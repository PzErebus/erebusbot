# ErebusBot - Telegram 私聊消息转发 Bot

基于 Cloudflare Workers + D1 的轻量级 Telegram 私聊 Bot，自动转发用户消息给管理员，支持管理员直接回复。

## 功能特性

### 核心功能
- **消息转发** — 用户发送的消息自动转发给管理员，支持文字/图片/视频/贴纸/语音/音频/文件
- **管理员回复** — 管理员可直接回复，消息自动送达对应用户
- **欢迎消息** — 自定义 `/start` 欢迎语
- **用户封禁** — 一键封禁/解封用户

### 管理面板（Telegram 内联按钮）

| 功能 | 说明 |
|------|------|
| 👥 用户管理 | 用户列表、详情查看、标签备注、封禁管理、分页浏览 |
| 📨 待处理消息 | 查看未回复消息，优先级标记，一键标记已读 |
| 📊 数据统计 | 用户数、消息量、今日活跃、封禁数、未读统计 |
| 💬 回复管理 | 自动回复（关键词匹配）+ 快捷回复（预设模板） |
| 🛡️ 消息过滤 | 关键词规则过滤（支持正则表达式） |
| 📢 群发消息 | 向所有注册用户广播通知 |
| ⚙️ 基础设置 | 自定义欢迎语、重置默认 |
| 🕐 工作时间 | 设置工作时间，非工作时间自定义提示 |
| ⏰ 定时消息 | 定时发送消息给用户 |
| 📝 审计日志 | 操作记录追踪 |
| 💾 数据备份 | 数据概览与备份 |

### 消息过滤

基于关键词的黑名单过滤机制：

```
用户消息
  │
  └─ 关键词匹配检测
       ├─ 精确匹配（全字匹配）
       ├─ 包含匹配（部分匹配）
       └─ 正则匹配（支持正则表达式）
```

| 配置 | 说明 |
|------|------|
| 关键词黑名单 | 支持添加/删除关键词 |
| 匹配类型 | 精确匹配、包含匹配、正则匹配 |
| 启用/禁用 | 每个规则可单独启用/禁用 |

### 性能优化
- 内存缓存层，减少 90%+ 数据库查询
- 并行异步操作，提升响应速度
- D1 数据库 + Cloudflare Edge 部署
- 消息去重机制，防止重复处理

---

## 快速开始

