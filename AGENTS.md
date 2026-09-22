# PROJECT KNOWLEDGE BASE

Generated: 2026-09-22T03:11:36.090Z Commit: 72331ff (master)

## OVERVIEW

diff2html：把 git / unified diff 文本解析成 JSON，再渲染成 HTML（line-by-line 或 side-by-side）。发布 npm 包（CommonJS
`lib/`、ESM `lib-esm/`、浏览器 UMD `bundles/`）与网站 diff2html.xyz。

## STRUCTURE

只记非 obvious 用途：

- `src/` 扁平 TS 核心，**无 index.ts**；公开入口是 `src/diff2html.ts`
- `src/ui/js/` 浏览器专用（DOM + highlight.js），不进 npm main，单独打 3 个 bundle
- `src/diff2html-templates.ts` 是**生成物**：被 `.gitignore` 忽略，却被 `src/hoganjs-utils.ts:5` import → 新克隆必须先
  `npm run build:templates`
- `website/` 构建输出到 `docs/`（GitHub Pages 命名），实际部署到 S3 + CloudFront
- 两个模板引擎：`src/` 用 mustache/hogan，`website/` 用 handlebars（`webpack.website.ts:81-88`）
- `scripts/hulk.ts` 唯一用途：把 mustache 编译成 TS 模板模块
- `typings/` 既是 `typeRoots` 目录，又随 npm 发布

## WHERE TO LOOK

| 任务                              | 位置                                                                |
| --------------------------------- | ------------------------------------------------------------------- |
| 解析 diff 文本 / 支持新 diff 语法 | `src/diff-parser.ts`                                                |
| 改 HTML 结构或 class              | `src/templates/*.mustache` + 对应 renderer                          |
| 行级/词级相似度匹配               | `src/rematch.ts` + `src/render-utils.ts:239`                        |
| 转义 / XSS / 行高亮               | `src/render-utils.ts:112` `escapeForHtml`、`:126` `deconstructLine` |
| 文件列表（侧栏）                  | `src/file-list-renderer.ts` + `src/templates/file-summary-*`        |
| 浏览器 UI（滚动同步、高亮、折叠） | `src/ui/js/diff2html-ui-base.ts`                                    |
| 网站页面 / 在线 demo              | `website/templates/pages/{index,demo}/`                             |
| 测试                              | `src/__tests__/<name>-tests.ts`                                     |
| 构建 / 发布 / 部署                | `package.json` scripts + `.github/workflows/`                       |
| 基础设施（S3/CDN/Route53）        | `terraform/`（手动 apply，无 CI）                                   |

## CODE MAP

引用 = `src/` 内含该模块 import 语句的文件数（grep 实测）。

| 符号                                                                  | 位置                                                                 | 引用  | 职责                                                                      |
| --------------------------------------------------------------------- | -------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------- |
| `parse` / `html`                                                      | `src/diff2html.ts:24,28`                                             | 2     | 唯一公开 API：文本→`DiffFile[]`；文本或 `DiffFile[]`→HTML                 |
| `DiffFile` / `DiffLine` / `DiffBlock`                                 | `src/types.ts:49,34`                                                 | 14    | 领域模型；`DiffLine` 按 `LineType` 三态联合，`oldNumber`/`newNumber` 互斥 |
| `escapeForHtml` / `deconstructLine` / `diffHighlight` / `getFileIcon` | `src/render-utils.ts:112,126,239,217`                                | 7     | 转义、拆行、词级高亮、图标模板名                                          |
| `HoganJsUtils`                                                        | `src/hoganjs-utils.ts:20`                                            | 8     | 模板注册表：key = `${namespace}-${view}`，构造时缓存，缺 key 抛错         |
| `levenshtein` / `newMatcherFn`                                        | `src/rematch.ts:24,79`                                               | 3     | 贪心 Levenshtein 序列匹配（行级与词级共用）                               |
| `LineByLineRenderer` / `SideBySideRenderer`                           | `src/line-by-line-renderer.ts:34`、`src/side-by-side-renderer.ts:34` | 2 / 2 | 两种输出格式，镜像实现，共用 `render-utils`                               |
| `Diff2HtmlUI`                                                         | `src/ui/js/diff2html-ui-base.ts:38`                                  | 2     | DOM 注入 + 高亮/滚动同步/折叠；`-ui`、`-ui-slim` 只注入 hljs              |
| `escapeForRegExp` / `unifyPath` / `max`                               | `src/utils.ts:29,36,67`                                              | 12    | 路径与安全小工具；`max` 手写循环                                          |

