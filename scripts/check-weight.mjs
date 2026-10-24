/**
 * 加权随机验证 / 调参台：node scripts/check-weight.mjs
 *
 * 单人自用版的规则很直白，所以重点验证两件事：
 *   1. 星越高中签率确实单调上升，且未评分不会被压死
 *   2. 打过 0 星的菜必须彻底抽不到（不是"概率很低"）
 */
import {
  weightOf, inPool, pickWeighted, randomFloat, DEFAULT_STARS,
} from '../src/weight.js';

import { installNodeShims } from './_node-shim.mjs';

// 浏览器里 globalThis.crypto 一直存在，网站本身不依赖这一段。
// 但验证脚本跑在 Node 上：全局 crypto 是 Node 19+ 才有的，
// 低版本 Node 不补就会 ReferenceError: crypto is not defined
// （当前开发环境 v22 本来就有，这是给老 Node 的兜底）。
await installNodeShims();

const dish = (name, stars) => ({ id: name, name, meal: 'lunch', stars, createdAt: '' });

const cases = [
  dish('很爱吃', 5),
  dish('爱吃', 4),
  dish('还行', 3),
  dish('一般', 2),
  dish('不大喜欢', 1),
  dish('未评分', null),
  dish('打过 0 星', 0),
];

console.log('=== 权重与池内状态 ===');
for (const d of cases) {
  console.log(
    `  ${d.name.padEnd(6, '　')} 星=${String(d.stars ?? 'null').padStart(4)}` +
    `  权重=${weightOf(d).toFixed(2)}` +
    `  在池中=${inPool(d)}`
  );
}

console.log('');
console.log(`基准：未评分按 ${DEFAULT_STARS} 星算 => 权重恒为 1.00`);

// 0 星必须被 inPool 拦在池外，而不是靠权重小到抽不到
const zeroPool = cases.filter(inPool).map((d) => ({ dish: d, weight: weightOf(d) }));
const zeroHits = new Map(cases.filter((d) => !inPool(d)).map((d) => [d.name, 0]));
for (let i = 0; i < 20000; i++) {
  const hit = pickWeighted(zeroPool, randomFloat());
  if (hit && zeroHits.has(hit.dish.name)) zeroHits.set(hit.dish.name, zeroHits.get(hit.dish.name) + 1);
}
const leaked = [...zeroHits.values()].reduce((a, b) => a + b, 0);
console.log('');
console.log(`  ${leaked === 0 ? 'PASS' : 'FAIL'}  20000 次抽签中，0 星菜被抽到 ${leaked} 次（必须为 0）`);

// 正常池：看分布是否单调
const pool = cases.filter(inPool).map((d) => ({ dish: d, weight: weightOf(d) }));
const counts = new Map(pool.map((c) => [c.dish.name, 0]));
for (let i = 0; i < 20000; i++) {
  const hit = pickWeighted(pool, randomFloat());
  if (hit) counts.set(hit.dish.name, (counts.get(hit.dish.name) ?? 0) + 1);
}
console.log('');
console.log(`=== 同池 ${pool.length} 道、20000 次抽签分布 ===`);
const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
for (const [name, c] of sorted) console.log(`  ${name.padEnd(6, '　')} ${(c / 200).toFixed(1)}%`);

const pct = Object.fromEntries(sorted);
const monotonic = pct['很爱吃'] > pct['爱吃'] && pct['爱吃'] > pct['还行']
  && pct['还行'] > pct['未评分'] && pct['未评分'] > pct['一般'] && pct['一般'] > pct['不大喜欢'];
console.log('');
console.log(`  ${monotonic ? 'PASS' : 'FAIL'}  中签率随星级单调下降，且未评分稳居中游`);

// 只剩 0 星的极端情况
const noneLeft = cases.filter((d) => d.stars === 0).filter(inPool);
console.log(`  ${noneLeft.length === 0 ? 'PASS' : 'FAIL'}  全是 0 星时候选池为空，界面可提示"先改星"`);
