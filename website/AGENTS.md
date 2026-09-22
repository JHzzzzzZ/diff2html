# website/ — diff2html.xyz 站点源码

Generated: 2026-09-22T03:11:36.090Z Commit: 72331ff (master)

## OVERVIEW

静态站源码，webpack（handlebars-loader + ts-loader + postcss）构建到 `docs/`，再被 CI 同步到 S3 `diff2html.xyz` +
CloudFront。本地开发用 `npm run start:website`。

## WHERE TO LOOK

| 路径                                         | 用途                                                                                               |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `templates/template.handlebars`              | 唯一 HTML 外壳：head/GA/nav/footer，正文位置是 `{{#block "content"}}{{/block}}`                    |
| `templates/helpers/block.ts`                 | 定义 `block` helper，把页面内容注册成 partial 供外壳取用                                           |
| `templates/helpers/partial.ts`               | 定义 `partial` helper，`{{#partial "content"}}...{{/partial}}` 注册内容块                          |
| `templates/pages/<page>/<page>.handlebars`   | 页面入口模板，固定三行：`{{#partial "content"}}{{> content}}{{/partial}}` + `{{> ../../template}}` |
| `templates/pages/<page>/content.handlebars`  | 页面正文片段（被 `{{> content}}` 引入）                                                            |
| `templates/pages/<page>/<page>.ts`           | 页面脚本入口（webpack entry）                                                                      |
| `templates/pages/<page>/*.css`               | 页面样式，经 postcss-loader                                                                        |
| `main.ts` / `main.css`                       | 全站共用：bulma + 移动端导航折叠；两个页面都 `import` 它                                           |
| `templates/pages/demo/demo.ts`               | 在线 demo：直接 import `src/ui/js/diff2html-ui-slim` 与 `src/render-utils`、`src/types`            |
| `templates/pages/index/index.ts`             | 首页：clipboard 复制按钮                                                                           |
| `favicon.ico` / `robots.txt` / `sitemap.xml` | 由 CopyPlugin 原样复制到 `docs/`                                                                   |
| `templates/pages/index/images/*.png`         | 截图，file-loader 输出到 `docs/images/` 并压缩                                                     |

## CONVENTIONS

- 加一个页面 = 4 处：`webpack.website.ts:10` 的 `pages` 数组加名字 → 新建
  `templates/pages/<page>/{<page>.handlebars,<page>.ts,content.handlebars}` → 模板按固定三行写法引用外壳 →
  `npm run build:website` 验证产出 `docs/<page>.html`。只建目录不改数组不会被构建
- 页面模板的 partial 路径是相对 `partialDirs`（`website/templates`）解析的，所以引用外壳要写 `{{> ../../template}}`
- 页面只能通过源码相对路径引用库：`../../../../src/...`（`demo.ts:1,6,8`）。网站构建不依赖 `lib/`、`bundles/`，所以改
  `src/` 后网站会立刻用上新代码
- `.handlebars` 是这里的模板语言（handlebars-loader）；`inlineRequires: '/images/'` 让图片路径走 require 处理
- CSS 走 postcss-loader：`postcss.config.js` 的 import/preset-env/cssnano 对页面 CSS 同样生效
- `docs/` 是构建产物，`.gitignore` 忽略，由 CI 上传 artifact 后 S3 同步

## ANTI-PATTERNS

- 不要在 `website/` 写 mustache 或 `{{>filePath}}` 这类 src 模板语法：两套引擎不同（src 用 `@profoundlogic/hogan`）
- 不要手改或提交 `docs/`：`build:website` 开头 `rm -rf docs`
- 不要在这里 import `lib/`、`lib-esm/`、`bundles/`：那些目录本地通常不存在，构建顺序上网站是 `build` 的最后一步
- 不要新建顶层 `.html`：页面 HTML 一律由 `<page>.handlebars` 经 HtmlWebpackPlugin 生成，`docs/*.html` 的名字来自 `pages`
  数组
- 不要删 `sitemap.xml` / `robots.txt`
  的 CopyPlugin 条目：线上有这两个 URL，CloudFront 失效列表也点名了它们（`.github/workflows/release.yml`）
