# Chisel

A quiet voice-and-text journal that lives in your own Google Drive. There's no server and no database: the app is static files, and everything you write or record goes straight from your browser to your Drive.

- **Hybrid entries.** Type, record a voice note, or do both in one entry. Voice notes can be transcribed live as you speak.
- **Google Drive storage.** Audio files go in a `Chisel` folder you own.
- **A Google Doc log.** You get one Doc per month. Each day is a tab holding that day's log, with links to its entries, and each entry is a tab nested inside its day.
- **Google sign-in.** It uses the `drive.file` scope, so Chisel can only see files it created.

```
Chisel/
├── chisel-index.json            ← powers the list view
└── 2026/
    ├── September 2026           ← Google Doc
    │   ├── 03 · Thursday        ← day tab: that day's log
    │   │   └── 18:12 · Backdated
    │   └── 27 · Sunday
    │       ├── 08:42 · Coffee with Maren   ← entry tab: text, voice-note links, transcripts
    │       └── 19:03 · Evening walk
    └── Voice notes/
        └── 2026-09-27 0842 — Coffee with Maren.webm
```

Open `/?demo` for a preview that works without signing in and saves nothing.

## 1. Google Cloud setup (about five minutes)

1. Go to [console.cloud.google.com](https://console.cloud.google.com/) and create a project (for example, "Chisel").
2. Under **APIs & Services → Library**, enable the **Google Drive API** and the **Google Docs API**.
3. Under **APIs & Services → OAuth consent screen** (Google Auth Platform → Branding / Audience):
   - Set the app name, support email, and developer contact.
   - Set the privacy policy URL to `https://<your-site>/privacy.html`.
   - Under **Data access**, add the scopes `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile` and `.../auth/drive.file`. All of these are non-sensitive, so no Google security review is needed.
   - Under **Audience**, either add yourself as a *test user* (fine for personal use), or click **Publish app** so anyone with a Google account can sign in.
4. Under **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**
   - Authorized JavaScript origins: `https://onslaught13.github.io` (plus `http://localhost:8000` for local testing)
   - No redirect URIs are needed, because sign-in uses the Google Identity Services popup.
5. Copy the **Client ID** (`…apps.googleusercontent.com`). It isn't a secret.

## 2. Publish on GitHub Pages

1. In this repo, go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
2. Go to **Settings → Secrets and variables → Actions → Variables** and add a repository variable named `GOOGLE_CLIENT_ID` containing your client ID.
3. Push to `main` (or run the **Deploy to GitHub Pages** workflow by hand). The site is published at `https://onslaught13.github.io/chisel/`.

The workflow copies `public/` and writes `config.js` from the variable. If the variable is missing, the app asks for a client ID on first visit and keeps it in that browser.

## 2b. Or publish on Netlify

`netlify.toml` is already set up. Its publish directory is `public/`, and its build step writes `config.js` from an environment variable.

1. In Netlify, choose **Add new site → Import an existing project → GitHub**, then pick this repo and branch. Leave the build settings as they are, because they come from `netlify.toml`.
2. Under **Site configuration → Environment variables**, add `GOOGLE_CLIENT_ID` and set it to your client ID. Then trigger a redeploy.
3. Add the site's origin (for example `https://chisel-journal.netlify.app`, or your custom domain) to the OAuth client's **Authorized JavaScript origins**. Also update the consent screen's privacy policy URL.

Deploy previews run on different URLs, so Google sign-in won't work on them unless you add each one as an origin. `/?demo` still works there.

If you only use Netlify, delete `.github/workflows/pages.yml` so GitHub doesn't try to deploy as well.

## Local development

```sh
cd public && python3 -m http.server 8000
# http://localhost:8000        (add this origin to your OAuth client)
# http://localhost:8000/?demo  (no Google needed)
```

## Notes

- **Transcription** uses the browser's Web Speech API. It works in Chrome, Edge, and Safari; in Firefox you can still record audio but won't get a transcript. You can edit a transcript before you save the entry.
- **Audio format** depends on the browser: `.webm` (Opus) in Chrome, Edge and Firefox, `.m4a` in Safari. Both play in Drive.
- **Sessions.** Access tokens last about an hour, and Chisel renews them quietly as you use it. Nothing is stored beyond the current browser tab, apart from cached Drive folder IDs and your last-used email.
- **Editing in Docs.** The Docs are yours to edit. Chisel only rewrites a day tab's log when you add or delete an entry on that day.
