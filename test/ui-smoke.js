'use strict';
/**
 * UI 冒烟测试：用 Chrome DevTools Protocol 驱动真实无头浏览器，
 * 验证「界面能选中群聊并发消息」这类 API 测试覆盖不到的问题。
 *
 * 自包含：自动启动临时实例（隔离数据目录 + 随机端口）并造夹具，跑完销毁。
 * 依赖：Node 22+（内置 WebSocket）、本机 Chrome/Edge。
 *
 * 用法：node test/ui-smoke.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start, seed, sleep } = require('./_env');

const CDP_PORT = Number(process.env.CDP_PORT || 9223);
const results = [];

function ok(name, cond, extra) {
  results.push((cond ? 'PASS  ' : 'FAIL  ') + name + (extra != null ? '   ' + extra : ''));
  return cond;
}
function findChrome() {
  const list = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ];
  return list.find((p) => fs.existsSync(p)) || null;
}
async function waitHttp(url, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(url); if (r.ok) return true; } catch (_) {}
    await sleep(200);
  }
  return false;
}
async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true });
  });
  let seq = 0;
  const pending = new Map();
  const exceptions = [];
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params && msg.params.exceptionDetails;
      exceptions.push((d && (d.text || (d.exception && d.exception.description))) || 'unknown');
    }
  });
  return {
    exceptions,
    send(method, params = {}) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { try { ws.close(); } catch (_) {} },
  };
}
async function evalJs(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) {
    throw new Error('页面脚本异常: ' + (r.exceptionDetails.text || (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || ''));
  }
  return r.result && r.result.value;
}

(async () => {
  let env = null;
  let proc = null;
  let cdp = null;
  let userDir = '';

  try {
    env = await start();
    const BASE = env.base;
    await seed(BASE);
    ok('隔离实例就绪', true, BASE);

    const chrome = findChrome();
    if (!chrome) {
      console.log('SKIP  未找到 Chrome/Edge，跳过 UI 测试');
      process.exit(0);
    }

    userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-ui-'));
    proc = spawn(chrome, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
      '--disable-extensions', '--disable-background-networking',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${userDir}`,
      'about:blank',
    ], { stdio: 'ignore', windowsHide: true });

    const up = await waitHttp(`http://127.0.0.1:${CDP_PORT}/json/version`);
    ok('浏览器调试端口就绪', up, 'port=' + CDP_PORT);
    if (!up) throw new Error('浏览器未能启动');

    const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('找不到页面 target');

    cdp = await connectCdp(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: BASE });
    await sleep(1800);

    // ---------- 基础渲染 ----------
    const base = await evalJs(cdp, `(() => ({
      title: document.title,
      cards: document.querySelectorAll('#cardList .card-item').length,
      groups: document.querySelectorAll('#groupList .card-item').length,
      hasInput: !!document.querySelector('#input'),
      hasSend: !!document.querySelector('#send'),
      ver: (document.querySelector('#verTag') || {}).textContent || ''
    }))()`);
    ok('页面标题', base.title === 'RoleHaven', base.title);
    ok('版本号已渲染', /^v\d+\.\d+\.\d+$/.test(base.ver), base.ver);
    ok('角色列表有内容', base.cards >= 1, base.cards + ' 个');
    ok('群聊列表有内容', base.groups >= 1, base.groups + ' 个');
    ok('输入框与发送按钮存在', base.hasInput && base.hasSend);

    // ---------- 选中群聊（核心回归点：S.card 为空时的守卫） ----------
    const picked = await evalJs(cdp, `(async () => {
      document.querySelector('#groupList .card-item').click();
      await new Promise(r => setTimeout(r, 1200));
      return {
        title: document.querySelector('#chatTitle').textContent,
        speakerBarVisible: !document.querySelector('#speakerBar').hidden,
        inputDisabled: document.querySelector('#input').disabled
      };
    })()`);
    ok('点击群聊后标题切换', picked.title && picked.title !== '未选择角色', picked.title);
    ok('群聊发言者条可见', picked.speakerBarVisible === true);
    ok('群聊下输入框可用', picked.inputDisabled === false);

    // ---------- 输入文字 → 发送按钮必须可用 ----------
    const typed = await evalJs(cdp, `(() => {
      const i = document.querySelector('#input');
      i.value = 'UI 冒烟：群聊能不能发出去';
      i.dispatchEvent(new Event('input', { bubbles: true }));
      return { disabled: document.querySelector('#send').disabled };
    })()`);
    ok('群聊输入后发送按钮可用', typed.disabled === false, 'disabled=' + typed.disabled);

    // ---------- 真点一次发送 ----------
    const sent = await evalJs(cdp, `(async () => {
      const count = () => document.querySelectorAll('#msgInner .msg').length;
      const before = count();
      document.querySelector('#send').click();
      await new Promise(r => setTimeout(r, 2600));
      return {
        before, after: count(),
        inputCleared: document.querySelector('#input').value === '',
        stopHidden: document.querySelector('#stop').hidden
      };
    })()`);
    ok('发送后消息数增加', sent.after > sent.before, `${sent.before} → ${sent.after}`);
    ok('发送后输入框已清空', sent.inputCleared === true);
    ok('发送结束后状态复原', sent.stopHidden === true);
    ok('页面无未捕获异常', cdp.exceptions.length === 0, cdp.exceptions.slice(0, 2).join(' | '));

  } catch (e) {
    ok('UI 测试执行', false, e.message || String(e));
  } finally {
    if (cdp) cdp.close();
    if (proc) {
      try { spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch (_) {}
    }
    await sleep(600);
    if (userDir) { try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (_) {} }
    if (env) await env.stop();

    console.log(results.join('\n'));
    const failed = results.filter((x) => x.startsWith('FAIL'));
    console.log('\n合计 ' + results.length + ' 项，失败 ' + failed.length + ' 项');
    console.log('（本轮使用隔离数据目录 + 临时浏览器配置，用户数据未被触碰）');
    process.exit(failed.length ? 1 : 0);
  }
})();
