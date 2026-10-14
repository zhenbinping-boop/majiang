/**
 * engine.js - 麻将核心引擎 (纯逻辑，无 DOM 依赖)
 * 规则：大众化四人麻将 · 136 张 (无花牌)．吃/碰/明杠/暗杠/加杠/抢杠 · 4组+1对 与 七对
 * 结算：金币制 (无点数) — 底注 × 牌型倍率，牌型越大赔率越高 (高点法择优计番)
 * 可在 Node 中直接 require 进行自动化测试。
 */
(function (global, factory) {
  const MJ = (typeof module !== 'undefined' && module.exports) ? require('./tiles.js') : global.MJ;
  const api = factory(MJ);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.MJEngine = api;
})(typeof self !== 'undefined' ? self : this, function (MJ) {
  'use strict';

  const TOTAL = 34;
  const WALL_TILES = 122;    // 可摸牌数 (136 - 4×13 - 14 王牌)
  const DEAD_TILES = 14;     // 王牌 (岭上牌来源)

  /* ------------- 金币结算参数 -------------
   * 底注 5000 金币；每个牌型/状态各有一个倍率，最终倍率为各倍率之积 (封顶 ×500)。
   * 点炮：放炮者独付 底注×倍率；自摸：三家各付 底注×倍率÷2，赢家共得三份。
   */
  const BASE_BET = 5000;
  const START_SCORE = 500000;    // 开局金币
  const MULT_CAP = 500;          // 倍率封顶
  const COIN_UNIT = 100;         // 金币取整单位
  const KONG_COIN = { concealed: 5000, open: 2500 };  // 暗杠 / 明杠·加杠 每家付

  /** 赔率表 (展示顺序即为结算明细顺序) */
  const FAN_MULT = [
    { name: '平胡', mult: 1, desc: '基本和牌' },
    { name: '断幺九', mult: 1.5, desc: '全部为 2~8 数牌' },
    { name: '海底捞月', mult: 1.5, desc: '摸到最后一张和牌' },
    { name: '自摸', mult: 2, desc: '自己摸到和牌张' },
    { name: '门清', mult: 2, desc: '全程未吃碰未明杠' },
    { name: '三元牌', mult: 2, desc: '中/发/白 刻子' },
    { name: '三色同顺', mult: 2, desc: '万筒条同数字顺子各一组' },
    { name: '杠上开花', mult: 2, desc: '杠后岭上牌自摸' },
    { name: '抢杠', mult: 2, desc: '抢他人加杠的和牌' },
    { name: '一气通贯', mult: 2.5, desc: '同花色 123 + 456 + 789' },
    { name: '对对胡', mult: 3, desc: '四组刻子 (杠)' },
    { name: '三暗刻', mult: 3, desc: '三组暗刻' },
    { name: '混一色', mult: 3, desc: '一门数牌 + 字牌' },
    { name: '七对', mult: 6, desc: '七组对子' },
    { name: '清一色', mult: 8, desc: '全部为一门数牌' },
    { name: '龙七对', mult: 12, desc: '七对中含一组四张' },
  ];
  const MULT_OF = {};
  const DESC_OF = {};
  FAN_MULT.forEach(f => { MULT_OF[f.name] = f.mult; DESC_OF[f.name] = f.desc; });

  /** 金币取整 (向下取到 100 的整数倍，最低 100) */
  function roundCoins(n) {
    return Math.max(COIN_UNIT, Math.floor(n / COIN_UNIT) * COIN_UNIT);
  }

  /* ==================== 基础工具 ==================== */

  function toCounts(tiles) {
    const c = new Array(TOTAL).fill(0);
    for (const t of tiles) c[t]++;
    return c;
  }
  function cloneCounts(c) { return c.slice(); }
  function sortTiles(tiles) { return tiles.slice().sort((a, b) => a - b); }

  /* ==================== 和牌判定 ==================== */

  // counts 能否分解出 need 个面子 (顺子/刻子)
  function canFormSets(counts, need) {
    let i = 0;
    while (i < TOTAL && counts[i] === 0) i++;
    if (i === TOTAL) return need === 0;
    if (need === 0) return false;
    if (counts[i] >= 3) {
      counts[i] -= 3;
      const ok = canFormSets(counts, need - 1);
      counts[i] += 3;
      if (ok) return true;
    }
    if (i < 27 && i % 9 <= 6 && counts[i + 1] > 0 && counts[i + 2] > 0) {
      counts[i]--; counts[i + 1]--; counts[i + 2]--;
      const ok = canFormSets(counts, need - 1);
      counts[i]++; counts[i + 1]++; counts[i + 2]++;
      if (ok) return true;
    }
    return false;
  }

  function isSevenPairs(counts) {
    let sum = 0;
    for (let i = 0; i < TOTAL; i++) {
      if (counts[i] !== 0 && counts[i] !== 2 && counts[i] !== 4) return false;
      sum += counts[i];
    }
    return sum === 14;
  }

  /**
   * tiles: 手牌数组 (不含副露)，meldCount: 副露组数 (杠也算 1 组)
   * 手牌+副露总数须为 14。
   */
  function isWin(tiles, meldCount) {
    const need = 4 - meldCount;
    if (need < 0) return false;
    if (tiles.length + meldCount * 3 !== 14) return false;
    const counts = toCounts(tiles);
    for (let p = 0; p < TOTAL; p++) {
      if (counts[p] >= 2) {
        counts[p] -= 2;
        const ok = canFormSets(counts, need);
        counts[p] += 2;
        if (ok) return true;
      }
    }
    if (meldCount === 0 && isSevenPairs(counts)) return true;
    return false;
  }

  /** 枚举全部合法的面子分解，供高点法番型结算使用 */
  function collectAllSets(counts, need, out, all) {
    let i = 0;
    while (i < TOTAL && counts[i] === 0) i++;
    if (i === TOTAL) {
      if (need === 0) all.push(out.slice());
      return;
    }
    if (need === 0) return;
    if (counts[i] >= 3) {
      counts[i] -= 3;
      out.push({ type: 'pong', tile: i });
      collectAllSets(counts, need - 1, out, all);
      out.pop();
      counts[i] += 3;
    }
    if (i < 27 && i % 9 <= 6 && counts[i + 1] > 0 && counts[i + 2] > 0) {
      counts[i]--; counts[i + 1]--; counts[i + 2]--;
      out.push({ type: 'chi', tile: i });
      collectAllSets(counts, need - 1, out, all);
      out.pop();
      counts[i]++; counts[i + 1]++; counts[i + 2]++;
    }
  }

  /** 找出所有和牌方式 (用于结算展示与高点法番型分析)；melds 为副露 */
  function findWinForms(tiles, meldCount, melds = []) {
    const need = 4 - meldCount;
    const counts = toCounts(tiles);
    const forms = [];
    const meldSets = melds.map(m => ({ type: m.type === 'chi' ? 'chi' : 'pong', tile: m.tile }));
    for (let p = 0; p < TOTAL; p++) {
      if (counts[p] >= 2) {
        counts[p] -= 2;
        const allSets = [];
        collectAllSets(counts.slice(), need, [], allSets);
        for (const handSets of allSets) {
          forms.push({
            type: 'normal',
            pair: p,
            handSets,
            sets: handSets.concat(meldSets),
          });
        }
        counts[p] += 2;
      }
    }
    if (meldCount === 0 && isSevenPairs(counts)) {
      forms.push({ type: 'seven', pairs: counts.map((n, i) => (n ? i : -1)).filter(i => i >= 0) });
    }
    return forms;
  }

  /* ==================== 向听数 ==================== */

  const _shantenCache = new Map();
  const SHANTEN_CACHE_MAX = 25000;

  /**
   * 向听公式 (经随机手牌属性测试验证)：
   *   得分 = 2×面子 + min(雀头,1) + min(max(雀头-1,0) + 搭子, 4 - 面子)
   *   向听 = 8 - 最大得分
   * 优化：在当前牌种穷尽面子/雀头/搭子组合后直接推进至 i+1，并校验 4 张同牌不可单骑或双对拆解。
   */
  function shantenNormal(counts, meldCount) {
    const c = counts;
    const orig = counts.slice();
    const maxMentsu = 4 - meldCount;
    let best = 0;
    function rec(i, mentsu, pairs, tatsus) {
      if (best >= 9) return;
      while (i < TOTAL && c[i] === 0) i++;
      if (i === TOTAL) {
        const M = mentsu + meldCount;
        const p1 = Math.min(pairs, 1);
        const p2 = Math.max(pairs - 1, 0);
        let score = 2 * M + p1 + Math.min(p2 + tatsus, 4 - M);
        // 4 组面子且无雀头时，若唯一剩余单张在原手牌中已有 4 张 (已用 3 张作刻子)，则无法单骑成对
        if (M === 4 && pairs === 0) {
          let hasValidTanki = false, hasAnyLeft = false;
          for (let k = 0; k < TOTAL; k++) {
            if (c[k] > 0) {
              hasAnyLeft = true;
              if (orig[k] < 4) { hasValidTanki = true; break; }
            }
          }
          if (hasAnyLeft && !hasValidTanki) score = 7;
        }
        if (score > best) best = score;
        return;
      }
      const n = c[i];
      if (n >= 3 && mentsu < maxMentsu) {
        c[i] -= 3;
        rec(i, mentsu + 1, pairs, tatsus);
        c[i] += 3;
      }
      if (i < 27 && i % 9 <= 6 && c[i + 1] > 0 && c[i + 2] > 0 && mentsu < maxMentsu) {
        c[i]--; c[i + 1]--; c[i + 2]--;
        rec(i, mentsu + 1, pairs, tatsus);
        c[i]++; c[i + 1]++; c[i + 2]++;
      }
      // 同一牌种在一般形中最多取 1 对 (避免 4 张同牌被当成 2 对或 1 刻 + 1 对)
      if (n >= 2 && orig[i] - n < 2) {
        c[i] -= 2;
        rec(i, mentsu, pairs + 1, tatsus);
        c[i] += 2;
      }
      if (i < 27) {
        if (i % 9 <= 7 && c[i + 1] > 0) {
          c[i]--; c[i + 1]--;
          rec(i, mentsu, pairs, tatsus + 1);
          c[i]++; c[i + 1]++;
        }
        if (i % 9 <= 6 && c[i + 2] > 0) {
          c[i]--; c[i + 2]--;
          rec(i, mentsu, pairs, tatsus + 1);
          c[i]++; c[i + 2]++;
        }
      }
      rec(i + 1, mentsu, pairs, tatsus);
    }
    rec(0, 0, 0, 0);
    return 8 - best;
  }

  function shantenSeven(counts) {
    let pairs = 0, fours = 0;
    for (let i = 0; i < TOTAL; i++) {
      if (counts[i] >= 2) pairs++;
      if (counts[i] === 4) fours++;
    }
    return 6 - pairs - fours;
  }

  /** 手牌向听数 (-1 表示已和牌)；带容量上限缓存 */
  function shantenOf(counts, meldCount) {
    const sum = counts.reduce((a, b) => a + b, 0);
    if (sum + meldCount * 3 === 14 && isWinFromCounts(counts, meldCount)) return -1;
    const key = meldCount + ':' + counts.join(',');
    const hit = _shantenCache.get(key);
    if (hit !== undefined) return hit;
    let s = shantenNormal(counts, meldCount);
    if (meldCount === 0 && (sum === 13 || sum === 14)) {
      s = Math.min(s, shantenSeven(counts));
    }
    if (s < 0) s = 0; // 14 张非和牌状态 (如四副露+搭子) 按 0 处理
    if (_shantenCache.size >= SHANTEN_CACHE_MAX) _shantenCache.clear();
    _shantenCache.set(key, s);
    return s;
  }
  function shanten(tiles, meldCount) {
    return shantenOf(toCounts(tiles), meldCount);
  }
  function isWinFromCounts(counts, meldCount) {
    for (let p = 0; p < TOTAL; p++) {
      if (counts[p] >= 2) {
        counts[p] -= 2;
        const ok = canFormSets(counts, 4 - meldCount);
        counts[p] += 2;
        if (ok) return true;
      }
    }
    if (meldCount === 0 && isSevenPairs(counts)) return true;
    return false;
  }

  /** 有效进牌：某手牌状态下，哪些牌能降低向听数 (含剩余张数) */
  function effectiveTiles(tiles, meldCount) {
    const counts = toCounts(tiles);
    const base = shantenOf(counts, meldCount);
    const good = {};
    // 门清且七对向听占优时，任意单张亦可成对进张，不限于数牌邻张
    const checkAllForSeven = meldCount === 0 && shantenSeven(counts) <= base;
    for (let t = 0; t < TOTAL; t++) {
      if (counts[t] >= 4) continue;
      if (counts[t] === 0 && !checkAllForSeven) {
        if (t >= 27) continue; // 字牌无邻张概念
        const r = t % 9;
        let near = false;
        for (const d of [-2, -1, 1, 2]) {
          const k = r + d;
          if (k < 0 || k > 8) continue;
          if (counts[t - r + k] > 0) { near = true; break; }
        }
        if (!near) continue;
      }
      counts[t]++;
      const s = shantenOf(counts, meldCount);
      counts[t]--;
      if (s < base) good[t] = 4 - counts[t];
    }
    return { shanten: base, good };
  }

  /* ==================== 番型结算 ==================== */

  function suitOfSet(t) { return t < 27 ? Math.floor(t / 9) : -1; }

  /** 对单个和牌分解 form 计算番型与赔率 */
  function scoreSingleForm(ctx, form, hand, melds, allTiles) {
    const { winTile, selfDraw, rinshan, robKong, haitei } = ctx;
    const fans = [];
    const add = (name) => fans.push({ name, mult: MULT_OF[name] || 1, desc: DESC_OF[name] || '' });
    const isSeven = !!form && form.type === 'seven';

    // 平胡 (基础倍率)
    add('平胡');
    if (selfDraw) add('自摸');
    // 门清：无吃、无碰、无明杠 (暗杠不破坏门清)
    const hasOpenMeld = melds.some(m => m.type === 'chi' || m.type === 'pong' || (m.type === 'kong' && !m.concealed));
    if (!hasOpenMeld) add('门清');

    // 断幺九
    if (allTiles.every(t => !MJ.isTerminal(t) && !MJ.isHonor(t))) add('断幺九');

    // 组成刻子的牌 (含副露)，用于役牌判定
    const tripletTiles = melds.filter(m => m.type === 'pong' || m.type === 'kong').map(m => m.tile)
      .concat(form && form.type === 'normal' ? form.sets.filter(s => s.type === 'pong').map(s => s.tile) : []);

    // 对对胡 / 七对
    const meldAllTriplets = melds.every(m => m.type === 'pong' || m.type === 'kong');
    if (isSeven) {
      const handCounts = toCounts(hand);
      const hasFour = form.pairs.some(p => handCounts[p] === 4);
      add(hasFour ? '龙七对' : '七对');
    } else if (form && form.sets.every(s => s.type === 'pong') && meldAllTriplets) {
      add('对对胡');
    }

    // 三元牌: 中 / 发 / 白 刻子
    if (tripletTiles.some(t => t >= 31)) add('三元牌');

    // 清一色 / 混一色
    const suits = new Set(allTiles.filter(t => !MJ.isHonor(t)).map(t => suitOfSet(t)));
    if (suits.size === 1 && allTiles.every(t => MJ.isHonor(t) || suitOfSet(t) === [...suits][0])) {
      if (allTiles.some(t => MJ.isHonor(t))) add('混一色');
      else add('清一色');
    }

    // 一气通贯 / 三色同顺 / 三暗刻
    if (form && form.type === 'normal') {
      const handSets = form.handSets || form.sets;
      const allSeqs = form.sets.filter(s => s.type === 'chi').map(s => s.tile);
      for (let su = 0; su < 3; su++) {
        const has = r => allSeqs.some(t => suitOfSet(t) === su && t % 9 === r);
        if (has(0) && has(3) && has(6)) { add('一气通贯'); break; }
      }
      const byRank = {};
      allSeqs.forEach(t => { const k = t % 9; byRank[k] = byRank[k] || new Set(); byRank[k].add(suitOfSet(t)); });
      if (Object.values(byRank).some(s => s.size === 3)) add('三色同顺');

      let dark = melds.filter(m => m.type === 'kong' && m.concealed).length;
      let handPongs = handSets.filter(s => s.type === 'pong').length;
      // 点炮或抢杠和牌时，若和牌张非雀头且未参与顺子，则其所成的刻子为明刻，不计入暗刻
      if (!selfDraw && winTile !== undefined && winTile !== null) {
        const winInPair = form.pair === winTile;
        const winInSeq = handSets.some(s =>
          s.type === 'chi' && suitOfSet(s.tile) === suitOfSet(winTile) && winTile >= s.tile && winTile <= s.tile + 2
        );
        if (!winInPair && !winInSeq && handSets.some(s => s.type === 'pong' && s.tile === winTile)) {
          handPongs = Math.max(0, handPongs - 1);
        }
      }
      dark += handPongs;
      if (dark >= 3) add('三暗刻');
    }

    // 特殊和牌
    if (rinshan) add('杠上开花');
    if (robKong) add('抢杠');
    if (haitei) add('海底捞月');

    let totalMult = fans.reduce((p, f) => p * f.mult, 1);
    if (totalMult > MULT_CAP) totalMult = MULT_CAP;
    totalMult = Math.round(totalMult * 100) / 100;

    // 自摸三家各付一半 (含自摸加成)，点炮由放炮者独付
    const perPayer = roundCoins(BASE_BET * totalMult * (selfDraw ? 0.5 : 1));
    const gain = selfDraw ? perPayer * 3 : perPayer;
    return { fans, totalMult, baseBet: BASE_BET, perPayer, gain, form, isSeven };
  }

  /**
   * 计算和牌牌型与金币赔率 (高点法：遍历所有合法分解取最高倍率)
   */
  function evaluateFan(ctx) {
    const { player, winTile } = ctx;
    const hand = player.hand.concat([winTile]);
    const melds = player.melds;
    const allTiles = hand.concat(...melds.map(m => m.tiles));
    const forms = findWinForms(hand, melds.length, melds);
    if (!forms.length) {
      return scoreSingleForm(ctx, null, hand, melds, allTiles);
    }
    let best = null;
    for (const form of forms) {
      const cand = scoreSingleForm(ctx, form, hand, melds, allTiles);
      if (!best || cand.totalMult > best.totalMult || (cand.totalMult === best.totalMult && cand.fans.length > best.fans.length)) {
        best = cand;
      }
    }
    return best;
  }

  /* ==================== 对局引擎 ==================== */

  let __id = 0;

  class MahjongGame {
    /**
     * @param {Object} opts { rng, names:[4], onEvent }
     */
    constructor(opts = {}) {
      this.id = ++__id;
      this.rng = opts.rng || Math.random;
      this.names = opts.names || ['你', '小龙', '阿秀', '老陈'];
      this.onEvent = opts.onEvent || (() => {});
      this.players = [0, 1, 2, 3].map(i => ({
        id: i,
        name: this.names[i],
        isHuman: i === 0,
        hand: [],
        melds: [],
        discards: [],
        wind: 0,
        dealer: false,
        score: START_SCORE,
        lastDraw: null,
        lastDrawWasReplacement: false,
        lastDrawWasLast: false,
        tenpai: false,
      }));
      this.wall = [];
      this.dead = [];
      this.turn = 0;
      this.lastDiscard = null;
      this.lastDiscarder = -1;
      this.phase = 'idle'; // idle|play|claim|end
      this.handIndex = 0; // 0..7 -> 东1..南4
      this.dealer = 0;
      this.honba = 0;      // 本场数
      this.matchOver = false;
      this.lastKongInfo = null;
    }

    /* ---- 事件 ---- */
    emit(type, data) { this.onEvent(type, data); }

    /* ---- 牌墙 ---- */
    buildWall() {
      const wall = [];
      for (let i = 0; i < TOTAL; i++) for (let c = 0; c < 4; c++) wall.push(i);
      for (let i = wall.length - 1; i > 0; i--) {
        const j = Math.floor(this.rng() * (i + 1));
        [wall[i], wall[j]] = [wall[j], wall[i]];
      }
      this.dead = wall.splice(TOTAL * 4 - DEAD_TILES, DEAD_TILES);
      this.wall = wall; // 122 张
    }

    /* ---- 局/场管理 ---- */
    get roundName() {
      const windName = this.handIndex < 4 ? '东' : '南';
      const num = (this.handIndex % 4) + 1;
      return windName + num + '局' + (this.honba > 0 ? '·' + this.honba + '本场' : '');
    }
    get prevailingWind() { return this.handIndex < 4 ? 0 : 1; }

    startMatch() {
      this.players.forEach(p => { p.score = START_SCORE; });
      this.handIndex = 0;
      this.dealer = 0;
      this.honba = 0;
      this.matchOver = false;
      this.emit('matchStart', this.snapshot());
      this.startHand();
    }

    startHand() {
      if (this.matchOver) return;
      this.buildWall();
      this.players.forEach((p, i) => {
        p.hand = [];
        p.melds = [];
        p.discards = [];
        p.wind = (i - this.dealer + 4) % 4; // 庄家为东风
        p.dealer = i === this.dealer;
        p.lastDraw = null;
        p.lastDrawWasReplacement = false;
        p.lastDrawWasLast = false;
        p.tenpai = false;
      });
      for (let r = 0; r < 13; r++) {
        for (let i = 0; i < 4; i++) this.players[i].hand.push(this.wall.shift());
      }
      const dealerTile = this.wall.shift();
      this.players[this.dealer].hand.push(dealerTile); // 庄家 14 张
      this.players[this.dealer].lastDraw = dealerTile;
      this.players.forEach(p => { p.hand = sortTiles(p.hand); });
      this.turn = this.dealer;
      this.lastDiscard = null;
      this.lastDiscarder = -1;
      this.lastKongInfo = null;
      this.phase = 'play';
      this.emit('handStart', this.snapshot());
    }

    /* ---- 摸牌 ---- */
    /** replacement=true 表示岭上 (杠后摸牌，取自王牌) */
    drawTile(player, replacement = false) {
      const t = replacement ? this.dead.shift() : this.wall.shift();
      if (t === undefined) return null;
      player.hand.push(t);
      player.hand = sortTiles(player.hand);
      player.lastDraw = t;
      player.lastDrawWasReplacement = !!replacement;
      player.lastDrawWasLast = !replacement && this.wall.length === 0;
      return t;
    }

    /**
     * 回合开始时是否需要摸牌：
     * 庄家开局 (14 张) 与 碰/吃/杠 之后 (手牌 13-3×副露+1) 都已持有“那一张”，直接进入舍牌。
     */
    needsDraw(player) {
      return player.hand.length !== 13 - 3 * player.melds.length + 1;
    }

    /* ---- 弃和检测 ---- */
    canWin(player, extraTile) {
      return isWin(player.hand.concat(extraTile === undefined ? [] : [extraTile]), player.melds.length);
    }

    /** 当前手牌是否听牌 (向听 0) */
    isTenpai(player) {
      return shanten(player.hand, player.melds.length) === 0;
    }

    /** 刷新所有玩家的听牌标记 (用于流局展示与连庄判断) */
    updateTenpaiFlags() {
      this.players.forEach(p => { p.tenpai = this.isTenpai(p); });
    }

    /* ---- 弃牌 ---- */
    discard(player, tile) {
      const idx = player.hand.indexOf(tile);
      if (idx === -1) throw new Error('弃牌不在手牌中: ' + tile);
      player.hand.splice(idx, 1);
      player.discards.push(tile);
      this.lastDiscard = tile;
      this.lastDiscarder = player.id;
      this.phase = 'claim';
      this.emit('discard', { player: player.id, tile });
      return tile;
    }

    /* ---- 鸣牌概要 ---- */
    /** 计算某张弃牌能引发的全部鸣牌选项 (按优先级与逆时针座序排序) */
    claimOptions(discarder, tile) {
      const options = [];
      const nextSeat = (discarder + 1) % 4; // 下家 (仅下家可吃上家打出的牌)
      for (let i = 1; i <= 3; i++) {
        const p = this.players[(discarder + i) % 4];
        if (this.canWin(p, tile)) options.push({ player: p.id, type: 'win', tile });
        const cnt = p.hand.filter(t => t === tile).length;
        if (cnt >= 3) options.push({ player: p.id, type: 'kong', tile, from: discarder });
        if (cnt >= 2) options.push({ player: p.id, type: 'pong', tile, from: discarder });
        if (p.id === nextSeat && tile < 27) {
          const r = tile % 9;
          const combos = [];
          if (r >= 2 && p.hand.includes(tile - 2) && p.hand.includes(tile - 1)) combos.push([tile - 2, tile - 1]);
          if (r >= 1 && r <= 7 && p.hand.includes(tile - 1) && p.hand.includes(tile + 1)) combos.push([tile - 1, tile + 1]);
          if (r <= 6 && p.hand.includes(tile + 1) && p.hand.includes(tile + 2)) combos.push([tile + 1, tile + 2]);
          if (combos.length) options.push({ player: p.id, type: 'chi', tile, from: discarder, combos });
        }
      }
      const rank = { win: 0, kong: 1, pong: 2, chi: 3 };
      const dist = (pid) => (pid - discarder + 4) % 4;
      options.sort((a, b) => rank[a.type] - rank[b.type] || dist(a.player) - dist(b.player));
      return options;
    }

    /* ---- 鸣牌执行 ---- */
    _removeTiles(player, tiles) {
      for (const t of tiles) {
        const i = player.hand.indexOf(t);
        if (i === -1) throw new Error('手牌中找不到 ' + t);
        player.hand.splice(i, 1);
      }
    }

    applyPong(claimer) {
      const tile = this.lastDiscard;
      this._removeTiles(this.players[claimer], [tile, tile]);
      this.players[claimer].melds.push({ type: 'pong', tile, tiles: [tile, tile, tile], from: this.lastDiscarder });
      this._afterClaim(claimer);
      this.emit('pong', { player: claimer, tile });
    }

    applyChi(claimer, combo) {
      const tile = this.lastDiscard;
      this._removeTiles(this.players[claimer], combo);
      const tiles = sortTiles([tile, combo[0], combo[1]]);
      this.players[claimer].melds.push({ type: 'chi', tile, tiles, from: this.lastDiscarder });
      this._afterClaim(claimer);
      this.emit('chi', { player: claimer, tile });
    }

    applyKongFromDiscard(claimer) {
      const tile = this.lastDiscard;
      this._removeTiles(this.players[claimer], [tile, tile, tile]);
      this.players[claimer].melds.push({ type: 'kong', tile, tiles: [tile, tile, tile, tile], from: this.lastDiscarder, concealed: false });
      this._afterClaim(claimer);
      this.emit('kong', { player: claimer, tile, concealed: false });
    }

    _afterClaim(claimer) {
      this.turn = claimer;
      this.lastDiscard = null;
      this.lastDiscarder = -1;
      this.phase = 'play';
    }

    /* ---- 杠 (自己回合) ---- */
    /** 手上 4 张相同 -> 暗杠 */
    findConcealedKongs(player) {
      const counts = toCounts(player.hand);
      const out = [];
      for (let t = 0; t < TOTAL; t++) if (counts[t] === 4) out.push(t);
      return out;
    }

    declareConcealedKong(player, tile) {
      this._removeTiles(player, [tile, tile, tile, tile]);
      player.melds.push({ type: 'kong', tile, tiles: [tile, tile, tile, tile], from: -1, concealed: true });
      this.lastKongInfo = { player: player.id, tile, added: false };
      this.emit('kong', { player: player.id, tile, concealed: true });
      return true;
    }

    /** 已碰的牌再摸到第 4 张 -> 加杠 (可被抢杠) */
    findAddedKongs(player) {
      const out = [];
      for (const m of player.melds) {
        if (m.type === 'pong' && player.hand.includes(m.tile)) out.push(m.tile);
      }
      return out;
    }

    declareAddedKong(player, tile) {
      const m = player.melds.find(mm => mm.type === 'pong' && mm.tile === tile);
      if (!m) return false;
      this._removeTiles(player, [tile]);
      m.type = 'kong';
      m.tiles = [tile, tile, tile, tile];
      m.added = true;
      m.concealed = false;
      this.lastKongInfo = { player: player.id, tile, added: true };
      this.emit('kong', { player: player.id, tile, added: true });
      return true;
    }

    /** 抢杠机会：加杠的牌能让谁和牌 */
    robKongOptions() {
      const info = this.lastKongInfo;
      if (!info || !info.added) return [];
      const opts = [];
      for (let i = 1; i <= 3; i++) {
        const p = this.players[(info.player + i) % 4];
        if (this.canWin(p, info.tile)) opts.push({ player: p.id, tile: info.tile });
      }
      return opts;
    }

    /* ---- 和牌 ---- */
    settleWin(winner, opts = {}) {
      const { selfDraw = false, rinshan = false, robKong = false, haitei = false, fromDiscard = -1 } = opts;
      let winTile;
      if (selfDraw) winTile = winner.lastDraw;
      else if (robKong) winTile = this.lastKongInfo.tile;
      else winTile = this.lastDiscard;
      const ctx = {
        player: winner, winTile, selfDraw, rinshan, robKong, haitei,
        prevailingWind: this.prevailingWind,
      };
      const result = evaluateFan(ctx);
      const payments = this.players.map(p => ({ player: p.id, delta: 0 }));
      if (selfDraw) {
        this.players.forEach(p => { if (p.id !== winner.id) payments[p.id].delta = -result.perPayer; });
        payments[winner.id].delta = result.perPayer * 3;
      } else {
        payments[fromDiscard].delta = -result.perPayer;
        payments[winner.id].delta = result.perPayer;
      }
      this.players.forEach((p, i) => { p.score += payments[i].delta; });
      this.phase = 'end';
      this.emit('win', { winner: winner.id, selfDraw, fromDiscard, result, payments });
      return { result, payments, winTile };
    }

    /* ---- 杠分即时结算 (金币) ---- */
    settleKongPoints(player, concealed) {
      const per = concealed ? KONG_COIN.concealed : KONG_COIN.open;
      const payments = this.players.map(p => ({ player: p.id, delta: 0 }));
      this.players.forEach(p => { if (p.id !== player.id) payments[p.id].delta = -per; });
      payments[player.id].delta = per * 3;
      this.players.forEach((p, i) => { p.score += payments[i].delta; });
      this.emit('kongPoints', { player: player.id, payments, per });
    }

    /* ---- 流局 ---- */
    settleDraw() {
      const tenpaiList = this.players.filter(p => this.isTenpai(p)).map(p => p.id);
      this.phase = 'end';
      this.emit('draw', { tenpai: tenpaiList });
      return tenpaiList;
    }

    /** 一局结束后的庄家/连庄处理 (isDraw: 流局且庄家听牌则连庄) */
    nextHand(dealerWon, isDraw = false) {
      if (dealerWon || (isDraw && this.players[this.dealer].tenpai)) {
        this.honba++; // 连庄
      } else {
        this.dealer = (this.dealer + 1) % 4;
        this.honba = 0;
      }
      this.handIndex++;
      if (this.handIndex >= 8) {
        this.matchOver = true;
        this.emit('matchOver', this.snapshot());
        return false;
      }
      this.startHand();
      return true;
    }

    /* ---- 快照 ---- */
    snapshot() {
      return {
        handIndex: this.handIndex,
        roundName: this.roundName,
        dealer: this.dealer,
        honba: this.honba,
        prevailingWind: this.prevailingWind,
        wallLeft: this.wall.length,
        deadLeft: this.dead.length,
        turn: this.turn,
        phase: this.phase,
        matchOver: this.matchOver,
        players: this.players.map(p => ({
          id: p.id, name: p.name, isHuman: p.isHuman,
          hand: p.hand.slice(), melds: p.melds.map(m => ({ ...m })),
          discards: p.discards.slice(), wind: p.wind, dealer: p.dealer,
          score: p.score, tenpai: p.tenpai,
        })),
      };
    }
  }

  return {
    MahjongGame, isWin, shanten, shantenOf, shantenNormal, shantenSeven,
    effectiveTiles, evaluateFan, findWinForms, isSevenPairs, canFormSets,
    toCounts, sortTiles, WALL_TILES, DEAD_TILES, START_SCORE, TOTAL,
    BASE_BET, MULT_CAP, COIN_UNIT, KONG_COIN, FAN_MULT, MULT_OF, DESC_OF, roundCoins,
  };
});
