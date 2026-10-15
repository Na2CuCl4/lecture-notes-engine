# Docker Hub 发布与服务器部署

部署只需要两个镜像。`worker` 和临时构建器 `builder` 使用同一个 compiler 镜像，不需要单独上传 Node、TeX 基础镜像或 Dockerfile 的中间阶段。

| Docker Hub 镜像 | 标签 | 用途 |
| --- | --- | --- |
| `na2cucl4/lecture-notes-engine-web` | `v1.0.0`、`latest` | 网页、打印 API、下载 |
| `na2cucl4/lecture-notes-engine-compiler` | `v1.0.0`、`latest` | 内容构建、全文 PDF、打印队列 worker |

同一镜像的两个标签指向同一版本，不会存两份镜像层。生产环境建议固定 `v1.0.0`，升级时明确修改版本；`latest` 用于选择最近发布的版本。这次发布目标为 **Linux amd64**，服务器需要 Docker Engine 和 Compose v2，无需安装 Node、Pandoc、TeX 或引擎源码。其他 CPU 架构须另行构建相应镜像。

## 在本机上传

镜像已准备好时，登录 Docker Hub 后依次上传四个标签：

```sh
docker login
docker push na2cucl4/lecture-notes-engine-web:v1.0.0
docker push na2cucl4/lecture-notes-engine-web:latest
docker push na2cucl4/lecture-notes-engine-compiler:v1.0.0
docker push na2cucl4/lecture-notes-engine-compiler:latest
```

这些命令由你执行。后续需要从当前源码重新构建时，在引擎仓库根目录执行：

```sh
docker build --platform linux/amd64 --target web -t na2cucl4/lecture-notes-engine-web:v1.0.0 -t na2cucl4/lecture-notes-engine-web:latest .
docker build --platform linux/amd64 --target compiler -t na2cucl4/lecture-notes-engine-compiler:v1.0.0 -t na2cucl4/lecture-notes-engine-compiler:latest .
```

正式发布后的版本标签保持不变；下一次引擎更新使用新版本号，并将 `latest` 更新到该版本。

## 准备服务器目录

将仓库 `deploy/` 中的 `compose.yaml`、`.env.example`、`projects.example.yaml` 复制到服务器，例如 `/srv/lecture-notes/`。再放入课程内容：

```text
/srv/lecture-notes/
  compose.yaml
  .env.example
  projects.example.yaml
  .env
  projects.yaml
  content/
    demo/
      course.yaml
      chapters/
      documents/
      problems/
      ...
```

首次试用可把引擎仓库的 **`examples/calculus` 整个目录**复制为服务器的 `content/demo`，直接配合示例清单运行。它只是少量验收样例；现有 `calculus-i`、`advanced-calculus-i` LaTeX 仓库尚未正式迁移，不能直接挂载成 Markdown 内容目录。

在服务器该目录内执行：

```sh
cp .env.example .env
cp projects.example.yaml projects.yaml
docker compose --profile tools config --quiet
docker compose pull web worker
docker compose run --rm --pull never builder
docker compose up -d --no-build --wait web worker
docker compose ps
```

`pull web worker` 已拉取两个镜像，builder 复用 worker 的镜像。先完成 builder，再启动网页；它生成网页和全文 PDF，全部成功后才切换发布版本。生产 Compose 没有 `build:` 配置，不会在服务器构建引擎镜像，也不依赖仓库中的 `examples/` 挂载。私有镜像需要先在服务器执行 `docker login`。

默认访问 `http://127.0.0.1:3000/` 为项目主界面，`/lecture-demo/` 为示例课程。默认端口只对服务器本机开放，可使用现有 Nginx 代理：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

若想通过服务器 IP 直接查看，将 `.env` 中 `WEB_BIND` 改为 `0.0.0.0`，重新执行 `up`，按服务器防火墙设置开放端口 3000。公开上线前将 `projects.yaml` 中的 `siteUrl` 改成实际网址，再构建内容。与现有个人网站共享域名时，项目路径和公共 `/_engine/` 接口的代理方式见 [完整部署说明](deployment.md#反向代理与原站点路径)；保留旧课程现有的归档服务。

## 添加课程和更新内容

将已迁移的 Markdown 内容放在 `content/<课程名>/`，在 `projects.yaml` 添加项目。`content` 字段填写容器内路径，例如 `/content/advanced-calculus-i`；`basePath` 控制页面路径，默认是 `/<项目 ID>/`。整个宿主机 `content/` 已只读挂载，不需要为每门课改 Compose。

内容仓库也可以位于统一目录之外：将 `.env` 的 `CONTENT_ROOT` 设置为包含各课程目录的宿主机绝对路径，清单仍使用 `/content/...`。挂载整个内容目录，不使用指向挂载范围外的符号链接。

更新内容或项目清单后运行：

```sh
docker compose run --rm --pull never builder
```

只更新一门课程：

```sh
docker compose run --rm --pull never builder npm run build -- --projects /projects.yaml --project advanced-calculus-i --out /releases --book --local-worker
```

更新内容不重建镜像、不重启网页。全部项目及 builder 的全文 PDF 共用持久队列，默认最大编译并发为 1。

## 升级与数据保留

`releases` 卷保存发布快照和全文 PDF；`state` 卷保存打印队列、缓存 PDF 和编译状态。默认卷名分别为 `lecture-notes-engine_releases`、`lecture-notes-engine_state`。保持 Compose 项目名不变才能继续使用这两个卷；同一主机需要独立测试部署时使用不同的 `-p` 项目名和端口。

引擎升级前等待当前打印任务完成，确认没有 builder 在运行，停止 web/worker 并一致性备份两个卷，然后将 `.env` 中 `ENGINE_VERSION` 改成新版本，依次执行：

```sh
docker compose stop web worker
docker compose pull web worker
docker compose run --rm --pull never builder
docker compose up -d --no-build --wait web worker
```

web 和 compiler 必须使用同一个版本。选择 `ENGINE_VERSION=latest` 时也需显式 `pull`，不会自动更新。普通重启和升级不要执行 `docker compose down -v`，该选项会删除数据卷。备份、队列参数及故障定位见 [完整部署说明](deployment.md)。
