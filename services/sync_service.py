"""
同步服务层：从游戏服务器拉取账号库存数据
"""
import time
import logging
import threading
from datetime import datetime, timedelta

import sqlite3
import requests
from database import get_conn
from config import SYNC_INTERVAL_MINUTES, SYNC_DELAY_SECONDS, SCHEDULER_INTERVAL_SECONDS, DB_PATH, AUTO_REFRESH_COOLDOWN_MINUTES
from services.account_service import update_sync_status

logger = logging.getLogger("sync_service")


# ───────── 自动刷新触发 ─────────

def _try_auto_refresh(account: dict):
    """同步失败时尝试自动触发 Playwright 刷新（有冷却期）"""
    account_id = account["id"]
    account_name = account.get("name", "unknown")
    email = (account.get("arc_email") or "").strip()
    password = (account.get("arc_password") or "").strip()

    if not email or not password:
        logger.info(f"[auto-refresh] 账号 {account_name} 未设置凭据，跳过自动刷新")
        return

    # 检查是否有 browser profile
    from services.auto_login import get_profile_dir, auto_refresh
    import os
    profile_dir = get_profile_dir(account_id)
    if not os.path.isdir(profile_dir) or not os.listdir(profile_dir):
        logger.info(f"[auto-refresh] 账号 {account_name} 无 browser profile，跳过")
        return

    # 检查冷却期
    last_refresh = (account.get("last_auto_refresh") or "").strip()
    if last_refresh:
        try:
            last_dt = datetime.fromisoformat(last_refresh)
            cooldown = timedelta(minutes=AUTO_REFRESH_COOLDOWN_MINUTES)
            if datetime.now() - last_dt < cooldown:
                logger.info(f"[auto-refresh] 账号 {account_name} 冷却期内（上次: {last_refresh}），跳过")
                return
        except ValueError:
            pass

    logger.info(f"[auto-refresh] 账号 {account_name} 同步失败，自动触发全链路刷新")
    result = auto_refresh(account_id, account_name)
    if result.get("ok"):
        logger.info(f"[auto-refresh] 账号 {account_name} 自动刷新已启动")
    else:
        logger.warning(f"[auto-refresh] 账号 {account_name} 自动刷新启动失败: {result.get('error')}")


# ───────── 单账号同步 ─────────

def sync_account(account: dict) -> bool:
    """同步单个账号库存，返回是否成功"""
    account_id = account["id"]
    account_name = account.get("name", "unknown")
    cookie     = account.get("cookie", "").strip()
    logger.info(f"[sync] 开始同步账号: id={account_id}, name={account_name}")

    if not cookie:
        logger.warning(f"[sync] 账号 {account_name} Cookie 为空，跳过")
        update_sync_status(account_id, "error", "Cookie 为空")
        return False

    update_sync_status(account_id, "syncing")
    logger.debug(f"[sync] 账号 {account_name} 状态更新为 syncing")

    try:
        logger.debug(f"[sync] 发送 HTTP 请求...")
        resp = requests.post(
            "https://arctracker.io/api/embark/sync/inventory",
            headers={
                "Cookie": cookie,
                "User-Agent": "Mozilla/5.0",
                "Accept": "application/json",
            },
            timeout=15
        )
        logger.debug(f"[sync] HTTP 响应: status={resp.status_code}, len={len(resp.content)}")
    except requests.Timeout:
        logger.error(f"[sync] 账号 {account_name} 请求超时")
        update_sync_status(account_id, "timeout", "请求超时")
        return False
    except Exception as e:
        logger.error(f"[sync] 账号 {account_name} 请求异常", exc_info=True)
        update_sync_status(account_id, "error", str(e))
        return False

    if resp.status_code == 401:
        logger.warning(f"[sync] 账号 {account_name} Cookie 已过期 (401)")
        update_sync_status(account_id, "cookie_expired", "Cookie 已过期，请重新登录")
        _try_auto_refresh(account)
        return False
    if resp.status_code != 200:
        try:
            body = resp.text[:500]
        except Exception:
            body = "(无法读取)"
        logger.error(f"[sync] 账号 {account_name} 服务器返回 {resp.status_code}, body: {body}")
        # 500 可能是 Steam 绑定失效，自动刷新会重新绑定 Steam
        if resp.status_code == 500:
            update_sync_status(account_id, "error", "同步失败，尝试重新绑定")
            _try_auto_refresh(account)
        else:
            update_sync_status(account_id, "error", f"服务器返回 {resp.status_code}")
        return False

    try:
        data = resp.json()
        items_count = len(data.get("items", []))
        logger.info(f"[sync] 账号 {account_name} 收到 {items_count} 个物品")
        _save_inventory(account_id, data)
        update_sync_status(account_id, "ok")
        logger.info(f"[sync] 账号 {account_name} 同步成功")
        return True
    except Exception as e:
        logger.error(f"[sync] 账号 {account_name} 数据解析/保存失败", exc_info=True)
        update_sync_status(account_id, "error", f"数据解析失败: {e}")
        return False


