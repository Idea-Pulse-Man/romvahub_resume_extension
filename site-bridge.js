/**
 * Runs on romva.space pages: lets the site's **Apply** button (Applications
 * table) ask this extension to open one job and fill in its application form.
 *
 * The page cannot call the extension directly, so it posts a window message;
 * this script passes it to the background worker and posts the answer back.
 * It also marks the page (`<html data-romva-apply>`) so the site knows the
 * extension is there.
 */

document.documentElement.dataset.romvaApply = chrome.runtime.getManifest().version;

window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.source !== 'romva-site') return;
  const { type, bidId, requestId } = event.data;
  if (type !== 'apply' || typeof bidId !== 'string') return;

  const answer = (result) =>
    window.postMessage({ source: 'romva-extension', type: 'apply-result', requestId, ...result }, window.location.origin);

  try {
    chrome.runtime.sendMessage({ type: 'apply-one', bidId }, (result) => {
      if (chrome.runtime.lastError) answer({ ok: false, error: chrome.runtime.lastError.message });
      else answer(result ?? { ok: false, error: 'No answer from the extension.' });
    });
  } catch (error) {
    // The extension was reloaded after this page opened: the page must be refreshed.
    answer({ ok: false, error: 'The extension was updated. Refresh this page and try again.' });
  }
});
