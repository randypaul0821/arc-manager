"""
数据库连接与初始化
使用上下文管理器确保连接安全释放、异常自动回滚
"""
import sqlite3
import logging
from contextlib import contextmanager
from config import DB_PATH

logger = logging.getLogger("database")


@contextmanager
def get_conn():
    """
    获取数据库连接（上下文管理器）。
    - 正常退出：自动 commit
    - 异常退出：自动 rollback
    - 始终关闭连接，杜绝泄漏
    """
    logger.debug(f"正在创建数据库连接: {DB_PATH}")
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    except Exception as e:
        conn.rollback()
        logger.warning(f"事务已回滚，异常: {e}")
        raise
    finally:
        conn.close()


def init_db():
    logger.info("开始初始化数据库...")
    with get_conn() as conn:
        c = conn.cursor()

        c.executescript("""
            CREATE TABLE IF NOT EXISTS item_overrides (
                item_id      TEXT PRIMARY KEY,
                name_zh      TEXT,
                is_starred   INTEGER DEFAULT 0,
                alert_min    INTEGER DEFAULT 0,
                alert_enabled INTEGER DEFAULT 0,
                updated_at   TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS item_aliases (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                item_id    TEXT NOT NULL,
                alias      TEXT NOT NULL UNIQUE,
                created_at TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS accounts (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                name        TEXT NOT NULL UNIQUE,
                cookie      TEXT NOT NULL DEFAULT '',
                note        TEXT DEFAULT '',
                active      INTEGER DEFAULT 1,
                last_sync   TEXT,
                sync_status TEXT DEFAULT 'never',
                sync_error  TEXT DEFAULT '',
                used_slots  INTEGER DEFAULT 0,
                max_slots   INTEGER DEFAULT 0,
                credits     INTEGER DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS inventory (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                item_id    TEXT NOT NULL,
                quantity   INTEGER NOT NULL,
                slot       INTEGER,
                durability REAL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS bundles (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                name       TEXT NOT NULL UNIQUE,
                source     TEXT DEFAULT 'manual',
                created_at TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS bundle_items (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                bundle_id INTEGER NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
                item_id   TEXT NOT NULL,
                quantity  INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS bundle_aliases (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                bundle_id INTEGER NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
                alias     TEXT NOT NULL UNIQUE,
                created_at TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS bundle_alerts (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                bundle_id INTEGER NOT NULL UNIQUE REFERENCES bundles(id) ON DELETE CASCADE,
                min_sets  INTEGER DEFAULT 1,
                enabled   INTEGER DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS customers (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                name       TEXT NOT NULL UNIQUE,
                note       TEXT DEFAULT '',
                created_at TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS orders (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                customer_id    INTEGER REFERENCES customers(id) ON DELETE SET NULL,
                customer_name  TEXT DEFAULT '',
                status         TEXT DEFAULT 'pending',
                raw_text       TEXT DEFAULT '',
                total_cost     REAL DEFAULT 0,
                total_revenue  REAL DEFAULT 0,
                created_at     TEXT DEFAULT (datetime('now')),
                completed_at   TEXT
            );
            CREATE TABLE IF NOT EXISTS order_items (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                order_id  INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
                item_id   TEXT NOT NULL,
                raw_name  TEXT DEFAULT '',
                quantity  INTEGER NOT NULL,
                cost_price REAL DEFAULT 0,
                sell_price REAL DEFAULT 0,
                ready     INTEGER DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS order_accounts (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
                account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS item_prices (
                item_id    TEXT PRIMARY KEY,
                cost_price REAL DEFAULT 0,
                sell_price REAL DEFAULT 0,
                updated_at TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS settings (
                key   TEXT PRIMARY KEY,
                value TEXT DEFAULT ''
            );
        """)

        _migrate(c)

    logger.info("数据库初始化完成")