def _save_inventory(account_id: int, data: dict) -> None:
    """将同步数据写入库存表（原子操作：DELETE + INSERT 在同一事务中）"""
    items    = data.get("items", [])
    now      = datetime.now().isoformat()
    used     = data.get("totalItems", len(items))
    max_s    = data.get("maxSlots", 0)
    currencies = data.get("currencies", {})
    credits  = currencies.get("credits", 0) if isinstance(currencies, dict) else data.get("credits", 0)

    logger.debug(f"[save] account_id={account_id}, items={len(items)}, slots={used}/{max_s}, credits={credits}")

    with get_conn() as conn:
        conn.execute("DELETE FROM inventory WHERE account_id=?", (account_id,))
        inserted = 0
        skipped  = 0
        for item in items:
            item_id    = item.get("itemId") or item.get("id", "")
            quantity   = item.get("quantity", 1)
            slot       = item.get("slotIndex") or item.get("slot")
            durability = item.get("durabilityPercent") or item.get("durability")
            if not item_id:
                skipped += 1
                continue
            conn.execute(
                "INSERT INTO inventory (account_id, item_id, quantity, slot, durability, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (account_id, item_id, quantity, slot, durability, now)
            )
            inserted += 1
        conn.execute(
            "UPDATE accounts SET used_slots=?, max_slots=?, credits=? WHERE id=?",
            (used, max_s, credits, account_id)
        )
        logger.info(f"[save] account_id={account_id}: 写入 {inserted} 条, 跳过 {skipped} 条")


# ───────── 批量同步 ─────────

def sync_accounts(account_ids: list[int]) -> dict:
    logger.info(f"[batch] 批量同步 {len(account_ids)} 个账号: {account_ids}")
    results = {}
    with get_conn() as conn:
        accounts = conn.execute(
            f"SELECT * FROM accounts WHERE id IN ({','.join('?'*len(account_ids))})",
            account_ids
        ).fetchall()
        accounts = [dict(a) for a in accounts]

    logger.info(f"[batch] 实际查到 {len(accounts)} 个账号")
    for i, acc in enumerate(accounts):
        if i > 0:
            logger.debug(f"[batch] 等待 {SYNC_DELAY_SECONDS} 秒...")
            time.sleep(SYNC_DELAY_SECONDS)
        ok = sync_account(acc)
        results[acc["id"]] = "ok" if ok else "error"

    logger.info(f"[batch] 批量同步完成: {results}")
    return results


def sync_all_active(force: bool = False) -> dict:
    """同步所有激活账号。force=True 时忽略 sync_paused（手动全量同步用）"""
    if force:
        logger.info("[sync_all] 强制同步所有激活账号（忽略暂停）")
        sql = "SELECT id FROM accounts WHERE active=1"
    else:
        logger.info("[sync_all] 同步所有激活账号（跳过暂停）")
        sql = "SELECT id FROM accounts WHERE active=1 AND sync_paused=0"
    with get_conn() as conn:
        accounts = conn.execute(sql).fetchall()
        ids = [r["id"] for r in accounts]
    logger.info(f"[sync_all] 待同步: {len(ids)} 个")
    return sync_accounts(ids) if ids else {}


