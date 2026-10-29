# 部署与维护

首次部署见 [镜像发布与部署](dockerhub-release.md)；从源码启动见 [README](../README.md#快速开始)。以下命令在 Compose 所在目录执行。

## 服务与数据

| 服务 | 用途 |
| --- | --- |
| `web` | 网页、打印 API 和下载 |
| `worker` | 领取打印任务并编译 PDF |
| `builder` | 临时构建课程网页、全文 PDF 并发布 |

`releases` 卷保存发布快照和全文 PDF；`state` 卷保存 SQLite 队列、打印缓存及日志。默认卷名前缀为 `lecture-notes-engine`，更改 Compose 项目名会使用另一组卷。

`state` 须放在单台主机的本地磁盘。普通重启、升级不要使用 `docker compose down -v`，它会删除数据卷。

## 更新内容

修改内容或项目清单后执行：

```sh
docker compose run --rm builder
```

只更新一门课程，将 `COURSE_ID` 换成清单中的项目 ID：

```sh
docker compose run --rm builder npm run build -- --projects /projects.yaml --project COURSE_ID --out /releases --book --local-worker
```

构建成功才切换发布版本，不需重启 web。删除项目时修改清单后执行一次全量构建。已排队任务继续使用原快照。

### 延迟发布与回滚

```sh
# 构建但不发布
docker compose run --rm builder npm run build -- --projects /projects.yaml --project COURSE_ID --out /releases --book --local-worker --no-publish

# 发布构建输出的版本，或回滚到仍保留的旧版本
docker compose run --rm builder npx tsx src/cli.ts publish REVISION --projects /projects.yaml --project COURSE_ID --out /releases
```

将 `REVISION` 替换为版本哈希。不要直接修改生成的快照或 `projects.json`。

## 代理

默认只监听 `127.0.0.1:3000`。独立域名可代理整个站点：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

与其他网站共用域名时，代理各课程的 `basePath` 及公共 `/_engine/` 路径，并保留路径前缀。项目的 `siteUrl` 应与公开地址一致。

`TRUST_PROXY` 默认 `false`。需要使用真实访客 IP 限流时，设为实际代理的 IP/CIDR；Docker 环境中可能是网桥地址。

## 打印队列

所有项目、worker 和 builder 共用队列，默认同时编译一个任务。常用配置在 `.env` 中设置：

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `PRINT_CONCURRENCY` | `1` | 全局编译并发 |
| `PRINT_TIMEOUT_MS` | `180000` | 章节编译超时，毫秒 |
| `BOOK_TIMEOUT_MS` | `900000` | 全文编译超时，毫秒 |
| `PRINT_MAX_QUEUED` | `30` | 排队上限 |
| `PRINT_MAX_ACTIVE_PER_SOURCE` | `3` | 每来源未完成任务上限 |
| `PRINT_MAX_PROBLEMS` | `500` | 单次选题上限 |
| `PRINT_CACHE_TTL_HOURS` | `168` | 打印缓存保留小时数 |
| `PRINT_CACHE_MAX_MB` | `1024` | 打印缓存容量 |
| `PRINT_LOG_TTL_HOURS` | `168` | 失败日志保留小时数 |

其他参数及容器资源预算见 [Compose 配置](../deploy/compose.yaml)。worker 定期清理打印缓存和日志，不清理发布快照及其全文 PDF。

调整并发时，等待任务结束并确认没有 builder 在运行，再执行：

```sh
docker compose stop web worker
docker compose run --rm builder npx tsx src/cli.ts concurrency 2
```

将 `.env` 的 `PRINT_CONCURRENCY` 同步改为 `2`，再执行 `docker compose up -d --wait web worker`。数据库与所有进程的并发配置须一致。

## 升级与备份

升级前等待任务完成、停止 web/worker 并备份两个卷；备份期间不能有 builder 写入。SQLite 须一致性备份，不能在写入中只复制主数据库而漏掉 WAL。

预构建镜像的升级命令见 [镜像升级](dockerhub-release.md#升级镜像)。从源码部署时，切换到指定 Git 版本后执行：

```sh
docker compose build web worker
docker compose run --rm builder
docker compose up -d --wait web worker
```

web 与 compiler 使用同一版本；模板变更后需重建内容以生成新 PDF。清理历史快照前，确认当前发布和未完成任务均未引用它。

## 故障定位

```sh
docker compose ps
docker compose logs --tail 200 web worker
curl --fail http://127.0.0.1:3000/healthz
```

- 内容构建失败：按终端提示检查对应文件、引用、宏或图片。
- PDF 编译失败：查看 `state` 卷的 `logs/` 目录。
- 数据卷权限错误：核对所有者 UID/GID 是否为 `1000`。
- 发布锁残留：确认没有 builder 正在发布后，再删除 `releases` 卷中的 `.projects.lock`。

## 内容仓库 CI

引擎 CI 仅做类型检查、核心测试和示例网页构建。

自动发布课程可参考 [内容工作流示例](../scripts/content-workflow.example.yaml)：自托管 runner 需配置固定版本的引擎、同一个 Compose 项目，以及 `ENGINE_DIRECTORY`、`LECTURE_PROJECT_ID` 仓库变量。builder 的只读内容挂载应指向该内容仓库的稳定 checkout。
