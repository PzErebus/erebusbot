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
| 🛡️ 消息过滤 | 关键词规则过滤 + AI广告拦截（Qwen2.5-7B） |
| 📢 群发消息 | 向所有注册用户广播通知 |
| ⚙️ 基础设置 | 自定义欢迎语、重置默认 |
| 🕐 工作时间 | 设置工作时间，非工作时间自定义提示 |
| ⏰ 定时消息 | 定时发送消息给用户 |
| 📝 审计日志 | 操作记录追踪 |
| 💾 数据备份 | 数据概览与备份 |

### AI 广告检测

双层检测架构，规则优先 + AI 补充：

```
用户消息
  │
  ├─ ① 规则检测（即时）
  │    ├─ 促销用语 (20+规则)
  │    ├─ URL/短链接检测
  │    ├─ 联系方式检测
  │    ├─ 结构特征分析
  │    └─ 发送频率检测
  │
  ├─ 规则分 ≥ 严格阈值 → 直接拦截
  │
  └─ 规则分 < 阈值 → ② AI二次检测
       ├─ 调用 Qwen2.5-7B (SiliconFlow 免费模型)
       ├─ AI评分 + 规则评分合并
       └─ 合并分 ≥ AI阈值 → 拦截
```

| 配置 | 默认值 | 说明 |
|------|--------|------|
| AI增强检测 | 开启 | 规则未命中时AI二次检测 |
| AI阈值 | 60 | AI检测触发阈值（可切换40/60/80） |
| 规则阈值 | 50 | 规则检测触发阈值 |
| 严格阈值 | 80 | 直接拦截阈值 |
| 超时 | 5秒 | AI API调用超时 |
| 缓存 | 5分钟 | 相同内容不重复调用 |

### 性能优化
- 内存缓存层，减少 90%+ 数据库查询
- 并行异步操作，提升响应速度
- AI检测结果缓存，避免重复API调用
- D1 数据库 + Cloudflare Edge 部署

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

# SiliconFlow API Key（可选，用于AI广告检测）
npx wrangler secret put SILICONFLOW_API_KEY

# 部署
npx wrangler deploy
```

> 获取 ADMIN_USER_ID：给 [@userinfobot](https://t.me/userinfobot) 发消息
> 获取 SILICONFLOW_API_KEY：在 [SiliconFlow](https://siliconflow.cn) 注册，Qwen2.5-7B 免费使用

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
│   ├── ad-filter.ts       # AI广告检测（规则+Qwen2.5）
│   ├── cache.ts           # MemoryCache 缓存类
│   ├── auth.ts            # Admin认证（JWT/API Key）
│   ├── security.ts        # 安全头/CSP/CORS
│   ├── logger.ts          # 日志模块
│   ├── dashboard.ts       # Web管理后台
│   └── types.ts           # TypeScript类型定义
├── schema.sql             # 数据库建表SQL
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
| `pm_settings` | 系统设置（欢迎语、工作时间等） |
| `pm_auto_replies` | 自动回复规则 |
| `pm_blacklist_keywords` | 黑名单关键词 |
| `pm_quick_replies` | 快捷回复模板 |
| `pm_message_mappings` | 消息映射关系 |
| `pm_scheduled_messages` | 定时消息 |
| `pm_audit_log` | 审计日志 |
| `user_sessions` | 用户会话状态 |
| `rate_limits` | 限流记录 |

---

## 环境变量

| 变量 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `BOT_TOKEN` | Secret | ✅ | Telegram Bot Token |
| `ADMIN_USER_ID` | Secret | ✅ | 管理员 Telegram User ID（多管理员逗号分隔） |
| `SILICONFLOW_API_KEY` | Secret | ❌ | SiliconFlow API Key（AI广告检测） |
| `LANGUAGE` | Variable | ❌ | 语言 (默认 zh_CN) |
| `ADMIN_API_KEY` | Secret | ❌ | Admin API 访问密钥 |
| `ADMIN_JWT_SECRET` | Secret | ❌ | JWT签名密钥 |

---

## 开发

```bash
# 类型检查
npx tsc --noEmit

# 部署
npx wrangler deploy

# 查看实时日志
npx wrangler tail
```

---

## 技术栈

- **运行时**: Cloudflare Workers (Edge)
- **数据库**: Cloudflare D1 (SQLite)
- **AI模型**: Qwen2.5-7B-Instruct (SiliconFlow 免费API)
- **语言**: TypeScript (strict mode)
- **部署**: Wrangler CLI
- **API**: Telegram Bot API

---

## License

MIT
