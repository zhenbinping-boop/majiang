/**
 * tests/engine.test.js — 引擎单元测试 + 属性测试 + 无头模拟对局
 * 运行: node tests/engine.test.js
 */
'use strict';
const E = require('../js/engine.js');
const { MahjongAI } = require('../js/ai.js');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error('  ✗ FAIL:', msg); }
}
function section(name) { console.log('\n== ' + name + ' =='); }

/* ---------- 工具 ---------- */
const T = require('../js/tiles.js').tileToIndex;
const hand = (s) => s.split(/\s+/).map(T);

/* ---------- 和牌判定 ---------- */
section('和牌判定');
ok(E.isWin(hand('1m 2m 3m 4m 5m 6m 7m 8m 9m 1p 2p 3p 5s 5s'), 0), '4组+对');
ok(E.isWin(hand('1m 1m 1m 2m 2m 2m 3m 3m 3m 4m 4m 4m 5s 5s'), 0), '对对胡');
ok(E.isWin(hand('1m 1m 2m 2m 3m 3m 4m 4m 5m 5m 6m 6m 7m 7m'), 0), '七对');
ok(E.isWin(hand('1m 1m 1m 1m 2m 2m 2m 2m 3m 3m 3m 3m 4m 4m'), 0), '四连对仍算七对(龙七对)');
ok(!E.isWin(hand('1m 1m 1m 2m 3m 4m 5m 5m 6m 7m 8m 9m 9p 9p'), 0), '含刻子杂牌不和');
ok(!E.isWin(hand('1m 2m 3m 4m 5m 6m 7m 8m 9m 1p 2p 3p 5s'), 0), '13张不和');
ok(!E.isWin(hand('1m 9m 1p 9p 1s 9s 1z 2z 3z 4z 5z 6z 7z'), 0), '十三幺(未实现)不和');
ok(E.isWin(hand('1m 2m 3m 4m 5m 6m 7m 8m 9m 5s 5s'), 1), '带1副露');
ok(E.isWin(hand('4m 5m 6m 7m 8m 9m 1p 1p'), 2), '带2副露');
ok(!E.isWin(hand('4m 5m 6m 7m 8m 9m 1p'), 2), '牌数不足不和');
ok(E.isWin(hand('2m 3m 4m 4m 5m 6m 7m 8m 9m 8s 8s'), 1), '暗杠副露+手牌3组');
ok(E.isWin(hand('1m 2m 3m 4m 5m 6m 7m 8m 9m 1p 1p'), 1), '1副露+3组+对');

/* ---------- 向听数 ---------- */
section('向听数');
ok(E.shanten(hand('1m 2m 3m 4m 5m 6m 7m 8m 9m 1p 2p 3p 5s 5s'), 0) === -1, '和牌向听-1');
ok(E.shanten(hand('1m 2m 3m 4m 5m 6m 7m 8m 9m 1p 2p 3p 5s'), 0) === 0, '4组+单张听牌');
ok(E.shanten(hand('1m 2m 3m 4m 5m 6m 7m 8m 9m 1p 1p 2p 2p'), 0) === 0, '3组+2对=听牌');
ok(E.shanten(hand('1m 1m 2m 2m 3m 3m 4m 4m 5m 5m 6m 6m 7m'), 0) === 0, '七对听牌');
ok(E.shanten(hand('1m 1m 1m 2m 2m 2m 3m 3m 3m 4m 4m 4m 9p'), 0) === 0, '对对听9p');
ok(E.shanten(hand('1m 1m 2m 2m 3m 3m 4m 4m 5m 5m 6m 6m 7m 7m'), 0) === -1, '七对和牌');
ok(E.shanten(hand('1m 3m 5m 7m 9m 1p 3p 5p 7p 9p 1s 3s 5s'), 0) === 4, '全散牌向听4');
ok(E.shanten(hand('1m 2m 3m 4m 5m 6m 1p 1p 2p 3p 5s 5s 9p'), 0) === 1, '2组+2对+搭子向听1');
ok(E.shanten(hand('1m 2m 3m 4m 5m 6m 1p 2p 3p 5s 6s 7s 9s'), 0) === 0, '4组+单张听牌');
ok(E.shanten(hand('1m 2m 3m 4m 5m 6m 1p 2p 3p 5s 5s 8s 9s'), 0) === 0, '3组+对+搭子听牌');
ok(E.shanten(hand('1m 1m 1m 9p 9p 1s 1s 5m 5m 6m 7m 2z 3z'), 0) >= 1, '杂乱手牌向听>=1');

