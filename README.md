# Romva Resume Maker (Chrome extension)

Makes the Resume and cover letter for every new **Draft** application on
romva.space with **your own signed-in ChatGPT** in your normal Chrome — no API
key, nothing else to install. Works on any computer with Chrome (Windows, Mac,
Linux).

While you are signed in to romva.space in this Chrome, every 30 seconds it:

1. asks romva.space for the next application (each one goes to one worker only —
   this extension, the desktop agent, or the local API — so several computers
   can run at once),
2. opens a small ChatGPT window with a new temporary chat, sends the Profile's
   Resume prompt and the job post, and waits for the answer,
3. sends the answer to romva.space, which builds the Resume (the Profile's Word
   template + PDF) and attaches it to the application,
4. does the same for the cover letter,
5. saves the five files to `Downloads\Resume\<Profile>\<Company_Role>\`:
   job description (.txt), Resume (.pdf, .docx), cover letter (.pdf, .docx).

The ChatGPT window closes by itself after each chat.

## Install

1. Open `chrome://extensions`, turn on **Developer mode** (top right).
2. **Load unpacked** → choose this `resume_extension` folder.
3. Sign in to **romva.space** and to **chatgpt.com** in this Chrome.
4. Click the extension's icon: it shows your romva.space account and whether
   Auto resume is on.

## Use

- **Start / Stop** (romva.space Applications page, or the extension popup)
  turns every worker on or off.
- **Make Resumes in this browser** (popup) turns just this Chrome on or off.
- Leave Chrome open. If ChatGPT signs out, it pauses and retries every minute.
- If Chrome asks where to save each download, turn off
  *Settings → Downloads → Ask where to save each file*.

## Apply (fill in the application forms — you submit)

In the popup, tick **Open & fill applications** and choose how many tabs to
keep open. Each tab is the application page of a Draft whose Resume and cover
letter are made, already filled in from the Profile — name, email, phone,
links, location, current company and title, the cover letter box, work
authorisation, sponsorship, relocation and the voluntary EEO questions — with
the Resume and cover letter PDFs attached. A small green banner on the page
says what was filled.

- **Apply button** (romva.space Applications table, each row's Actions): opens
  that one job in a new tab and fills it in the same way, even with
  *Open & fill applications* off. After installing or reloading the extension,
  refresh romva.space once so the button can reach it.
- **It never submits.** Check each tab, answer anything left, click Submit.
- When the page says the application was sent, the tab closes and the next job
  opens. Closing a tab yourself also counts as done with that job.
- No screenshot is taken and the status on romva.space is not changed.
- Opened jobs are remembered for 14 days; **Forget opened jobs** opens them again.
- The extension needs access to all sites to fill forms on any job site.
