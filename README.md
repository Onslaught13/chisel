# Chisel

A quiet voice-and-text journal. Anyone can sign up with email and password or with Google. Entries are private to each account, and anyone can optionally keep a copy of their journal in their own Google Drive.

- **Hybrid entries.** Type, record a voice note, or do both in one entry. Voice notes can be transcribed live as you speak.
- **Accounts** use [Supabase](https://supabase.com) Auth: email + password, or Google. Apple is planned.
- **Storage** is Supabase Postgres for entries, plus a private Storage bucket for audio. Row-level security means each account can only read its own rows and files.
- **Optional Google Drive copy.** It's a one-way sync into the user's own Drive: one Doc per month, a tab per day holding that day's log, a tab per entry nested inside its day, and audio files. It uses the `drive.file` scope, so Chisel only sees files it created.

```
Chisel/                              (in the user's Google Drive, if they connect it)
└── 2026/
    ├── September 2026               ← Google Doc
    │   └── 27 · Sunday              ← day tab: log with links to each entry
    │       ├── 08:42 · Coffee with Maren
    │       └── 19:03 · Evening walk
    └── Voice notes/
        └── 2026-09-27 0842 — Coffee with Maren.webm
```

`/?demo` shows the whole UI without an account, and saves nothing.

## Architecture

| Piece | Where |
|---|---|
| Static site (`public/`) | Netlify |
| Auth, database, audio storage | Supabase project `chisel` (`xhqokhbqegxyidzqecyj`, Singapore) |
| Drive copy | Runs in the browser with Google Identity Services. The Drive token never leaves the browser. |

Tables (see `supabase/migrations/`):
- `entries`: one row per entry. `drive` records where the entry was copied in Drive.
- `clips`: the voice notes for an entry, with the storage path, duration, transcript and Drive file ID.
- `drive_sync`: one row per user who connected Drive. It holds cached folder and Doc IDs, the day-tab map, and Drive deletions queued for the next sync.
- `delete_account()`: an RPC that deletes the caller's own account. Their rows go with it through the cascades; the app removes their audio files first.

Drive sync runs whenever the app is open and Google access is still valid (tokens last about an hour). New entries are copied right after saving. If Google access has expired, entries wait, and a banner asks the user to click **Sync now**, which re-opens Google's popup. Deletions are queued the same way.

## Setup checklist

### 1. Google Cloud (one OAuth client for both sign-in and Drive)

1. In [console.cloud.google.com](https://console.cloud.google.com/), create a project and enable the **Google Drive API** and the **Google Docs API**.
2. Set up the **OAuth consent screen**: app name, support email, logo (optional), and the privacy policy URL `https://<your-site>/privacy.html`. Add the scopes `openid`, `userinfo.email`, `userinfo.profile` and `drive.file`. All are non-sensitive.
3. Under **Audience**, click **Publish app** so anyone can sign in. In *Testing* mode, only listed test users can.
4. Under **Credentials → Create OAuth client ID → Web application**, add:
   - **Authorized JavaScript origins:** your Netlify URL, for example `https://chisel-journal.netlify.app`, plus `http://localhost:8000` for local testing.
   - **Authorized redirect URIs:** `https://xhqokhbqegxyidzqecyj.supabase.co/auth/v1/callback`
5. Keep the **Client ID** and **Client secret** handy.

### 2. Supabase dashboard (project `chisel`)

1. **Authentication → Sign In / Providers → Google:** enable it, paste the client ID and secret, and save.
2. **Authentication → Sign In / Providers → Email:** keep *Confirm email* on, and set the minimum password length to 8.
3. **Authentication → URL Configuration:**
   - **Site URL:** your Netlify URL.
   - **Redirect URLs:** `https://<your-site>/**` and `http://localhost:8000/**`.
4. **Authentication → Emails → SMTP settings:** before real users arrive, connect an email provider such as Resend or Postmark. The built-in sender only allows a few emails per hour, which isn't enough for sign-ups and password resets.
5. Optionally, customise the email templates under **Authentication → Emails** so they say "Chisel".

The database schema, access rules and storage bucket are already applied.

### 3. Netlify

1. **Add new site → Import from GitHub** and pick this repo. `netlify.toml` publishes `public/`.
2. Under **Site configuration → Environment variables**, add `GOOGLE_CLIENT_ID`. It turns on "Connect Google Drive"; without it, that option is hidden. `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` are optional overrides of the values in `public/config.js`.
3. Redeploy. Deploy previews live on other URLs, so sign-in there only works if you add them to Supabase's redirect URLs and Google's JavaScript origins.

### 4. Before launch

- Replace the placeholder contact email in `public/privacy.html`.
- Supabase free projects pause after a week of inactivity and include 1 GB of file storage. For a public app, move to the Pro plan.

## Local development

```sh
cd public && python3 -m http.server 8000
# http://localhost:8000        (add this origin to Google and Supabase, as above)
# http://localhost:8000/?demo  (no account needed)
```

## Notes

- **Transcription** uses the browser's Web Speech API. It works in Chrome, Edge and Safari; in Firefox, recording still works but you won't get a transcript. You can edit a transcript before saving the entry.
- **Audio format** depends on the browser: `.webm` (Opus) in Chrome, Edge and Firefox, `.m4a` in Safari.
- **Disconnecting Drive** leaves the copy in place. Connecting again makes a fresh copy of the whole journal.
- **Apple sign-in** needs an Apple Developer account. Enable it under Supabase → Auth → Providers → Apple, then add a button next to Google's.
