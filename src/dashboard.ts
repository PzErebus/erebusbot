export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ErebusBot 管理后台</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #f0f2f5;
            color: #333;
            line-height: 1.6;
        }
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 25px 20px;
            text-align: center;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        .header h1 { font-size: 28px; margin-bottom: 8px; font-weight: 600; }
        .header p { opacity: 0.9; font-size: 14px; }
        .nav {
            background: white;
            padding: 0 20px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.05);
            display: flex;
            justify-content: center;
            gap: 0;
        }
        .nav-item {
            padding: 15px 25px;
            cursor: pointer;
            border-bottom: 3px solid transparent;
            transition: all 0.3s;
            font-weight: 500;
            color: #666;
        }
        .nav-item:hover { color: #667eea; background: #f8f9fa; }
        .nav-item.active {
            color: #667eea;
            border-bottom-color: #667eea;
            background: #f8f9fa;
        }
        .container {
            max-width: 1400px;
            margin: 0 auto;
            padding: 25px 20px;
        }
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }
        .stat-card {
            background: white;
            border-radius: 12px;
            padding: 25px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.06);
            transition: all 0.3s;
            border-left: 4px solid #667eea;
        }
        .stat-card:hover { transform: translateY(-3px); box-shadow: 0 4px 15px rgba(0,0,0,0.1); }
        .stat-card .icon { font-size: 36px; margin-bottom: 12px; }
        .stat-card .number { font-size: 32px; font-weight: bold; color: #333; margin-bottom: 5px; }
        .stat-card .label { color: #888; font-size: 14px; }
        .stat-card.primary { border-left-color: #667eea; }
        .stat-card.success { border-left-color: #28a745; }
        .stat-card.warning { border-left-color: #ffc107; }
        .stat-card.danger { border-left-color: #dc3545; }
        .stat-card.info { border-left-color: #17a2b8; }
        .stat-card.secondary { border-left-color: #6c757d; }
        .section {
            background: white;
            border-radius: 12px;
            padding: 25px;
            margin-bottom: 25px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.06);
        }
        .section-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
            padding-bottom: 15px;
            border-bottom: 2px solid #f0f2f5;
        }
        .section h2 { font-size: 20px; color: #333; font-weight: 600; }
        .toolbar { display: flex; gap: 10px; align-items: center; }
        .btn {
            padding: 8px 16px;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
            transition: all 0.2s;
            display: inline-flex;
            align-items: center;
            gap: 6px;
        }
        .btn-primary { background: #667eea; color: white; }
        .btn-primary:hover { background: #5568d3; }
        .btn-secondary { background: #6c757d; color: white; }
        .btn-secondary:hover { background: #5a6268; }
        .search-box {
            padding: 8px 12px;
            border: 1px solid #ddd;
            border-radius: 6px;
            font-size: 14px;
            width: 200px;
        }
        .search-box:focus { outline: none; border-color: #667eea; }
        table { width: 100%; border-collapse: collapse; font-size: 14px; }
        th, td { text-align: left; padding: 14px 12px; border-bottom: 1px solid #f0f2f5; }
        th {
            background: #f8f9fa;
            font-weight: 600;
            color: #555;
            text-transform: uppercase;
            font-size: 12px;
            letter-spacing: 0.5px;
        }
        tr:hover { background: #f8f9fa; }
        .badge {
            display: inline-block;
            padding: 4px 10px;
            border-radius: 20px;
            font-size: 12px;
            font-weight: 500;
        }
        .badge-success { background: #d4edda; color: #155724; }
        .badge-danger { background: #f8d7da; color: #721c24; }
        .badge-warning { background: #fff3cd; color: #856404; }
        .badge-info { background: #d1ecf1; color: #0c5460; }
        .badge-secondary { background: #e2e3e5; color: #383d41; }
        .loading { text-align: center; padding: 50px; color: #888; }
        .loading-spinner {
            display: inline-block;
            width: 40px;
            height: 40px;
            border: 3px solid #f3f3f3;
            border-top: 3px solid #667eea;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin-bottom: 15px;
        }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        @keyframes pulse { 0% { transform: scale(1); } 50% { transform: scale(1.2); } 100% { transform: scale(1); } }
        .error {
            background: #f8d7da;
            color: #721c24;
            padding: 15px;
            border-radius: 8px;
            margin: 20px 0;
            border-left: 4px solid #dc3545;
        }
        .empty-state { text-align: center; padding: 60px 20px; color: #888; }
        .empty-state-icon { font-size: 48px; margin-bottom: 15px; opacity: 0.5; }
        .tab-content { display: none; }
        .tab-content.active { display: block; }
        .user-actions { display: flex; gap: 8px; }
        .action-btn {
            padding: 4px 10px;
            font-size: 12px;
            border-radius: 4px;
            cursor: pointer;
            border: none;
            transition: all 0.2s;
        }
        .action-btn.view { background: #e3f2fd; color: #1976d2; }
        .action-btn.view:hover { background: #bbdefb; }
        .action-btn.ban { background: #ffebee; color: #c62828; }
        .action-btn.ban:hover { background: #ffcdd2; }
        .action-btn.unban { background: #e8f5e9; color: #2e7d32; }
        .action-btn.unban:hover { background: #c8e6c9; }
        .pagination { display: flex; justify-content: center; gap: 8px; margin-top: 20px; }
        .page-btn {
            padding: 8px 14px;
            border: 1px solid #ddd;
            background: white;
            border-radius: 6px;
            cursor: pointer;
            transition: all 0.2s;
        }
        .page-btn:hover { background: #f8f9fa; }
        .page-btn.active { background: #667eea; color: white; border-color: #667eea; }
        .page-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .chart-placeholder {
            height: 200px;
            background: #f8f9fa;
            border-radius: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #888;
        }
        .filter-select {
            padding: 8px 12px;
            border: 1px solid #ddd;
            border-radius: 6px;
            font-size: 14px;
            background: white;
        }
        .stats-overview {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 20px;
            margin-bottom: 25px;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>🤖 ErebusBot 管理后台</h1>
        <p>实时查看 Bot 运行状态和用户数据</p>
    </div>

    <div class="nav">
        <div class="nav-item active" onclick="showTab('overview', this)">📊 总览</div>
        <div class="nav-item" onclick="showTab('users', this)">👥 用户管理</div>
        <div class="nav-item" onclick="showTab('messages', this)">📊 消息统计</div>
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
                        <h2>📈 消息趋势</h2>
                    </div>
                    <div class="chart-placeholder">消息统计图表（开发中）</div>
                </div>
                <div class="section">
                    <div class="section-header">
                        <h2>👥 用户增长</h2>
                    </div>
                    <div class="chart-placeholder">用户增长图表（开发中）</div>
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
                    <h2>📊 消息统计</h2>
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
                    <h2>📈 消息趋势</h2>
                </div>
                <div class="chart-placeholder">消息统计图表（开发中）</div>
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

    <script>
        // 全局数据存储
        let allUsers = [];
        let currentUserPage = 1;
        const itemsPerPage = 20;

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
                    const response = await fetch('/admin/api/messages');
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
                const response = await fetch('/admin/api/stats');
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
            } catch (err) {
                console.error('加载统计数据失败:', err);
            }
        }

        // 加载用户列表
        async function loadUsers() {
            try {
                const response = await fetch('/admin/api/users');
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
                const response = await fetch('/admin/api/stats');
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
                const response = await fetch('/admin/api/search?q=' + encodeURIComponent(query));
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

    </script>
</body>
</html>`;
