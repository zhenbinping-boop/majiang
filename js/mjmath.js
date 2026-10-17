/**
 * mjmath.js - 军师数学内核 (L1 计算层，免费军师模式共用)
 *
 * 职责：对「我方手牌 × 桌面信息」做纯函数评估，产出每张候选弃牌的
 *   { 向听数, 真实进张(种类/张数), 和了率, 危险度, 综合评分 }
 * 以及攻防建议（进攻 / 平衡 / 防守）。引擎无关（不依赖 MahjongGame 实例），
 * ai.js 与 ui.js 军师面板共用同一套数字，保证「AI 怎么想」与「军师怎么说」一致。
 *
 * 数学依据 (docs/mahjong-math-research.html)：
 *   - 向听数：8 − 2×面子 − 搭子 − 雀头 (engine.js 已验证实现)
 *   - 真实进张：有效进张 × (4 − 全桌可见张)，别人打掉/副露的不算
 *   - 和了率：1 − (1 − 进张/未见牌)^剩余摸牌次数   [几何分布近似]
 *   - 危险度：现物/四张全见 = 绝对安全；无筋字牌 < 无筋端牌 < 无筋中张，
 *     按各家威胁度 (副露数 × 巡目) 加权累计
 *   - 综合评分：向听一档压倒一切 (×1000)，其次进张、保留价值、放炮惩罚
 */
