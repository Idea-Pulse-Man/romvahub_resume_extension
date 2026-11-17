/**
 * Romva Resume Maker — runs inside a new chatgpt.com chat.
 *
 * `window.__romvaAsk(message, requestId)` types the message into ChatGPT,
 * sends it, waits for the whole answer and reports it back to the background
 * worker (`chatgpt-answer`), or why it could not (`chatgpt-error`; `unavailable`
 * when ChatGPT itself is the problem — signed out, a "verify you are human"
 * check — rather than this application).
 *
 * The same rules as the desktop agent and the romva.space local API: the
 * message ends with a unique marker line, the answer is the last code block
 * holding a JSON object (else the text after the marker), and it is done when
 * nothing is streaming and the text has not changed for three seconds.
 */
(() => {
  if (window.__romvaAsk) return;

  const COMPOSER = '#prompt-textarea, textarea[name="prompt"], #mobile-composer-prompt, [contenteditable="true"][role="textbox"]';
  const SEND = [
    'button[data-testid="send-button"]',
    '#composer-submit-button',
    'button[aria-label="Send message"]',
    'button[aria-label="Send prompt"]',
  ].join(', ');
  const ANSWER_TIMEOUT_MS = 10 * 60_000;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  class Unavailable extends Error {}

  async function waitFor(check, timeoutMs, stepMs = 500) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = check();
      if (value) return value;
      await sleep(stepMs);
    }
    return null;
  }

  function signedOut() {
    return Array.from(document.querySelectorAll('button, a')).some((el) => /^log in$/i.test((el.innerText || '').trim()));
  }

  function freshChat() {
    return (
      !location.pathname.startsWith('/c/') &&
      document.querySelectorAll('pre').length === 0 &&
      !/(You said:|ChatGPT said:)/.test(document.body.innerText || '')
    );
  }

  function fill(editor, text) {
    const isField = editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT';
    editor.focus();
    if (isField) editor.select();
    else document.execCommand('selectAll');
    document.execCommand('delete');
    document.execCommand('insertText', false, text);
    let got = isField ? editor.value : editor.innerText;
    if (got.replace(/\s+/g, '').length < text.replace(/\s+/g, '').length * 0.95) {
      if (isField) {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(editor), 'value').set;
        setter.call(editor, text);
        editor.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        const data = new DataTransfer();
        data.setData('text/plain', text);
        editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      }
      got = isField ? editor.value : editor.innerText;
    }
    if (got.replace(/\s+/g, '').length < text.replace(/\s+/g, '').length * 0.95) {
      throw new Error('Could not type the prompt into ChatGPT. The chatgpt.com page may have changed.');
    }
  }

  async function send(editor) {
    const button = await waitFor(
      () =>
        Array.from(document.querySelectorAll(SEND)).find(
          (b) => b.offsetParent !== null && !b.disabled && b.getAttribute('aria-disabled') !== 'true',
        ),
      15_000,
    );
    if (button) button.click();
    else editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
  }

  function snapshot(marker) {
    const pres = Array.from(document.querySelectorAll('pre'), (p) => p.innerText || '');
    const body = document.body.innerText || '';
    const at = body.lastIndexOf(marker);
    const tail = at >= 0 ? body.slice(at + marker.length) : '';
    const streaming = Array.from(document.querySelectorAll('button')).some((b) => {
      const label = `${b.getAttribute('aria-label') || ''} ${b.getAttribute('data-testid') || ''}`;
      return /\bstop\b|stop[-_ ]?(generating|streaming|response|button)/i.test(label);
    });
    return { pres, tail, streaming };
  }

  async function ask(message) {
    const editor = await waitFor(() => document.querySelector(COMPOSER), 30_000);
    if (!editor) throw new Unavailable('ChatGPT did not load. Check chatgpt.com in this browser (sign in, or a "verify you are human" check).');
    if (signedOut()) throw new Unavailable('ChatGPT is not signed in in this browser. Sign in on chatgpt.com.');
    if (!(await waitFor(freshChat, 20_000))) throw new Unavailable('ChatGPT did not open a new, empty chat.');

    const marker = `Request ${crypto.randomUUID()}`;
    fill(editor, `${message}\n\n${marker}`);
    await send(editor);

    const deadline = Date.now() + ANSWER_TIMEOUT_MS;
    let started = false;
    let last = '';
    let stableSince = 0;
    while (Date.now() < deadline) {
      await sleep(1000);
      const answer = snapshot(marker);
      started ||= answer.streaming || answer.pres.length > 0;
      const key = JSON.stringify([answer.pres, answer.tail]);
      if (!started || answer.streaming) {
        stableSince = 0;
        last = key;
        continue;
      }
      if (key !== last || !stableSince) {
        last = key;
        stableSince = Date.now();
        continue;
      }
      if (Date.now() - stableSince >= 3000) {
        const block = [...answer.pres].reverse().find((text) => text.includes('{') && text.includes('}'));
        const text = (block ?? answer.tail).trim();
        if (text) return text;
      }
    }
    throw new Error('ChatGPT had not finished answering after 10 minutes.');
  }

  window.__romvaAsk = (message, requestId) => {
    ask(message).then(
      (answer) => chrome.runtime.sendMessage({ type: 'chatgpt-answer', requestId, answer }),
      (error) =>
        chrome.runtime.sendMessage({
          type: 'chatgpt-error',
          requestId,
          error: error?.message ?? String(error),
          unavailable: error instanceof Unavailable,
        }),
    );
    return true;
  };
})();
