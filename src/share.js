/**
 * 分享码：把一份清单压成一段可粘贴的短文本。
 *
 * 为什么不用 JSON 文件：手机上从聊天软件"长按粘贴"远比去文件管理器找
 * 一个下载下来的 .json 容易。日常量级压缩后只有几百字符。
 *
 * 格式：ZYD1:<编码标记><base64>
 *   编码标记 g = gzip 压缩，p = 明文（浏览器不支持 CompressionStream 时降级）
 *
 * 与「导出/导入」的区别（重要）：
 *   导出/导入是【整体覆盖】备份，为自己的档留底；
 *   分享码导入是【新增共存】—— 导入后生成一个新分类，不碰你现有数据。
 *   两者语义不同，所以没有合并成一个功能。
 */
import { tabById, dishesOf, addTab, renameTab, addDish, setStars, MAX_TAB_NAME } from './store.js';

const PREFIX = 'ZYD1:';

/**
 * 分享码是不可信输入（谁都能粘一段文本给你），和文件导入同等对待：
 *   - 解压前限长：gzip 放大比极高（实测 100MB 数据压成 132KB，≈771:1），
 *     不设上限等于把 OOM 主动权交给粘贴板里的一段文本；
 *   - 导入限条数：十万条的码会同步执行十万次 addDish，直接卡死标签页。
 */
const MAX_CODE_LEN = 200_000;
const MAX_IMPORT_ITEMS = 500;

/** 分块转换，避免大数组 spread 撑爆调用栈 */
function bytesToBinary(bytes) {
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return out;
}

function binaryToBytes(bin) {
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

const b64encode = (bytes) => btoa(bytesToBinary(bytes));
const b64decode = (s) => binaryToBytes(atob(s));

async function encode(text) {
  const raw = new TextEncoder().encode(text);
  if (typeof CompressionStream === 'function') {
    const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'));
    const buf = new Uint8Array(await new Response(stream).arrayBuffer());
    return 'g' + b64encode(buf);
  }
  // 降级：不压缩。日常几百字节的数据，base64 后也还在一千字符以内
  return 'p' + b64encode(raw);
}

async function decode(body) {
  if (body.length > MAX_CODE_LEN) throw new Error('分享码太长了，可能已损坏');
  const flag = body[0];
  const bytes = b64decode(body.slice(1));
  if (flag === 'g') {
    if (typeof DecompressionStream !== 'function') {
      throw new Error('这个浏览器不支持解压，无法读取压缩过的分享码');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new TextDecoder().decode(await new Response(stream).arrayBuffer());
  }
  if (flag === 'p') return new TextDecoder().decode(bytes);
  throw new Error('分享码格式不对');
}

/**
 * 生成某个分类的分享码。
 * 只带名字和星级，不带 id、时间、抽签记录 —— 那些属于你自己的历史，
 * 分享出去对别人没有意义，还会撑大体积。
 *
 * @param {string} tabId
 * @returns {Promise<string>}
 */
export async function makeShareCode(tabId) {
  const tab = tabById(tabId);
  if (!tab) throw new Error('分类不存在');
  const items = dishesOf(tabId).map((d) => [d.name, d.stars]);
  if (!items.length) throw new Error('这个分类还是空的，没什么可分享的');
  const payload = { n: tab.name, i: items };
  return PREFIX + await encode(JSON.stringify(payload));
}

/**
 * 导入分享码：新建一个分类并把条目放进去，不动现有数据。
 * 重名分类会自动加后缀，而不是覆盖或报错。
 *
 * @param {string} code
 * @returns {Promise<{tabName: string, count: number, skipped: number}>}
 */
export async function importShareCode(code) {
  const text = String(code ?? '').trim();
  if (!text) throw new Error('没有内容');
  if (!text.startsWith(PREFIX)) throw new Error('这不是「掷一个」的分享码');

  let payload;
  try {
    payload = JSON.parse(await decode(text.slice(PREFIX.length)));
  } catch (e) {
    throw new Error(e?.message?.includes('解压') ? e.message : '分享码损坏，读不出来');
  }
  if (!payload || !Array.isArray(payload.i)) throw new Error('分享码里没有清单');

  const created = addTab();
  if (created.error) throw new Error(created.error);

  // 重名加后缀。后缀长度按 i 生长，且前缀按 MAX_TAB_NAME 反向截断：
  // 早期固定 slice(0,10)+'(i)'，i≥10 时拼出 13 字符超出上限，
  // renameTab 全部失败，最后提示的名字和界面上的对不上。
  const wanted = String(payload.n ?? '分享的清单').slice(0, MAX_TAB_NAME) || '分享的清单';
  let name = wanted;
  for (let i = 2; i <= 20; i++) {
    if (!renameTab(created.tab.id, name).error) break;
    const suffix = `(${i})`;
    name = `${wanted.slice(0, MAX_TAB_NAME - suffix.length)}${suffix}`;
  }
  // 以界面上的真实名字为准（极端情况下 rename 全失败，tab 保留默认名）
  const tabName = tabById(created.tab.id)?.name ?? name;

  let count = 0;
  let skipped = 0;
  const items = Array.isArray(payload.i) ? payload.i : [];
  if (items.length > MAX_IMPORT_ITEMS) skipped += items.length - MAX_IMPORT_ITEMS;
  for (const item of items.slice(0, MAX_IMPORT_ITEMS)) {
    const [itemName, stars] = Array.isArray(item) ? item : [item, null];
    const added = addDish(created.tab.id, itemName);
    if (added.error) { skipped++; continue; }
    // 星级容错：数字/数字字符串都收，其余按未评。注意 Number(null)===0，
    // 必须先挡掉 null，否则未评分条目会被当成 0 星直接踢出池。
    const s = stars == null ? null : Number(stars);
    if (s !== null && Number.isInteger(s) && s >= 0 && s <= 5) setStars(added.dish.id, s);
    count++;
  }

  return { tabName, count, skipped };
}
