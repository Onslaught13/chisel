/* Chisel — a voice + text journal stored in the user's own Google Drive.
 *
 * Drive layout (all created by the app, so the narrow drive.file scope is enough):
 *   Chisel/
 *     chisel-index.json          list view index (the Docs are the readable record)
 *     2026/
 *       September 2026           Google Doc: one tab per day, one child tab per entry
 *       Voice notes/             audio files, linked from the entry tabs
 */
(() => {
  'use strict';

  // ============ CONFIG ============
  const CFG = window.CHISEL_CONFIG || {};
  const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const SCOPES = 'openid email profile ' + DRIVE_SCOPE;
  const ROOT_NAME = 'Chisel';
  const INDEX_NAME = 'chisel-index.json';
  const AUDIO_FOLDER = 'Voice notes';
  const DRIVE = 'https://www.googleapis.com/drive/v3';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
  const DOCS = 'https://docs.googleapis.com/v1';
  const FOLDER = 'application/vnd.google-apps.folder';
  const GDOC = 'application/vnd.google-apps.document';
  const DEMO = new URLSearchParams(location.search).has('demo');

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
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
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
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
  }
  function sync(state, text) { $('sync').className = 'sync ' + state; $('syncText').textContent = text; }

  const ICON = {
    play: '<svg viewBox="0 0 12 12"><path d="M3 1.5v9l7.5-4.5z"/></svg>',
    pause: '<svg viewBox="0 0 12 12"><path d="M2.5 1.5h2.5v9H2.5zM7 1.5h2.5v9H7z"/></svg>',
    x: '<svg viewBox="0 0 12 12"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7"/></svg>',
    mic: '<svg viewBox="0 0 12 12"><rect x="4" y="1" width="4" height="6.5" rx="2"/><path d="M2.5 6a3.5 3.5 0 0 0 7 0M6 9.5V11"/></svg>',
  };

  // ============ AUTH (Google Identity Services, token model) ============
  let clientId = CFG.clientId || local.get('chisel.clientId') || '';
  let tokenClient = null, token = null, tokenExp = 0, me = null;

  function show(view) {
    $('welcome').hidden = view !== 'welcome';
    $('app').hidden = view !== 'app';
    $('account').hidden = view !== 'app';
    $('foot').hidden = view !== 'app';
  }

  $('saveCid').onclick = () => {
    const v = $('cid').value.trim();
    if (!/\.apps\.googleusercontent\.com$/.test(v)) { toast('That doesn’t look like a Google client ID.'); return; }
    local.set('chisel.clientId', v); clientId = v; boot();
  };

  const waitForGis = () => new Promise(res => {
    (function poll() { (window.google && google.accounts && google.accounts.oauth2) ? res() : setTimeout(poll, 80); })();
  });

  async function boot() {
    if (DEMO) { await startDemo(); return; }
    show('welcome');
    if (!clientId) { $('setup').hidden = false; $('signinBlock').hidden = true; return; }
    $('setup').hidden = true; $('signinBlock').hidden = false;
    await waitForGis();
    tokenClient = google.accounts.oauth2.initTokenClient({ client_id: clientId, scope: SCOPES, callback: () => { } });
    const saved = session.get('chisel.token');
    if (saved) { try { const t = JSON.parse(saved); if (t.exp > Date.now() + 60000) { token = t.token; tokenExp = t.exp; } } catch (e) { } }
    if (token) { try { await afterSignin(); return; } catch (e) { token = null; session.del('chisel.token'); } }
  }

  function requestToken(prompt) {
    return new Promise((resolve, reject) => {
      tokenClient.callback = resp => {
        if (resp.error) { reject(new Error(resp.error_description || resp.error)); return; }
        if (!google.accounts.oauth2.hasGrantedAllScopes(resp, DRIVE_SCOPE)) {
          reject(new Error('Chisel needs permission to create files in your Drive — that’s where your journal lives.')); return;
        }
        token = resp.access_token; tokenExp = Date.now() + (resp.expires_in - 60) * 1000;
        session.set('chisel.token', JSON.stringify({ token, exp: tokenExp }));
        resolve(token);
      };
      tokenClient.error_callback = e => reject(new Error(e.type === 'popup_closed' ? 'The sign-in window was closed.' : (e.message || e.type || 'Sign-in failed.')));
      const opts = { prompt };
      const hint = local.get('chisel.lastEmail'); if (hint) opts.login_hint = hint;
      tokenClient.requestAccessToken(opts);
    });
  }

  $('signinBtn').onclick = async () => {
    $('signinErr').hidden = true;
    try { await requestToken(local.get('chisel.lastEmail') ? '' : 'consent'); await afterSignin(); }
    catch (e) { $('signinErr').textContent = e.message; $('signinErr').hidden = false; }
  };
  $('signout').onclick = () => {
    if (DEMO) { location.href = location.pathname; return; }
    if (token && window.google) google.accounts.oauth2.revoke(token, () => { });
    token = null; session.del('chisel.token'); local.del('chisel.lastEmail'); location.reload();
  };

  async function ensureToken() {
    if (token && tokenExp > Date.now()) return token;
    return requestToken(''); // silent when Google allows it; otherwise a brief popup
  }

  // ============ HTTP ============
  async function api(url, opts = {}, retry = true) {
    const t = await ensureToken();
    const headers = Object.assign({ Authorization: 'Bearer ' + t }, opts.headers || {});
    let body = opts.body;
    if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.json); }
    const r = await fetch(url, { method: opts.method || 'GET', headers, body });
    if (r.status === 401 && retry) { token = null; tokenExp = 0; return api(url, opts, false); }
    if (!r.ok) {
      let msg = r.status + ' ' + r.statusText;
      try { const j = await r.json(); msg = (j.error && j.error.message) || msg; } catch (e) { }
      const err = new Error(msg); err.status = r.status; throw err;
    }
    if (opts.raw) return r;
    if (r.status === 204) return null;
    const ct = r.headers.get('content-type') || '';
    return ct.includes('application/json') ? r.json() : r.text();
  }

  // ============ DRIVE ============
  let ids = {};                                   // path key -> Drive file id (cached per account)
  let idsKey = 'chisel.ids';
  const saveIds = () => local.set(idsKey, JSON.stringify(ids));
  const dq = s => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  async function findOrCreate(key, name, mime, parentId) {
    if (ids[key]) {
      try { const f = await api(DRIVE + '/files/' + ids[key] + '?fields=id,trashed'); if (!f.trashed) return ids[key]; } catch (e) { }
      delete ids[key];
    }
    const query = "name='" + dq(name) + "' and mimeType='" + mime + "' and trashed=false" + (parentId ? " and '" + parentId + "' in parents" : '');
    const res = await api(DRIVE + '/files?q=' + encodeURIComponent(query) + '&fields=files(id)&orderBy=createdTime&pageSize=1');
    let id = res.files && res.files[0] && res.files[0].id;
    if (!id) {
      const body = { name, mimeType: mime }; if (parentId) body.parents = [parentId];
      id = (await api(DRIVE + '/files?fields=id', { method: 'POST', json: body })).id;
    }
    ids[key] = id; saveIds(); return id;
  }
  const rootId = () => findOrCreate('root', ROOT_NAME, FOLDER, null);
  const yearId = async y => findOrCreate('y:' + y, String(y), FOLDER, await rootId());
  const audioFolderId = async y => findOrCreate('a:' + y, AUDIO_FOLDER, FOLDER, await yearId(y));
  const monthDocId = async (y, m) => findOrCreate('m:' + y + '-' + pad(m), monthName(y, m), GDOC, await yearId(y));
  const forgetId = id => { Object.keys(ids).forEach(k => { if (ids[k] === id) delete ids[k]; }); saveIds(); };

  async function uploadFile(name, mime, blob, parentId, fileId) {
    const boundary = 'chisel' + uid();
    const meta = fileId ? {} : { name, mimeType: mime, parents: [parentId] };
    const body = new Blob([
      '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) + '\r\n',
      '--' + boundary + '\r\nContent-Type: ' + mime + '\r\n\r\n', blob, '\r\n--' + boundary + '--',
    ]);
    const url = UPLOAD + '/files' + (fileId ? '/' + fileId : '') + '?uploadType=multipart&fields=id,webViewLink';
    return api(url, { method: fileId ? 'PATCH' : 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body });
  }
  const trashFile = id => api(DRIVE + '/files/' + id + '?fields=id', { method: 'PATCH', json: { trashed: true } });

  // ---- index ----
  let index = { version: 2, entries: [], days: {} };

  function normalizeIndex(ix) {
    ix = ix && typeof ix === 'object' ? ix : {};
    ix.entries = (ix.entries || []).map(e => Object.assign({ tags: [], clips: [] }, e, {
      text: e.text != null ? e.text : (e.story || ''),               // v1 used "story"
      time: e.time || (e.createdAt ? hhmm(new Date(e.createdAt)) : ''),
    }));
    ix.days = ix.days || {};
    ix.version = 2;
    return ix;
  }
  const sortEntries = () => index.entries.sort((a, b) => (b.date + b.time + b.createdAt).localeCompare(a.date + a.time + a.createdAt));

  async function loadIndex() {
    const root = await rootId();
    const res = await api(DRIVE + '/files?q=' + encodeURIComponent("name='" + INDEX_NAME + "' and '" + root + "' in parents and trashed=false") + '&fields=files(id)&orderBy=modifiedTime%20desc');
    if (res.files && res.files[0]) {
      ids.index = res.files[0].id; saveIds();
      const txt = await api(DRIVE + '/files/' + ids.index + '?alt=media');
      try { index = normalizeIndex(typeof txt === 'string' ? JSON.parse(txt) : txt); } catch (e) { index = normalizeIndex({}); }
    } else { delete ids.index; index = normalizeIndex({}); }
    sortEntries();
  }
  async function saveIndex() {
    const blob = new Blob([JSON.stringify(index)], { type: 'application/json' });
    if (ids.index) {
      try { await uploadFile(null, 'application/json', blob, null, ids.index); return; }
      catch (e) { if (e.status !== 404) throw e; delete ids.index; }
    }
    ids.index = (await uploadFile(INDEX_NAME, 'application/json', blob, await rootId())).id; saveIds();
  }

  // ============ GOOGLE DOCS ============
  const getDoc = (id, content = true) => api(DOCS + '/documents/' + id + '?includeTabsContent=' + content);
  const docBatch = (id, requests) => api(DOCS + '/documents/' + id + ':batchUpdate', { method: 'POST', json: { requests } });
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
    const known = index.days[date];
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
      const dateOfTab = id => Object.keys(index.days).find(d => index.days[d].tabId === id && index.days[d].docId === docId);
      const later = top.findIndex(t => { const d = dateOfTab(tabIdOf(t)); return d && d > date; });
      tabId = await addTab(docId, { title, index: later === -1 ? top.length : later });
    }
    index.days[date] = { docId, tabId };
    return tabId;
  }

  async function writeDayLog(docId, dayTabId, date) {
    const doc = await getDoc(docId);
    const tab = findTab(doc, dayTabId); if (!tab) return;
    const end = tabEnd(tab);
    const day = index.entries.filter(e => e.date === date && e.dayTabId === dayTabId).sort((a, b) => (a.time + a.createdAt).localeCompare(b.time + b.createdAt));
    const voiceSec = day.reduce((n, e) => n + e.clips.reduce((m, c) => m + (c.duration || 0), 0), 0);
    const c = composer();
    c.add(fmtLong(date) + '\n', { para: 'TITLE' });
    c.add([day.length + (day.length === 1 ? ' entry' : ' entries'), voiceSec ? fmtDur(voiceSec) + ' spoken' : ''].filter(Boolean).join('  ·  ') + '\n', { text: Object.assign({}, MUTED) });
    c.add('\n');
    for (const e of day) {
      c.add(e.time + '    ', { text: Object.assign({}, MUTED) });
      c.add(e.title, { text: { link: { tabId: e.tabId } } });
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
      c.add('▶  Voice note' + (e.clips.length > 1 ? ' ' + (i + 1) : '') + '  ·  ' + fmtDur(cl.duration) + '\n', { para: 'HEADING_3', text: { link: { url: cl.link } } });
      c.add((cl.transcript || 'No transcript.') + '\n', { text: Object.assign({ italic: true }, cl.transcript ? {} : MUTED) });
    });
    c.add('\n');
    c.add('Saved by Chisel · ' + new Date(e.createdAt).toLocaleString() + '\n', { text: Object.assign({}, MUTED, SMALL) });
    await docBatch(docId, c.requests(tabId));
    return tabId;
  }

  // ============ BACKENDS ============
  const extFor = mime => /mp4|m4a|aac/.test(mime) ? 'm4a' : /ogg/.test(mime) ? 'ogg' : /wav/.test(mime) ? 'wav' : 'webm';
  const fileSafe = s => s.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();

  const drive = {
    async save(e, draftClips) {
      const [y, m] = e.date.split('-').map(Number);
      // 1. Voice notes → Drive (skip ones already uploaded by an earlier failed attempt)
      for (let i = 0; i < draftClips.length; i++) {
        const d = draftClips[i];
        if (!d.remote) {
          sync('busy', 'Uploading voice note' + (draftClips.length > 1 ? ' ' + (i + 1) + '/' + draftClips.length : '') + '…');
          const name = fileSafe(e.date + ' ' + e.time.replace(':', '') + ' — ' + e.title + (draftClips.length > 1 ? ' (' + (i + 1) + ')' : '')) + '.' + extFor(d.mime);
          const f = await uploadFile(name, d.mime.split(';')[0], d.blob, await audioFolderId(y));
          d.remote = { fileId: f.id, link: f.webViewLink || ('https://drive.google.com/file/d/' + f.id + '/view') };
        }
      }
      e.clips = draftClips.map(d => ({ fileId: d.remote.fileId, link: d.remote.link, mime: d.mime, duration: d.duration, transcript: d.transcript.trim() }));
      // 2. The month's Doc: day tab → entry tab
      sync('busy', 'Writing to Google Docs…');
      const docId = await monthDocId(y, m);
      const dayTabId = await ensureDayTab(docId, e.date);
      const tabId = await writeEntryTab(docId, dayTabId, e);
      Object.assign(e, { docId, dayTabId, tabId });
      index.entries.push(e); sortEntries();
      try { await saveIndex(); }
      catch (err) { index.entries = index.entries.filter(x => x !== e); throw err; }
      // 3. Refresh the day's log (a summary with links to each entry tab). Not fatal: the entry is saved.
      try { await writeDayLog(docId, dayTabId, e.date); } catch (err) { console.warn('Day log not updated', err); }
    },

    async remove(e) {
      for (const c of e.clips) { try { await trashFile(c.fileId); } catch (err) { } }
      index.entries = index.entries.filter(x => x.id !== e.id);
      if (e.docId && e.dayTabId) {
        try { await docBatch(e.docId, [{ deleteTab: { tabId: e.tabId } }]); } catch (err) { if (err.status !== 400 && err.status !== 404) throw err; }
        const rest = index.entries.filter(x => x.dayTabId === e.dayTabId && x.docId === e.docId);
        if (rest.length) await writeDayLog(e.docId, e.dayTabId, e.date);
        else {
          const doc = await getDoc(e.docId, false);
          if ((doc.tabs || []).length > 1) await docBatch(e.docId, [{ deleteTab: { tabId: e.dayTabId } }]);
          else { await trashFile(e.docId); forgetId(e.docId); }
          if (index.days[e.date] && index.days[e.date].tabId === e.dayTabId) delete index.days[e.date];
        }
      } else if (e.docId && e.tabId) {                     // v1 entries: a flat tab per entry
        const doc = await getDoc(e.docId, false);
        if ((doc.tabs || []).length > 1) await docBatch(e.docId, [{ deleteTab: { tabId: e.tabId } }]);
        else { await trashFile(e.docId); forgetId(e.docId); }
      }
      await saveIndex();
    },

    async audioUrl(c) {
      const r = await api(DRIVE + '/files/' + c.fileId + '?alt=media', { raw: true });
      return URL.createObjectURL(await r.blob());
    },
  };

  // Preview mode: same UI, nothing leaves the browser.
  const demo = {
    blobs: {},
    async save(e, draftClips) {
      await new Promise(r => setTimeout(r, 450));
      e.clips = draftClips.map(d => { const id = uid(); demo.blobs[id] = d.blob; return { fileId: id, link: '#', mime: d.mime, duration: d.duration, transcript: d.transcript.trim() }; });
      index.entries.push(e); sortEntries();
    },
    async remove(e) { index.entries = index.entries.filter(x => x.id !== e.id); },
    async audioUrl(c) { if (!demo.blobs[c.fileId]) throw new Error('Sample entries have no audio.'); return URL.createObjectURL(demo.blobs[c.fileId]); },
  };
  let backend = drive;

  async function startDemo() {
    backend = demo;
    me = { email: 'Preview — nothing is saved' };
    const d = n => { const x = new Date(); x.setDate(x.getDate() - n); return isoDate(x); };
    index = normalizeIndex({ entries: [
      { id: 'a', title: 'Coffee with Maren', text: 'We talked about her move to Bergen and how quiet the first winter was. She said the trick is to walk every morning, even when the light barely shows up.', with: 'Maren', tags: ['friends'], date: d(0), time: '08:42', createdAt: new Date().toISOString(),
        clips: [{ fileId: 'x', duration: 94, transcript: 'She said the first winter you just learn to love candles and long walks, and then one day it clicks.' }] },
      { id: 'b', title: 'Standup ran long', text: 'Two decisions, one of which I disagree with. Write it down, sleep on it.', tags: ['work'], date: d(1), time: '10:15', createdAt: new Date().toISOString(), clips: [] },
      { id: 'c', title: 'Evening walk', text: '', tags: [], date: d(1), time: '19:03', createdAt: new Date().toISOString(),
        clips: [{ fileId: 'y', duration: 212, transcript: 'Walked the long way round the lake. Thinking about what I actually want from the next year.' }] },
      { id: 'd', title: 'Phone call with Dad', text: 'He’s fixing the boat again. Asked about summer.', with: 'Dad', tags: ['family'], date: d(4), time: '17:30', createdAt: new Date().toISOString(), clips: [] },
    ] });
    sortEntries();
    $('avatarBtn').querySelector('#initial').textContent = 'P';
    $('menuWho').textContent = me.email;
    $('folderLink').hidden = true;
    enterApp();
    const b = document.createElement('p'); b.className = 'banner';
    b.innerHTML = 'Preview mode — entries stay in this tab and disappear on reload. <a href="' + location.pathname + '">Sign in</a> to keep them in Drive.';
    $('app').prepend(b);
    sync('ok', 'Preview');
  }

  // ============ APP ============
  const fTitle = $('fTitle'), fText = $('fText'), fWith = $('fWith'), fDate = $('fDate'), fTags = $('fTags'),
    recBtn = $('recBtn'), saveBtn = $('saveBtn'), list = $('list'), search = $('search');
  fDate.value = isoDate(new Date());
  const draft = { clips: [] };
  const open = new Set();
  let busy = false;

  async function afterSignin() {
    sync('busy', 'Connecting…');
    me = await api('https://www.googleapis.com/oauth2/v3/userinfo');
    local.set('chisel.lastEmail', me.email || '');
    idsKey = 'chisel.ids.' + (me.sub || me.email || 'me');
    try { ids = JSON.parse(local.get(idsKey) || '{}'); } catch (e) { ids = {}; }
    $('menuWho').textContent = me.email || '';
    if (me.picture) { $('avatar').src = me.picture; $('avatar').hidden = false; }
    else $('initial').textContent = (me.given_name || me.email || '?').slice(0, 1).toUpperCase();
    await loadIndex();
    $('folderLink').href = 'https://drive.google.com/drive/folders/' + ids.root;
    enterApp();
    sync('ok', 'Synced');
  }

  function enterApp() {
    const now = new Date(), h = now.getHours();
    $('todayLabel').textContent = now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
    const part = h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    $('greeting').textContent = part + (me && me.given_name ? ', ' + me.given_name : '') + '.';
    $('footText').textContent = DEMO ? 'Preview mode' : 'Your journal lives in Google Drive → Chisel';
    show('app'); render();
    if (!window.MediaRecorder || !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) { recBtn.hidden = true; $('transcribeWrap').hidden = true; }
    else if (!SR) { $('transcribeWrap').hidden = true; }
  }

  // ---- account menu ----
  $('avatarBtn').onclick = ev => { ev.stopPropagation(); const m = $('menu'); m.hidden = !m.hidden; $('avatarBtn').setAttribute('aria-expanded', String(!m.hidden)); };
  document.addEventListener('click', ev => { if (!ev.target.closest('#menu')) { $('menu').hidden = true; $('avatarBtn').setAttribute('aria-expanded', 'false'); } });
  document.addEventListener('keydown', ev => { if (ev.key === 'Escape') $('menu').hidden = true; });

  // ---- list ----
  function render() {
    const all = index.entries;
    const wk = new Date(); wk.setDate(wk.getDate() - 6); const wkS = isoDate(wk);
    const spoken = all.reduce((n, e) => n + e.clips.reduce((m, c) => m + (c.duration || 0), 0), 0);
    $('sCount').textContent = all.length;
    $('sWeek').textContent = all.filter(e => e.date >= wkS).length;
    $('sVoice').textContent = spoken < 60 && spoken > 0 ? '<1 min' : Math.round(spoken / 60) + ' min';

    const qs = search.value.trim().toLowerCase();
    const rows = all.filter(e => !qs || [e.title, e.text, e.with, e.tags.join(' '), e.clips.map(c => c.transcript).join(' ')].join(' ').toLowerCase().includes(qs));
    if (!rows.length) {
      list.innerHTML = '<p class="empty">' + (qs ? 'Nothing matches “' + esc(qs) + '”.' : 'Nothing here yet. Your first entry creates a <i>Chisel</i> folder in your Drive, with this month’s journal inside.') + '</p>';
      return;
    }
    let html = '', day = '';
    for (const e of rows) {
      if (e.date !== day) {
        if (day) html += '</section>';
        day = e.date;
        const d = asDate(day), dayRef = index.days[day];
        html += '<section class="day"><header class="day-h"><span class="day-n">' + d.getDate() + '</span><span class="day-w"><b>' +
          esc(d.toLocaleDateString(undefined, { weekday: 'long' })) + '</b><span>' + esc(d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })) + '</span></span>' +
          (dayRef && !DEMO ? '<a href="' + esc(docUrl(dayRef.docId, dayRef.tabId)) + '" target="_blank" rel="noopener">Open day ↗</a>' : '') + '</header>';
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
          e.clips.map((c, i) => '<div class="clip"><button class="play" type="button" data-play="' + esc(c.fileId) + '" aria-label="Play voice note">' + ICON.play + '</button>' +
            '<span class="clip-name">Voice note' + (e.clips.length > 1 ? ' ' + (i + 1) : '') + '<span class="clip-dur">' + fmtDur(c.duration) + '</span></span>' +
            (c.transcript ? '<p>' + esc(c.transcript) + '</p>' : '') + '</div>').join('') +
          '<div class="acts">' + (e.docId && !DEMO ? '<a href="' + esc(docUrl(e.docId, e.tabId)) + '" target="_blank" rel="noopener">Open in Google Docs ↗</a>' : '') +
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
    const e = index.entries.find(x => x.id === art.dataset.id); if (!e) return;
    const playBtn = ev.target.closest('[data-play]');
    if (playBtn) { const c = e.clips.find(x => x.fileId === playBtn.dataset.play); if (c) togglePlay(c.fileId, () => backend.audioUrl(c)); return; }
    const del = ev.target.closest('[data-act="del"]');
    if (del) {
      if (!del.classList.contains('danger')) { del.classList.add('danger'); del.textContent = 'Delete for good?'; setTimeout(() => { del.classList.remove('danger'); del.textContent = 'Delete'; }, 3500); return; }
      if (busy) return; busy = true; sync('busy', 'Deleting…');
      try { await backend.remove(e); open.delete(e.id); render(); sync('ok', DEMO ? 'Preview' : 'Synced'); toast('Entry deleted'); }
      catch (err) { sync('err', 'Sync problem'); toast('Couldn’t delete: ' + err.message); }
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
  window.addEventListener('beforeunload', ev => { if ((hasDraft() && !DEMO) || busy) { ev.preventDefault(); ev.returnValue = ''; } });

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
    const e = {
      id: uid(), title, text, with: fWith.value.trim(),
      tags: fTags.value.split(',').map(s => s.trim().replace(/^#/, '')).filter(Boolean),
      date: fDate.value || isoDate(now), time: hhmm(now), createdAt: now.toISOString(), clips: [],
    };
    busy = true; dirty(); saveBtn.textContent = 'Saving…';
    try {
      await backend.save(e, draft.clips);
      draft.clips.forEach((c, i) => { if (e.clips[i]) urlCache[e.clips[i].fileId] = c.url; });   // play saved clips without re-downloading
      draft.clips = []; renderClips();
      fTitle.value = fText.value = fWith.value = fTags.value = ''; fDate.value = isoDate(new Date());
      render(); sync('ok', DEMO ? 'Preview' : 'Synced');
      toast(DEMO ? 'Saved (preview only)' : 'Saved to ' + monthName(+e.date.slice(0, 4), +e.date.slice(5, 7)));
    } catch (err) {
      sync('err', 'Sync problem'); toast('Couldn’t save: ' + err.message);
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
      draft.clips.push({ id: uid(), blob, url: URL.createObjectURL(blob), mime, duration, transcript, transcribed: r.transcribed });
      renderClips();
    }
    dirty();
  }
  recBtn.addEventListener('click', () => rec ? stopRecording() : startRecording());

  boot();
})();
