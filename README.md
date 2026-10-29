# Lecture Notes Engine

用 Markdown 和 Git 维护数学讲义，生成支持筛选、抽题和 PDF 打印的课程网站。引擎与课程内容分开维护，支持多项目部署。

## 快速开始

### Docker

```sh
docker compose build
docker compose run --rm builder
docker compose up -d web worker
```

打开 <http://localhost:3000/>。默认两个项目共用示例内容；builder 生成网页和全文 PDF 后发布。

### 本地开发

需要 Node.js 24、Pandoc 和 XeLaTeX（含 ctex、Fandol 及模板所需宏包）；本地预览会同时生成全文 PDF。

```sh
npm ci
npm run dev
```

默认读取 `projects.yaml`，预览地址为 <http://127.0.0.1:3000/>。保存内容后自动重建，刷新页面查看；构建失败时保留上一版。

## 接入课程

在 `projects.yaml` 中配置内容目录：

```yaml
schemaVersion: 1
title: 课程讲义
projects:
  - id: calculus-i
    content: ../calculus-content
    title: 微积分 A(1)
    siteUrl: https://example.com/calculus-i/
```

`content` 相对清单文件解析；`basePath` 默认 `/<id>/`。修改清单后需重启开发服务。

课程由文档、题目、习题集和章节组成。题目通过稳定 ID 复用，解答与评语分文件维护，显示编号由章节顺序生成。目录结构、元数据和 Markdown 扩展见 [内容格式](docs/content-format.md)。

## 常用命令

```sh
# 校验内容
npm run check

# 构建并发布网页
npm run build

# 同时生成全文 PDF
npm run build -- --book --local-worker

# 重新生成已发布项目的全文 PDF
npm run pdf -- --book --project calculus-i --local-worker
```

使用 `--projects PATH` 指定清单，`--project ID` 选择项目；构建时加 `--no-publish` 可保留当前发布版本。有常驻 worker 时可省略 `--local-worker`。

章节打印支持选择题目、解答位置和评语。网页与 PDF 使用同一份内容快照；打印任务通过共享队列执行，可从网页的“打印状态”下载结果。

## 开发检查

```sh
npm run typecheck
npm test
```

CI 执行类型检查、核心测试和一次示例网页构建。

## 文档

- [内容格式](docs/content-format.md)：目录、字段、数学宏与引用。
- [部署说明](docs/deployment.md)：课程挂载、代理、队列配置与回滚。
- [镜像发布与部署](docs/dockerhub-release.md)：Docker Hub 和独立 Compose 部署。
