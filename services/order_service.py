"""
订单服务层：订单 CRUD、参与账号、价格管理
"""
import logging
from datetime import datetime
from database import get_conn
from services.item_service import load_display_names, load_english_names
from services.customer_service import get_or_create_customer

logger = logging.getLogger("order_service")


# ───────── 查询 ─────────

def get_orders(status: str = "", customer_id: int = 0,
               days: int = 0, limit: int = 100) -> list:
    logger.info(f"查询订单列表: status='{status}', customer_id={customer_id}, days={days}, limit={limit}")
    with get_conn() as conn:
        where  = []
        params = []
        if status:
            # 'archived' 是前端虚拟状态，实际包含 cancelled + deleted
            if status == 'archived':
                where.append("status IN ('cancelled','deleted')")
            else:
                where.append("status=?")
                params.append(status)
        if customer_id:
            where.append("customer_id=?")
            params.append(customer_id)
        if days:
            # 自然天：days=1表示今天，days=3表示最近3天（含今天）
            date_col = "completed_at" if status == "completed" else "created_at"
            if days == 1:
                where.append(f"date({date_col}) >= date('now', 'localtime')")
            else:
                where.append(f"date({date_col}) >= date('now', 'localtime', ?)")
                params.append(f"-{days - 1} days")
        sql = "SELECT * FROM orders"
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY COALESCE(completed_at, created_at) DESC LIMIT ?"
        params.append(limit)
        logger.debug(f"SQL: {sql}, params: {params}")
        rows = conn.execute(sql, params).fetchall()

        order_ids = [r["id"] for r in rows]
        items_map: dict = {oid: [] for oid in order_ids}
        if order_ids:
            placeholders = ",".join("?" * len(order_ids))
            item_rows = conn.execute(
                f"SELECT * FROM order_items WHERE order_id IN ({placeholders})",
                order_ids
            ).fetchall()
            for it in item_rows:
                items_map[it["order_id"]].append(dict(it))
            logger.debug(f"订单物品: {len(item_rows)} 行")

        inv_rows = conn.execute(
            "SELECT i.item_id, SUM(i.quantity) as total "
            "FROM inventory i JOIN accounts a ON i.account_id=a.id "
            "WHERE a.active=1 GROUP BY i.item_id"
        ).fetchall()
        inv_map = {r["item_id"]: r["total"] for r in inv_rows}

        # 加载套餐名称和别名
        all_items = [it for its in items_map.values() for it in its]
        bundle_ids = []
        for it in all_items:
            iid = it.get("item_id", "")
            if iid.startswith("__bundle__"):
                try: bundle_ids.append(int(iid.replace("__bundle__", "")))
                except (ValueError, TypeError): pass
        bundle_info = {}
        if bundle_ids:
            bp = ','.join('?' * len(bundle_ids))
            brows = conn.execute(f"SELECT id, name FROM bundles WHERE id IN ({bp})", bundle_ids).fetchall()
            for r in brows:
                bundle_info[f"__bundle__{r['id']}"] = {"name": r["name"], "alias": ""}
            arows = conn.execute(f"SELECT bundle_id, alias FROM bundle_aliases WHERE bundle_id IN ({bp})", bundle_ids).fetchall()
            for a in arows:
                key = f"__bundle__{a['bundle_id']}"
                if key in bundle_info and not bundle_info[key]["alias"]:
                    bundle_info[key]["alias"] = a["alias"]

    names = load_display_names()
    en_names = load_english_names()
    result = []
    for r in rows:
        oid   = r["id"]
        items = items_map.get(oid, [])
        enriched = []
        for it in items:
            iid     = it.get("item_id", "")
            need    = it.get("quantity", 0)
            have    = inv_map.get(iid, 0)
            shortage = max(0, need - have)
            is_bundle = iid.startswith("__bundle__")
            if is_bundle:
                bi = bundle_info.get(iid, {})
                b_alias = bi.get("alias", "")
                b_name  = bi.get("name", iid)
                enriched.append({
                    **it,
                    "name_zh": b_alias or b_name,
                    "name_en": b_name if b_alias else "",
                    "is_bundle": True,
                    "have": have, "shortage": shortage,
                })
            else:
                enriched.append({
                    **it,
                    "name_zh": names.get(iid, it.get("raw_name", iid)),
                    "name_en": en_names.get(iid, ""),
                    "is_bundle": False,
                    "have": have, "shortage": shortage,
                })
        enriched.sort(key=lambda x: (0 if x["shortage"] > 0 else 1, x["shortage"] * -1))
        result.append({**dict(r), "items": enriched})

    logger.info(f"查询到 {len(result)} 个订单")
    return result


