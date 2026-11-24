# 简体中文汉化流水线

每天自动检查上游 [Moustachauve/cookie-editor](https://github.com/Moustachauve/cookie-editor) 的最新提交，
现场把界面文案换成中文，打包成各浏览器的 zip，发一个 Release。

**仓库里不保存汉化后的代码**：只有这个目录（词典 + 打补丁脚本）和 `.github/workflows/zh-sync.yml`。
上游改什么都不会产生合并冲突。

## 文件

| 文件 | 作用 |
| --- | --- |
| `zh-CN.json` | 词典：`text`（HTML 文本）、`attrs`（placeholder/title 等）、`js`（JS 里写死的提示语） |
| `localize.mjs` | 把上游源码复制出来并逐条替换文案，同时报告"上游新增的英文"和"词典里失效的条目" |
| `ci.mjs` | 完整流水线：查上游 → 去重 → 下载 → 汉化 → 打包 → 发 Release |
| `heartbeat.mjs` | 每 7 天留一次心跳提交，避免公共仓库 60 天无活动被停用定时任务 |
| `state.json` | 上次检查/发布的结果，由工作流自动更新 |

## 上游发了新版本但没汉化完整？

Release 说明里会列出未翻译的英文原文，例如：

```
interface/options/options.html: Enable Telemetry
```

在 `zh-CN.json` 的 `text` 里加一行即可，下次运行自动生效：

```json
"Enable Telemetry": "启用使用统计"
```

改完也可以手动跑一次：仓库 Actions 页面 → 「上游同步 · 汉化发布」→ Run workflow。

## 本地试构建

```bash
node localize/localize.mjs --src . --out dist          # 只汉化
node localize/ci.mjs --build-only --src . --out dist   # 汉化 + 打包
```

`dist/chrome`（Edge 同样适用）、`dist/firefox`、`dist/opera` 都可以直接在浏览器里
「加载解压缩的扩展」。

## 词典编写约定

- 键必须是**上游原文**，大小写、标点、空格都要一致；脚本会按"多余空白折叠成一个空格"后匹配。
- `text` 里的键是 HTML 文本节点（多行段落会被折叠成一行再匹配）。
- `attrs` 只认这几个属性：`placeholder`、`title`、`aria-label`、`alt`、`data-tooltip`、`data-tooltip-left`。
- `js` 只作用于 `interface/lib/cookie.js`、`interface/lib/ads/activeAds.js`、
  `interface/popup/cookie-list.js`、`interface/options/options.js`、
  `interface/devtools/devtools.js`、`cookie-editor.js` 里的**完整字符串字面量**。
- 品牌名 `Cookie-Editor`、规格值 `SameSite` / `None` / `Lax` / `Strict`、格式名 `JSON` / `Netscape`
  保持原样，放在 `keep` 里，这样覆盖率报告不会把它们算成漏翻。
- 浏览器自己抛出的报错（如 `Invalid cookie fields`）不会翻译，那些字符串来自 Chrome/Firefox。

## 注意

- 工作流依赖 `GITHUB_TOKEN` 的 `contents: write` 权限，用来建 Release 和推心跳分支，不需要额外配 secret。
- fork 的 Actions 如果被 GitHub 关掉，定时任务不会跑。去 Actions 页签确认一次即可；
  也可以随时用「Run workflow」手动补一次。
- 汉化只改界面文案，不动任何 Cookie 读写逻辑。
