/**
 * 静态体检：node scripts/audit.mjs
 *
 * 查的是"能跑但已经烂掉"的东西 —— 构建不会报、测试也测不出来的那类：
 *   1. 模板里绑定的处理器在 <script> 里根本没定义（点下去才炸）
 *   2. import 了但没用到的名字
 *   3. export 了但全项目没人用的函数/常量
 *   4. style.css 里存在但模板中已无对应元素的死样式
 *   5. 同一文件里重复的顶层 const
 *   6. 纯符号按钮缺可访问名称（✎ / 🗑 / × / ＋）
 *
 * 全部基于正则启发式，会有误报。这里的原则是：宁可多报，让人自己判断；
 * 但每条都给出文件名和行号，方便人工核对。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const vueFiles = ['src/App.vue', 'src/views/HomeView.vue'];
const jsFiles = ['src/main.js', 'src/store.js', 'src/weight.js', 'src/share.js'];
const scriptFiles = readdirSync(join(root, 'scripts'))
  .filter((f) => f.endsWith('.mjs'))
  .map((f) => `scripts/${f}`);

const allFiles = [...vueFiles, ...jsFiles, ...scriptFiles];

const findings = [];
const note = (level, area, msg) => findings.push({ level, area, msg });

/* ---------- 拆分 Vue 文件的 script / template ---------- */
function splitVue(path) {
  const raw = read(path);
  const script = (raw.match(/<script setup>([\s\S]*?)<\/script>/) ?? ['', ''])[1];
  const template = (raw.match(/<template>([\s\S]*)<\/template>/) ?? ['', ''])[1];
  return { raw, script, template };
}

/* ---------- 1. 模板事件处理器的定义检查 ---------- */
for (const path of vueFiles) {
  const { script, template } = splitVue(path);
  const handlers = new Set();
  for (const m of template.matchAll(/@[a-z]+(?:\.\w+)?="([^"]+)"/g)) {
    const expr = m[1].trim();
    // 只取形如 fn 或 fn(...) 的简单处理器；内联赋值（tab = t.id）跳过
    const name = expr.match(/^([A-Za-z_$][\w$]*)\s*\(/)?.[1] ?? expr.match(/^([A-Za-z_$][\w$]*)$/)?.[1];
    if (name) handlers.add(name);
  }
  for (const h of handlers) {
    const defined = new RegExp(`(?:function\\s+${h}\\b|const\\s+${h}\\s*=|let\\s+${h}\\s*=|async\\s+function\\s+${h}\\b)`).test(script)
      // 可能是从 store.js 直接导入的函数
      || new RegExp(`\\b${h}\\b`).test(script);
    if (!defined) note('ERROR', path, `模板绑定的处理函数 "${h}" 在 <script> 里找不到`);
  }
}

/* ---------- 2. 未使用的 import ---------- */
for (const path of [...vueFiles, ...jsFiles]) {
  const raw = read(path);
  const importBlock = raw.match(/import\s*\{([\s\S]*?)\}\s*from\s*['"][^'"]+['"]/g) ?? [];
  for (const block of importBlock) {
    const names = (block.match(/\{([\s\S]*?)\}/)?.[1] ?? '')
      .split(',')
      .map((s) => s.trim().split(/\s+as\s+/).pop().trim())
      .filter(Boolean);
    const body = raw.replace(block, '');
    for (const n of names) {
      const used = new RegExp(`\\b${n.replace(/[$]/g, '\\$')}\\b`).test(body);
      if (!used) note('WARN', path, `import 了 "${n}" 但文件里没用到`);
    }
  }
}

/* ---------- 3. 未被使用的导出 ---------- */
for (const path of jsFiles) {
  if (path.endsWith('main.js')) continue;
  const raw = read(path);
  const exported = new Set();
  for (const m of raw.matchAll(/export\s+(?:async\s+)?(?:function|const|let)\s+([A-Za-z_$][\w$]*)/g)) exported.add(m[1]);
  for (const m of raw.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const piece of m[1].split(',')) {
      const n = piece.trim().split(/\s+as\s+/).pop().trim();
      if (n) exported.add(n);
    }
  }
  for (const n of exported) {
    // 在【其他文件】里是否被引用
    const others = allFiles
      .filter((p) => p !== path)
      .map(read)
      .join('\n');
    const usedOutside = new RegExp(`\\b${n}\\b`).test(others);
    if (!usedOutside) note('WARN', path, `导出的 "${n}" 全项目无引用（可能是死代码）`);
  }
}

/* ---------- 4. 死 CSS（类名在模板中不存在） ---------- */
const css = read('src/style.css');
const classDefs = new Set();
for (const m of css.matchAll(/\.([a-zA-Z][\w-]*)/g)) classDefs.add(m[1]);
const markup = [...vueFiles.map((p) => read(p)), read('index.html')].join('\n');
for (const cls of classDefs) {
  // 类名可能出现在 class="..."、:class="{ cls: ... }"、动态拼接里，用宽松匹配
  if (!new RegExp(`\\b${cls}\\b`).test(markup)) note('WARN', 'src/style.css', `样式类 ".${cls}" 在模板里找不到使用处`);
}

/* ---------- 5. 重复的顶层 const ---------- */
for (const path of [...vueFiles, ...jsFiles]) {
  const { script } = path.endsWith('.vue') ? splitVue(path) : { script: read(path) };
  const seen = new Map();
  for (const m of script.matchAll(/^(?:const|let)\s+([A-Za-z_$][\w$]*)/gm)) {
    const n = m[1];
    if (seen.has(n)) note('ERROR', path, `顶层重复声明 "${n}"`);
    seen.set(n, true);
  }
}

/* ---------- 6. 纯符号按钮缺可访问名称 ---------- */
for (const path of vueFiles) {
  const raw = read(path);
  for (const m of raw.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
    const attrs = m[1];
    const inner = m[2].replace(/<!--[\s\S]*?-->/g, '').trim();
    const hasWord = /[A-Za-z\u4e00-\u9fa5]/.test(inner) || /\{\{/.test(inner);
    const hasName = /aria-label|:aria-label/.test(attrs);
    const hasTitle = /\btitle=/.test(attrs);
    if (!hasWord && !hasName) {
      note(hasTitle ? 'INFO' : 'WARN', path,
        `纯符号按钮 <button${attrs.trim() ? ' ' + attrs.trim().slice(0, 40) + '…' : ''}> 内容为 "${inner.slice(0, 6)}"，${hasTitle ? '有 title 但' : ''}缺 aria-label`);
    }
  }
}

/* ---------- 输出 ---------- */
const order = { ERROR: 0, WARN: 1, INFO: 2 };
findings.sort((a, b) => order[a.level] - order[b.level]);

if (!findings.length) {
  console.log('未发现问题。');
} else {
  for (const f of findings) console.log(`[${f.level}] ${f.area}  ${f.msg}`);
}
const count = (l) => findings.filter((f) => f.level === l).length;
console.log('');
console.log(`合计 ERROR ${count('ERROR')} / WARN ${count('WARN')} / INFO ${count('INFO')}`);
process.exitCode = count('ERROR') > 0 ? 1 : 0;