def get_order(order_id: int) -> dict | None:
    logger.info(f"查询订单详情: id={order_id}")
    with get_conn() as conn:
        order = conn.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone()
        if not order:
            logger.warning(f"订单不存在: id={order_id}")
            return None

        items = conn.execute(
            "SELECT * FROM order_items WHERE order_id=?", (order_id,)
        ).fetchall()
        accounts = conn.execute(
            "SELECT a.id, a.name FROM order_accounts oa "
            "JOIN accounts a ON oa.account_id=a.id WHERE oa.order_id=?",
            (order_id,)
        ).fetchall()

        # 加载套餐名称和别名（给 __bundle__ 类型的订单行用）
        bundle_ids = [int(it["item_id"].replace("__bundle__", ""))
                      for it in items if it["item_id"].startswith("__bundle__")]
        bundle_info = {}  # {__bundle__N: {name, alias}}
        if bundle_ids:
            placeholders = ','.join('?' * len(bundle_ids))
            brows = conn.execute(
                f"SELECT id, name FROM bundles WHERE id IN ({placeholders})", bundle_ids
            ).fetchall()
            for r in brows:
                bundle_info[f"__bundle__{r['id']}"] = {"name": r["name"], "alias": ""}
            # 取每个套餐的第一个别名作为中文显示名
            arows = conn.execute(
                f"SELECT bundle_id, alias FROM bundle_aliases WHERE bundle_id IN ({placeholders})",
                bundle_ids
            ).fetchall()
            for a in arows:
                key = f"__bundle__{a['bundle_id']}"
                if key in bundle_info and not bundle_info[key]["alias"]:
                    bundle_info[key]["alias"] = a["alias"]

    names = load_display_names()
    en_names = load_english_names()
    logger.info(f"订单 id={order_id}: {len(items)} 个物品, {len(accounts)} 个关联账号")

    enriched = []
    for it in items:
        iid = it["item_id"]
        is_bundle = iid.startswith("__bundle__")
        if is_bundle:
            bi = bundle_info.get(iid, {})
            # 别名作为中文名，套餐原名作为英文名
            b_alias = bi.get("alias", "")
            b_name  = bi.get("name", iid)
            enriched.append({
                **dict(it),
                "name_zh":   b_alias or b_name,
                "name_en":   b_name if b_alias else "",
                "is_bundle": True,
            })
        else:
            enriched.append({
                **dict(it),
                "name_zh":   names.get(iid, iid),
                "name_en":   en_names.get(iid, ""),
                "is_bundle": False,
            })

    return {
        **dict(order),
        "items": enriched,
        "accounts": [{"id": r["id"], "name": r["name"]} for r in accounts],
    }


# ───────── 创建 ─────────

