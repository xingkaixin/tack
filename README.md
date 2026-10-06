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

当前机器的 `.env` 已配置局域网开发库，不进入 Git。新环境需要复制 `.env.example` 并填写数据库密码。`APP_ORIGIN` 是允许写操作和 WebSocket 使用的前端 Origin 列表，逗号分隔；前端通过同源 `/api` 代理访问后端。

## 首版功能

- 多工作区、项目、自动任务编号。
- 列表和可拖动的看板；按标题、编号和标签搜索，按状态、优先级和负责人筛选。
- 任务状态、优先级、负责人、截止日期、标签、子任务和阻塞依赖。父子关系与依赖关系均检查循环。
- Tiptap 富文本描述，Yjs/Yrs 多人编辑、在线光标和断线合并。
- 评论、活动记录、附件上传与下载。单个附件最大 10 MB，附件存储在 PostgreSQL 中。
- 邮箱密码登录、HttpOnly 会话、管理员和成员角色。管理员创建账号或把已有账号加入工作区。
- 中英文界面、浅色和深色主题。
- 已同步数据的离线访问；离线创建任务、修改字段、编辑描述、发表评论及选择附件。

工作区成员可以管理工作区内的项目和任务。管理员额外负责添加成员。任务依赖和父子任务限定在同一项目内。

## 离线与冲突

结构化修改先写入 IndexedDB，按顺序发送。每次操作都有固定 UUID，服务端保存结果，网络重试不会重复创建任务或评论。多个标签页通过 Web Locks 和 BroadcastChannel 协调本地队列。

字段更新携带编辑前的值。服务器上同一字段已改变时，修改留在队列中，侧栏显示同步问题。用户可以选择服务器版本或保留自己的修改；不会静默覆盖另一人的修改。发生冲突或校验错误时，后续操作等待处理，以保留离线创建任务与后续评论等操作之间的顺序。

描述使用 Yjs CRDT 合并，更新持久化到 PostgreSQL 后才显示已同步。描述在本地单独持久化，关闭详情后仍会补传。浏览器重新启动时会恢复未同步的描述。已同步描述会随数据快照缓存，附件仅在下载后缓存。

首次登录、创建成员需要联网。离线任务在服务器接受后获得正式编号。未下载过的附件需要联网才能访问。浏览器存储属于当前浏览器和站点；清除站点数据会清除尚未同步的本地修改。

## 数据库

开发 PostgreSQL 运行在 `dev-host`：

- Compose 目录：`/srv/tack/`
- 连接地址：`127.0.0.1:55433`
- 数据库和用户：`tack`
- 数据目录：`/srv/tack/postgres/`
- 密码：服务器目录内的 `.env` 和本机 `.env`，均未提交。

仓库中的 `infra/compose.yaml` 是部署源文件，只运行 PostgreSQL。前后端不部署到服务器。

```sh
ssh dev-host 'cd /srv/tack && docker compose ps'
ssh dev-host 'cd /srv/tack && docker compose logs --tail=50 postgres'
```

## 验证

```sh
mise exec -- pnpm check
mise exec -- pnpm check:format
mise exec -- pnpm exec playwright install chromium
mise exec -- pnpm test
```

`pnpm test` 构建应用，启动专用的测试 API（3002）和预览服务（4174），运行真实 PostgreSQL、WebSocket 和 Chromium 验收测试，然后关闭测试服务。不要同时运行 `pnpm test:serve`。

测试使用同一 PostgreSQL 实例中的独立 `tack_test` 数据库，不使用开发库。当前服务器已创建该数据库；在新环境中先创建：

```sh
ssh dev-host 'cd /srv/tack && docker compose exec -T postgres createdb -U tack tack_test'
```

也可以通过 `TEST_DATABASE_URL` 指定独立测试库，库名必须以 `_test` 结尾。测试账号和任务仅存在于测试库。

验收覆盖登录与权限、工作区隔离、操作去重、字段冲突、依赖循环、并发写入、Yjs/Yrs 持久化、附件、离线刷新、多标签页队列、关闭详情后的恢复、双客户端实时编辑、在线光标及中英文和主题切换。截图写入被 Git 忽略的 `test-results/`。

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
