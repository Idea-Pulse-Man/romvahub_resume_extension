/**
 * Romva Apply — the extension's side.
 *
 * With "Apply" on (popup), it keeps a few job tabs open: each one is the job's
 * application page for a Draft whose Resume and cover letter are made, filled
 * in from the Profile with both files attached (`apply-fill.js`). You check
 * each tab and click Submit yourself; when the page says the application was
 * sent, the tab closes and the next job opens. Closing a tab yourself also
 * counts as done with that job.
 *
 * Nothing is submitted, screenshotted or changed on romva.space: the status
 * stays as it is.
 */

const HANDLED_DAYS = 14;
/** How long a tab keeps re-filling as the page renders more of the form. */
const FILL_FOR_MS = 40_000;

async function applySettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { applyEnabled: false, applyTabs: 3, ...(settings ?? {}) };
}

async function openTabs() {
  const { applyOpen = {} } = await chrome.storage.local.get('applyOpen');
  return applyOpen; // tabId → { bidId, company, openedAt }
}

async function saveOpenTabs(applyOpen) {
  await chrome.storage.local.set({ applyOpen });
}

async function handled() {
  const { applyHandled = {} } = await chrome.storage.local.get('applyHandled');
  const cutoff = Date.now() - HANDLED_DAYS * 24 * 60 * 60_000;
  for (const [id, at] of Object.entries(applyHandled)) if (at < cutoff) delete applyHandled[id];
  return applyHandled; // bidId → when
}

async function markHandled(bidId) {
  const applyHandled = await handled();
  applyHandled[bidId] = Date.now();
  await chrome.storage.local.set({ applyHandled });
}

export async function forgetHandled() {
  await chrome.storage.local.set({ applyHandled: {} });
}

/** What to fill in for one application, kept for the tab's life (re-filled on every page load). */
async function dataFor(bidId, api) {
  const key = `applyData:${bidId}`;
  const stored = await chrome.storage.session.get(key);
  if (stored[key]) return stored[key];
  const data = await api(`/api/auto-make/apply/${bidId}`);
  await chrome.storage.session.set({ [key]: data });
  return data;
}

/** Keeps the chosen number of application tabs open. */
export async function applyTick(api, note) {
  const { applyEnabled, applyTabs } = await applySettings();
  if (!applyEnabled) return;

  // Forget tabs that are gone (closed while the worker slept).
  const applyOpen = await openTabs();
  for (const tabId of Object.keys(applyOpen)) {
    try {
      await chrome.tabs.get(Number(tabId));
    } catch {
      await markHandled(applyOpen[tabId].bidId);
      delete applyOpen[tabId];
    }
  }
  await saveOpenTabs(applyOpen);

  const room = applyTabs - Object.keys(applyOpen).length;
  if (room <= 0) return;

  const skip = [...Object.keys(await handled()), ...Object.values(applyOpen).map((t) => t.bidId)].slice(-150);
  let next;
  try {
    next = await api(`/api/auto-make/apply/next?limit=${room}&skip=${skip.join(',')}`);
  } catch {
    return; // signed out of romva.space, or it is unreachable: try on the next tick
  }

  for (const job of next.jobs ?? []) {
    try {
      await dataFor(job.bidId, api);
      const tab = await chrome.tabs.create({ url: job.jobUrl, active: false });
      applyOpen[tab.id] = { bidId: job.bidId, company: job.company, role: job.role, openedAt: Date.now() };
      await saveOpenTabs(applyOpen);
      await note(`Apply: opened ${job.company} — ${job.role}`);
    } catch (error) {
      await markHandled(job.bidId);
      await note(`Apply: could not open ${job.company} (${error.message})`, 'error');
    }
  }
}

/**
 * The Apply button on romva.space: open this one job now and fill it in,
 * whether or not "Open & fill applications" is on. A job already open in a tab
 * is brought to the front instead of opened twice.
 */
export async function applyOne(bidId, api, note) {
  const applyOpen = await openTabs();
  const open = Object.entries(applyOpen).find(([, t]) => t.bidId === bidId);
  if (open) {
    try {
      const tab = await chrome.tabs.update(Number(open[0]), { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return { ok: true, alreadyOpen: true };
    } catch {
      delete applyOpen[open[0]];
      await saveOpenTabs(applyOpen);
    }
  }

  await chrome.storage.session.remove(`applyData:${bidId}`); // the latest Profile and files
  let data;
  try {
    data = await dataFor(bidId, api);
  } catch (error) {
    return { ok: false, error: error.message };
  }
  const tab = await chrome.tabs.create({ url: data.jobUrl, active: true });
  applyOpen[tab.id] = { bidId, company: data.company, role: data.role, openedAt: Date.now() };
  await saveOpenTabs(applyOpen);
  await note(`Apply: opened ${data.company} — ${data.role}`);
  return { ok: true };
}

/** A tracked tab finished loading a page: fill it in (again — only empty fields are touched). */
async function onTabLoaded(tabId, api) {
  const applyOpen = await openTabs();
  const tracked = applyOpen[tabId];
  if (!tracked) return;
  let data;
  try {
    data = await dataFor(tracked.bidId, api);
  } catch {
    return;
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['apply-fill.js'] });
    await chrome.scripting.executeScript({
      target: { tabId },
      args: [data, FILL_FOR_MS],
      func: (payload, fillForMs) => {
        if (window.__romvaApplyRunning) return;
        window.__romvaApplyRunning = true;
        const started = Date.now();
        const timer = setInterval(() => {
          if (window.__romvaApply.submitted()) {
            clearInterval(timer);
            chrome.runtime.sendMessage({ type: 'apply-submitted' });
            return;
          }
          if (Date.now() - started < fillForMs) window.__romvaApply.fill(payload);
        }, 2000);
        window.__romvaApply.fill(payload);
      },
    });
  } catch {
    // A page the extension may not touch (chrome://, the Web Store…): left to the person.
  }
}

/** The page said the application was sent: close the tab, open the next job. */
async function onSubmitted(tabId, api, note) {
  const applyOpen = await openTabs();
  const tracked = applyOpen[tabId];
  if (!tracked) return;
  delete applyOpen[tabId];
  await saveOpenTabs(applyOpen);
  await markHandled(tracked.bidId);
  await chrome.storage.session.remove(`applyData:${tracked.bidId}`);
  await note(`Apply: sent — ${tracked.company}`);
  setTimeout(() => chrome.tabs.remove(tabId).catch(() => undefined), 2500);
  await applyTick(api, note);
}

/** Closed by the person: done with that job either way. */
async function onTabClosed(tabId, api, note) {
  const applyOpen = await openTabs();
  const tracked = applyOpen[tabId];
  if (!tracked) return;
  delete applyOpen[tabId];
  await saveOpenTabs(applyOpen);
  await markHandled(tracked.bidId);
  await chrome.storage.session.remove(`applyData:${tracked.bidId}`);
  await applyTick(api, note);
}

export function registerApply(api, note) {
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status === 'complete') void onTabLoaded(tabId, api);
  });
  chrome.tabs.onRemoved.addListener((tabId) => void onTabClosed(tabId, api, note));
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'apply-one') {
      applyOne(message.bidId, api, note).then(sendResponse, (error) => sendResponse({ ok: false, error: error.message }));
      return true; // answered later
    }
    if (message?.type === 'apply-submitted' && sender.tab?.id) void onSubmitted(sender.tab.id, api, note);
    if (message?.type === 'apply-now') void applyTick(api, note);
    if (message?.type === 'apply-forget') void forgetHandled();
  });
}
