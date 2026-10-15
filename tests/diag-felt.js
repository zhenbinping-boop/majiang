/* 诊断：基座/绒毡几何关系 + raycast 桌心第一命中面 */
const puppeteer = require('puppeteer-core');
const path = require('path');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
      '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 500 });
  page.on('console', m => { const t = m.text(); if (t.includes('error') || t.includes('Error')) console.log('[console]', t); });
  await page.goto('http://127.0.0.1:8765/index.html', { waitUntil: 'load' });
  await page.waitForFunction(
    () => window.__mjHome && document.getElementById('btn-quick'), { timeout: 15000, polling: 60 });
  await page.evaluate(() => document.getElementById('btn-quick').click());
  await page.waitForFunction(() => {
    const home = document.getElementById('home');
    const app = document.getElementById('app');
    return (!home || home.classList.contains('hidden')) && app && !app.classList.contains('hidden');
  }, { timeout: 20000, polling: 80 });
  await page.waitForFunction(() => window.__mahjong && window.__mahjong.ui && window.__mahjong.ui.t3d, { timeout: 10000 });
  await new Promise(r => setTimeout(r, 2500));

  const diag = await page.evaluate(() => {
    const t3 = window.__mahjong.ui.t3d;
    const out = {};
    const scene = t3.scene;
    if (!scene) return { err: 'no scene access' };
    scene.traverse(o => {
      if (!o.isMesh) return;
      const p = o.geometry.parameters || {};
      if (o.geometry.type === 'PlaneGeometry' && p.width === 22.8) {
        out.felt = {
          y: o.position.y, visible: o.visible, matId: o.material.id,
          mapId: o.material.map ? o.material.map.id : null,
        };
      }
      if (o.geometry.type === 'ExtrudeGeometry') {
        o.geometry.computeBoundingBox();
        const bb = o.geometry.boundingBox;
        const w = bb.max.x - bb.min.x;
        if (w > 20) {
          out.base = {
            posY: o.position.y,
            geoY: [+bb.min.y.toFixed(3), +bb.max.y.toFixed(3)],
            worldTop: +(o.position.y + bb.max.y).toFixed(3),
            worldBottom: +(o.position.y + bb.min.y).toFixed(3),
            color: o.material.color ? '#' + o.material.color.getHexString() : '?',
          };
        }
      }
    });
    /* raycast：从桌心正上方 y=20 垂直向下，看前三个命中面 */
    if (window.THREE) {
      const ray = new window.THREE.Raycaster(
        new window.THREE.Vector3(0, 20, 0), new window.THREE.Vector3(0, -1, 0));
      const hits = ray.intersectObjects(scene.children, true).slice(0, 3).map(h => ({
        y: +h.point.y.toFixed(3),
        dist: +h.distance.toFixed(3),
        geo: h.object.geometry.type,
        color: h.object.material.color ? '#' + h.object.material.color.getHexString() : '?',
      }));
      out.raycastTop3 = hits;
    }
    return out;
  });
  console.log(JSON.stringify(diag, null, 2));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
