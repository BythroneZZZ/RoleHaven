'use strict';
/**
 * API 冒烟测试。
 * 自包含：自动启动一个「临时数据目录 + 随机端口」的独立实例，跑完销毁，
 * 不会触碰用户的 data/ 与 regex 配置。
 *
 * 用法：node test/smoke.js
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { start, seed, makePng, ROOT } = require('./_env');

const VER = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
const results = [];
function ok(name, cond, extra) {
  results.push((cond ? 'PASS  ' : 'FAIL  ') + name + (extra != null ? '   ' + extra : ''));
}
function readPng(buf) {
  if (buf.length < 20 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  let i = 8;
  const texts = {};
  const types = [];
  let w = 0, h = 0;
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i);
    if (i + 12 + len > buf.length) return null;
    const type = buf.toString('latin1', i + 4, i + 8);
    const data = buf.subarray(i + 8, i + 8 + len);
    types.push(type);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); }
    if (type === 'tEXt') {
      const z = data.indexOf(0);
      if (z > 0) texts[data.toString('latin1', 0, z)] = data.subarray(z + 1).toString('latin1');
    }
    i += 12 + len;
    if (type === 'IEND') break;
  }
  return { texts, types, w, h };
}
function rawGet(port, pathname, hostHeader) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, headers: { host: hostHeader } }, (res) => {
      resolve({ status: res.statusCode });
      res.resume();
    });
    req.on('error', () => resolve({ status: 0 }));
    req.end();
  });
}

(async () => {
  let env;
  try {
    env = await start();
    const B = env.base;
    const get = async (p) => { const r = await fetch(B + p); return { status: r.status, body: await r.json().catch(() => null) }; };
    const post = async (p, o) => {
      const r = await fetch(B + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) });
      return { status: r.status, body: await r.json().catch(() => null) };
    };

    // ---------- 0. 版本与基础接口 ----------
    let r = await get('/api/version');
    ok('版本接口', r.status === 200 && r.body.version === VER && r.body.name === 'RoleHaven', JSON.stringify(r.body));
    const st = await get('/api/settings');
    ok('settings 带版本', st.body && st.body.version === VER && st.body.name === 'RoleHaven');

    for (const ep of ['/api/cards', '/api/groups', '/api/worlds', '/api/chats', '/api/regex']) {
      const rr = await get(ep);
      ok('GET ' + ep, rr.status === 200);
    }

    // ---------- 1. 夹具 ----------
    const { alpha, beta, world, group } = await seed(B);
    ok('夹具：两张卡', !!alpha && !!beta, `${alpha.name} / ${beta.name}`);
    ok('夹具：世界书含 2 条', Object.keys((await get('/api/worlds/' + world.id)).body.entries).length === 2);
    ok('夹具：群聊 2 人', group.members.length === 2);

    // ---------- 2. PNG 导出：占位图（无原图） ----------
    let pngRes = await fetch(B + '/api/cards/' + alpha.id + '/export-png');
    let buf = Buffer.from(await pngRes.arrayBuffer());
    let p = readPng(buf);
    ok('无图卡导出 HTTP', pngRes.status === 200, pngRes.headers.get('content-type') + ' ' + buf.length + 'B');
    ok('占位图为 400x600', !!p && p.w === 400 && p.h === 600, p ? `${p.w}x${p.h}` : '');
    ok('PNG 结构合法', !!p && p.types[0] === 'IHDR' && p.types[p.types.length - 1] === 'IEND');
    ok('含 chara / ccv3', !!(p && p.texts.chara && p.texts.ccv3));

    const v2 = JSON.parse(Buffer.from(p.texts.chara, 'base64').toString('utf8'));
    const v3 = JSON.parse(Buffer.from(p.texts.ccv3, 'base64').toString('utf8'));
    ok('chara 为 V2 规范', v2.spec === 'chara_card_v2' && v2.data.name === 'SmokeAlpha', v2.data.name);
    ok('ccv3 为 V3 规范', v3.spec === 'chara_card_v3' && v3.spec_version === '3.0');
    ok('默认不携带对话', !(v3.data.extensions.rolehaven && v3.data.extensions.rolehaven.chat));
    ok('默认文件名无标记', !decodeURIComponent(pngRes.headers.get('content-disposition') || '').includes('含对话'));

    // ---------- 3. PNG 导出：有原图（尺寸保留） ----------
    fs.writeFileSync(path.join(env.dataDir, 'cards', beta.id + '.png'), makePng(16, 24));
    await post('/api/cards', { ...beta, hasAvatar: true });
    pngRes = await fetch(B + '/api/cards/' + beta.id + '/export-png');
    buf = Buffer.from(await pngRes.arrayBuffer());
    p = readPng(buf);
    ok('保留原图尺寸', !!p && p.w === 16 && p.h === 24, p ? `${p.w}x${p.h}` : '');

    // ---------- 4. PNG 导出：显式携带对话 ----------
    r = await post('/api/chats', { cardId: alpha.id });
    const chat = r.body.chat;
    chat.messages.push({ role: 'user', content: '带走对话测试' });
    chat.messages.push({ role: 'assistant', content: '*Alpha 点头。* "记住了。"', speakerId: alpha.id, speakerName: alpha.name });
    fs.writeFileSync(path.join(env.dataDir, 'chats', chat.id + '.json'), JSON.stringify(chat, null, 2));

    pngRes = await fetch(B + '/api/cards/' + alpha.id + '/export-png?chatId=' + chat.id + '&withChat=1');
    buf = Buffer.from(await pngRes.arrayBuffer());
    p = readPng(buf);
    const v3c = JSON.parse(Buffer.from(p.texts.ccv3, 'base64').toString('utf8'));
    const rh = v3c.data.extensions.rolehaven;
    ok('withChat=1 写入对话', !!(rh && rh.chat && rh.chat.messages.length >= 3), rh && rh.chat ? rh.chat.messages.length + ' 条' : 'missing');
    ok('卡内记录来源版本', !!(rh && rh.version === VER), rh && rh.version);
    ok('文件名标注含对话', decodeURIComponent(pngRes.headers.get('content-disposition') || '').includes('含对话'),
      decodeURIComponent(pngRes.headers.get('content-disposition') || ''));

    const pngRes2 = await fetch(B + '/api/cards/' + alpha.id + '/export-png?chatId=' + chat.id + '&withChat=1');
    const p2 = readPng(Buffer.from(await pngRes2.arrayBuffer()));
    ok('重复导出不叠加块', p2.types.filter((t) => t === 'tEXt').length === 2);

    // ---------- 5. 正则 ----------
    const scripts = [
      { name: '压缩连续空白', find: '/[ \t]{2,}/g', replace: ' ', when: ['input'], enabled: true },
      { name: '斜体转直角引号', find: '/\\*([^*\\n]+)\\*/g', replace: '「$1」', when: ['output'], enabled: true },
      { name: '停用的规则', find: '/XXX/g', replace: 'YYY', when: ['output'], enabled: false },
    ];
    r = await post('/api/regex', { scripts });
    ok('保存正则规则', r.status === 200 && r.body.scripts.length === 3);
    r = await get('/api/regex');
    ok('读回正则规则', r.body.scripts.length === 3 && r.body.scripts[1].replace === '「$1」');

    r = await post('/api/regex/test', { text: '你好    世界', when: 'input' });
    ok('试跑 input 规则', r.body.result === '你好 世界', JSON.stringify(r.body.result));
    r = await post('/api/regex/test', { text: '*她笑了* "走吧"', when: 'output' });
    ok('试跑 output 规则', r.body.result === '「她笑了」 "走吧"', JSON.stringify(r.body.result));
    r = await post('/api/regex/test', { text: 'XXX', when: 'output' });
    ok('停用规则不生效', r.body.result === 'XXX');
    r = await post('/api/regex/test', { text: 'a   b', when: 'output' });
    ok('时机隔离', r.body.result === 'a   b');

    await post('/api/regex', { scripts: [{ name: 'bad', find: '/(/g', replace: 'x', when: ['output'], enabled: true }, { name: 'good', find: '/A/g', replace: 'B', when: ['output'], enabled: true }] });
    r = await post('/api/regex/test', { text: 'A', when: 'output' });
    ok('非法正则被跳过', r.body.result === 'B');

    // ---------- 6. 对话管理：分组 / 置顶 / 批量 / 分享 ----------
    r = await post('/api/chats', { cardId: alpha.id });
    const ca = r.body.chat;
    r = await post('/api/chats', { cardId: alpha.id });
    const cb = r.body.chat;

    r = await post('/api/folders', { name: '第一章' });
    const folder = r.body.folder;
    ok('创建分组', r.status === 200 && !!folder.id, folder.name);

    r = await post('/api/chats/batch', { ids: [ca.id], action: 'pin' });
    ok('批量置顶', r.body.affected === 1);
    r = await post('/api/chats/batch', { ids: [cb.id], action: 'move', folderId: folder.id });
    ok('批量移动分组', r.body.affected === 1);

    const listed = (await get('/api/chats?cardId=' + alpha.id)).body.chats;
    ok('置顶排在首位', listed[0].id === ca.id && listed[0].pinned === true);
    ok('分组已生效', listed.find((x) => x.id === cb.id).folderId === folder.id);

    const htmlRes = await fetch(B + '/api/chats/' + ca.id + '/export?format=html');
    const htmlBody = await htmlRes.text();
    ok('HTML 导出', htmlRes.status === 200 && (htmlRes.headers.get('content-type') || '').includes('text/html'), htmlBody.length + 'B');
    ok('HTML 自包含（内联样式、无外链）', htmlBody.includes('<style>') && !/<link[^>]+href=/.test(htmlBody));
    ok('HTML 含角色名', htmlBody.includes(alpha.name));
    ok('HTML 文件名', /\.html"/.test(decodeURIComponent(htmlRes.headers.get('content-disposition') || '')),
      decodeURIComponent(htmlRes.headers.get('content-disposition') || ''));

    await fetch(B + '/api/folders/' + folder.id, { method: 'DELETE' });
    const afterDel = (await get('/api/chats?cardId=' + alpha.id)).body.chats;
    ok('删除分组后对话回未分组', afterDel.find((x) => x.id === cb.id).folderId === '');

    r = await post('/api/chats/batch', { ids: [cb.id], action: 'delete' });
    ok('批量删除', r.body.affected === 1);

    // ---------- 7. 生成链路（无 Key） ----------
    await post('/api/regex', { scripts: [{ name: '压缩空白', find: '/[ \t]{2,}/g', replace: ' ', when: ['input'], enabled: true }] });
    r = await post('/api/chats', { cardId: alpha.id });
    const tchat = r.body.chat;
    const gen = await fetch(B + '/api/generate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: tchat.id, text: '多    个    空格' }),
    });
    const sse = await gen.text();
    ok('生成接口返回 SSE', gen.status === 200 && sse.includes('"type":"done"'));
    const back = await get('/api/chats/' + tchat.id);
    const lastUser = [...back.body.messages].reverse().find((m) => m.role === 'user');
    ok('input 正则在落库前生效', lastUser && lastUser.content === '多 个 空格', lastUser && JSON.stringify(lastUser.content));

    // ---------- 7. 安全边界 ----------
    ok('非本机 Host 被拒', (await rawGet(env.port, '/api/cards', 'evil.example.com')).status === 403);
    ok('本机 Host 放行', (await rawGet(env.port, '/api/cards', '127.0.0.1:' + env.port)).status === 200);
    ok('静态目录穿越被拒', (await fetch(B + '/..%2fserver.js')).status === 403);

  } catch (e) {
    ok('测试执行', false, e.message || String(e));
  } finally {
    if (env) await env.stop();
    console.log(results.join('\n'));
    const failed = results.filter((x) => x.startsWith('FAIL'));
    console.log('\n合计 ' + results.length + ' 项，失败 ' + failed.length + ' 项');
    console.log('（本轮使用隔离数据目录，用户 data/ 未被触碰）');
    process.exit(failed.length ? 1 : 0);
  }
})();