## CONVENTIONS

只写偏离常识的。

- 模板文件名 =
  `${namespace}-${view}.mustache`，renderer 里的 namespace 常量（`line-by-line-renderer.ts:29-32`）必须与文件名前缀一致；不一致则运行期抛
  `Could not find template to render '<key>'`
- 新增/改名/删除模板后必须重跑 `npm run build:templates`；生成物不入库
- 测试文件命名 `*-tests.ts`（不是 `*.test.ts`），放 `src/__tests__/`，期望值用内联快照
- 覆盖率阈值强制：statements 93 / branches 86 / functions 98 / lines 93（`jest.config.js`）；`src/ui/**`
  与生成模板文件被排除
- lint **无类型感知规则**（`recommendedTypeChecked` 全被注释，`eslint.config.mjs:10-14`）：`no-floating-promises`
  不生效，别指望 lint 抓 Promise/类型错误
- 未使用的变量/参数/捕获错误报 error，除非名字以 `_` 开头（`eslint.config.mjs:11-24`）
- prettier：printWidth 120 / singleQuote / semi / trailingComma all / arrowParens avoid
- 接口不加 `I`
  前缀（`DiffFile`、`Diff2HtmlConfig`）：lint 无 naming-convention 规则拦不住，加了只会与既有 17 个导出类型不一致
- 提交信息：首行 ≤50 字符且 `subsystem: 描述` 前缀，第二行空，正文 72 列（`CONTRIBUTING.md`）；同步用 `git rebase`
  不用 merge

## ANTI-PATTERNS

- 不要在 `deconstructLine` 之外调用 `escapeForHtml`（`render-utils.ts:111` TODO 明示它只该在 `deconstructLine` 内使用）
- 不要把大数组展开进 `Math.max(...arr)`：`utils.ts:67` 用循环规避 `Maximum call stack size exceeded`
- 不要在拿到文件名之前输出文件块（`diff-parser.ts:111`，防二进制文件报错）
- 不要在三行 header 未齐全时开新文件（`diff-parser.ts:347`，对应 issues/87）
- 不要把未转义数据交给 `{{{ }}}` 模板槽：`filePath`、`blockHeader` 必须由调用方先 `escapeForHtml`
- 不要提交构建产物：`lib/`、`lib-esm/`、`bundles/`、`docs/`、`bundles-out/`、`src/diff2html-templates.*` 均在
  `.gitignore`

## COMMANDS

- 首次或改过模板后：`npm run build:templates`（否则 tsc/jest 找不到 `./diff2html-templates`）
- 跑单个测试并写快照：`npx jest src/__tests__/<name>-tests.ts -u`（`npm test` 本地会进 watch，CI 才跑 `test:coverage`）
- 全量门禁：`npm run validate`（build:templates → format:check → lint:check → build → test:coverage）
- 网站本地开发：`npm run start:website`
- 单独构建：`npm run build:commonjs` / `build:esm` / `build:bundles` / `build:website`（都以 `rm -rf`
  开头，Windows 需 bash）

## NOTES

- 新克隆必跑 `build:templates`；PR CI（`ci.yml`）的 build job 只 `build` 不跑测试，测试在 master 发布时随
  `npm run validate` 执行；CI node 矩阵 20.x / 22.x / 24.x，`engines` 声明 `>=12`
- `terraform/` 无 CI 覆盖，`terraform apply` 手动执行；根目录 `CNAME` 是 GitHub Pages 遗留，S3/CloudFront 部署不使用
- 发布：`codacy/git-version` 算版本号，tag 为 `latest`/`next`/`pr`；同时发 npm 与 GPR（发布前 sed 改包名为
  `@rtfpessoa/diff2html`）
- `src/rematch.ts` 无测试；`src/ui/**` 无测试且不计覆盖率
- `README.md` 的 TOC 由 lint-staged 自动重写（`gen:toc-base`），手改会被覆盖
- 大文件/长行慢或 OOM：配置 `{"matching": "none"}` 关闭行匹配（README Troubleshooting）
