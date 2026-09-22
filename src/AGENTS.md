# src/ — 核心库（解析 + 渲染）

Generated: 2026-09-22T03:11:36.090Z Commit: 72331ff (master)

## OVERVIEW

扁平 TS 核心，无 index.ts；`diff2html.ts` 是唯一对外门面，其余文件按「解析 → 渲染 → 工具」分层。

## WHERE TO LOOK

| 文件                                                       | 内容                                                                                                        |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `diff2html.ts`                                             | 门面：`parse`(:24)、`html`(:28)、`Diff2HtmlConfig`(:8)、`defaultDiff2HtmlConfig`(:18)                       |
| `diff-parser.ts`                                           | 状态机式 diff 文本解析，`parse`(:55)，处理 combined diff / 二进制 / too-big                                 |
| `types.ts`                                                 | 领域模型：`LineType`(:6)、`DiffLine`(:34 三态联合)、`DiffBlock`(:38)、`DiffFile`(:49)、`ColorSchemeType`    |
| `line-by-line-renderer.ts` / `side-by-side-renderer.ts`    | 两套镜像渲染器；namespace 常量在 :29-32                                                                     |
| `file-list-renderer.ts`                                    | 侧栏文件列表，namespace `file-summary` + `icon`                                                             |
| `render-utils.ts`                                          | `escapeForHtml`(:112)、`deconstructLine`(:126)、`getFileIcon`(:217)、`diffHighlight`(:239)、行 id/颜色 hash |
| `hoganjs-utils.ts`                                         | 模板注册表 + 缓存，key = `${namespace}-${view}`(:55)                                                        |
| `rematch.ts`                                               | Levenshtein 序列匹配：`levenshtein`(:24)、`newDistanceFn`(:68)、`newMatcherFn`(:79)                         |
| `utils.ts`                                                 | `escapeForRegExp`(:29)、`unifyPath`(:36)、`hashCode`、`max`(:67)                                            |
| `ui/js/diff2html-ui-base.ts`                               | 浏览器层全部行为：`draw()` 注入 DOM 后依次接高亮/滚动同步/折叠                                              |
| `ui/js/diff2html-ui.ts` / `-slim.ts` / `highlight.js-*.ts` | 只负责注入不同体积的 hljs 实例；`-base` 不注入（可传入自定义 hljs）                                         |
| `ui/css/diff2html.css`                                     | 唯一 CSS 源，postcss 产出 `bundles/css/diff2html.min.css`                                                   |

## 数据流

`diff 文本` → `diff-parser.parse` → `DiffFile[]` → `FileListRenderer` + `LineByLineRenderer|SideBySideRenderer` →
`HoganJsUtils.render` → HTML 字符串。

## CONVENTIONS

- 新增配置项：同时改 3 处 —— 对应模块的 `XxxConfig` 接口、`defaultXxxConfig` 常量、`src/diff2html.ts:8` 的
  `Diff2HtmlConfig extends` 列表；只加接口不加默认值会让 `html()` 拿到 `undefined`
- 新增输出格式：在 `types.ts` 的 `OutputFormatType` 加值 → 新增 renderer（镜像 `line-by-line-renderer.ts` 结构）→ 在
  `diff2html.ts:39` 的三元分支加分支 → 建对应 `src/templates/<namespace>-*.mustache` → `npm run build:templates`
- 新增模板：namespace 常量必须写在 renderer 顶部（如 `const baseTemplatesPath = 'line-by-line'`），文件名前缀与之相同
- 行级匹配器按文件新建（`line-by-line-renderer.ts:92-94`），词级匹配器是 `render-utils.ts:55-56` 的模块级单例，不要互换
- `DiffLine` 是判别联合：访问 `oldNumber`/`newNumber` 前先判 `type`，否则 `strictNullChecks` 下拿到的可能是 `undefined`
- 渲染器的 HTML 字符串由 `HoganJsUtils` 缓存实例产出；`html()` 只 new 一个实例传给三个 renderer（`diff2html.ts:35`）
- `ui/js/**` 只能跑在浏览器（用 `document`/`window`），不要被 `src/*.ts` import；`ui/js` 不进覆盖率统计
- 渲染路径中的字符串默认已转义；只有 `file.isTooBig`
  分支刻意不转义（`line-by-line-renderer.ts:102`、`side-by-side-renderer.ts:210`，内容是可信的
  `config.diffTooBigMessage`）
- 未使用的参数/局部变量以 `_` 前缀命名（`noUnusedLocals`/`noUnusedParameters` 开着）

## ANTI-PATTERNS

- 不要绕过 `deconstructLine` 直接 `escapeForHtml`（`render-utils.ts:111` TODO 指定它只服务 `deconstructLine`）
- 不要把 `escape=false` 当性能开关滥用：`deconstructLine(..., false)` 只出现在 `diffHighlight` 内部（先切分后逐段转义）
- 不要在 renderer 里拼 HTML 字符串：结构一律走 mustache 模板
- 不要在 `src/*.ts` 里 import `ui/js/**`：会把 DOM 依赖带进 node 构建产物
- 不要手写新的正则转义逻辑，复用 `utils.ts:29` `escapeForRegExp`
