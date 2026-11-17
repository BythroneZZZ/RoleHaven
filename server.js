'use strict';
/**
 * RoleHaven · 本地角色扮演前端
 * 无工具、无联网、无 Agent 能力 —— 只做角色、世界、对话与记忆。
 *
 * 组件：
 *   1. 角色卡    —— 兼容 Character Card V2/V3，支持 PNG(tEXt chara/ccv3) 与 JSON 导入
 *   2. 世界书    —— 兼容 ST 的 entries 结构，关键词/常驻触发
 *   3. 对话流    —— swipe 多候选、编辑、删除、回退、重新生成
 *   4. 群聊      —— 多角色轮询/随机/手动发言
 *   5. 设定/参数 —— 人设、系统提示词、采样参数
 */
const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const {
  now, sid, safeId, readJson, writeJsonAtomic,
  sendJson, readBody, sseHead, sseSend, msgText,
} = require('./lib/util');
const {
  readPngCard, embedCardIntoPng, makePlaceholderPng, cardToV2, cardToV3,
} = require('./lib/png');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
// 数据目录可用环境变量重定向，便于测试跑在隔离沙箱里，不碰用户真实数据
const DATA_DIR = process.env.ROLEHAVEN_DATA_DIR
  ? path.resolve(process.env.ROLEHAVEN_DATA_DIR)
  : path.join(ROOT, 'data');
const CARDS_DIR = path.join(DATA_DIR, 'cards');
const WORLDS_DIR = path.join(DATA_DIR, 'worlds');
const CHATS_DIR = path.join(DATA_DIR, 'chats');
const GROUPS_DIR = path.join(DATA_DIR, 'groups');
const CFG_PATH = path.join(ROOT, 'config.json');
const VER_PATH = path.join(ROOT, 'VERSION');
const REGEX_PATH = path.join(DATA_DIR, 'regex.json');
const FOLDERS_PATH = path.join(DATA_DIR, 'folders.json');

const APP_NAME = 'RoleHaven';
const APP_VERSION = (() => {
  try { return fs.readFileSync(VER_PATH, 'utf8').trim(); } catch (_) { return '0.0.0'; }
})();

for (const d of [CARDS_DIR, WORLDS_DIR, CHATS_DIR, GROUPS_DIR]) fs.mkdirSync(d, { recursive: true });

const DEFAULTS = {
  port: 8787,
  apiKey: '',
  baseURL: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  user_name: '你',
  system_prompt:
    '你正在扮演 {{char}}，与 {{user}} 进行沉浸式角色扮演对话。\n' +
    '- 始终以 {{char}} 的身份、口吻、性格与知识边界回应，绝不跳出角色，不提"AI""模型""提示词"。\n' +
    '- 用 *斜体* 描写动作、神态、环境，用 "引号" 包裹台词。\n' +
    '- 不要替 {{user}} 说话、行动或决定心理活动，把主动权留给 {{user}}。\n' +
    '- 每次回复聚焦一个场景推进，篇幅自然，避免空泛总结。',
  temperature: 1.0,
  top_p: 0.95,
  presence_penalty: 0.3,
  frequency_penalty: 0.3,
  max_tokens: 1024,
  context_messages: 20,
  stream: true,
  world_enabled: true,
  world_scan_depth: 4,
  memory_enabled: true,
  memory_min_batch: 6,
  memory_max_chars: 600,
  request_timeout_ms: 180000,
  first_byte_timeout_ms: 45000,
  idle_timeout_ms: 90000,
  max_swipes: 20,
};

function loadConfig() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')) || {}; } catch (_) { raw = {}; }

  const merged = { ...DEFAULTS, ...raw };
  const out = {};
  for (const k of Object.keys(DEFAULTS)) out[k] = merged[k];

  // 自动清理前身版本遗留的字段（如 allowShell / maxTurns），避免误导
  const stale = Object.keys(raw).filter((k) => !(k in DEFAULTS));
  if (stale.length) {
    try {
      fs.writeFileSync(CFG_PATH, JSON.stringify(out, null, 2), 'utf8');
      console.log(`[migrate] 已从 config.json 清理 ${stale.length} 个旧字段：${stale.join(', ')}`);
    } catch (_) {}
  }

  // 端口可被环境变量覆盖（测试用），优先级高于配置文件
  if (process.env.PORT) {
    const p = Number(process.env.PORT);
    if (Number.isFinite(p) && p > 0) out.port = p;
  }
  return out;
}
let CFG = loadConfig();
function saveConfig(next) {
  CFG = { ...CFG, ...next };
  fs.writeFileSync(CFG_PATH, JSON.stringify(CFG, null, 2), 'utf8');
  return CFG;
}

/* =============================== 基础工具（实现见 lib/util.js） =============================== */
/** 同一对话同时只允许一轮生成，避免两个窗口互相覆盖 */
const activeChats = new Set();

/* =============================== 角色卡 =============================== */
function normalizeCard(raw, id) {
  if (!raw) return null;
  const d = raw.data && typeof raw.data === 'object' ? raw.data : raw;
  const arr = (v) => (Array.isArray(v) ? v.map(String) : []);
  return {
    id: id || sid(),
    name: String(d.name || raw.name || '未命名角色').trim().slice(0, 80),
    description: String(d.description || ''),
    personality: String(d.personality || ''),
    scenario: String(d.scenario || ''),
    first_mes: String(d.first_mes || ''),
    mes_example: String(d.mes_example || ''),
    system_prompt: String(d.system_prompt || ''),
    post_history_instructions: String(d.post_history_instructions || ''),
    alternate_greetings: arr(d.alternate_greetings),
    tags: arr(d.tags),
    creator: String(d.creator || ''),
    character_version: String(d.character_version || ''),
    creator_notes: String(d.creator_notes || ''),
    worldId: '',
    hasAvatar: false,
    createdAt: now(),
    updatedAt: now(),
  };
}

function cardFile(id) { return path.join(CARDS_DIR, safeId(id) + '.json'); }
function cardAvatar(id) { return path.join(CARDS_DIR, safeId(id) + '.png'); }

