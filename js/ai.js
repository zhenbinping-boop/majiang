/**
 * ai.js - AI 对手决策 (强化版)
 *
 * 弃牌：
 *   1. 向听数优先 (每差一档的权重压倒其它一切)
 *   2. 其次「按全桌可见牌折算后的剩余有效进张」—同一手牌，别人打掉/碰掉的牌不再算进张
 *   3. 再次牌张固有价值 (对子、役牌、靠张)
 *   4. 放炮风险：自身向听较远且有人明显在做牌时，安全牌权重大幅提升 (现物 / 已见四张为绝对安全)
 *      听牌时有效进张即「剩余和牌张」，因此选最大听口是自动的。
 *
 * 鸣牌：和牌必取；向听有实质改善才鸣，已接近听牌 (≤1 向听) 时允许持平的提速鸣牌；
 *      追七对时不吃不碰不开杠。
 */
(function (global, factory) {
  const MJ = (typeof module !== 'undefined' && module.exports) ? require('./tiles.js') : global.MJ;
  const E = (typeof module !== 'undefined' && module.exports) ? require('./engine.js') : global.MJEngine;
  const api = factory(MJ, E);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.MJAI = api;
})(typeof self !== 'undefined' ? self : this, function (MJ, E) {
  'use strict';

  const { toCounts, shanten, effectiveTiles, isHonor, isTerminal } = { ...MJ, ...E };

  const TOTAL = 34;
  const TRIPLET_HONORS = { 31: 1, 32: 1, 33: 1 };  // 中 / 发 / 白

  function removeOne(tiles, t) {
    const a = tiles.slice();
    const i = a.indexOf(t);
    if (i >= 0) a.splice(i, 1);
    return a;
  }

  /**
   * 单张牌的固有保留价值 (越高越应留手)，仅用于同分决胜
   * @param opts { prevailingWind, seatWind }
   */
  function keepValue(t, counts, opts = {}) {
    const n = counts[t];
    if (n >= 3) return 100;
    if (n >= 2) {
      if (isHonor(t)) return 84;      // 字牌对：既是雀头也可能是役牌刻
      if (isTerminal(t)) return 52;
      return 60;
    }
    if (isHonor(t)) {
      if (TRIPLET_HONORS[t]) return 34;                            // 三元牌单张也值
      const w = t - 27;
      if (w === opts.prevailingWind || w === opts.seatWind) return 28;     // 场风 / 自风
      return 7;
    }
    if (isTerminal(t)) return 5;
    // 数牌：看邻张 (相邻价值高于间隔)
    const r = t % 9, s = t - r;
    let v = 6;
    for (const d of [-2, -1, 1, 2]) {
      const k = r + d;
      if (k < 0 || k > 8) continue;
      if (counts[s + k] > 0) v += (d === -1 || d === 1) ? 15 : 8;
    }
    return v;
  }

  class MahjongAI {
    constructor(engine) {
      this.engine = engine;
    }

    /* ==================== 局面评估 ==================== */

    /** 全桌可见牌计数：各家牌河 + 各家副露 (扣除从牌河鸣走的1张避免重复计数) + 自己手牌 */
    visibleCounts(self) {
      const c = new Array(TOTAL).fill(0);
      for (const p of this.engine.players) {
        for (const t of p.discards) c[t]++;
        for (const m of p.melds) {
          for (const t of m.tiles) c[t]++;
          if (m.from >= 0 && m.tile !== undefined) c[m.tile]--;
        }
      }
      if (self) for (const t of self.hand) c[t]++;
      return c;
    }

    /**
     * 扣除可见牌后的真实进张。
     * 注意：向听为 0 时 effectiveTiles 统计的正是「和牌张」，故听牌时 total 即剩余听口张数。
     */
    liveUkeire(tiles, meldCount, visible) {
      const eff = effectiveTiles(tiles, meldCount);
      const live = {};
      let total = 0;
      for (const k in eff.good) {
        const t = +k;
        const left = Math.max(0, 4 - visible[t]);
        if (left > 0) { live[t] = left; total += left; }
      }
      return { shanten: eff.shanten, total, live };
    }

    /** 吃/碰后需紧接着打出一张手牌：仅对能维持最小向听的候选舍牌计算真实进张 */
    bestAfterClaimDiscard(rest, newMeldCount, visible) {
      const candidates = [];
      let minS = 8;
      const seen = new Set();
      for (const d of rest) {
        if (seen.has(d)) continue;
        seen.add(d);
        const afterD = removeOne(rest, d);
        const s = shanten(afterD, newMeldCount);
        if (s < minS) {
          minS = s;
          candidates.length = 0;
          candidates.push(afterD);
        } else if (s === minS) {
          candidates.push(afterD);
        }
      }
      let best = { shanten: minS, total: 0, live: {} };
      for (const afterD of candidates) {
        const r = this.liveUkeire(afterD, newMeldCount, visible);
        if (r.total > best.total) best = r;
      }
      return best;
    }

    /** 某家的压迫感 (0~1)：副露越多、牌河越接近终盘，越可能已听牌 */
    threatLevel(p) {
      const meld = Math.min(p.melds.length, 3) / 3;
      const late = Math.min(Math.max(p.discards.length - 5, 0), 12) / 12;
      return Math.min(1, meld * 0.72 + late * 0.5);
    }

    maxThreat(selfId) {
      let m = 0;
      for (const p of this.engine.players) {
        if (p.id === selfId) continue;
        if (this.threatLevel(p) > m) m = this.threatLevel(p);
      }
      return m;
    }

    /** 打出该牌放炮的风险：0 绝对安全 ~ 90 很危险 */
    dangerOf(tile, visible, selfId) {
      if (visible[tile] >= 4) return 0;                             // 四张全见，和不了
      let total = 0;
      for (const p of this.engine.players) {
        if (p.id === selfId) continue;
        if (p.discards.indexOf(tile) !== -1) continue;     // 对该家是现物
        const pressure = this.threatLevel(p);
        if (pressure <= 0.12) continue;
        let base;
        if (isHonor(tile)) base = 20;                      // 字牌相对安全
        else {
          const r = tile % 9;
          base = (r === 0 || r === 8) ? 15 : (r === 1 || r === 7 ? 25 : 40);
        }
        total += base * pressure;
      }
      return Math.min(90, total);
    }

    /** 确定性微扰：同分时不再永远打第一张，同时保证结果可复现 */
    tieBreak(t) {
      return (((t * 2654435761) >>> 0) % 97) / 97;
    }

    /* ==================== 决策：弃牌 ==================== */

    /** 摸牌 / 轮到自己后选择弃牌 (两阶段评估：先筛最小向听，再算精确有效进张) */
    chooseDiscard(player) {
      const hand = player.hand;
      if (!hand || !hand.length) return null;
      const meldCount = player.melds.length;
      const counts = toCounts(hand);
      const visible = this.visibleCounts(player);
      const opts = {
        prevailingWind: this.engine.prevailingWind || 0,
        seatWind: player.wind,
      };
      const aggressive = this.maxThreat(player.id);

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

      let best = null, bestScore = -Infinity;
      for (const { t, rest, s } of items) {
        // 向听差一档相差 1000 分，大于进张+防守最大分差，因此仅需对最小向听档精确计算 liveUkeire
        const uke = (s === minS) ? this.liveUkeire(rest, meldCount, visible).total : 0;
        const danger = this.dangerOf(t, visible, player.id);
        const keep = keepValue(t, counts, opts);

        let score = (6 - s) * 1000 + uke * 12 - keep * 1.2;
        const defending = s >= 2 && aggressive > 0.5;
        score -= danger * (defending ? 5.5 : 0.5);
        score += this.tieBreak(t) * 0.5;

        if (score > bestScore) { bestScore = score; best = t; }
      }
      return best === null ? hand[hand.length - 1] : best;
    }

    /* ==================== 鸣牌 ==================== */

    /** 是否追七对 (无副露且七对路线明显更近) */
    pursuingSeven(player) {
      if (player.melds.length > 0) return false;
      const counts = toCounts(player.hand);
      const pairs = counts.filter(n => n >= 2).length;
      if (pairs < 4) return false;
      const s7 = E.shantenSeven ? E.shantenSeven(counts) : 6 - pairs;
      const normal = E.shantenNormal ? E.shantenNormal(counts, 0) : shanten(player.hand, 0);
      return s7 < normal;
    }

    /** 对别人弃牌的鸣牌决策；options 已按优先级排序，返回采用的选项或 null */
    decideClaim(options, player) {
      const win = options.find(o => o.type === 'win');
      if (win) return win;                                           // 能和必和

      const meldCount = player.melds.length;
      const current = shanten(player.hand, meldCount);
      if (this.pursuingSeven(player)) return null;                   // 追七对时不吃不碰不开杠
      const visible = this.visibleCounts(player);
      const nearWin = current <= 1;                                  // 已接近听牌 → 允许提速型鸣牌

      for (const opt of options) {
        if (opt.type === 'kong') {
          const rest = removeOne(removeOne(removeOne(player.hand, opt.tile), opt.tile), opt.tile);
          if (shanten(rest, meldCount + 1) > current) continue;
          const a = this.liveUkeire(rest, meldCount + 1, visible);
          if (a.shanten <= current && a.total > 0) return opt;      // 杠后有岭上摸牌 + 杠分
        } else if (opt.type === 'pong') {
          const rest = removeOne(removeOne(player.hand, opt.tile), opt.tile);
          const allowEqual = isHonor(opt.tile) || nearWin;
          const sFast = shanten(rest, meldCount + 1);
          if (sFast > current || (sFast === current && !allowEqual)) continue;
          const a = this.bestAfterClaimDiscard(rest, meldCount + 1, visible);
          if (a.shanten < current && a.total > 0) return opt;
          if (a.shanten === current && a.total > 0 && allowEqual) return opt;
        } else if (opt.type === 'chi') {
          const combos = opt.combos || [];
          let bestCombo = null, bestEval = null;
          for (const combo of combos) {
            const rest = removeOne(removeOne(player.hand, combo[0]), combo[1]);
            const sFast = shanten(rest, meldCount + 1);
            if (sFast > current || (sFast === current && !nearWin)) continue;
            const a = this.bestAfterClaimDiscard(rest, meldCount + 1, visible);
            if (!bestEval || a.shanten < bestEval.shanten || (a.shanten === bestEval.shanten && a.total > bestEval.total)) {
              bestEval = a;
              bestCombo = combo;
            }
          }
          if (!bestCombo || !bestEval) continue;
          if (bestEval.shanten < current && bestEval.total > 0) return { ...opt, combo: bestCombo };
          if (nearWin && bestEval.shanten === current && bestEval.total > 0) return { ...opt, combo: bestCombo };
        }
      }
      return null;
    }

    /** 自己回合是否暗杠/加杠，返回 { kind:'concealed'|'added', tile } 或 null */
    decideKong(player) {
      const meldCount = player.melds.length;
      if (this.pursuingSeven(player)) return null;                  // 追七对时不开杠

      const visible = this.visibleCounts(player);
      const current = shanten(player.hand, meldCount);
      // 暗杠：向听不劣化即可 (额外岭上摸牌 + 杠分)
      for (const t of this.engine.findConcealedKongs(player)) {
        const rest = player.hand.filter(x => x !== t);
        const a = this.liveUkeire(rest, meldCount + 1, visible);
        if (a.shanten <= current) return { kind: 'concealed', tile: t };
      }
      // 加杠：几乎总是赚 (多一张岭上牌)，能加就加
      for (const t of this.engine.findAddedKongs(player)) {
        return { kind: 'added', tile: t };
      }
      return null;
    }

    /** 抢杠决策 */
    decideRobKong(player, tile) {
      return this.engine.canWin(player, tile);
    }
  }

  return { MahjongAI, keepValue };
});
