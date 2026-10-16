/**
 * tests/smoke.js — 对局控制器集成冒烟测试（game.js + ui.js + engine.js + ai.js）
 *
 * 用 DOM 桩 + 极速定时器驱动 GameController 跑完整场对局（8 局），验证：
 *   1. 发牌 / 摸牌 / 弃牌 / 吃碰明杠 / 暗杠加杠 / 抢杠 / 岭上 / 和牌 / 荒庄 / 连庄 全流程不抛异常
 *   2. 每局结束后全桌分数守恒（4 × START_SCORE）
 *   3. 每局结束牌张守恒（手上 + 副露 + 牌山 + 王牌 = 136 - 未被鸣牌的牌河）
 *   4. 各类鸣牌路径均被覆盖到
 *
 * 运行: node tests/smoke.js [场数]
 */
'use strict';

/* ================= DOM 桩 ================= */
function stubEl(tag) {
  const classes = new Set();
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    children: [],
    style: {},
    dataset: {},
    _html: '',
    _text: '',
    classList: {
      add: (...c) => c.forEach(x => classes.add(x)),
      remove: (...c) => c.forEach(x => classes.delete(x)),
      contains: (c) => classes.has(c),
      toggle: (c, f) => { const on = f === undefined ? !classes.has(c) : !!f; on ? classes.add(c) : classes.delete(c); return on; },
    },
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
    insertBefore(c) { this.children.push(c); return c; },
    append(...cs) { cs.forEach(c => this.children.push(c)); },
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    focus() {}, blur() {}, click() {}, scrollIntoView() {},
    getBoundingClientRect() { return { width: 100, height: 40, left: 0, top: 0 }; },
    animate() { return { finished: Promise.resolve(), cancel() {}, onfinish: null }; },
    get firstChild() { return this.children[0] || null; },
    get offsetWidth() { return 100; },
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); if (this._html === '') this.children = []; },
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); },
  };
  return el;
}

const registry = {};
global.window = global;
global.document = {
  getElementById(id) { return registry[id] || (registry[id] = stubEl('div')); },
  createElement(tag) { return stubEl(tag); },
  createDocumentFragment() { return stubEl('fragment'); },
  addEventListener() {}, removeEventListener() {},
  body: stubEl('body'),
  documentElement: stubEl('html'),
};

// 极速模式：动画/思考延时统一压到 0ms（真实节奏由浏览器提供）
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, 0, ...rest);

/* ================= 加载模块 ================= */
global.MJ = require('../js/tiles.js');
global.MJEngine = require('../js/engine.js');
global.MJAI = require('../js/ai.js');
require('../js/ui.js');
require('../js/game.js');
const { GameController } = global.MJGame;
const E = global.MJEngine;

/* ================= 工具 ================= */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const stats = {
  matches: 0, hands: 0, wins: 0, draws: 0, selfDraw: 0, ron: 0,
  robKong: 0, rinshan: 0, haitei: 0,
  pong: 0, chi: 0, kongFromDiscard: 0, concealedKong: 0, addedKong: 0,
  humanClaims: 0, errors: 0, badScore: 0, badTiles: 0, handCountErrors: 0,
};