### 前置条件
- [Cloudflare 账号](https://dash.cloudflare.com/sign-up)（免费）
- Telegram Bot Token（找 [@BotFather](https://t.me/BotFather) 创建）

### 1. 克隆并安装

```bash
git clone <repo-url>
cd erebusbot
npm install
```

### 2. 配置

编辑 `wrangler.toml`：

```toml
name = "erebusbot"
main = "src/index.ts"
compatibility_date = "2025-01-01"

[vars]
LANGUAGE = "zh_CN"

[[d1_databases]]
binding = "BOT_D1"
database_name = "cf-pm-bot"
database_id = "你的数据库ID"
```

### 3. 创建 D1 数据库

```bash
npx wrangler d1 create cf-pm-bot
```

将返回的 `database_id` 添加到 `wrangler.toml`。

### 4. 设置 Secrets 并部署

```bash
# Telegram Bot Token（必需）
npx wrangler secret put BOT_TOKEN

# 管理员 Telegram User ID（必需，支持多管理员逗号分隔）
npx wrangler secret put ADMIN_USER_ID

# 部署
npm run deploy
```

> 获取 ADMIN_USER_ID：给 [@userinfobot](https://t.me/userinfobot) 发消息

### 5. 完成！

给 Bot 发 `/start` 即可使用。管理员在 Bot 中操作管理面板。

---

## 项目结构

```
erebusbot/
├── src/
│   ├── index.ts           # 入口，HTTP路由/Webhook处理
│   ├── bot.ts             # Bot核心逻辑，消息处理与回调
│   ├── db-optimized.ts    # 数据库操作层（带内存缓存）
│   ├── cache.ts           # MemoryCache 缓存类
│   ├── auth.ts            # Admin认证（JWT/API Key）
│   ├── security.ts        # 安全头/CSP/CORS
│   ├── logger.ts          # 日志模块
│   ├── dashboard.ts       # Web管理后台
│   └── types.ts           # TypeScript类型定义
├── scripts/
│   └── bump-version.js    # 版本号自动更新脚本
├── tests/                 # Vitest 测试套件
├── wrangler.toml          # Cloudflare配置
├── package.json
├── tsconfig.json
└── README.md
```

---

## API 端点

| 端点 | 方法 | 说明 | 认证 |
|------|------|------|------|
| `/` | GET | 服务信息 | 公开 |
| `/health` | GET | 健康检查 | 公开 |
| `/version` | GET | 版本信息 | 公开 |
| `/webhook` | POST | Telegram Webhook | 公开 |
| `/admin` | GET | 管理后台 (Web UI) | 需认证 |
| `/admin/api/stats` | GET | 统计数据 | 需认证 |
| `/admin/api/users` | GET | 用户列表 | 需认证 |
| `/admin/api/messages` | GET | 消息统计 | 需认证 |

---

## 数据库表

| 表名 | 用途 |
|------|------|
| `pm_users` | PM用户（ID、昵称、封禁状态、标签、备注） |
| `pm_messages` | 消息记录 |
| `pm_settings` | 系统设置（欢迎语、工作时间等） |
| `pm_auto_replies` | 自动回复规则 |
| `pm_blacklist_keywords` | 黑名单关键词 |
| `pm_quick_replies` | 快捷回复模板 |
| `pm_message_mappings` | 消息映射关系 |
| `pm_scheduled_messages` | 定时消息 |
| `pm_audit_log` | 审计日志 |
| `user_sessions` | 用户会话状态 |

---

## 环境变量

| 变量 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `BOT_TOKEN` | Secret | ✅ | Telegram Bot Token |
| `ADMIN_USER_ID` | Secret | ✅ | 管理员 Telegram User ID（多管理员逗号分隔） |
| `LANGUAGE` | Variable | ❌ | 语言 (默认 zh_CN) |
| `ADMIN_API_KEY` | Secret | ❌ | Admin API 访问密钥 |
| `ADMIN_JWT_SECRET` | Secret | ❌ | JWT签名密钥 |

---

## 开发

```bash
# 类型检查
npm run lint

# 运行测试
npm run test

# 更新版本号
npm run version:bump

# 构建
npm run build

# 部署（自动更新版本号）
npm run deploy
```

注释掉 `npm run deploy` 里的 `version:bump` 即可跳过版本号改动，直接 `npx wrangler deploy`。

---

## 自动部署（GitHub Actions）

`.github/workflows/deploy.yml` —— push 到 `main` 时自动跑「类型检查 → 测试 → 部署」；也可在 GitHub 仓库手动触发（workflow_dispatch）。

需要在仓库 **Settings → Secrets and variables → Actions → Secrets** 中添加一个密钥：

| Secret 名 | 取值 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | [My Profile → API Tokens](https://dash.cloudflare.com/profile/api-tokens) 创建的 Token，需勾选 `Account → Cloudflare Workers:Edit` 与 `Account → D1:Edit` |

生成后可直接本地跑一次，把 token 交给命令行：

```bash
export CLOUDFLARE_API_TOKEN=xxxxxxxxxxxx
npx wrangler whoami   # 确认已识别账号
npx wrangler deploy   # 部署 Worker + D1 绑定
```

注意事项：

- GitHub Actions 里**不会**执行 `version:bump`，避免 `package.json` 改动回写仓库造成下次合并冲突
- Worker 名取自 `wrangler.toml` 的 `name = "erebusbot"`，首次部署会直接创建该 Worker
- D1 的 `database_id` 已固化在 `wrangler.toml`，换机器/换环境不需要重新 `wrangler d1 create`

---

## 消息接收模式：轮询（默认）

Telegram 的 `setWebhook` 会**直接拒绝**解析到 `198.18.0.0/15`（Cloudflare 保留 anycast 段）的地址——
也就是 `*.workers.dev` 和 CF 自定义域名的默认解析结果，错误会被包装成
`Failed to resolve host: Name or service not known`，实际是那个保留段不可路由。

因此本项目默认走 **Cron 轮询**接收消息，不再依赖 webhook 域名：

- `wrangler.toml` 的 `[triggers] crons = ["*/1 * * * *"]` 每分钟触发 `/cron/poll`
- `bot.handlePoll()` 调 `getUpdates`，从 `pm_settings` 表读 `tg_poll_offset` 作起点
- 处理完把 `update_id + 1` 写回，天然去重；单条失败不中断整批，offset 仍前进
- **必须过滤 `from.is_bot`**：Bot 自己发出的消息也会出现在 `getUpdates` 结果里，
  不过滤会被当成「新消息」再转发一次，形成死循环刷屏

代价是约 1 分钟延迟（CF Cron 最小粒度就是 1 分钟）。若要改回 webhook 模式，
把 `[triggers]` 删掉、执行 `setWebhook`，并在 `dispatchUpdate` 处接回 `handleUpdate` 即可。

---

## 技术栈

- **运行时**: Cloudflare Workers (Edge)
- **数据库**: Cloudflare D1 (SQLite)
- **语言**: TypeScript (strict mode)
- **部署**: Wrangler CLI
- **测试**: Vitest
- **API**: Telegram Bot API

---

## License

MIT
