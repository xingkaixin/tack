# Tack

面向小团队的轻量项目管理工具。Workspace → Project → Issue；前后端分离，数据库使用 PostgreSQL。

## 启动

```sh
mise install
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm start
```

打开 <http://localhost:4173>。第一次访问会要求创建管理员账号和工作区，没有默认账号或默认密码。

`pnpm start` 构建前端、启动 Rust API 和本地预览服务。浏览器首次在线加载完成后，可以离线刷新和编辑。数据库迁移在 API 启动时自动执行。

开发时使用：

```sh
mise exec -- pnpm dev
```

开发地址为 <http://localhost:5173>，API 为 `127.0.0.1:3001`。Vite 开发模式用于热更新；完整的离线刷新通过 `pnpm start` 或验收测试中的构建产物验证。

首次运行前，复制 `.env.example` 为 `.env`，并按自己的环境配置数据库连接。`.env` 不进入 Git。`APP_ORIGIN` 是允许写操作和 WebSocket 使用的前端 Origin 列表，逗号分隔；前端通过同源 `/api` 代理访问后端。

## 首版功能

- 多工作区、项目、自动任务编号。
- 列表和可拖动的看板；按标题、编号和标签搜索，按状态、优先级和负责人筛选。
- 任务状态、优先级、负责人、截止日期、标签、子任务和阻塞依赖。父子关系与依赖关系均检查循环。
- Tiptap 富文本描述，支持粘贴 PNG、JPEG、GIF 和 WebP 图片并直接显示；Yjs/Yrs 多人编辑、在线光标和断线合并。
- 评论、活动记录、附件上传与下载。单个附件最大 10 MB，附件存储在 PostgreSQL 中。
- 邮箱密码登录、HttpOnly 会话、管理员和成员角色。管理员创建账号或把已有账号加入工作区。
- 中英文界面、浅色和深色主题。
- 已同步数据的离线访问；离线创建任务、修改字段、编辑描述、发表评论及选择附件。

工作区成员可以管理工作区内的项目和任务。管理员额外负责添加成员。任务依赖和父子任务限定在同一项目内。

## 离线与冲突

结构化修改先写入 IndexedDB，按顺序发送。每次操作都有固定 UUID，服务端保存结果，网络重试不会重复创建任务或评论。多个标签页通过 Web Locks 和 BroadcastChannel 协调本地队列。

字段更新携带编辑前的值。服务器上同一字段已改变时，修改留在队列中，侧栏显示同步问题。用户可以选择服务器版本或保留自己的修改；不会静默覆盖另一人的修改。发生冲突或校验错误时，后续操作等待处理，以保留离线创建任务与后续评论等操作之间的顺序。

描述使用 Yjs CRDT 合并，更新持久化到 PostgreSQL 后才显示已同步。描述在本地单独持久化，关闭详情后仍会补传。浏览器重新启动时会恢复未同步的描述。已同步描述会随数据快照缓存，附件在添加或下载后缓存，描述图片在查看后缓存。

首次登录、创建成员需要联网。离线任务在服务器接受后获得正式编号。未下载过的附件需要联网才能访问。浏览器存储属于当前浏览器和站点；清除站点数据会清除尚未同步的本地修改。

## 数据库

仓库提供 `infra/compose.yaml`，可以在本地启动 PostgreSQL，也可以通过 `DATABASE_URL` 连接已有实例。

使用 Compose 时，先设置 `POSTGRES_PASSWORD` 环境变量，并在 `.env` 的 `DATABASE_URL` 中填写相同的密码。默认数据库和用户为 `tack`，监听 `127.0.0.1:55433`，数据持久化到 Compose 文件旁的 `postgres/` 目录。

```sh
docker compose -f infra/compose.yaml up -d --wait
docker compose -f infra/compose.yaml ps
docker compose -f infra/compose.yaml logs --tail=50 postgres
```

通过 `POSTGRES_BIND_IP` 和 `POSTGRES_PORT` 可以调整数据库监听地址和端口。具体主机信息和凭据仅保存在本地配置中，不提交到仓库。

## 验证

```sh
mise exec -- pnpm check
mise exec -- pnpm check:format
mise exec -- pnpm exec playwright install chromium
mise exec -- pnpm test
```

`pnpm test` 构建应用，启动专用的测试 API（3002）和预览服务（4174），运行真实 PostgreSQL、WebSocket 和 Chromium 验收测试，然后关闭测试服务。不要同时运行 `pnpm test:serve`。

测试默认使用同一 PostgreSQL 实例中的独立 `tack_test` 数据库，不使用开发库。使用仓库提供的 Compose 时，先创建测试库：

```sh
docker compose -f infra/compose.yaml exec -T postgres createdb -U tack tack_test
```

也可以通过 `TEST_DATABASE_URL` 指定独立测试库，库名必须以 `_test` 结尾。测试账号和任务仅存在于测试库。

验收覆盖登录与权限、工作区隔离、操作去重、字段冲突、依赖循环、并发写入、Yjs/Yrs 持久化、附件、离线刷新、多标签页队列、关闭详情后的恢复、图片粘贴与离线恢复、双客户端实时编辑、在线光标及中英文和主题切换。截图写入被 Git 忽略的 `test-results/`。

## 代码结构

```text
apps/api/src/       Axum API、认证、任务操作、附件和协作服务
apps/api/migrations/ SQLx 数据库迁移
apps/web/src/       React 界面、TanStack 路由/查询/表格、本地同步
infra/             PostgreSQL Compose
scripts/           本地启动和端到端验收
```

Node、pnpm、Rust 的版本在 `mise.toml` 中固定。前端依赖版本与锁文件一并提交。格式和静态检查使用 oxfmt、Oxlint、TypeScript、rustfmt 和 Clippy。

实现参考 Plane 的任务关系和协作职责划分，代码独立编写。首版采用一个 Rust 服务和一个前端应用，未引入 Redis、消息队列或额外 Node 协作服务。
