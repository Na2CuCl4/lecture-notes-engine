# Docker 运行与发布

引擎仓库是 `lecture-notes-engine`。课程内容保存在另一个 Git 仓库中，通过只读挂载交给构建器。运行中的网页和打印任务读取构建后的版本快照，不直接读取正在编辑的 Markdown。

此文档提供部署方法；初始化工程不会自动修改现有站点、推送 Git 提交或发布课程。

## 组件与磁盘

| 组件 | 作用 | 读写位置 |
| --- | --- | --- |
| `web` | 静态阅读页面、打印 API、下载 | 只读 `/releases`，读写 `/state` |
| `worker` | 从 SQLite 队列领取任务、用 XeLaTeX 编译 | 只读 `/releases`，读写 `/state` |
| `builder` | 临时运行的内容校验、Astro 构建、全文 PDF 发布 | 只读 `/content`，读写 `/releases` 和 `/state` |

Compose 创建两个命名卷：`lecture-notes-engine_releases` 和 `lecture-notes-engine_state`。镜像预先设置 UID/GID 1000 的目录权限，第一次挂载时 Docker 会复制这些权限。容器以 `node` 用户运行，不需要对内容仓库执行 `chmod` 或 `chown`。

`state` 卷保存 SQLite 队列、PDF 和编译工作目录，必须位于单台 Docker 主机的本地文件系统。不要用 NFS、SMB 或多台主机共享这一 SQLite 卷。不要挂载 Docker socket。

要记录一次真实构建的用时和容器峰值内存，可用以下命令替代普通 builder 命令；输出的峰值来自 Linux cgroup v2，包含文件缓存。缓存命中的再次构建不能代表首次全文编译性能。

```sh
docker compose run --rm builder node scripts/benchmark-build.mjs
```

## 本地首次启动

需要 Docker Engine/Compose v2；Windows 可使用启用 Linux 容器的 Docker Desktop。不需要在宿主机安装 Node、Pandoc 或 TeX。

在仓库根目录执行：

```sh
docker compose --profile tools config --quiet
docker compose build web worker
docker compose run --rm builder
docker compose up -d --wait web worker
docker compose ps
```

默认使用 `examples/calculus`。访问 `http://127.0.0.1:3000/`；课程配置若设置了路径前缀，则使用其 `basePath` 下的入口。`http://127.0.0.1:3000/healthz` 始终独立于课程路径。

`builder` 的默认命令等价于：

```sh
npm run build -- --content /content --out /releases --book --local-worker
```

它通过持久队列生成全文 PDF，成功后切换 `current.json`。首次启动时没有常驻 worker，`--local-worker` 会临时消费同一个队列；已有常驻 worker 时也遵守同一个全局并发限制。

TeX 镜像首次构建需要下载 Debian 软件包，耗时和镜像体积明显高于纯网页镜像；后续内容更新不会重新安装这些依赖。镜像预装 Pandoc、XeLaTeX、ctex 和 Fandol 字体，运行时不下载字体和 TeX 包。

打印模板沿用旧 `calculus-i/main.tex` 的基础排版：`book` 默认的 10pt、Letter 纸张、双面与奇数页开章，左右边距 2cm、上下边距 3cm，首行缩进 2em、段间距 0.5em；封面、目录和页眉页码沿用书籍类的布局。旧文件没有指定 A4，因此这里也不改为 A4。中文正文依次选择 Noto Serif SC、Noto Serif CJK SC、FandolSong；斜体使用 KaiTi，缺少时回退 FandolKai。题目保留课程稳定题号，解答和评语使用段首标题；文档章节使用正常的书籍章节编号，不把每道题和每种解答塞入目录。模板变更属于引擎更新，需要重建镜像并重新构建内容版本，已有 PDF 缓存不会被原地覆盖。

