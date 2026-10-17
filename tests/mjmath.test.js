/**
 * tests/mjmath.test.js — 军师数学内核单元测试
 *
 * 覆盖：真实进张 (ukeireOf)、危险度 (dangerOf/现物/四张全见/威胁加权)、
 *       和了率 (winRate 边界与单调性)、保留价值、analyzeHand 综合评估
 *       (听牌选择最大进张 / 远听遇威胁转防守) 与建议文案。
 *
 * 运行：node tests/mjmath.test.js
 */
'use strict';
const MJ = require('../js/tiles.js');
const E = require('../js/engine.js');
const M = require('../js/mjmath.js');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ok - ' + msg); }
  else { failed++; console.error('  FAIL - ' + msg); }
}

/* 牌索引：0-8 万 1-9，9-17 筒，18-26 条，27-30 东南西北，31-33 中发白 */
const Z = new Array(34).fill(0);

console.log('== ukeireOf 真实进张 ==');
{
  // 1万2万3万 4万5万6万 7万8万9万 东东 白白 = 13 张，三组面子 + 两对 → 听牌 (听东/白 成刻)
  const hand = [0, 1, 2, 3, 4, 5, 6, 7, 8, 27, 27, 32, 32];
  const vis = E.toCounts(hand);              // 我视角可见牌含自己手牌 (与 ai.visibleCounts 同构)
  const r = M.ukeireOf(hand, 0, vis);
  ok(r.shanten === 0, '三组+两对 13 张为听牌 (shanten=0，实际 ' + r.shanten + ')');
  ok(r.live[27] === 2, '东东所听的第三张东剩 2 张 (手里已有 2 张)');
  ok(r.live[32] === 2, '白白所听的第三张白剩 2 张');
  ok(r.total === 4 && r.kinds === 2, '进张合计 4 张 / 2 种 (实际 ' + r.total + '张/' + r.kinds + '种)');

  // 桌面(他家牌河/副露)再现 1 张白 → 真实进张折减
  const v2 = vis.slice(); v2[32] += 1;
  const r2 = M.ukeireOf(hand, 0, v2);
  ok(r2.live[32] === 1, '白再现 1 张 → 只剩 1 张 (实际 ' + r2.live[32] + ')');
  ok(r2.total === 3 && r2.kinds === 2, '折减后进张 3 张 / 2 种 (实际 ' + r2.total + '张/' + r2.kinds + '种)');

  // 向听较远的散牌
  const far = [0, 9, 18, 27, 28, 29, 30, 31, 32, 33, 4, 13, 22];
  const r3 = M.ukeireOf(far, 0, E.toCounts(far));
  ok(r3.shanten >= 3, '孤张散牌向听 ≥ 3 (实际 ' + r3.shanten + ')');
  ok(r3.total > r3.kinds, '进张总张数 > 种类数 (数牌邻张各有 4 张)');
}

console.log('== dangerOf 危险度 ==');
{
  const mkOpp = (discards, threat) => ({ discards, threat });
  // 四张全见 → 绝对安全
  const v1 = Z.slice(); v1[31] = 4;
  ok(M.dangerOf(31, { visible: v1, opponents: [mkOpp([], 0.9)] }) === 0, '中张白四张全见 → 0');
  // 现物 → 对该家安全
  ok(M.dangerOf(27, { visible: Z.slice(), opponents: [mkOpp([27], 0.9)] }) === 0, '该家打过东 (现物) → 0');
  // 威胁低 → 忽略
  ok(M.dangerOf(4, { visible: Z.slice(), opponents: [mkOpp([], 0.05)] }) === 0, '威胁 ≤ 0.12 忽略 → 0');
  // 无筋中张 5万 × 满威胁 = 40 × 0.9 = 36
  ok(M.dangerOf(4, { visible: Z.slice(), opponents: [mkOpp([], 0.9)] }) === 36,
    '无筋 5万 × 威胁 0.9 → 36 (实际 ' + M.dangerOf(4, { visible: Z.slice(), opponents: [mkOpp([], 0.9)] }) + ')');
  // 两家威胁累加且封顶 90
  const d3 = M.dangerOf(4, { visible: Z.slice(), opponents: [mkOpp([], 1), mkOpp([], 1), mkOpp([], 1)] });
  ok(d3 === 90, '三家满威胁封顶 90 (实际 ' + d3 + ')');
  // 中张 > 端牌，字牌较安全
  const ctx = { visible: Z.slice(), opponents: [mkOpp([], 1)] };
  ok(M.tileDangerBase(4) > M.tileDangerBase(0) && M.tileDangerBase(0) < M.tileDangerBase(31),
    '危险度序：中张 > 字牌 > 端数牌');
  ok(M.dangerLevel(0).label === '安全' && M.dangerLevel(15).label === '低'
    && M.dangerLevel(30).label === '中' && M.dangerLevel(80).label === '高', '分级文案四档');
}

console.log('== winRate 和了率 ==');
{
  ok(M.winRate(0, 100, 10) === 0, '进张 0 → 0');
  ok(M.winRate(5, 100, 0) === 0, '剩余摸牌 0 → 0');
  const a = M.winRate(3, 136, 5), b = M.winRate(3, 136, 10), c = M.winRate(6, 136, 5);
  ok(a > 0 && a < 0.5, '3 张听 5 巡和率约 10% (实际 ' + (a * 100).toFixed(1) + '%)');
  ok(b > a, '巡数越多和率越高');
  ok(c > a, '进张越多和率越高');
  ok(M.winRate(999, 100, 99) === 1, '饱和 → 1');
  ok(M.unseenCount(Z.slice()) === 136, '未见牌基准 136');
  const v = Z.slice(); v[0] = 3; v[27] = 1;
  ok(M.unseenCount(v) === 132, '可见 4 张 → 132 (实际 ' + M.unseenCount(v) + ')');
}

