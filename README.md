# Lecture Notes Engine

用 Git 管理 Markdown 数学讲义，生成可筛选、抽题的课程网站，并通过受限队列生成章节 PDF。

课程内容与引擎分开维护。这个仓库保存程序、Docker 配置、打印模板和少量示例；正式内容仓库只需 Markdown、图片、课程配置及固定的引擎版本。

## 快速开始

### Docker（推荐部署方式）

```sh
docker compose build
docker compose run --rm builder
docker compose up -d web worker
```

打开 <http://localhost:3000/>。首次 builder 命令生成示例网页和全文 PDF，成功后发布；web 和 worker 读取相同的只读内容快照。依赖都随镜像安装，任务执行时不下载 TeX 包或字体。

正式课程的挂载、子路径代理、资源限制、CI 和回滚步骤见 [部署说明](docs/deployment.md)。

### 本地写作与开发

需要 Node.js 24、Pandoc、XeLaTeX（含 ctex、Fandol 及模板所需宏包）。

```sh
npm ci
npm run content:check
npm run dev
```

默认读取 `examples/calculus/`，预览地址 <http://127.0.0.1:3000/>。更换内容目录：

```sh
npm run dev -- --content /path/to/course --port 3000
```

`dev` 启动网页、编译 worker 和文件监听。保存内容后重新构建；失败时保留上一版，终端显示文件及原因。构建完成后刷新页面查看新版本。浏览器预览使用与发布相同的公式、宏、引用和页面，不依赖编辑器专有插件。

## 内容模型

- **文档**：标题、标签、正文，可以包含定理、定义、证明和知识点回顾。
- **题目**：稳定 ID、可空标题、标签、来源、1–5 星或未标定难度、题干、分文件多解和评语。
- **习题集**：标题、说明和有序题目 ID，可跨章引用、被多个章节挂靠。
- **章节**：有序文档、主归属题目和挂靠习题集。每题只属于一个主章节。

完整字段及支持的 Markdown 扩展见 [内容格式](docs/content-format.md)。[样例来源记录](docs/sample-provenance.md) 说明旧课程选材与迁移边界；这些是引擎验收样例，不是正式章节迁移或数学审校。

课程首页的“继续阅读”使用当前浏览器的本地存储，记录最近阅读页面及位置；内容更新后，仍存在的页面可以继续阅读。浏览器禁止或清除本地存储时，按钮恢复为“开始阅读”。

```text
course.yaml
math/macros.tex
chapters/limits.md
documents/continuity.md
problems/example/index.md
problems/example/solutions/direct.md
problems/example/solutions/alternative.md
problems/example/comments/common-mistake.md
sets/tutorial.md
assets/figure.png
```

同题在不同习题集出现时只引用 ID；不复制题干。显示编号由课程章节及题目顺序生成，筛选不改变编号。链接使用稳定 ID。

章节导览和习题集每页显示 10 题，仅加载当前页的完整题卡与公式。筛选和随机抽题作用于整个题单，打印也包含当前筛选或抽题结果中的全部题目；页码随分享链接和阅读进度保存。

## 发布与打印

```sh
# 只校验，不修改内容
npm run content:check -- --content /path/to/course

# 构建网页，使用本地 worker 经共享队列生成全文，再切换发布版本
npm run build -- --content /path/to/course --book --local-worker

# 有常驻 worker 的 CI 不需要 --local-worker
npm run build -- --content /path/to/course --book

# 构建但不切换，验收后再发布
npm run build -- --content /path/to/course --no-publish
npm run pdf -- --book --revision REVISION
npm exec tsx src/cli.ts publish REVISION
```

网页与 PDF 基于同一套 Pandoc 内容树。公共数学宏统一维护；不支持的命令、重复 ID、失效引用、缺失资源等会阻止发布。章节打印支持仅题目、题后解答、文末解答，以及独立的评语开关。跨章题单分别生成各章 PDF。

全文 PDF 按章节输出文档及“所有习题”，每题只出现一次，不输出各习题集的说明或索引。题目使用简单的编号环境，省略难度、标签和来源；解答标题采用“解（方法名）”。定理、定义、命题、引理、推论、注等语义块在网页和 PDF 中显示一致的类型、编号及可选标题。章外引用保留目标名称和网站链接。

任务通过 SQLite 持久化。默认全局只执行一个编译任务，包括 CI 全文构建；重复请求复用任务或 PDF。每个任务固定内容版本、题目顺序及排版选项，发布新内容不会改变已排队任务。公开接口不能提交全文任务、任意 Markdown、TeX 或文件路径。

## 验证

```sh
npm run typecheck
npm test
npm run build -- --book --local-worker
docker compose config --quiet
```

测试覆盖内容及引用校验、定理编号、分页与阅读进度、快照资源、打印模式、全书去重、请求校验、持久队列、并发领取和过期任务恢复。可在 Linux 编译容器中显式运行 `node scripts/verify-worker.mjs`，检查两个 worker 的真实 XeLaTeX 并发。

## 第一版边界

第一版面向公开课程阅读与 Git 文件写作，不含账号、在线编辑后台或自动数学审校。基础 Markdown 编辑器可读正文；自定义数学宏和自动编号引用以项目预览为准。复杂 TeX 排版需转换成支持的语义块；TikZ/pgfplots 应提前导出 SVG 和同名 PDF/PNG，在线打印不执行绘图程序。

旧课程仓库不受此项目修改。正式章节仅在明确指定迁移范围后迁移。引擎升级时先停止领取新任务并等待正在运行的任务完成，再切换匹配的 web/worker 镜像。
