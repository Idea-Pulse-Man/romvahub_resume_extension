/**
 * The extension's own romva.space sign-in: its own session, kept in
 * chrome.storage, separate from the romva.space website's.
 *
 * It used to borrow the website's cookies and renew them on its own clock.
 * Renewing the same session from two places at once (this worker and a
 * romva.space tab) spent a renewal key twice, and romva.space took that for a
 * stolen session and signed the account out everywhere. Now no request here
 * sends or receives a cookie (`credentials: 'omit'`): the access token goes in
 * the Authorization header, the refresh token in the body of
 * /api/auth/refresh, and the website's session is never touched.
 *
 * The background worker and the popup both renew through `withLock`, a Web
 * Lock both share, so the session is never renewed twice at once from here.
 */

export const DEFAULT_API_URL = 'https://www.romva.space';
const KEY = 'session'; // { accessToken, refreshToken, email }
const LOCK = 'romva-resume-session';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function apiUrl() {
  const { settings } = await chrome.storage.local.get('settings');
  return String(settings?.apiUrl || DEFAULT_API_URL).replace(/\/+$/, '');
}

export async function getSession() {
  const { [KEY]: session } = await chrome.storage.local.get(KEY);
  return session?.accessToken && session?.refreshToken ? session : null;
}

async function setSession(session) {
  if (session) await chrome.storage.local.set({ [KEY]: session });
  else await chrome.storage.local.remove(KEY);
}

const withLock = (run) => (navigator.locks ? navigator.locks.request(LOCK, run) : run());

/** One request, no cookies. `status` 0: romva.space could not be reached. */
async function send(path, { method = 'GET', body, accessToken } = {}) {
  let response;
  try {
    response = await fetch(`${await apiUrl()}${path}`, {
      method,
      credentials: 'omit',
      headers: {
        accept: 'application/json',
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    throw new ApiError(0, `Could not reach romva.space (${error.message}).`);
  }
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    throw new ApiError(response.status, data?.error?.message || `${response.status} ${response.statusText}`);
  }
  return data;
}

function keep(result, email) {
  if (!result?.accessToken || !result?.refreshToken) throw new ApiError(0, 'romva.space did not send a session.');
  return setSession({ accessToken: result.accessToken, refreshToken: result.refreshToken, email: result.user?.email || email });
}

/**
 * Signs in with email and password. Resolves `{ ok: true }`, or `{ mfa }` when
 * the account needs its authenticator code next (then `verifyCode`).
 */
export async function signIn(email, password) {
  const result = await send('/api/auth/login', { method: 'POST', body: { email, password } });
  if (result?.mfa) {
    if (result.mfa.setup) {
      throw new ApiError(0, 'Set up the authenticator app on romva.space first (sign in there once), then sign in here.');
    }
    return { mfa: result.mfa };
  }
  await keep(result, email);
  return { ok: true };
}

export async function verifyCode(challengeId, code, email) {
  await keep(await send('/api/auth/login/verify', { method: 'POST', body: { challengeId, code } }), email);
  return { ok: true };
}

/** Forgets this extension's session (the website's stays signed in). */
export async function signOut() {
  await setSession(null);
}

/**
 * Renews the session once. `used`: the access token that was refused; when
 * the stored one is already different, another part of the extension renewed
 * it meanwhile, and that one is used.
 */
async function renew(used) {
  return withLock(async () => {
    const session = await getSession();
    if (!session) return null;
    if (session.accessToken !== used) return session;
    try {
      const result = await send('/api/auth/refresh', { method: 'POST', body: { refreshToken: session.refreshToken } });
      const next = { accessToken: result.accessToken, refreshToken: result.refreshToken, email: result.user?.email || session.email };
      await setSession(next);
      return next;
    } catch (error) {
      // Refused: this session is over, and the popup asks to sign in again.
      // Anything else (romva.space busy, the network down) keeps it for the next try.
      if (error instanceof ApiError && error.status === 401) {
        await setSession(null);
        return null;
      }
      throw error;
    }
  });
}

/** A call as the signed-in person; an expired access token is renewed once. */
export async function api(path, options = {}) {
  const session = await getSession();
  if (!session) throw new ApiError(401, 'Not signed in: open the extension and sign in to romva.space.');
  try {
    return await send(path, { ...options, accessToken: session.accessToken });
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) throw error;
    const next = await renew(session.accessToken);
    if (!next) throw new ApiError(401, 'Signed out: open the extension and sign in to romva.space again.');
    return send(path, { ...options, accessToken: next.accessToken });
  }
}