function listCards() {
  const out = [];
  for (const f of fs.readdirSync(CARDS_DIR)) {
    if (!f.endsWith('.json')) continue;
    const c = readJson(path.join(CARDS_DIR, f), null);
    if (!c) continue;
    out.push({
      id: c.id, name: c.name, tags: c.tags || [], creator: c.creator || '',
      hasAvatar: !!c.hasAvatar, updatedAt: c.updatedAt || 0,
      desc: String(c.description || '').replace(/\s+/g, ' ').slice(0, 90),
    });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/* =============================== 世界书 =============================== */
function normalizeWorld(raw, id) {
  let entries = raw && raw.entries;
  if (Array.isArray(entries)) {
    const obj = {};
    entries.forEach((e, i) => { obj[String(e.uid != null ? e.uid : i)] = e; });
    entries = obj;
  }
  if (!entries || typeof entries !== 'object') entries = {};
  const norm = {};
  let i = 0;
  for (const k of Object.keys(entries)) {
    const e = entries[k] || {};
    // 兼容两套字段：World Info 的 key/order/disable ↔ Character Book V3 的 keys/insertion_order/enabled
    const keySrc = Array.isArray(e.key) ? e.key
      : Array.isArray(e.keys) ? e.keys
      : (e.key != null ? String(e.key).split(',') : (e.keys != null ? String(e.keys).split(',') : []));
    const secondSrc = Array.isArray(e.keysecondary) ? e.keysecondary
      : Array.isArray(e.secondary_keys) ? e.secondary_keys : [];
    const ord = e.order != null ? Number(e.order)
      : (e.insertion_order != null ? Number(e.insertion_order) : 100);
    norm[String(i)] = {
      uid: i,
      key: keySrc.map(String).map((x) => x.trim()).filter(Boolean),
      keysecondary: secondSrc.map(String).map((x) => x.trim()).filter(Boolean),
      comment: String(e.comment || e.name || ''),
      content: String(e.content || ''),
      constant: !!e.constant,
      selective: e.selective !== false,
      order: Number.isFinite(ord) ? ord : 100,
      disable: e.disable != null ? !!e.disable : e.enabled === false,
      probability: e.probability == null ? 100 : Number(e.probability),
      depth: e.depth == null ? 4 : Number(e.depth),
      caseSensitive: e.caseSensitive != null ? !!e.caseSensitive
        : (e.case_sensitive != null ? !!e.case_sensitive : null),
    };
    i++;
  }
  return {
    id: id || sid(),
    name: String((raw && (raw.name || raw.comment)) || '未命名世界书').slice(0, 80),
    entries: norm,
    createdAt: now(),
    updatedAt: now(),
  };
}

function worldFile(id) { return path.join(WORLDS_DIR, safeId(id) + '.json'); }

function listWorlds() {
  const out = [];
  for (const f of fs.readdirSync(WORLDS_DIR)) {
    if (!f.endsWith('.json')) continue;
    const w = readJson(path.join(WORLDS_DIR, f), null);
    if (!w) continue;
    out.push({ id: w.id, name: w.name, count: Object.keys(w.entries || {}).length, updatedAt: w.updatedAt || 0 });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 关键词触发，返回要注入的文本（按 order 排序拼接） */
function triggerWorld(world, scanText) {
  if (!world || !world.entries) return '';
  const raw = String(scanText || '');
  const lower = raw.toLowerCase();
  const hits = [];
  for (const e of Object.values(world.entries)) {
    if (e.disable || !e.content) continue;
    if (e.constant) { hits.push(e); continue; }
    const keys = (e.key || []).filter(Boolean);
    if (!keys.length) continue;
    const hay = e.caseSensitive ? raw : lower;
    const matched = keys.some((k) => {
      const needle = e.caseSensitive ? String(k) : String(k).toLowerCase();
      return needle && hay.includes(needle);
    });
    if (matched) hits.push(e);
  }
  hits.sort((a, b) => (a.order || 100) - (b.order || 100));
  return hits.map((e) => e.content).join('\n\n');
}

/* =============================== 群聊 =============================== */
function groupFile(id) { return path.join(GROUPS_DIR, safeId(id) + '.json'); }

function normalizeGroup(raw, id) {
  const members = Array.isArray(raw && raw.members) ? raw.members.filter((x) => typeof x === 'string') : [];
  return {
    id: id || sid(),
    name: String((raw && raw.name) || '未命名群组').slice(0, 60),
    members,
    mode: (raw && raw.mode) === 'random' ? 'random' : 'round_robin',
    worldId: String((raw && raw.worldId) || ''),
    createdAt: now(),
    updatedAt: now(),
  };
}

function readGroup(id) { return readJson(groupFile(id), null); }

function listGroups() {
  const out = [];
  for (const f of fs.readdirSync(GROUPS_DIR)) {
    if (!f.endsWith('.json')) continue;
    const g = readJson(path.join(GROUPS_DIR, f), null);
    if (!g) continue;
    out.push({ id: g.id, name: g.name, members: g.members || [], mode: g.mode || 'round_robin', updatedAt: g.updatedAt || 0 });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 载入群组成员卡，过滤掉已删除的卡 */
function loadMembers(group) {
  const out = [];
  for (const id of group.members || []) {
    const c = readJson(cardFile(id), null);
    if (c) out.push(c);
  }
  return out;
}

/** 选下一位发言者：手动指定 > 随机 > 轮询 */
function pickSpeaker(chat, group, cards) {
  if (!cards.length) return null;
  const explicit = chat.nextSpeakerId;
  if (explicit) {
    const hit = cards.find((c) => c.id === explicit);
    chat.nextSpeakerId = '';
    if (hit) return hit;
  }
  if (group.mode === 'random') return cards[Math.floor(Math.random() * cards.length)];
  const i = Math.max(0, Number(chat.turnIndex) || 0) % cards.length;
  return cards[i];
}

/* =============================== 正则替换 =============================== */
function loadRegexScripts() {
  const j = readJson(REGEX_PATH, null);
  return j && Array.isArray(j.scripts) ? j.scripts : [];
}

function saveRegexScripts(scripts) {
  const clean = (Array.isArray(scripts) ? scripts : []).slice(0, 200).map((r, i) => ({
    id: String(r.id || ('rx_' + i)),
    name: String(r.name || '').slice(0, 80),
    find: String(r.find || ''),
    replace: String(r.replace == null ? '' : r.replace),
    when: Array.isArray(r.when) ? r.when.filter((w) => w === 'input' || w === 'output') : ['output'],
    enabled: r.enabled !== false,
  })).filter((r) => r.find.trim());
  fs.writeFileSync(REGEX_PATH, JSON.stringify({ scripts: clean }, null, 2), 'utf8');
  return clean;
}

function parseRegex(src) {
  const s = String(src || '').trim();
  const m = s.match(/^\/([\s\S]*)\/([gimsuy]*)$/);
  if (m && /^[gimsuy]*$/.test(m[2])) {
    const flags = m[2].includes('g') ? m[2] : m[2] + 'g';
    return new RegExp(m[1], flags);
  }
  return new RegExp(s, 'g');
}

/** when: 'input' | 'output' */
function applyRegex(text, when) {
  let out = String(text == null ? '' : text);
  for (const r of loadRegexScripts()) {
    if (!r.enabled) continue;
    if (!Array.isArray(r.when) || !r.when.includes(when)) continue;
    try {
      const re = parseRegex(r.find);
      const rep = String(r.replace || '').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
      out = out.replace(re, rep);
    } catch (_) { /* 单条规则写错不影响其他规则 */ }
  }
  return out;
}

/* =============================== 对话分组 =============================== */
function loadFolders() {
  const j = readJson(FOLDERS_PATH, null);
  return j && Array.isArray(j.folders) ? j.folders : [];
}

function saveFolders(folders) {
  const clean = (Array.isArray(folders) ? folders : []).slice(0, 100).map((f, i) => ({
    id: String(f.id || ('fd_' + i)),
    name: String(f.name || '未命名分组').slice(0, 40),
    createdAt: f.createdAt || now(),
  }));
  fs.writeFileSync(FOLDERS_PATH, JSON.stringify({ folders: clean }, null, 2), 'utf8');
  return clean;
}

/* =============================== 对话 =============================== */
function chatFile(id) { return path.join(CHATS_DIR, safeId(id) + '.json'); }

function listChats(cardId, groupId) {
  const out = [];
  for (const f of fs.readdirSync(CHATS_DIR)) {
    if (!f.endsWith('.json')) continue;
    const c = readJson(path.join(CHATS_DIR, f), null);
    if (!c) continue;
    if (cardId && c.cardId !== cardId) continue;
    if (groupId && c.groupId !== groupId) continue;
    out.push({
      id: c.id,
      cardId: c.cardId,
      groupId: c.groupId || '',
      title: c.title || '新对话',
      count: (c.messages || []).length,
      pinned: !!c.pinned,
      folderId: c.folderId || '',
      updatedAt: c.updatedAt || 0,
    });
  }
  // 置顶优先，其次按最近更新
  return out.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updatedAt - a.updatedAt);
}

/* msgText 见 lib/util.js */

/* =============================== 提示词构建 =============================== */
/**
 * @param card    当前发言者（单人模式即该角色）
 * @param chat    对话对象
 * @param scanText 世界书扫描文本
 * @param opts    { group, cards, speaker } —— 群聊时传入
 */
function buildMessages(card, chat, scanText, opts = {}) {
  const group = opts.group || null;
  const cards = opts.cards || [];
  const speaker = opts.speaker || card;
  const U = CFG.user_name || '你';
  const C = speaker.name;
  const rep = (s) => String(s || '')
    .replace(/\{\{char\}\}/gi, C)
    .replace(/\{\{user\}\}/gi, U);

  const sys = [];
  const base = speaker.system_prompt && speaker.system_prompt.trim() ? speaker.system_prompt : CFG.system_prompt;
  if (base) sys.push(rep(base));

  if (group) {
    const others = cards.filter((c) => c.id !== speaker.id).map((c) => c.name);
    sys.push(
      `## 群聊场景\n` +
      `你正在一场多角色群聊中，**只扮演「${C}」**。用户是「${U}」。\n` +
      `在场其他角色：${others.length ? others.join('、') : '（无）'}。\n` +
      `规则：\n` +
      `- 只输出「${C}」的动作与台词，不要代替其他角色发言、行动或决定他们的想法。\n` +
      `- 不要在回复开头加「${C}：」这类名字前缀，直接写内容。\n` +
      `- 称呼与关系要符合「${C}」的设定，也不要复述别人刚说过的话。\n` +
      `- 若剧情需要其他人回应，把机会留给下一轮。`
    );

    const spDef = [];
    if (speaker.description) spDef.push(rep(speaker.description));
    if (speaker.personality) spDef.push('性格：' + rep(speaker.personality));
    if (speaker.scenario) spDef.push('场景：' + rep(speaker.scenario));
    if (spDef.length) sys.push(`## 当前发言者：${C}\n` + spDef.join('\n\n'));

    const brief = cards.filter((c) => c.id !== speaker.id).map((c) => {
      const d = String(c.description || '').replace(/\s+/g, ' ').slice(0, 360);
      return `- ${c.name}：${d || '（无描述）'}`;
    });
    if (brief.length) sys.push('## 其他角色简介（仅用于知道他们是谁）\n' + brief.join('\n'));
  } else {
    const def = [];
    if (speaker.description) def.push(rep(speaker.description));
    if (speaker.personality) def.push('性格：' + rep(speaker.personality));
    if (speaker.scenario) def.push('场景：' + rep(speaker.scenario));
    if (def.length) sys.push(`## 角色：${C}\n` + def.join('\n\n'));
  }

  const worldId = (group && group.worldId) || speaker.worldId;
  if (CFG.world_enabled && worldId) {
    const w = readJson(worldFile(worldId), null);
    const wi = triggerWorld(w, scanText);
    if (wi) sys.push('## 世界设定\n' + rep(wi));
  }

  if (speaker.mes_example) sys.push('## 对话示例（仅用于把握口吻，不要复述）\n' + rep(speaker.mes_example));
  if (speaker.post_history_instructions) sys.push(rep(speaker.post_history_instructions));

  // 长上下文记忆：早期剧情的压缩提要
  const mem = chat.memory || {};
  if (CFG.memory_enabled && mem.summary && mem.summary.trim()) {
    sys.push('## 前情提要（更早的剧情已经过压缩，请把它当作已经发生的事实继续演绎）\n' + rep(mem.summary.trim()));
  }

  const messages = [{ role: 'system', content: sys.filter(Boolean).join('\n\n') }];

  // 已被提要覆盖的部分不再重复投喂，只保留最近 N 条原文
  const all = chat.messages || [];
  const ctx = Math.max(2, Number(CFG.context_messages) || 20);
  const covered = CFG.memory_enabled ? Math.min(Number(mem.summarized) || 0, all.length) : 0;
  const start = Math.max(covered, all.length - ctx);
  for (const m of all.slice(start)) {
    const t = msgText(m);
    if (!t) continue;
    if (group) {
      const who = m.role === 'assistant' ? (m.speakerName || '角色') : U;
      messages.push({ role: m.role, content: `${who}：${t}` });
    } else {
      messages.push({ role: m.role, content: t });
    }
  }
  return messages;
}

/* =============================== 生成 =============================== */
/**
 * 流式生成。
 * 超时策略改为「首字节 + 空闲」双计时：长回复只要还在持续出词就不会被总时长误杀，
 * 上游真的挂起时也能及时中止。
 * handlers: { onDelta(text), onThinking(text) }
 */
async function streamCompletion(messages, handlers, external) {
  const onDelta = (handlers && handlers.onDelta) || (() => {});
  const onThinking = (handlers && handlers.onThinking) || (() => {});
  const base = String(CFG.baseURL || DEFAULTS.baseURL).replace(/\/+$/, '');
  const body = {
    model: CFG.model,
    messages,
    stream: true,
    max_tokens: Number(CFG.max_tokens) || 1024,
    temperature: Number(CFG.temperature),
    top_p: Number(CFG.top_p),
    presence_penalty: Number(CFG.presence_penalty),
    frequency_penalty: Number(CFG.frequency_penalty),
  };

  const firstByteMs = Math.max(5000, Number(CFG.first_byte_timeout_ms) || 45000);
  const idleMs = Math.max(10000, Number(CFG.idle_timeout_ms) || 90000);

  const ac = new AbortController();
  let timer = null;
  let timeoutKind = 0; // 1 = 首字节超时，2 = 空闲超时
  const arm = (ms, kind) => {
    clearTimeout(timer);
    timer = setTimeout(() => { timeoutKind = kind; try { ac.abort(); } catch (_) {} }, ms);
  };
  const onExternalAbort = () => { try { ac.abort(); } catch (_) {} };
  if (external) external.addEventListener('abort', onExternalAbort, { once: true });
  arm(firstByteMs, 1);

  try {
    const r = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + CFG.apiKey },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error(`上游 HTTP ${r.status}：${t.slice(0, 500)}`);
    }

    const dec = new TextDecoder();
    let buf = '';
    let out = '';
    let reasoning = '';
    for await (const chunk of r.body) {
      arm(idleMs, 2); // 只要还在出数据就重置空闲计时
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const d = line.slice(5).trim();
        if (d === '[DONE]') continue;
        let j;
        try { j = JSON.parse(d); } catch (_) { continue; }
        const ch = j.choices && j.choices[0];
        if (!ch || !ch.delta) continue;
        // deepseek-reasoner 的思考过程单独回传，不能丢
        if (ch.delta.reasoning_content) {
          reasoning += ch.delta.reasoning_content;
          onThinking(ch.delta.reasoning_content);
        }
        if (ch.delta.content) {
          out += ch.delta.content;
          onDelta(ch.delta.content);
        }
      }
    }
    return { text: out, reasoning };
  } catch (e) {
    if (timeoutKind === 1) throw new Error(`上游 ${Math.round(firstByteMs / 1000)} 秒内没有返回任何数据（首字节超时）`);
    if (timeoutKind === 2) throw new Error(`上游超过 ${Math.round(idleMs / 1000)} 秒没有继续输出（空闲超时）`);
    throw e;
  } finally {
    clearTimeout(timer);
    if (external) external.removeEventListener('abort', onExternalAbort);
  }
}

/* ---- 非流式调用（摘要用） ---- */
async function nonStreamCompletion(messages, maxTokens, signal) {
  const base = String(CFG.baseURL || DEFAULTS.baseURL).replace(/\/+$/, '');
  const r = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + CFG.apiKey },
    body: JSON.stringify({
      model: CFG.model,
      messages,
      stream: false,
      max_tokens: maxTokens,
      temperature: 0.35,
      top_p: 0.9,
      presence_penalty: 0,
      frequency_penalty: 0,
    }),
    signal: requestSignal(signal),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`摘要请求失败 HTTP ${r.status}：${t.slice(0, 300)}`);
  }
  const j = await r.json();
  const c = j.choices && j.choices[0];
  return (c && c.message && c.message.content) || '';
}

