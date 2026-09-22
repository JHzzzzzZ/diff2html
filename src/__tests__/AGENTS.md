# src/**tests**/ — jest + ts-jest 测试

Generated: 2026-09-22T03:11:36.090Z Commit: 72331ff (master)

## OVERVIEW

8 个 `*-tests.ts` 与 2 个 diff 样本；期望值以内联快照写回测试文件本身，仓库没有 `__snapshots__` 目录。测试文件被
`tsconfig.json` 排除，只由 ts-jest 编译。

## WHERE TO LOOK

| 文件                                          | 覆盖对象                                  | 行数 |
| --------------------------------------------- | ----------------------------------------- | ---- |
| `diff-parser-tests.ts`                        | `parse()` 文本解析全分支                  | 2518 |
| `diff2html-tests.ts`                          | 公开 API `parse`/`html` 端到端 + 配置组合 | 1551 |
| `line-by-line-tests.ts`                       | `LineByLineRenderer`                      | 725  |
| `side-by-side-printer-tests.ts`               | `SideBySideRenderer`                      | 538  |
| `file-list-renderer-tests.ts`                 | `FileListRenderer`                        | 272  |
| `printer-utils-tests.ts`                      | `render-utils` 的转义/高亮/文件名工具     | 152  |
| `hogan-cache-tests.ts`                        | `HoganJsUtils` 模板覆盖与缓存             | 56   |
| `utils-tests.ts`                              | `utils.ts`                                | 31   |
| `diffs/large.diff`、`diffs/bad-escaping.diff` | 仅有的外部 fixture                        | —    |

## 新增一个测试（照抄这 5 步）

1. 新建 `src/__tests__/<name>-tests.ts`，`import` 源文件用相对路径 `../<module>`
2. 用 `describe('ClassName', () => describe('method', () => ...))` 嵌套；配置变体额外包一层
   `describe('with dark colorScheme', ...)`
3. 输入内联构造：解析测试拼 diff 字符串，渲染测试造 `DiffFile` 对象
4. 断言用 `expect(result).toMatchInlineSnapshot()`，**参数留空**，然后 `npx jest src/__tests__/<name>-tests.ts -u`
   让 jest 把快照写进源码；纯标量用 `toBe`/`toContain`
5. `npx jest --coverage` 确认阈值仍过（阈值数值见 `jest.config.js` 与根 `AGENTS.md`）

## CONVENTIONS

- 文件命名 `*-tests.ts`：jest 未配置 `testMatch`，默认 `**/__tests__/**/*.[jt]s` 会收集本目录下任意 `.ts`；名字写成
  `*.test.ts` 也能跑，但 eslint 的 jest 规则块只匹配 `src/__tests__/**/*tests.ts`，`describe`/`it` 会被报未定义
- fixture 路径是 **cwd 相对**（`fs.readFileSync('src/__tests__/diffs/large.diff', 'utf-8')`），必须从仓库根运行 jest
- 除 2 个 `.diff` 外不要新增 fixture 文件：期望 HTML/JSON 一律进内联快照
- 改渲染输出后必须 `-u` 重写快照；漏改会在 `test:coverage` 的断言处失败
- 覆盖率收集范围 = `src/**/*.ts` 减去
  `src/ui/**`、`src/diff2html-templates.ts`、`src/__tests__/**`；新增源文件自动进入分母，没测到就拉低阈值
- 新增测试前先 `npm run build:templates`：`hoganjs-utils.ts` import 的 `./diff2html-templates`
  是生成物，缺失时整个套件加载失败

## ANTI-PATTERNS

- 不要在本地用 `npm test` 当单次运行：它是 `is-ci 'test:coverage' 'test:watch'`，本地会进 watch 挂住
- 不要新建 `__snapshots__/`：与仓库内联快照风格冲突，且不在 `.gitignore` 之外的管理约定里
- 不要为本目录写 `tsconfig` 特例：`tsconfig.json` 显式 `exclude` 了 `src/__tests__/**`，改它会把测试编译进 `lib/`
- 不要假设 `src/ui/**` 与 `src/rematch.ts` 有测试（实测无引用）：动这两处等于无回归网，必须手测或先补测试
- 不要在测试里依赖测试执行顺序：jest 默认并行，仓库未配置 `setupFiles`/`roots`/串行
