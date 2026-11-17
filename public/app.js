'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const S = {
  cards: [],
  cardId: null,
  card: null,
  groups: [],
  groupId: null,
  group: null,
  members: [],
  chats: [],
  chat: null,
  folders: [],
  selected: new Set(),
  selectMode: false,
  renderLimit: 200,
  worlds: [],
  worldId: null,
  world: null,
  regex: [],
  settings: {},
  version: '',
  streaming: false,
  abort: null,
  editing: null,
  targetIdx: -1,
  streamMsg: null,
  raf: false,
};

/* ============================== 基础 ============================== */
async function api(path, opts) {
  const r = await fetch(path, opts);
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('json')) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return null;
  }
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
  return j;
}

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

function el(tag, cls, txt) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ============================== Markdown ============================== */
function renderMarkdown(src) {
  const codes = [];
  let s = String(src || '');
  s = s.replace(/```([A-Za-z0-9_+-]*)\n?([\s\S]*?)```/g, (m, lang, code) => {
    codes.push(code.replace(/\n$/, ''));
    return '\u0000C' + (codes.length - 1) + '\u0000';
  });
  s = esc(s);
  s = s.replace(/^###### (.*)$/gm, '<h4>$1</h4>')
       .replace(/^##### (.*)$/gm, '<h4>$1</h4>')
       .replace(/^#### (.*)$/gm, '<h4>$1</h4>')
       .replace(/^### (.*)$/gm, '<h3>$1</h3>')
       .replace(/^## (.*)$/gm, '<h2>$1</h2>')
       .replace(/^# (.*)$/gm, '<h1>$1</h1>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  s = s.replace(/^&gt; (.*)$/gm, '<blockquote>$1</blockquote>');
  s = s.replace(/^\s*[-*+] (.*)$/gm, '<li>$1</li>');
  s = s.replace(/^\s*\d+\. (.*)$/gm, '<li>$1</li>');
  s = s.replace(/(?:<li>[\s\S]*?<\/li>\s*)+/g, (m) => '<ul>' + m + '</ul>');
  s = s.replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>');
  s = '<p>' + s + '</p>';
  s = s.replace(/<p>\s*<\/p>/g, '');
  s = s.replace(/\u0000C(\d+)\u0000/g, (m, i) => '<pre><code>' + esc(codes[+i]) + '</code></pre>');
  return s;
}

/* ============================== 角色列表 ============================== */
function initial(name) { return String(name || '?').trim().charAt(0).toUpperCase(); }

function renderCards() {
  const box = $('#cardList');
  box.replaceChildren();
  if (!S.cards.length) {
    box.append(el('div', 'empty-mini', '还没有角色卡'));
    return;
  }
  for (const c of S.cards) {
    const row = el('div', 'card-item' + (c.id === S.cardId ? ' active' : ''));
    const av = el('div', 'avatar');
    if (c.hasAvatar) {
      const img = el('img');
      img.src = '/api/cards/' + c.id + '/avatar';
      img.alt = c.name;
      av.append(img);
    } else {
      av.textContent = initial(c.name);
      av.classList.add('ph');
    }
    const meta = el('div', 'ci-meta');
    meta.append(el('div', 'ci-name', c.name));
    meta.append(el('div', 'ci-desc', c.desc || '无描述'));
    row.append(av, meta);
    row.addEventListener('click', () => selectCard(c.id).catch((e) => toast(e.message)));
    box.append(row);
  }
}

function currentEntity() {
  if (S.group) return { type: 'group', name: S.group.name, count: S.members.length, worldId: S.group.worldId };
  if (S.card) return { type: 'card', name: S.card.name, count: 1, worldId: S.card.worldId };
  return null;
}

/* ============================== 群聊列表 ============================== */
function renderGroups() {
  const box = $('#groupList');
  if (!box) return;
  box.replaceChildren();
  if (!S.groups.length) {
    box.append(el('div', 'empty-mini', '还没有群聊'));
    return;
  }
  for (const g of S.groups) {
    const row = el('div', 'card-item' + (g.id === S.groupId ? ' active' : ''));
    const stack = el('div', 'avatar-stack');
    const mem = (g.members || []).map((id) => S.cards.find((c) => c.id === id)).filter(Boolean);
    mem.slice(0, 3).forEach((c) => {
      const a = el('span', 'mini-av');
      if (c.hasAvatar) {
        const img = el('img');
        img.src = '/api/cards/' + c.id + '/avatar';
        a.append(img);
      } else {
        a.textContent = initial(c.name);
      }
      stack.append(a);
    });
    if (!mem.length) {
      const a = el('span', 'mini-av ph', '群');
      stack.append(a);
    }
    const meta = el('div', 'ci-meta');
    meta.append(el('div', 'ci-name', g.name));
    meta.append(el('div', 'ci-desc', `${g.members.length} 名成员 · ${g.mode === 'random' ? '随机' : '轮询'}`));
    row.append(stack, meta);
    row.addEventListener('click', () => selectGroup(g.id).catch((e) => toast(e.message)));
    box.append(row);
  }
}

async function loadGroups() {
  S.groups = (await api('/api/groups')).groups || [];
  renderGroups();
}

function fillGroupForm() {
  const g = S.group;
  const sel = $('#gSelect');
  sel.replaceChildren();
  if (!S.groups.length) sel.append(new Option('（暂无群组）', ''));
  for (const x of S.groups) sel.append(new Option(x.name, x.id));
  if (S.groupId) sel.value = S.groupId;

  $('#gName').value = g ? g.name : '';
  $('#gMode').value = g ? g.mode : 'round_robin';

  const gw = $('#gWorld');
  gw.replaceChildren();
  gw.append(new Option('（不使用）', ''));
  for (const w of S.worlds) gw.append(new Option(w.name, w.id));
  gw.value = (g && g.worldId) || '';

  renderGroupMembers(g ? new Set(g.members || []) : new Set());
}

function renderGroupMembers(selected) {
  const box = $('#gMembers');
  box.replaceChildren();
  const upd = () => {
    const n = box.querySelectorAll('input[type=checkbox]:checked').length;
    $('#gCount').textContent = `(${n}/${S.cards.length})`;
  };
  for (const c of S.cards) {
    const lab = el('label', 'member');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.value = c.id;
    cb.checked = selected.has(c.id);
    cb.addEventListener('change', upd);
    const av = el('span', 'mini-av');
    if (c.hasAvatar) {
      const img = el('img');
      img.src = '/api/cards/' + c.id + '/avatar';
      av.append(img);
    } else {
      av.textContent = initial(c.name);
    }
    lab.append(cb, av, el('span', 'member-name', c.name));
    box.append(lab);
  }
  $('#gCount').textContent = `(${selected.size}/${S.cards.length})`;
}

async function openGroupForm(id) {
  S.groupId = id || null;
  S.group = id ? await api('/api/groups/' + id) : null;
  if (S.group) S.members = S.group.memberInfo || [];
  fillGroupForm();
  renderGroups();
}

async function saveGroup() {
  const members = Array.from($('#gMembers').querySelectorAll('input[type=checkbox]:checked')).map((x) => x.value);
  if (!members.length) { toast('至少选择一位成员'); return; }
  const body = {
    name: $('#gName').value.trim() || '未命名群组',
    members,
    mode: $('#gMode').value,
    worldId: $('#gWorld').value,
  };
  if (S.groupId) body.id = S.groupId;
  const r = await api('/api/groups', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await loadGroups();
  await openGroupForm(r.group.id);
  toast('群组已保存');
}

async function newGroup() {
  if (!S.cards.length) { toast('先导入角色卡'); return; }
  const r = await api('/api/groups', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '新群聊', members: [S.cards[0].id], mode: 'round_robin', worldId: '' }),
  });
  await loadGroups();
  await openGroupForm(r.group.id);
  openDrawer('group');
}

async function deleteGroup() {
  if (!S.groupId) { toast('先选择一个群组'); return; }
  if (!confirm('删除群组「' + (S.group ? S.group.name : '') + '」及其全部对话？')) return;
  await api('/api/groups/' + S.groupId, { method: 'DELETE' });
  S.groupId = null; S.group = null; S.members = []; S.chat = null; S.chats = [];
  await loadGroups();
  fillGroupForm();
  if (S.card) await selectCard(S.card.id); else { renderMessages(); renderTop(); }
  toast('已删除');
}

/* 单一判定入口：单人卡片或群聊都算"就绪"，避免各处守卫各写一套 */
function isReady() {
  return !!(S.card || S.group);
}
function canSend() {
  return isReady() && !S.streaming && !!$('#input').value.trim();
}

function renderTop() {
  const ent = currentEntity();
  $('#chatTitle').textContent = ent ? ent.name : '未选择角色';
  const bits = [];
  if (S.chat && S.chat.title && S.chat.title !== (ent && ent.name)) bits.push(S.chat.title);
  if (ent) bits.push((S.chat ? S.chat.messages.length : 0) + ' 条消息');
  if (ent && ent.type === 'group') bits.push(ent.count + ' 名成员');
  if (ent && ent.worldId) {
    const w = S.worlds.find((x) => x.id === ent.worldId);
    if (w) bits.push('世界书：' + w.name);
  }
  $('#chatSub').textContent = bits.join(' · ') || '从左侧选择角色';
  const ready = isReady();
  $('#input').disabled = !ready;
  $('#input').placeholder = ready ? `以 ${S.settings.user_name || '你'} 的身份说点什么…` : '请先选择角色';
  $('#send').disabled = !canSend();
  renderSpeakerBar();
}

/* 群聊：下一位发言者选择条 */
function renderSpeakerBar() {
  const bar = $('#speakerBar');
  if (!S.group || !S.members.length) { bar.hidden = true; return; }
  bar.hidden = false;
  const box = $('#speakerPick');
  box.replaceChildren();
  const next = S.chat && S.chat.nextSpeakerId;
  const autoIdx = S.chat && S.members.length ? (Number(S.chat.turnIndex) || 0) % S.members.length : 0;
  const autoId = S.members[autoIdx] ? S.members[autoIdx].id : '';
  for (const m of S.members) {
    const isNext = next ? next === m.id : autoId === m.id;
    const b = el('button', 'sp-chip' + (isNext ? ' active' : ''));
    const av = el('span', 'sp-av');
    if (m.hasAvatar) {
      const img = el('img');
      img.src = '/api/cards/' + m.id + '/avatar';
      img.alt = m.name;
      av.append(img);
    } else {
      av.textContent = initial(m.name);
    }
    b.append(av, el('span', 'sp-name', m.name));
    if (isNext && !next) b.append(el('span', 'sp-tag', '自动'));
    b.title = next === m.id ? '取消指定，恢复自动顺序' : `下一位由 ${m.name} 发言`;
    b.addEventListener('click', () => setSpeaker(next === m.id ? '' : m.id));
    box.append(b);
  }
  if (!next) box.append(el('span', 'sp-hint', '按顺序自动切换'));
}

/* ============================== 消息渲染 ============================== */
function ensureInner() {
  let inner = document.getElementById('msgInner');
  if (!inner) {
    inner = el('div', 'inner');
    inner.id = 'msgInner';
    $('#messages').append(inner);
  }
  return inner;
}

function showWelcome(on) {
  const w = document.getElementById('welcome');
  const inner = ensureInner();
  w.hidden = !on;
  inner.hidden = on;
  if (!on) return;

  const h1 = w.querySelector('h1');
  const p = w.querySelector('p');
  const chips = w.querySelector('.chips');
  const hint = w.querySelector('.hint-line');

  if (isReady()) {
    h1.textContent = (S.group && S.group.name) || (S.card && S.card.name) || '开始对话';
    p.textContent = S.group ? '群聊已就绪，说点什么开场。' : '还没有消息，说点什么开场。';
    if (chips) chips.hidden = true;
    if (hint) hint.hidden = true;
  } else {
    h1.textContent = '角色扮演引擎';
    p.innerHTML = '导入角色卡（PNG / JSON），加载世界书，然后开始一段对话。<br>支持多角色群聊、多候选重掷、消息回退与长上下文记忆。';
    if (chips) chips.hidden = false;
    if (hint) hint.hidden = false;
  }
}

function msgText(m) {
  if (!m) return '';
  if (m.role === 'assistant') {
    if (m._streaming) return m.content || '';
    const sw = Array.isArray(m.swipes) && m.swipes.length ? m.swipes : [m.content || ''];
    return sw[Math.min(m.swipeId || 0, sw.length - 1)] || '';
  }
  return m.content || '';
}

function toolsBar(m, i) {
  const bar = el('div', 'msg-tools');
  const isLast = i === S.chat.messages.length - 1;
  const n = Array.isArray(m.swipes) ? m.swipes.length : 1;
  if (m.role === 'assistant' && n > 1) {
    const nav = el('span', 'swipe-nav');
    const prev = el('button', 'sw-btn', '‹');
    const lab = el('span', null, (Math.min(m.swipeId || 0, n - 1) + 1) + '/' + n);
    const next = el('button', 'sw-btn', '›');
    prev.addEventListener('click', () => swipeTo(i, (m.swipeId || 0) - 1));
    next.addEventListener('click', () => swipeTo(i, (m.swipeId || 0) + 1));
    nav.append(prev, lab, next);
    bar.append(nav);
  }
  if (m.role === 'assistant' && isLast && !S.streaming) {
    const rg = el('button', null, '重掷');
    rg.title = '重新生成这条回复（会作为新的候选保留）';
    rg.addEventListener('click', () => regenerate());
    bar.append(rg);
  }
  const ed = el('button', null, '编辑');
  ed.addEventListener('click', () => { S.editing = i; renderMessages(); });
  const rw = el('button', null, '回退');
  rw.title = '回到这一刻：删除这条消息之后的全部内容';
  rw.addEventListener('click', () => rewindTo(i));
  const del = el('button', null, '删除');
  del.addEventListener('click', () => deleteMsg(i));
  bar.append(ed, rw, del);
  return bar;
}

function speakerOf(m) {
  if (S.group) {
    const mem = S.members.find((x) => x.id === m.speakerId);
    if (mem) return mem;
    return { id: m.speakerId || '', name: m.speakerName || '角色', hasAvatar: false };
  }
  return {
    id: S.card ? S.card.id : '',
    name: (S.card && S.card.name) || m.speakerName || '角色',
    hasAvatar: !!(S.card && S.card.hasAvatar),
  };
}

function msgEl(m, i) {
  if (m.role === 'user') {
    const wrap = el('div', 'msg user');
    const b = el('div', 'bubble');
    if (S.editing === i) {
      b.append(editArea(m.content, (v) => saveEdit(i, v), () => { S.editing = null; renderMessages(); }));
    } else {
      b.textContent = m.content;
    }
    const holder = el('div', 'u-col');
    holder.append(b, toolsBar(m, i));
    wrap.append(holder);
    return wrap;
  }
  const sp = speakerOf(m);
  const wrap = el('div', 'msg assistant');
  const av = el('div', 'avatar small');
  if (sp.hasAvatar && sp.id) {
    const img = el('img');
    img.src = '/api/cards/' + sp.id + '/avatar';
    av.append(img);
  } else {
    av.textContent = initial(sp.name);
    av.classList.add('ph');
  }
  const col = el('div', 'a-col');
  col.append(el('div', 'who', sp.name));

  // 深度思考（deepseek-reasoner）：流式时展开，结束后默认折叠
  if (m.reasoning || m._streaming) {
    const det = el('details', 'think');
    if (m._streaming && !m.content) det.open = true;
    const sum = el('summary', null, m._streaming && !m.content ? '思考中…' : '思考过程');
    const tb = el('div', 'think-body');
    tb.textContent = m.reasoning || '';
    det.append(sum, tb);
    col.append(det);
  }

  const body = el('div', 'body');
  if (S.editing === i) {
    body.append(editArea(msgText(m), (v) => saveEdit(i, v), () => { S.editing = null; renderMessages(); }));
  } else {
    body.innerHTML = renderMarkdown(msgText(m));
  }
  col.append(body, toolsBar(m, i));
  wrap.append(av, col);
  return wrap;
}

function editArea(text, onSave, onCancel) {
  const box = el('div', 'edit-box');
  const ta = el('textarea');
  ta.value = text || '';
  ta.rows = Math.max(4, Math.min(16, String(text || '').split('\n').length + 2));
  const bar = el('div', 'edit-bar');
  const ok = el('button', 'save small', '保存');
  const no = el('button', 'ghost small', '取消');
  ok.addEventListener('click', () => onSave(ta.value));
  no.addEventListener('click', onCancel);
  bar.append(ok, no);
  box.append(ta, bar);
  setTimeout(() => ta.focus(), 0);
  return box;
}

const RENDER_STEP = 200;

function renderMessages(opts = {}) {
  if (!S.chat || !S.chat.messages.length) {
    showWelcome(true);
    renderTop();
    return;
  }
  showWelcome(false);
  const inner = ensureInner();
  inner.replaceChildren();

  const all = S.chat.messages;
  const limit = Math.min(all.length, S.renderLimit || RENDER_STEP);
  const start = all.length - limit;

  // 长对话只渲染最近 N 条，避免 DOM 无限膨胀
  if (start > 0) {
    const btn = el('button', 'load-earlier', `↑ 加载更早的 ${start} 条`);
    btn.addEventListener('click', () => {
      const box = $('#messages');
      const prevHeight = box.scrollHeight;
      const prevTop = box.scrollTop;
      S.renderLimit = (S.renderLimit || RENDER_STEP) + RENDER_STEP;
      renderMessages({ keepScroll: true });
      box.scrollTop = box.scrollHeight - prevHeight + prevTop;
    });
    inner.append(btn);
  }

  for (let i = start; i < all.length; i++) inner.append(msgEl(all[i], i));
  renderTop();
  if (!opts.keepScroll) scrollBottom();
}

function scrollBottom() {
  const m = $('#messages');
  m.scrollTop = m.scrollHeight;
}

/* ============================== 对话操作 ============================== */
function chatsUrl() {
  return S.groupId ? '/api/chats?groupId=' + S.groupId : '/api/chats?cardId=' + (S.cardId || '');
}

/* 惰性建对话：只在内存里准备，用户发出第一条消息时才落盘 */
function prepareDraftChat() {
  const draft = {
    id: '',
    cardId: S.cardId || '',
    groupId: S.groupId || '',
    title: '',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  if (!S.groupId && S.card && S.card.first_mes) {
    draft.messages.push({
      role: 'assistant', content: S.card.first_mes, swipes: [S.card.first_mes], swipeId: 0,
      speakerId: S.card.id, speakerName: S.card.name,
    });
  }
  S.chat = draft;
  S.editing = null;
  renderMessages();
  loadMemory();
  renderChatList();
}

async function selectCard(id) {
  S.cardId = id;
  S.groupId = null;
  S.group = null;
  S.members = [];
  S.card = await api('/api/cards/' + id);
  S.chats = (await api(chatsUrl())).chats || [];
  if (S.chats.length) await openChat(S.chats[0].id);
  else prepareDraftChat();
  renderCards();
  renderGroups();
  fillCardForm();
}

async function selectGroup(id) {
  S.groupId = id;
  S.cardId = null;
  S.card = null;
  S.group = await api('/api/groups/' + id);
  S.members = S.group.memberInfo || [];
  S.chats = (await api(chatsUrl())).chats || [];
  if (S.chats.length) await openChat(S.chats[0].id);
  else prepareDraftChat();
  renderCards();
  renderGroups();
  fillCardForm();
}

async function openChat(id) {
  S.chat = await api('/api/chats/' + id);
  S.renderLimit = RENDER_STEP;
  // 切换到群聊对话时，同步群组上下文
  if (S.chat.groupId && (!S.group || S.group.id !== S.chat.groupId)) {
    S.groupId = S.chat.groupId;
    S.group = await api('/api/groups/' + S.chat.groupId);
    S.members = S.group.memberInfo || [];
    S.cardId = null;
    S.card = null;
  } else if (!S.chat.groupId && S.group) {
    S.groupId = null;
    S.group = null;
    S.members = [];
  }
  S.editing = null;
  S.chats = (await api(chatsUrl())).chats || [];
  renderMessages();
  renderChatList();
  renderGroups();
  renderCards();
  loadMemory();
}

async function newChat() {
  if (!S.cardId && !S.groupId) return;
  // 同样走惰性：点「新建」只切到空白草稿，发出消息才落盘
  prepareDraftChat();
}

async function reloadChat() {
  if (!S.chat) return;
  S.chat = await api('/api/chats/' + S.chat.id);
  renderMessages();
  loadMemory();
}

async function swipeTo(i, dir) {
  if (!S.chat) return;
  await api('/api/chats/message', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chatId: S.chat.id, index: i, action: 'swipe', index2: dir }),
  });
  await reloadChat();
}

async function saveEdit(i, content) {
  await api('/api/chats/message', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chatId: S.chat.id, index: i, action: 'edit', content }),
  });
  S.editing = null;
  await reloadChat();
}

