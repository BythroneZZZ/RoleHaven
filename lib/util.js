'use strict';
/**
 * 通用工具：ID、JSON 读写、HTTP 响应、SSE。
 * 不依赖任何业务状态，server.js 与 lib/* 共用。
 */
const fs = require('fs');
const fsp = require('fs/promises');
const { randomUUID } = require('crypto');

const now = () => Date.now();

function sid() {
  return randomUUID().replace(/-/g, '').slice(0, 16);
}

function safeId(id) {
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(String(id || ''))) throw new Error('非法 ID');
  return String(id);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

/** 原子写：先写临时文件再 rename，避免进程中途退出留下半截 JSON */
async function writeJsonAtomic(file, obj) {
  const tmp = file + '.' + process.pid + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

function sendJson(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(b),
  });
  res.end(b);
}

function readBody(req, limit = 24 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(new Error('JSON 解析失败: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

function sseHead(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
}

function sseSend(res, obj) {
  if (res.writableEnded) return;
  res.write('data: ' + JSON.stringify(obj) + '\n\n');
}

/** 取消息当前展示文本（assistant 走 swipe） */
function msgText(m) {
  if (!m) return '';
  if (m.role === 'assistant') {
    const sw = Array.isArray(m.swipes) && m.swipes.length ? m.swipes : [m.content || ''];
    return sw[Math.min(m.swipeId || 0, sw.length - 1)] || '';
  }
  return m.content || '';
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = {
  now, sid, safeId, readJson, writeJsonAtomic,
  sendJson, readBody, sseHead, sseSend, msgText, escapeHtml,
};