/* ---------- 属性测试：听牌判定 ⟺ 存在和牌张 ---------- */
section('属性测试（随机 200 手）');
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
{
  const rng = mulberry32(42);
  let bad = 0;
  for (let iter = 0; iter < 200; iter++) {
    // 随机 13 张
    const tiles = [];
    for (let i = 0; i < 34; i++) for (let c = 0; c < 4; c++) tiles.push(i);
    for (let i = tiles.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [tiles[i], tiles[j]] = [tiles[j], tiles[i]];
    }
    const h = tiles.slice(0, 13);
    const s = E.shanten(h, 0);
    const hasWinTile = Array.from({ length: 34 }, (_, t) => t).some(t => h.filter(x => x === t).length < 4 && E.isWin(h.concat([t]), 0));
    if ((s === 0) !== hasWinTile) { bad++; if (bad <= 3) console.error('  ✗ 手牌', h.join(','), '向听', s, '但存在和牌张:', hasWinTile); }
    if (s === -1 !== E.isWin(h, 0)) { bad++; }
  }
  ok(bad === 0, '随机手牌：向听0 ⟺ 存在和牌张');
}

/* ---------- 番型结算 ---------- */
section('番型结算');
function mkPlayer(h, melds) { return { hand: hand(h), melds: melds || [], wind: 0 }; }
{
  const r = E.evaluateFan({ player: mkPlayer('1m 2m 3m 4m 5m 6m 7m 8m 9m 1p 2p 3p 5s'), winTile: T('5s'), selfDraw: false });
  ok(r.fans.some(f => f.name === '平胡'), '平胡');
  ok(!r.fans.some(f => f.name === '清一色'), '非清一色');
}
{
  const r = E.evaluateFan({ player: mkPlayer('1m 2m 3m 4m 5m 6m 7m 8m 9m 1m 2m 3m 1m'), winTile: T('1m'), selfDraw: true });
  ok(r.fans.some(f => f.name === '自摸'), '自摸+1');
  ok(r.fans.some(f => f.name === '门清'), '门清+1');
  ok(r.fans.some(f => f.name === '清一色' && f.mult === 8), '清一色 ×8');
  ok(r.fans.some(f => f.name === '一气通贯'), '一气通贯');
}
{
  const r = E.evaluateFan({ player: mkPlayer('1m 1m 1m 2m 2m 2m 3m 3m 3m 4m 4m 4m 5s'), winTile: T('5s'), selfDraw: false });
  ok(r.fans.some(f => f.name === '对对胡' && f.mult === 3), '对对胡 ×3');
}
{
  const r = E.evaluateFan({ player: mkPlayer('1m 1m 2m 2m 3m 3m 4m 4m 5m 5m 6m 6m 7m'), winTile: T('7m'), selfDraw: false });
  ok(r.fans.some(f => f.name === '七对'), '七对');
}
{
  const r = E.evaluateFan({ player: mkPlayer('1m 1m 1m 1m 2m 2m 2m 2m 3m 3m 3m 3m 4m'), winTile: T('4m'), selfDraw: false });
  ok(r.fans.some(f => f.name === '龙七对'), '龙七对');
}
{
  const melds = [{ type: 'chi', tile: T('1m'), tiles: [T('1m'), T('2m'), T('3m')], from: 1 }];
  const r = E.evaluateFan({ player: mkPlayer('4m 5m 6m 7m 8m 9m 1p 2p 3p 5s 5s', melds), winTile: T('5s'), selfDraw: false });
  ok(!r.fans.some(f => f.name === '门清'), '有吃牌则非门清');
}
{
  const r = E.evaluateFan({ player: mkPlayer('2m 3m 4m 2p 3p 4p 2s 3s 4s 5m 6m 7m 5m'), winTile: T('5m'), selfDraw: false });
  ok(r.fans.some(f => f.name === '三色同顺'), '三色同顺');
}
{
  const r = E.evaluateFan({ player: mkPlayer('2m 3m 4m 4m 5m 6m 6m 7m 8m 5p 5p 5p 5s'), winTile: T('5s'), selfDraw: false });
  ok(r.fans.some(f => f.name === '断幺九'), '断幺九');
}
{
  const r = E.evaluateFan({ player: mkPlayer('1m 1m 2m 2m 3m 3m 4m 4m 5m 5m 6m 6m 7m'), winTile: T('7m'), selfDraw: false, rinshan: true });
  ok(r.fans.some(f => f.name === '杠上开花'), '杠上开花');
}