async function deleteMsg(i) {
  await api('/api/chats/message', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chatId: S.chat.id, index: i, action: 'delete' }),
  });
  await reloadChat();
}

async function rewindTo(i) {
  if (!S.chat) return;
  const after = S.chat.messages.length - i - 1;
  if (after <= 0) { toast('这已经是最后一条，无需回退'); return; }
  const tail = S.chat.messages[i];
  const what = tail.role === 'user' ? '你的这条发言之后' : '这条回复之后';
  if (!confirm(`回退到${what}？其后的 ${after} 条消息会被删除，且不可恢复。`)) return;
  const r = await api('/api/chats/rewind', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chatId: S.chat.id, index: i }),
  });
  await reloadChat();
  S.chats = (await api(chatsUrl())).chats || [];
  renderChatList();
  toast(`已回退，删除 ${r.removed} 条消息`);
  if (tail.role === 'user') {
    $('#input').value = tail.content || '';
    autoGrow();
    $('#send').disabled = !canSend();
    $('#input').focus();
  }
}

async function setSpeaker(id) {
  if (!S.chat) return;
  await api('/api/chats/message', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chatId: S.chat.id, action: 'speaker', content: id }),
  });
  S.chat.nextSpeakerId = id;
  renderSpeakerBar();
}

/* ============================== 生成 ============================== */
function scheduleStreamPaint() {
  if (S.raf) return;
  S.raf = true;
  requestAnimationFrame(() => {
    S.raf = false;
    const m = S.streamMsg;
    if (!m) return;
    const inner = document.getElementById('msgInner');
    if (!inner) return;
    const nodes = inner.querySelectorAll('.msg.assistant .body');
    const node = nodes[nodes.length - 1];
    if (node) {
      node.innerHTML = renderMarkdown(m.content || '') || '<span class="cursor">▍</span>';
      const tbs = inner.querySelectorAll('.think-body');
      const tb = tbs[tbs.length - 1];
      if (tb) tb.textContent = m.reasoning || '';
      scrollBottom();
    }
  });
}