# ───────── 定时任务 ─────────

_scheduler_thread: threading.Thread | None = None
_scheduler_running = False
_scheduler_lock = threading.Lock()

# 定时任务间隔常量（基于 SCHEDULER_INTERVAL_SECONDS 的倍数）
_CLEANUP_EVERY = 12    # ~1小时执行一次订单清理
_BACKUP_EVERY  = 288   # ~24小时执行一次数据库备份


def start_scheduler():
    global _scheduler_thread, _scheduler_running
    with _scheduler_lock:
        if _scheduler_running:
            logger.warning("定时同步已在运行，跳过重复启动")
            return
        _scheduler_running = True
        _scheduler_thread = threading.Thread(target=_scheduler_loop, daemon=True)
        _scheduler_thread.start()
    logger.info(f"定时同步已启动（每 {SCHEDULER_INTERVAL_SECONDS}s 检查，{SYNC_INTERVAL_MINUTES}min 未更新则触发）")
    print(f"  定时同步已启动（每{SCHEDULER_INTERVAL_SECONDS//60}分钟检查，{SYNC_INTERVAL_MINUTES}分钟未更新则触发）")


def stop_scheduler():
    global _scheduler_running
    with _scheduler_lock:
        _scheduler_running = False
    logger.info("定时同步已停止")


def _scheduler_loop():
    logger.debug("[scheduler] 定时线程已启动")
    _cleanup_counter = 0
    _backup_counter = 0
    while _scheduler_running:
        try:
            _check_and_sync()
            _cleanup_counter += 1
            if _cleanup_counter >= _CLEANUP_EVERY:
                _cleanup_counter = 0
                try:
                    from services.order_service import cleanup_old_orders
                    from config import ORDER_CLEANUP_DAYS
                    cleanup_old_orders(days=ORDER_CLEANUP_DAYS)
                except Exception as e:
                    logger.error("[scheduler] 订单清理出错", exc_info=True)
            _backup_counter += 1
            if _backup_counter >= _BACKUP_EVERY:
                _backup_counter = 0
                _backup_database()
        except Exception as e:
            logger.error("[scheduler] 检查同步出错", exc_info=True)
        time.sleep(SCHEDULER_INTERVAL_SECONDS)
    logger.debug("[scheduler] 定时线程已退出")


def _backup_database():
    """使用 SQLite 内置 backup API 备份数据库（原子、不锁表）"""
    backup_path = DB_PATH + ".bak"
    src = dst = None
    try:
        src = sqlite3.connect(DB_PATH)
        dst = sqlite3.connect(backup_path)
        src.backup(dst)
        logger.info(f"[scheduler] 数据库已备份到 {backup_path}")
    except Exception:
        logger.error("[scheduler] 数据库备份失败", exc_info=True)
    finally:
        if dst:
            dst.close()
        if src:
            src.close()


def _check_and_sync():
    threshold = (datetime.now() - timedelta(minutes=SYNC_INTERVAL_MINUTES)).isoformat()
    with get_conn() as conn:
        accounts = conn.execute(
            "SELECT * FROM accounts WHERE active=1 AND sync_paused=0 "
            "AND (last_sync IS NULL OR last_sync < ?)",
            (threshold,)
        ).fetchall()
        accounts = [dict(a) for a in accounts]

    if not accounts:
        logger.debug("[scheduler] 没有需要同步的账号")
        return

    logger.info(f"[scheduler] 发现 {len(accounts)} 个账号需要更新")
    for i, acc in enumerate(accounts):
        if not _scheduler_running:
            logger.info("[scheduler] 收到停止信号，终止同步")
            break
        if i > 0:
            time.sleep(SYNC_DELAY_SECONDS)
        logger.info(f"[scheduler] 同步账号「{acc['name']}」...")
        sync_account(acc)


