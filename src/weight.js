/**
 * 加权随机 —— 单人自用版
 *
 * ============================================================
 * 为什么把之前的贝叶斯收缩删掉了
 * ============================================================
 *
 * 上一版是多人公共池设计，公式 (C·2.5 + Σ星)/(C + n)，C=5。
 * 它的唯一作用是压制噪声：陌生人手滑打满星，不该碾压两百人的 4.6 分。
 *
 * 现在每道菜只有你一票，而这一票不是噪声，是你的口味本身。
 * 再套收缩会把"我很爱吃"算成 (5×2.5+5)/6 = 2.92，相对优势只剩 1.17 倍 ——
 * 等于把你自己的评分打七折。所以这里改成线性，不再收缩。
 *
 * 同理被删掉的还有"0 星要三重门槛才下架"：单人场景不存在小样本误杀，
 * 你打 0 星就是一个明确结论，直接出池。
 */

/** 未评分的菜按这个基准参与随机（1.0 倍权重） */
export const DEFAULT_STARS = 2.5;

const MIN_STARS = 0;

/**
 * @typedef {Object} Dish
 * @property {number} id
 * @property {'breakfast'|'lunch'|'dinner'} meal
 * @property {string} name
 * @property {number|null} stars  null = 还没评过
 * @property {string} createdAt
 */

/**
 * 权重 = 星级相对基准的倍数。
 *
 *   5 星 -> 2.00 倍      3 星 -> 1.20 倍
 *   4 星 -> 1.60 倍      2 星 -> 0.80 倍
 *   未评 -> 1.00 倍      1 星 -> 0.40 倍
 *
 * 不再设权重下限：下限是为"别人误伤你爱的菜"准备的，
 * 单人场景里 0 星就是你自己的判决，托底反而违背你的规则。
 *
 * @param {Dish} dish
 * @returns {number}
 */
export function weightOf(dish) {
  const s = dish.stars ?? DEFAULT_STARS;
  if (s <= MIN_STARS) return 0;
  return s / DEFAULT_STARS;
}

/**
 * 是否还在随机池里。打过 0 星即出池 —— 没有单独的下架标记，
 * 状态就是星级本身，避免出现"0 星但已恢复"这种自相矛盾的中间态。
 * 想让它回池，改个星就行。
 *
 * @param {Dish} dish
 * @returns {boolean}
 */
export function inPool(dish) {
  return (dish.stars ?? DEFAULT_STARS) > MIN_STARS;
}

/**
 * 按权重抽取一项。rnd 取 [0,1)，由调用方用 crypto 提供。
 * @template {{weight:number}} T
 * @param {readonly T[]} items
 * @param {number} rnd
 * @returns {T|null}
 */
export function pickWeighted(items, rnd) {
  if (items.length === 0) return null;

  let total = 0;
  for (const it of items) total += it.weight;
  // 全是 0 星（理论上不会进到这里）时退化成取第一个，避免除零
  if (total <= 0) return items[0] ?? null;

  let cursor = rnd * total;
  for (const it of items) {
    cursor -= it.weight;
    if (cursor <= 0) return it;
  }
  return items[items.length - 1] ?? null;
}

/** [0,1) 均匀随机数。crypto 而非 Math.random：结果不该可预测或复现 */
export function randomFloat() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] / 0x100000000;
}
