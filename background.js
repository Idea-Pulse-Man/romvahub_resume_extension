import { applyTick, registerApply } from './apply.js';

/**
 * Romva Resume Maker — background worker.
 *
 * While you are signed in to romva.space in this Chrome, it asks romva.space
 * for the next Draft application without a Resume, writes it with ChatGPT (your
 * own signed-in chatgpt.com, in a small window of its own), and saves the five
 * files to Downloads\Resume\<Profile>\<Company_Role>\:
 *
 *   claim → ChatGPT (Resume prompt) → romva.space builds the Resume
 *         → ChatGPT (cover letter prompt) → romva.space builds the letter → done
 *
 * romva.space hands each application to one worker only (this extension, the
 * desktop agent, or the local API), so several computers can run at once.
 * Start / Stop on the romva.space Applications page turns them all on or off;
 * the switch in this extension's popup turns just this browser on or off.
 *
 * Service workers are stopped when idle, so everything that must survive is in
 * chrome.storage: the job in progress and the step it is on. The ChatGPT page
 * reports back with a message, which wakes the worker up again.
 */

const DEFAULTS = { apiUrl: 'https://www.romva.space', enabled: true, deviceName: '', applyEnabled: false, applyTabs: 3 };
const CHAT_URL = 'https://chatgpt.com/?temporary-chat=true';
/** One ChatGPT answer may take this long before the step is given up. */
const STEP_TIMEOUT_MS = 12 * 60_000;
/** After "ChatGPT is not available", wait this long before trying again. */
const PAUSE_MS = 60_000;

// ---------------------------------------------------------------------------
// Storage

async function settings() {
  const { settings: saved } = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...(saved ?? {}) };
}

async function getState() {
  const { state } = await chrome.storage.local.get('state');
  return state ?? null;
}

async function setState(state) {
  if (state) await chrome.storage.local.set({ state });
  else await chrome.storage.local.remove('state');
}

/** What the popup shows: the last few events, newest first. */
async function note(text, kind = 'info') {
  const { events = [] } = await chrome.storage.local.get('events');
  events.unshift({ at: Date.now(), text, kind });
  await chrome.storage.local.set({ events: events.slice(0, 30) });
  const badge = kind === 'error' ? '!' : '';
  await chrome.action.setBadgeText({ text: badge }).catch(() => undefined);
}

async function setStatus(status) {
  await chrome.storage.local.set({ status: { ...status, at: Date.now() } });
  const text = status.making ? '…' : '';
  await chrome.action.setBadgeText({ text }).catch(() => undefined);
  await chrome.action.setBadgeBackgroundColor({ color: '#10b981' }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// romva.space API, with this browser's romva.space sign-in (its cookies)

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function rawCall(path, { method = 'GET', body } = {}) {
  const { apiUrl } = await settings();
  const response = await fetch(`${apiUrl.replace(/\/+$/, '')}${path}`, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) throw new ApiError(response.status, data?.error?.message || `${response.status} ${response.statusText}`);
  return data;
}

/** A call as the signed-in person; an expired session is refreshed once, as the site itself does. */
async function api(path, options) {
  try {
    return await rawCall(path, options);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) throw error;
    await rawCall('/api/auth/refresh', { method: 'POST', body: {} });
    return rawCall(path, options);
  }
}

async function workerName() {
  const { deviceName } = await settings();
  if (deviceName) return `extension · ${deviceName}`;
  let { deviceId } = await chrome.storage.local.get('deviceId');
  if (!deviceId) {
    deviceId = crypto.randomUUID().slice(0, 8);
    await chrome.storage.local.set({ deviceId });
  }
  return `extension · ${deviceId}`;
}

// ---------------------------------------------------------------------------
// ChatGPT: one chat per step, in a small window of its own

function waitForTabLoaded(tabId, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('chatgpt.com did not load.'));
    }, timeoutMs);
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') listener(tabId, { status: 'complete' });
    }, () => undefined);
  });
}

/**
 * Opens a new temporary ChatGPT chat and hands it the message; the answer
 * comes back later as a runtime message (`chatgpt-answer`). A visible, unfocused
 * window rather than a background tab: a hidden page may be slowed down.
 */
async function startChat(message, requestId) {
  const win = await chrome.windows.create({
    url: CHAT_URL,
    type: 'popup',
    focused: false,
    width: 520,
    height: 720,
    left: 40,
    top: 40,
  });
  const tabId = win.tabs[0].id;
  await waitForTabLoaded(tabId);
  await chrome.scripting.executeScript({ target: { tabId }, files: ['chatgpt.js'] });
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (text, id) => window.__romvaAsk(text, id),
    args: [message, requestId],
  });
  return { tabId, windowId: win.id };
}

