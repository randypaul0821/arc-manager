"""
账号服务层：账号增删改查
"""
import logging
from database import get_conn

logger = logging.getLogger("account_service")


def get_all_accounts() -> list:
    logger.info("查询所有账号")
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM accounts ORDER BY name").fetchall()
        logger.info(f"查询到 {len(rows)} 个账号")
        return [dict(r) for r in rows]


def get_account(account_id: int) -> dict | None:
    logger.info(f"查询账号 id={account_id}")
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM accounts WHERE id=?", (account_id,)).fetchone()
        if row:
            logger.info(f"找到账号: {row['name']}")
        else:
            logger.warning(f"账号 id={account_id} 不存在")
        return dict(row) if row else None


def create_account(name: str, cookie: str = "", note: str = "") -> tuple[int | None, str]:
    logger.info(f"创建账号: name={name}")
    if not name.strip():
        logger.warning("创建账号失败: 名称为空")
        return None, "账号名不能为空"
    try:
        with get_conn() as conn:
            cur = conn.execute(
                "INSERT INTO accounts (name, cookie, note) VALUES (?, ?, ?)",
                (name.strip(), cookie.strip(), note.strip())
            )
            aid = cur.lastrowid
            logger.info(f"账号创建成功: id={aid}, name={name}")
            return aid, ""
    except Exception as e:
        err = "账号名已存在" if "UNIQUE" in str(e) else str(e)
        logger.error(f"创建账号异常: {err}")
        return None, err


# 允许通过 API 更新的字段白名单
_ACCOUNT_UPDATE_ALLOWED = {"name", "cookie", "note", "active", "sync_paused", "arc_email", "arc_password"}


def update_account(account_id: int, fields: dict) -> tuple[bool, str]:
    logger.info(f"更新账号 id={account_id}, fields={list(fields.keys())}")
    updates = {k: v for k, v in fields.items() if k in _ACCOUNT_UPDATE_ALLOWED}
    if not updates:
        logger.warning(f"更新账号 id={account_id} 失败: 没有可更新的字段，收到 {list(fields.keys())}")
        return False, "没有可更新的字段"
    try:
        with get_conn() as conn:
            set_clause = ", ".join(f"{k}=?" for k in updates)
            conn.execute(
                f"UPDATE accounts SET {set_clause} WHERE id=?",
                list(updates.values()) + [account_id]
            )
            logger.info(f"账号 id={account_id} 更新成功: {list(updates.keys())}")
            return True, ""
    except Exception as e:
        logger.error(f"更新账号 id={account_id} 异常", exc_info=True)
        return False, str(e)


def delete_account(account_id: int) -> bool:
    logger.info(f"删除账号 id={account_id}")
    try:
        with get_conn() as conn:
            # 手动清理关联数据（旧数据库可能缺少 ON DELETE CASCADE）
            conn.execute("DELETE FROM inventory WHERE account_id=?", (account_id,))
            conn.execute("DELETE FROM order_accounts WHERE account_id=?", (account_id,))
            conn.execute("DELETE FROM account_watch_rules WHERE account_id=?", (account_id,))
            conn.execute("DELETE FROM accounts WHERE id=?", (account_id,))
            logger.info(f"账号 id={account_id} 已删除")
        try:
            from services.auto_login import clear_profile
            clear_profile(account_id)
        except Exception:
            pass
        return True
    except Exception as e:
        logger.error(f"删除账号 id={account_id} 异常", exc_info=True)
        return False


def update_sync_status(account_id: int, status: str, error: str = "") -> None:
    logger.info(f"更新同步状态: account_id={account_id}, status={status}, error={error[:50] if error else ''}")
    from datetime import datetime
    with get_conn() as conn:
        if status == "ok":
            conn.execute(
                "UPDATE accounts SET sync_status=?, sync_error='', last_sync=? WHERE id=?",
                (status, datetime.now().isoformat(), account_id)
            )
        else:
            conn.execute(
                "UPDATE accounts SET sync_status=?, sync_error=? WHERE id=?",
                (status, error, account_id)
            )
    logger.debug(f"同步状态已更新: account_id={account_id}")


# ───────── 同步暂停 ─────────

def toggle_sync_paused(account_id: int) -> dict:
    """切换账号的自动同步暂停状态，返回新状态"""
    with get_conn() as conn:
        row = conn.execute("SELECT sync_paused FROM accounts WHERE id=?", (account_id,)).fetchone()
        if not row:
            return {"ok": False, "error": "账号不存在"}
        new_val = 0 if row["sync_paused"] else 1
        conn.execute("UPDATE accounts SET sync_paused=? WHERE id=?", (new_val, account_id))
    logger.info(f"账号 id={account_id} 自动同步{'暂停' if new_val else '恢复'}")
    return {"ok": True, "sync_paused": new_val}


# ───────── Cookie 管理 ─────────


def get_cookie_status() -> dict:
    """检查当前 Cookie 是否可能过期"""
    with get_conn() as conn:
        accounts = conn.execute(
            "SELECT id, name, sync_status, sync_error, cookie FROM accounts WHERE active=1"
        ).fetchall()
    needs_relogin = any(
        a["sync_status"] in ("error", "cookie_expired") or
        "404" in (a["sync_error"] or "") or
        not a["cookie"]
        for a in accounts
    )
    return {
        "needs_relogin": needs_relogin,
        "accounts": [
            {"id": a["id"], "name": a["name"], "status": a["sync_status"], "error": a["sync_error"]}
            for a in accounts
        ],
    }