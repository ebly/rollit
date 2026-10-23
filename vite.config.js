import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// 纯静态站点，没有后端，数据全在浏览器 localStorage 里。
//
// base 必须是 './' 而不是默认的 '/'：默认值会把资源写成绝对路径，
// 双击 index.html （file://）时 JS/CSS 全部 404，页面白屏。
// 用相对路径后，dist/ 既可以直接发人双击，也能丢到任意子目录的静态空间。
//
// 但 file:// 下 localStorage 在部分浏览器会被限制，
// 要稳定使用请走 npm run preview（本地 HTTP）或直接挂到一个静态服务器上。
export default defineConfig({
  base: './',
  plugins: [vue()],
  build: { outDir: 'dist' },
});