def _migrate(c):
    """从旧表结构迁移数据到新表，每项迁移只执行一次。"""

    # 1
    try:
        old = c.execute(
            "SELECT item_id, alias FROM item_aliases WHERE is_primary=1"
        ).fetchall()
        for r in old:
            c.execute("INSERT OR IGNORE INTO item_overrides (item_id, name_zh) VALUES (?, ?)", (r[0], r[1]))
        if old:
            logger.info(f"  迁移 {len(old)} 条主显示名到 item_overrides")
    except sqlite3.OperationalError:
        logger.debug("迁移步骤1: 旧表/列不存在，跳过")
    except Exception as e:
        logger.warning(f"迁移步骤1异常: {e}", exc_info=True)

    # 2
    try:
        old = c.execute(
            "SELECT item_id, alias FROM item_aliases WHERE is_primary=0 OR is_primary IS NULL"
        ).fetchall()
        for r in old:
            c.execute("INSERT OR IGNORE INTO item_aliases (item_id, alias) VALUES (?, ?)", (r[0], r[1]))
        if old:
            logger.info(f"  迁移 {len(old)} 条搜索别名到 item_aliases")
    except sqlite3.OperationalError:
        logger.debug("迁移步骤2: 旧表/列不存在，跳过")
    except Exception as e:
        logger.warning(f"迁移步骤2异常: {e}", exc_info=True)

    # 3
    try:
        old = c.execute("SELECT item_id, alias FROM search_aliases").fetchall()
        for r in old:
            c.execute("INSERT OR IGNORE INTO item_aliases (item_id, alias) VALUES (?, ?)", (r[0], r[1]))
        if old:
            c.execute("DELETE FROM search_aliases")
            logger.info(f"  迁移 {len(old)} 条 search_aliases，已清空旧表")
    except sqlite3.OperationalError:
        logger.debug("迁移步骤3: search_aliases 表不存在，跳过")
    except Exception as e:
        logger.warning(f"迁移步骤3异常: {e}", exc_info=True)

    # 4
    try:
        old = c.execute("SELECT item_id, name_zh FROM item_name_overrides").fetchall()
        for r in old:
            c.execute("INSERT OR IGNORE INTO item_overrides (item_id, name_zh) VALUES (?, ?)", (r[0], r[1]))
        if old:
            logger.info(f"  迁移 {len(old)} 条 item_name_overrides")
    except sqlite3.OperationalError:
        logger.debug("迁移步骤4: item_name_overrides 表不存在，跳过")
    except Exception as e:
        logger.warning(f"迁移步骤4异常: {e}", exc_info=True)

    # 5
    try:
        import json
        old = c.execute("SELECT id, name, source, items, aliases FROM custom_bundles").fetchall()
        for r in old:
            c.execute("INSERT OR IGNORE INTO bundles (id, name, source) VALUES (?, ?, ?)",
                      (r["id"], r["name"], r["source"] or "manual"))
            items = json.loads(r["items"] or "[]")
            for it in items:
                c.execute("INSERT OR IGNORE INTO bundle_items (bundle_id, item_id, quantity) VALUES (?, ?, ?)",
                          (r["id"], it.get("item_id") or it.get("id"), it.get("quantity", 1)))
            try:
                aliases = json.loads(r["aliases"] or "[]")
                for alias in aliases:
                    if alias:
                        c.execute("INSERT OR IGNORE INTO bundle_aliases (bundle_id, alias) VALUES (?, ?)",
                                  (r["id"], alias))
            except Exception:
                pass
        if old:
            logger.info(f"  迁移 {len(old)} 个套餐到新表结构")
    except sqlite3.OperationalError:
        logger.debug("迁移步骤5: custom_bundles 表不存在，跳过")
    except Exception as e:
        logger.warning(f"迁移步骤5异常: {e}", exc_info=True)

    # 6
    try:
        old = c.execute("SELECT module_name, alias FROM bundle_module_aliases").fetchall()
        for r in old:
            bundle = c.execute("SELECT id FROM bundles WHERE name LIKE ?", (r["module_name"] + "%",)).fetchone()
            if bundle:
                c.execute("INSERT OR IGNORE INTO bundle_aliases (bundle_id, alias) VALUES (?, ?)",
                          (bundle["id"], r["alias"]))
        if old:
            logger.info(f"  迁移 {len(old)} 条套餐模块别名")
    except sqlite3.OperationalError:
        logger.debug("迁移步骤6: bundle_module_aliases 表不存在，跳过")
    except Exception as e:
        logger.warning(f"迁移步骤6异常: {e}", exc_info=True)

    # 7
    for table, col, typedef in [
        ("orders",      "customer_id",   "INTEGER"),
        ("orders",      "customer_name", "TEXT DEFAULT ''"),
        ("order_items", "ready",         "INTEGER DEFAULT 0"),
        ("accounts",    "sync_error",    "TEXT DEFAULT ''"),
        ("accounts",    "sync_status",   "TEXT DEFAULT 'never'"),
    ]:
        try:
            c.execute(f"ALTER TABLE {table} ADD COLUMN {col} {typedef}")
            logger.info(f"  添加列 {table}.{col}")
        except sqlite3.OperationalError:
            logger.debug(f"  列 {table}.{col} 已存在，跳过")
        except Exception as e:
            logger.warning(f"添加列 {table}.{col} 异常: {e}", exc_info=True)

    # 8 — 账号等待 Cookie 标记
    try:
        c.execute("ALTER TABLE accounts ADD COLUMN pending_cookie INTEGER DEFAULT 0")
        logger.info("  添加列 accounts.pending_cookie")
    except sqlite3.OperationalError:
        logger.debug("  列 accounts.pending_cookie 已存在，跳过")

    # 9 — 暂停自动同步
    try:
        c.execute("ALTER TABLE accounts ADD COLUMN sync_paused INTEGER DEFAULT 0")
        logger.info("  添加列 accounts.sync_paused")
    except sqlite3.OperationalError:
        logger.debug("  列 accounts.sync_paused 已存在，跳过")

    # 10 — 清理与显示名重复的别名（历史迁移遗留）
    try:
        deleted = c.execute("""
            DELETE FROM item_aliases WHERE id IN (
                SELECT a.id FROM item_aliases a
                JOIN item_overrides o ON a.item_id = o.item_id AND a.alias = o.name_zh
            )
        """).rowcount
        if deleted:
            logger.info(f"  清理了 {deleted} 条与显示名重复的别名")
    except Exception as e:
        logger.debug(f"迁移步骤10: {e}")

    # 10 — arctracker 登录凭据（自动登录用）
    for col, typedef in [("arc_email", "TEXT DEFAULT ''"), ("arc_password", "TEXT DEFAULT ''")]:
        try:
            c.execute(f"ALTER TABLE accounts ADD COLUMN {col} {typedef}")
            logger.info(f"  添加列 accounts.{col}")
        except sqlite3.OperationalError:
            logger.debug(f"  列 accounts.{col} 已存在，跳过")

    # 11 — 自动刷新时间戳（防止重复刷新）
    try:
        c.execute("ALTER TABLE accounts ADD COLUMN last_auto_refresh TEXT DEFAULT ''")
        logger.info("  添加列 accounts.last_auto_refresh")
    except sqlite3.OperationalError:
        logger.debug("  列 accounts.last_auto_refresh 已存在，跳过")

    # 12 — 套餐类型、售价、描述
    for col, typedef in [
        ("type", "TEXT DEFAULT 'item'"),
        ("price", "REAL"),
        ("description", "TEXT DEFAULT ''"),
    ]:
        try:
            c.execute(f"ALTER TABLE bundles ADD COLUMN {col} {typedef}")
            logger.info(f"  添加列 bundles.{col}")
        except sqlite3.OperationalError:
            logger.debug(f"  列 bundles.{col} 已存在，跳过")

    # 13 — 重点关注规则表
    c.execute("""
        CREATE TABLE IF NOT EXISTS account_watch_rules (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
            rule_type   TEXT NOT NULL DEFAULT 'item',
            target_id   TEXT NOT NULL DEFAULT '',
            threshold   INTEGER NOT NULL DEFAULT 1,
            created_at  TEXT DEFAULT (datetime('now'))
        )
    """)
    # 避免同一账号同一目标重复
    try:
        c.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_watch_account_target ON account_watch_rules(account_id, rule_type, target_id)")
    except sqlite3.OperationalError:
        logger.debug("  索引 idx_watch_account_target 已存在，跳过")

    # 14 — 清理孤儿监控规则（引用已删除套餐的 bundle watch rules）
    orphan = c.execute(
        "DELETE FROM account_watch_rules WHERE rule_type='bundle' "
        "AND CAST(target_id AS INTEGER) NOT IN (SELECT id FROM bundles)"
    ).rowcount
    if orphan:
        logger.info(f"  清理 {orphan} 条孤儿套餐监控规则")


if __name__ == "__main__":
    init_db()