def create_order(items: list, raw_text: str = "",
                 customer_name: str = "") -> tuple[int | None, str]:
    logger.info(f"创建订单: {len(items)} 个物品, customer_name='{customer_name}'")
    if not items:
        return None, "订单必须包含至少一个物品"

    now = datetime.now().isoformat()

    customer_id = None
    if customer_name.strip():
        customer_id = get_or_create_customer(customer_name.strip())
        logger.debug(f"客户 id={customer_id}")

    try:
        with get_conn() as conn:
            # 加载已有物品价格，自动继承
            price_rows = conn.execute(
                "SELECT item_id, cost_price, sell_price FROM item_prices"
            ).fetchall()
            saved_prices = {r["item_id"]: (r["cost_price"] or 0, r["sell_price"] or 0) for r in price_rows}

            # 给每个物品填充价格 + 清洗脏数据
            for it in items:
                iid = it["item_id"]
                if it.get("cost_price", 0) == 0 and it.get("sell_price", 0) == 0:
                    cp, sp = saved_prices.get(iid, (0, 0))
                    it["cost_price"] = cp
                    it["sell_price"] = sp
                # 防御：成本价高于售价 → 清空成本（之前测试遗留的脏数据）
                cp = it.get("cost_price", 0) or 0
                sp = it.get("sell_price", 0) or 0
                if cp > 0 and sp > 0 and cp > sp:
                    logger.info(f"清空异常成本价 item={iid}: cost={cp} > sell={sp}")
                    it["cost_price"] = 0

            total_cost    = sum(i.get("cost_price", 0) * i.get("quantity", 1) for i in items)
            total_revenue = sum(i.get("sell_price", 0) * i.get("quantity", 1) for i in items)

            cur = conn.execute(
                "INSERT INTO orders (customer_id, customer_name, raw_text, "
                "total_cost, total_revenue, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (customer_id, customer_name.strip(), raw_text,
                 total_cost, total_revenue, now)
            )
            order_id = cur.lastrowid
            for it in items:
                conn.execute(
                    "INSERT INTO order_items (order_id, item_id, raw_name, quantity, "
                    "cost_price, sell_price) VALUES (?, ?, ?, ?, ?, ?)",
                    (order_id, it["item_id"], it.get("raw_name", ""),
                     it["quantity"], it.get("cost_price", 0), it.get("sell_price", 0))
                )
                # 把本订单的有效价格固化到 item_prices 表（同时清掉旧的脏成本）
                # 仅当传入的价格和历史不同 / 新清洗了成本才更新
                final_cp = it.get("cost_price", 0) or 0
                final_sp = it.get("sell_price", 0) or 0
                old_cp, old_sp = saved_prices.get(it["item_id"], (0, 0))
                if (final_cp != old_cp) or (final_sp != old_sp):
                    conn.execute(
                        "INSERT INTO item_prices (item_id, cost_price, sell_price, updated_at) "
                        "VALUES (?, ?, ?, datetime('now')) "
                        "ON CONFLICT(item_id) DO UPDATE SET "
                        "cost_price=excluded.cost_price, "
                        "sell_price=excluded.sell_price, "
                        "updated_at=excluded.updated_at",
                        (it["item_id"], final_cp, final_sp),
                    )
            logger.info(f"订单创建成功: id={order_id}, cost={total_cost}, revenue={total_revenue}")

        # ── 订单确认即认可：把每个匹配结果自动写成别名 ──
        # 下次同样原文会直接命中 search_aliases 精确返回，绕过模糊匹配和 AI
        _auto_create_aliases_from_order(items)

        return order_id, ""
    except Exception as e:
        logger.error("创建订单异常", exc_info=True)
        return None, str(e)


def _auto_create_aliases_from_order(items: list) -> None:
    """
    订单确认后，把 raw_name → item_id 的映射固化为别名。
    规则：
    - 只处理单品（套餐有自己的 bundle_aliases）
    - raw_name 经过归一（剥 "ARC Raiders：" 前缀、去括号等）
    - 跳过空名、< 2 字符、纯数字、已和显示名/英文名完全相同的
    - 已存在的别名静默跳过（UNIQUE 冲突）
    - 任何异常都吞掉，绝不影响订单主流程
    """
    try:
        from services.match_service import _normalize_raw_name
        from services.item_service import (
            add_alias, load_display_names, load_english_names, load_search_aliases,
        )
        display_names = load_display_names()
        english_names = load_english_names()
        existing = load_search_aliases()  # {alias_lower: item_id}

        for it in items:
            if it.get("is_bundle"):
                continue
            iid = (it.get("item_id") or "").strip()
            raw = (it.get("raw_name") or "").strip()
            if not iid or not raw:
                continue

            norm = _normalize_raw_name(raw)
            if not norm or len(norm) < 2 or norm.isdigit():
                continue

            disp = (display_names.get(iid) or "").strip()
            en   = (english_names.get(iid) or "").strip()
            if norm == disp or norm.lower() == en.lower():
                continue

            # 已经是该物品或别的物品的别名 → 跳过（避免覆盖用户手动设置的映射）
            if norm.lower() in existing:
                continue

            ok, err = add_alias(iid, norm)
            if ok:
                logger.info(f"订单确认自动加别名: {iid} ← {norm}")
                existing[norm.lower()] = iid  # 同一订单内防重复插入
            else:
                logger.debug(f"自动别名跳过: {iid} ← {norm} ({err})")
    except Exception as e:
        logger.warning(f"自动别名处理异常（不影响订单创建）: {e}")


# ───────── 更新 ─────────

_ORDER_UPDATE_ALLOWED = {"customer_name", "status", "total_cost", "total_revenue"}


