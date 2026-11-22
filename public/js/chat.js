// Local team chat: General, project channels and direct messages (live via server-sent events)
// Supports emoji, image / audio / file attachments, paste & drop, and recorded voice messages.
import { state, get, post, esc, rich, icon, avatar, openModal, errToast, guarded, on, bus, loadUsers, fmtClock } from './lib.js';

const EMOJI = [
  ['Smileys', ['😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '🙂', '😉', '😍', '🥰', '😘', '😋', '😎', '🤩', '🥳', '🤔', '🤗', '😐', '😴', '😢', '😭', '😡', '🤯', '😱', '🙄', '😬', '🤝']],
  ['Gestures', ['👍', '👎', '👏', '🙌', '🙏', '💪', '👌', '✌️', '🤞', '👋', '🤙', '👀', '🫡', '🤷', '🙋']],
  ['Work', ['✅', '❌', '⚠️', '🔥', '⭐', '💡', '🎯', '🚀', '🎉', '📌', '📎', '📅', '⏰', '📝', '📊', '🐛', '🔧', '💻', '🔒', '🏆']],
  ['Hearts & fun', ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '💯', '✨', '☕', '🍕', '🌱']],
];
const fmtSize = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
const MAX_FILE = 25 * 1024 * 1024;

export function attach(m) {
  if (!m.file_name) return '';
  const url = `/api/files/${m.id}`, name = esc(m.file_name), type = m.file_type || '';
  if (type.startsWith('image/')) return `<a href="${url}" target="_blank" rel="noopener"><img class="chat-img" src="${url}" alt="${name}" loading="lazy"></a>`;
  if (type.startsWith('audio/')) return `<audio class="chat-audio" controls preload="none" src="${url}"></audio><div class="small muted">${name} · ${fmtSize(m.file_size)}</div>`;
  return `<a class="file-card" href="${url}" download="${name}">${icon('file')}<span class="grow trunc">${name}</span><span class="muted small">${fmtSize(m.file_size)}</span>${icon('download')}</a>`;
}

function uploadFile(channelId, file, caption) {
  return fetch(`/api/channels/${channelId}/upload`, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name), 'X-Caption': encodeURIComponent(caption || '') },
    body: file,
  }).then(async (r) => {
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'Upload failed');
    return d;
  }).catch((e) => { throw e instanceof TypeError ? new Error('Upload failed. Is the server still running?') : e; });
}

export async function refreshChatBadge() {
  try {
    const chans = await get('/api/channels');
    state.chatUnread = chans.reduce((a, c) => a + (c.unread || 0), 0);
    bus.emit('badges');
    return chans;
  } catch { return []; }
}

