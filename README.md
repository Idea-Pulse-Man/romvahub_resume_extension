# Romva Resume Maker (Chrome extension)

Makes the Resume and cover letter for every new **Draft** application on
romva.space with **your own signed-in ChatGPT** in your normal Chrome — no API
key, nothing else to install. Works on any computer with Chrome (Windows, Mac,
Linux).

Once you sign in to romva.space in the extension's popup, every 30 seconds it:

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
3. Sign in to **chatgpt.com** in this Chrome.
4. Click the extension's icon and sign in to **romva.space** there (email,
   password, and the authenticator code if your account has one). This is the
   extension's own sign-in: it never uses or renews the romva.space website's,
   so it cannot sign the website out. After a day with Chrome closed, sign in
   again. The popup then shows your romva.space account and whether
   Auto resume is on.

## Use

- **Start / Stop** (romva.space Applications page, or the extension popup)
  turns every worker on or off.
- **Make Resumes in this browser** (popup) turns just this Chrome on or off.
- Leave Chrome open. If ChatGPT signs out, it pauses and retries every minute.
- If Chrome asks where to save each download, turn off
  *Settings → Downloads → Ask where to save each file*.

## Apply

Filling in the application forms (the **Apply** button on romva.space, and
**Alt+V** on sites that need a sign-in) is done by the separate **Romva
Apply** extension in the [`altv`](../altv/) folder. Install both to have
Resumes made and forms filled.
