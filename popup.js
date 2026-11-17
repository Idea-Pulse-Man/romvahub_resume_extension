const DEFAULTS = { apiUrl: 'https://www.romva.space', enabled: true, deviceName: '', applyEnabled: false, applyTabs: 3 };
const $ = (id) => document.getElementById(id);

async function settings() {
  const { settings: saved } = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...(saved ?? {}) };
}

async function saveSettings(patch) {
  await chrome.storage.local.set({ settings: { ...(await settings()), ...patch } });
}

async function call(path, options = {}) {
  const { apiUrl } = await settings();
  const response = await fetch(`${apiUrl.replace(/\/+$/, '')}${path}`, {
    credentials: 'include',
    method: options.method ?? 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (response.status === 401 && !options.retried) {
    await fetch(`${apiUrl.replace(/\/+$/, '')}/api/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    return call(path, { ...options, retried: true });
  }
  if (!response.ok) throw Object.assign(new Error(`${response.status}`), { status: response.status });
  return response.json();
}

function time(at) {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

async function render() {
  const current = await settings();
  $('enabled').checked = current.enabled;
  $('applyEnabled').checked = current.applyEnabled;
  $('applyTabs').value = current.applyTabs;
  const { applyOpen = {}, applyHandled = {} } = await chrome.storage.local.get(['applyOpen', 'applyHandled']);
  $('applyCount').textContent = `${Object.keys(applyOpen).length} open · ${Object.keys(applyHandled).length} done`;
  $('deviceName').value = current.deviceName;
  $('apiUrl').value = current.apiUrl;

  const { status, events = [], state } = await chrome.storage.local.get(['status', 'events', 'state']);
  if (state?.job) {
    $('current').textContent = `Making ${state.job.company} — ${state.step === 'cover' ? 'cover letter' : 'Resume'}…`;
    $('current').className = 'ok';
  } else {
    $('current').textContent = status?.info ?? 'Idle';
    $('current').className = 'muted';
  }
  $('events').replaceChildren(
    ...events.map((event) => {
      const li = document.createElement('li');
      li.textContent = `${time(event.at)} ${event.text}`;
      if (event.kind === 'error') li.className = 'err';
      return li;
    }),
  );

  try {
    const me = await call('/api/auth/me');
    $('account').textContent = me?.user?.email ?? 'signed in';
    $('account').className = 'ok';
    const auto = await call('/api/auto-make');
    $('global').textContent = auto.enabled ? 'On' : 'Stopped';
    $('global').className = auto.enabled ? 'ok' : 'warn';
    $('toggleGlobal').hidden = false;
    $('toggleGlobal').textContent = auto.enabled ? 'Stop' : 'Start';
    $('toggleGlobal').className = auto.enabled ? '' : 'primary';
    $('toggleGlobal').onclick = async () => {
      await call('/api/auto-make', { method: 'PUT', body: { enabled: !auto.enabled } });
      await render();
    };
  } catch (error) {
    $('account').textContent = error.status === 401 ? 'Not signed in — open romva.space and sign in' : 'Cannot reach romva.space';
    $('account').className = 'err';
    $('global').textContent = '—';
    $('toggleGlobal').hidden = true;
  }
}

$('enabled').addEventListener('change', async (event) => {
  await saveSettings({ enabled: event.target.checked });
  await chrome.runtime.sendMessage({ type: 'tick-now' });
  await render();
});
$('deviceName').addEventListener('change', (event) => saveSettings({ deviceName: event.target.value.trim() }));
$('apiUrl').addEventListener('change', async (event) => {
  await saveSettings({ apiUrl: event.target.value.trim() || DEFAULTS.apiUrl });
  await render();
});
$('applyEnabled').addEventListener('change', async (event) => {
  await saveSettings({ applyEnabled: event.target.checked });
  if (event.target.checked) await chrome.runtime.sendMessage({ type: 'apply-now' });
  setTimeout(render, 1500);
});
$('applyTabs').addEventListener('change', async (event) => {
  const tabs = Math.min(10, Math.max(1, Number(event.target.value) || 3));
  await saveSettings({ applyTabs: tabs });
  await chrome.runtime.sendMessage({ type: 'apply-now' });
  setTimeout(render, 1500);
});
$('applyNow').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'apply-now' });
  setTimeout(render, 1500);
});
$('applyForget').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'apply-forget' });
  setTimeout(render, 500);
});
$('now').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'tick-now' });
  setTimeout(render, 1500);
});

chrome.action.setBadgeText({ text: '' }).catch(() => undefined);
void render();