async function streamGenerate(payload, targetIdx) {
  const ac = new AbortController();
  S.abort = ac;
  const r = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: ac.signal,
  });
  if (!r.ok || !r.body) throw new Error('HTTP ' + r.status);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const d = line.slice(5).trim();
        if (!d) continue;
        let ev;
        try { ev = JSON.parse(d); } catch (_) { continue; }
        if (ev.type === 'chat') {
          if (S.chat) S.chat.id = ev.id;
        } else if (ev.type === 'delta') {
          S.streamMsg.content = (S.streamMsg.content || '') + ev.text;
          scheduleStreamPaint();
        } else if (ev.type === 'thinking') {
          S.streamMsg.reasoning = (S.streamMsg.reasoning || '') + ev.text;
          scheduleStreamPaint();
        } else if (ev.type === 'memory') {
          if (ev.status === 'start') toast('正在整理前情提要…');
          else if (ev.status === 'done') toast(`已把 ${ev.batch} 条早期消息压缩进提要`);
          else if (ev.status === 'error') toast('提要整理失败：' + ev.message);
        } else if (ev.type === 'error') {
          toast(ev.message);
        } else if (ev.type === 'done') {
          if (ev.chatId) S.chat.id = ev.chatId;
        }
      }
    }
  }
}

async function send() {
  if (S.streaming || !isReady()) return;
  const text = $('#input').value.trim();
  if (!text) return;

  // 惰性落盘：对话文件在发出第一条消息时才创建
  if (!S.chat || !S.chat.id) {
    try {
      const r = await api('/api/chats', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(S.groupId ? { groupId: S.groupId } : { cardId: S.cardId }),
      });
      S.chat = r.chat;
      S.chats = (await api(chatsUrl())).chats || [];
      renderChatList();
    } catch (e) {
      toast('创建对话失败：' + e.message);
      return;
    }
  }

  $('#input').value = '';
  autoGrow();
  $('#send').disabled = true;

  S.chat.messages.push({ role: 'user', content: text, time: Date.now() });
  const ph = { role: 'assistant', content: '', swipes: [''], swipeId: 0, _streaming: true };
  S.chat.messages.push(ph);
  S.streamMsg = ph;
  S.streaming = true;
  $('#stop').hidden = false;
  renderMessages();

  try {
    await streamGenerate({ chatId: S.chat.id, text }, S.chat.messages.length - 1);
  } catch (e) {
    if (e.name !== 'AbortError') toast(e.message || String(e));
  } finally {
    S.streaming = false;
    S.streamMsg = null;
    S.abort = null;
    $('#stop').hidden = true;
    await reloadChat();
    S.chats = (await api(chatsUrl())).chats || [];
    renderChatList();
  }
}