(function (global, factory) {
  const MJ = (typeof module !== 'undefined' && module.exports) ? require('./tiles.js') : global.MJ;
  const E = (typeof module !== 'undefined' && module.exports) ? require('./engine.js') : global.MJEngine;
  const api = factory(MJ, E);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.MJMath = api;
})(typeof self !== 'undefined' ? self : this, function (MJ, E) {
  'use strict';

  const { toCounts, shanten, effectiveTiles, isHonor, isTerminal } = { ...MJ, ...E };

  const TOTAL_KINDS = 34;
  const TOTAL_TILES = 136;              // 34 种 × 4
  const TRIPLET_HONORS = { 31: 1, 32: 1, 33: 1 };   // 中 / 发 / 白
  const DRAW_SEAT = 4;                  // 四家轮摸 → 剩余摸牌次数 ≈ 余牌 / 4

  function removeOne(tiles, t) {
    const a = tiles.slice();
    const i = a.indexOf(t);
    if (i >= 0) a.splice(i, 1);
    return a;
  }

  /* ==================== 进张 (ukeire) ==================== */

  /**
   * 真实进张：扣除全桌可见牌后的有效进张。
   * @param {number[]} tiles  手牌 (13/14 张，14 张时调用方自行先扣 1)
   * @param {number}   meldCount 副露组数
   * @param {number[]} visible   34 长度全桌可见计数 (牌河+副露+我手牌)
   * @returns {{shanten:number, kinds:number, total:number, live:Object}}
   */
  function ukeireOf(tiles, meldCount, visible) {
    const eff = effectiveTiles(tiles, meldCount);
    const live = {};
    let total = 0, kinds = 0;
    for (const k in eff.good) {
      const t = +k;
      const left = Math.max(0, 4 - (visible[t] || 0));
      if (left > 0) { live[t] = left; total += left; kinds++; }
    }
    return { shanten: eff.shanten, kinds, total, live };
  }

  /* ==================== 危险度 (0 安全 ~ 90 极危) ==================== */

  /** 单张威胁：无筋中张 40 > 无筋端边 25 > 无筋端数 15 > 字牌 20 */
  function tileDangerBase(t) {
    if (isHonor(t)) return 20;
    const r = t % 9;
    return (r === 0 || r === 8) ? 15 : (r === 1 || r === 7 ? 25 : 40);
  }

  /**
   * 打出该牌的放炮风险。
   * @param {number} tile     候选弃牌
   * @param {Object} ctx { visible:number[], opponents:[{discards:number[], threat:number}] }
   *   threat ∈ [0,1]：副露越多、牌河越深威胁越大 (ai.threatLevel 同构)
   */
  function dangerOf(tile, ctx) {
    const { visible, opponents } = ctx;
    if ((visible[tile] || 0) >= 4) return 0;              // 四张全见，和不了
    let total = 0;
    for (const p of opponents) {
      if (!p) continue;
      if (p.discards && p.discards.indexOf(tile) !== -1) continue;  // 对该家是现物
      const threat = p.threat || 0;
      if (threat <= 0.12) continue;                        // 太前期，无炮可放
      total += tileDangerBase(tile) * threat;
    }
    return Math.min(90, Math.round(total));
  }

  /** 危险度 → 文案分级 */
  function dangerLevel(d) {
    if (d <= 0) return { label: '安全', cls: 'safe' };
    if (d < 20) return { label: '低', cls: 'low' };
    if (d < 45) return { label: '中', cls: 'mid' };
    return { label: '高', cls: 'high' };
  }

  /* ==================== 和了率 ==================== */

  /**
   * 剩余摸牌次数内至少摸到一次进张的概率 (几何分布近似，忽略他家摸走的二次修正)。
   * @param {number} ukeTotal  真实进张总张数
   * @param {number} unseen    我视角未见牌张数 (含他家手牌与牌山)
   * @param {number} drawsLeft 我剩余摸牌次数
   */
  function winRate(ukeTotal, unseen, drawsLeft) {
    if (ukeTotal <= 0 || drawsLeft <= 0 || unseen <= 0) return 0;
    const p = Math.min(1, ukeTotal / unseen);
    const r = 1 - Math.pow(1 - p, drawsLeft);
    return Math.max(0, Math.min(1, r));
  }

  /** 我视角未见牌数 = 136 − 全桌可见 (牌河+副露+我手牌) */
  function unseenCount(visible) {
    let seen = 0;
    for (let t = 0; t < TOTAL_KINDS; t++) seen += visible[t] || 0;
    return Math.max(0, TOTAL_TILES - seen);
  }

  /* ==================== 保留价值 (同分决胜) ==================== */

  /**
   * 单张固有保留价值 (越高越该留)。与 ai.keepValue 同构：
   * 刻子/雀头潜力 > 对子 > 靠张连张潜力 > 孤张字牌/端牌。
   */
  function keepValue(t, counts, opts = {}) {
    const n = counts[t];
    if (n >= 3) return 100;
    if (n >= 2) {
      if (isHonor(t)) return 84;
      if (isTerminal(t)) return 52;
      return 60;
    }
    if (isHonor(t)) {
      if (TRIPLET_HONORS[t]) return 34;
      const w = t - 27;
      if (w === opts.prevailingWind || w === opts.seatWind) return 28;
      return 7;
    }
    if (isTerminal(t)) return 5;
    const r = t % 9, s = t - r;
    let v = 6;
    for (const d of [-2, -1, 1, 2]) {
      const k = r + d;
      if (k < 0 || k > 8) continue;
      if (counts[s + k] > 0) v += (d === -1 || d === 1) ? 15 : 8;
    }
    return v;
  }

  /** 确定性微扰：同分时结果可复现 (与 ai.tieBreak 同构) */
  function tieBreak(t) {
    return (((t * 2654435761) >>> 0) % 97) / 97;
  }

  /* ==================== 综合分析 ==================== */

  /**
   * 全手牌弃牌评估。纯函数：不依赖引擎实例。
   * @param {Object} input
   *   hand          我方手牌 (14−3×副露 张，含刚摸的牌)
   *   meldCount     副露组数
   *   visible       全桌可见 34 计数
   *   opponents     [{discards, threat}] 三家威胁信息
   *   wallLeft      牌山+王牌剩余可摸数
   *   prevailingWind / seatWind  场风自风 (keepValue 用)
   * @returns {{shanten, mode, defending, drawsLeft, unseen, best, top}}
   *   best/top 候选: {tile, shanten, kinds, uke, winRate, danger, dangerLv, score}
   */
  function analyzeHand(input) {
    const {
      hand, meldCount = 0, visible, opponents = [],
      wallLeft = 70, prevailingWind = 0, seatWind = 0,
    } = input;
    if (!hand || !hand.length) return null;

    const counts = toCounts(hand);
    const unseen = unseenCount(visible);
    const drawsLeft = Math.max(0, Math.ceil(wallLeft / DRAW_SEAT));
    let maxThreat = 0;
    for (const p of opponents) if (p && p.threat > maxThreat) maxThreat = p.threat;

    const opts = { prevailingWind, seatWind };
    const items = [];
    let minS = 8;
    const seen = new Set();
    for (const t of hand) {
      if (seen.has(t)) continue;
      seen.add(t);
      const rest = removeOne(hand, t);
      const s = shanten(rest, meldCount);
      if (s < minS) minS = s;
      items.push({ t, rest, s });
    }

    const defending = minS >= 2 && maxThreat > 0.5;
    const dangerPenalty = defending ? 5.5 : 0.5;

    const candidates = [];
    for (const { t, rest, s } of items) {
      // 向听差一档压倒其它分差 → 仅对最小向听档精算进张与和了率
      const u = (s === minS)
        ? ukeireOf(rest, meldCount, visible)
        : { shanten: s, kinds: 0, total: 0, live: {} };
      const danger = dangerOf(t, { visible, opponents });
      const keep = keepValue(t, counts, opts);
      const score = (6 - s) * 1000 + u.total * 12 - keep * 1.2
        - danger * dangerPenalty + tieBreak(t) * 0.5;
      candidates.push({
        tile: t,
        shanten: s,
        kinds: u.kinds,
        uke: u.total,
        winRate: (s === minS) ? winRate(u.total, unseen, drawsLeft) : 0,
        danger,
        dangerLv: dangerLevel(danger),
        score: Math.round(score * 10) / 10,
        keep,
      });
    }
    candidates.sort((a, b) => b.score - a.score);

    const best = candidates[0];
    const mode = defending ? 'defend' : (minS <= 1 ? 'attack' : 'balance');
    return {
      shanten: minS,
      mode, defending,
      drawsLeft, unseen,
      best,
      top: candidates.slice(0, 3),
      all: candidates,
    };
  }

  /** 军师一句话建议文案 */
  function adviceText(a) {
    if (!a || !a.best) return '';
    const b = a.best;
    const modeTxt = a.mode === 'defend' ? '他家做牌凶，优先安全牌'
      : a.mode === 'attack' ? '进度不错，按最大进张进攻'
      : '稳扎稳打，向听优先';
    return `建议打 ${MJ.tileName(b.tile)} · 进张 ${b.kinds} 种 ${b.uke} 张 · 和率 ${(b.winRate * 100).toFixed(0)}% · 危险 ${b.dangerLv.label} — ${modeTxt}`;
  }

  return {
    ukeireOf, dangerOf, dangerLevel, tileDangerBase,
    winRate, unseenCount, keepValue, tieBreak,
    analyzeHand, adviceText,
    TOTAL_TILES,
  };
});
