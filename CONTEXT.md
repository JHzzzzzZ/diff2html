# Diff2Html

把 git / unified diff 解析并渲染成可交互 HTML 的库（npm 包 + CLI +
diff2html.xyz 网站）。本文件是术语表：只收本项目特有的领域概念，不记实现细节。

## Language

**Gap**: 一个文件内未被渲染的行区间——相邻两个 hunk 之间、首个 hunk 之前到文件头、末个 hunk 之后到文件尾。Gap 是上下文展开的基本单位。
_Avoid_: context region、折叠区

**Hidden range (`hiddenTop` / `hiddenBottom`)**:
Gap 在当前时刻仍未揭示的行区间，用新文件行号的一对端点表示。两端随揭示向中间收缩，相遇即 gap 关闭。`hiddenBottom`
为空表示文件尾长度未知（内容源未提供总行数）。 _Avoid_: boundary / bound（已被取代的一对近义旧名）

**Reveal（揭示）**: 应用户点击，把 hidden range 贴近某一侧 hunk 的一段行（一个 chunk）插入渲染输出，并同步收缩 hidden
range。同一个 gap 的两侧可各自触发 reveal，共享同一份 hidden range。 _Avoid_: 展开（仅用于"展开更多"按钮文案）、load

**Comment anchor（评论锚点）**: 一条行评论的定位三元组 `(filePath, lineNumber, side)`。`side`
决定行号指旧文件还是新文件；锚点不随揭示变化，所以 gap 展开后评论仍落在原行。_Avoid_: 位置、坐标

**Reveal to anchor（按锚点揭示）**: 导入或从导航面板跳转时，程序化地反复 reveal 到锚点行（`old`
锚点先按 gap 的 delta 换算成新文件行号），而不是让用户手动点展开。_Avoid_: 自动展开

**Placed / unplaced（可定位 / 不可定位）**: 导入报告里的区分：`imported` 是校验通过的条数，`placed`
是其中在渲染结果里真正找到行（或文件面板）的条数；两者之差即
`unplaced`（diff 里没有这个文件或这行）。_Avoid_: 成功/失败（失败专指整个导入被拒绝）