export async function chatPage(view, { cid }) {
  let channels = [], current = null, msgs = [], more = false, gone = false;
  let pending = null, pendingUrl = null, sending = false;
  let recorder = null, recStream = null, recTimer = null, recChunks = [], recStart = 0, recCancel = false;
  view.innerHTML = '<div class="card chat" id="chat"><div class="chat-list" id="cl"></div><div class="chat-main" id="cm"><div class="spinner"></div></div></div>';
  const wrap = view.querySelector('#chat'), cl = view.querySelector('#cl'), cm = view.querySelector('#cm');

  async function loadChannels() {
    channels = await get('/api/channels');
    state.chatUnread = channels.reduce((a, c) => a + (c.unread || 0), 0);
    bus.emit('badges');
    drawList();
  }
  function drawList() {
    const sec = (title, list, extra = '') => `<h4>${title}${extra}</h4>${list.map((c) => `<div class="ch-item ${current && current.id === c.id ? 'active' : ''}" data-ch="${c.id}">
      ${c.type === 'dm' ? avatar(c.other && c.other.name, c.other && c.other.color, 'xs') : '<span class="muted">#</span>'}<span class="grow trunc">${esc(c.name)}</span>${c.unread ? `<span class="badge">${c.unread}</span>` : ''}</div>`).join('') || '<div class="small muted" style="padding:4px 14px">None</div>'}`;
    const general = channels.filter((c) => c.type === 'general');
    const projects = channels.filter((c) => c.type === 'project').sort((a, b) => a.name.localeCompare(b.name));
    const dms = channels.filter((c) => c.type === 'dm').sort((a, b) => (b.last_id || 0) - (a.last_id || 0));
    cl.innerHTML = sec('Channels', general) + sec('Projects', projects) + sec('Direct messages', dms, '<button class="icon-btn right" data-act="newdm" title="New message" style="padding:2px">' + icon('plus') + '</button>');
  }

  async function open(id) {
    const c = channels.find((x) => x.id === id);
    if (!c) { cm.innerHTML = '<div class="empty"><h3>Channel not found</h3></div>'; return; }
    cancelRecording();
    current = c; wrap.classList.add('has-ch');
    msgs = await get(`/api/channels/${id}/messages`);
    more = msgs.length >= 50;
    c.unread = 0;
    post(`/api/channels/${id}/read`).then(() => refreshChatBadge()).catch(() => {});
    drawList(); drawChannel(true);
    cm.querySelector('#msg')?.focus();
  }

  function drawChannel(scrollBottom) {
    const title = current.type === 'dm' ? esc(current.name) : '# ' + esc(current.name);
    pending = null; pendingUrl = null;
    cm.innerHTML = `<div class="chat-head"><button class="icon-btn" data-act="back" title="Back" style="display:none">${icon('left')}</button>${current.type === 'dm' ? avatar(current.other && current.other.name, current.other && current.other.color, 'xs') : ''}<span>${title}</span>
        ${current.type === 'project' ? `<a class="small right" href="#/p/${current.project_id}/board">Open project</a>` : ''}</div>
      <div class="chat-msgs" id="ml"></div>
      <div id="pend" class="pending hidden"></div><div id="rec" class="pending hidden"></div>
      <form class="chat-compose" id="cf">
        <button type="button" class="icon-btn" data-act="emoji" title="Emoji" aria-label="Emoji">${icon('smile')}</button>
        <button type="button" class="icon-btn" data-act="attach" title="Attach an image, audio or any file (max 25 MB)" aria-label="Attach file">${icon('paperclip')}</button>
        <button type="button" class="icon-btn" data-act="mic" title="Record a voice message" aria-label="Record voice message">${icon('mic')}</button>
        <input type="file" id="fileinp" class="hidden">
        <textarea id="msg" rows="1" maxlength="4000" placeholder="Message ${current.type === 'dm' ? esc(current.name) : '#' + esc(current.name)} — Enter to send. Paste or drop images here."></textarea>
        <button class="btn primary" title="Send">${icon('send')}</button></form>`;
    drawMsgs(scrollBottom);
  }
  function drawMsgs(scrollBottom) {
    const ml = cm.querySelector('#ml');
    if (!ml) return;
    const nearBottom = ml.scrollHeight - ml.scrollTop - ml.clientHeight < 120;
    let prev = null, lastDay = '';
    const html = msgs.map((m) => {
      const day = new Date(m.created_at).toDateString();
      let out = '';
      if (day !== lastDay) { out += `<div class="small muted" style="text-align:center;margin:12px 0 4px">${new Date(m.created_at).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</div>`; lastDay = day; prev = null; }
      const first = !prev || prev.user_id !== m.user_id || new Date(m.created_at) - new Date(prev.created_at) > 5 * 60000;
      prev = m;
      const time = new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return out + `<div class="msg ${first ? 'first' : ''}">${first ? avatar(m.user_name, m.user_color) : '<span class="gutter"></span>'}<div class="grow"><div class="meta">${first ? `<b>${esc(m.user_name || 'Former member')}</b>${time}` : ''}</div>${m.body ? `<div class="rich">${rich(m.body)}</div>` : ''}${attach(m)}</div></div>`;
    }).join('');
    ml.innerHTML = (more ? '<button class="btn sm ghost" data-act="earlier" style="align-self:center">Load earlier messages</button>' : '') + (html || '<div class="empty small">No messages yet — say hello! 👋</div>');
    if (scrollBottom || nearBottom) { ml.scrollTop = ml.scrollHeight; ml.dataset.stick = '1'; } else ml.dataset.stick = '';
    if (!ml.dataset.bound) {
      ml.dataset.bound = '1';
      // images/audio change the height after they load: keep the view pinned to the bottom if the user was there
      ml.addEventListener('load', () => { if (ml.dataset.stick) ml.scrollTop = ml.scrollHeight; }, true);
      ml.addEventListener('scroll', () => { ml.dataset.stick = ml.scrollHeight - ml.scrollTop - ml.clientHeight < 150 ? '1' : ''; });
    }
  }

  // ---------- sending ----------
  async function send() {
    const t = cm.querySelector('#msg');
    if (!t || !current || sending) return;
    const text = t.value.trim();
    if (!text && !pending) return;
    sending = true;
    const sendBtn = cm.querySelector('#cf button.primary');
    if (sendBtn) sendBtn.disabled = true;
    try {
      const m = pending ? await uploadFile(current.id, pending, text) : await post(`/api/channels/${current.id}/messages`, { body: text });
      t.value = ''; t.style.height = '';
      setPending(null);
      if (!msgs.some((x) => x.id === m.id)) msgs.push(m);
      drawMsgs(true);
    } catch (e) { errToast(e); } finally { sending = false; if (sendBtn) sendBtn.disabled = false; }
  }

  // ---------- attachments ----------
  function setPending(file) {
    if (pendingUrl) { URL.revokeObjectURL(pendingUrl); pendingUrl = null; }
    pending = file;
    const box = cm.querySelector('#pend');
    if (!box) return;
    if (!file) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    let thumb = icon('file');
    if (file.type.startsWith('image/')) { pendingUrl = URL.createObjectURL(file); thumb = `<img src="${pendingUrl}" alt="">`; }
    else if (file.type.startsWith('audio/')) { pendingUrl = URL.createObjectURL(file); thumb = `<audio controls src="${pendingUrl}"></audio>`; }
    box.innerHTML = `<span class="pthumb">${thumb}</span><span class="grow trunc">${esc(file.name)} <span class="muted small">${fmtSize(file.size)}</span></span><button type="button" class="icon-btn" data-act="unattach" title="Remove">${icon('x')}</button>`;
    box.classList.remove('hidden');
    cm.querySelector('#msg')?.focus();
  }
  function pickFile(file) {
    if (!file) return;
    if (!file.size) return errToast(new Error('That file is empty'));
    if (file.size > MAX_FILE) return errToast(new Error('Files can be at most 25 MB'));
    setPending(file);
  }
  on(cm, 'click', '[data-act=attach]', () => cm.querySelector('#fileinp').click());
  cm.addEventListener('change', (e) => { if (e.target.id === 'fileinp') { pickFile(e.target.files[0]); e.target.value = ''; } });
  on(cm, 'click', '[data-act=unattach]', () => setPending(null));
  cm.addEventListener('paste', (e) => { const f = [...((e.clipboardData && e.clipboardData.files) || [])][0]; if (f) { e.preventDefault(); pickFile(f); } });
  cm.addEventListener('dragover', (e) => { if ([...((e.dataTransfer && e.dataTransfer.types) || [])].includes('Files')) e.preventDefault(); });
  cm.addEventListener('drop', (e) => { const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) { e.preventDefault(); pickFile(f); } });

  // ---------- emoji picker ----------
  on(cm, 'click', '[data-act=emoji]', (el, e) => {
    e.stopPropagation();
    const old = cm.querySelector('.emoji-pop');
    if (old) { old.remove(); return; }
    const pop = document.createElement('div');
    pop.className = 'emoji-pop';
    pop.innerHTML = EMOJI.map(([name, list]) => `<div class="emoji-h">${name}</div><div class="emoji-grid">${list.map((x) => `<button type="button" data-emo="${x}">${x}</button>`).join('')}</div>`).join('');
    cm.querySelector('#cf').appendChild(pop);
  });
  cm.addEventListener('click', (e) => {
    const b = e.target.closest('[data-emo]');
    if (b) {
      const t = cm.querySelector('#msg'), s = t.selectionStart ?? t.value.length, en = t.selectionEnd ?? s;
      t.value = t.value.slice(0, s) + b.dataset.emo + t.value.slice(en);
      t.focus(); t.selectionStart = t.selectionEnd = s + b.dataset.emo.length;
    } else if (!e.target.closest('.emoji-pop') && !e.target.closest('[data-act=emoji]')) cm.querySelector('.emoji-pop')?.remove();
  });

  // ---------- voice messages ----------
  function stopRecUi() {
    clearInterval(recTimer);
    const box = cm.querySelector('#rec');
    if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
    if (recStream) recStream.getTracks().forEach((t) => t.stop());
    recStream = null; recorder = null;
  }
  function cancelRecording() {
    if (recorder) { recCancel = true; try { if (recorder.state !== 'inactive') recorder.stop(); } catch { /* ignore */ } stopRecUi(); }
  }
  on(cm, 'click', '[data-act=mic]', async () => {
    if (recorder) return;
    if (!navigator.mediaDevices || !window.MediaRecorder || !window.isSecureContext) {
      return errToast(new Error('Voice recording only works when TaskFlow is opened at http://localhost:3000 on this computer (browsers block the microphone on plain network addresses). You can still attach an audio file.'));
    }
    try { recStream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { return errToast(new Error('Microphone access was blocked. Allow it in the address bar and try again.')); }
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
    recChunks = []; recCancel = false;
    const rec = new MediaRecorder(recStream, mime ? { mimeType: mime } : undefined);
    recorder = rec;
    rec.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
    rec.onstop = () => {
      const type = (rec.mimeType || mime || 'audio/webm').split(';')[0];
      const blob = new Blob(recChunks, { type });
      const cancelled = recCancel;
      stopRecUi();
      if (cancelled || !blob.size) return;
      const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
      pickFile(new File([blob], `voice-message.${ext}`, { type }));
    };
    rec.start();
    recStart = Date.now();
    const box = cm.querySelector('#rec');
    box.classList.remove('hidden');
    const draw = () => { box.innerHTML = `<span class="rec-dot"></span><span class="grow">Recording… <b>${fmtClock(Date.now() - recStart)}</b></span><button type="button" class="btn sm" data-act="rec-cancel">Cancel</button><button type="button" class="btn sm primary" data-act="rec-stop">Stop &amp; attach</button>`; };
    draw();
    recTimer = setInterval(() => { if (Date.now() - recStart > 5 * 60000 && rec.state !== 'inactive') rec.stop(); else draw(); }, 500);
  });
  on(cm, 'click', '[data-act=rec-stop]', () => { if (recorder && recorder.state !== 'inactive') recorder.stop(); });
  on(cm, 'click', '[data-act=rec-cancel]', cancelRecording);

  // ---------- other events ----------
  on(cm, 'keydown', '#msg', (el, e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
  on(cm, 'input', '#msg', (el) => { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 140) + 'px'; });
  cm.addEventListener('submit', (e) => { e.preventDefault(); send(); });
  on(cm, 'click', '[data-act=earlier]', (el) => guarded(el, async () => {
    const older = await get(`/api/channels/${current.id}/messages?before=${msgs[0].id}`);
    more = older.length >= 50; msgs = [...older, ...msgs];
    const ml = cm.querySelector('#ml'), h = ml.scrollHeight;
    drawMsgs(false); ml.scrollTop = ml.scrollHeight - h;
  }));
  on(cm, 'click', '[data-act=back]', () => { wrap.classList.remove('has-ch'); current = null; location.hash = '#/chat'; });
  on(cl, 'click', '[data-ch]', (el) => { const id = Number(el.dataset.ch); history.replaceState(null, '', `#/chat/${id}`); open(id).catch(errToast); });
  on(cl, 'click', '[data-act=newdm]', async () => {
    await loadUsers();
    const others = state.users.filter((u) => u.active && u.id !== state.user.id);
    const m = openModal({ title: 'New message', body: others.length ? `<div class="col" style="gap:0">${others.map((u) => `<div class="dd-item" data-u="${u.id}">${avatar(u.name, u.color)} <b>${esc(u.name)}</b><span class="muted small">${esc(u.email)}</span></div>`).join('')}</div>` : '<p class="muted">There are no other team members yet. An administrator can add accounts in Team.</p>' });
    on(m.el, 'click', '[data-u]', async (el) => {
      try { const r = await post('/api/channels/dm', { user_id: Number(el.dataset.u) }); m.close(); await loadChannels(); history.replaceState(null, '', `#/chat/${r.id}`); await open(r.id); } catch (e) { errToast(e); }
    });
  });

  // live messages
  const off = bus.on('message', async ({ channel_id, message }) => {
    if (gone) return;
    if (current && channel_id === current.id) {
      if (!msgs.some((m) => m.id === message.id)) { msgs.push(message); drawMsgs(false); }
      if (message.user_id !== state.user.id) post(`/api/channels/${channel_id}/read`).catch(() => {});
    } else { await loadChannels().catch(() => {}); }
  });
  const off2 = bus.on('project-event', (e) => { if (e.kind === 'project' || e.kind === 'deleted') loadChannels().catch(() => {}); });

  await loadChannels();
  const target = cid ? Number(cid) : (channels.find((c) => c.type === 'general') || channels[0] || {}).id;
  if (target) { wrap.classList.toggle('has-ch', !!cid); await open(target); if (!cid) wrap.classList.remove('has-ch'); }
  return { destroy: () => { gone = true; cancelRecording(); if (pendingUrl) URL.revokeObjectURL(pendingUrl); off(); off2(); } };
}
