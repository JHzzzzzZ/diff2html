# src/templates/ — hogan/mustache 模板层

Generated: 2026-09-22T03:11:36.090Z Commit: 72331ff (master)

## OVERVIEW

19 个 mustache 模板，构建期被 `scripts/hulk.ts` 编译进生成文件
`src/diff2html-templates.ts`（`defaultTemplates`），运行期按 key 取用；本目录不参与 tsc 编译，改动只影响生成物。

## WHERE TO LOOK

| 模板                                                           | 渲染者                                                                                       |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `file-summary-wrapper` / `file-summary-line`                   | `file-list-renderer.ts:46` / `:28`（侧栏列表）                                               |
| `generic-wrapper`                                              | `line-by-line-renderer.ts:56`、`side-by-side-renderer.ts:56`（最外层容器）                   |
| `generic-file-path`                                            | 两个 renderer 的 `filePath` partial（`line-by-line-renderer.ts:66`）                         |
| `generic-block-header` / `generic-empty-diff` / `generic-line` | `line-by-line-renderer.ts:100,87,267`；`side-by-side-renderer.ts:208,89,285`                 |
| `line-by-line-file-diff` / `line-by-line-numbers`              | `line-by-line-renderer.ts:65,262`                                                            |
| `side-by-side-file-diff`                                       | `side-by-side-renderer.ts:65`                                                                |
| `icon-file`                                                    | 两个 renderer 的 `fileIcon` partial（`:67`）+ 文件列表 partial（`file-list-renderer.ts:40`） |
| `icon-file-*` / `tag-file-*`（added/changed/deleted/renamed）  | `render-utils.ts:217` `getFileIcon()` 返回后缀名，renderer 据此选模板                        |

## 命名与加载

- key = 文件名去掉**第一个点之后的所有内容**（`hulk.ts:177` 的 `replace(/\..*$/, '')`）→
  `line-by-line-file-diff.mustache` 得到 `line-by-line-file-diff`。**模板名里不要再加点**，`a.b.mustache` 会变成 `a`
- 取用方式：`HoganJsUtils.render(namespace, view)` / `.template(namespace, view)`，内部拼
  `${namespace}-${view}`（`hoganjs-utils.ts:55`），namespace 由 renderer 顶部常量提供
- 生成物 `src/diff2html-templates.ts` 被 `.gitignore` 忽略、被 eslint/jest 排除，但 `hoganjs-utils.ts:5`
  会 import 它：**改完模板必须 `npm run build:templates`**，否则测试与构建报模块缺失
- 用户可用 `config.rawTemplates` / `compiledTemplates` 覆盖同名 key（`hoganjs-utils.ts:23-29` 的合并顺序：内置 <
  compiledTemplates < rawTemplates）

## CONVENTIONS

- 部分渲染（partial）靠 renderer 传模板对象：`file-summary-line` 用 `{{>fileIcon}}`，`generic-file-path` 用
  `{{>fileIcon}}`/`{{>fileTag}}`，键名在 `line-by-line-renderer.ts:74-81` 与 `file-list-renderer.ts:39-41`
  提供；改模板里的 `{{>name}}` 必须同步改 renderer
- 报错会误导：`HoganJsUtils.render` 把所有异常统一重写成
  `Could not find template to render '<key>'`（`hoganjs-utils.ts:34-46`），partial 名写错时看到的也是这条
- 动态内容一律 `{{{ }}}` 原样插入（`generic-line.mustache:8,14`、`generic-file-path` 的
  `filePath`）；转义是调用方责任，模板里不做 `{{ }}` 双保险
- class 名是公开契约：`d2h-*` 前缀被
  `src/ui/css/diff2html.css`、`diff2html-ui-base.ts`（折叠/滚动同步）与网站 CSS 选择器依赖，改名等于改公共 API
- 新增图标/标签：`icon-file-<state>.mustache` + `tag-file-<state>.mustache` 成对添加，并在 `render-utils.ts:217`
  `getFileIcon()` 里加分支
- 只放 HTML 片段，不放样式与脚本

## ANTI-PATTERNS

- 不要在 `website/` 复用本目录模板：那里是 handlebars（`.handlebars` +
  `handlebars-loader`，`webpack.website.ts:81-88`），语法与 partial 机制不同
- 不要手改 `src/diff2html-templates.ts`：生成物，下次 `build:templates` 覆盖
- 不要用 `{{ }}` 输出 diff 内容：会二次转义，屏幕上出现 `&amp;lt;`
- 不要给文件起带多个点的模板名（key 会被截断）
- 不要在模板里写死文件名：`filePath`/`fileDiffName`/`fileName` 由 `render-utils.ts` 的 `filenameDiff` 与 `getHtmlId`
  计算
