# 镜像发布与部署

服务器需要 Docker Engine 和 Compose v2，使用 Linux amd64 镜像。无需安装 Node、Pandoc、TeX 或引擎源码。

## 发布镜像

在引擎仓库构建并上传两个镜像；`worker` 和 `builder` 共用 compiler 镜像：

```sh
docker login
docker build --platform linux/amd64 --target web -t na2cucl4/lecture-notes-engine-web:v1.0.0 -t na2cucl4/lecture-notes-engine-web:latest .
docker build --platform linux/amd64 --target compiler -t na2cucl4/lecture-notes-engine-compiler:v1.0.0 -t na2cucl4/lecture-notes-engine-compiler:latest .
docker push na2cucl4/lecture-notes-engine-web:v1.0.0
docker push na2cucl4/lecture-notes-engine-web:latest
docker push na2cucl4/lecture-notes-engine-compiler:v1.0.0
docker push na2cucl4/lecture-notes-engine-compiler:latest
```

发布新版本时替换版本号，保留旧版本标签；生产环境固定版本，不依赖 `latest`。

## 首次部署

将 [deploy/](../deploy/) 中的 `compose.yaml`、`.env.example`、`projects.example.yaml` 复制到服务器目录，例如 `/srv/lecture-notes/`。课程内容放在 `content/<课程名>/`；试用可将仓库的 `examples/calculus` 整个目录复制为 `content/demo/`。

```sh
cp .env.example .env
cp projects.example.yaml projects.yaml
```

编辑 `projects.yaml`。内容路径使用容器内的 `/content/...`，`siteUrl` 改为公开网址：

```yaml
schemaVersion: 1
title: 课程讲义
projects:
  - id: calculus-i
    content: /content/calculus-i
    siteUrl: https://notes.example.com/calculus-i/
```

`basePath` 默认 `/<项目 ID>/`。内容须符合 [内容格式](content-format.md)，不能直接挂载 LaTeX 仓库。

`.env` 中设置镜像版本 `ENGINE_VERSION`；内容目录不在当前目录时，设置 `CONTENT_ROOT` 为宿主机上包含各课程的目录。随后运行：

```sh
docker compose pull web worker
docker compose run --rm --pull never builder
docker compose up -d --no-build --wait web worker
```

builder 生成网页及全文 PDF，成功后发布。默认访问 <http://127.0.0.1:3000/>，服务器公开访问的代理配置见 [代理](deployment.md#代理)。私有镜像须先在服务器执行 `docker login`。

## 升级镜像

等待打印任务完成，确认无 builder 在运行，停止服务并按 [备份说明](deployment.md#升级与备份) 备份数据卷。修改 `.env` 中的 `ENGINE_VERSION`，执行：

```sh
docker compose pull web worker
docker compose run --rm --pull never builder
docker compose up -d --no-build --wait web worker
```

web 和 compiler 使用相同版本。保持 Compose 项目名不变以复用原数据卷。

日常内容更新、回滚、队列配置和故障定位见 [部署与维护](deployment.md)。