def update_order(order_id: int, fields: dict) -> tuple[bool, str]:
    logger.info(f"更新订单: id={order_id}, fields={list(fields.keys())}")
    updates = {k: v for k, v in fields.items() if k in _ORDER_UPDATE_ALLOWED}

    if "customer_name" in updates and updates["customer_name"].strip():
        cid = get_or_create_customer(updates["customer_name"].strip())
        updates["customer_id"] = cid
        logger.debug(f"关联客户: id={cid}")

    if not updates:
        logger.warning(f"更新订单 id={order_id} 失败: 没有可更新的字段")
        return False, "没有可更新的字段"

    safe_keys = _ORDER_UPDATE_ALLOWED | {"customer_id"}
    if not all(k in safe_keys for k in updates):
        raise ValueError(f"非法列名: {set(updates) - safe_keys}")

    try:
        with get_conn() as conn:
            set_clause = ", ".join(f"{k}=?" for k in updates)
            conn.execute(
                f"UPDATE orders SET {set_clause} WHERE id=?",
                list(updates.values()) + [order_id]
            )
            logger.info(f"订单 id={order_id} 更新成功")
            return True, ""
    except Exception as e:
        logger.error(f"更新订单 id={order_id} 异常", exc_info=True)
        return False, str(e)


def update_order_item_ready(item_id: int, ready: int) -> bool:
    logger.info(f"切换 order_item ready: item_id={item_id}, ready={ready}")
    try:
        with get_conn() as conn:
            conn.execute("UPDATE order_items SET ready=? WHERE id=?", (ready, item_id))
            return True
    except Exception as e:
        logger.error(f"切换 ready 失败 item_id={item_id}", exc_info=True)
        return False


def update_order_item_price(item_id: int, cost_price, sell_price) -> bool:
    """更新订单行的成本价和售价，并联动更新订单总价和全局物品价格表"""
    logger.info(f"更新 order_item 价格: item_id={item_id}, cost={cost_price}, sell={sell_price}")
    try:
        with get_conn() as conn:
            sets, vals = [], []
            if cost_price is not None:
                sets.append("cost_price=?")
                vals.append(float(cost_price))
            if sell_price is not None:
                sets.append("sell_price=?")
                vals.append(float(sell_price))
            if not sets:
                return False
            vals.append(item_id)
            conn.execute(f"UPDATE order_items SET {','.join(sets)} WHERE id=?", vals)

            # 同步到全局物品价格表（下次订单自动继承）
            oi_row = conn.execute(
                "SELECT item_id, cost_price, sell_price FROM order_items WHERE id=?", (item_id,)
            ).fetchone()
            if oi_row:
                iid = oi_row["item_id"]
                cp  = oi_row["cost_price"] or 0
                sp  = oi_row["sell_price"] or 0
                conn.execute(
                    "INSERT INTO item_prices (item_id, cost_price, sell_price, updated_at) "
                    "VALUES (?, ?, ?, datetime('now')) "
                    "ON CONFLICT(item_id) DO UPDATE SET cost_price=excluded.cost_price, "
                    "sell_price=excluded.sell_price, updated_at=excluded.updated_at",
                    (iid, cp, sp)
                )

            # 联动：重新汇总订单总价
            order_row = conn.execute(
                "SELECT order_id FROM order_items WHERE id=?", (item_id,)
            ).fetchone()
            if order_row:
                oid = order_row["order_id"]
                totals = conn.execute(
                    "SELECT COALESCE(SUM(cost_price * quantity), 0) as tc, "
                    "COALESCE(SUM(sell_price * quantity), 0) as tr "
                    "FROM order_items WHERE order_id=?", (oid,)
                ).fetchone()
                conn.execute(
                    "UPDATE orders SET total_cost=?, total_revenue=? WHERE id=?",
                    (totals["tc"], totals["tr"], oid)
                )
                logger.info(f"订单 #{oid} 总价已联动更新: cost={totals['tc']}, revenue={totals['tr']}")
            return True
    except Exception as e:
        logger.error("更新 order_item 价格失败", exc_info=True)
        return False


def replace_order_item(oi_id: int, new_item_id: str) -> bool:
    """替换订单行的物品（item_id），保留数量和价格"""
    logger.info(f"替换 order_item: oi_id={oi_id}, new_item_id={new_item_id}")
    try:
        with get_conn() as conn:
            conn.execute(
                "UPDATE order_items SET item_id=? WHERE id=?",
                (new_item_id, oi_id)
            )
            logger.info(f"order_item {oi_id} 物品已替换为 {new_item_id}")
            return True
    except Exception as e:
        logger.error("替换 order_item 失败", exc_info=True)
        return False


