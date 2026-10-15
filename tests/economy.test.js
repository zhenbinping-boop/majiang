/**
 * tests/economy.test.js — 局外代币经济模块专项验证
 * 覆盖：余额初始化/下限截断、局级选择、名次结算、皮肤解锁/余额不足、破产补助每日一次
 */
const path = require('path');
const fs = require('fs');
const vm = require('vm');

/* localStorage 桩（内存版） */
const store = new Map();
global.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

/* 以 window=globalThis 的语义加载 economy.js（其 IIFE 绑定 window||this） */
const src = fs.readFileSync(path.resolve(__dirname, '..', 'js', 'economy.js'), 'utf8');
const ctx = { localStorage: global.localStorage, document: undefined };
ctx.window = ctx;   /* economy.js 的 IIFE 参数 = window，挂到沙箱全局 */
vm.createContext(ctx);
vm.runInContext(src, ctx);
const E = ctx.window.MJEconomy;

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

console.log('== 余额初始化 ==');
ok(E.getCoins() === 1000, '首次启动赠 1,000 代币（实际 ' + E.getCoins() + '）');

console.log('== 局级选择 ==');
ok(E.getStake() === 'tea' && E.stakeInfo().base === 100, '默认茶局 · 底分 100');
E.setStake('gold');
ok(E.getStake() === 'gold' && E.stakeInfo().base === 500, '切金局 · 底分 500');
E.setStake('nope');
ok(E.getStake() === 'gold', '非法局级名被拒绝，保持金局');

console.log('== 名次结算（金局 · 底分 500）==');
let d = E.settleMatch(1);
ok(d === 2000 && E.getCoins() === 3000, '第 1 名 +2,000（实际 ' + d + '）');
d = E.settleMatch(4);
ok(d === -2000 && E.getCoins() === 1000, '第 4 名 −2,000（实际 ' + d + '）');
d = E.settleMatch(2);
ok(d === 500 && E.getCoins() === 1500, '第 2 名 +500');
d = E.settleMatch(3);
ok(d === -1000 && E.getCoins() === 500, '第 3 名 −1,000');
d = E.settleMatch(9);
ok(d === 0, '非法名次返回 0 变动');

console.log('== 皮肤解锁 ==');
let r = E.unlockSkin('ocean');
ok(!r.ok && r.reason === 'poor', '余额 500 解锁 8,000 鎏金 → 拒绝（poor）');
E.addCoins(9500); // 500 → 10,000
ok(E.getCoins() === 10000, '充值代币到 10,000（纯虚拟加币）');
r = E.unlockSkin('ocean');
ok(r.ok && E.isUnlocked('ocean'), '8,000 解锁深海鎏金成功');
ok(E.getCoins() === 2000, '扣款后余额 2,000（实际 ' + E.getCoins() + '）');
r = E.unlockSkin('ocean');
ok(!r.ok && r.reason === 'owned', '重复解锁 → owned');
r = E.unlockSkin('sandal');
ok(!r.ok && r.reason === 'poor', '2,000 解锁 15,000 玄金 → 拒绝（poor）');
ok(E.ownedSkins().length === 2 && E.ownedSkins().indexOf('jade') >= 0, '翡翠始终默认拥有');

console.log('== 破产补助 ==');
E.addCoins(-2500); // 2,000 → 0（下限截断）
ok(E.getCoins() === 0, '余额下限截断为 0（实际 ' + E.getCoins() + '）');
const g1 = E.maybeRelief();
ok(g1 === 1000 && E.getCoins() === 1000, '补助 +1,000（实际 +' + g1 + '）');
const g2 = E.maybeRelief();
ok(g2 === 0, '同一天二次触发 → 0');

console.log('== 持久化 ==');
ok(store.get('mj-coins') === '1000', '余额已写回存储');
ok(JSON.parse(store.get('mj-unlocked')).indexOf('ocean') >= 0, '解锁清单已持久化');

console.log('\n========== 通过 ' + pass + ' / 失败 ' + fail + ' ==========');
process.exit(fail ? 1 : 0);
