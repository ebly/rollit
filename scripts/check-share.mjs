/**
 * 分享码验证：node scripts/check-share.mjs
 *
 * 注意这里的 import 必须【不带 query】：share.js 内部写的是 import './store.js'，
 * 若本文件用 '../src/store.js?case=xxx' 会得到另一个模块实例，
 * 于是 share 新建的分类在本文件里根本看不到（测出来就是"只新增了 0 个分类"）。
 * 不同进程之间不会有冲突，所以直接无 query 引同一个实例即可。
 */
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

// btoa/atob 在 Node 16+ 有全局实现；Blob/CompressionStream 在 18 里也有。
// 这里只做能力探测并如实打印，缺了就说明当前环境走的是降级分支。
console.log('环境能力：' +
  `btoa=${typeof btoa} atob=${typeof atob} Blob=${typeof Blob} ` +
  `CompressionStream=${typeof CompressionStream} DecompressionStream=${typeof DecompressionStream}`);
if (typeof btoa !== 'function') globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
if (typeof atob !== 'function') globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');

const S = await import('../src/store.js');
const share = await import('../src/share.js');

let failed = 0;
const check = (label, ok, extra = '') => {
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  [${extra}]` : ''}`);
};

const first = S.tabList()[0];
const seedCount = S.dishesOf(first.id).length;

/* ---------- 生成 ---------- */
console.log('');
console.log('=== 生成分享码 ===');
const code = await share.makeShareCode(first.id);
check('分享码以 ZYD1: 开头', code.startsWith('ZYD1:'));
check('分享码是纯 ASCII（能安全粘进任何聊天软件）', /^[\x20-\x7e]+$/.test(code));
check('日常量级体积足够小（< 1500 字符）', code.length < 1500, `${code.length} 字符`);
console.log(`  实际长度：${code.length} 字符`);

/* ---------- 导入 ---------- */
console.log('');
console.log('=== 导入分享码（新增共存，不覆盖现有数据）===');
const tabsBefore = S.tabList().length;
const imported = await share.importShareCode(code);
check('生成一个新分类', S.tabList().length === tabsBefore + 1, `${tabsBefore} -> ${S.tabList().length}`);
check('重名分类自动加后缀而不报错', imported.tabName !== first.name, imported.tabName);
check('条目数量一致', imported.count === seedCount, `${imported.count} / ${seedCount}`);
check('原分类的条目一条没少', S.dishesOf(first.id).length === seedCount);
check('导入的条目名与原分类一致', (() => {
  const a = S.dishesOf(first.id).map((d) => d.name).sort();
  const b = S.dishesOf(S.tabList().at(-1).id).map((d) => d.name).sort();
  return a.join('|') === b.join('|');
})());

/* ---------- 星级随码带走 ---------- */
console.log('');
console.log('=== 星级是否随码带走 ===');
S.setStars(S.dishesOf(first.id)[0].id, 5);
S.setStars(S.dishesOf(first.id)[1].id, 0);
const code2 = await share.makeShareCode(first.id);
const imported2 = await share.importShareCode(code2);
const newTab = S.tabList().at(-1);
const starsInNew = S.dishesOf(newTab.id).map((d) => d.stars);
check('5 星被原样带走', starsInNew.includes(5));
check('0 星（已出池状态）也被带走', starsInNew.includes(0));
check('未评分的仍是 null', starsInNew.includes(null));
check('二次导入仍然成功', imported2.count === seedCount);

/* ---------- 幂等/上限/异常 ---------- */
console.log('');
console.log('=== 异常与边界 ===');
let e1 = '';
try { await share.importShareCode('随便一段话'); } catch (err) { e1 = err.message; }
check('非本站分享码被拒', e1.includes('分享码'), e1);

let e2 = '';
try { await share.importShareCode('ZYD1:g@@@@'); } catch (err) { e2 = err.message; }
check('损坏的分享码被拒而不是崩溃', e2.length > 0, e2);

let e3 = '';
try { await share.importShareCode(''); } catch (err) { e3 = err.message; }
check('空内容被拒', e3.length > 0, e3);

// 空分类不该生成分享码（放在填满分类之前，否则 addTab 会先失败，
// 测到的就不是"空分类"而是"分类满了"）
const emptyTab = S.addTab();
let e5 = '';
try { await share.makeShareCode(emptyTab.tab.id); } catch (err) { e5 = err.message; }
check('空分类生成分享码时报错而不是给一段空壳', e5.length > 0, e5);

// 分类拉满后导入应该明确报错，而不是静默失败或越界
while (S.tabList().length < S.MAX_TABS) S.addTab();
let e4 = '';
try { await share.importShareCode(code); } catch (err) { e4 = err.message; }
check('分类已满时导入给出明确错误', e4.includes('分类'), e4);

console.log('');
console.log(failed === 0 ? '全部通过' : `有 ${failed} 项失败`);
process.exitCode = failed === 0 ? 0 : 1;