构建器的根文件系统保持只读。Astro/Vite 的构建缓存由 Compose 放在 `/releases/.astro-cache`，镜像中的 `/app/.astro` 符号链接指向同一目录，与临时发布目录位于同一文件系统，避免原子 `rename` 跨挂载失败。构建结束后这些缓存仍属于引擎内部临时数据，不会进入版本目录。其余 `.astro` 临时目录和 `/tmp` 使用容器内存盘，若构建所需内容异常大，应先降低并发或调整内存盘上限。

默认使用 Debian 官方软件源；若本地连接较慢，可在 `.env` 中设置 `APT_MIRROR=mirrors.tuna.tsinghua.edu.cn` 再构建。该选项只改变软件包镜像地址，保留 Debian 签名验证，不影响运行时服务。

查看日志或停止：

```sh
docker compose logs --tail 100 web worker
docker compose down
```

`down` 保留课程版本和任务；`down -v` 会删除两个数据卷，不用于普通重启或升级。

## 使用独立内容仓库

复制 `.env.example` 为 `.env`。Windows PowerShell：

```powershell
Copy-Item .env.example .env
```

Linux/macOS：

```sh
cp .env.example .env
```

然后修改 `CONTENT_PATH`，例如 Windows：

```dotenv
CONTENT_PATH=E:/Projects/Website/advanced-calculus-i
WEB_BIND=127.0.0.1
WEB_PORT=3000
```

Linux 示例：

```dotenv
CONTENT_PATH=/srv/lecture-content/advanced-calculus-i
```

只有按新格式迁移、通过内容校验的目录才能这样挂载；现有 LaTeX 仓库不能直接当成新内容库。挂载路径不存在会失败，不会悄悄创建空文件夹。

内容更新后运行：

```sh
docker compose run --rm builder
```

构建成功前继续提供旧版本。每份网页、索引和 PDF 使用同一内容版本；已入队任务继续使用其原版本。无需重新构建镜像或重启 web。

需要先构建再人工选择发布时间时：

```sh
docker compose run --rm builder npm run build -- --content /content --out /releases --book --local-worker --no-publish
docker compose run --rm builder npx tsx src/cli.ts publish REVISION
```

将 `REVISION` 替换为构建输出的真实版本号。回滚使用相同的 `publish` 命令选择仍在卷中的旧版本。不要手动编辑已生成的版本目录。

## 资源与队列

默认 worker 为 1 vCPU、2 GB 内存，web 为 0.75 vCPU、768 MB 内存。builder 同样限制 1 vCPU、2 GB 内存；同机内容构建期间可能同时消耗 builder 与 web 的资源。Compose 的限制是初始预算，需要根据实际课程大小调整。

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| `PRINT_CONCURRENCY` | `1` | 共享 SQLite 中同时编译的任务总数 |
| `PRINT_TIMEOUT_MS` | `180000` | 单章任务编译超时 |
| `BOOK_TIMEOUT_MS` | `900000` | CI 全文任务编译超时 |
| `PRINT_MAX_QUEUED` | `30` | 排队任务数量上限 |
| `PRINT_MAX_ACTIVE_PER_SOURCE` | `3` | 每来源尚未完成的任务数量上限 |
| `PRINT_MAX_PROBLEMS` | `500` | 单次请求题目数量上限 |
| `PRINT_LEASE_MS` | `60000` | 工作进程任务租约时间 |
| `PRINT_MAX_ATTEMPTS` | `2` | 崩溃恢复后任务的最大尝试次数 |
| `PRINT_CACHE_TTL_HOURS` | `168` | 任务 PDF 缓存保留时间 |
| `PRINT_CACHE_MAX_MB` | `1024` | 任务 PDF 缓存容量上限 |
| `PRINT_LOG_TTL_HOURS` | `168` | 编译失败日志保留时间 |

并发限制写入队列数据库，各进程必须保持一致。需要调整时，先等现有任务完成，确保没有临时 builder 在运行，再停 web 和 worker。例如改为 2：

```sh
docker compose stop web worker
docker compose run --rm builder npx tsx src/cli.ts concurrency 2
```