async function regenerate() {
  if (S.streaming || !isReady() || !S.chat) return;
  const last = S.chat.messages[S.chat.messages.length - 1];
  if (!last || last.role !== 'assistant') { toast('最后一条是角色发言才能重掷'); return; }

  const ph = { role: 'assistant', content: '', swipes: [''], swipeId: 0, _streaming: true };
  S.chat.messages[S.chat.messages.length - 1] = ph;
  S.streamMsg = ph;
  S.streaming = true;
  $('#stop').hidden = false;
  renderMessages();

  try {
    await streamGenerate({ chatId: S.chat.id, regenerate: true }, S.chat.messages.length - 1);
  } catch (e) {
    if (e.name !== 'AbortError') toast(e.message || String(e));
  } finally {
    S.streaming = false;
    S.streamMsg = null;
    S.abort = null;
    $('#stop').hidden = true;
    await reloadChat();
  }
}

/* ============================== 对话列表（置顶/分组/多选） ============================== */
function chatRow(c) {
  const active = S.chat && c.id === S.chat.id;
  const row = el('div', 'chat-item' + (active ? ' active' : '') + (S.selected.has(c.id) ? ' selected' : ''));

  if (S.selectMode) {
    const cb = el('input');
    cb.type = 'checkbox';
    cb.className = 'chat-cb';
    cb.checked = S.selected.has(c.id);
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => toggleSelect(c.id));
    row.append(cb);
  }

  const t = el('div', 'ci-meta');
  const nameRow = el('div', 'ci-name');
  if (c.pinned) nameRow.append(el('span', 'pin-dot', '★ '));
  nameRow.append(document.createTextNode(c.title || '新对话'));
  t.append(nameRow);
  t.append(el('div', 'ci-desc', c.count + ' 条 · ' + new Date(c.updatedAt).toLocaleString('zh-CN', { hour12: false })));

  const pin = el('button', 'mini pin-btn', c.pinned ? '★' : '☆');
  pin.title = c.pinned ? '取消置顶' : '置顶';
  pin.addEventListener('click', async (e) => {
    e.stopPropagation();
    await batchAction([c.id], c.pinned ? 'unpin' : 'pin');
  });

  const del = el('button', 'mini item-del', '×');
  del.title = '删除这个对话';
  del.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm(`删除「${c.title || '新对话'}」？不可恢复。`)) return;
    await batchAction([c.id], 'delete');
    if (S.chat && S.chat.id === c.id) {
      if (S.chats.length) await openChat(S.chats[0].id);
      else prepareDraftChat();
    }
  });

  row.append(t, pin, del);
  row.addEventListener('click', () => {
    if (S.selectMode) toggleSelect(c.id);
    else openChat(c.id).catch((e) => toast(e.message));
  });
  return row;
}