/* ---------- 杠：确定性路径覆盖（不依赖随机触发） ---------- */
section('杠（暗杠 / 加杠 / 明杠）');
{
  const game = new E.MahjongGame({ rng: mulberry32(7) });
  game.startMatch();
  const p = game.players[0];
  // 暗杠：手上凑齐 4 张 5 万
  p.hand = hand('5m 5m 5m 5m 1m 2m 3m 4m 6m 7m 8m 9m 1p 2p');
  const deadBefore = game.dead.length;
  const list = game.findConcealedKongs(p);
  ok(list.length === 1 && list[0] === T('5m'), 'findConcealedKongs 命中 5m');
  game.declareConcealedKong(p, T('5m'));
  ok(p.melds.length === 1 && p.melds[0].concealed === true, '暗杠写入副露且标记 concealed');
  ok(p.hand.filter(t => t === T('5m')).length === 0, '手牌中 4 张 5m 被移除');
  ok(p.hand.length === 10, '暗杠后手牌 10 张（14-4）');
  const t2 = game.drawTile(p, true);
  ok(t2 !== null && game.dead.length === deadBefore - 1, '暗杠后从王牌（岭上）补牌，王牌 -1');

  // 加杠：已有碰副露 + 摸到第 4 张
  const q = game.players[1];
  q.hand = hand('3s 3s 3s 1m 2m 4m 5m 6m 7m 8m 9m 1p 2p 3p');
  q.melds = [{ type: 'pong', tile: T('3s'), tiles: [T('3s'), T('3s'), T('3s')], from: 0 }];
  q.hand.push(T('3s'));
  const added = game.findAddedKongs(q);
  ok(added.length === 1 && added[0] === T('3s'), 'findAddedKongs 命中 3s');
  game.declareAddedKong(q, T('3s'));
  ok(q.melds.length === 1 && q.melds[0].type === 'kong' && q.melds[0].tiles.length === 4, '加杠升级为 4 张杠');

  // 明杠：他家弃牌 + 手中 3 张
  const r = game.players[2];
  r.hand = hand('7p 7p 7p 1m 2m 3m 4m 5m 6m 7m 8m 9m 1s');
  const d3 = game.players[3];
  d3.hand = hand('7p 1m 2m 3m 4m 5m 6m 7m 8m 9m 1s 2s 3s 4s');
  d3.discards = [];
  game.discard(d3, T('7p'));
  const opts = game.claimOptions(3, T('7p'));
  ok(opts.some(o => o.player === 2 && o.type === 'kong'), '明杠选项出现在 claimOptions');
  game.applyKongFromDiscard(2);
  ok(r.melds.length === 1 && r.melds[0].tiles.length === 4 && !r.melds[0].concealed, '明杠写入 4 张副露');
}

/* ---------- 无头模拟对局 ---------- */
section('模拟对局（4 家全 AI）');

