/* tests/helpers.js — 测试共享辅助 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 关闭「拿牌后选择筹码」弹窗（选 500 档）。
 * 每场开局发牌后 playHand 会 await ui.askChip()，在手牌交互解锁之前
 * 必须先选筹码，否则 handClickResolve 永不就绪。
 * @param {import('puppeteer-core').Page} page
 * @param {number} [timeout] 等弹窗出现的超时
 */
async function pickChip(page, timeout = 15000) {
  await page.waitForFunction(() => {
    const modal = document.getElementById('modal-root');
    return modal && modal.children.length > 0 &&
      modal.querySelectorAll('.chip-btn').length >= 3;
  }, { timeout, polling: 100 }).catch(() => { /* 无弹窗则跳过（如已选过） */ });
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.chip-btn')].find((x) => x.textContent.indexOf('500') >= 0);
    if (b) b.click();
  });
  await sleep(500);
}

module.exports = { pickChip, sleep };
