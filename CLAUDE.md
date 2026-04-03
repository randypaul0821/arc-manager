# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
- **`match_service.py`** — Core fuzzy matching engine using bigram analysis + longest common substring for order text parsing
- **`order_service.py`** — Largest service (~900 lines); order creation, item matching, shortage calculation, pricing
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
