/* Chisel — a private voice + text journal.
 *
 * Accounts and entries live in Supabase (email + password or Google sign-in; row-level security keeps
 * every row private to its owner; voice notes go in the private "voice-notes" storage bucket).
 *
 * Google Drive is an optional one-way copy the user can connect at any time:
 *   Chisel/
 *     2026/
 *       September 2026           Google Doc: one tab per day (a log), one child tab per entry
 *       Voice notes/             audio files, linked from the entry tabs
 * Drive uses the narrow drive.file scope, so Chisel only ever sees files it created.
 */
(() => {
  'use strict';

  // ============ CONFIG ============
  const CFG = window.CHISEL_CONFIG || {};
  const DEMO = new URLSearchParams(location.search).has('demo');
  const BUCKET = 'voice-notes';
  const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const DRIVE_SCOPES = 'openid email ' + DRIVE_SCOPE;
  const ROOT_NAME = 'Chisel';
  const AUDIO_FOLDER = 'Voice notes';
  const DRIVE = 'https://www.googleapis.com/drive/v3';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
  const DOCS = 'https://docs.googleapis.com/v1';
  const FOLDER = 'application/vnd.google-apps.folder';
  const GDOC = 'application/vnd.google-apps.document';
  const SITE_URL = location.origin + location.pathname;

  // ============ UTIL ============
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = n => String(n).padStart(2, '0');
  const isoDate = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const hhmm = d => pad(d.getHours()) + ':' + pad(d.getMinutes());
  const asDate = s => new Date(s + 'T00:00:00');
  const fmtDur = sec => { const s = Math.max(0, Math.round(sec || 0)); return Math.floor(s / 60) + ':' + pad(s % 60); };
  const fmtLong = s => asDate(s).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const monthName = (y, m) => new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = crypto.getRandomValues(new Uint8Array(1))[0] & 15; return (c === 'x' ? r : (r & 3) | 8).toString(16);
  }));
  const truncate = (s, n) => s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s;
  const safe = (store) => ({
    get(k) { try { return store.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { store.setItem(k, v); } catch (e) { } },
    del(k) { try { store.removeItem(k); } catch (e) { } },
  });
  const local = safe(window.localStorage), session = safe(window.sessionStorage);

  let toastTimer;
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }
  function sync(state, text) { $('sync').className = 'sync ' + state; $('syncText').textContent = text; }

  const ICON = {
    play: '<svg viewBox="0 0 12 12"><path d="M3 1.5v9l7.5-4.5z"/></svg>',
    pause: '<svg viewBox="0 0 12 12"><path d="M2.5 1.5h2.5v9H2.5zM7 1.5h2.5v9H7z"/></svg>',
    x: '<svg viewBox="0 0 12 12"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7"/></svg>',
    mic: '<svg viewBox="0 0 12 12"><rect x="4" y="1" width="4" height="6.5" rx="2"/><path d="M2.5 6a3.5 3.5 0 0 0 7 0M6 9.5V11"/></svg>',
  };

  function show(view) {
    $('welcome').hidden = view !== 'welcome';
    $('misconfigured').hidden = view !== 'misconfigured';
    $('app').hidden = view !== 'app';
    $('account').hidden = view !== 'app';
    $('foot').hidden = view !== 'app';
  }

  // ============ SUPABASE ============
  // Read these before the client consumes the URL fragment.
  const urlParams = new URLSearchParams(location.hash.slice(1) + '&' + location.search.slice(1));
  let recovering = urlParams.get('type') === 'recovery';
  const urlError = urlParams.get('error_description');

  const sb = (!DEMO && CFG.supabaseUrl && CFG.supabaseKey && window.supabase)
    ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })
    : null;
  let user = null;

  // ============ AUTH UI ============
  let authMode = 'signin';
  const authCopy = {
    signin: { title: 'Sign in', submit: 'Sign in', switchText: 'New to Chisel?', switchBtn: 'Create an account', pwAuto: 'current-password' },
    signup: { title: 'Create your account', submit: 'Create account', switchText: 'Already have an account?', switchBtn: 'Sign in', pwAuto: 'new-password' },
    reset: { title: 'Reset your password', submit: 'Send reset link', switchText: 'Remembered it?', switchBtn: 'Sign in', pwAuto: 'current-password' },
  };
  function setAuthMode(mode) {
    authMode = mode; const c = authCopy[mode];
    $('authTitle').textContent = c.title; $('authSubmit').textContent = c.submit;
    $('switchText').textContent = c.switchText; $('switchBtn').textContent = c.switchBtn;
    $('authPassword').autocomplete = c.pwAuto;
    $('pwField').hidden = mode === 'reset';
    $('forgotBtn').hidden = mode !== 'signin';
    $('googleBtn').hidden = mode === 'reset';
    document.querySelector('.or').hidden = mode === 'reset';
    authError('');
    $('authMain').hidden = false; $('authMsg').hidden = true; $('newPassForm').hidden = true;
  }
  function authError(msg, el = 'authErr') { $(el).textContent = msg; $(el).hidden = !msg; }
  function authMessage(title, text) {
    $('authMsgTitle').textContent = title; $('authMsgText').textContent = text;
    $('authMain').hidden = true; $('newPassForm').hidden = true; $('authMsg').hidden = false;
  }
  function friendly(err) {
    const code = err && (err.code || ''), msg = (err && err.message) || String(err);
    if (code === 'invalid_credentials' || /invalid login credentials/i.test(msg)) return 'That email and password don’t match.';
    if (code === 'email_not_confirmed' || /email not confirmed/i.test(msg)) return 'Please confirm your email first — the link is in your inbox.';
    if (code === 'user_already_exists') return 'That email already has an account. Try signing in.';
    if (code === 'over_email_send_rate_limit' || /rate limit/i.test(msg)) return 'Too many emails sent just now. Please try again in a little while.';
    if (code === 'weak_password') return msg;
    if (/fetch|network/i.test(msg)) return 'Can’t reach Chisel right now. Check your connection and try again.';
    return msg;
  }

  $('switchBtn').onclick = () => setAuthMode(authMode === 'signin' ? 'signup' : 'signin');
  $('forgotBtn').onclick = () => setAuthMode('reset');
  $('authBack').onclick = () => setAuthMode('signin');

  $('authForm').addEventListener('submit', async ev => {
    ev.preventDefault();
    const email = $('authEmail').value.trim(), password = $('authPassword').value;
    if (!/^\S+@\S+\.\S+$/.test(email)) { authError('Enter a valid email address.'); return; }
    if (authMode !== 'reset' && password.length < 8) { authError('Passwords are at least 8 characters.'); return; }
    if (DEMO || !sb) { authError('Sign-in isn’t available in the preview.'); return; }
    authError(''); const btn = $('authSubmit'); btn.disabled = true;
    try {
      if (authMode === 'signin') {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else if (authMode === 'signup') {
        const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: SITE_URL } });
        if (error) throw error;
        if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
          authError('That email already has an account. Sign in, or reset your password.'); return;
        }
        if (!data.session) authMessage('Check your inbox', 'We sent a confirmation link to ' + email + '. Open it to finish creating your account.');
      } else {
        const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: SITE_URL });
        if (error) throw error;
        authMessage('Check your inbox', 'If there’s an account for ' + email + ', you’ll get a link to choose a new password.');
      }
    } catch (err) { authError(friendly(err)); }
    finally { btn.disabled = false; }
  });

  $('googleBtn').onclick = async () => {
    if (DEMO || !sb) { authError('Sign-in isn’t available in the preview.'); return; }
    const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: SITE_URL } });
    if (error) authError(friendly(error));
  };

  $('newPassForm').addEventListener('submit', async ev => {
    ev.preventDefault();
    const password = $('newPassword').value;
    if (password.length < 8) { authError('Passwords are at least 8 characters.', 'newPassErr'); return; }
    const { error } = await sb.auth.updateUser({ password });
    if (error) { authError(friendly(error), 'newPassErr'); return; }
    recovering = false; toast('Password updated');
    const { data } = await sb.auth.getSession();
    if (data.session) signedIn(data.session.user);
  });
  function showNewPassword() {
    show('welcome'); $('authMain').hidden = true; $('authMsg').hidden = true; $('newPassForm').hidden = false;
    $('newPassword').focus();
  }

  async function boot() {
    if (DEMO) { await startDemo(); return; }
    if (!sb) { show('misconfigured'); return; }
    setAuthMode('signin');
    if (urlError) { show('welcome'); authError(urlError.replace(/\+/g, ' ')); }
    sb.auth.onAuthStateChange((event, s) => {
      // Don't await Supabase calls inside this callback; defer them.
      if (event === 'PASSWORD_RECOVERY') { recovering = true; setTimeout(showNewPassword, 0); return; }
      if (recovering) { if (s) setTimeout(showNewPassword, 0); return; }
      if (s && s.user) { if (!user || user.id !== s.user.id) { user = s.user; setTimeout(() => signedIn(s.user), 0); } }
      else if (event === 'SIGNED_OUT' || event === 'INITIAL_SESSION') { user = null; show('welcome'); }
    });
    if (urlError) history.replaceState(null, '', SITE_URL);   // Supabase clears successful sign-in fragments itself
  }

  $('signout').onclick = async () => {
    revokeDriveToken();
    if (!DEMO) await sb.auth.signOut();
    location.replace(SITE_URL);
  };

  // ============ DATA: Supabase ============
  let entries = [];
  const sortEntries = () => entries.sort((a, b) => (b.date + b.time + b.createdAt).localeCompare(a.date + a.time + a.createdAt));
  const fromRow = r => ({
    id: r.id, title: r.title, text: r.body, with: r.with_whom, tags: r.tags || [], date: r.entry_date, time: r.entry_time,
    createdAt: r.created_at, drive: r.drive,
    clips: (r.clips || []).sort((a, b) => a.position - b.position).map(c => ({
      id: c.id, path: c.storage_path, mime: c.mime, duration: c.duration, transcript: c.transcript,
      driveFileId: c.drive_file_id, driveLink: c.drive_link,
    })),
  });
  const extFor = mime => /mp4|m4a|aac/.test(mime) ? 'm4a' : /ogg/.test(mime) ? 'ogg' : /wav/.test(mime) ? 'wav' : /mpeg/.test(mime) ? 'mp3' : 'webm';
  const blobCache = {};   // clip id -> Blob recorded on this device (saves a download when copying to Drive)
  const must = ({ data, error }) => { if (error) throw error; return data; };

  const cloud = {
    async load() {
      const out = [];
      for (let from = 0; ; from += 1000) {
        const rows = must(await sb.from('entries')
          .select('id,title,body,with_whom,tags,entry_date,entry_time,created_at,drive,clips(id,position,storage_path,mime,duration,transcript,drive_file_id,drive_link)')
          .order('entry_date', { ascending: false }).order('entry_time', { ascending: false })
          .range(from, from + 999));
        out.push(...rows.map(fromRow));
        if (rows.length < 1000) break;
      }
      return out;
    },

    async save(e, draftClips) {
      const clipRows = draftClips.map((d, i) => ({
        id: d.remoteId || (d.remoteId = uuid()), entry_id: e.id, user_id: user.id, position: i,
        storage_path: user.id + '/' + e.id + '/' + (d.remoteId) + '.' + extFor(d.mime),
        mime: d.mime.split(';')[0], duration: d.duration, transcript: d.transcript.trim(),
      }));
      const uploaded = [];
      try {
        for (let i = 0; i < clipRows.length; i++) {
          sync('busy', 'Uploading voice note' + (clipRows.length > 1 ? ' ' + (i + 1) + '/' + clipRows.length : '') + '…');
          must(await sb.storage.from(BUCKET).upload(clipRows[i].storage_path, draftClips[i].blob, { contentType: clipRows[i].mime, upsert: true }));
          uploaded.push(clipRows[i].storage_path);
        }
        sync('busy', 'Saving…');
        const row = must(await sb.from('entries').insert({
          id: e.id, user_id: user.id, title: e.title, body: e.text, with_whom: e.with, tags: e.tags,
          entry_date: e.date, entry_time: e.time,
        }).select('created_at').single());
        e.createdAt = row.created_at;
        if (clipRows.length) {
          const { error } = await sb.from('clips').insert(clipRows);
          if (error) { await sb.from('entries').delete().eq('id', e.id); throw error; }
        }
      } catch (err) {
        if (uploaded.length) await sb.storage.from(BUCKET).remove(uploaded).catch(() => { });
        throw err;
      }
      e.clips = clipRows.map((r, i) => { blobCache[r.id] = draftClips[i].blob; return { id: r.id, path: r.storage_path, mime: r.mime, duration: r.duration, transcript: r.transcript }; });
      e.drive = null;
      entries.push(e); sortEntries();
    },

    async remove(e) {
      const paths = e.clips.map(c => c.path).filter(Boolean);
      must(await sb.from('entries').delete().eq('id', e.id));
      if (paths.length) await sb.storage.from(BUCKET).remove(paths).catch(() => { });
      entries = entries.filter(x => x.id !== e.id);
    },

    async audioBlob(c) {
      if (blobCache[c.id]) return blobCache[c.id];
      return must(await sb.storage.from(BUCKET).download(c.path));
    },
  };

  // Preview mode: same UI, nothing leaves the browser.
  const demo = {
    async load() { return entries; },
    async save(e, draftClips) {
      await new Promise(r => setTimeout(r, 400));
      e.clips = draftClips.map(d => { const id = uuid(); blobCache[id] = d.blob; return { id, mime: d.mime, duration: d.duration, transcript: d.transcript.trim() }; });
      entries.push(e); sortEntries();
    },
    async remove(e) { entries = entries.filter(x => x.id !== e.id); },
    async audioBlob(c) { if (!blobCache[c.id]) throw new Error('Sample entries have no audio.'); return blobCache[c.id]; },
  };
  const backend = DEMO ? demo : cloud;

  // ============ GOOGLE DRIVE: auth ============
  let drive = null;                       // this user's drive_sync row, or null when not connected
  let gToken = null, gTokenExp = 0, tokenClient = null, syncing = false;
  const gTokenKey = () => 'chisel.gtoken.' + (user ? user.id : '');
  const driveTokenValid = () => !!(gToken && gTokenExp > Date.now());
  const driveReady = () => !!(drive && driveTokenValid());
  const waitForGis = () => new Promise((res, rej) => {
    const t0 = Date.now();
    (function poll() {
      if (window.google && google.accounts && google.accounts.oauth2) res();
      else if (Date.now() - t0 > 8000) rej(new Error('Couldn’t load Google sign-in. Check your connection or ad blocker.'));
      else setTimeout(poll, 80);
    })();
  });
  function restoreDriveToken() {
    try { const t = JSON.parse(session.get(gTokenKey()) || 'null'); if (t && t.exp > Date.now() + 60000) { gToken = t.token; gTokenExp = t.exp; } } catch (e) { }
  }
  function revokeDriveToken() {
    if (gToken && window.google && google.accounts) google.accounts.oauth2.revoke(gToken, () => { });
    gToken = null; gTokenExp = 0; session.del(gTokenKey());
  }
  // Must be called from a click: Google shows a popup.
  async function requestDriveToken(prompt, hint) {
    if (!CFG.googleClientId) throw new Error('Google Drive isn’t set up on this site yet.');
    await waitForGis();
    if (!tokenClient) tokenClient = google.accounts.oauth2.initTokenClient({ client_id: CFG.googleClientId, scope: DRIVE_SCOPES, callback: () => { } });
    const token = await new Promise((resolve, reject) => {
      tokenClient.callback = resp => {
        if (resp.error) { reject(new Error(resp.error_description || resp.error)); return; }
        if (!google.accounts.oauth2.hasGrantedAllScopes(resp, DRIVE_SCOPE)) { reject(new Error('Chisel needs permission to create files in your Drive to keep a copy there.')); return; }
        gTokenExp = Date.now() + (resp.expires_in - 60) * 1000;
        resolve(resp.access_token);
      };
      tokenClient.error_callback = e => reject(new Error(e.type === 'popup_closed' ? 'The Google window was closed.' : e.type === 'popup_failed_to_open' ? 'Your browser blocked the Google window. Allow pop-ups for this site.' : (e.message || e.type || 'Google sign-in failed.')));
      const opts = { prompt }; if (hint) opts.login_hint = hint;
      tokenClient.requestAccessToken(opts);
    });
    gToken = token;
    session.set(gTokenKey(), JSON.stringify({ token: gToken, exp: gTokenExp }));
    return token;
  }

  async function gapi(url, opts = {}) {
    if (!driveTokenValid()) { const e = new Error('Google Drive needs you to sign in again.'); e.code = 'drive_auth'; throw e; }
    const headers = Object.assign({ Authorization: 'Bearer ' + gToken }, opts.headers || {});
    let body = opts.body;
    if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.json); }
    const r = await fetch(url, { method: opts.method || 'GET', headers, body });
    if (r.status === 401) { gToken = null; gTokenExp = 0; session.del(gTokenKey()); const e = new Error('Google Drive needs you to sign in again.'); e.code = 'drive_auth'; throw e; }
    if (!r.ok) {
      let msg = r.status + ' ' + r.statusText;
      try { const j = await r.json(); msg = (j.error && j.error.message) || msg; } catch (e) { }
      const err = new Error(msg); err.status = r.status; throw err;
    }
    if (r.status === 204) return null;
    const ct = r.headers.get('content-type') || '';
    return ct.includes('application/json') ? r.json() : r.text();
  }

  // ============ GOOGLE DRIVE: files ============
  const dq = s => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  async function findOrCreate(key, name, mime, parentId) {
    const ids = drive.ids;
    if (ids[key]) {
      try { const f = await gapi(DRIVE + '/files/' + ids[key] + '?fields=id,trashed'); if (!f.trashed) return ids[key]; } catch (e) { if (e.code === 'drive_auth') throw e; }
      delete ids[key];
    }
    const query = "name='" + dq(name) + "' and mimeType='" + mime + "' and trashed=false" + (parentId ? " and '" + parentId + "' in parents" : '');
    const res = await gapi(DRIVE + '/files?q=' + encodeURIComponent(query) + '&fields=files(id)&orderBy=createdTime&pageSize=1');
    let id = res.files && res.files[0] && res.files[0].id;
    if (!id) {
      const body = { name, mimeType: mime }; if (parentId) body.parents = [parentId];
      id = (await gapi(DRIVE + '/files?fields=id', { method: 'POST', json: body })).id;
    }
    ids[key] = id; return id;
  }
  const rootId = () => findOrCreate('root', ROOT_NAME, FOLDER, null);
  const yearId = async y => findOrCreate('y:' + y, String(y), FOLDER, await rootId());
  const audioFolderId = async y => findOrCreate('a:' + y, AUDIO_FOLDER, FOLDER, await yearId(y));
  const monthDocId = async (y, m) => findOrCreate('m:' + y + '-' + pad(m), monthName(y, m), GDOC, await yearId(y));
  const forgetId = id => { Object.keys(drive.ids).forEach(k => { if (drive.ids[k] === id) delete drive.ids[k]; }); };

  async function uploadFile(name, mime, blob, parentId) {
    const boundary = 'chisel' + uuid();
    const body = new Blob([
      '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify({ name, mimeType: mime, parents: [parentId] }) + '\r\n',
      '--' + boundary + '\r\nContent-Type: ' + mime + '\r\n\r\n', blob, '\r\n--' + boundary + '--',
    ]);
    return gapi(UPLOAD + '/files?uploadType=multipart&fields=id,webViewLink', { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body });
  }
  const trashFile = id => gapi(DRIVE + '/files/' + id + '?fields=id', { method: 'PATCH', json: { trashed: true } });

  // ============ GOOGLE DRIVE: Docs with a tab per day, a child tab per entry ============
  const getDoc = (id, content = true) => gapi(DOCS + '/documents/' + id + '?includeTabsContent=' + content);
  const docBatch = (id, requests) => gapi(DOCS + '/documents/' + id + ':batchUpdate', { method: 'POST', json: { requests } });
  function allTabs(tabs, out = [], parent = null) {
    for (const t of tabs || []) { out.push({ tab: t, parent }); allTabs(t.childTabs, out, t); }
    return out;
  }
  const tabIdOf = t => t.tabProperties.tabId;
  const findTab = (doc, id) => { const hit = allTabs(doc.tabs).find(x => tabIdOf(x.tab) === id); return hit && hit.tab; };
  const tabEnd = tab => ((tab.documentTab && tab.documentTab.body && tab.documentTab.body.content) || []).reduce((n, c) => Math.max(n, c.endIndex || 0), 1);
  const dayTabTitle = date => { const d = asDate(date); return pad(d.getDate()) + ' · ' + d.toLocaleDateString(undefined, { weekday: 'long' }); };
  const entryTabTitle = e => e.time + ' · ' + truncate(e.title, 44);
  const docUrl = (docId, tabId) => 'https://docs.google.com/document/d/' + docId + '/edit' + (tabId ? '?tab=' + encodeURIComponent(tabId) : '');

  async function addTab(docId, props) {
    const r = await docBatch(docId, [{ addDocumentTab: { tabProperties: props } }]);
    let id = r && r.replies && r.replies[0] && r.replies[0].addDocumentTab && r.replies[0].addDocumentTab.tabProperties && r.replies[0].addDocumentTab.tabProperties.tabId;
    if (!id) {
      const d = await getDoc(docId, false);
      const hit = allTabs(d.tabs).filter(x => x.tab.tabProperties.title === props.title && (x.parent ? tabIdOf(x.parent) : undefined) === props.parentTabId).pop();
      id = hit && tabIdOf(hit.tab);
    }
    if (!id) throw new Error('Could not create a tab in the month’s document.');
    return id;
  }

  // Builds a block of text plus the styling requests that go with it, for one tab.
  function composer() {
    let text = ''; const marks = [];
    const self = {
      add(str, style) { const start = text.length; text += str; if (style) marks.push({ start, end: text.length, style }); return self; },
      requests(tabId) {
        if (!text) return [];
        const reqs = [
          { insertText: { location: { index: 1, tabId }, text } },
          { updateParagraphStyle: { range: { startIndex: 1, endIndex: 1 + text.length, tabId }, paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, fields: 'namedStyleType' } },
          { updateTextStyle: { range: { startIndex: 1, endIndex: 1 + text.length, tabId }, textStyle: {}, fields: 'bold,italic,link,foregroundColor,fontSize' } },
        ];
        for (const m of marks) {
          const range = { startIndex: 1 + m.start, endIndex: 1 + m.end, tabId };
          if (m.style.para) reqs.push({ updateParagraphStyle: { range, paragraphStyle: { namedStyleType: m.style.para }, fields: 'namedStyleType' } });
          // Character styles stop short of the paragraph's newline.
          const end = text[m.end - 1] === '\n' ? m.end - 1 : m.end;
          if (m.style.text && end > m.start) reqs.push({ updateTextStyle: { range: { startIndex: 1 + m.start, endIndex: 1 + end, tabId }, textStyle: m.style.text, fields: Object.keys(m.style.text).join(',') } });
        }
        return reqs;
      },
    };
    return self;
  }
  const MUTED = { foregroundColor: { color: { rgbColor: { red: .52, green: .51, blue: .48 } } } };
  const SMALL = { fontSize: { magnitude: 10, unit: 'PT' } };

  async function ensureDayTab(docId, date) {
    const doc = await getDoc(docId);
    const known = drive.days[date];
    if (known && known.docId === docId && findTab(doc, known.tabId)) return known.tabId;
    const top = doc.tabs || [];
    const title = dayTabTitle(date);
    let tabId;
    const byTitle = top.find(t => t.tabProperties.title === title);
    if (byTitle) tabId = tabIdOf(byTitle);
    else if (top.length === 1 && !(top[0].childTabs || []).length && tabEnd(top[0]) <= 2) {
      // A new doc comes with one empty "Tab 1" — make it this day's tab.
      tabId = tabIdOf(top[0]);
      await docBatch(docId, [{ updateDocumentTabProperties: { tabProperties: { tabId, title }, fields: 'title' } }]);
    } else {
      // Keep day tabs in date order.
      const dateOfTab = id => Object.keys(drive.days).find(d => drive.days[d].tabId === id && drive.days[d].docId === docId);
      const later = top.findIndex(t => { const d = dateOfTab(tabIdOf(t)); return d && d > date; });
      tabId = await addTab(docId, { title, index: later === -1 ? top.length : later });
    }
    drive.days[date] = { docId, tabId };
    return tabId;
  }

  async function writeDayLog(docId, dayTabId, date) {
    const doc = await getDoc(docId);
    const tab = findTab(doc, dayTabId); if (!tab) return;
    const end = tabEnd(tab);
    const day = entries.filter(e => e.date === date && e.drive && e.drive.dayTabId === dayTabId && e.drive.docId === docId)
      .sort((a, b) => (a.time + a.createdAt).localeCompare(b.time + b.createdAt));
    const voiceSec = day.reduce((n, e) => n + e.clips.reduce((m, c) => m + (c.duration || 0), 0), 0);
    const c = composer();
    c.add(fmtLong(date) + '\n', { para: 'TITLE' });
    c.add([day.length + (day.length === 1 ? ' entry' : ' entries'), voiceSec ? fmtDur(voiceSec) + ' spoken' : ''].filter(Boolean).join('  ·  ') + '\n', { text: Object.assign({}, MUTED) });
    c.add('\n');
    for (const e of day) {
      c.add(e.time + '    ', { text: Object.assign({}, MUTED) });
      c.add(e.title, { text: { link: { tabId: e.drive.tabId } } });
      const bits = [];
      if (e.clips.length) bits.push(e.clips.length === 1 ? 'voice note ' + fmtDur(e.clips[0].duration) : e.clips.length + ' voice notes');
      if (e.with) bits.push('with ' + e.with);
      if (bits.length) c.add('    ' + bits.join('  ·  '), { text: Object.assign({}, MUTED) });
      c.add('\n');
    }
    const reqs = [];
    if (end > 2) reqs.push({ deleteContentRange: { range: { startIndex: 1, endIndex: end - 1, tabId: dayTabId } } });
    await docBatch(docId, reqs.concat(c.requests(dayTabId)));
  }

  async function writeEntryTab(docId, dayTabId, e) {
    const tabId = await addTab(docId, { title: entryTabTitle(e), parentTabId: dayTabId });
    const c = composer();
    c.add(e.title + '\n', { para: 'HEADING_1' });
    const meta = [fmtLong(e.date), e.time, e.with ? 'with ' + e.with : '', e.tags.length ? '#' + e.tags.join('  #') : ''].filter(Boolean).join('  ·  ');
    c.add(meta + '\n', { text: Object.assign({}, MUTED) });
    if (e.text) { c.add('\n'); c.add(e.text.replace(/\r/g, '') + '\n'); }
    e.clips.forEach((cl, i) => {
      c.add('\n');
      c.add('▶  Voice note' + (e.clips.length > 1 ? ' ' + (i + 1) : '') + '  ·  ' + fmtDur(cl.duration) + '\n', { para: 'HEADING_3', text: { link: { url: cl.driveLink } } });
      c.add((cl.transcript || 'No transcript.') + '\n', { text: Object.assign({ italic: true }, cl.transcript ? {} : MUTED) });
    });
    c.add('\n');
    c.add('Copied from Chisel · ' + new Date(e.createdAt).toLocaleString() + '\n', { text: Object.assign({}, MUTED, SMALL) });
    await docBatch(docId, c.requests(tabId));
    return tabId;
  }

  // ============ GOOGLE DRIVE: sync ============
  const fileSafe = s => s.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();

  async function copyEntryToDrive(e) {
    const [y, m] = e.date.split('-').map(Number);
    for (let i = 0; i < e.clips.length; i++) {
      const c = e.clips[i];
      if (c.driveFileId) continue;
      const blob = await backend.audioBlob(c);
      const name = fileSafe(e.date + ' ' + e.time.replace(':', '') + ' — ' + e.title + (e.clips.length > 1 ? ' (' + (i + 1) + ')' : '')) + '.' + extFor(c.mime);
      const f = await uploadFile(name, c.mime, blob, await audioFolderId(y));
      c.driveFileId = f.id; c.driveLink = f.webViewLink || ('https://drive.google.com/file/d/' + f.id + '/view');
      must(await sb.from('clips').update({ drive_file_id: c.driveFileId, drive_link: c.driveLink }).eq('id', c.id));
    }
    const docId = await monthDocId(y, m);
    const dayTabId = await ensureDayTab(docId, e.date);
    const tabId = await writeEntryTab(docId, dayTabId, e);
    const ref = { docId, dayTabId, tabId, syncedAt: new Date().toISOString() };
    must(await sb.from('entries').update({ drive: ref }).eq('id', e.id));
    e.drive = ref;
    try { await writeDayLog(docId, dayTabId, e.date); } catch (err) { if (err.code === 'drive_auth') throw err; console.warn('Day log not updated', err); }
  }

  async function removeFromDrive(d) {
    for (const id of d.fileIds || []) { try { await trashFile(id); } catch (err) { if (err.code === 'drive_auth') throw err; } }
    try { await docBatch(d.docId, [{ deleteTab: { tabId: d.tabId } }]); }
    catch (err) { if (err.code === 'drive_auth') throw err; if (err.status !== 400 && err.status !== 404) throw err; }
    const rest = entries.filter(x => x.drive && x.drive.dayTabId === d.dayTabId && x.drive.docId === d.docId);
    try {
      if (rest.length) await writeDayLog(d.docId, d.dayTabId, d.date);
      else {
        const doc = await getDoc(d.docId, false);
        if ((doc.tabs || []).length > 1) await docBatch(d.docId, [{ deleteTab: { tabId: d.dayTabId } }]);
        else { await trashFile(d.docId); forgetId(d.docId); }
        if (drive.days[d.date] && drive.days[d.date].tabId === d.dayTabId) delete drive.days[d.date];
      }
    } catch (err) { if (err.code === 'drive_auth') throw err; if (err.status !== 404) throw err; }
  }

  async function saveDriveState() {
    if (!drive || DEMO) return;
    must(await sb.from('drive_sync').update({
      ids: drive.ids, days: drive.days, pending_deletes: drive.pending_deletes, updated_at: new Date().toISOString(),
    }).eq('user_id', user.id));
  }

  const pendingCount = () => drive ? entries.filter(e => !e.drive).length + drive.pending_deletes.length : 0;

  async function syncDrive() {
    if (syncing || !driveReady()) { updateDriveUI(); return; }
    syncing = true; updateDriveUI();
    let done = 0;
    try {
      while (drive.pending_deletes.length) {
        sync('busy', 'Updating Drive…');
        await removeFromDrive(drive.pending_deletes[0]);
        drive.pending_deletes.shift();
        await saveDriveState();
      }
      const todo = entries.filter(e => !e.drive).sort((a, b) => (a.date + a.time + a.createdAt).localeCompare(b.date + b.time + b.createdAt));
      for (const e of todo) {
        if (!drive) break;                                           // disconnected mid-sync
        sync('busy', todo.length > 1 ? 'Copying to Drive ' + (done + 1) + '/' + todo.length + '…' : 'Copying to Drive…');
        await copyEntryToDrive(e);
        done++;
        await saveDriveState();
        render();
      }
      sync('ok', 'Saved');
      if (done > 1) toast(done + ' entries copied to Google Drive');
    } catch (err) {
      await saveDriveState().catch(() => { });
      if (err.code === 'drive_auth') sync('ok', 'Saved');
      else { sync('err', 'Drive sync problem'); toast('Google Drive: ' + err.message); }
    } finally { syncing = false; updateDriveUI(); render(); }
  }

  async function connectDrive() {
    if (DEMO) { toast('Google Drive isn’t available in the preview.'); return; }
    closeMenu();
    try {
      const isGoogleUser = user.app_metadata && (user.app_metadata.providers || []).includes('google');
      await requestDriveToken(drive ? '' : 'consent', drive ? drive.google_email : (isGoogleUser ? user.email : undefined));
      const info = await gapi('https://www.googleapis.com/oauth2/v3/userinfo');
      if (drive && drive.google_email && info.email && drive.google_email !== info.email) {
        revokeDriveToken();
        toast('That’s a different Google account. Disconnect Drive first to switch accounts.'); updateDriveUI(); return;
      }
      if (!drive) {
        drive = must(await sb.from('drive_sync').upsert({ user_id: user.id, google_email: info.email || '' }).select('*').single());
        drive.ids = drive.ids || {}; drive.days = drive.days || {}; drive.pending_deletes = drive.pending_deletes || [];
        toast('Google Drive connected');
      }
      await syncDrive();
    } catch (err) { toast(err.message); updateDriveUI(); }
  }

  async function disconnectDrive() {
    closeMenu();
    if (!confirm('Disconnect Google Drive?\n\nEverything already copied stays in your Drive. New entries won’t be copied. If you connect again later, Chisel makes a fresh copy of your whole journal.')) return;
    try {
      revokeDriveToken();
      must(await sb.from('drive_sync').delete().eq('user_id', user.id));
      must(await sb.from('entries').update({ drive: null }).eq('user_id', user.id).not('drive', 'is', null));
      must(await sb.from('clips').update({ drive_file_id: null, drive_link: null }).eq('user_id', user.id).not('drive_file_id', 'is', null));
      drive = null;
      entries.forEach(e => { e.drive = null; e.clips.forEach(c => { c.driveFileId = null; c.driveLink = null; }); });
      toast('Google Drive disconnected');
    } catch (err) { toast('Couldn’t disconnect: ' + friendly(err)); }
    updateDriveUI(); render();
  }

  function updateDriveUI() {
    const n = pendingCount(), available = !!CFG.googleClientId && !DEMO;
    $('driveConnect').hidden = !available || !!drive;
    $('driveSyncNow').hidden = !drive || n === 0;
    $('driveSyncNow').textContent = syncing ? 'Syncing…' : 'Sync now · ' + n + ' waiting';
    $('driveSyncNow').disabled = syncing;
    $('driveDisconnect').hidden = !drive;
    $('driveFolder').hidden = !(drive && drive.ids && drive.ids.root);
    if (drive && drive.ids && drive.ids.root) $('driveFolder').href = 'https://drive.google.com/drive/folders/' + drive.ids.root;
    $('driveNote').textContent = DEMO ? 'Not available in the preview' : !available ? 'Not set up on this site' :
      !drive ? 'Keep a copy you own' : (drive.google_email || 'Connected') + (n ? ' · ' + n + ' waiting' : ' · up to date');
    // Banner: invite to connect (once), or nudge when entries are waiting and Google needs a click.
    const banner = $('driveBanner');
    if (available && !drive && local.get('chisel.driveBannerDismissed') !== '1') {
      $('driveBannerText').textContent = 'Keep a copy of your journal in your own Google Drive.';
      $('driveBannerBtn').textContent = 'Connect'; banner.hidden = false; banner.dataset.kind = 'connect';
    } else if (drive && n && !driveTokenValid() && !syncing) {
      $('driveBannerText').textContent = n + (n === 1 ? ' change is' : ' changes are') + ' waiting to be copied to Google Drive.';
      $('driveBannerBtn').textContent = 'Sync now'; banner.hidden = false; banner.dataset.kind = 'sync';
    } else banner.hidden = true;
  }

  $('driveConnect').onclick = connectDrive;
  $('driveSyncNow').onclick = connectDrive;   // re-auths if needed, then syncs
  $('driveDisconnect').onclick = disconnectDrive;
  $('driveBannerBtn').onclick = connectDrive;
  $('driveBannerClose').onclick = () => {
    if ($('driveBanner').dataset.kind === 'connect') local.set('chisel.driveBannerDismissed', '1');
    $('driveBanner').hidden = true;
  };

  // ============ ACCOUNT ============
  async function signedIn(u) {
    user = u;
    show('app'); sync('busy', 'Loading…');
    const meta = u.user_metadata || {};
    const name = meta.full_name || meta.name || '';
    $('menuWho').textContent = u.email || '';
    const pic = meta.avatar_url || meta.picture;
    if (pic) { $('avatar').src = pic; $('avatar').hidden = false; $('initial').textContent = ''; }
    else { $('avatar').hidden = true; $('initial').textContent = (name || u.email || '?').slice(0, 1).toUpperCase(); }
    enterApp(name.split(' ')[0]);
    try {
      const [loaded, ds] = await Promise.all([cloud.load(), sb.from('drive_sync').select('*').maybeSingle()]);
      entries = loaded; sortEntries();
      drive = must(ds);
      if (drive) { drive.ids = drive.ids || {}; drive.days = drive.days || {}; drive.pending_deletes = drive.pending_deletes || []; }
      restoreDriveToken();
      render(); sync('ok', 'Saved'); updateDriveUI();
      if (driveReady() && pendingCount()) syncDrive();
    } catch (err) {
      sync('err', 'Offline'); toast('Couldn’t load your journal: ' + friendly(err));
    }
  }

  function enterApp(firstName) {
    const now = new Date(), h = now.getHours();
    $('todayLabel').textContent = now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
    const part = h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    $('greeting').textContent = part + (firstName ? ', ' + firstName : '') + '.';
    show('app'); render(); updateDriveUI();
    if (!window.MediaRecorder || !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) { recBtn.hidden = true; $('transcribeWrap').hidden = true; }
    else if (!SR) { $('transcribeWrap').hidden = true; }
  }

  // ---- delete account ----
  const dlg = $('deleteDialog');
  $('deleteAccount').onclick = () => {
    closeMenu();
    if (DEMO) { toast('Nothing to delete in the preview.'); return; }
    $('deleteConfirm').value = ''; $('deleteGo').disabled = true; dlg.showModal(); $('deleteConfirm').focus();
  };
  $('deleteConfirm').oninput = () => { $('deleteGo').disabled = $('deleteConfirm').value.trim().toLowerCase() !== 'delete'; };
  dlg.addEventListener('close', async () => {
    if (dlg.returnValue !== 'delete') return;
    sync('busy', 'Deleting account…');
    try {
      const paths = entries.flatMap(e => e.clips.map(c => c.path)).filter(Boolean);
      for (let i = 0; i < paths.length; i += 100) must(await sb.storage.from(BUCKET).remove(paths.slice(i, i + 100)));
      must(await sb.rpc('delete_account'));
      revokeDriveToken();
      await sb.auth.signOut({ scope: 'local' }).catch(() => { });
      local.del('chisel.driveBannerDismissed');
      location.replace(SITE_URL);
    } catch (err) { sync('err', 'Problem'); toast('Couldn’t delete your account: ' + friendly(err)); }
  });

  // ---- account menu ----
  const closeMenu = () => { $('menu').hidden = true; $('avatarBtn').setAttribute('aria-expanded', 'false'); };
  $('avatarBtn').onclick = ev => { ev.stopPropagation(); const m = $('menu'); m.hidden = !m.hidden; $('avatarBtn').setAttribute('aria-expanded', String(!m.hidden)); if (!m.hidden) updateDriveUI(); };
  document.addEventListener('click', ev => { if (!ev.target.closest('#menu')) closeMenu(); });
  document.addEventListener('keydown', ev => { if (ev.key === 'Escape') closeMenu(); });

  // ============ PREVIEW ============
  async function startDemo() {
    const d = n => { const x = new Date(); x.setDate(x.getDate() - n); return isoDate(x); };
    const now = new Date().toISOString();
    entries = [
      { id: 'a', title: 'Coffee with Maren', text: 'We talked about her move to Bergen and how quiet the first winter was. She said the trick is to walk every morning, even when the light barely shows up.', with: 'Maren', tags: ['friends'], date: d(0), time: '08:42', createdAt: now,
        clips: [{ id: 'x', duration: 94, transcript: 'She said the first winter you just learn to love candles and long walks, and then one day it clicks.' }] },
      { id: 'b', title: 'Standup ran long', text: 'Two decisions, one of which I disagree with. Write it down, sleep on it.', with: '', tags: ['work'], date: d(1), time: '10:15', createdAt: now, clips: [] },
      { id: 'c', title: 'Evening walk', text: '', with: '', tags: [], date: d(1), time: '19:03', createdAt: now,
        clips: [{ id: 'y', duration: 212, transcript: 'Walked the long way round the lake. Thinking about what I actually want from the next year.' }] },
      { id: 'd', title: 'Phone call with Dad', text: 'He’s fixing the boat again. Asked about summer.', with: 'Dad', tags: ['family'], date: d(4), time: '17:30', createdAt: now, clips: [] },
    ];
    sortEntries();
    $('initial').textContent = 'P';
    $('menuWho').textContent = 'Preview — nothing is saved';
    enterApp('');
    const b = document.createElement('p'); b.className = 'banner';
    b.innerHTML = '<span>Preview mode — entries stay in this tab and disappear on reload. <a href="' + SITE_URL + '">Create an account</a> to keep them.</span>';
    $('app').prepend(b);
    sync('ok', 'Preview');
  }

  // ============ LIST ============
  const fTitle = $('fTitle'), fText = $('fText'), fWith = $('fWith'), fDate = $('fDate'), fTags = $('fTags'),
    recBtn = $('recBtn'), saveBtn = $('saveBtn'), list = $('list'), search = $('search');
  fDate.value = isoDate(new Date());
  const draft = { clips: [], entryId: null };
  const open = new Set();
  let busy = false;

  function render() {
    const wk = new Date(); wk.setDate(wk.getDate() - 6); const wkS = isoDate(wk);
    const spoken = entries.reduce((n, e) => n + e.clips.reduce((m, c) => m + (c.duration || 0), 0), 0);
    $('sCount').textContent = entries.length;
    $('sWeek').textContent = entries.filter(e => e.date >= wkS).length;
    $('sVoice').textContent = spoken < 60 && spoken > 0 ? '<1 min' : Math.round(spoken / 60) + ' min';

    const qs = search.value.trim().toLowerCase();
    const rows = entries.filter(e => !qs || [e.title, e.text, e.with, e.tags.join(' '), e.clips.map(c => c.transcript).join(' ')].join(' ').toLowerCase().includes(qs));
    if (!rows.length) {
      list.innerHTML = '<p class="empty">' + (qs ? 'Nothing matches “' + esc(qs) + '”.' : 'Nothing here yet. Write a few lines or record a thought — your first entry starts the journal.') + '</p>';
      return;
    }
    let html = '', day = '';
    for (const e of rows) {
      if (e.date !== day) {
        if (day) html += '</section>';
        day = e.date;
        const d = asDate(day), dayRef = drive && drive.days[day];
        html += '<section class="day"><header class="day-h"><span class="day-n">' + d.getDate() + '</span><span class="day-w"><b>' +
          esc(d.toLocaleDateString(undefined, { weekday: 'long' })) + '</b><span>' + esc(d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })) + '</span></span>' +
          (dayRef ? '<a href="' + esc(docUrl(dayRef.docId, dayRef.tabId)) + '" target="_blank" rel="noopener">Open in Docs ↗</a>' : '') + '</header>';
      }
      const isOpen = open.has(e.id);
      const preview = e.text || (e.clips[0] && e.clips[0].transcript) || '';
      const tags = [];
      e.clips.forEach(c => tags.push('<span class="tag voice">' + ICON.mic + fmtDur(c.duration) + '</span>'));
      if (e.with) tags.push('<span class="tag">with ' + esc(e.with) + '</span>');
      e.tags.forEach(t => tags.push('<span class="tag">#' + esc(t) + '</span>'));
      html += '<article class="entry' + (isOpen ? ' open' : '') + '" data-id="' + esc(e.id) + '">' +
        '<button class="row" type="button" aria-expanded="' + isOpen + '"><time>' + esc(e.time) + '</time><span class="row-main">' +
        '<h3>' + esc(e.title || 'Untitled') + '</h3>' + (preview ? '<p class="prev">' + esc(preview) + '</p>' : '') +
        (tags.length ? '<span class="tags">' + tags.join('') + '</span>' : '') + '</span></button>';
      if (isOpen) {
        html += '<div class="body">' + (e.text ? '<p class="text">' + esc(e.text) + '</p>' : '') +
          e.clips.map((c, i) => '<div class="clip"><button class="play" type="button" data-play="' + esc(c.id) + '" aria-label="Play voice note">' + ICON.play + '</button>' +
            '<span class="clip-name">Voice note' + (e.clips.length > 1 ? ' ' + (i + 1) : '') + '<span class="clip-dur">' + fmtDur(c.duration) + '</span></span>' +
            (c.transcript ? '<p>' + esc(c.transcript) + '</p>' : '') + '</div>').join('') +
          '<div class="acts">' + (e.drive ? '<a href="' + esc(docUrl(e.drive.docId, e.drive.tabId)) + '" target="_blank" rel="noopener">Open in Google Docs ↗</a>' : '') +
          '<button type="button" data-act="del">Delete</button></div></div>';
      }
      html += '</article>';
    }
    list.innerHTML = html + '</section>';
    syncPlayButtons();
  }

  list.addEventListener('click', async ev => {
    if (ev.target.closest('a')) return;
    const art = ev.target.closest('.entry'); if (!art) return;
    const e = entries.find(x => x.id === art.dataset.id); if (!e) return;
    const playBtn = ev.target.closest('[data-play]');
    if (playBtn) { const c = e.clips.find(x => x.id === playBtn.dataset.play); if (c) togglePlay(c.id, async () => URL.createObjectURL(await backend.audioBlob(c))); return; }
    const del = ev.target.closest('[data-act="del"]');
    if (del) {
      if (!del.classList.contains('danger')) { del.classList.add('danger'); del.textContent = 'Delete for good?'; setTimeout(() => { del.classList.remove('danger'); del.textContent = 'Delete'; }, 3500); return; }
      if (busy) return; busy = true; sync('busy', 'Deleting…');
      try {
        await backend.remove(e);
        open.delete(e.id);
        if (drive && e.drive) {
          drive.pending_deletes.push({ docId: e.drive.docId, tabId: e.drive.tabId, dayTabId: e.drive.dayTabId, date: e.date, fileIds: e.clips.map(c => c.driveFileId).filter(Boolean) });
          await saveDriveState();
        }
        render(); sync('ok', DEMO ? 'Preview' : 'Saved'); toast('Entry deleted'); updateDriveUI();
        if (driveReady()) syncDrive();
      } catch (err) { sync('err', 'Problem'); toast('Couldn’t delete: ' + friendly(err)); }
      finally { busy = false; }
      return;
    }
    if (ev.target.closest('.row')) { open.has(e.id) ? open.delete(e.id) : open.add(e.id); render(); }
  });
  search.addEventListener('input', render);

  // ---- audio playback (one player shared by drafts and saved entries) ----
  const player = new Audio();
  const urlCache = {};
  let playing = null;
  function syncPlayButtons() {
    document.querySelectorAll('[data-play]').forEach(b => {
      const on = playing === b.dataset.play && !player.paused;
      b.classList.toggle('on', on); b.innerHTML = on ? ICON.pause : ICON.play;
      b.setAttribute('aria-label', on ? 'Pause voice note' : 'Play voice note');
    });
  }
  async function togglePlay(key, getUrl) {
    if (playing === key && !player.paused) { player.pause(); return; }
    try {
      if (playing !== key) {
        urlCache[key] = urlCache[key] || await getUrl();
        player.src = urlCache[key]; playing = key;
      }
      await player.play();
    } catch (err) { toast(err.message || 'Couldn’t play that voice note.'); playing = null; }
    syncPlayButtons();
  }
  ['play', 'pause', 'ended'].forEach(ev => player.addEventListener(ev, syncPlayButtons));

  // ---- composer ----
  const hasDraft = () => !!(fText.value.trim() || fTitle.value.trim() || draft.clips.length);
  const dirty = () => { saveBtn.disabled = busy || !!rec || !hasDraft(); };
  [fTitle, fText].forEach(el => el.addEventListener('input', dirty));
  document.addEventListener('keydown', ev => { if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter' && !saveBtn.disabled) saveBtn.click(); });
  $('detailsBtn').onclick = () => { const d = $('details'); d.hidden = !d.hidden; $('detailsBtn').setAttribute('aria-expanded', String(!d.hidden)); };
  window.addEventListener('beforeunload', ev => { if ((hasDraft() && !DEMO && user) || busy) { ev.preventDefault(); ev.returnValue = ''; } });

  function renderClips() {
    $('clips').innerHTML = draft.clips.map((c, i) =>
      '<li class="clip" data-clip="' + c.id + '"><button class="play" type="button" data-play="' + c.id + '" aria-label="Play voice note">' + ICON.play + '</button>' +
      '<span class="clip-name">Voice note' + (draft.clips.length > 1 ? ' ' + (i + 1) : '') + '<span class="clip-dur">' + fmtDur(c.duration) + '</span></span>' +
      '<button class="x" type="button" data-remove="' + c.id + '" aria-label="Remove voice note">' + ICON.x + '</button>' +
      '<textarea rows="1" placeholder="' + (c.transcribed ? 'No words caught — add a note about this recording' : 'Add a note about this recording') + '" aria-label="Transcript">' + esc(c.transcript) + '</textarea></li>').join('');
    $('clips').querySelectorAll('textarea').forEach(autosize);
    syncPlayButtons();
  }
  function autosize(t) { t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; }
  $('clips').addEventListener('click', ev => {
    const p = ev.target.closest('[data-play]');
    if (p) { const c = draft.clips.find(x => x.id === p.dataset.play); if (c) togglePlay(c.id, async () => c.url); return; }
    const r = ev.target.closest('[data-remove]');
    if (r) {
      const c = draft.clips.find(x => x.id === r.dataset.remove);
      if (playing === r.dataset.remove) { player.pause(); playing = null; }
      draft.clips = draft.clips.filter(x => x !== c); if (c) URL.revokeObjectURL(c.url);
      renderClips(); dirty();
    }
  });
  $('clips').addEventListener('input', ev => {
    const li = ev.target.closest('[data-clip]'); if (!li) return;
    const c = draft.clips.find(x => x.id === li.dataset.clip); if (c) c.transcript = ev.target.value;
    autosize(ev.target);
  });

  saveBtn.addEventListener('click', async () => {
    if (busy || rec || !hasDraft()) return;
    const text = fText.value.trim();
    const spoken = draft.clips.map(c => c.transcript.trim()).filter(Boolean).join(' ');
    let title = fTitle.value.trim();
    if (!title) {
      const src = text || spoken;
      title = src ? truncate(src.split(/[.!?](?:\s|$)|\n/)[0].trim(), 60) : (draft.clips.length ? 'Voice note' : 'Untitled');
    }
    const now = new Date();
    draft.entryId = draft.entryId || uuid();          // stable across retries so uploads are overwritten, not duplicated
    const e = {
      id: draft.entryId, title, text, with: fWith.value.trim(),
      tags: fTags.value.split(',').map(s => s.trim().replace(/^#/, '')).filter(Boolean),
      date: fDate.value || isoDate(now), time: hhmm(now), createdAt: now.toISOString(), clips: [], drive: null,
    };
    busy = true; dirty(); saveBtn.textContent = 'Saving…';
    try {
      await backend.save(e, draft.clips);
      draft.clips.forEach((c, i) => { if (e.clips[i]) urlCache[e.clips[i].id] = c.url; });   // play saved clips without re-downloading
      draft.clips = []; draft.entryId = null; renderClips();
      fTitle.value = fText.value = fWith.value = fTags.value = ''; fDate.value = isoDate(new Date());
      render(); sync('ok', DEMO ? 'Preview' : 'Saved');
      toast(DEMO ? 'Saved (preview only)' : 'Saved');
      updateDriveUI();
      if (driveReady()) syncDrive();
    } catch (err) {
      sync('err', 'Not saved'); toast('Couldn’t save: ' + friendly(err));
    } finally { busy = false; saveBtn.textContent = 'Save entry'; dirty(); }
  });

  // ============ VOICE: MediaRecorder for the audio, Web Speech for the words ============
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const transcribeBox = $('transcribe');
  transcribeBox.checked = local.get('chisel.transcribe') !== '0';
  transcribeBox.onchange = () => local.set('chisel.transcribe', transcribeBox.checked ? '1' : '0');
  const meter = $('meter');
  meter.innerHTML = '<span></span>'.repeat(36);
  const bars = [...meter.children];
  let rec = null;

  function pickMime() {
    const opts = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
    return opts.find(t => window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';
  }

  async function startRecording() {
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch (err) { toast(err.name === 'NotAllowedError' ? 'Microphone blocked — allow it in the address bar.' : 'No microphone available.'); return; }
    if (playing) player.pause();
    const mime = pickMime();
    const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const r = rec = { stream, mr, chunks: [], started: Date.now(), committed: '', fin: '', interim: '', sr: null, transcribed: false };
    mr.ondataavailable = ev => { if (ev.data && ev.data.size) r.chunks.push(ev.data); };
    r.stopped = new Promise(res => { mr.onstop = res; });
    mr.start(1000);

    // level meter
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      r.ctx = new Ctx(); const src = r.ctx.createMediaStreamSource(stream); const an = r.ctx.createAnalyser();
      an.fftSize = 512; src.connect(an); const buf = new Uint8Array(an.fftSize); const hist = new Array(bars.length).fill(0); let last = 0;
      const tick = t => {
        if (rec !== r) return;
        if (t - last > 70) {
          last = t; an.getByteTimeDomainData(buf);
          let sum = 0; for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
          hist.push(Math.min(1, Math.sqrt(sum / buf.length) * 4)); hist.shift();
          bars.forEach((b, i) => { b.style.height = Math.max(8, hist[i] * 100) + '%'; });
          $('recTime').textContent = fmtDur((Date.now() - r.started) / 1000);
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    } catch (e) { }

    // live transcription
    $('recTranscript').innerHTML = '';
    if (SR && transcribeBox.checked) {
      const sr = r.sr = new SR(); sr.continuous = true; sr.interimResults = true; sr.lang = navigator.language || 'en-US';
      r.transcribed = true;
      sr.onresult = ev => {
        let fin = '', interim = '';
        for (let i = 0; i < ev.results.length; i++) { const x = ev.results[i]; if (x.isFinal) fin += x[0].transcript + ' '; else interim += x[0].transcript; }
        r.fin = fin; r.interim = interim;
        $('recTranscript').innerHTML = esc(r.committed + r.fin) + '<span class="interim">' + esc(r.interim) + '</span>';
      };
      sr.onerror = ev => { if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') { r.sr = null; toast('Transcription unavailable — the audio is still recording.'); } };
      r.srEnded = new Promise(res => {
        sr.onend = () => {
          r.committed += r.fin; r.fin = '';
          if (rec === r && !r.stopping && r.sr) { try { sr.start(); return; } catch (e) { } }
          res();
        };
      });
      try { sr.start(); } catch (e) { }
    }

    recBtn.classList.add('on'); recBtn.setAttribute('aria-pressed', 'true'); $('recLabel').textContent = 'Stop';
    $('recorder').hidden = false; $('recTime').textContent = '0:00'; dirty();
  }

  async function stopRecording() {
    const r = rec; if (!r || r.stopping) return;
    r.stopping = true;
    try { r.mr.stop(); } catch (e) { }
    if (r.sr) { try { r.sr.stop(); } catch (e) { } }
    await Promise.all([r.stopped, r.srEnded ? Promise.race([r.srEnded, new Promise(res => setTimeout(res, 1500))]) : null]);
    r.stream.getTracks().forEach(t => t.stop());
    if (r.ctx) r.ctx.close().catch(() => { });
    const duration = (Date.now() - r.started) / 1000;
    const mime = r.mr.mimeType || pickMime() || 'audio/webm';
    const blob = new Blob(r.chunks, { type: mime.split(';')[0] });
    rec = null;
    recBtn.classList.remove('on'); recBtn.setAttribute('aria-pressed', 'false'); $('recLabel').textContent = 'Record';
    $('recorder').hidden = true;
    if (blob.size && duration > 0.4) {
      const transcript = (r.committed + r.fin + r.interim).replace(/\s+/g, ' ').trim();
      draft.clips.push({ id: uuid(), blob, url: URL.createObjectURL(blob), mime, duration, transcript, transcribed: r.transcribed });
      renderClips();
    }
    dirty();
  }
  recBtn.addEventListener('click', () => rec ? stopRecording() : startRecording());

  boot();
})();