function playHand(game, ai) {
  let guard = 0;
  let skipDraw = false;
  while (guard++ < 300) {
    const p = game.players[game.turn];
    if (!skipDraw && game.needsDraw(p)) {
      const tile = game.drawTile(p);
      if (tile === null) {
        game.updateTenpaiFlags();
        game.settleDraw();
        return { dealerWon: false, isDraw: true };
      }
      if (game.canWin(p)) {
        game.settleWin(p, { selfDraw: true, haitei: p.lastDrawWasLast });
        return { dealerWon: p.dealer, isDraw: false };
      }
      const kong = ai.decideKong(p);
      if (kong) {
        if (kong.kind === 'concealed') game.declareConcealedKong(p, kong.tile);
        else game.declareAddedKong(p, kong.tile);
        game.settleKongPoints(p, kong.kind === 'concealed');
        const rob = game.robKongOptions();
        if (rob.length) {
          const w = game.players[rob[0].player];
          game.settleWin(w, { robKong: true, fromDiscard: p.id });
          return { dealerWon: w.dealer, isDraw: false };
        }
        const t2 = game.drawTile(p, true);
        if (t2 === null) { game.updateTenpaiFlags(); game.settleDraw(); return { dealerWon: false, isDraw: true }; }
        if (game.canWin(p)) {
          game.settleWin(p, { selfDraw: true, rinshan: true });
          return { dealerWon: p.dealer, isDraw: false };
        }
      }
    }
    skipDraw = false;
    const d = ai.chooseDiscard(p);
    if (d === undefined || !p.hand.includes(d)) throw new Error('AI 弃牌非法: ' + d);
    game.discard(p, d);
    const opts = game.claimOptions(p.id, d);
    const decided = [];
    for (const o of opts) {
      const myOpts = opts.filter(x => x.player === o.player);
      const dec = ai.decideClaim(myOpts, game.players[o.player]);
      if (dec) decided.push(dec);
    }
    if (decided.length) {
      const d0 = decided[0];
      const pl = game.players[d0.player];
      if (d0.type === 'win') {
        game.settleWin(pl, { selfDraw: false, fromDiscard: p.id, haitei: game.wall.length === 0 });
        return { dealerWon: pl.dealer, isDraw: false };
      }
      if (d0.type === 'pong') game.applyPong(d0.player);
      else if (d0.type === 'kong') {
        game.applyKongFromDiscard(d0.player);
        game.settleKongPoints(pl, false);
        const t2 = game.drawTile(pl, true);
        if (t2 !== null && game.canWin(pl)) {
          game.settleWin(pl, { selfDraw: true, rinshan: true });
          return { dealerWon: pl.dealer, isDraw: false };
        }
        if (t2 === null) { game.updateTenpaiFlags(); game.settleDraw(); return { dealerWon: false, isDraw: true }; }
      } else if (d0.type === 'chi') game.applyChi(d0.player, d0.combos[0]);
      game.turn = d0.player;
      skipDraw = true;
      continue;
    }
    game.turn = (game.turn + 1) % 4;
  }
  throw new Error('单局超过 300 巡，疑似死循环');
}

function simulate(seed) {
  const game = new E.MahjongGame({ rng: mulberry32(seed) });
  const ai = new MahjongAI(game);
  game.startMatch();
  let hands = 0, wins = 0, draws = 0;
  while (!game.matchOver && hands < 40) {
    const r = playHand(game, ai);
    hands++;
    if (r.isDraw) draws++; else wins++;
    game.nextHand(r.dealerWon, r.isDraw);
  }
  return { game, hands, wins, draws };
}

const N = 20;
let totalHands = 0, totalWins = 0, totalDraws = 0;
let errors = 0;
const t0 = Date.now();
for (let seed = 1; seed <= N; seed++) {
  try {
    const r = simulate(seed);
    totalHands += r.hands;
    totalWins += r.wins;
    totalDraws += r.draws;
    const sum = r.game.players.reduce((s, p) => s + p.score, 0);
    if (sum !== E.START_SCORE * 4) { failed++; console.error(`  ✗ seed=${seed} 金币不守恒: ${sum}`); }
  } catch (e) {
    errors++;
    if (errors <= 3) console.error(`  ✗ seed=${seed} 异常:`, e.message);
  }
}
ok(errors === 0, `${N} 场模拟无异常（异常 ${errors} 次）`);
console.log(`  模拟 ${N} 场对局：共 ${totalHands} 局，和牌 ${totalWins}，流局 ${totalDraws}，耗时 ${Date.now() - t0}ms`);
console.log(`  和牌率 ${(totalWins / totalHands * 100).toFixed(1)}%，流局率 ${(totalDraws / totalHands * 100).toFixed(1)}%`);

/* ---------- 结果 ---------- */
console.log(`\n========== 通过 ${passed} / 失败 ${failed} ==========`);
process.exit(failed > 0 ? 1 : 0);