def rematch_order_item(oi_id: int) -> dict:
    """用 raw_name 重新跑匹配算法，返回匹配结果（不自动替换）"""
    logger.info(f"重新匹配 order_item: oi_id={oi_id}")
    with get_conn() as conn:
        row = conn.execute(
            "SELECT id, item_id, raw_name, quantity FROM order_items WHERE id=?",
            (oi_id,)
        ).fetchone()
    if not row:
        return {"error": "订单行不存在"}

    raw_name = row["raw_name"] or ""
    qty      = row["quantity"] or 1
    if not raw_name:
        return {"error": "没有原始名称，无法重新匹配"}

    from services.match_service import _match_single_item
    result = _match_single_item(raw_name, qty)
    logger.info(f"重新匹配结果: raw='{raw_name}' → matched={result['matched']['name_zh'] if result.get('matched') else 'None'}")
    return result


# ───────── 完成 / 取消 ─────────

def complete_order(order_id: int, sync_account_ids: list = None) -> tuple[bool, str]:
    logger.info(f"[complete] 尝试完成订单 #{order_id}, sync_accounts={sync_account_ids}")
    now = datetime.now().isoformat()
    try:
        with get_conn() as conn:
            order = conn.execute("SELECT id, status FROM orders WHERE id=?", (order_id,)).fetchone()
            if not order:
                logger.warning(f"[complete] 订单 #{order_id} 不存在")
                return False, f"订单 #{order_id} 不存在"
            if order["status"] != "pending":
                logger.warning(f"[complete] 订单 #{order_id} 状态为 {order['status']}，无法完成")
                return False, f"订单状态为 {order['status']}，只有待处理订单可以完成"

            conn.execute(
                "UPDATE orders SET status='completed', completed_at=? WHERE id=?",
                (now, order_id)
            )
            logger.info(f"[complete] 订单 #{order_id} 已标记为完成")

            # 同步参与账号
            acc_ids = list(sync_account_ids) if sync_account_ids else []

            # 如果前端没传，后端兜底：查询订单物品涉及哪些账号有库存
            if not acc_ids:
                oi_rows = conn.execute(
                    "SELECT item_id FROM order_items WHERE order_id=?", (order_id,)
                ).fetchall()
                # 展开套餐为子物品
                real_item_ids = []
                for r in oi_rows:
                    iid = r["item_id"]
                    if iid.startswith("__bundle__"):
                        bid = int(iid.replace("__bundle__", ""))
                        comps = conn.execute(
                            "SELECT item_id FROM bundle_items WHERE bundle_id=?", (bid,)
                        ).fetchall()
                        real_item_ids.extend(c["item_id"] for c in comps)
                    else:
                        real_item_ids.append(iid)
                if real_item_ids:
                    placeholders = ",".join("?" * len(real_item_ids))
                    acc_rows = conn.execute(
                        f"SELECT DISTINCT i.account_id FROM inventory i "
                        f"JOIN accounts a ON i.account_id=a.id "
                        f"WHERE a.active=1 AND a.sync_paused=0 AND i.item_id IN ({placeholders})",
                        real_item_ids
                    ).fetchall()
                    acc_ids = [r["account_id"] for r in acc_rows]

        if acc_ids:
            import threading
            from services.sync_service import sync_accounts
            logger.info(f"[complete] 触发参与账号同步: {acc_ids}")
            threading.Thread(target=sync_accounts, args=(acc_ids,), daemon=True).start()
        else:
            logger.info(f"[complete] 无参与账号，跳过同步")

        return True, len(acc_ids)
    except Exception as e:
        logger.error(f"[complete] 订单 #{order_id} 异常", exc_info=True)
        return False, str(e)


def cancel_order(order_id: int) -> bool:
    logger.info(f"[cancel] 尝试取消订单 #{order_id}")
    try:
        with get_conn() as conn:
            order = conn.execute("SELECT id, status FROM orders WHERE id=?", (order_id,)).fetchone()
            if not order:
                logger.warning(f"[cancel] 订单 #{order_id} 不存在")
                return False
            logger.info(f"[cancel] 订单 #{order_id} 当前状态: {order['status']}")
            conn.execute("UPDATE orders SET status='cancelled' WHERE id=?", (order_id,))
        logger.info(f"[cancel] 订单 #{order_id} 已取消")
        return True
    except Exception as e:
        logger.error(f"[cancel] 订单 #{order_id} 异常", exc_info=True)
        return False


