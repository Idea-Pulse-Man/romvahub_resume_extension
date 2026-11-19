import { DEFAULT_API_URL, api, getSession, signIn, signOut, verifyCode } from './session.js';

const DEFAULTS = { apiUrl: DEFAULT_API_URL, enabled: true, deviceName: '' };
const $ = (id) => document.getElementById(id);

async function settings() {
  const { settings: saved } = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...(saved ?? {}) };
}

async function saveSettings(patch) {
  await chrome.storage.local.set({ settings: { ...(await settings()), ...patch } });
}

/** A call with the extension's own sign-in (session.js): never the website's cookies. */
const call = (path, options = {}) => api(path, options);

function time(at) {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

async function render() {
  const current = await settings();
  $('enabled').checked = current.enabled;
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

  const session = await getSession();
  $('signIn').hidden = !!session;
  $('signOut').hidden = !session;
  if (!session) {
    $('account').textContent = 'Not signed in';
    $('account').className = 'err';
    $('global').textContent = '—';
    $('toggleGlobal').hidden = true;
    return;
  }
  try {
    const me = await call('/api/auth/me');
    $('account').textContent = me?.user?.email ?? session.email ?? 'signed in';
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
    $('account').textContent =
      error.status === 401 ? 'Signed out: sign in again' : error.status >= 500 ? `romva.space error (${error.status})` : 'Cannot reach romva.space';
    $('account').title = error.message;
    if (error.status === 401) {
      $('signIn').hidden = false;
      $('signOut').hidden = true;
    }
    $('account').className = 'err';
    $('global').textContent = '—';
    $('toggleGlobal').hidden = true;
  }
}

// Sign in: email and password, then the authenticator code when the account asks for one.
let challenge = null;
$('signInForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('signInError').textContent = '';
  $('signInButton').disabled = true;
  const email = $('email').value.trim();
  try {
    if (challenge) {
      await verifyCode(challenge.challengeId, $('code').value.trim(), email);
    } else {
      const result = await signIn(email, $('password').value);
      if (result.mfa) {
        challenge = result.mfa;
        $('code').hidden = false;
        $('code').required = true;
        $('code').focus();
        $('signInButton').textContent = 'Verify';
        return;
      }
    }
    challenge = null;
    $('password').value = '';
    $('code').value = '';
    $('code').hidden = true;
    $('code').required = false;
    $('signInButton').textContent = 'Sign in';
    await chrome.runtime.sendMessage({ type: 'tick-now' }).catch(() => undefined);
    await render();
  } catch (error) {
    $('signInError').textContent = error.message;
  } finally {
    $('signInButton').disabled = false;
  }
});
$('signOut').addEventListener('click', async () => {
  await signOut();
  await render();
});

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
$('now').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'tick-now' });
  setTimeout(render, 1500);
});

chrome.action.setBadgeText({ text: '' }).catch(() => undefined);
void render();
