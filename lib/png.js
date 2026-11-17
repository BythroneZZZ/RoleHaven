'use strict';
/**
 * PNG 角色卡读写：tEXt 块解析与写入、CRC32、占位图生成、V2/V3 卡片序列化。
 * 纯函数，不依赖服务状态。
 */
const zlib = require('zlib');
const { msgText } = require('./util');

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c | 0;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function textChunk(keyword, text) {
  return pngChunk('tEXt', Buffer.concat([
    Buffer.from(keyword, 'latin1'),
    Buffer.from([0]),
    Buffer.from(text, 'latin1'),
  ]));
}

/** 从 PNG 的 tEXt 块中取出 chara / ccv3 的 base64 JSON（优先 V3） */
function readPngCard(buf) {
  if (buf.length < 20 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  let i = 8;
  const found = {};
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i);
    if (len < 0 || i + 12 + len > buf.length) break;
    const type = buf.toString('latin1', i + 4, i + 8);
    const data = buf.subarray(i + 8, i + 8 + len);
    if (type === 'tEXt' || type === 'iTXt') {
      const z = data.indexOf(0);
      if (z > 0) {
        const key = data.toString('latin1', 0, z);
        if (key === 'chara' || key === 'ccv3') {
          const val = data.subarray(z + 1).toString('latin1').replace(/\0+$/, '');
          try { found[key] = JSON.parse(Buffer.from(val, 'base64').toString('utf8')); } catch (_) {}
        }
      }
    }
    if (type === 'IEND') break;
    i += 12 + len;
  }
  return found.ccv3 || found.chara || null;
}

/** 剔除旧 chara/ccv3 后，在 IHDR 之后插入新的 tEXt 块 */
function embedCardIntoPng(png, pairs) {
  const out = [png.subarray(0, 8)];
  let i = 8;
  let inserted = false;
  while (i + 12 <= png.length) {
    const len = png.readUInt32BE(i);
    if (i + 12 + len > png.length) break;
    const type = png.toString('latin1', i + 4, i + 8);
    const data = png.subarray(i + 8, i + 8 + len);
    let skip = false;
    if (type === 'tEXt' || type === 'iTXt') {
      const z = data.indexOf(0);
      const key = z > 0 ? data.toString('latin1', 0, z) : '';
      if (key === 'chara' || key === 'ccv3') skip = true;
    }
    if (!skip) out.push(png.subarray(i, i + 12 + len));
    if (type === 'IHDR' && !inserted) {
      for (const [k, v] of pairs) out.push(textChunk(k, v));
      inserted = true;
    }
    i += 12 + len;
    if (type === 'IEND') break;
  }
  return Buffer.concat(out);
}

/** 没有原图时生成一张深色渐变占位卡面 */
function makePlaceholderPng(w = 400, h = 600) {
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const row = y * stride;
    raw[row] = 0; // filter: none
    const t = y / (h - 1);
    const r = Math.round(14 + 34 * (1 - t));
    const g = Math.round(17 + 26 * (1 - t));
    const b = Math.round(26 + 78 * (1 - t));
    for (let x = 0; x < w; x++) {
      const o = row + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: truecolor
  return Buffer.concat([
    PNG_SIG,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function cardToV2(card) {
  const data = {
    name: card.name,
    description: card.description || '',
    personality: card.personality || '',
    scenario: card.scenario || '',
    first_mes: card.first_mes || '',
    mes_example: card.mes_example || '',
    creator_notes: card.creator_notes || '',
    system_prompt: card.system_prompt || '',
    post_history_instructions: card.post_history_instructions || '',
    alternate_greetings: card.alternate_greetings || [],
    tags: card.tags || [],
    creator: card.creator || 'RoleHaven',
    character_version: card.character_version || '',
    extensions: { rolehaven: { world: card.worldId || '' } },
  };
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    name: data.name,
    description: data.description,
    personality: data.personality,
    scenario: data.scenario,
    first_mes: data.first_mes,
    mes_example: data.mes_example,
    data,
  };
}

function cardToV3(card, chat, version) {
  const ext = { rolehaven: { world: card.worldId || '', version: version || '' } };
  if (chat) {
    ext.rolehaven.chat = {
      id: chat.id,
      title: chat.title || '',
      groupId: chat.groupId || '',
      memory: chat.memory || null,
      exportedAt: new Date().toISOString(),
      messages: (chat.messages || []).slice(-300).map((x) => ({
        role: x.role,
        content: msgText(x),
        speakerId: x.speakerId || '',
        speakerName: x.speakerName || '',
        time: x.time || 0,
      })),
    };
  }
  const data = {
    name: card.name,
    description: card.description || '',
    personality: card.personality || '',
    scenario: card.scenario || '',
    first_mes: card.first_mes || '',
    mes_example: card.mes_example || '',
    creator_notes: card.creator_notes || '',
    system_prompt: card.system_prompt || '',
    post_history_instructions: card.post_history_instructions || '',
    alternate_greetings: card.alternate_greetings || [],
    tags: card.tags || [],
    creator: card.creator || 'RoleHaven',
    character_version: card.character_version || '',
    extensions: ext,
    group_only_greetings: [],
  };
  return {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    name: data.name,
    description: data.description,
    personality: data.personality,
    scenario: data.scenario,
    first_mes: data.first_mes,
    mes_example: data.mes_example,
    creator_notes: data.creator_notes,
    system_prompt: data.system_prompt,
    post_history_instructions: data.post_history_instructions,
    alternate_greetings: data.alternate_greetings,
    tags: data.tags,
    creator: data.creator,
    character_version: data.character_version,
    avatar: 'none',
    talkativeness: '0.5',
    data,
  };
}

module.exports = {
  readPngCard, embedCardIntoPng, makePlaceholderPng, cardToV2, cardToV3, crc32,
};