function renderChatList() {
  const box = $('#chatListBody');
  if (!box) return;
  box.replaceChildren();

  const cnt = $('#chatCount');
  if (cnt) cnt.textContent = S.chats.length ? `(${S.chats.length})` : '';

  const bar = $('#batchBar');
  if (bar) bar.hidden = !S.selectMode;
  if (S.selectMode) {
    const bc = $('#batchCount');
    if (bc) bc.textContent = `已选 ${S.selected.size}`;
  }

  if (!S.chats.length) {
    box.append(el('div', 'empty-mini', '暂无对话'));
    return;
  }

  const pinned = S.chats.filter((c) => c.pinned);
  const rest = S.chats.filter((c) => !c.pinned);

  const section = (title, items, folderId) => {
    // 空分组也要显示，否则用户新建后看不到它
    if (!items.length && !folderId) return;
    const head = el('div', 'chat-group-head');
    head.append(el('span', 'cg-name', title));
    head.append(el('span', 'cg-count', String(items.length)));
    if (folderId) {
      const del = el('button', 'mini danger', '×');
      del.title = '删除分组（其中的对话会回到未分组）';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`删除分组「${title}」？其中的对话会移到未分组。`)) return;
        await api('/api/folders/' + folderId, { method: 'DELETE' });
        await loadFolders();
        await refreshChats();
      });
      head.append(del);
    }
    box.append(head);
    items.forEach((c) => box.append(chatRow(c)));
  };

  section('置顶', pinned);
  for (const f of S.folders) section(f.name, rest.filter((c) => c.folderId === f.id), f.id);
  section('未分组', rest.filter((c) => !c.folderId || !S.folders.some((f) => f.id === c.folderId)));
}

async function refreshChats() {
  S.chats = (await api(chatsUrl())).chats || [];
  renderChatList();
}

async function batchAction(ids, action, folderId) {
  await api('/api/chats/batch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids, action, folderId }),
  });
  await refreshChats();
}

function toggleSelect(id) {
  if (S.selected.has(id)) S.selected.delete(id);
  else S.selected.add(id);
  renderChatList();
}

async function runBatch(action) {
  const ids = Array.from(S.selected);
  if (!ids.length) { toast('先选择对话'); return; }
  if (action === 'delete') {
    if (!confirm(`删除 ${ids.length} 个对话？不可恢复。`)) return;
  }
  let folderId;
  if (action === 'move') {
    const v = $('#batchMoveSel').value;
    if (!v || v === '__none') { toast('先选择一个分组'); return; }
    folderId = v;
  }
  await batchAction(ids, action, folderId);
  S.selected.clear();

  if (action === 'delete' && S.chat && ids.includes(S.chat.id)) {
    if (S.chats.length) await openChat(S.chats[0].id);
    else prepareDraftChat();
  }
  renderChatList();
}

function fillMoveSelect() {
  const sel = $('#batchMoveSel');
  if (!sel) return;
  const cur = sel.value;
  sel.replaceChildren();
  sel.append(new Option('移到分组…', '__none'));
  for (const f of S.folders) sel.append(new Option(f.name, f.id));
  sel.append(new Option('（未分组）', ''));
  if (Array.from(sel.options).some((o) => o.value === cur)) sel.value = cur;
}

async function loadFolders() {
  S.folders = (await api('/api/folders')).folders || [];
  fillMoveSelect();
}

async function createFolder() {
  const name = prompt('新建分组，输入名称：');
  if (!name || !name.trim()) return;
  await api('/api/folders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: name.trim() }),
  });
  await loadFolders();
  await refreshChats();
  toast('分组已创建');
}

/* ============================== 记忆与导出 ============================== */
async function loadMemory() {
  if (!S.chat || !S.chat.id) {
    S.mem = null;
    $('#memText').value = '';
    $('#memStat').textContent = '';
    return;
  }
  try {
    const r = await api('/api/memory?chatId=' + S.chat.id);
    S.mem = r;
    $('#memText').value = (r.memory && r.memory.summary) || '';
    $('#memStat').textContent = `已覆盖 ${r.covered}/${r.total} 条 · 待压缩 ${r.pending} 条`;
  } catch (_) {}
}

function exportChat(fmt) {
  if (!S.chat || !S.chat.id) { toast('先发一条消息，对话才会保存'); return; }
  window.open('/api/chats/' + S.chat.id + '/export?format=' + fmt, '_blank');
}

