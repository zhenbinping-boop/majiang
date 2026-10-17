/**
 * economy.js — 局外代币经济系统
 *
 * 设计定位（合规红线，务必保持）：
 *   代币为**纯虚拟**积分 —— 不可充值、不可提现、不可转赠，
 *   数值仅存 localStorage，仅用于局内皮肤解锁与牌局体验。
 *
 * 结构：
 *   - 资金：初始 50 万代币（外置、可成长 —— 随每局输赢累积/消耗）。
 *   - 筹码：每次开小局拿到牌后选择（100 / 500 / 1500），筹码即本局底注 ——
 *     局内金币结算与局外代币共用同一套数值（局内外共享）。
 *   - 实时结算：每小局结束按玩家本局金币变动直接写入钱包（赢钱 / 输钱即时到账），
 *     名次只在总结算展示，不影响代币。
 *   - 破产补助：余额 < 2,000 时补到 20,000，每日一次（按本地日期）。
 *   - 皮肤解锁：竹韵翡翠免费；深海鎏金 8,000、紫檀玄金 15,000。
 */
(function (global) {
  'use strict';

  var LS_COINS = 'mj-coins';
  var LS_UNLOCKED = 'mj-unlocked';
  var LS_RELIEF = 'mj-relief';

  /** 本局筹码选项（拿到牌后弹窗选择，内存态、不持久化 —— 每小局都要选） */
  var CHIPS = [100, 500, 1500];
  var chip = 500;
  var START_COINS = 500000;
  var RELIEF_BELOW = 2000;
  var RELIEF_TO = 20000;

  /** 皮肤目录（swatch 用于面板色卡） */
  var SKINS = {
    jade:   { name: '竹韵翡翠', price: 0,     swatch: '#0c3b2e' },
    ocean:  { name: '深海鎏金', price: 8000,  swatch: '#0c1f3d' },
    sandal: { name: '紫檀玄金', price: 15000, swatch: '#2a1512' },
  };
  var SKIN_ORDER = ['jade', 'ocean', 'sandal'];

  /* ---------- localStorage 安全读写（隐私模式 / 禁存储时静默降级为内存态） ---------- */

  function lsGet(key, fallback) {
    try {
      var v = global.localStorage.getItem(key);
      return v === null ? fallback : v;
    } catch (e) { return fallback; }
  }
  function lsSet(key, val) {
    try { global.localStorage.setItem(key, val); } catch (e) { /* ignore */ }
  }

  /* ---------- 余额 ---------- */

  var coins = parseInt(lsGet(LS_COINS, ''), 10);
  if (isNaN(coins) || coins < 0) coins = START_COINS;

  function getCoins() { return coins; }

  function addCoins(delta) {
    coins = Math.max(0, coins + Math.round(delta));
    lsSet(LS_COINS, String(coins));
    renderCoins();
    return coins;
  }

  /* ---------- 筹码（每小局拿到牌后选一次，内存态；筹码即本局底注） ---------- */

  function getChip() { return chip; }
  function setChip(v) {
    v = Math.round(v);
    if (CHIPS.indexOf(v) >= 0) chip = v;
    return chip;
  }

  /* ---------- 破产补助 ---------- */

  /** 余额过低时补到 RELIEF_TO，每日一次；返回补助金额（0 = 今日未触发/无需触发） */
  function maybeRelief() {
    if (coins >= RELIEF_BELOW) return 0;
    var today = new Date();
    var key = today.getFullYear() + '-' + (today.getMonth() + 1) + '-' + today.getDate();
    if (lsGet(LS_RELIEF, '') === key) return 0;
    lsSet(LS_RELIEF, key);
    var grant = RELIEF_TO - coins;
    addCoins(grant);
    return grant;
  }

  /* ---------- 皮肤解锁 ---------- */

  function ownedSkins() {
    try {
      var a = JSON.parse(lsGet(LS_UNLOCKED, ''));
      if (a && a.length && a.indexOf('jade') >= 0) return a;
    } catch (e) { /* ignore */ }
    return ['jade'];
  }
  function isUnlocked(id) { return ownedSkins().indexOf(id) >= 0; }

  /**
   * 购买皮肤：余额足够才扣款并解锁。
   * @returns {{ok:boolean, reason?:string}}
   */
  function unlockSkin(id) {
    if (!SKINS[id]) return { ok: false, reason: 'no-skin' };
    if (isUnlocked(id)) return { ok: false, reason: 'owned' };
    var price = SKINS[id].price;
    if (coins < price) return { ok: false, reason: 'poor' };
    addCoins(-price);
    var o = ownedSkins();
    o.push(id);
    lsSet(LS_UNLOCKED, JSON.stringify(o));
    return { ok: true };
  }

  /* ---------- DOM 渲染辅助（顶栏 / 主界面的代币与局级同步） ---------- */

  function fmt(n) {
    var v = Math.round(n) || 0;
    return String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /** 把余额同步到页面所有 [data-coin-val] 节点 */
  function renderCoins() {
    if (typeof document === 'undefined') return;
    var nodes = document.querySelectorAll('[data-coin-val]');
    for (var i = 0; i < nodes.length; i++) nodes[i].textContent = fmt(coins);
  }

  global.MJEconomy = {
    CHIPS: CHIPS,
    SKINS: SKINS, SKIN_ORDER: SKIN_ORDER,
    START_COINS: START_COINS,
    getCoins: getCoins, addCoins: addCoins,
    getChip: getChip, setChip: setChip,
    maybeRelief: maybeRelief,
    ownedSkins: ownedSkins, isUnlocked: isUnlocked, unlockSkin: unlockSkin,
    renderCoins: renderCoins,
    fmt: fmt,
  };
})(typeof window !== 'undefined' ? window : this);