/* =============================== 长上下文记忆 =============================== */
/** 摘要游标：已覆盖到哪、这次可以摘要到哪 */
function memoryWindow(chat) {
  const all = chat.messages || [];
  const covered = Math.min(Math.max(0, Number(chat.memory && chat.memory.summarized) || 0), all.length);
  const ctx = Math.max(2, Number(CFG.context_messages) || 20);
  const keep = Math.max(2, Math.floor(ctx / 4));
  const upto = Math.max(covered, all.length - keep);
  return { covered, upto, pending: upto - covered, keep };
}

async function summarizeMemory(chat, card, signal) {
  const all = chat.messages || [];
  const { covered, upto } = memoryWindow(chat);
  if (upto <= covered) return null;

  const U = CFG.user_name || '你';
  const batch = all.slice(covered, upto)
    .map((m) => `${m.role === 'assistant' ? (m.speakerName || card.name) : U}: ${msgText(m)}`)
    .join('\n\n');
  const existing = (chat.memory && chat.memory.summary) || '';

  const prompt = `你是剧情记录员，负责为一段角色扮演对话维护"前情提要"，供后续续写时参考。

任务：把【已有提要】与【新增对话】合并，输出一份更新后的提要。

要求：
1. 保留必要事实：人物与关系的变化、已发生的关键事件、承诺与约定、获得或失去的物品、抵达的地点、未解决的悬念与冲突。
2. 保留 ${card.name} 对 ${U} 的态度、称呼与情感走向的变化。
3. 用第三人称陈述，按时间顺序，语言简洁；不评价、不编造、不抄录大段原文对白。
4. 全文不超过 ${CFG.memory_max_chars} 字，用短段落或要点罗列。
5. 只输出提要正文，不要前言、标题或解释。

【已有提要】
${existing || '（暂无）'}

【新增对话】
${batch}`;

  const out = await nonStreamCompletion(
    [{ role: 'system', content: '你是一名严谨的剧情记录员。' }, { role: 'user', content: prompt }],
    Math.min(1600, Math.max(320, Number(CFG.memory_max_chars) * 3)),
    signal
  );
  const summary = String(out || '').trim();
  if (!summary) return null;
  chat.memory = { summary, summarized: upto, updatedAt: now() };
  chat.updatedAt = now();
  await writeJsonAtomic(chatFile(chat.id), chat).catch(() => {});
  return { summary, from: covered, to: upto, batch: upto - covered, summarized: upto };
}

