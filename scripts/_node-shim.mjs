/**
 * Node 垫片：check 系列与 measure-size 脚本共用。
 *
 * store.js 依赖 localStorage 和 crypto.getRandomValues，
 * 浏览器里两者本来就在；Node 需要补。
 * 全局 crypto 是 Node 19+ 才有的，低版本 Node 不补就会
 * ReferenceError: crypto is not defined。
 */
export async function installNodeShims() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  if (!globalThis.crypto) {
    const { webcrypto } = await import('node:crypto');
    globalThis.crypto = webcrypto;
  }
  // 句柄返回给调用方：有的测试要直接往里塞旧版数据
  return { store };
}