async function memoryAction(action) {
  if (!S.chat) { toast('先选择一个对话'); return; }
  if (action === 'rebuild' && !confirm('将清空现有提要，用全部历史重新生成。继续？')) return;
  if (action === 'clear' && !confirm('清空这段对话的前情提要？')) return;
  const body = { chatId: S.chat.id, action };
  if (action === 'set') {
    body.summary = $('#memText').value;
    body.summarized = (S.mem && S.mem.memory && S.mem.memory.summarized) || 0;
  }
  try {
    if (action === 'append' || action === 'rebuild') toast('正在生成提要，请稍候…');
    await api('/api/memory', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    await loadMemory();
    toast(action === 'clear' ? '提要已清空' : action === 'set' ? '提要已保存' : '提要已更新');
  } catch (e) { toast(e.message); }
}

/* ============================== 设置 ============================== */
async function loadSettings() {
  S.settings = await api('/api/settings');
  const s = S.settings;
  $('#cfgKey').value = '';
  $('#cfgKey').placeholder = s.hasKey ? '已配置 ' + s.keyMask + '（留空不修改）' : 'sk-...';
  $('#cfgModel').value = s.model;
  $('#cfgUser').value = s.user_name || '';
  $('#cfgTemp').value = s.temperature;
  $('#cfgTopP').value = s.top_p;
  $('#cfgPres').value = s.presence_penalty;
  $('#cfgFreq').value = s.frequency_penalty;
  $('#cfgMax').value = s.max_tokens;
  $('#cfgCtx').value = s.context_messages;
  $('#cfgWorldOn').checked = !!s.world_enabled;
  $('#cfgScan').value = s.world_scan_depth;
  $('#cfgMemOn').checked = !!s.memory_enabled;
  $('#cfgMemBatch').value = s.memory_min_batch;
  $('#cfgMemChars').value = s.memory_max_chars;
  $('#cfgSys').value = s.system_prompt || '';
  $('#modelTag').textContent = s.model;
  S.version = s.version || '';
  $('#verTag').textContent = 'v' + (S.version || '—');
  $('#verFoot').textContent = `${s.name || 'RoleHaven'} v${S.version || '—'} · 本地优先 · 零依赖`;
  $('#keyState').textContent = s.hasKey ? 'API Key 已配置' : 'API Key 未配置';
  $('#keyState').className = 'key-state' + (s.hasKey ? ' ok' : '');
  syncSliderLabels();
}

function syncSliderLabels() {
  $('#vTemp').textContent = Number($('#cfgTemp').value).toFixed(2);
  $('#vTopP').textContent = Number($('#cfgTopP').value).toFixed(2);
  $('#vPres').textContent = Number($('#cfgPres').value).toFixed(2);
  $('#vFreq').textContent = Number($('#cfgFreq').value).toFixed(2);
}

async function saveSettings() {
  const body = {
    model: $('#cfgModel').value,
    user_name: $('#cfgUser').value,
    temperature: Number($('#cfgTemp').value),
    top_p: Number($('#cfgTopP').value),
    presence_penalty: Number($('#cfgPres').value),
    frequency_penalty: Number($('#cfgFreq').value),
    max_tokens: Number($('#cfgMax').value),
    context_messages: Number($('#cfgCtx').value),
    world_enabled: $('#cfgWorldOn').checked,
    world_scan_depth: Number($('#cfgScan').value),
    memory_enabled: $('#cfgMemOn').checked,
    memory_min_batch: Number($('#cfgMemBatch').value),
    memory_max_chars: Number($('#cfgMemChars').value),
    system_prompt: $('#cfgSys').value,
  };
  const k = $('#cfgKey').value.trim();
  if (k) body.apiKey = k;
  await api('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await loadSettings();
  renderTop();
  toast('设置已保存');
}

/* ============================== 角色卡表单 ============================== */
function fillCardForm() {
  const c = S.card;
  const on = !!c;
  ['cName', 'cDesc', 'cPers', 'cScen', 'cFirst', 'cExample', 'cSys', 'cPost', 'cAlt', 'cTags'].forEach((id) => {
    $(`#${id}`).disabled = !on;
  });
  $('#cWorld').disabled = !on;
  if (!on) {
    ['cName', 'cDesc', 'cPers', 'cScen', 'cFirst', 'cExample', 'cSys', 'cPost', 'cAlt', 'cTags'].forEach((id) => { $(`#${id}`).value = ''; });
    return;
  }
  $('#cName').value = c.name || '';
  $('#cDesc').value = c.description || '';
  $('#cPers').value = c.personality || '';
  $('#cScen').value = c.scenario || '';
  $('#cFirst').value = c.first_mes || '';
  $('#cExample').value = c.mes_example || '';
  $('#cSys').value = c.system_prompt || '';
  $('#cPost').value = c.post_history_instructions || '';
  $('#cAlt').value = (c.alternate_greetings || []).join('\n');
  $('#cTags').value = (c.tags || []).join(', ');
  const sel = $('#cWorld');
  sel.replaceChildren();
  sel.append(new Option('（不使用）', ''));
  for (const w of S.worlds) sel.append(new Option(w.name, w.id));
  sel.value = c.worldId || '';
}

async function saveCard() {
  if (!S.card) return;
  const body = {
    id: S.card.id,
    name: $('#cName').value.trim() || '未命名角色',
    description: $('#cDesc').value,
    personality: $('#cPers').value,
    scenario: $('#cScen').value,
    first_mes: $('#cFirst').value,
    mes_example: $('#cExample').value,
    system_prompt: $('#cSys').value,
    post_history_instructions: $('#cPost').value,
    alternate_greetings: $('#cAlt').value.split('\n').map((x) => x.trim()).filter(Boolean),
    tags: $('#cTags').value.split(',').map((x) => x.trim()).filter(Boolean),
    worldId: $('#cWorld').value,
  };
  const r = await api('/api/cards', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  S.card = r.card;
  S.cards = (await api('/api/cards')).cards || [];
  renderCards();
  renderTop();
  toast('角色卡已保存');
}

async function deleteCard() {
  if (!S.card) return;
  if (!confirm('删除角色「' + S.card.name + '」及其全部对话？')) return;
  await api('/api/cards/' + S.card.id, { method: 'DELETE' });
  S.card = null; S.cardId = null; S.chat = null; S.chats = [];
  S.cards = (await api('/api/cards')).cards || [];
  renderCards(); fillCardForm(); renderMessages(); renderTop();
  toast('已删除');
}

/* ============================== 世界书 ============================== */
async function loadWorlds() {
  S.worlds = (await api('/api/worlds')).worlds || [];
  const sel = $('#wSelect');
  sel.replaceChildren();
  if (!S.worlds.length) sel.append(new Option('（暂无世界书）', ''));
  for (const w of S.worlds) sel.append(new Option(w.name + ' (' + w.count + ')', w.id));
  const cw = $('#cWorld');
  const cur = cw.value;
  cw.replaceChildren();
  cw.append(new Option('（不使用）', ''));
  for (const w of S.worlds) cw.append(new Option(w.name, w.id));
  if (cur) cw.value = cur;
  if (S.worldId) sel.value = S.worldId;
}

async function openWorld(id) {
  if (!id) { S.world = null; $('#wEntries').replaceChildren(); $('#wName').value = ''; return; }
  S.worldId = id;
  S.world = await api('/api/worlds/' + id);
  $('#wName').value = S.world.name || '';
  renderEntries();
}

function renderEntries() {
  const box = $('#wEntries');
  box.replaceChildren();
  const w = S.world;
  if (!w) return;
  const list = Object.values(w.entries || {});
  $('#wCount').textContent = list.length ? '(' + list.length + ')' : '';
  list.sort((a, b) => (a.order || 100) - (b.order || 100));
  for (const e of list) {
    const card = el('div', 'entry');
    const head = el('div', 'entry-head');
    const cm = el('input', 'e-comment');
    cm.value = e.comment || '';
    cm.placeholder = '备注';
    const cst = el('label', 'mini');
    const cstI = el('input'); cstI.type = 'checkbox'; cstI.checked = !!e.constant;
    cst.append(cstI, el('span', null, '常驻'));
    const dis = el('label', 'mini');
    const disI = el('input'); disI.type = 'checkbox'; disI.checked = !!e.disable;
    dis.append(disI, el('span', null, '停用'));
    const del = el('button', 'mini danger', '✕');
    head.append(cm, cst, dis, del);

    const keys = el('input', 'e-keys');
    keys.value = (e.key || []).join(', ');
    keys.placeholder = '触发关键词，逗号分隔';
    const content = el('textarea', 'e-content');
    content.rows = 4;
    content.value = e.content || '';

    del.addEventListener('click', () => {
      delete w.entries[e.uid];
      renderEntries();
    });
    card.append(head, keys, content);
    card._e = e; card._keys = keys; card._content = content; card._cst = cstI; card._dis = disI; card._cm = cm;
    box.append(card);
  }
}

function collectWorld() {
  const w = S.world;
  if (!w) return null;
  const cards = Array.from($('#wEntries').children);
  const entries = {};
  cards.forEach((c, i) => {
    const e = c._e || {};
    entries[String(i)] = {
      uid: i,
      key: c._keys.value.split(',').map((x) => x.trim()).filter(Boolean),
      keysecondary: e.keysecondary || [],
      comment: c._cm.value,
      content: c._content.value,
      constant: c._cst.checked,
      disable: c._dis.checked,
      selective: true,
      order: e.order == null ? 100 : e.order,
      probability: 100,
      depth: e.depth == null ? 4 : e.depth,
    };
  });
  return { id: w.id, name: $('#wName').value.trim() || '未命名世界书', entries };
}

async function saveWorld() {
  const body = collectWorld();
  if (!body) { toast('先选择或新建世界书'); return; }
  const r = await api('/api/worlds', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  S.world = r.world;
  S.worlds = (await api('/api/worlds')).worlds || [];
  await loadWorlds();
  await openWorld(S.world.id);
  toast('世界书已保存');
}

/* ============================== 正则替换 ============================== */
function renderRegex() {
  const box = $('#rxList');
  box.replaceChildren();
  $('#rxCount').textContent = S.regex.length ? `(${S.regex.length})` : '';
  if (!S.regex.length) {
    box.append(el('div', 'empty-mini', '还没有规则'));
    return;
  }
  S.regex.forEach((r, i) => {
    const card = el('div', 'entry');
    const head = el('div', 'entry-head');

    const nm = el('input', 'e-comment rx-name');
    nm.value = r.name || '';
    nm.placeholder = '规则名（备注）';

    const mk = (label, cls, checked, title) => {
      const lab = el('label', 'mini');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.className = cls;
      cb.checked = !!checked;
      cb.title = title;
      lab.append(cb, el('span', null, label));
      return lab;
    };

    const del = el('button', 'mini danger', '✕');
    head.append(
      nm,
      mk('启用', 'rx-en', r.enabled !== false, '关闭后该规则不生效'),
      mk('输入', 'rx-in', (r.when || []).includes('input'), '对用户输入生效'),
      mk('输出', 'rx-out', (r.when || []).includes('output'), '对模型输出生效'),
      del
    );

    const find = el('input', 'e-keys rx-find');
    find.value = r.find || '';
    find.placeholder = '/pattern/gi  或  pattern';

    const rep = el('input', 'e-keys rx-rep');
    rep.value = r.replace || '';
    rep.placeholder = '替换为（\\n 换行，$1 分组）';

    del.addEventListener('click', () => { S.regex.splice(i, 1); renderRegex(); });
    card.append(head, find, rep);
    box.append(card);
  });
}

function collectRegex() {
  return Array.from($('#rxList').querySelectorAll('.entry')).map((c) => ({
    name: c.querySelector('.rx-name').value,
    find: c.querySelector('.rx-find').value,
    replace: c.querySelector('.rx-rep').value,
    enabled: c.querySelector('.rx-en').checked,
    when: [
      c.querySelector('.rx-in').checked ? 'input' : null,
      c.querySelector('.rx-out').checked ? 'output' : null,
    ].filter(Boolean),
  }));
}

async function loadRegex() {
  const r = await api('/api/regex');
  S.regex = r.scripts || [];
  renderRegex();
}

async function saveRegex(silent) {
  const r = await api('/api/regex', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scripts: collectRegex() }),
  });
  S.regex = r.scripts || [];
  renderRegex();
  if (!silent) toast('正则规则已保存');
}

async function rxTest(when) {
  await saveRegex(true);
  const text = $('#rxTestIn').value;
  const r = await api('/api/regex/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, when }),
  });
  const out = $('#rxOut');
  out.textContent = (r.changed ? '已生效：\n' : '（无变化）\n') + r.result;
  out.hidden = false;
}