/** 生成前按需整理记忆；失败不影响正常出词 */
async function ensureMemory(chat, card, emit, signal) {
  if (!CFG.memory_enabled || !CFG.apiKey) return false;
  const { pending } = memoryWindow(chat);
  const minBatch = Math.max(2, Number(CFG.memory_min_batch) || 6);
  if (pending < minBatch) return false;
  emit({ type: 'memory', status: 'start', pending });
  try {
    const r = await summarizeMemory(chat, card, signal);
    if (r) { emit({ type: 'memory', status: 'done', ...r }); return true; }
    emit({ type: 'memory', status: 'skip' });
  } catch (e) {
    emit({ type: 'memory', status: 'error', message: e.message || String(e) });
  }
  return false;
}

async function handleGenerate(req, res) {
  const b = await readBody(req);
  const regenerate = !!b.regenerate;
  // 用户输入先过正则（input 时机）
  const text = applyRegex(String(b.text || '').trim(), 'input');

  let chat = b.chatId ? readJson(chatFile(b.chatId), null) : null;
  if (!chat) {
    if (b.groupId) {
      const g = readGroup(b.groupId);
      if (!g) return sendJson(res, 404, { error: '群组不存在' });
      chat = { id: sid(), groupId: g.id, cardId: '', title: g.name, turnIndex: 0, createdAt: now(), updatedAt: now(), messages: [] };
    } else {
      const card = readJson(cardFile(b.cardId), null);
      if (!card) return sendJson(res, 404, { error: '角色卡不存在' });
      chat = { id: sid(), cardId: card.id, title: card.name, createdAt: now(), updatedAt: now(), messages: [] };
      if (card.first_mes) {
        chat.messages.push({ role: 'assistant', swipes: [card.first_mes], swipeId: 0, content: card.first_mes, time: now(), speakerId: card.id, speakerName: card.name });
      }
    }
  }

  // 解析上下文：群聊 or 单人
  let group = null;
  let members = [];
  let card = null;
  if (chat.groupId) {
    group = readGroup(chat.groupId);
    if (!group) return sendJson(res, 404, { error: '群组已删除' });
    members = loadMembers(group);
    if (!members.length) return sendJson(res, 400, { error: '群组内没有可用角色卡' });
  } else {
    card = chat.cardId ? readJson(cardFile(chat.cardId), null) : null;
    if (!card) return sendJson(res, 404, { error: '角色卡已丢失' });
  }

  if (b.speakerId) chat.nextSpeakerId = String(b.speakerId);

  // 选这一轮由谁说
  let speaker;
  if (regenerate) {
    const last = chat.messages[chat.messages.length - 1];
    speaker = (group && last && members.find((c) => c.id === last.speakerId)) || (group ? members[0] : card);
  } else if (group) {
    speaker = pickSpeaker(chat, group, members);
  } else {
    speaker = card;
  }
  if (!speaker) return sendJson(res, 400, { error: '没有可发言的角色' });
  const opts = group ? { group, cards: members, speaker } : {};

  sseHead(res);
  const ac = new AbortController();
  req.on('close', () => { try { ac.abort(); } catch (_) {} });
  const emit = (o) => sseSend(res, o);
  emit({ type: 'chat', id: chat.id, groupId: chat.groupId || '', speaker: { id: speaker.id, name: speaker.name } });

  // 同一对话互斥：两个窗口同时生成会互相覆盖
  if (activeChats.has(chat.id)) {
    emit({ type: 'error', message: '这个对话正在生成中，请等本轮结束后再发。' });
    emit({ type: 'done', chatId: chat.id, message: null });
    return res.end();
  }
  activeChats.add(chat.id);
  const release = () => activeChats.delete(chat.id);
  res.on('finish', release);
  res.on('close', release);

  // 先落地用户发言，避免无 Key / 报错时输入丢失
  if (!regenerate && text) chat.messages.push({ role: 'user', content: text, time: now() });

  if (!CFG.apiKey || !CFG.apiKey.trim()) {
    emit({ type: 'error', message: '尚未配置 API Key，请在「参数」中填写 DeepSeek API Key。' });
    await writeJsonAtomic(chatFile(chat.id), chat).catch(() => {});
    emit({ type: 'done', chatId: chat.id, message: null });
    return res.end();
  }

  try {
    // 出词前先整理长上下文记忆（超阈值才触发）
    await ensureMemory(chat, speaker, emit, ac.signal);

    if (regenerate) {
      const last = chat.messages[chat.messages.length - 1];
      if (!last || last.role !== 'assistant') throw new Error('最后一条不是角色发言，无法重新生成');
      const draft = chat.messages.slice(0, -1);
      const scan = draft.slice(-CFG.world_scan_depth).map(msgText).join('\n');
      const msgs = buildMessages(speaker, { messages: draft, memory: chat.memory }, scan, opts);

      emit({ type: 'start' });
      const streamed = await streamCompletion(msgs, {
        onDelta: (d) => emit({ type: 'delta', text: d }),
        onThinking: (t) => emit({ type: 'thinking', text: t }),
      }, ac.signal);
      const raw = streamed.text || '';
      if (!raw.trim()) throw new Error('模型返回空内容');
      const out = applyRegex(raw, 'output');
      last.reasoning = streamed.reasoning || '';
      last.swipes = Array.isArray(last.swipes) ? last.swipes : [last.content || ''];
      last.swipes.push(out);
      last.swipeId = last.swipes.length - 1;
      // 候选上限：只留最近 N 个，避免文件无限膨胀
      const maxSw = Math.max(2, Number(CFG.max_swipes) || 20);
      if (last.swipes.length > maxSw) {
        const drop = last.swipes.length - maxSw;
        last.swipes.splice(0, drop);
        last.swipeId = Math.max(0, last.swipeId - drop);
      }
      last.content = out;
      chat.updatedAt = now();
      await writeJsonAtomic(chatFile(chat.id), chat);
      emit({ type: 'done', chatId: chat.id, message: { swipes: last.swipes.length, swipeId: last.swipeId } });
      return res.end();
    }

    if (!chat.messages.length) throw new Error('还没有任何消息');

    const scan = chat.messages.slice(-CFG.world_scan_depth).map(msgText).join('\n');
    const msgs = buildMessages(speaker, chat, scan, opts);

    emit({ type: 'start' });
    const streamed = await streamCompletion(msgs, {
      onDelta: (d) => emit({ type: 'delta', text: d }),
      onThinking: (t) => emit({ type: 'thinking', text: t }),
    }, ac.signal);
    const raw = streamed.text || '';
    if (!raw.trim()) throw new Error('模型返回空内容');
    const out = applyRegex(raw, 'output');

    chat.messages.push({
      role: 'assistant', swipes: [out], swipeId: 0, content: out, time: now(),
      reasoning: streamed.reasoning || '',
      speakerId: speaker.id, speakerName: speaker.name,
    });
    chat.updatedAt = now();
    if (group) {
      const idx = members.findIndex((c) => c.id === speaker.id);
      chat.turnIndex = (idx + 1) % members.length;
    }
    const fallbackTitle = group ? group.name : speaker.name;
    if (!chat.title || chat.title === fallbackTitle) {
      const first = chat.messages.find((m) => m.role === 'user');
      if (first) chat.title = String(first.content).replace(/\s+/g, ' ').slice(0, 24);
    }
    await writeJsonAtomic(chatFile(chat.id), chat);
    emit({ type: 'done', chatId: chat.id, message: { swipes: 1, swipeId: 0 } });
    res.end();
  } catch (e) {
    const msg = e.name === 'AbortError'
      ? '已停止生成。'
      : e.name === 'TimeoutError'
        ? `上游响应超时（${Math.round((Number(CFG.request_timeout_ms) || 180000) / 1000)} 秒），已中止。`
        : (e.message || String(e));
    emit({ type: 'error', message: msg });
    await writeJsonAtomic(chatFile(chat.id), chat).catch(() => {});
    emit({ type: 'done', chatId: chat.id, message: null });
    try { res.end(); } catch (_) {}
  }
}

