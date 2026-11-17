'use strict';
/**
 * 测试环境工具：启动一个使用「临时数据目录 + 随机端口」的独立服务实例，
 * 让冒烟测试完全不接触用户真实数据。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

async function waitHttp(url, timeout = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(url); if (r.ok) return true; } catch (_) {}
    await sleep(200);
  }
  return false;
}

/** 生成一张纯色 PNG（用于测试"保留原图尺寸"分支） */
function makePng(w, h, rgb = [40, 60, 110]) {
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const row = y * stride;
    for (let x = 0; x < w; x++) {
      const o = row + 1 + x * 3;
      raw[o] = rgb[0]; raw[o + 1] = rgb[1]; raw[o + 2] = rgb[2];
    }
  }
  const CRC = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c | 0; }
    return t;
  })();
  const crc32 = (b) => { let c = -1; for (let i = 0; i < b.length; i++) c = (c >>> 8) ^ CRC[(c ^ b[i]) & 0xff]; return (c ^ -1) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'latin1');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function start() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-test-'));
  const port = await freePort();
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, ROLEHAVEN_DATA_DIR: dataDir, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let log = '';
  proc.stdout.on('data', (d) => { log += d.toString(); });
  proc.stderr.on('data', (d) => { log += d.toString(); });

  const base = `http://127.0.0.1:${port}`;
  const up = await waitHttp(base + '/api/version');
  if (!up) {
    try { proc.kill(); } catch (_) {}
    throw new Error('隔离实例启动失败：\n' + log);
  }

  return {
    base,
    port,
    dataDir,
    get log() { return log; },
    async stop() {
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        } else {
          proc.kill('SIGKILL');
        }
      } catch (_) {}
      await sleep(500);
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
    },
  };
}

/** 造一份固定夹具：两张卡（其中一张带头像）、一本世界书、一个群组 */
async function seed(base) {
  const post = async (p, o) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  let r = await post('/api/cards', {
    name: 'SmokeAlpha',
    description: '测试用角色甲，冷静、简短。',
    personality: '冷静',
    first_mes: '*Alpha 抬头。* "来了。"',
    tags: ['smoke'],
  });
  const alpha = r.body.card;

  r = await post('/api/cards', {
    name: 'SmokeBeta',
    description: '测试用角色乙，话多、热情。',
    personality: '热情',
    first_mes: '*Beta 挥手。* "终于有人来了！"',
    tags: ['smoke'],
  });
  const beta = r.body.card;

  r = await post('/api/worlds', {
    name: 'SmokeWorld',
    entries: {
      0: { uid: 0, key: ['eldoria', 'forest'], comment: 'eldoria', content: 'Eldoria 是一片古老森林。', constant: false, disable: false, order: 100 },
      1: { uid: 1, key: [], comment: '常驻设定', content: '此地长年薄雾。', constant: true, disable: false, order: 50 },
    },
  });
  const world = r.body.world;

  const bound = await post('/api/cards', { ...alpha, worldId: world.id });

  r = await post('/api/groups', { name: 'SmokeGroup', members: [alpha.id, beta.id], mode: 'round_robin', worldId: world.id });
  const group = r.body.group;

  return { alpha: (bound.body && bound.body.card) || alpha, beta, world, group };
}

module.exports = { ROOT, sleep, freePort, waitHttp, makePng, start, seed };
