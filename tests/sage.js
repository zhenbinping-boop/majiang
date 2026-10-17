/**
 * tests/sage.js — 军师模式浏览器专项验证
 *
 * 校验点：
 *   1. window.MJMath 挂载且 analyzeHand 可用
 *   2. 🧠 按钮切换：点亮态 (icon-btn.on) + localStorage 持久化 (mj-sage)
 *   3. 轮到我出牌（手牌 14−3×副露 张）时 #sage-tip 出现，内容含「军师 / 打 / 进张 / 危险」
 *   4. DOM 模式：推荐牌获得 .sage-best 金环；3D 模式：面板同样出现（HUD DOM 通用）
 *   5. 再点一次关闭 → 面板隐藏、偏好落盘为 0
 *   6. 全程零脚本错误
 *
 * 运行：NODE_PATH=<managed node workspace>/node_modules node tests/sage.js
 *       (需先起本地服务 tests/serve.js 8765)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { pickChip, sleep } = require('./helpers');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8765';
const OUT = path.resolve(__dirname, '..', 'shots');
fs.mkdirSync(OUT, { recursive: true });

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log('  ok - ' + msg); }
  else { failed++; console.error('  FAIL - ' + msg); }
};
const sleep2 = sleep;

async function newPage(browser, url) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return { page, errors };
}

/** 进牌桌并选筹码（经主界面按钮，旋转定位元素用原生 click） */
async function enterTable(page, timeout = 30000) {
  await page.waitForFunction(
    () => window.__mjHome && document.getElementById('btn-quick'),
    { timeout, polling: 60 }
  );
  await page.evaluate(() => { const q = document.getElementById('btn-quick'); if (q) q.click(); });
  await page.waitForFunction(() => {
    const home = document.getElementById('home');
    const app = document.getElementById('app');
    return (!home || home.classList.contains('hidden')) && app && !app.classList.contains('hidden');
  }, { timeout, polling: 80 }).catch(() => {});
  await pickChip(page);
}

async function openSage(page) {
  await page.evaluate(() => { const b = document.getElementById('btn-sage'); if (b) b.click(); });
}

const SAGE_VISIBLE = () => {
  const t = document.getElementById('sage-tip');
  return !!t && !t.classList.contains('hidden') && t.textContent.indexOf('军师') >= 0;
};

async function testMode(browser, name, url, is3D) {
  console.log(`\n== ${name} ==`);
  const { page, errors } = await newPage(browser, url);

  ok(await page.evaluate(() => !!window.MJMath && typeof window.MJMath.analyzeHand === 'function'),
    'MJMath 挂载且 analyzeHand 可用');

  await enterTable(page);

  // 打开军师：按钮点亮 + 偏好落盘
  await openSage(page);
  ok(await page.evaluate(() => document.getElementById('btn-sage').classList.contains('on')),
    '按钮点亮态 on');
  ok(await page.evaluate(() => localStorage.getItem('mj-sage') === '1'),
    '偏好持久化 mj-sage=1');

  // 轮到我出牌时面板出现（军师建议只在玩家弃牌阶段展示）
  await page.waitForFunction(SAGE_VISIBLE, { timeout: 40000, polling: 120 });
  const content = await page.evaluate(() => {
    const t = document.getElementById('sage-tip');
    return {
      text: t.textContent,
      hasPick: !!t.querySelector('.sage-pick'),
      hasMeta: !!t.querySelector('.sage-meta'),
      pick: t.querySelector('.sage-pick') ? t.querySelector('.sage-pick').textContent : '',
    };
  });
  ok(content.hasPick && content.pick.indexOf('打') === 0, `给出弃牌建议：「${content.pick}」`);
  ok(/进张/.test(content.text) && /危险/.test(content.text), '建议含进张与危险度信息');

  if (!is3D) {
    // DOM 模式：推荐牌描金环
    const marked = await page.evaluate(() => {
      const el = document.querySelector('#my-hand .tile.sage-best');
      return el ? el.dataset.tile : null;
    });
    ok(marked !== null, `DOM 手牌推荐牌金环 (tile=${marked})`);
  } else {
    ok(await page.evaluate(() => !!document.querySelector('#table.t3d')),
      '3D 模式确认 (#table.t3d)，军师面板为 HUD DOM 通用');
  }

  await page.screenshot({ path: path.join(OUT, `sage-${name}.png`) });

  // 关闭军师：面板立即隐藏 + 偏好落盘 0
  await openSage(page);
  ok(await page.evaluate(() => {
    const t = document.getElementById('sage-tip');
    return localStorage.getItem('mj-sage') === '0' && t.classList.contains('hidden');
  }), '关闭后面板隐藏且 mj-sage=0');

  ok(errors.length === 0, '零脚本错误' + (errors.length ? '：' + errors.join(' | ') : ''));
  await page.close();
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
  });

  try {
    await testMode(browser, 'dom', `${BASE}/?ui=dom`, false);
    await testMode(browser, '3d', `${BASE}/`, true);
  } finally {
    await browser.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