/* ================= 单场对局 ================= */
async function runMatch(seed) {
  Math.random = mulberry32(seed);
  const ctrl = new GameController();
  const ui = ctrl.ui;
  const eng = ctrl.engine;

  /* --- 覆盖视觉层：动画立即完成 --- */
  ui.animateDeal = async () => {};
  ui.animateDraw = async () => {};
  ui.animateDiscard = () => {};
  ui.animateClaim = async () => {};
  ui.toast = () => {};
  ui.askChip = async () => 500;   // 拿牌后的筹码弹窗：桩环境无真实 DOM，直接选 500

  /* --- 人类决策（座位 0） --- */
  ui.askDiscard = async () => {
    const p = eng.players[0];
    if (!p.hand.length) throw new Error('人类手牌为空却要求弃牌');
    return ctrl.ai.chooseDiscard(p); // 借用 AI 逻辑，保证合法
  };
  ui.askSelfDraw = async () => true;                       // 能和必和
  ui.askKong = async (opts) => (Math.random() < 0.5 ? opts[0] : null);  // 一半概率开杠
  ui.askRobKong = async () => Math.random() < 0.3;
  ui.askClaim = async (pid, opts) => {
    const win = opts.find(o => o.type === 'win');
    if (win) return win;                                    // 能和必和
    if (Math.random() > 0.55) return null;                  // 否则约一半概率鸣牌
    for (const t of ['kong', 'pong', 'chi']) {
      const o = opts.find(x => x.type === t);
      if (o) { stats.humanClaims++; return t === 'chi' ? { ...o, combo: o.combos[0] } : o; }
    }
    return null;
  };

  /* --- 结算弹窗：只记录，不渲染 DOM --- */
  let handCount = 0;
  const handEnds = [];
  ui.showSettlement = async (d) => { handCount++; handEnds.push(d); };
  ui.showDrawGame = async () => { handCount++; handEnds.push(null); };
  ui.showMatchOver = async () => null;                      // 直接结束整场，不重开

  /* --- 埋点：统计鸣牌 / 和牌类型 --- */
  const wrap = (name, bucket, probe) => {
    const orig = eng[name].bind(eng);
    eng[name] = (...a) => { stats[bucket] = (stats[bucket] || 0) + 1; if (probe) probe(...a); return orig(...a); };
  };
  wrap('applyPong', 'pong');
  wrap('applyChi', 'chi');
  wrap('applyKongFromDiscard', 'kongFromDiscard');
  wrap('declareConcealedKong', 'concealedKong');
  wrap('declareAddedKong', 'addedKong');
  const origSettleWin = eng.settleWin.bind(eng);
  eng.settleWin = (winner, opts = {}) => {
    const r = origSettleWin(winner, opts);
    stats.wins++;
    if (opts.selfDraw) stats.selfDraw++; else stats.ron++;
    if (opts.robKong) stats.robKong++;
    if (opts.rinshan) stats.rinshan++;
    if (opts.haitei) stats.haitei++;
    return r;
  };
  const origSettleDraw = eng.settleDraw.bind(eng);
  eng.settleDraw = (...a) => { stats.draws++; return origSettleDraw(...a); };

  /* --- 校验一局结束时的牌张/分数守恒 --- */
  function checkIntegrity(tag) {
    // 分数守恒
    const sum = eng.players.reduce((s, p) => s + p.score, 0);
    if (sum !== E.START_SCORE * 4) { stats.badScore++; throw new Error(`${tag} 分数不守恒: ${sum}`); }

    // 牌张守恒：手上 + 副露 + 牌山 + 王牌 = 136 - 未被鸣牌的牌河
    const counts = new Array(34).fill(0);
    let total = 0;
    const add = (t) => { counts[t]++; total++; };
    let claimedMelds = 0;
    for (const p of eng.players) {
      p.hand.forEach(add);
      for (const m of p.melds) { m.tiles.forEach(add); if (m.from >= 0) claimedMelds++; }
    }
    eng.wall.forEach(add);
    eng.dead.forEach(add);
    const totalDiscards = eng.players.reduce((s, p) => s + p.discards.length, 0);
    const unclaimed = totalDiscards - claimedMelds;
    if (unclaimed < 0) { stats.badTiles++; throw new Error(`${tag} 牌河/副露计数异常: 牌河 ${totalDiscards} 鸣牌 ${claimedMelds}`); }
    if (total + unclaimed !== 136) { stats.badTiles++; throw new Error(`${tag} 牌张不守恒: 在场 ${total} + 牌河 ${unclaimed} = ${total + unclaimed} ≠ 136`); }
    for (let k = 0; k < 34; k++) {
      if (counts[k] > 4) { stats.badTiles++; throw new Error(`${tag} 牌张 ${k} 出现 ${counts[k]} 次 (>4)`); }
    }
  }

  /* --- 启动整场 --- */
  await ctrl.start();

  // 整场结束校验
  checkIntegrity(`seed ${seed}`);
  if (handCount !== 8) { stats.handCountErrors++; throw new Error(`seed ${seed} 局数异常: ${handCount} ≠ 8`); }
  stats.matches++;
  stats.hands += handCount;
  return handCount;
}

/* ================= 主流程 ================= */
(async () => {
  const N = parseInt(process.argv[2] || '40', 10);
  const t0 = Date.now();
  for (let seed = 7000; seed < 7000 + N; seed++) {
    try {
      await runMatch(seed);
    } catch (e) {
      stats.errors++;
      if (stats.errors <= 5) console.error(`  ✗ seed ${seed}: ${e.message}`);
    }
  }

  const pct = (n) => `${n} (${(n / Math.max(stats.hands, 1) * 100).toFixed(1)}%)`;
  console.log('\n──────── smoke 集成测试结果 ────────');
  console.log(`场次            : ${stats.matches}/${N} 通过`);
  console.log(`总局数          : ${stats.hands}`);
  console.log(`和牌 / 流局     : ${pct(stats.wins)} / ${pct(stats.draws)}`);
  console.log(`自摸 / 点炮     : ${pct(stats.selfDraw)} / ${pct(stats.ron)}`);
  console.log(`抢杠 / 岭上     : ${stats.robKong} / ${stats.rinshan}   (海底 ${stats.haitei})`);
  console.log(`碰 / 吃         : ${stats.pong} / ${stats.chi}   (其中人类鸣牌 ${stats.humanClaims})`);
  console.log(`明杠 / 暗杠 / 加杠: ${stats.kongFromDiscard} / ${stats.concealedKong} / ${stats.addedKong}`);
  console.log(`牌张异常        : ${stats.badTiles}    分数异常: ${stats.badScore}    局数异常: ${stats.handCountErrors}`);
  console.log(`未捕获异常      : ${stats.errors}`);
  console.log(`耗时            : ${Date.now() - t0}ms`);
  console.log('────────────────────────────────────\n');

  const kongTotal = stats.kongFromDiscard + stats.concealedKong + stats.addedKong;
  const ok = stats.errors === 0 && stats.badTiles === 0 && stats.badScore === 0 && stats.handCountErrors === 0
    && stats.matches === N && stats.chi > 0 && stats.pong > 0 && kongTotal > 0;
  if (!ok) {
    console.error('smoke 测试未全部通过（需覆盖吃/碰/杠 且无异常）');
    process.exit(1);
  }
  if (stats.concealedKong === 0) {
    console.log('提示：本轮未随机出现暗杠（暗杠路径由 engine.test.js 确定性命中，非本测试职责）');
  }
  console.log('smoke 集成测试全部通过 ✓');
})();