/* =============================== 路由 =============================== */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(url.pathname);
  const m = req.method;

  // Host 白名单：本地服务只接受本机来源，挡掉 DNS rebinding 一类读取
  const hostName = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
  if (hostName && !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostName)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden: unexpected Host header');
  }

  try {
    /* ---- 版本 ---- */
    if (p === '/api/version' && m === 'GET') {
      return sendJson(res, 200, { name: APP_NAME, version: APP_VERSION });
    }

    /* ---- 正则替换 ---- */
    if (p === '/api/regex' && m === 'GET') {
      return sendJson(res, 200, { scripts: loadRegexScripts() });
    }
    if (p === '/api/regex' && m === 'POST') {
      const b = await readBody(req);
      return sendJson(res, 200, { ok: true, scripts: saveRegexScripts(b.scripts) });
    }
    if (p === '/api/regex/test' && m === 'POST') {
      const b = await readBody(req);
      const when = b.when === 'input' ? 'input' : 'output';
      const raw = String(b.text || '');
      const result = applyRegex(raw, when);
      return sendJson(res, 200, { ok: true, when, result, changed: result !== raw });
    }

    /* ---- 设置 ---- */
    if (p === '/api/settings' && m === 'GET') {
      const { apiKey, ...rest } = CFG;
      return sendJson(res, 200, {
        ...rest, name: APP_NAME, version: APP_VERSION,
        hasKey: !!apiKey, keyMask: apiKey ? apiKey.slice(0, 4) + '****' + apiKey.slice(-4) : '',
      });
    }
    if (p === '/api/settings' && m === 'POST') {
      const b = await readBody(req);
      const next = {};
      for (const k of Object.keys(DEFAULTS)) {
        if (k === 'port' || k === 'apiKey') continue;
        if (k in b) {
          const dv = DEFAULTS[k];
          next[k] = typeof dv === 'number' ? Number(b[k]) : typeof dv === 'boolean' ? !!b[k] : String(b[k]);
        }
      }
      if (typeof b.apiKey === 'string' && b.apiKey.trim()) next.apiKey = b.apiKey.trim();
      if (b.clearKey) next.apiKey = '';
      saveConfig(next);
      return sendJson(res, 200, { ok: true });
    }

    /* ---- 角色卡 ---- */
    if (p === '/api/cards' && m === 'GET') return sendJson(res, 200, { cards: listCards() });

    if (p === '/api/cards' && m === 'POST') {
      const b = await readBody(req);
      const id = b.id ? safeId(b.id) : sid();
      const existing = b.id ? readJson(cardFile(id), null) : null;
      const card = { ...(existing || {}), ...b, id, updatedAt: now(), createdAt: (existing && existing.createdAt) || now() };
      if (!card.name) card.name = '未命名角色';
      await fsp.writeFile(cardFile(id), JSON.stringify(card, null, 2), 'utf8');
      return sendJson(res, 200, { ok: true, card });
    }

    if (p.startsWith('/api/cards/') && p.endsWith('/avatar')) {
      const id = p.slice('/api/cards/'.length, -'/avatar'.length);
      const f = cardAvatar(id);
      if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=60' });
      return fs.createReadStream(f).pipe(res);
    }

    /* ---- 导出 PNG 角色卡（可带走对话） ---- */
    if (p.startsWith('/api/cards/') && p.endsWith('/export-png') && m === 'GET') {
      const id = p.slice('/api/cards/'.length, -'/export-png'.length);
      const card = readJson(cardFile(id), null);
      if (!card) { res.writeHead(404); return res.end('Not Found'); }
      const chatId = url.searchParams.get('chatId') || '';
      const chat = chatId ? readJson(chatFile(chatId), null) : null;
      // 默认「仅角色」；显式 withChat=1 才把对话封进去，并在文件名上标记，避免静默外发
      const withChat = url.searchParams.get('withChat') === '1' && !!chat;

      let png = null;
      if (card.hasAvatar && fs.existsSync(cardAvatar(id))) png = fs.readFileSync(cardAvatar(id));
      if (!png) png = makePlaceholderPng();

      const v2 = cardToV2(card);
      const v3 = cardToV3(card, withChat ? chat : null, APP_VERSION);
      const out = embedCardIntoPng(png, [
        ['chara', Buffer.from(JSON.stringify(v2), 'utf8').toString('base64')],
        ['ccv3', Buffer.from(JSON.stringify(v3), 'utf8').toString('base64')],
      ]);
      const fname = withChat ? `${card.name}-含对话` : card.name;
      res.writeHead(200, {
        'content-type': 'image/png',
        'content-disposition': `attachment; filename="${encodeURIComponent(fname)}.png"`,
        'content-length': out.length,
      });
      return res.end(out);
    }

    if (p.startsWith('/api/cards/') && p.endsWith('/export') && m === 'GET') {
      const id = p.slice('/api/cards/'.length, -'/export'.length);
      const c = readJson(cardFile(id), null);
      if (!c) { res.writeHead(404); return res.end('Not Found'); }
      const v2 = {
        spec: 'chara_card_v2', spec_version: '2.0',
        data: {
          name: c.name, description: c.description, personality: c.personality,
          scenario: c.scenario, first_mes: c.first_mes, mes_example: c.mes_example,
          creator_notes: c.creator_notes, system_prompt: c.system_prompt,
          post_history_instructions: c.post_history_instructions,
          alternate_greetings: c.alternate_greetings, tags: c.tags,
          creator: c.creator, character_version: c.character_version,
        },
      };
      const body = JSON.stringify(v2, null, 2);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="card.json"`,
      });
      return res.end(body);
    }

    if (p.startsWith('/api/cards/') && m === 'GET') {
      const c = readJson(cardFile(p.slice('/api/cards/'.length)), null);
      if (!c) return sendJson(res, 404, { error: '不存在' });
      return sendJson(res, 200, c);
    }

    if (p.startsWith('/api/cards/') && m === 'DELETE') {
      const id = p.slice('/api/cards/'.length);
      await fsp.unlink(cardFile(id)).catch(() => {});
      await fsp.unlink(cardAvatar(id)).catch(() => {});
      for (const c of listChats(id)) await fsp.unlink(chatFile(c.id)).catch(() => {});
      return sendJson(res, 200, { ok: true });
    }

    /* ---- 导入角色卡（PNG / JSON，base64） ---- */
    if (p === '/api/import/card' && m === 'POST') {
      const b = await readBody(req);
      const buf = Buffer.from(String(b.data || ''), 'base64');
      if (!buf.length) return sendJson(res, 400, { error: '空文件' });
      let raw = null;
      const isPng = buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47;
      if (isPng) raw = readPngCard(buf);
      else { try { raw = JSON.parse(buf.toString('utf8')); } catch (_) {} }
      if (!raw) return sendJson(res, 400, { error: '未找到角色卡数据：PNG 需内嵌 chara/ccv3 块，JSON 需为 V2/V3 格式' });
      const card = normalizeCard(raw, sid());
      const cb = (raw.data && raw.data.character_book) || raw.character_book;
      if (cb && cb.entries) {
        const w = normalizeWorld({ name: (cb.name || card.name + ' 世界书'), entries: cb.entries }, sid());
        await fsp.writeFile(worldFile(w.id), JSON.stringify(w, null, 2), 'utf8');
        card.worldId = w.id;
      }
      if (isPng) {
        await fsp.writeFile(cardAvatar(card.id), buf);
        card.hasAvatar = true;
      }
      await fsp.writeFile(cardFile(card.id), JSON.stringify(card, null, 2), 'utf8');
      return sendJson(res, 200, { ok: true, card });
    }

    /* ---- 世界书 ---- */
    if (p === '/api/worlds' && m === 'GET') return sendJson(res, 200, { worlds: listWorlds() });

    if (p === '/api/worlds' && m === 'POST') {
      const b = await readBody(req);
      const id = b.id ? safeId(b.id) : sid();
      const existing = b.id ? readJson(worldFile(id), null) : null;
      const w = { ...(existing || {}), ...b, id, updatedAt: now(), createdAt: (existing && existing.createdAt) || now() };
      if (!w.entries || typeof w.entries !== 'object' || Array.isArray(w.entries)) w.entries = {};
      await fsp.writeFile(worldFile(id), JSON.stringify(w, null, 2), 'utf8');
      return sendJson(res, 200, { ok: true, world: w });
    }

    if (p.startsWith('/api/worlds/') && m === 'GET') {
      const w = readJson(worldFile(p.slice('/api/worlds/'.length)), null);
      if (!w) return sendJson(res, 404, { error: '不存在' });
      return sendJson(res, 200, w);
    }

    if (p.startsWith('/api/worlds/') && m === 'DELETE') {
      await fsp.unlink(worldFile(p.slice('/api/worlds/'.length))).catch(() => {});
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/import/world' && m === 'POST') {
      const b = await readBody(req);
      let raw = null;
      try { raw = JSON.parse(Buffer.from(String(b.data || ''), 'base64').toString('utf8')); }
      catch (_) { raw = b.json || null; }
      if (!raw || !raw.entries) return sendJson(res, 400, { error: '不是有效的世界书 JSON' });
      const w = normalizeWorld(raw, sid());
      if (b.name) w.name = String(b.name);
      await fsp.writeFile(worldFile(w.id), JSON.stringify(w, null, 2), 'utf8');
      return sendJson(res, 200, { ok: true, world: w });
    }

    /* ---- 群组 ---- */
    if (p === '/api/groups' && m === 'GET') return sendJson(res, 200, { groups: listGroups() });

    if (p === '/api/groups' && m === 'POST') {
      const b = await readBody(req);
      const id = b.id ? safeId(b.id) : sid();
      const existing = b.id ? readGroup(id) : null;
      const g = { ...(existing || {}), ...b, id, updatedAt: now(), createdAt: (existing && existing.createdAt) || now() };
      if (!Array.isArray(g.members)) g.members = [];
      g.members = g.members.filter((mid) => typeof mid === 'string' && !!readJson(cardFile(mid), null));
      if (!g.name) g.name = '未命名群组';
      if (g.mode !== 'random') g.mode = 'round_robin';
      if (typeof g.worldId !== 'string') g.worldId = '';
      await fsp.writeFile(groupFile(id), JSON.stringify(g, null, 2), 'utf8');
      return sendJson(res, 200, { ok: true, group: g });
    }

    if (p.startsWith('/api/groups/') && m === 'GET') {
      const g = readGroup(p.slice('/api/groups/'.length));
      if (!g) return sendJson(res, 404, { error: '不存在' });
      const members = loadMembers(g).map((c) => ({ id: c.id, name: c.name, hasAvatar: !!c.hasAvatar }));
      return sendJson(res, 200, { ...g, memberInfo: members });
    }

    if (p.startsWith('/api/groups/') && m === 'DELETE') {
      const id = p.slice('/api/groups/'.length);
      await fsp.unlink(groupFile(id)).catch(() => {});
      for (const c of listChats('')) {
        const cc = readJson(chatFile(c.id), null);
        if (cc && cc.groupId === id) await fsp.unlink(chatFile(c.id)).catch(() => {});
      }
      return sendJson(res, 200, { ok: true });
    }

    /* ---- 对话分组 ---- */
    if (p === '/api/folders' && m === 'GET') return sendJson(res, 200, { folders: loadFolders() });

    if (p === '/api/folders' && m === 'POST') {
      const b = await readBody(req);
      const list = loadFolders();
      const id = b.id ? safeId(b.id) : sid();
      const idx = list.findIndex((x) => x.id === id);
      const item = {
        id,
        name: String(b.name || '新分组').slice(0, 40),
        createdAt: idx >= 0 ? list[idx].createdAt : now(),
      };
      if (idx >= 0) list[idx] = item; else list.push(item);
      return sendJson(res, 200, { ok: true, folder: item, folders: saveFolders(list) });
    }

    if (p.startsWith('/api/folders/') && m === 'DELETE') {
      const id = p.slice('/api/folders/'.length);
      const list = loadFolders().filter((x) => x.id !== id);
      // 该分组下的对话落回「未分组」，不连带删除
      for (const c of listChats('', '')) {
        const file = chatFile(c.id);
        const cc = readJson(file, null);
        if (cc && cc.folderId === id) {
          cc.folderId = '';
          await fsp.writeFile(file, JSON.stringify(cc, null, 2), 'utf8').catch(() => {});
        }
      }
      return sendJson(res, 200, { ok: true, folders: saveFolders(list) });
    }

    /* ---- 对话 ---- */
    if (p === '/api/chats' && m === 'GET') {
      const cardId = url.searchParams.get('cardId') || '';
      const groupId = url.searchParams.get('groupId') || '';
      return sendJson(res, 200, { chats: listChats(cardId, groupId) });
    }

    if (p === '/api/chats' && m === 'POST') {
      const b = await readBody(req);

      if (b.groupId) {
        const g = readGroup(b.groupId);
        if (!g) return sendJson(res, 404, { error: '群组不存在' });
        const members = loadMembers(g);
        if (!members.length) return sendJson(res, 400, { error: '群组内没有可用角色卡' });
        const first = (b.speakerId && members.find((c) => c.id === b.speakerId)) || members[0];
        const chat = {
          id: sid(), groupId: g.id, cardId: '', title: g.name,
          turnIndex: (members.findIndex((c) => c.id === first.id) + 1) % members.length,
          createdAt: now(), updatedAt: now(), messages: [],
        };
        if (first.first_mes) {
          chat.messages.push({
            role: 'assistant', swipes: [first.first_mes], swipeId: 0,
            content: first.first_mes, time: now(), speakerId: first.id, speakerName: first.name,
          });
        }
        await writeJsonAtomic(chatFile(chat.id), chat);
        return sendJson(res, 200, { ok: true, chat });
      }

      const card = readJson(cardFile(b.cardId), null);
      if (!card) return sendJson(res, 404, { error: '角色卡不存在' });
      const greeting = card.first_mes
        ? [{
          role: 'assistant', swipes: [card.first_mes], swipeId: 0,
          content: card.first_mes, time: now(), speakerId: card.id, speakerName: card.name,
        }]
        : [];
      const chat = { id: sid(), cardId: card.id, title: card.name, createdAt: now(), updatedAt: now(), messages: greeting };
      await writeJsonAtomic(chatFile(chat.id), chat);
      return sendJson(res, 200, { ok: true, chat });
    }

    /* ---- 批量操作：删除 / 置顶 / 取消置顶 / 移动到分组 ---- */
    if (p === '/api/chats/batch' && m === 'POST') {
      const b = await readBody(req);
      const ids = (Array.isArray(b.ids) ? b.ids : []).filter((x) => typeof x === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(x));
      if (!ids.length) return sendJson(res, 400, { error: '未选择对话' });
      const action = String(b.action || '');
      if (!['delete', 'pin', 'unpin', 'move'].includes(action)) return sendJson(res, 400, { error: '未知操作' });

      let affected = 0;
      for (const id of ids) {
        const file = chatFile(id);
        const c = readJson(file, null);
        if (!c) continue;
        if (action === 'delete') {
          await fsp.unlink(file).catch(() => {});
          affected++;
          continue;
        }
        if (action === 'pin') c.pinned = true;
        else if (action === 'unpin') c.pinned = false;
        else if (action === 'move') c.folderId = String(b.folderId || '');
        c.updatedAt = now();
        await fsp.writeFile(file, JSON.stringify(c, null, 2), 'utf8').catch(() => {});
        affected++;
      }
      return sendJson(res, 200, { ok: true, affected });
    }

    if (p === '/api/chats/message' && m === 'POST') {
      const b = await readBody(req);
      const c = readJson(chatFile(b.chatId), null);
      if (!c) return sendJson(res, 404, { error: '对话不存在' });
      // 指定下一位发言者：不依赖具体消息，先于消息校验
      if (b.action === 'speaker') {
        c.nextSpeakerId = String(b.content || '');
        c.updatedAt = now();
        await writeJsonAtomic(chatFile(c.id), c);
        return sendJson(res, 200, { ok: true, chat: c });
      }

      const i = Number(b.index);
      const msg = c.messages[i];
      if (!msg) return sendJson(res, 400, { error: '消息不存在' });
      if (b.action === 'delete') {
        c.messages.splice(i, 1);
        // 删掉的消息若已被提要覆盖，游标要跟着回退，否则会漏投喂
        if (c.memory && Number(c.memory.summarized) > i) {
          c.memory.summarized = Math.max(0, Number(c.memory.summarized) - 1);
        }
      } else if (b.action === 'swipe') {
        if (!Array.isArray(msg.swipes)) return sendJson(res, 400, { error: '该消息无候选' });
        const n = msg.swipes.length;
        const cur = Number(msg.swipeId) || 0;
        const dir = Number(b.index2) || 0;
        msg.swipeId = (((cur + dir) % n) + n) % n;
        msg.content = msg.swipes[msg.swipeId];
      } else if (b.action === 'edit') {
        if (msg.role === 'assistant') {
          if (!Array.isArray(msg.swipes)) msg.swipes = [msg.content || ''];
          msg.swipes[msg.swipeId || 0] = String(b.content || '');
          msg.content = msg.swipes[msg.swipeId || 0];
        } else {
          msg.content = String(b.content || '');
        }
      } else if (b.action === 'title') {
        c.title = String(b.content || c.title).slice(0, 60);
      }
      c.updatedAt = now();
      await writeJsonAtomic(chatFile(c.id), c);
      return sendJson(res, 200, { ok: true, chat: c });
    }

    /* ---- 导出聊天记录 ---- */
    if (p.startsWith('/api/chats/') && p.endsWith('/export') && m === 'GET') {
      const id = p.slice('/api/chats/'.length, -'/export'.length);
      const c = readJson(chatFile(id), null);
      if (!c) { res.writeHead(404); return res.end('Not Found'); }
      const card = c.cardId ? readJson(cardFile(c.cardId), null) : null;
      const grp = c.groupId ? readGroup(c.groupId) : null;
      const title = (grp && grp.name) || (card && card.name) || c.title || '对话';
      const U = CFG.user_name || '你';
      const fmt = String(url.searchParams.get('format') || 'txt').toLowerCase();
      const rows = (c.messages || []).map((x) => ({
        who: x.role === 'assistant' ? (x.speakerName || title) : U,
        isUser: x.role === 'user',
        text: msgText(x),
        time: x.time || c.updatedAt || now(),
        speakerId: x.speakerId || '',
      }));
      const iso = (t) => new Date(t).toISOString().slice(0, 19).replace('T', ' ');
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const summary = (c.memory && c.memory.summary) || '';
      let body = '';
      let type = 'text/plain; charset=utf-8';
      let ext = 'txt';

      if (fmt === 'html') {
        type = 'text/html; charset=utf-8';
        ext = 'html';
        const esc = (s) => String(s == null ? '' : s)
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const inline = (s) => esc(s)
          .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
          .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
          .replace(/\n/g, '<br>');
        const rowsHtml = rows.map((r) => `
    <div class="row ${r.isUser ? 'me' : 'them'}">
      ${r.isUser ? '' : `<div class="who">${esc(r.who)}</div>`}
      <div class="bubble">${inline(r.text)}</div>
    </div>`).join('');
        body = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;background:#0f1116;color:#e7eaf0;font:15px/1.85 system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:760px;margin:0 auto;padding:40px 20px 60px}
header h1{font-size:22px;margin:0 0 6px;font-weight:650}
.meta{font-size:12px;opacity:.55}
.mem{margin:18px 0;padding:12px 14px;border-radius:10px;background:rgba(127,157,255,.08);border:1px solid rgba(127,157,255,.25);font-size:13.5px}
.mem summary{cursor:pointer;color:#7f9dff}
.mem div{margin-top:8px;opacity:.85}
main{margin-top:26px}
.row{margin:0 0 18px;display:flex;flex-direction:column;gap:5px}
.row.me{align-items:flex-end}
.who{font-size:12px;color:#7f9dff}
.bubble{padding:11px 15px;border-radius:12px;max-width:86%;word-break:break-word}
.them .bubble{background:rgba(127,157,255,.10);border:1px solid rgba(127,157,255,.18)}
.me .bubble{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.10)}
.bubble em{opacity:.85}
footer{margin-top:36px;font-size:11px;opacity:.4;text-align:center}
@media (prefers-color-scheme:light){
  body{background:#f6f7f9;color:#1b1f27}
  .them .bubble{background:#fff;border-color:#e3e7ef}
  .me .bubble{background:#e9efff;border-color:#cfdcff}
  .who{color:#3b5bdb}
}
</style>
</head><body>
<div class="wrap">
  <header>
    <h1>${esc(title)}</h1>
    <div class="meta">${rows.length} 条消息 · 导出于 ${iso(now())}</div>
  </header>
  ${summary ? `<details class="mem"><summary>前情提要</summary><div>${inline(summary)}</div></details>` : ''}
  <main>${rowsHtml}
  </main>
  <footer>由 RoleHaven v${APP_VERSION} 导出</footer>
</div>
</body></html>`;
      } else if (fmt === 'jsonl') {
        type = 'application/jsonl; charset=utf-8';
        ext = 'jsonl';
        const lines = [JSON.stringify({
          user_name: U,
          character_name: title,
          create_date: new Date(c.createdAt || now()).toISOString(),
          chat_metadata: {
            source: 'RoleHaven',
            version: APP_VERSION,
            group: c.groupId || '',
            world: (grp && grp.worldId) || (card && card.worldId) || '',
            summary,
          },
        })];
        for (const r of rows) {
          lines.push(JSON.stringify({
            name: r.who,
            is_user: r.isUser,
            is_system: false,
            send_date: new Date(r.time).toISOString(),
            mes: r.text,
          }));
        }
        body = lines.join('\n');
      } else if (fmt === 'md') {
        type = 'text/markdown; charset=utf-8';
        ext = 'md';
        const out = [`# ${title}`, '', `> 导出时间：${iso(now())}　消息数：${rows.length}`];
        if (c.title) out.push(`> 对话标题：${c.title}`);
        if (summary) out.push('', '## 前情提要', '', summary);
        out.push('', '---', '');
        for (const r of rows) {
          out.push(`### ${r.who}`, '', r.text, '');
        }
        body = out.join('\n');
      } else {
        ext = 'txt';
        const pad = '='.repeat(40);
        const out = [`${title} - ${new Date(c.createdAt || now()).toISOString().slice(0, 10)}`, pad, ''];
        for (const r of rows) {
          out.push(`${r.who}: ${r.text}`, '');
        }
        if (summary) out.push(pad, '前情提要：', summary, '');
        body = out.join('\n');
      }

      res.writeHead(200, {
        'content-type': type,
        'content-disposition': `attachment; filename="${encodeURIComponent(title + '-' + stamp)}.${ext}"`,
        'content-length': Buffer.byteLength(body),
      });
      return res.end(body);
    }

    /* ---- 长上下文记忆 ---- */
    if (p === '/api/memory' && m === 'GET') {
      const c = readJson(chatFile(url.searchParams.get('chatId') || ''), null);
      if (!c) return sendJson(res, 404, { error: '对话不存在' });
      const w = memoryWindow(c);
      return sendJson(res, 200, {
        memory: c.memory || { summary: '', summarized: 0, updatedAt: 0 },
        total: (c.messages || []).length,
        covered: w.covered,
        pending: w.pending,
        keep: w.keep,
        enabled: !!CFG.memory_enabled,
        minBatch: Number(CFG.memory_min_batch) || 6,
      });
    }

    if (p === '/api/memory' && m === 'POST') {
      const b = await readBody(req);
      const c = readJson(chatFile(b.chatId), null);
      if (!c) return sendJson(res, 404, { error: '对话不存在' });
      const card = (c.cardId && readJson(cardFile(c.cardId), null)) || { name: c.title || '角色' };

      if (b.action === 'clear') {
        delete c.memory;
        c.updatedAt = now();
        await writeJsonAtomic(chatFile(c.id), c);
        return sendJson(res, 200, { ok: true, memory: { summary: '', summarized: 0, updatedAt: 0 } });
      }

      if (b.action === 'set') {
        c.memory = {
          summary: String(b.summary || ''),
          summarized: Math.min(Math.max(0, Number(b.summarized) || 0), (c.messages || []).length),
          updatedAt: now(),
        };
        c.updatedAt = now();
        await writeJsonAtomic(chatFile(c.id), c);
        return sendJson(res, 200, { ok: true, memory: c.memory });
      }

      if (b.action === 'rebuild') {
        if (!CFG.apiKey) return sendJson(res, 400, { error: '未配置 API Key，无法生成摘要' });
        // 从零重建：把除最近 keep 条之外的全部重新压缩
        c.memory = { summary: '', summarized: 0, updatedAt: 0 };
        const w = memoryWindow(c);
        if (w.pending <= 0) return sendJson(res, 400, { error: '消息太少，暂无可摘要的内容' });
        const r = await summarizeMemory(c, card, null);
        return sendJson(res, 200, { ok: true, memory: c.memory, result: r });
      }

      if (b.action === 'append') {
        if (!CFG.apiKey) return sendJson(res, 400, { error: '未配置 API Key，无法生成摘要' });
        const r = await summarizeMemory(c, card, null);
        if (!r) return sendJson(res, 400, { error: '没有需要摘要的新内容' });
        return sendJson(res, 200, { ok: true, memory: c.memory, result: r });
      }

      return sendJson(res, 400, { error: '未知操作' });
    }

    /* ---- 回退到某条消息 ---- */
    if (p === '/api/chats/rewind' && m === 'POST') {
      const b = await readBody(req);
      const c = readJson(chatFile(b.chatId), null);
      if (!c) return sendJson(res, 404, { error: '对话不存在' });
      const i = Number(b.index);
      if (!(i >= 0 && i < c.messages.length)) return sendJson(res, 400, { error: '消息不存在' });
      const removed = c.messages.length - i - 1;
      c.messages = c.messages.slice(0, i + 1);

      // 游标不能超过新长度，否则会漏投喂
      if (c.memory) {
        c.memory.summarized = Math.min(Number(c.memory.summarized) || 0, c.messages.length);
        if (!c.memory.summarized) delete c.memory;
      }

      // 群聊：轮询指针回到保留的最后一位之后
      if (c.groupId) {
        const g = readGroup(c.groupId);
        if (g) {
          const members = loadMembers(g);
          const lastSpk = [...c.messages].reverse().find((x) => x.role === 'assistant' && x.speakerId);
          if (lastSpk && members.length) {
            const idx = members.findIndex((x) => x.id === lastSpk.speakerId);
            c.turnIndex = idx >= 0 ? (idx + 1) % members.length : 0;
          }
        }
      }

      c.updatedAt = now();
      await writeJsonAtomic(chatFile(c.id), c);
      return sendJson(res, 200, { ok: true, removed, chat: c });
    }

    if (p.startsWith('/api/chats/') && m === 'GET') {
      const c = readJson(chatFile(p.slice('/api/chats/'.length)), null);
      if (!c) return sendJson(res, 404, { error: '不存在' });
      return sendJson(res, 200, c);
    }

    if (p.startsWith('/api/chats/') && m === 'DELETE') {
      await fsp.unlink(chatFile(p.slice('/api/chats/'.length))).catch(() => {});
      return sendJson(res, 200, { ok: true });
    }

    /* ---- 生成 ---- */
    if (p === '/api/generate' && m === 'POST') return await handleGenerate(req, res);

    /* ---- 提示词预览（调试用） ---- */
    if (p === '/api/prompt' && m === 'GET') {
      const c = readJson(chatFile(url.searchParams.get('chatId') || ''), null);
      if (!c) return sendJson(res, 404, { error: '对话不存在' });

      let group = null;
      let cards = [];
      let speaker = null;
      if (c.groupId) {
        group = readGroup(c.groupId);
        if (!group) return sendJson(res, 404, { error: '群组不存在' });
        cards = loadMembers(group);
        if (!cards.length) return sendJson(res, 400, { error: '群组内没有可用角色卡' });
        if (c.nextSpeakerId) speaker = cards.find((x) => x.id === c.nextSpeakerId) || cards[0];
        else if (group.mode === 'random') speaker = cards[Math.floor(Math.random() * cards.length)];
        else speaker = cards[(Number(c.turnIndex) || 0) % cards.length];
      } else {
        speaker = readJson(cardFile(c.cardId), null);
        if (!speaker) return sendJson(res, 404, { error: '角色卡不存在' });
      }

      const worldId = (group && group.worldId) || speaker.worldId;
      const scan = (c.messages || []).slice(-CFG.world_scan_depth).map(msgText).join('\n');
      const messages = buildMessages(speaker, c, scan, group ? { group, cards, speaker } : {});

      let worldHits = [];
      if (CFG.world_enabled && worldId) {
        const w = readJson(worldFile(worldId), null);
        if (w) {
          const raw = scan.toLowerCase();
          worldHits = Object.values(w.entries || {})
            .filter((e) => !e.disable && e.content && (e.constant || (e.key || []).some((k) => k && raw.includes(String(k).toLowerCase()))))
            .map((e) => e.comment || (e.key || []).join('/') || '(无备注)');
        }
      }
      return sendJson(res, 200, {
        speaker: { id: speaker.id, name: speaker.name },
        group: group ? { id: group.id, name: group.name, mode: group.mode } : null,
        systemLength: (messages[0].content || '').length,
        totalMessages: messages.length,
        worldHits,
        messages,
      });
    }

    /* ---- 静态 ---- */
    if (m === 'GET' || m === 'HEAD') {
      const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
      const abs = path.resolve(PUBLIC_DIR, rel);
      const pubRoot = path.resolve(PUBLIC_DIR);
      if (abs !== pubRoot && !abs.startsWith(pubRoot + path.sep)) {
        res.writeHead(403); return res.end('Forbidden');
      }
      return fs.readFile(abs, (err, data) => {
        if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Not Found'); }
        res.writeHead(200, {
          'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
          // 本地服务，禁掉缓存，避免升级后还加载旧的前端脚本
          'cache-control': 'no-cache, no-store, must-revalidate',
          'pragma': 'no-cache',
          'expires': '0',
        });
        res.end(data);
      });
    }

    res.writeHead(404); res.end('Not Found');
  } catch (e) {
    if (!res.headersSent) sendJson(res, 500, { error: e.message || String(e) });
    else { try { res.end(); } catch (_) {} }
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('');
    console.error(`[错误] 端口 ${CFG.port} 已被占用。`);
    console.error(`  可能已经有一个 RoleHaven 在运行，直接访问 http://127.0.0.1:${CFG.port}`);
    console.error(`  或换端口启动：set PORT=8790 && node server.js`);
    console.error('');
  } else if (e.code === 'EACCES') {
    console.error(`[错误] 没有权限监听端口 ${CFG.port}`);
  } else {
    console.error('[错误] ' + (e.message || String(e)));
  }
  process.exit(1);
});

server.listen(CFG.port, '127.0.0.1', () => {
  console.log(`${APP_NAME} v${APP_VERSION}  ->  http://127.0.0.1:${CFG.port}`);
  console.log(`  角色卡: ${CARDS_DIR}`);
  console.log(`  世界书: ${WORLDS_DIR}`);
  console.log(`  群组:   ${GROUPS_DIR}`);
  console.log(`  模型:   ${CFG.model}   API Key: ${CFG.apiKey ? '已配置' : '未配置'}`);
});
