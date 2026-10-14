/**
 * tests/intro-film.js — 入场动画逐帧取样（人工视觉复核）
 * 从 0 到结束每 180ms 截一帧，拼成序列，用于检查：
 *   · 飞入是否铺满全屏（而不是挤在一角）
 *   · 洗牌是否真的在中央收成一堆
 *   · 字面「立」起来时是否整齐铺开
 *   · 标题显现的时机与位置
 */
'use strict';
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8765';
const OUT = path.resolve(__dirname, '..', 'shots', 'intro-film');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const VP = process.argv[2] === 'portrait' ? { w: 390, h: 844, mobile: true }
  : process.argv[2] === 'landscape' ? { w: 844, h: 390, mobile: true }
    : { w: 1440, h: 900, mobile: false };

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--mute-audio'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: VP.w, height: VP.h, deviceScaleFactor: 2, isMobile: VP.mobile, hasTouch: VP.mobile });
  await page.goto(BASE + '/index.html', { waitUntil: 'load' });

  const tag = process.argv[2] || 'desktop';
  const t0 = Date.now();
  const frames = [];
  for (let i = 0; i < 22; i++) {
    await sleep(150);
    const ms = Date.now() - t0;
    const stat = await page.evaluate(() => {
      const uses = [...document.querySelectorAll('#intro-tiles .it')];
      const root = document.getElementById('intro');
      if (!uses.length) return { n: 0, gone: root.classList.contains('gone') };
      // 取每个 <use> 的「当前视觉位置」：自身 x/y + 动画后的 transform 平移
      const rootBox = root.getBoundingClientRect();
      let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
      const live = [];
      for (const u of uses) {
        const m = u.getBoundingClientRect();
        // 用屏幕盒统计覆盖范围（旋转下也无所谓，只关心铺开程度）
        minX = Math.min(minX, m.left); maxX = Math.max(maxX, m.right);
        minY = Math.min(minY, m.top); maxY = Math.max(maxY, m.bottom);
        const op = parseFloat(getComputedStyle(u).opacity);
        if (op > 0.05) live.push(op);
      }
      return {
        n: uses.length, live: live.length,
        spreadX: Math.round(maxX - minX), spreadY: Math.round(maxY - minY),
        vw: window.innerWidth, vh: window.innerHeight,
        gone: root.classList.contains('gone'),
        titleOpacity: (() => {
          // 量的是真正参与淡入的「来/把/麻/将」四字，而不是外层容器
          const ch = [...document.querySelectorAll('#intro-title .it-ch')];
          if (!ch.length) return 0;
          return Math.max(...ch.map((e) => parseFloat(getComputedStyle(e).opacity) || 0));
        })(),
      };
    });
    frames.push({ ms, titleOpacity: 0, gone: false, vw: 0, ...stat });
    await page.screenshot({ path: path.join(OUT, `${tag}-${String(i).padStart(2, '0')}-${String(ms).padStart(4, '0')}ms.png`) });
  }
  await browser.close();
  console.log('帧序列：');
  for (const f of frames) {
    const cover = f.vw ? ((f.spreadX / f.vw) * 100).toFixed(0) + '%/' + ((f.spreadY / f.vh) * 100).toFixed(0) + '%' : '—';
    console.log(`  ${String(f.ms).padStart(4)}ms  可见 ${String(f.live || 0).padStart(2)}/${f.n}  覆盖 ${cover}  标题α ${f.titleOpacity.toFixed(2)}${f.gone ? '  [已结束]' : ''}`);
  }
  console.log('帧存至 shots/intro-film/');
})();
