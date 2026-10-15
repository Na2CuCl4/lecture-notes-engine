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

打开 <http://localhost:3000/> 查看项目主界面，进入 `/advanced-calculus-i/` 或 `/calculus-demo/`。两个默认项目复用同一份验收样例，用来演示项目切换，并不代表已迁移两门正式课程。首次 builder 命令生成全部项目的网页和全文 PDF，全部成功后统一发布；web 和 worker 读取相同的只读内容快照。

服务器直接拉取已发布镜像，无需复制引擎源码，见 [Docker Hub 发布与部署](docs/dockerhub-release.md) 和 `deploy/` 中的独立 Compose。正式课程的挂载、子路径代理、资源限制、CI 和回滚步骤见 [部署说明](docs/deployment.md)。

### 本地写作与开发

需要 Node.js 24、Pandoc、XeLaTeX（含 ctex、Fandol 及模板所需宏包）。

```sh
npm ci
npm run content:check
npm run dev
```

默认读取引擎根目录的 `projects.yaml`，预览地址 <http://127.0.0.1:3000/>。每个项目拥有独立 URL、阅读进度、引用和全文 PDF，共用一个打印队列及编译并发限制。

```yaml
schemaVersion: 1
title: 课程讲义
projects:
  - id: advanced-calculus-i
    content: ../advanced-calculus-content
  - id: calculus-i
    content: ../calculus-content
    title: 微积分 A(1)
    basePath: /calculus-i/
    siteUrl: https://example.com/calculus-i/
```

`content` 相对项目清单文件解析，也可填写绝对路径；必须是已迁移的 Markdown 内容目录。`basePath` 默认 `/<id>/`，不能占用 `/`、API 等保留路径，也不能与另一项目路径重叠。`title`、`siteUrl` 可覆盖课程配置，源文件不会被改写。项目 ID 应保持稳定。

```sh
npm run dev -- --projects projects.yaml
npm run check -- --projects projects.yaml --project advanced-calculus-i
```

`--project` 只构建或校验选中的项目，保留其他项目的已发布版本。项目清单变更后重启开发服务；内容修改会自动重建受影响的项目。仍支持显式单项目模式，建议使用独立输出目录：

```sh
npm run dev -- --content /path/to/course --out dist/single-releases --port 3000
```

`dev` 启动网页、一个共享编译 worker 和文件监听。保存内容后重新构建；失败时保留上一版，终端显示文件及原因。构建完成后刷新页面查看新版本。`--content` 与 `--projects`/`--project` 不能混用，已有多项目目录也不会被单项目发布覆盖。

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
# 只校验所有项目，不修改内容
npm run check -- --projects projects.yaml

# 构建网页，使用本地 worker 经共享队列生成全文，再切换发布版本
npm run build -- --projects projects.yaml --book --local-worker

# 有常驻 worker 的 CI 不需要 --local-worker
npm run build -- --projects projects.yaml --project advanced-calculus-i --book

# 构建但不切换，验收后再发布
npm run build -- --projects projects.yaml --project advanced-calculus-i --book --local-worker --no-publish
npm exec -- tsx src/cli.ts publish REVISION --project advanced-calculus-i

# 为已发布项目重新生成全文 PDF
npm run pdf -- --book --project advanced-calculus-i --local-worker
```

网页与 PDF 基于同一套 Pandoc 内容树。公共数学宏统一维护；不支持的命令、重复 ID、失效引用、缺失资源等会阻止发布。章节打印支持仅题目、题后解答、文末解答，以及独立的评语开关。跨章题单分别生成各章 PDF。

全文 PDF 按章节输出文档及“所有习题”，每题只出现一次，不输出各习题集的说明或索引。题目使用简单的编号环境，省略难度、标签和来源；解答标题采用“解（方法名）”。定理、定义、命题、引理、推论、注等语义块在网页和 PDF 中显示一致的类型、编号及可选标题。章外引用保留目标名称和网站链接。

任务通过 SQLite 持久化。默认全局只执行一个编译任务，包括 CI 全文构建；重复请求复用任务或 PDF。每个任务固定内容版本、题目顺序及排版选项，发布新内容不会改变已排队任务。公开接口不能提交全文任务、任意 Markdown、TeX 或文件路径。

提交打印后可继续阅读，右上角“打印状态”提供本浏览器提交的任务状态和 PDF 下载。刷新或切换项目后仍可查看；任务记录保存在当前浏览器，清除浏览器存储会清除这份本地记录。任务完成后的 PDF 仍受服务器缓存保留期限约束。

全量构建只在所有项目成功后原子更新 `releases/projects.json`；单项目发布只替换其对应条目。`--no-publish` 不改变任何当前发布指针。独立项目并发发布采用文件锁，完整目录发布还会检查构建期间是否有其他发布，避免覆盖新版本。网站和任务使用固定快照，不会因项目切换混用内容。

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
