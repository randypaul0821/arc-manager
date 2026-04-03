<p align="center">
  <img src="static/favicon.svg" width="80" height="80" alt="Arc Manager Pro">
</p>

<h1 align="center">Arc Manager Pro</h1>

<p align="center">
  <strong>Arc Raiders 多账号库存管理 & 订单追踪系统</strong>
</p>

<p align="center">
  <a href="#features">功能特性</a> &nbsp;&bull;&nbsp;
  <a href="#quick-start">快速开始</a> &nbsp;&bull;&nbsp;
  <a href="#architecture">架构设计</a> &nbsp;&bull;&nbsp;
  <a href="#api">API 文档</a> &nbsp;&bull;&nbsp;
  <a href="#chrome-extension">Chrome 扩展</a> &nbsp;&bull;&nbsp;
  <a href="#contributing">参与贡献</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/python-3.12+-blue?logo=python&logoColor=white" alt="Python 3.12+">
  <img src="https://img.shields.io/badge/flask-2.3+-green?logo=flask&logoColor=white" alt="Flask">
  <img src="https://img.shields.io/badge/database-SQLite-blue?logo=sqlite&logoColor=white" alt="SQLite">
  <img src="https://img.shields.io/badge/frontend-Vanilla%20JS-yellow?logo=javascript&logoColor=white" alt="Vanilla JS">
  <img src="https://img.shields.io/badge/platform-Windows-0078D6?logo=windows&logoColor=white" alt="Windows">
</p>

---

## Overview

