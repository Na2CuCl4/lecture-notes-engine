# 内容格式（schemaVersion 1）

内容仓库保存 UTF-8 文件。引擎不改写输入；校验成功后生成可部署快照。数学正文只解析一次为 Pandoc AST，再分别用于网页和 PDF。

```text
course.yaml
math/macros.tex
chapters/limits.md
documents/limits-review.md
problems/limit-squeeze/index.md
problems/limit-squeeze/solutions/direct.md
problems/limit-squeeze/comments/pitfall.md
sets/tutorial-01.md
assets/limit-diagram.svg
assets/limit-diagram.pdf
```

## 课程与 ID

```yaml
schemaVersion: 1
engineVersion: 0.1.0
title: 高等微积分（1）习题课
subtitle: 知识回顾与问题讨论
author: 夏子睿
language: zh-CN
basePath: /xiazr20/advanced-calculus-i/
siteUrl: https://www.xiazr20.top
chapters: [limits, continuity]
```

`basePath` 须以 `/` 开头及结束；根部署用 `/`。`engineVersion` 在当前版本必须为 `0.1.0`，升级须明确修改配置。未知字段会报错，以便发现拼写错误。除可空的题目标题外，实体标题不可为空。

ID 全库唯一，以小写英文字母开头，仅包含小写字母、数字和连字符。文件标题和顺序可以改变，显式 ID 不随之改变。章节、文档、题目、习题集、解答、评语、显式标题锚点、公式和图片共用一个命名空间。推荐有含义的英文短 ID，例如 `supremum-union`、`eq-squeeze-bound`。

一个题目只有一个主归属章节，用于题库编号、全文去重和章节打印。同一题可以被任意多个习题集引用。同一文档也只有一个所属章节。习题集可挂靠多个章节；其正文中的公式采用首次挂靠章节的编号。

## 文档与章节

`documents/limits-review.md`：

```markdown
---
id: limits-review
title: 数列极限回顾
tags: [数列极限, 定义]
---

## 极限的定义 {#sequence-limit-definition}

设数列 $a_n$ 满足……
```

`chapters/limits.md`：

```markdown
---
id: limits
title: 数列与函数极限
documents: [limits-review]
problems: [limit-squeeze]
sets: [tutorial-01]
---

本章从定义出发，讨论极限与基本性质。
```

`documents`、`problems`、`sets` 各自决定显示顺序，缺省为空数组。文档显示在前，之后是“所有习题”和各习题集。章节必须列入 `course.yaml`。题目编号由章节顺序及 `problems` 顺序确定，筛选和随机抽题不会改变编号。未显式命名的标题会获得文件范围内的自动 ID；需要长期引用的标题应手写 `{#id}`。

## 题目、多解和评语

`problems/limit-squeeze/index.md` 的目录名必须和题目 ID 相同：

```markdown
---
id: limit-squeeze
title: ""
tags: [夹逼准则, 数列极限]
sources: [教材习题 1.2]
difficulty: 2
solutions:
  - solutions/direct.md
comments:
  - comments/pitfall.md
---

证明 $\lim_{n\to\infty}\frac{\sin n}{n}=0$。
```

`difficulty` 为整数 `1` 到 `5`，页面显示星级；尚未确定时为 `null` 或省略。`solutions` 与 `comments` 可为空或省略。解答/评语路径相对于该题目录，必须指向同一题目录内的 `.md` 文件，不能复用同一个文件。图片统一放在课程根目录的 `assets/`。

解答和评语都写正常 Markdown，可选元数据：

```markdown
---
id: limit-squeeze-direct
title: 用夹逼准则
kind: proof
---

由 $-1/n\leq \sin n/n\leq 1/n$，结论成立。
```

`id` 省略时由题目 ID、类型和序号生成，例如 `limit-squeeze-solution-1`。需要长期引用某个解法时，请填写显式 ID。`title` 省略时显示“解答 1”或“评语 1”。`kind` 作为说明性分类保存，例如 `proof`、`remark`、`pitfall`、`extension`，不允许借此注入样式或脚本。

## 习题集与分组

```markdown
---
id: tutorial-01
title: 第一次习题课
problems: [limit-squeeze, supremum-union]
---

先复习极限定义，再讨论确界。
```

需要小节时，可以只写分组：

