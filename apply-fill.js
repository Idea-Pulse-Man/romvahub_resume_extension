/**
 * Romva Apply — runs inside a job's application page.
 *
 * Fills in the form from the applicant's Profile, attaches the Resume and
 * cover letter, and shows a small banner. It NEVER submits: the person checks
 * the form and clicks Submit. After that, `submitted()` reports the
 * confirmation page, and the tab is closed by whoever opened it.
 *
 * Shared, unchanged, by the Chrome extension (injected as a content script)
 * and the desktop agent (evaluated by puppeteer):
 *
 *   window.__romvaApply.fill(data)  → { filled, files, unfilledRequired }   (safe to call again)
 *   window.__romvaApply.submitted() → true on the "application sent" page
 *   window.__romvaApply.questions() → the form's open questions still empty: [{ id, question, required, maxLength }]
 *   window.__romvaApply.answer(list) → types [{ id, answer }] into those fields (empty ones only)
 *
 * Only empty fields are filled, so calling fill() again as the page renders
 * more of the form never overwrites what the person typed.
 */
(() => {
  if (window.__romvaApply) return;

  const norm = (text) => String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

  function visible(el) {
    if (!el || el.disabled) return false;
    if (el.type === 'file') return true; // file inputs are often hidden behind a styled button
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  /** Everything that says what a field is for: its label, name, id, placeholder, nearby question text. */
  function describe(el) {
    const parts = [
      el.name,
      el.id,
      el.getAttribute('aria-label'),
      el.getAttribute('placeholder'),
      el.getAttribute('autocomplete'),
      el.getAttribute('data-qa'),
    ];
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) parts.push(label.innerText);
    }
    const wrapping = el.closest('label');
    if (wrapping) parts.push(wrapping.innerText);
    for (const id of (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)) {
      const node = document.getElementById(id);
      if (node) parts.push(node.innerText);
    }
    const container = el.closest(
      'fieldset, .field, .form-group, .application-question, [class*="field"], [class*="question"], [class*="Field"], [class*="Question"], li',
    );
    if (container) {
      const legend = container.querySelector('legend, label, [class*="label"], [class*="Label"]');
      if (legend) parts.push(legend.innerText);
      parts.push((container.innerText || '').slice(0, 160));
    }
    return norm(parts.filter(Boolean).join(' | '));
  }

  /** Sets a value the way typing would, so React/Vue forms notice it. */
  function setValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    el.focus();
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    mark(el);
  }

  function mark(el) {
    el.style.outline = '2px solid rgba(16,185,129,.7)';
    el.style.outlineOffset = '1px';
  }

  const yes = (value) => /^(yes|true|y)$/i.test(String(value ?? '').trim());
  const no = (value) => /^(no|false|n)$/i.test(String(value ?? '').trim());

  /** The text to type into a field described as `d`, or undefined when it is not one we know. */
  function textFor(d, el, a, data) {
    const isTextarea = el.tagName === 'TEXTAREA';
    if (isTextarea && /cover[\s_-]*letter/.test(d)) return data.coverLetterText || undefined;
    if (isTextarea) return undefined; // free-text questions are the person's to answer
    if (el.type === 'email' || /e-?mail/.test(d)) return a.email;
    if (el.type === 'tel' || /phone|mobile|\bcell\b/.test(d)) return a.phone;
    if (/linkedin/.test(d)) return a.linkedin;
    if (/github/.test(d)) return a.github;
    if (/portfolio|website|personal (site|url|page)|other (url|link|website)/.test(d)) return a.website;
    if (/preferred|middle|nick ?name/.test(d)) return undefined;
    if (/first[\s_-]*name|given[\s_-]*name|\bfname\b|firstname/.test(d)) return a.firstName;
    if (/last[\s_-]*name|family[\s_-]*name|surname|\blname\b|lastname/.test(d)) return a.lastName;
    if (/current (company|employer)|company name|\borg\b|current organi[sz]ation/.test(d)) return a.currentCompany;
    if (/current (job )?(title|role|position)|job title/.test(d)) return a.currentTitle;
    if (/\b(full[\s_-]*)?name\b|your name|legal name/.test(d) && !/company|employer|school|university|reference|manager|user ?name|recruiter|referr/.test(d)) {
      return a.fullName;
    }
    if (/zip|postal/.test(d)) return a.zipCode;
    if (/\bcity\b/.test(d) && !/state|country/.test(d)) return a.city;
    if (/\b(state|province)\b/.test(d) && !/statement|united states/.test(d)) return a.state;
    if (/\bcountry\b/.test(d)) return a.country;
    if (/address|street/.test(d)) return a.address;
    if (/location|where are you (based|located)|city,? state/.test(d)) return a.location;
    if (/notice period|when can you start|start date|availability to start/.test(d)) return a.noticePeriod;
    return undefined;
  }

  /** The answer to a choice question (select / radio) described as `d`, as text to match an option. */
  function answerFor(d, a) {
    const authorized = (a.authorizedCountries ?? []).length > 0;
    // The applicant never needs a visa sponsored, for any country.
    if (/sponsor/.test(d)) return 'No';
    if (/authori[sz]ed to work|legally (authori[sz]ed|eligible|able)|eligible to work|right to work/.test(d)) {
      return authorized ? 'Yes' : undefined;
    }
    if (/relocat/.test(d)) return yes(a.openToRelocation) ? 'Yes' : no(a.openToRelocation) ? 'No' : undefined;
    if (/hispanic|latin[oax]/.test(d)) {
      if (!a.ethnicity) return undefined;
      return /hispanic|latin/i.test(a.ethnicity) ? 'Yes' : 'No';
    }
    if (/\bgender\b|\bsex\b/.test(d)) return a.gender || undefined;
    if (/\brace\b|ethnic/.test(d)) return a.ethnicity || undefined;
    if (/veteran/.test(d)) return a.veteranStatus || undefined;
    if (/disabilit/.test(d)) return a.disabilityStatus || undefined;
    if (/country/.test(d)) return a.country || undefined;
    if (/\bstate\b|province/.test(d)) return a.state || undefined;
    return undefined;
  }

  const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  /** Whether `phrase` appears in `text` as whole words ("no" is not in "latino"). */
  const hasWords = (text, phrase) => new RegExp(`(^|[^a-z0-9])${escapeRe(phrase)}([^a-z0-9]|$)`).test(text);

  /** The option (or radio) whose text best matches the answer: exact, then starts with it, then contains it as words. */
  function pick(options, answer) {
    const want = norm(answer);
    if (!want) return null;
    const usable = options.filter((o) => o.text && !/^(select|choose|please select|--)/.test(o.text));
    return (
      usable.find((o) => o.text === want) ||
      usable.find((o) => o.text.startsWith(want) && hasWords(o.text, want)) ||
      usable.find((o) => hasWords(o.text, want)) ||
      usable.find((o) => o.text.length > 3 && hasWords(want, o.text)) ||
      null
    );
  }

  /**
   * A choice question's own wording — its legend or label — without the text
   * of its answers, so "Race: … Hispanic or Latino …" is read as a race
   * question, not as the Hispanic yes/no one.
   */
  function questionOf(container, radios) {
    if (!container) return '';
    const heading = container.querySelector('legend, h3, h4, [class*="label"]:not(label), [class*="Label"]:not(label)');
    if (heading && heading.innerText.trim()) return norm(heading.innerText).slice(0, 200);
    let text = container.innerText || '';
    for (const radio of radios) {
      const label = (radio.id && document.querySelector(`label[for="${CSS.escape(radio.id)}"]`)) || radio.closest('label');
      if (label?.innerText) text = text.replace(label.innerText, ' ');
    }
    return norm(text).slice(0, 200);
  }

  function base64File(file, type) {
    const bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
    return new File([bytes], file.name, { type });
  }

  function attach(input, file) {
    const transfer = new DataTransfer();
    transfer.items.add(base64File(file, 'application/pdf'));
    input.files = transfer.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    mark(input.closest('label, div') || input);
  }

  const attached = new WeakSet();
  const clickedGroups = new WeakSet();

  /** A button that looks chosen: pressed, checked, or styled as active/selected. */
  function selected(button) {
    if (/^(true|mixed)$/.test(button.getAttribute('aria-pressed') || '')) return true;
    if (button.getAttribute('aria-checked') === 'true' || button.getAttribute('aria-selected') === 'true') return true;
    if (/^(on|checked|active|selected)$/.test(button.getAttribute('data-state') || '')) return true;
    return /(^|[\s_-])(active|selected|checked|is-?selected|pressed)([\s_-]|$)/i.test(String(button.className || ''));
  }

  /**
   * Groups of 2–6 short sibling buttons answering one question ("Yes" / "No"),
   * with the question read from the surrounding field. Submit and navigation
   * buttons are never part of one.
   */
  function buttonGroups() {
    const parents = new Set();
    for (const button of document.querySelectorAll('button, [role=button], [role=radio]')) {
      if (visible(button) && button.parentElement) parents.add(button.parentElement);
    }
    const groups = [];
    for (const parent of parents) {
      const buttons = Array.from(parent.children).filter(
        (child) => child.matches('button, [role=button], [role=radio]') && visible(child),
      );
      if (buttons.length < 2 || buttons.length > 6) continue;
      if (buttons.some((b) => b.type === 'submit' || !norm(b.innerText) || norm(b.innerText).length > 40)) continue;
      if (buttons.some((b) => /submit|apply|next|back|continue|save|cancel|upload|attach|remove|replace/.test(norm(b.innerText)))) continue;
      let container = parent;
      let question = '';
      for (let depth = 0; depth < 4 && container.parentElement; depth += 1) {
        container = container.parentElement;
        // The field's own label or legend, when it has one ("Gender").
        const heading = Array.from(container.querySelectorAll('label, legend, [class*="label"], [class*="Label"]')).find(
          (node) => !node.contains(parent) && norm(node.innerText),
        );
        if (heading) {
          question = norm(heading.innerText).slice(0, 300);
          break;
        }
        let text = container.innerText || '';
        for (const b of buttons) text = text.replace(b.innerText, ' ');
        question = norm(text).slice(0, 300);
        if (question.length > 3) break;
      }
      if (question) groups.push({ parent, buttons, question });
    }
    return groups;
  }

  /** A field's question, as the person reads it: its label, else what is around it. */
  function labelOf(el) {
    const parts = [];
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) parts.push(label.innerText);
    }
    for (const id of (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)) {
      const node = document.getElementById(id);
      if (node) parts.push(node.innerText);
    }
    if (!parts.length && el.getAttribute('aria-label')) parts.push(el.getAttribute('aria-label'));
    if (!parts.length && el.closest('label')) parts.push(el.closest('label').innerText);
    if (!parts.length) {
      let node = el;
      for (let depth = 0; depth < 4 && node.parentElement && !parts.length; depth += 1) {
        node = node.parentElement;
        const text = (node.innerText || '').trim();
        if (text.length > 5) parts.push(text);
      }
    }
    if (!parts.length && el.getAttribute('placeholder')) parts.push(el.getAttribute('placeholder'));
    return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 600);
  }

  let nextQuestionId = 1;

  /** The open questions still empty: every text area, and required one-line fields nothing above filled. */
  function questions() {
    const found = [];
    for (const el of document.querySelectorAll('textarea, input:not([type]), input[type=text]')) {
      if (!visible(el) || el.readOnly || String(el.value || '').trim()) continue;
      const label = labelOf(el);
      const question = label.replace(/\s*\*\s*$/, '').trim();
      if (!question) continue;
      const required = el.required || el.getAttribute('aria-required') === 'true' || /\*\s*$/.test(label);
      if (el.tagName !== 'TEXTAREA' && !required) continue;
      if (/cover[\s_-]*letter/i.test(question)) continue;
      if (!el.dataset.romvaQ) el.dataset.romvaQ = String(nextQuestionId++);
      const maxLength = el.maxLength > 0 ? el.maxLength : null;
      found.push({ id: el.dataset.romvaQ, question, required, maxLength, multiline: el.tagName === 'TEXTAREA' });
    }
    return found;
  }

  /** Types ChatGPT's answers into their fields; a field the person has typed in is left alone. */
  function answer(list) {
    let typed = 0;
    for (const { id, answer: text } of list || []) {
      const value = String(text ?? '').trim();
      if (!value) continue;
      const el = document.querySelector(`[data-romva-q="${CSS.escape(String(id))}"]`);
      if (!el || String(el.value || '').trim()) continue;
      setValue(el, el.maxLength > 0 ? value.slice(0, el.maxLength) : value);
      typed += 1;
    }
    if (typed) {
      totals = { ...totals, filled: totals.filled + typed };
      const host = document.getElementById('romva-apply-banner');
      const strong = host?.shadowRoot?.querySelector('strong');
      if (strong?.nextSibling) {
        strong.nextSibling.textContent = ` filled ${totals.filled} field(s)${totals.files ? ` and attached ${totals.files} file(s)` : ''} for `;
      }
    }
    return typed;
  }

  function fill(data) {
    const a = data.applicant || {};
    let filled = 0;
    let files = 0;

    // Text fields and text areas.
    for (const el of document.querySelectorAll('input:not([type]), input[type=text], input[type=email], input[type=tel], input[type=url], textarea')) {
      if (!visible(el) || el.readOnly || String(el.value || '').trim()) continue;
      const value = textFor(describe(el), el, a, data);
      if (value) {
        setValue(el, value);
        filled += 1;
      }
    }

    // Drop-downs.
    for (const el of document.querySelectorAll('select')) {
      if (!visible(el) || (el.value && el.selectedIndex > 0)) continue;
      const answer = answerFor(describe(el), a);
      const option = pick(Array.from(el.options, (o) => ({ el: o, text: norm(o.text) })), answer);
      if (option) {
        el.value = option.el.value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        mark(el);
        filled += 1;
      }
    }

    // Radio groups, by name.
    const groups = new Map();
    for (const el of document.querySelectorAll('input[type=radio]')) {
      if (!el.name) continue;
      if (!groups.has(el.name)) groups.set(el.name, []);
      groups.get(el.name).push(el);
    }
    for (const radios of groups.values()) {
      if (radios.some((r) => r.checked) || !radios.some(visible)) continue;
      const container = radios[0].closest('fieldset, [role=radiogroup], .field, [class*="question"], [class*="Question"], li') || radios[0].parentElement;
      const answer = answerFor(questionOf(container, radios), a);
      const option = pick(
        radios.map((r) => {
          const label = (r.id && document.querySelector(`label[for="${CSS.escape(r.id)}"]`)) || r.closest('label');
          return { el: r, text: norm(label?.innerText || r.value) };
        }),
        answer,
      );
      if (option) {
        option.el.click();
        mark(option.el.closest('label') || option.el);
        filled += 1;
      }
    }

    // Choice buttons: "Yes / No" (and the like) drawn as buttons, not radios.
    for (const group of buttonGroups()) {
      if (clickedGroups.has(group.parent) || group.buttons.some(selected)) continue;
      const option = pick(
        group.buttons.map((button) => ({ el: button, text: norm(button.innerText) })),
        answerFor(group.question, a),
      );
      if (option) {
        option.el.click();
        clickedGroups.add(group.parent);
        mark(option.el);
        filled += 1;
      }
    }

    // Resume and cover letter uploads.
    const fileInputs = Array.from(document.querySelectorAll('input[type=file]')).filter((el) => !el.disabled);
    let resumePlaced = false;
    for (const el of fileInputs) {
      if (attached.has(el) || (el.files && el.files.length)) {
        resumePlaced ||= !/cover/.test(describe(el));
        continue;
      }
      const d = describe(el);
      let file = null;
      if (/cover/.test(d)) file = data.coverLetter;
      else if (/resume|\bcv\b|curriculum/.test(d) || !resumePlaced) file = data.resume;
      if (file) {
        attach(el, file);
        attached.add(el);
        files += 1;
        if (file === data.resume) resumePlaced = true;
      }
    }

    const unfilledRequired = Array.from(
      document.querySelectorAll('input[required], textarea[required], select[required], [aria-required="true"]'),
    ).filter((el) => visible(el) && !(el.type === 'file' ? el.files?.length : String(el.value || '').trim())).length;

    banner(data, filled, files, unfilledRequired);
    return { filled, files, unfilledRequired };
  }

  let totals = { filled: 0, files: 0 };
  function banner(data, filled, files, unfilledRequired) {
    totals = { filled: totals.filled + filled, files: totals.files + files };
    let host = document.getElementById('romva-apply-banner');
    if (!host) {
      host = document.createElement('div');
      host.id = 'romva-apply-banner';
      host.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:16px;max-width:340px';
      host.attachShadow({ mode: 'open' });
      document.documentElement.appendChild(host);
    }
    const left = unfilledRequired
      ? `<div style="color:#fbbf24;margin-top:4px">${unfilledRequired} required field(s) still empty.</div>`
      : '';
    host.shadowRoot.innerHTML = `
      <div style="font:13px/1.45 system-ui,Segoe UI,sans-serif;background:#0f172a;color:#e5e7eb;border:1px solid #10b981;border-radius:10px;padding:10px 12px;box-shadow:0 6px 24px rgba(0,0,0,.35)">
        <strong style="color:#34d399">Romva</strong> filled ${totals.filled} field(s)${totals.files ? ` and attached ${totals.files} file(s)` : ''}
        for <em>${(data.company || '').replace(/[<>&]/g, '')}</em>.
        ${left}
        <div style="margin-top:4px;color:#94a3b8">Check everything, answer the rest, then click Submit yourself. This tab closes after the application is sent.</div>
      </div>`;
  }

  /** The "application sent" page: thank-you wording, and no application form left on it. */
  function submitted() {
    const text = norm((document.body?.innerText || '').slice(0, 20000));
    const said =
      /thank(s| you) for (applying|your application|submitting)|application (has been |was )?(successfully )?(submitted|received|sent)|we('ve| have) received your application|your application (has been|was) (submitted|received|sent)|successfully applied|application complete/.test(
        text,
      );
    const byUrl = /\/(thanks|thank-you|thankyou|confirmation|submitted|success)(\/|\?|$)/i.test(location.pathname + location.search);
    const formLeft = Array.from(document.querySelectorAll('input[type=file], input[type=email]')).some(visible);
    return (said || byUrl) && !formLeft;
  }

  window.__romvaApply = { fill, submitted, questions, answer };
})();