async function closeChat(state) {
  if (state?.windowId) await chrome.windows.remove(state.windowId).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Files

async function saveFiles(job, files) {
  for (const file of Object.values(files ?? {})) {
    if (!file?.name || !file.base64) continue;
    await chrome.downloads.download({
      url: `data:application/octet-stream;base64,${file.base64}`,
      filename: `Resume/${job.profileFolderName}/${job.folderName}/${file.name}`,
      conflictAction: 'overwrite',
      saveAs: false,
    });
  }
}

// ---------------------------------------------------------------------------
// The loop

async function giveUp(state, error, { unavailable = false, counted = false } = {}) {
  await closeChat(state);
  await setState(null);
  if (unavailable) {
    await chrome.storage.local.set({ pausedUntil: Date.now() + PAUSE_MS, pauseReason: error });
    await note(`Paused: ${error}`, 'error');
  } else {
    await note(`Failed: ${state.job.company} — ${error}`, 'error');
  }
  if (!counted) {
    await api(`/api/auto-make/jobs/${state.job.bidId}/release`, {
      method: 'POST',
      body: { failed: !unavailable, error: String(error).slice(0, 4000) },
    }).catch(() => undefined);
  }
  await setStatus({ making: null });
}

async function tick() {
  const { enabled } = await settings();
  const state = await getState();

  if (state) {
    // A step in progress; only check that it has not hung.
    if (Date.now() - state.stepStartedAt > STEP_TIMEOUT_MS) {
      await giveUp(state, 'ChatGPT took too long to answer.');
    }
    return;
  }
  if (!enabled) {
    await setStatus({ making: null, info: 'Off in this browser' });
    return;
  }
  const { pausedUntil = 0 } = await chrome.storage.local.get('pausedUntil');
  if (Date.now() < pausedUntil) return;

  let claim;
  try {
    claim = await api('/api/auto-make/claim', { method: 'POST', body: { worker: await workerName() } });
  } catch (error) {
    const signedOut = error instanceof ApiError && error.status === 401;
    await setStatus({ making: null, info: signedOut ? 'Sign in to romva.space in this browser' : `romva.space: ${error.message}` });
    return;
  }
  if (!claim.enabled) {
    await setStatus({ making: null, info: 'Auto resume is at Stop on romva.space' });
    return;
  }
  if (!claim.job) {
    await setStatus({ making: null, info: 'Waiting for new applications' });
    return;
  }

  const job = claim.job;
  const requestId = crypto.randomUUID();
  const next = { job, step: 'resume', requestId, stepStartedAt: Date.now() };
  await setState(next);
  await setStatus({ making: { company: job.company, role: job.role, step: 'Resume' } });
  await note(`Making #${job.number ?? '?'} ${job.company} — ${job.role}`);
  try {
    Object.assign(next, await startChat(job.resumeMessage, requestId));
    await setState(next);
  } catch (error) {
    await giveUp(next, error.message, { unavailable: true });
  }
}

/** The ChatGPT page answered (or could not). */
async function onAnswer(message) {
  const state = await getState();
  if (!state || state.requestId !== message.requestId) return;
  await closeChat(state);

  if (message.type === 'chatgpt-error') {
    await giveUp(state, message.error, { unavailable: !!message.unavailable });
    return;
  }

  try {
    if (state.step === 'resume') {
      const done = await api(`/api/auto-make/jobs/${state.job.bidId}/resume`, {
        method: 'POST',
        body: { answer: message.answer },
      });
      await saveFiles(state.job, done.files);
      await note(`Resume saved: ${state.job.company}`);
      const requestId = crypto.randomUUID();
      const next = { ...state, step: 'cover', requestId, stepStartedAt: Date.now(), coverAttempt: 1, coverLetterMessage: done.coverLetterMessage };
      await setState(next);
      await setStatus({ making: { company: state.job.company, role: state.job.role, step: 'Cover letter' } });
      Object.assign(next, await startChat(done.coverLetterMessage, requestId));
      await setState(next);
      return;
    }

    const done = await api(`/api/auto-make/jobs/${state.job.bidId}/cover-letter`, {
      method: 'POST',
      body: { answer: message.answer },
    });
    await saveFiles(state.job, done.files);
    await note(`Done: ${state.job.company} (5 files in Downloads\\Resume\\${state.job.profileFolderName}\\${state.job.folderName})`);
    await setState(null);
    await setStatus({ making: null, info: 'Waiting for new applications' });
    void tick();
  } catch (error) {
    // The letter gets one more try with a new chat.
    if (state.step === 'cover' && (state.coverAttempt ?? 1) < 2 && !(error instanceof ApiError && error.status === 409)) {
      const requestId = crypto.randomUUID();
      const next = { ...state, requestId, stepStartedAt: Date.now(), coverAttempt: 2 };
      await setState(next);
      await note(`Cover letter: trying again (${error.message})`);
      try {
        Object.assign(next, await startChat(state.coverLetterMessage, requestId));
        await setState(next);
        return;
      } catch (retryError) {
        error = retryError;
      }
    }
    const counted = error instanceof ApiError && (error.status === 400 || error.status === 502);
    await giveUp(state, error.message, { counted });
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'chatgpt-answer' || message?.type === 'chatgpt-error') void onAnswer(message);
  if (message?.type === 'tick-now') void tick();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'tick') {
    void tick();
    void applyTick(api, note);
  }
});

// Apply: open and fill the application forms (apply.js). You submit.
registerApply(api, note);

function schedule() {
  chrome.alarms.create('tick', { periodInMinutes: 0.5 });
}
chrome.runtime.onInstalled.addListener(schedule);
chrome.runtime.onStartup.addListener(schedule);
schedule();