```yaml
groups:
  - title: 课堂讨论
    problems: [limit-squeeze]
  - title: 课后练习
    problems: [supremum-union]
```

若同时填写 `groups` 和 `problems`，分组展开后的顺序必须与 `problems` 完全一致。一份习题集中不能重复列同一道题；不同习题集之间允许重复。跨章习题集可正常阅读，按章分别提交打印任务。

## 数学宏和引用

数学公式使用 `$...$` 或独占一段的 `$$...$$`。也支持 `\(...\)` 与 `\[...\]`。公共宏写在 `math/macros.tex`：

```tex
\newcommand{\RR}{\mathbb{R}}
\newcommand{\dd}{\mathop{}\!\mathrm{d}}
\newcommand{\abs}[1]{\left|#1\right|}
\renewcommand{\hat}[1]{\widehat{#1}}
```

支持 0～9 个固定参数及嵌套花括号，不支持可选参数默认值、递归宏、文件操作、排版命令和正文中的宏定义。宏必须在固定 MathJax 数学命令集合中可展开；未知命令会报告所在文件。宏统一加载，题目顺序及筛选不会改变数学含义。PDF 使用相同宏配置重新生成经过验证的声明。

用 Markdown 链接跨文件引用：

```markdown
参见 [自动文字](ref:limit-squeeze)。
也可使用 [极限定义](ref:sequence-limit-definition)。
```

链接文字为空、`自动文字` 或 `auto` 时，构建器填入“题 1.2”“式 (1.3)”等标签；其他文字原样保留。`#id` 链接也按全库锚点解析。不存在或重复的目标会使构建失败。未选入章节 PDF 的引用保留其全库位置和网页链接。

需要编号的独立公式：

```markdown
$$
|a_n-a|<\varepsilon \label{eq-sequence-limit}
$$

由 [自动文字](ref:eq-sequence-limit) 可知……
```

一个独立公式只允许一个 `\label`，且该公式须单独成段。公式引用写在正文中，不在数学公式内使用 `\ref` 或 `\eqref`。式号按章节内容顺序生成，网页和 PDF 使用同一个编号。多行公式可在一个 `aligned` 环境中共用一个编号。

## 语义块和图片

使用 Pandoc fenced div 表达简单定理、证明或注记：

```markdown
::: {.theorem #squeeze-theorem title="夹逼准则"}
若 $a_n\le b_n\le c_n$，且两端同趋于 $L$，则 $b_n\to L$。
:::
```

允许的块类型是 `theorem`、`definition`、`lemma`、`proposition`、`corollary`、`proof`、`remark`、`note`、`warning`、`example`、`exercise`。支持一般列表、表格、脚注和代码块，不接受任意 HTML 或数学公式之外的原始 TeX。普通链接限 `http(s)`、`mailto` 和内部引用。

图片路径相对于当前 Markdown 文件：

```markdown
![极限示意图](../assets/limit-diagram.svg){#fig-limit}
```

支持 PNG、JPEG、WebP、GIF、静态 SVG。SVG 不得含脚本、外部资源、动画或嵌入 HTML。SVG、WebP 和 GIF 必须同时提供同名 `.pdf` 或 `.png` 作为打印替代（优先 PDF），例如 `limit-diagram.svg` 对应 `limit-diagram.pdf`；没有替代文件时内容校验即报错。TikZ 等复杂图形先生成 SVG/PDF 两份，在线打印不额外转换图形。`assets/` 内允许以上图片及 PDF，全部资源随内容版本发布。不能使用远程图片、绝对路径、符号链接或越出内容目录的资源。

## 本地工作流和校验

以项目提供的浏览器预览为准。普通 Markdown 预览器通常不能识别公共宏、自动引用和全库编号，但仍能直接阅读正文。

校验会检查元数据、所有引用、章节归属、题目路径、静态资源、未知数学命令，以及正文中禁止的原始标记。一个失败会给出具体源文件，发布保留上一份有效版本。修复后重新执行即可。

内容版本 `revision` 对实际配置、正文、宏和全部资源的字节及相对路径计算 SHA-256，不依赖 Git commit，也不受构建时间影响。构建结束前再次比对输入字节，避免编辑到一半的内容被打包成同一个版本。文件新增或删除应在下一次完整构建后发布。