随后将 `.env` 中的 `PRINT_CONCURRENCY` 同步改为 `2`，执行 `docker compose up -d --wait web worker`。存在运行中的任务时修改会被拒绝。不要只改一台容器的环境变量或复制数据库。多加 worker 容器不会自动突破全局并发上限；在 2 vCPU 的服务器上建议保留默认值 1。

全文任务与公开章节任务走同一个队列。不要在已有打印服务旁另行运行不受队列管理的 `xelatex` 或 CI 编译容器。章节请求只提交已发布的章节、题目 ID 和受限排版选项；编译关闭 shell escape，容器普通用户、只读根文件系统、无额外 Linux capabilities。

相同版本、同样题目顺序及选项可以命中缓存。任务恢复依靠持久队列及租约，停止 worker 后尚未完成的任务不会消失。worker 启动时及此后每 10 分钟清理过期 PDF、超出预算的缓存和过期日志；缓存过期后可重新提交任务生成。成功编译删除临时工作目录，失败日志在 `/state/logs/` 保留。发布目录内的全文 PDF 和历史版本不随任务缓存清除；定期监控磁盘容量，清理版本前必须确认它没有被当前发布或未完成任务引用。

## 反向代理与原站点路径

课程配置填写 `/xiazr20/advanced-calculus-i/` 等 `basePath`。代理保留该路径，不剥离前缀。Nginx 示例：

```nginx
location ^~ /xiazr20/advanced-calculus-i/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Docker 默认只绑定宿主机 `127.0.0.1`，由现有 HTTPS 入口代理。`TRUST_PROXY` 默认 `false`；需要按真实访客地址限流时，将其设为实际反向代理连接的明确 IP/CIDR，而非无条件信任互联网上传入的 `X-Forwarded-For`。容器看到的代理地址可能是 Docker 网桥地址，须结合访问日志确认。

保留 `calculus-i` 的原有服务。新课程切换到新入口前，单独检查站点导航、旧链接、搜索索引和完整 PDF 地址。课程的 `main.html` 兼容入口由内容构建提供。

## CI 与版本固定

引擎仓库的 `.github/workflows/ci.yaml` 执行类型检查、测试、Docker 构建和样例端到端启动，不推送镜像、不部署站点。

`scripts/content-workflow.example.yaml` 是供以后复制到**内容仓库**的发布示例，默认不会执行。示例要求已准备好的自托管 runner、固定版本的引擎 checkout 和同一个 Compose 项目；运行时只更新课程内容。`ENGINE_DIRECTORY` 由 GitHub 仓库变量提供，指向服务器已有的引擎目录。

生产环境应把引擎固定到审核过的 Git commit/tag，并记录镜像 digest。`ENGINE_VERSION` 仅决定本地镜像 tag，不会替你切换源码或拉取对应代码。更新引擎时先切到所需代码版本，再构建、跑验证，最后重建服务：

```sh
docker compose build web worker
docker compose run --rm builder
docker compose up -d --wait web worker
```

共享数据库同一时间只运行一种受支持的引擎版本。引擎升级及数据格式变化前保留数据卷备份。Node 主版本、TeX 发行版、字体配置和 lockfile 都影响生成结果，应一同版本管理。

## 备份与故障定位

内容仓库用 Git 备份；运行状态需备份 `releases` 和 `state` 两个命名卷。备份 SQLite 时先停止所有写入者（web、worker 及临时 builder），或使用 SQLite 的一致性备份 API；不能在写入中只拷贝主 `.sqlite` 文件而漏掉 WAL。

常见检查：

```sh
docker compose ps
docker compose logs --tail 200 web worker
docker compose run --rm builder node --version
docker compose run --rm builder pandoc --version
docker compose run --rm builder xelatex --version
```

缺引用、宏或资源的内容构建会报具体文件位置。编译失败时查 `/state/logs/` 中对应任务的日志；不要把编译失败视为发布成功。卷迁移后若遇到权限错误，先核对卷所有者是否仍为 UID/GID 1000，再在维护窗口修复该数据卷，避免更改课程原仓库权限。