def delete_order(order_id: int) -> bool:
    """软删除：将订单状态设为 deleted（7天后由定时任务彻底清除）"""
    logger.info(f"[delete] 软删除订单 #{order_id}")
    try:
        with get_conn() as conn:
            order = conn.execute("SELECT id, status FROM orders WHERE id=?", (order_id,)).fetchone()
            if not order:
                logger.warning(f"[delete] 订单 #{order_id} 不存在")
                return True
            logger.info(f"[delete] 订单 #{order_id} 当前状态={order['status']}，标记为 deleted")
            conn.execute(
                "UPDATE orders SET status='deleted', completed_at=COALESCE(completed_at, datetime('now')) WHERE id=?",
                (order_id,)
            )
        logger.info(f"[delete] 订单 #{order_id} 已软删除")
        return True
    except Exception as e:
        logger.error(f"[delete] 订单 #{order_id} 异常", exc_info=True)
        return False


def cleanup_old_orders(days: int = 7) -> int:
    """彻底删除 N 天前状态为 cancelled 或 deleted 的订单"""
    logger.info(f"[cleanup] 清理 {days} 天前的已取消/已删除订单...")
    try:
        with get_conn() as conn:
            old = conn.execute(
                "SELECT id FROM orders WHERE status IN ('cancelled','deleted') "
                "AND COALESCE(completed_at, created_at) < datetime('now', ?)",
                (f"-{days} days",)
            ).fetchall()
            if not old:
                logger.info("[cleanup] 没有需要清理的订单")
                return 0
            ids = [r["id"] for r in old]
            placeholders = ','.join('?' * len(ids))
            conn.execute(f"DELETE FROM order_items WHERE order_id IN ({placeholders})", ids)
            conn.execute(f"DELETE FROM order_accounts WHERE order_id IN ({placeholders})", ids)
            conn.execute(f"DELETE FROM orders WHERE id IN ({placeholders})", ids)
            logger.info(f"[cleanup] 已彻底删除 {len(ids)} 个订单: {ids}")
            return len(ids)
    except Exception as e:
        logger.error("[cleanup] 清理订单异常", exc_info=True)
        return 0


# ───────── 参与账号 ─────────

def set_order_accounts(order_id: int, account_ids: list[int]) -> bool:
    logger.info(f"设置订单关联账号: order_id={order_id}, account_ids={account_ids}")
    try:
        with get_conn() as conn:
            conn.execute("DELETE FROM order_accounts WHERE order_id=?", (order_id,))
            for aid in account_ids:
                conn.execute(
                    "INSERT INTO order_accounts (order_id, account_id) VALUES (?, ?)",
                    (order_id, aid)
                )
            logger.info(f"订单 id={order_id} 关联了 {len(account_ids)} 个账号")
            return True
    except Exception as e:
        logger.error(f"设置订单账号失败 order_id={order_id}", exc_info=True)
        return False


def suggest_accounts(order_id: int) -> list:
    logger.info(f"推荐账号: order_id={order_id}")
    with get_conn() as conn:
        items = conn.execute(
            "SELECT item_id, quantity FROM order_items WHERE order_id=?",
            (order_id,)
        ).fetchall()
        if not items:
            logger.info(f"订单 id={order_id} 没有物品，无法推荐")
            return []

        item_ids = [r["item_id"] for r in items]
        placeholders = ','.join('?' * len(item_ids))
        inv = conn.execute(
            f"SELECT i.account_id, i.item_id, i.quantity, a.name "
            f"FROM inventory i JOIN accounts a ON i.account_id=a.id "
            f"WHERE i.item_id IN ({placeholders}) AND a.active=1",
            item_ids
        ).fetchall()

    acc_coverage: dict = {}
    for r in inv:
        aid = r["account_id"]
        if aid not in acc_coverage:
            acc_coverage[aid] = {"account_id": aid, "account_name": r["name"], "items": set()}
        acc_coverage[aid]["items"].add(r["item_id"])

    total = len(item_ids)
    result = []
    for aid, info in sorted(acc_coverage.items(), key=lambda x: -len(x[1]["items"])):
        result.append({
            "account_id":    aid,
            "account_name":  info["account_name"],
            "covered_items": len(info["items"]),
            "total_items":   total,
        })

    if result:
        result[0]["is_suggested"] = True
    logger.info(f"推荐 {len(result)} 个账号, 最佳覆盖: {result[0]['covered_items']}/{total}" if result else "无推荐")
    return result


# ───────── 价格查询 ─────────

def get_item_prices() -> dict:
    """返回所有已设价格的物品 {item_id: {cost, sell}}"""
    with get_conn() as conn:
        rows = conn.execute("SELECT item_id, cost_price, sell_price FROM item_prices").fetchall()
    return {r["item_id"]: {"cost": r["cost_price"] or 0, "sell": r["sell_price"] or 0} for r in rows}