Arc Manager Pro 是一个为 [Arc Raiders](https://arcraiders.com/) 游戏玩家 / 商人打造的本地库存管理系统。通过对接 [arctracker.io](https://arctracker.io/) API 实现多账号库存自动同步，并提供订单文本智能解析、模糊匹配、套餐管理、缺货分析、客户追踪等完整的交易管理功能链。

### Why Arc Manager Pro?

- **多账号管理** — 同时监控多个游戏账号的库存变动
- **智能订单解析** — 粘贴客户消息，自动识别物品名称和数量（支持模糊匹配 + AI 辅助）
- **实时缺货预警** — 自定义阈值监控，低库存自动提醒
- **套餐化运营** — 预设常用套餐组合，一键核算成本与库存
- **零配置部署** — 双击 `install.bat` 即可完成环境搭建

---

<h2 id="features">Features</h2>

### Dashboard / 总览

实时展示活跃账号数、库存种类、待处理订单、营收利润等核心 KPI，附带营业走势图表（ECharts）。

### Inventory / 库存管理

- 多账号库存卡片视图，按武器 / 装备 / 材料 / 消耗品分类筛选
- 按稀有度（传说 / 史诗 / 稀有 / 优秀 / 普通）过滤
- 库存阈值呼吸灯提示（绿 = 充足 / 黄 = 低库存 / 红 = 缺货）
- 后台定时同步（默认每 30 分钟），支持手动触发

### Orders / 订单管理

- **文本解析引擎**：粘贴客户聊天记录，自动提取「物品名 x 数量」
- **模糊匹配算法**：基于 Bigram 分析 + 最长公共子串，容错率高
- **AI 辅助匹配**：低置信度物品可调用 Claude API 二次匹配
- 订单全生命周期管理（草稿 → 进行中 → 已完成 / 已取消）
- 智能分账建议：根据各账号库存自动推荐最优扣货方案
- 缺货清单 & 每日报表

### Bundles / 套餐管理

- 自定义套餐组合，支持成本自动聚合
- 套餐别名系统（一个套餐可匹配多种叫法）
- 来自游戏藏身处配方的自动生成

### Watchlist / 重点关注

- 按账号设置物品 / 套餐 / 物品类型的监控规则
- 自定义阈值，低于阈值自动标记告警
- 实时库存对比看板

### Customers / 客户管理

- 订单解析时自动创建客户档案
- 客户历史订单 & 活跃度追踪
- 自定义备注

---

<h2 id="quick-start">Quick Start</h2>

### Prerequisites

- **操作系统**：Windows 10 / 11
- **Python**：3.12+（`install.bat` 会自动检测，未安装时提示下载）

### Installation

```bash
# 1. 克隆仓库
git clone https://github.com/randypaul0821/arc-manager.git
cd arc-manager

# 2. 一键安装（创建虚拟环境 + 安装依赖 + 下载 Playwright 浏览器）
install.bat

# 3. 启动应用
start.bat
```

应用会在 `http://localhost:5000` 启动并自动打开浏览器。

### Manual Installation

```bash
# 创建虚拟环境
python -m venv venv
venv\Scripts\activate

# 安装依赖
pip install -r requirements.txt

# 安装 Playwright 浏览器（用于自动登录）
playwright install chromium

# 启动
python app.py
```

### Configuration

编辑 `config.py` 调整运行参数：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `SYNC_INTERVAL_MINUTES` | 30 | 账号库存同步间隔（分钟） |
| `SYNC_DELAY_SECONDS` | 4 | 多账号同步时逐个延迟（防频控） |
| `SCHEDULER_INTERVAL_SECONDS` | 300 | 后台调度检查周期（秒） |
| `AUTO_REFRESH_COOLDOWN_MINUTES` | 30 | 同步失败后自动刷新冷却时间 |

**AI 匹配（可选）**：设置环境变量 `CLAUDE_API_KEY` 启用 Claude 辅助匹配。

---

<h2 id="architecture">Architecture</h2>

### Tech Stack

| Layer | Technology |
|-------|-----------|
| **Backend** | Python 3.12+, Flask 2.3+ |
| **Database** | SQLite3 (context manager, auto-migration) |
| **Frontend** | Vanilla JS SPA, ECharts 5, CSS3 |
| **HTTP Client** | Requests (arctracker.io API) |
| **Browser Automation** | Playwright (auto-login) |
| **Text Processing** | Jieba (Chinese segmentation), Bigram fuzzy matching |
| **AI (Optional)** | Claude API (low-confidence match enhancement) |
| **Chrome Extension** | Manifest V3 (cookie capture) |

### Project Structure

```
arc-manager-pro/
├── app.py                      # Flask 入口，蓝图注册，调度器启动
├── config.py                   # 配置项（路径、同步间隔、API）
├── database.py                 # SQLite 连接 & 自动建表迁移
├── requirements.txt            # Python 依赖
│
├── routes/                     # HTTP 路由层（Flask 蓝图）
│   ├── accounts.py             #   账号 CRUD & 同步触发
│   ├── bundles.py              #   套餐管理
│   ├── customers.py            #   客户管理
│   ├── inventory.py            #   库存查询
│   ├── items.py                #   物品 & 别名
│   ├── orders.py               #   订单 & 文本解析
│   ├── settings.py             #   系统设置
│   └── watchlist.py            #   监控规则
│
├── services/                   # 业务逻辑层（核心代码 ~4,600 行）
│   ├── sync_service.py         #   后台同步调度器
│   ├── match_service.py        #   模糊匹配引擎
│   ├── order_service.py        #   订单全流程（最大模块 ~900 行）
│   ├── item_service.py         #   物品数据加载（线程安全缓存）
│   ├── bundle_service.py       #   套餐操作 & 成本计算
│   ├── inventory_service.py    #   库存聚合
│   ├── customer_service.py     #   客户追踪
│   ├── watchlist_service.py    #   告警规则 & 检查
│   ├── account_service.py      #   账号状态管理
│   ├── ai_match_service.py     #   Claude API 集成
│   └── auto_login.py           #   Playwright 自动登录
│
├── static/
│   ├── style.css               # 全局样式
│   └── js/                     # 前端模块（~5,100 行）
│       ├── common.js           #   公共 API 封装 & 工具函数
│       ├── dashboard.js        #   总览页
│       ├── inventory.js        #   库存页
│       ├── orders.js           #   订单页
│       ├── order_parse.js      #   订单解析
│       ├── bundles.js          #   套餐库
│       ├── bundle_monitor.js   #   重点关注
│       ├── items.js            #   物品库
│       ├── customers.js        #   客户页
│       ├── accounts.js         #   账号页
│       ├── watchlist.js        #   监控设置
│       └── shortage.js         #   缺货报表
│
├── templates/
│   └── index.html              # SPA 入口（单页应用外壳）
│
├── arcraiders-data-main/       # 游戏数据（只读）
│   ├── items/                  #   物品 JSON 定义
│   ├── hideout/                #   藏身处配方
│   └── images/items_ingame/    #   物品图标 PNG
│
├── arctracker-extension/       # Chrome 扩展（Cookie 捕获）
│   ├── manifest.json
│   ├── background.js
│   ├── presence.js
│   └── rules.json
│
├── install.bat                 # 一键安装脚本
├── start.bat                   # 启动脚本
└── pack.bat                    # 打包发布脚本
```

### Three-Layer Architecture

```
┌──────────────────────────────────────────────────────┐
│                    Frontend (SPA)                     │
│          Vanilla JS  ·  ECharts  ·  CSS3             │
└────────────────────────┬─────────────────────────────┘
                         │ HTTP / JSON
┌────────────────────────▼─────────────────────────────┐
│                   Routes (Blueprints)                 │
│          输入校验  ·  参数解析  ·  响应格式化           │
└────────────────────────┬─────────────────────────────┘
                         │ Function Call
┌────────────────────────▼─────────────────────────────┐
│                   Services (Logic)                    │
│     同步调度 · 模糊匹配 · 订单处理 · 告警检查          │
└────────────────────────┬─────────────────────────────┘
                         │ SQL (get_conn)
┌────────────────────────▼─────────────────────────────┐
│                   Database (SQLite)                   │
│          accounts · inventory · orders · bundles      │
└──────────────────────────────────────────────────────┘
```

**设计原则：**
- Routes 不写 SQL，Services 不碰 HTTP
- 所有数据库操作通过 `get_conn()` context manager，自动提交 / 回滚
- 物品数据线程安全缓存，支持多源合并（游戏 JSON + DB 覆盖 + 用户别名）

### Database Schema

主要表结构：

| Table | Description |
|-------|-------------|
| `accounts` | 游戏账号信息 & 同步状态 |
| `inventory` | 逐账号物品库存快照 |
| `orders` | 订单头信息（客户、状态、时间） |
| `order_items` | 订单明细（物品、数量、单价） |
| `bundles` | 套餐定义 |
| `bundle_items` | 套餐组成物品 |
| `bundle_aliases` | 套餐别名 |
| `bundle_alerts` | 自动生成的库存告警 |
| `item_overrides` | 物品自定义名称 |
| `item_aliases` | 物品搜索别名 |
| `customers` | 客户档案 |
| `account_watch_rules` | 账号监控规则 |
| `settings` | 系统配置键值对 |

数据库通过 `init_db()` 自动建表，支持向后兼容的增量迁移。

---

<h2 id="api">API Reference</h2>

所有 API 以 `/api` 为前缀，返回 JSON 格式。

<details>
<summary><strong>Items / 物品</strong></summary>

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/items?q=&rarity=&type=` | 搜索物品 |
| `GET` | `/api/items/<item_id>` | 物品详情 |
| `PUT` | `/api/items/<item_id>/name` | 修改物品名称 |
| `GET` | `/api/items/<item_id>/image` | 获取物品图片 |
| `GET` | `/api/items/<item_id>/aliases` | 获取别名列表 |
| `POST` | `/api/items/<item_id>/aliases` | 添加别名 |

</details>

<details>
<summary><strong>Inventory / 库存</strong></summary>

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/inventory?account_id=&q=` | 查询库存（按账号/搜索） |

</details>

<details>
<summary><strong>Accounts / 账号</strong></summary>

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/accounts` | 获取所有账号 |
| `POST` | `/api/accounts` | 创建账号 |
| `PUT` | `/api/accounts/<id>` | 更新账号信息 |
| `DELETE` | `/api/accounts/<id>` | 删除账号 |
| `POST` | `/api/accounts/<id>/sync` | 触发同步 |
| `GET` | `/api/accounts/<id>/cookie-status` | Cookie 有效性检查 |

</details>

<details>
<summary><strong>Orders / 订单</strong></summary>

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/orders?status=&customer_id=&days=` | 订单列表 |
| `POST` | `/api/orders` | 创建订单 |
| `PUT` | `/api/orders/<id>` | 更新订单 |
| `DELETE` | `/api/orders/<id>` | 删除订单 |
| `POST` | `/api/orders/<id>/complete` | 标记完成 |
| `POST` | `/api/orders/parse` | 文本解析 → 物品匹配 |
| `GET` | `/api/orders/shortage` | 缺货清单 |
| `GET` | `/api/orders/stats` | 统计数据 |

</details>

<details>
<summary><strong>Bundles / 套餐</strong></summary>

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/bundles?source=` | 套餐列表 |
| `POST` | `/api/bundles` | 创建套餐 |
| `PUT` | `/api/bundles/<id>` | 更新套餐 |
| `DELETE` | `/api/bundles/<id>` | 删除套餐 |
| `GET` | `/api/bundles/<id>/cost` | 计算套餐成本 |

</details>

<details>
<summary><strong>Customers / 客户</strong></summary>

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/customers?days=&limit=` | 客户列表 |
| `PUT` | `/api/customers/<id>` | 更新客户信息 |

</details>

<details>
<summary><strong>Watchlist / 监控</strong></summary>

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/watch/rules/<account_id>` | 获取监控规则 |
| `POST` | `/api/watch/rules/<account_id>` | 添加监控规则 |
| `DELETE` | `/api/watch/rules/<id>` | 删除规则 |

</details>

---

<h2 id="chrome-extension">Chrome Extension</h2>

`arctracker-extension/` 目录下包含一个 Chrome Manifest V3 扩展，用于自动捕获 arctracker.io 的登录 Cookie。

### Installation

1. 打开 Chrome，访问 `chrome://extensions/`
2. 开启右上角「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择 `arctracker-extension/` 文件夹
5. 登录 arctracker.io 后，扩展会自动将 Cookie 同步给本地应用

---

## Development

### Code Conventions

- **三层分离**：Routes 只做参数校验和转发，Services 包含全部业务逻辑，Database 通过 `get_conn()` 统一管理
- **代码注释**：Python / JS 注释使用中文
- **无 ORM**：直接使用原生 SQL，所有查询在 Services 层
- **线程安全**：物品数据缓存使用 `threading.Lock` 保护

### Running in Development

```bash
# 激活虚拟环境
venv\Scripts\activate

# 启动（debug 模式）
python app.py
# → http://localhost:5000
```

Flask 的 debug 模式会自动重载代码修改。SQLite 数据库在首次启动时自动建表。

---

## Packaging

```bash
# 打包为发布版 zip
pack.bat
# → release/ArcManagerPro.zip
```

打包产物包含所有源码、游戏数据、Chrome 扩展和安装脚本，终端用户解压后运行 `install.bat` → `start.bat` 即可使用。

---

## License

MIT License - 详见 [LICENSE](LICENSE) 文件。

---

<p align="center">
  <sub>Built with Flask & vanilla JS &nbsp;|&nbsp; Game data from <a href="https://arcraiders.com/">Arc Raiders</a></sub>
</p>
