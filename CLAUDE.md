# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 第一原则（最高优先级，必须严格遵守）

**写代码时必须充分考虑所有关联处的影响，不能只顾当前。** 具体要求：

1. **修改前先审视全局** — 改任何函数/变量/结构前，先搜索所有引用方和依赖方，确认改动不会破坏其他地方
2. **禁止制造重复** — 新增逻辑前先检查是否已有类似实现可复用；共享常量/工具函数放 `common.js` 或 `config.py`，不允许跨文件复制
3. **保持函数精简** — 函数应职责单一、逻辑清晰；过长或职责混杂时应拆分为语义明确的子函数
4. **保持文件聚焦** — 文件应围绕单一职责组织；当职责明显混杂时按关注点拆分为独立模块
5. **消灭魔法数字** — 业务阈值、配置值必须提取为命名常量（后端放 `config.py`，前端放 `common.js` 顶部）
6. **改完必须自验** — 每次修改后必须启动应用、检查相关页面、确认无 console 错误和功能回归
   - 服务端日志（启动报错、WARNING、异常堆栈）必须逐条检视，发现即修，不能视而不见
   - 代码改动必须实际运行验证效果，不能只靠"看代码逻辑没问题"就算通过
   - Python 代码改动后注意 `__pycache__` 缓存问题，必要时清理后重启验证

## Project Overview

Arc Manager Pro is a Flask-based inventory management system for the game Arc Raiders. It supports multi-account inventory syncing (via arctracker.io API), order management with text parsing/fuzzy matching, bundle monitoring, customer tracking, and a Chrome extension for cookie-based authentication.

The codebase uses Chinese comments and UI strings throughout.

## Running the Application

```bash
python app.py
# Launches on http://localhost:5000 with auto-initialized SQLite DB and background sync scheduler
```

There is no build step, no package manager lockfile, and no automated test suite. `test.py` is a data analysis script, not a test runner.

## Architecture

**Three-layer structure:** Routes (HTTP) → Services (business logic) → Database (SQLite)

- `app.py` — Flask entry point, blueprint registration, scheduler startup
- `config.py` — DB path, sync intervals, scheduler timing
- `database.py` — SQLite connection via context manager (`get_conn()`), auto-commit/rollback
- `routes/` — Thin Flask blueprints that validate input and delegate to services
- `services/` — All business logic lives here; no SQL in routes, no HTTP in services
- `static/js/` — Vanilla JS frontend (single-page app with tab navigation)
- `templates/index.html` — Single HTML shell for the SPA
- `arcraiders-data-main/` — Read-only game data JSONs (items, hideout recipes)
- `arc-cookie-helper/` — Chrome Manifest V3 extension for capturing arctracker.io cookies

### Key Services

- **`sync_service.py`** — Background thread polls accounts for stale sync times, fetches from arctracker.io API with per-account delays to avoid rate-limiting
- **`match_service.py`** — Core fuzzy matching engine using bigram analysis + longest common substring for order text parsing; 文本解析已拆为 13 个独立格式解析器 + 调度循环
- **`order_service.py`** — Order CRUD (~660 lines); 短缺/库存计算已拆到 `shortage_service.py`，统计/导出已拆到 `order_report_service.py`
- **`shortage_service.py`** — 库存短缺计算、现货查询、补货建议
- **`order_report_service.py`** — 订单统计、每日导出报表
- **`item_service.py`** — Multi-source item data: game JSONs + DB overrides (`item_overrides` table); thread-safe cached loading
- **`bundle_service.py`** — Bundle CRUD with cost aggregation and real-time stock alert checking
- **`watchlist_service.py`** — Per-account item/bundle threshold monitoring with alert generation

### Database

Raw SQL with `sqlite3` (no ORM). All DB access uses the `get_conn()` context manager from `database.py`. Schema is auto-initialized in `init_db()` with backward-compatible migrations.

Key tables: `accounts`, `inventory`, `orders`, `order_items`, `bundles`, `bundle_items`, `bundle_aliases`, `bundle_alerts`, `item_overrides`, `item_aliases`, `customers`, `account_watch_rules`.

### Frontend

Vanilla JS SPA — each tab has a corresponding `static/js/<tab>.js` file. `common.js` provides shared API wrapper (`api.get/post/put/delete`), toast notifications, and utility functions. Charts use ECharts 5 via CDN.

## Dependencies

Python: `flask`, `requests`, `sqlite3` (stdlib). No `requirements.txt` — install Flask and requests manually.
