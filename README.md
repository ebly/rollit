# rollit · 掷一个

把候选条目倒进分类里，每个分类每天掷一个出来，按你的评分加权。
纯本地应用：没有后端、不发任何网络请求，数据全部存在浏览器 localStorage，可离线使用。

## 怎么跑

```bash
npm install
npm run dev        # 开发（监听 0.0.0.0，手机连同一 Wi-Fi 可直接访问）
npm run build      # 产物在 dist/，任意静态托管可用
npm run preview    # 本地预览构建产物（同样监听 0.0.0.0）
npm run check      # 三个自检脚本（权重 / 业务规则 / 分享码）
npm run audit      # 静态体检（死代码 / 未用导入 / 可访问性启发式）
```

注意：dev/preview 监听 `0.0.0.0` 是为了手机联调，同一网段的人都能访问；
在公共 Wi-Fi 下用时留意这一点，不需要就临时改 `vite.config.js` 里的 `host`。

## 架构

- **无后端**：`src/store.js` 同时是"数据库 + 服务层"——状态、localStorage 持久化、
  全部业务规则（每天一次、0 星出池、加权随机）都在这一个文件里。
- **数据键**：`meal-roulette:v1`（v2 结构）。坏档自动备份到
  `meal-roulette:v1:corrupt`；再次损坏会带序号（`:corrupt:1`…），不覆盖更早的备份。
- **日界锁 UTC+8**：不跟随设备时区，手机电脑口径一致（`store.js` 的 `today()`）。
  界面侧的 `day` 是会定时翻转的 ref，页面挂着跨 0 点也不会错位。
- **base 是 './'**：`dist/` 可以双击打开（file://）、可以丢进任意子目录。
  代价：浏览器按来源隔离存储，`file://` / `localhost` / `127.0.0.1` / 局域网 IP
  是不同的数据桶，界面上会有相应提示。
- **PWA**：`public/sw.js` 导航请求网络优先（且只把 2xx 存成离线壳）、
  带 hash 的静态资源缓存优先；`CACHE` 常量每次发布 +1，activate 自动清理旧缓存。
- **分享码**：`ZYD1:` 前缀 + gzip + base64，只含条目名和星级；
  导入是"新增一个分类"，不碰现有数据。分享码是不可信输入，
  有长度上限、条目数上限和解压上限。
- **落盘防抖**：状态变更后 300ms 合并写一次；页面隐藏/关闭立即补写；
  写失败（配额满）会在界面顶部出警告条，不静默吞掉。

## 部署

任意静态托管（对象存储、GitHub Pages、子路径部署都可以）：

1. `npm run build`，把 `dist/` 整个传上去；
2. **必须 HTTPS**——Service Worker 只在安全上下文注册，http 下 PWA 静默不生效；
3. 缓存头建议：`/assets/*` 用 `public, max-age=31536000, immutable`（文件名带 hash），
   `index.html` / `sw.js` / `manifest.webmanifest` 保持 no-cache；
4. 发了新版本记得把 `public/sw.js` 里的 `CACHE` 版本号 +1。

## 回滚

git 回退到上一个 tag → 重新 build 部署旧产物即可。hash 资产 + SW 缓存优先
使回滚没有额外代价；如果 SW 本身有改动，同时递增 `CACHE` 版本号。

## 数据与隐私

零收集、零上报、零第三方请求。数据只在本机浏览器里，
「导出」是唯一的搬家方式（JSON 文件），「清空数据」不可撤销——清之前先导出。

## 自检脚本

| 脚本 | 覆盖 |
|------|------|
| `scripts/check-weight.mjs` | 权重曲线、0 星绝不泄漏 |
| `scripts/check-store.mjs` | 业务规则、v1→v2 迁移、病态存档 sanitize |
| `scripts/check-share.mjs` | 分享码生成/导入往返、异常输入 |
| `scripts/measure-size.mjs` | 容量推演（导出 JSON 字节数 vs 5MB 配额） |
| `scripts/audit.mjs` | 静态体检（启发式，允许误报） |