/* ============================== 抽屉 ============================== */
function openDrawer(tab) {
  $('#drawer').hidden = false;
  $('#mask').hidden = false;
  switchTab(tab || 'params');
}
function closeDrawer() { $('#drawer').hidden = true; $('#mask').hidden = true; }

function switchTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.pane').forEach((p) => { p.hidden = p.dataset.pane !== name; });
  if (name === 'chats') { renderChatList(); loadMemory(); }
  if (name === 'card') fillCardForm();
  if (name === 'group') fillGroupForm();
  if (name === 'regex') loadRegex().catch((e) => toast(e.message));
  if (name === 'world') { loadWorlds().then(() => openWorld(S.worldId || (S.worlds[0] && S.worlds[0].id))); }
}

/* ============================== 导入 ============================== */
function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const s = String(fr.result);
      resolve(s.slice(s.indexOf(',') + 1));
    };
    fr.onerror = () => reject(new Error('读取文件失败'));
    fr.readAsDataURL(file);
  });
}

async function importCardFile(file) {
  const data = await readAsBase64(file);
  const r = await api('/api/import/card', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data, filename: file.name }) });
  S.cards = (await api('/api/cards')).cards || [];
  renderCards();
  await selectCard(r.card.id);
  toast('已导入角色：' + r.card.name + (r.card.worldId ? '（含内嵌世界书）' : ''));
}

async function importWorldFile(file) {
  const data = await readAsBase64(file);
  const name = file.name.replace(/\.json$/i, '');
  const r = await api('/api/import/world', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data, name }) });
  await loadWorlds();
  await openWorld(r.world.id);
  toast('已导入世界书：' + r.world.name);
}

/* ============================== 输入框 ============================== */
function autoGrow() {
  const t = $('#input');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 190) + 'px';
}

/* ============================== 事件绑定 ============================== */
$('#input').addEventListener('input', () => {
  autoGrow();
  $('#send').disabled = !canSend();
});
$('#input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!$('#send').disabled) send();
  }
});
$('#send').addEventListener('click', send);
$('#stop').addEventListener('click', () => { if (S.abort) S.abort.abort(); });
$('#newChat').addEventListener('click', () => newChat().catch((e) => toast(e.message)));
$('#newChat2').addEventListener('click', () => newChat().catch((e) => toast(e.message)));

/* 对话管理：多选 / 置顶 / 分组 / 分享 */
$('#chatSelectMode').addEventListener('click', () => {
  S.selectMode = !S.selectMode;
  S.selected.clear();
  $('#chatSelectMode').textContent = S.selectMode ? '退出多选' : '多选';
  renderChatList();
});
$('#newFolder').addEventListener('click', () => createFolder().catch((e) => toast(e.message)));
$('#batchAll').addEventListener('click', () => {
  S.chats.forEach((c) => S.selected.add(c.id));
  renderChatList();
});
$('#batchCancel').addEventListener('click', () => {
  S.selectMode = false;
  S.selected.clear();
  $('#chatSelectMode').textContent = '多选';
  renderChatList();
});
$('#batchPin').addEventListener('click', () => runBatch('pin').catch((e) => toast(e.message)));
$('#batchUnpin').addEventListener('click', () => runBatch('unpin').catch((e) => toast(e.message)));
$('#batchDelete').addEventListener('click', () => runBatch('delete').catch((e) => toast(e.message)));
$('#batchMoveSel').addEventListener('change', (e) => {
  if (e.target.value && e.target.value !== '__none') runBatch('move').catch((err) => toast(err.message));
});
$('#expHtml').addEventListener('click', () => exportChat('html'));