console.log('== keepValue 保留价值 ==');
{
  const c = Z.slice(); c[27] = 2;
  ok(M.keepValue(27, c, {}) === 84, '字牌对子 84');
  ok(M.keepValue(31, Z.slice(), {}) === 34, '孤张中 34');
  ok(M.keepValue(28, Z.slice(), { seatWind: 1 }) === 28, '孤张自风 28');
  const near = Z.slice(); near[3] = 1; near[5] = 1;
  ok(M.keepValue(4, near, {}) > M.keepValue(4, Z.slice(), {}), '两面搭中心张价值高于孤张');
  ok(M.keepValue(0, Z.slice(), {}) === 5, '孤张端牌 5');
}

console.log('== analyzeHand 综合评估 ==');
{
  // 听牌 14 张：123456789万 + 东东 + 白白 + 北 → 打北进白/东（最大进张候选）
  const hand14 = [0, 1, 2, 3, 4, 5, 6, 7, 8, 27, 27, 32, 32, 30];
  const visible = E.toCounts(hand14);          // 我视角可见含自己手牌
  const oppLow = [{ discards: [], threat: 0.1 }, { discards: [], threat: 0.1 }, { discards: [], threat: 0.1 }];
  const a = M.analyzeHand({
    hand: hand14, meldCount: 0, visible, opponents: oppLow, wallLeft: 60,
    prevailingWind: 0, seatWind: 0,
  });
  ok(a.shanten === 0, '评估基准向听 0');
  ok(a.best.tile === 30, '打北是唯一保持听牌的切法 (实际打 ' + MJ.tileName(a.best.tile) + ')');
  ok(a.best.uke === 4 && a.best.kinds === 2, '听白/东 共 4 张 (实际 ' + a.best.uke + ')');
  ok(a.mode === 'attack' && a.defending === false, '听牌且无威胁 → 进攻');
  ok(a.best.winRate > 0 && a.best.winRate < 1, '和率在 (0,1) (实际 ' + (a.best.winRate * 100).toFixed(0) + '%)');
  ok(a.top.length === 3 && a.all.length === 12, 'top3 + 全候选 12 种 (实际 ' + a.all.length + ')');
  // 打北危险 0
  ok(a.best.danger === 0, '北无现物但威胁低 → 危险 0');

  // 远听散牌 + 两家高威胁 → 防守：优先现物
  const far14 = [27, 28, 29, 30, 31, 32, 33, 4, 13, 22, 0, 9, 18, 12];
  const fv = E.toCounts(far14);
  const oppHot = [
    { discards: [27], threat: 0.9 },
    { discards: [], threat: 0.85 },
    { discards: [], threat: 0.1 },
  ];
  const b = M.analyzeHand({
    hand: far14, meldCount: 0, visible: fv, opponents: oppHot, wallLeft: 40,
    prevailingWind: 0, seatWind: 1,
  });
  ok(b.defending === true && b.mode === 'defend', '远听 + 高威胁 → 防守模式');
  ok(b.best.tile === 27, '防守时优先打现物东 (实际打 ' + MJ.tileName(b.best.tile) + ')');
  // 现物只对那一家安全；其它高威胁家仍贡献危险 → 聚合后应落在最低档（孤立字牌 17 ≈ 20×0.85）
  ok(b.best.danger === 17, '现物对一家安全、对另一家 0.85 威胁 → 17 (实际 ' + b.best.danger + ')');
  ok(b.best.danger < 30, '现物候选危险度远低于无筋中张 (中张将 ≥ 70)');

  // 无威胁时不转防守（同一手牌）
  const c = M.analyzeHand({
    hand: far14, meldCount: 0, visible: fv, opponents: oppLow, wallLeft: 40,
    prevailingWind: 0, seatWind: 1,
  });
  ok(c.defending === false && c.mode !== 'defend', '低威胁同手牌不转防守');

  // 建议文案
  const txt = M.adviceText(a);
  ok(typeof txt === 'string' && txt.indexOf('打') >= 0 && txt.indexOf('进张') >= 0 && txt.indexOf('危险') >= 0,
    '建议文案含 打/进张/危险：' + txt.slice(0, 40) + '…');
  ok(M.adviceText(null) === '', '空分析 → 空文案');
}

console.log('== 与好形直觉一致 (三组面子 + 对子，拆孤张字牌保进张) ==');
{
  // 4万5万6万 4筒5筒6筒 7条8条9条 中中 + 东南白 = 14 张：拆孤张字牌
  const hand = [3, 4, 5, 12, 13, 14, 21, 22, 23, 31, 31, 27, 28, 33];
  const vis = E.toCounts(hand);
  const a = M.analyzeHand({
    hand, meldCount: 0, visible: vis, opponents: [{ discards: [], threat: 0.2 }],
    wallLeft: 70, prevailingWind: 0, seatWind: 0,
  });
  ok(a.shanten === 1, '三组+对子+散字牌 → 1 向听 (实际 ' + a.shanten + ')');
  ok([27, 28, 33].indexOf(a.best.tile) >= 0,
    '拆孤张字牌保留三组面子 (实际打 ' + MJ.tileName(a.best.tile) + ')');
  ok(a.best.uke >= 5, '切字牌后成对进张 ≥ 5 张 (实际 ' + a.best.uke + ')');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
