export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ErebusBot 管理后台</title>
    <style>
        :root {
            --bg: #f3f5fb;
            --card: #ffffff;
            --line: #e7eaf3;
            --ink: #1c2340;
            --muted: #7b83a0;
            --accent: #5b6cff;
            --accent-2: #8b5cf6;
            --ok: #16a34a;
            --bad: #dc2626;
            --warn: #d97706;
            --info: #0891b2;
        }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', Roboto, sans-serif;
            background:
                radial-gradient(900px 300px at 85% -80px, rgba(91,108,255,0.08), transparent 60%),
                radial-gradient(700px 260px at 0% -60px, rgba(139,92,246,0.07), transparent 55%),
                var(--bg);
            color: var(--ink);
            line-height: 1.6;
            min-height: 100vh;
        }

        /* ===== 顶栏 ===== */
        .topbar {
            background: linear-gradient(120deg, #10142e 0%, #1b2150 70%, #2a2160 100%);
            color: #fff;
            box-shadow: 0 4px 18px rgba(16,20,46,0.25);
            position: sticky;
            top: 0;
            z-index: 50;
        }
        .topbar-inner {
            max-width: 1400px;
            margin: 0 auto;
            padding: 16px 20px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            flex-wrap: wrap;
        }
        .brand {
            font-size: 21px;
            font-weight: 700;
            letter-spacing: 0.3px;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .brand-dot {
            width: 11px; height: 11px;
            border-radius: 50%;
            background: #34d399;
            box-shadow: 0 0 0 4px rgba(52,211,153,0.22);
            animation: breath 2.4s ease-in-out infinite;
        }
        .brand em { font-style: normal; font-weight: 500; font-size: 14px; color: #aab2e8; margin-left: 2px; }
        .topbar-right { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
        .chip {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 4px 12px;
            border-radius: 999px;
            font-size: 12.5px;
            font-weight: 600;
            background: rgba(255,255,255,0.1);
            color: #d7dcff;
            border: 1px solid rgba(255,255,255,0.14);
            transition: all 0.3s;
        }
        .chip-ok { background: rgba(52,211,153,0.16); color: #6ee7b7; border-color: rgba(52,211,153,0.35); }
        .chip-bad { background: rgba(248,113,113,0.16); color: #fca5a5; border-color: rgba(248,113,113,0.35); }
        .chip-ghost { background: transparent; color: #aab2e8; }
        .topbar-link {
            font-size: 13px;
            color: #c3caff;
            cursor: pointer;
            text-decoration: underline;
            text-underline-offset: 3px;
            opacity: 0.85;
        }
        .topbar-link:hover { opacity: 1; }

        /* ===== 导航 ===== */
        .nav {
            background: var(--card);
            padding: 10px 20px;
            box-shadow: 0 1px 0 var(--line);
            display: flex;
            justify-content: center;
            gap: 8px;
            flex-wrap: wrap;
        }
        .nav-item {
            padding: 9px 22px;
            cursor: pointer;
            border-radius: 999px;
            transition: all 0.25s;
            font-weight: 500;
            color: var(--muted);
            font-size: 14.5px;
            border: 1px solid transparent;
        }
        .nav-item:hover { color: var(--accent); background: #eef0ff; }
        .nav-item.active {
            color: #fff;
            background: linear-gradient(135deg, var(--accent), var(--accent-2));
            box-shadow: 0 4px 12px rgba(91,108,255,0.32);
        }

        /* ===== 容器与卡片 ===== */
        .container {
            max-width: 1400px;
            margin: 0 auto;
            padding: 26px 20px 40px;
        }
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 18px;
            margin-bottom: 26px;
        }
        .stat-card {
            background: var(--card);
            border: 1px solid var(--line);
            border-radius: 16px;
            padding: 20px;
            box-shadow: 0 2px 10px rgba(28,35,64,0.05);
            transition: all 0.25s;
            position: relative;
            overflow: hidden;
        }
        .stat-card::after {
            content: '';
            position: absolute;
            left: 0; top: 0; bottom: 0;
            width: 4px;
            background: var(--accent);
        }
        .stat-card:hover { transform: translateY(-3px); box-shadow: 0 10px 24px rgba(28,35,64,0.1); }
        .stat-card .icon {
            width: 46px; height: 46px;
            border-radius: 13px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 23px;
            margin-bottom: 12px;
            background: linear-gradient(135deg, #eef0ff, #f3efff);
        }
        .stat-card .number { font-size: 30px; font-weight: 700; letter-spacing: 0.5px; margin-bottom: 2px; font-variant-numeric: tabular-nums; }
        .stat-card .label { color: var(--muted); font-size: 13.5px; }
        .stat-card.primary { border-left-color: var(--accent); }
        .stat-card.success { border-left-color: var(--ok); }
        .stat-card.warning { border-left-color: var(--warn); }
        .stat-card.danger { border-left-color: var(--bad); }
        .stat-card.info { border-left-color: var(--info); }
        .stat-card.secondary { border-left-color: #6c757d; }

        .section {
            background: var(--card);
            border: 1px solid var(--line);
            border-radius: 16px;
            padding: 22px;
            margin-bottom: 22px;
            box-shadow: 0 2px 10px rgba(28,35,64,0.05);
        }
        .section-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 18px;
            padding-bottom: 14px;
            border-bottom: 1px solid var(--line);
            flex-wrap: wrap;
            gap: 10px;
        }
        .section h2 { font-size: 17.5px; font-weight: 700; }
        .toolbar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }

        /* ===== 状态行与比例条 ===== */
        .sys-rows { display: flex; flex-direction: column; gap: 4px; }
        .sys-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 10px 4px;
            border-bottom: 1px dashed var(--line);
            font-size: 14px;
        }
        .sys-row:last-child { border-bottom: none; }
        .sys-row .k { color: var(--muted); }
        .sys-row .v { font-weight: 600; font-variant-numeric: tabular-nums; }
        .meter { position: relative; height: 9px; border-radius: 999px; background: #edf0f8; overflow: hidden; }
        .meter > span {
            display: block;
            height: 100%;
            width: 0;
            border-radius: 999px;
            background: linear-gradient(90deg, var(--accent), var(--accent-2));
            transition: width 0.6s ease;
        }
        .meter.m-unread > span { background: linear-gradient(90deg, #38bdf8, var(--info)); }
        .meter-row { padding: 10px 4px; }
        .meter-row .meter-head { display: flex; justify-content: space-between; font-size: 13.5px; margin-bottom: 7px; }
        .meter-row .meter-head .k { color: var(--muted); }
        .meter-row .meter-head .v { font-weight: 600; font-variant-numeric: tabular-nums; }

        /* ===== 按钮 / 输入 ===== */
        .btn {
            padding: 8px 18px;
            border: none;
            border-radius: 9px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 600;
            transition: all 0.2s;
            display: inline-flex;
            align-items: center;
            gap: 6px;
        }
        .btn-primary { background: linear-gradient(135deg, var(--accent), var(--accent-2)); color: #fff; box-shadow: 0 3px 10px rgba(91,108,255,0.28); }
        .btn-primary:hover { filter: brightness(1.06); transform: translateY(-1px); }
        .btn-secondary { background: #6c757d; color: white; }
        .btn-secondary:hover { background: #5a6268; }
        .search-box {
            padding: 9px 14px;
            border: 1px solid var(--line);
            border-radius: 9px;
            font-size: 14px;
            width: 210px;
            background: #fafbff;
            transition: all 0.2s;
        }
        .search-box:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(91,108,255,0.12); }
        .filter-select {
            padding: 9px 12px;
            border: 1px solid var(--line);
            border-radius: 9px;
            font-size: 14px;
            background: #fafbff;
            color: var(--ink);
        }

        /* ===== 表格 ===== */
        table { width: 100%; border-collapse: collapse; font-size: 14px; }
        th, td { text-align: left; padding: 12px; border-bottom: 1px solid var(--line); }
        th {
            background: #f7f8fd;
            font-weight: 600;
            color: var(--muted);
            font-size: 12px;
            letter-spacing: 0.6px;
        }
        tbody tr { transition: background 0.15s; }
        tbody tr:hover { background: #f7f8fd; }

        /* ===== 徽章 ===== */
        .badge {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 3px 11px;
            border-radius: 999px;
            font-size: 12px;
            font-weight: 600;
        }
        .badge::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
        .badge-success { background: #e7f8ee; color: #15803d; }
        .badge-danger { background: #fdecec; color: #b91c1c; }
        .badge-warning { background: #fdf3e2; color: #b45309; }
        .badge-info { background: #e3f5fa; color: #0e7490; }
        .badge-secondary { background: #eceef3; color: #475069; }

        /* ===== 加载 / 空态 / 错误 ===== */
        .loading { text-align: center; padding: 46px; color: var(--muted); }
        .loading-spinner {
            display: inline-block;
            width: 38px; height: 38px;
            border: 3px solid #e7eaf3;
            border-top: 3px solid var(--accent);
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin-bottom: 14px;
        }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        @keyframes pulse { 0% { transform: scale(1); } 50% { transform: scale(1.2); } 100% { transform: scale(1); } }
        @keyframes breath { 0%, 100% { box-shadow: 0 0 0 4px rgba(52,211,153,0.22); } 50% { box-shadow: 0 0 0 7px rgba(52,211,153,0.08); } }
        .error {
            background: #fdecec;
            color: #b91c1c;
            padding: 14px;
            border-radius: 10px;
            margin: 16px 0;
            border-left: 4px solid var(--bad);
            font-size: 14px;
        }
        .empty-state { text-align: center; padding: 54px 20px; color: var(--muted); }
        .empty-state-icon { font-size: 44px; margin-bottom: 12px; opacity: 0.55; }

        /* ===== 标签页 ===== */
        .tab-content { display: none; }
        .tab-content.active { display: block; }

        /* ===== 用户操作 ===== */
        .user-actions { display: flex; gap: 8px; }
        .action-btn {
            padding: 4px 12px;
            font-size: 12px;
            font-weight: 600;
            border-radius: 7px;
            cursor: pointer;
            border: none;
            transition: all 0.2s;
        }
        .action-btn.view { background: #e8f0fe; color: #1a56db; }
        .action-btn.view:hover { background: #d5e3fd; }
        .action-btn.ban { background: #fdecec; color: #b91c1c; }
        .action-btn.ban:hover { background: #fbdcdc; }
        .action-btn.unban { background: #e7f8ee; color: #15803d; }
        .action-btn.unban:hover { background: #d3f2e0; }

        /* ===== 分页 ===== */
        .pagination { display: flex; justify-content: center; gap: 8px; margin-top: 18px; flex-wrap: wrap; }
        .page-btn {
            padding: 7px 14px;
            border: 1px solid var(--line);
            background: var(--card);
            border-radius: 8px;
            cursor: pointer;
            transition: all 0.2s;
            font-size: 13.5px;
            color: var(--ink);
        }
        .page-btn:hover { background: #eef0ff; border-color: var(--accent); color: var(--accent); }
        .page-btn.active { background: linear-gradient(135deg, var(--accent), var(--accent-2)); color: #fff; border-color: transparent; }
        .page-btn:disabled { opacity: 0.45; cursor: not-allowed; }

        /* ===== 登录弹层 ===== */
        .login-mask {
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(16, 20, 46, 0.55);
            backdrop-filter: blur(4px);
            display: none;
            align-items: center;
            justify-content: center;
            z-index: 999;
        }
        .login-mask.show { display: flex; }
        .login-box {
            background: var(--card);
            border-radius: 18px;
            padding: 32px 30px;
            width: 350px;
            max-width: 90vw;
            box-shadow: 0 24px 60px rgba(16,20,46,0.35);
        }
        .login-box h2 { font-size: 19px; margin-bottom: 6px; }
        .login-box .login-sub { font-size: 13px; color: var(--muted); margin-bottom: 18px; }
        .login-box input {
            width: 100%;
            padding: 11px 13px;
            border: 1px solid var(--line);
            border-radius: 10px;
            font-size: 14px;
            margin-bottom: 12px;
            background: #fafbff;
            transition: all 0.2s;
        }
        .login-box input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(91,108,255,0.12); }
        .login-box .btn { width: 100%; }
        .login-error { color: var(--bad); font-size: 13px; min-height: 20px; margin-top: 6px; }

        /* ===== 页脚 ===== */
        .footer { text-align: center; color: var(--muted); font-size: 12.5px; padding: 10px 0 26px; }
    </style>
</head>
<body>
    <div class="topbar">
        <div class="topbar-inner">
            <div class="brand"><span class="brand-dot"></span>ErebusBot <em>· 管理控制台</em></div>
            <div class="topbar-right">
                <span class="chip" id="sysChip">● 检测中…</span>
                <span class="chip chip-ghost" id="verChip">v—</span>
                <span class="topbar-link" onclick="showLogin()">🔐 管理员登录</span>
            </div>
        </div>
    </div>

    <div class="login-mask" id="loginMask">
        <div class="login-box">
            <h2>🔐 管理员登录</h2>
            <div class="login-sub">输入 ADMIN_API_KEY 换取访问令牌（有效期 12 小时）</div>
            <input type="password" id="apiKeyInput" placeholder="ADMIN_API_KEY" autocomplete="current-password">
            <button class="btn btn-primary" onclick="doLogin()">登录</button>
            <div class="login-error" id="loginError"></div>
        </div>
    </div>

    <div class="nav">
        <div class="nav-item active" onclick="showTab('overview', this)">📊 总览</div>
        <div class="nav-item" onclick="showTab('users', this)">👥 用户管理</div>
        <div class="nav-item" onclick="showTab('messages', this)">💬 消息统计</div>
        <div class="nav-item" onclick="showTab('search', this)">🔍 消息搜索</div>
    </div>

    <div class="container">
        <!-- 总览页面 -->
        <div id="overview" class="tab-content active">
            <div class="stats-grid">
                <div class="stat-card success">
                    <div class="icon">👥</div>
                    <div class="number" id="statUsers">-</div>
                    <div class="label">用户总数</div>
                </div>
                <div class="stat-card info">
                    <div class="icon">💬</div>
                    <div class="number" id="statMessages">-</div>
                    <div class="label">消息总量</div>
                </div>
                <div class="stat-card warning">
                    <div class="icon">📨</div>
                    <div class="number" id="statToday">-</div>
                    <div class="label">今日消息</div>
                </div>
                <div class="stat-card danger">
                    <div class="icon">🚫</div>
                    <div class="number" id="statBlocked">-</div>
                    <div class="label">封禁用户</div>
                </div>
                <div class="stat-card warning">
                    <div class="icon">🔵</div>
                    <div class="number" id="statUnread">-</div>
                    <div class="label">未读消息</div>
                </div>
            </div>

            <div class="stats-overview">
                <div class="section">
                    <div class="section-header">
                        <h2>🖥️ 系统状态</h2>
                    </div>
                    <div class="sys-rows">
                        <div class="sys-row">
                            <span class="k">Worker 服务</span>
                            <span class="v" id="sysHealthV">检测中…</span>
                        </div>
                        <div class="sys-row">
                            <span class="k">当前版本</span>
                            <span class="v" id="sysVersionV">—</span>
                        </div>
                        <div class="sys-row">
                            <span class="k">收发模式</span>
                            <span class="v">Webhook 推送</span>
                        </div>
                        <div class="sys-row">
                            <span class="k">自动刷新</span>
                            <span class="v">每 30 秒</span>
                        </div>
                    </div>
                </div>
                <div class="section">
                    <div class="section-header">
                        <h2>📈 消息构成</h2>
                    </div>
                    <div class="meter-row">
                        <div class="meter-head">
                            <span class="k">今日消息占总量</span>
                            <span class="v" id="barTodayText">—</span>
                        </div>
                        <div class="meter"><span id="barToday"></span></div>
                    </div>
                    <div class="meter-row">
                        <div class="meter-head">
                            <span class="k">未读消息占总量</span>
                            <span class="v" id="barUnreadText">—</span>
                        </div>
                        <div class="meter m-unread"><span id="barUnread"></span></div>
                    </div>
                </div>
            </div>

            <div class="section">
                <div class="section-header">
                    <h2>🕐 最近活动</h2>
                </div>
                <div id="recentActivity">
                    <div class="loading">
                        <div class="loading-spinner"></div>
                        <div>加载中...</div>
                    </div>
                </div>
            </div>
        </div>

        <!-- 用户管理页面 -->
        <div id="users" class="tab-content">
            <div class="section">
                <div class="section-header">
                    <h2>👥 用户列表</h2>
                    <div class="toolbar">
                        <input type="text" class="search-box" id="userSearch" placeholder="🔍 搜索用户...">
                        <select class="filter-select" id="userFilter">
                            <option value="all">全部用户</option>
                            <option value="active">正常用户</option>
                            <option value="blocked">已封禁</option>
                        </select>
                        <button class="btn btn-primary" onclick="loadUsers()">🔄 刷新</button>
                    </div>
                </div>
                <div id="usersContainer">
                    <div class="loading">
                        <div class="loading-spinner"></div>
                        <div>加载用户数据中...</div>
                    </div>
                </div>
                <div class="pagination" id="userPagination"></div>
            </div>
        </div>

        <!-- 消息统计页面 -->
        <div id="messages" class="tab-content">
            <div class="section">
                <div class="section-header">
                    <h2>💬 消息统计</h2>
                    <div class="toolbar">
                        <button class="btn btn-primary" onclick="loadMessageStats()">🔄 刷新</button>
                    </div>
                </div>
                <div id="messageStatsContainer">
                    <div class="loading">
                        <div class="loading-spinner"></div>
                        <div>加载统计数据中...</div>
                    </div>
                </div>
            </div>
            <div class="section">
                <div class="section-header">
                    <h2>📈 消息构成</h2>
                </div>
                <div class="meter-row">
                    <div class="meter-head">
                        <span class="k">今日消息占总量</span>
                        <span class="v" id="barTodayText2">—</span>
                    </div>
                    <div class="meter"><span id="barToday2"></span></div>
                </div>
                <div class="meter-row">
                    <div class="meter-head">
                        <span class="k">未读消息占总量</span>
                        <span class="v" id="barUnreadText2">—</span>
                    </div>
                    <div class="meter m-unread"><span id="barUnread2"></span></div>
                </div>
            </div>
        </div>

        <!-- 消息搜索页面 -->
        <div id="search" class="tab-content">
            <div class="section">
                <div class="section-header">
                    <h2>🔍 消息搜索</h2>
                    <div class="toolbar">
                        <input type="text" class="search-box" id="msgSearchInput" placeholder="输入搜索关键词...">
                        <button class="btn btn-primary" onclick="searchMessages()">🔍 搜索</button>
                    </div>
                </div>
                <div id="searchResults">
                    <div class="empty-state">
                        <div class="empty-state-icon">🔍</div>
                        <div>输入关键词搜索消息记录</div>
                    </div>
                </div>
            </div>
        </div>

    </div>

    <div class="footer">ErebusBot 管理控制台 · 数据每 30 秒自动刷新 · 未读消息每 10 秒轮询提醒</div>

    <script>
        // 全局数据存储
        let allUsers = [];
        let currentUserPage = 1;
        const itemsPerPage = 20;

        // ===== 鉴权：管理后台会话令牌（用 ADMIN_API_KEY 换 JWT） =====
        const TOKEN_KEY = 'erebusbot_admin_token';
        let authToken = sessionStorage.getItem(TOKEN_KEY) || '';

        function setAuthToken(token) {
            authToken = token || '';
            if (authToken) {
                sessionStorage.setItem(TOKEN_KEY, authToken);
            } else {
                sessionStorage.removeItem(TOKEN_KEY);
            }
        }

        // 统一接口请求：自动携带 Bearer 令牌，遇到 401/403 自动弹登录框
        async function apiFetch(url, options) {
            const opts = options || {};
            const headers = Object.assign({}, opts.headers);
            if (authToken) {
                headers['Authorization'] = 'Bearer ' + authToken;
            }
            if (opts.body && !headers['Content-Type']) {
                headers['Content-Type'] = 'application/json';
            }
            const response = await fetch(url, Object.assign({}, opts, { headers: headers }));
            if (response.status === 401 || response.status === 403) {
                setAuthToken('');
                showLogin();
            }
            return response;
        }

        function showLogin(message) {
            const mask = document.getElementById('loginMask');
            const errEl = document.getElementById('loginError');
            if (errEl && message) errEl.textContent = message;
            if (mask) mask.classList.add('show');
        }

        function hideLogin() {
            const mask = document.getElementById('loginMask');
            if (mask) mask.classList.remove('show');
        }

        // 用 ADMIN_API_KEY 换取 JWT
        function doLogin() {
            const keyInput = document.getElementById('apiKeyInput');
            const errEl = document.getElementById('loginError');
            const key = keyInput ? keyInput.value.trim() : '';
            errEl.textContent = '';
            if (!key) {
                errEl.textContent = '请输入 ADMIN_API_KEY';
                return;
            }

            fetch('/admin/api/auth/login', {
                method: 'POST',
                headers: { 'X-API-Key': key, 'Content-Type': 'application/json' }
            })
            .then(function(res) {
                return res.json().then(function(data) {
                    return { ok: res.ok, data: data };
                });
            })
            .then(function(result) {
                if (result.ok && result.data && result.data.token) {
                    setAuthToken(result.data.token);
                    if (keyInput) keyInput.value = '';
                    hideLogin();
                    refreshAll();
                } else {
                    errEl.textContent = (result.data && result.data.error) || '登录失败';
                }
            })
            .catch(function(err) {
                errEl.textContent = '网络错误: ' + err.message;
            });
        }

        // 重新拉取所有数据（登录成功后调用）
        function refreshAll() {
            loadStats();
            loadUsers();
            loadMessageStats();
        }

        // 回车登录
        document.addEventListener('DOMContentLoaded', function() {
            const keyInput = document.getElementById('apiKeyInput');
            if (keyInput) {
                keyInput.addEventListener('keydown', function(e) {
                    if (e.key === 'Enter') doLogin();
                });
            }
        });

        // DOMContentLoaded事件
        document.addEventListener('DOMContentLoaded', function() {
            loadStats();
            loadUsers();
            loadMessageStats();
            loadRecentActivity();

            // 搜索和筛选事件监听
            document.getElementById('userSearch').addEventListener('input', debounce(filterUsers, 300));
            document.getElementById('userFilter').addEventListener('change', filterUsers);

            // 自动刷新统计数据
            setInterval(() => {
                loadStats();
            }, 30000);

            // 实时推送 - 轮询未读消息数
            let lastUnreadCount = 0;
            setInterval(async () => {
                try {
                    const response = await apiFetch('/admin/api/messages');
                    if (response.ok) {
                        const data = await response.json();
                        const newUnread = data.stats?.unread || 0;
                        if (newUnread !== lastUnreadCount && newUnread > lastUnreadCount) {
                            const diff = newUnread - lastUnreadCount;
                            const badge = document.getElementById('statUnread');
                            if (badge) {
                                badge.style.animation = 'none';
                                badge.offsetHeight;
                                badge.style.animation = 'pulse 0.5s ease';
                            }
                            if (Notification.permission === 'granted') {
                                new Notification('ErebusBot', { body: diff + ' 条新消息', icon: '📨' });
                            }
                        }
                        lastUnreadCount = newUnread;
                        const unreadEl = document.getElementById('statUnread');
                        if (unreadEl) unreadEl.textContent = newUnread;
                    }
                } catch {}
            }, 10000);

            if ('Notification' in window && Notification.permission === 'default') {
                Notification.requestPermission();
            }
        });

        // 防抖函数
        function debounce(func, wait) {
            let timeout;
            return function executedFunction(...args) {
                const later = () => {
                    clearTimeout(timeout);
                    func(...args);
                };
                clearTimeout(timeout);
                timeout = setTimeout(later, wait);
            };
        }

        // 切换标签页
        function showTab(tabName, element) {
            document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));

            if (element) {
                element.classList.add('active');
            } else {
                document.querySelector('.nav-item[onclick*="' + tabName + '"]').classList.add('active');
            }
            document.getElementById(tabName).classList.add('active');
        }

        // 安全的文本创建函数（防止XSS）
        function createTextNode(text) {
            return document.createTextNode(text || '');
        }

        // 加载统计数据
        async function loadStats() {
            try {
                const response = await apiFetch('/admin/api/stats');
                if (!response.ok) {
                    throw new Error('HTTP ' + response.status);
                }
                const data = await response.json();

                if (data.error) {
                    console.error('加载统计数据失败:', data.error);
                    return;
                }

                document.getElementById('statUsers').textContent = data.totalUsers || 0;
                document.getElementById('statMessages').textContent = data.totalMessages || 0;
                document.getElementById('statToday').textContent = data.todayMessages || 0;
                document.getElementById('statBlocked').textContent = data.blockedUsers || 0;

                const unreadEl = document.getElementById('statUnread');
                if (unreadEl && data.unread !== undefined) {
                    unreadEl.textContent = data.unread;
                }

                // 美化 v2：同步更新消息构成比例条（总览 + 消息统计页两组）
                const total = data.totalMessages || 0;
                const today = data.todayMessages || 0;
                const unread = data.unread || 0;
                const pctToday = total > 0 ? Math.min(100, Math.round(today / total * 100)) : 0;
                const pctUnread = total > 0 ? Math.min(100, Math.round(unread / total * 100)) : 0;
                [['barToday', 'barTodayText'], ['barToday2', 'barTodayText2']].forEach(function(pair) {
                    const bar = document.getElementById(pair[0]);
                    const txt = document.getElementById(pair[1]);
                    if (bar) bar.style.width = pctToday + '%';
                    if (txt) txt.textContent = today + ' / ' + total + '（' + pctToday + '%）';
                });
                [['barUnread', 'barUnreadText'], ['barUnread2', 'barUnreadText2']].forEach(function(pair) {
                    const bar = document.getElementById(pair[0]);
                    const txt = document.getElementById(pair[1]);
                    if (bar) bar.style.width = pctUnread + '%';
                    if (txt) txt.textContent = unread + ' / ' + total + '（' + pctUnread + '%）';
                });
            } catch (err) {
                console.error('加载统计数据失败:', err);
            }
        }

        // 加载用户列表
        async function loadUsers() {
            try {
                const response = await apiFetch('/admin/api/users');
                if (!response.ok) {
                    throw new Error('HTTP ' + response.status);
                }
                const data = await response.json();

                if (data.error) {
                    showError('usersContainer', data.error);
                    return;
                }

                allUsers = data.users || [];
                filterUsers();
            } catch (err) {
                showError('usersContainer', '加载用户数据失败: ' + err.message);
            }
        }

        // 显示错误信息
        function showError(containerId, message) {
            const container = document.getElementById(containerId);
            container.innerHTML = '';

            const errorDiv = document.createElement('div');
            errorDiv.className = 'error';
            errorDiv.appendChild(createTextNode(message));
            container.appendChild(errorDiv);
        }

        // 筛选用户
        function filterUsers() {
            const searchTerm = document.getElementById('userSearch').value.toLowerCase();
            const filterType = document.getElementById('userFilter').value;

            let filtered = allUsers.filter(user => {
                const matchesSearch = !searchTerm ||
                    (user.first_name && user.first_name.toLowerCase().includes(searchTerm)) ||
                    (user.username && user.username.toLowerCase().includes(searchTerm)) ||
                    user.user_id.toString().includes(searchTerm);

                const matchesFilter = filterType === 'all' ||
                    (filterType === 'active' && !user.is_blocked) ||
                    (filterType === 'blocked' && user.is_blocked);

                return matchesSearch && matchesFilter;
            });

            renderUsers(filtered, currentUserPage);
        }

        // 渲染用户列表（使用DOM操作，避免innerHTML XSS）
        function renderUsers(users, page) {
            const container = document.getElementById('usersContainer');
            container.innerHTML = '';

            if (users.length === 0) {
                const emptyState = document.createElement('div');
                emptyState.className = 'empty-state';

                const icon = document.createElement('div');
                icon.className = 'empty-state-icon';
                icon.textContent = '👤';

                const text = document.createElement('div');
                text.appendChild(createTextNode('暂无用户数据'));

                emptyState.appendChild(icon);
                emptyState.appendChild(text);
                container.appendChild(emptyState);

                document.getElementById('userPagination').innerHTML = '';
                return;
            }

            const start = (page - 1) * itemsPerPage;
            const end = start + itemsPerPage;
            const pageUsers = users.slice(start, end);
            const totalPages = Math.ceil(users.length / itemsPerPage);

            // 创建表格
            const table = document.createElement('table');
            const thead = document.createElement('thead');
            const tbody = document.createElement('tbody');

            // 表头
            const headerRow = document.createElement('tr');
            const headers = ['用户ID', '名字', '用户名', '消息数', '状态', '加入时间', '操作'];
            headers.forEach(text => {
                const th = document.createElement('th');
                th.appendChild(createTextNode(text));
                headerRow.appendChild(th);
            });
            thead.appendChild(headerRow);

            // 表体
            pageUsers.forEach(user => {
                const row = document.createElement('tr');

                // 用户ID
                const idCell = document.createElement('td');
                idCell.appendChild(createTextNode(user.user_id));
                row.appendChild(idCell);

                // 名字
                const nameCell = document.createElement('td');
                nameCell.appendChild(createTextNode(user.first_name || 'Unknown'));
                row.appendChild(nameCell);

                // 用户名
                const usernameCell = document.createElement('td');
                usernameCell.appendChild(createTextNode(user.username ? '@' + user.username : '-'));
                row.appendChild(usernameCell);

                // 消息数
                const msgCell = document.createElement('td');
                msgCell.appendChild(createTextNode(user.message_count || 0));
                row.appendChild(msgCell);

                // 状态
                const statusCell = document.createElement('td');
                const badge = document.createElement('span');
                badge.className = user.is_blocked ? 'badge badge-danger' : 'badge badge-success';
                badge.appendChild(createTextNode(user.is_blocked ? '已封禁' : '正常'));
                statusCell.appendChild(badge);
                row.appendChild(statusCell);

                // 加入时间
                const dateCell = document.createElement('td');
                const date = new Date(user.created_at * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
                dateCell.appendChild(createTextNode(date));
                row.appendChild(dateCell);

                // 操作
                const actionCell = document.createElement('td');
                actionCell.className = 'user-actions';

                const viewBtn = document.createElement('button');
                viewBtn.className = 'action-btn view';
                viewBtn.textContent = '查看';
                viewBtn.onclick = function() { viewUser(user.user_id); };
                actionCell.appendChild(viewBtn);

                const banBtn = document.createElement('button');
                banBtn.className = user.is_blocked ? 'action-btn unban' : 'action-btn ban';
                banBtn.textContent = user.is_blocked ? '解封' : '封禁';
                banBtn.onclick = function() {
                    if (user.is_blocked) {
                        unbanUser(user.user_id);
                    } else {
                        banUser(user.user_id);
                    }
                };
                actionCell.appendChild(banBtn);

                row.appendChild(actionCell);
                tbody.appendChild(row);
            });

            table.appendChild(thead);
            table.appendChild(tbody);
            container.appendChild(table);

            // 渲染分页
            renderPagination('userPagination', totalPages, page, function(p) {
                currentUserPage = p;
                renderUsers(users, p);
            });
        }

        // 渲染分页
        function renderPagination(containerId, totalPages, currentPage, callback) {
            const container = document.getElementById(containerId);
            container.innerHTML = '';

            if (totalPages <= 1) {
                return;
            }

            // 上一页
            const prevBtn = document.createElement('button');
            prevBtn.className = 'page-btn';
            prevBtn.textContent = '上一页';
            prevBtn.disabled = currentPage === 1;
            prevBtn.onclick = function() { callback(currentPage - 1); };
            container.appendChild(prevBtn);

            // 页码
            for (let i = 1; i <= totalPages; i++) {
                if (i === 1 || i === totalPages || (i >= currentPage - 2 && i <= currentPage + 2)) {
                    const pageBtn = document.createElement('button');
                    pageBtn.className = 'page-btn' + (i === currentPage ? ' active' : '');
                    pageBtn.textContent = i;
                    pageBtn.onclick = function() { callback(i); };
                    container.appendChild(pageBtn);
                } else if (i === currentPage - 3 || i === currentPage + 3) {
                    const ellipsis = document.createElement('span');
                    ellipsis.textContent = '...';
                    container.appendChild(ellipsis);
                }
            }

            // 下一页
            const nextBtn = document.createElement('button');
            nextBtn.className = 'page-btn';
            nextBtn.textContent = '下一页';
            nextBtn.disabled = currentPage === totalPages;
            nextBtn.onclick = function() { callback(currentPage + 1); };
            container.appendChild(nextBtn);
        }

        // 加载消息统计（不显示具体消息内容，保护隐私）
        async function loadMessageStats() {
            try {
                const response = await apiFetch('/admin/api/stats');
                if (!response.ok) {
                    throw new Error('HTTP ' + response.status);
                }
                const data = await response.json();

                if (data.error) {
                    showError('messageStatsContainer', data.error);
                    return;
                }

                const container = document.getElementById('messageStatsContainer');
                container.innerHTML = '';

                // 创建统计卡片容器
                const statsGrid = document.createElement('div');
                statsGrid.className = 'stats-grid';

                statsGrid.appendChild(createStatCard('💬', data.stats.total || 0, '消息总量', 'info'));
                statsGrid.appendChild(createStatCard('📅', data.stats.today || 0, '今日消息', 'warning'));
                statsGrid.appendChild(createStatCard('🚫', data.stats.blockedUsers || 0, '封禁用户', 'danger'));
                statsGrid.appendChild(createStatCard('🔵', data.stats.unread || 0, '未读消息', 'warning'));

                container.appendChild(statsGrid);
            } catch (err) {
                showError('messageStatsContainer', '加载统计数据失败: ' + err.message);
            }
        }

        // 创建统计卡片
        function createStatCard(icon, number, label, type) {
            const card = document.createElement('div');
            card.className = 'stat-card ' + type;

            const iconDiv = document.createElement('div');
            iconDiv.className = 'icon';
            iconDiv.textContent = icon;
            card.appendChild(iconDiv);

            const numberDiv = document.createElement('div');
            numberDiv.className = 'number';
            numberDiv.textContent = number;
            card.appendChild(numberDiv);

            const labelDiv = document.createElement('div');
            labelDiv.className = 'label';
            labelDiv.textContent = label;
            card.appendChild(labelDiv);

            return card;
        }

        async function loadRecentActivity() {
            const container = document.getElementById('recentActivity');
            container.innerHTML = '';

            const emptyState = document.createElement('div');
            emptyState.className = 'empty-state';

            const icon = document.createElement('div');
            icon.className = 'empty-state-icon';
            icon.textContent = '📋';

            const text = document.createElement('div');
            text.appendChild(createTextNode('暂无最近活动'));

            emptyState.appendChild(icon);
            emptyState.appendChild(text);
            container.appendChild(emptyState);
        }

        // 查看用户详情
        function viewUser(userId) {
            alert('查看用户 ' + userId + ' 的详情（功能开发中）');
        }

        // 封禁用户
        async function banUser(userId) {
            if (!confirm('确定要封禁用户 ' + userId + ' 吗？')) return;
            alert('封禁用户功能需要在 Telegram Bot 中操作');
        }

        // 解封用户
        async function unbanUser(userId) {
            if (!confirm('确定要解封用户 ' + userId + ' 吗？')) return;
            alert('解封用户功能需要在 Telegram Bot 中操作');
        }

        // 搜索消息
        async function searchMessages() {
            const query = document.getElementById('msgSearchInput').value.trim();
            const container = document.getElementById('searchResults');

            if (!query || query.length < 2) {
                container.innerHTML = '';
                const emptyState = document.createElement('div');
                emptyState.className = 'empty-state';
                const icon = document.createElement('div');
                icon.className = 'empty-state-icon';
                icon.textContent = '⚠️';
                const text = document.createElement('div');
                text.appendChild(createTextNode('请输入至少2个字符'));
                emptyState.appendChild(icon);
                emptyState.appendChild(text);
                container.appendChild(emptyState);
                return;
            }

            container.innerHTML = '';
            const loading = document.createElement('div');
            loading.className = 'loading';
            loading.innerHTML = '<div class="loading-spinner"></div><div>搜索中...</div>';
            container.appendChild(loading);

            try {
                const response = await apiFetch('/admin/api/search?q=' + encodeURIComponent(query));
                if (!response.ok) throw new Error('HTTP ' + response.status);
                const data = await response.json();

                container.innerHTML = '';

                if (data.error) {
                    showError('searchResults', data.error);
                    return;
                }

                if (!data.results || data.results.length === 0) {
                    const emptyState = document.createElement('div');
                    emptyState.className = 'empty-state';
                    const icon = document.createElement('div');
                    icon.className = 'empty-state-icon';
                    icon.textContent = '🔍';
                    const text = document.createElement('div');
                    text.appendChild(createTextNode('未找到匹配的消息'));
                    emptyState.appendChild(icon);
                    emptyState.appendChild(text);
                    container.appendChild(emptyState);
                    return;
                }

                const countDiv = document.createElement('div');
                countDiv.style.marginBottom = '15px';
                countDiv.style.color = '#666';
                countDiv.appendChild(createTextNode('找到 ' + data.count + ' 条结果'));
                container.appendChild(countDiv);

                const table = document.createElement('table');
                const thead = document.createElement('thead');
                const tbody = document.createElement('tbody');
                const headerRow = document.createElement('tr');
                ['方向', '用户ID', '内容', '时间'].forEach(text => {
                    const th = document.createElement('th');
                    th.appendChild(createTextNode(text));
                    headerRow.appendChild(th);
                });
                thead.appendChild(headerRow);

                data.results.forEach(msg => {
                    const row = document.createElement('tr');

                    const dirCell = document.createElement('td');
                    dirCell.textContent = msg.direction === 'in' ? '👤 用户' : '🤖 管理员';
                    row.appendChild(dirCell);

                    const userCell = document.createElement('td');
                    userCell.appendChild(createTextNode(msg.user_id));
                    row.appendChild(userCell);

                    const contentCell = document.createElement('td');
                    const contentText = msg.content || '';
                    contentCell.appendChild(createTextNode(contentText.length > 80 ? contentText.substring(0, 80) + '...' : contentText));
                    row.appendChild(contentCell);

                    const timeCell = document.createElement('td');
                    timeCell.appendChild(createTextNode(new Date(msg.created_at * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })));
                    row.appendChild(timeCell);

                    tbody.appendChild(row);
                });

                table.appendChild(thead);
                table.appendChild(tbody);
                container.appendChild(table);
            } catch (err) {
                container.innerHTML = '';
                showError('searchResults', '搜索失败: ' + err.message);
            }
        }

        document.getElementById('msgSearchInput').addEventListener('keypress', function(e) {
            if (e.key === 'Enter') searchMessages();
        });

        // ===== 美化 v2：顶栏系统状态实时监测（/health 与 /version 为公开端点） =====
        function refreshSystemStatus() {
            fetch('/version').then(function(r) { return r.json(); }).then(function(d) {
                const ver = document.getElementById('verChip');
                const v = document.getElementById('sysVersionV');
                if (ver && d && d.version) ver.textContent = 'v' + d.version;
                if (v && d && d.version) v.textContent = d.version;
            }).catch(function() {});
            fetch('/health').then(function(r) {
                const chip = document.getElementById('sysChip');
                const hv = document.getElementById('sysHealthV');
                if (chip) {
                    if (r.ok) { chip.className = 'chip chip-ok'; chip.textContent = '● 运行正常'; }
                    else { chip.className = 'chip chip-bad'; chip.textContent = '● 异常 ' + r.status; }
                }
                if (hv) hv.textContent = r.ok ? '🟢 正常' : '🔴 异常（HTTP ' + r.status + '）';
            }).catch(function() {
                const chip = document.getElementById('sysChip');
                const hv = document.getElementById('sysHealthV');
                if (chip) { chip.className = 'chip chip-bad'; chip.textContent = '● 无响应'; }
                if (hv) hv.textContent = '🔴 无响应';
            });
        }
        refreshSystemStatus();
        setInterval(refreshSystemStatus, 30000);

    </script>
</body>
</html>`;