$('#newGroup').addEventListener('click', () => newGroup().catch((e) => toast(e.message)));
$('#gNew').addEventListener('click', () => newGroup().catch((e) => toast(e.message)));
$('#gSave').addEventListener('click', () => saveGroup().catch((e) => toast(e.message)));
$('#gDel').addEventListener('click', () => deleteGroup().catch((e) => toast(e.message)));
$('#gSelect').addEventListener('change', (e) => {
  if (e.target.value) openGroupForm(e.target.value).catch((err) => toast(err.message));
});

$('#importCard').addEventListener('click', () => $('#fileCard').click());
$('#chipImport').addEventListener('click', () => $('#fileCard').click());
$('#chipWorld').addEventListener('click', () => $('#fileWorld').click());
$('#fileCard').addEventListener('change', (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) importCardFile(f).catch((err) => toast(err.message));
});

$('#fileWorld').addEventListener('change', (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) importWorldFile(f).catch((err) => toast(err.message));
});

$('#openChats').addEventListener('click', () => openDrawer('chats'));
$('#openCard').addEventListener('click', () => { if (!S.card) { toast('先选择一个角色'); return; } openDrawer('card'); });
$('#openWorlds').addEventListener('click', () => openDrawer('world'));
$('#openSettings').addEventListener('click', () => openDrawer('params'));
$('#closeDrawer').addEventListener('click', closeDrawer);
$('#mask').addEventListener('click', closeDrawer);

$$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

['#cfgTemp', '#cfgTopP', '#cfgPres', '#cfgFreq'].forEach((s) => $(s).addEventListener('input', syncSliderLabels));

$('#saveSettings').addEventListener('click', () => saveSettings().catch((e) => toast(e.message)));
$('#saveCard').addEventListener('click', () => saveCard().catch((e) => toast(e.message)));
$('#deleteCard').addEventListener('click', () => deleteCard().catch((e) => toast(e.message)));
$('#exportCard').addEventListener('click', () => { if (S.card) window.open('/api/cards/' + S.card.id + '/export', '_blank'); });

$('#wSelect').addEventListener('change', (e) => openWorld(e.target.value).catch((err) => toast(err.message)));
$('#wSave').addEventListener('click', () => saveWorld().catch((e) => toast(e.message)));
$('#wNew').addEventListener('click', async () => {
  const r = await api('/api/worlds', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '新世界书', entries: { '0': { uid: 0, key: [], comment: '新条目', content: '', constant: false, disable: false, order: 100 } } }),
  });
  S.worlds = (await api('/api/worlds')).worlds || [];
  await loadWorlds();
  await openWorld(r.world.id);
});
$('#wDel').addEventListener('click', async () => {
  if (!S.world || !confirm('删除世界书「' + S.world.name + '」？')) return;
  await api('/api/worlds/' + S.world.id, { method: 'DELETE' });
  S.world = null; S.worldId = null;
  S.worlds = (await api('/api/worlds')).worlds || [];
  await loadWorlds();
  renderEntries();
  toast('已删除');
});
$('#wAdd').addEventListener('click', () => {
  if (!S.world) { toast('先选择或新建世界书'); return; }
  const n = Object.keys(S.world.entries).length;
  S.world.entries[String(n)] = { uid: n, key: [], comment: '', content: '', constant: false, disable: false, order: 100 };
  renderEntries();
});
$('#wImport').addEventListener('click', () => $('#fileWorld').click());

$('#rxAdd').addEventListener('click', () => {
  S.regex.push({ name: '', find: '', replace: '', enabled: true, when: ['output'] });
  renderRegex();
});
$('#rxSave').addEventListener('click', () => saveRegex().catch((e) => toast(e.message)));
$('#rxReload').addEventListener('click', () => loadRegex().catch((e) => toast(e.message)));
$('#rxRunInput').addEventListener('click', () => rxTest('input').catch((e) => toast(e.message)));
$('#rxRunOutput').addEventListener('click', () => rxTest('output').catch((e) => toast(e.message)));

$('#exportPng').addEventListener('click', () => {
  if (!S.card) { toast('先选择一个角色'); return; }
  const n = S.chat ? S.chat.messages.length : 0;
  let withChat = false;
  if (n > 0) {
    withChat = confirm(
      `导出「${S.card.name}」的角色卡 PNG\n\n` +
      `【确定】把当前对话（${n} 条）一起封进图片 —— 文件名会标注「含对话」，接收方可读取\n` +
      `【取消】只导出角色信息`
    );
  }
  const q = withChat ? `?chatId=${S.chat.id}&withChat=1` : '';
  window.open('/api/cards/' + S.card.id + '/export-png' + q, '_blank');
});

$('#expTxt').addEventListener('click', () => exportChat('txt'));
$('#expMd').addEventListener('click', () => exportChat('md'));
$('#expJsonl').addEventListener('click', () => exportChat('jsonl'));
$('#memSave').addEventListener('click', () => memoryAction('set'));
$('#memAppend').addEventListener('click', () => memoryAction('append'));
$('#memRebuild').addEventListener('click', () => memoryAction('rebuild'));
$('#memClear').addEventListener('click', () => memoryAction('clear'));

$('#previewPrompt').addEventListener('click', async () => {
  if (!S.chat) { toast('先选择一个角色并开始对话'); return; }
  try {
    const r = await api('/api/prompt?chatId=' + S.chat.id);
    const out = $('#promptOut');
    const worldLine = r.worldHits && r.worldHits.length ? '触发的世界书条目：' + r.worldHits.join(' / ') : '未触发世界书条目';
    out.textContent =
      `消息数 ${r.totalMessages} · system ${r.systemLength} 字\n${worldLine}\n\n` +
      r.messages.map((m, i) => `── [${i}] ${m.role} ──\n${m.content}`).join('\n\n');
    out.hidden = false;
  } catch (e) { toast(e.message); }
});

/* ============================== 启动 ============================== */
(async function boot() {
  await loadSettings();
  await loadWorlds();
  await loadFolders();
  S.cards = (await api('/api/cards')).cards || [];
  renderCards();
  await loadGroups();
  renderMessages();
  if (S.cards.length) await selectCard(S.cards[0].id).catch(() => {});
  else { fillCardForm(); renderTop(); }
  $('#stHint').textContent = '兼容 SillyTavern：PNG 卡（内嵌 chara/ccv3）与 V2/V3 JSON、世界书 entries 格式。';
})();
