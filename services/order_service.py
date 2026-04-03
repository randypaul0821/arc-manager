"""
订单服务层：订单 CRUD、参与账号、备货清单
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

            # 给每个物品填充价格
            for it in items:
                iid = it["item_id"]
                if it.get("cost_price", 0) == 0 and it.get("sell_price", 0) == 0:
                    cp, sp = saved_prices.get(iid, (0, 0))
                    it["cost_price"] = cp
                    it["sell_price"] = sp

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
            logger.info(f"订单创建成功: id={order_id}, cost={total_cost}, revenue={total_revenue}")
            return order_id, ""
    except Exception as e:
        logger.error("创建订单异常", exc_info=True)
        return None, str(e)


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

        return True, ""
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


# ───────── 跨订单备货清单 ─────────

def _expand_order_items(rows, conn) -> list:
    """展开订单物品：__bundle__ 类型拆解为子物品，普通物品保持不变。
    返回 [{item_id, quantity, order_id, customer_name, bundle_group, bundle_name}, ...]
    bundle_group: None=普通物品, 'bundleName'=套餐子物品
    """
    # 收集所有需要展开的 bundle
    bundle_ids_set = set()
    for r in rows:
        iid = r["item_id"]
        if iid.startswith("__bundle__"):
            try: bundle_ids_set.add(int(iid.replace("__bundle__", "")))
            except (ValueError, TypeError): pass

    # 批量查 bundle 组件
    bundle_components = {}  # {bundle_id: [{item_id, quantity}]}
    bundle_names = {}       # {bundle_id: name}
    bundle_aliases = {}     # {bundle_id: alias}
    bundle_types = {}       # {bundle_id: type}
    if bundle_ids_set:
        bids = list(bundle_ids_set)
        bp = ','.join('?' * len(bids))
        for b in conn.execute(f"SELECT id, name, type FROM bundles WHERE id IN ({bp})", bids).fetchall():
            bundle_names[b["id"]] = b["name"]
            bundle_types[b["id"]] = b["type"] or "item"
            bundle_components[b["id"]] = []
        for bi in conn.execute(
            f"SELECT bundle_id, item_id, MAX(quantity) as quantity FROM bundle_items "
            f"WHERE bundle_id IN ({bp}) GROUP BY bundle_id, item_id", bids
        ).fetchall():
            bundle_components[bi["bundle_id"]].append({"item_id": bi["item_id"], "quantity": bi["quantity"]})
        for a in conn.execute(f"SELECT bundle_id, alias FROM bundle_aliases WHERE bundle_id IN ({bp})", bids).fetchall():
            if a["bundle_id"] not in bundle_aliases:
                bundle_aliases[a["bundle_id"]] = a["alias"]

    # 展开
    expanded = []
    for r in rows:
        iid = r["item_id"]
        if iid.startswith("__bundle__"):
            try: bid = int(iid.replace("__bundle__", ""))
            except (ValueError, TypeError): continue
            comps = bundle_components.get(bid, [])
            bname = bundle_aliases.get(bid, bundle_names.get(bid, iid))
            btype = bundle_types.get(bid, "item")
            order_qty = r["quantity"]  # 套餐数量（组数）
            if btype == "service":
                # 纯服务套餐无物品，保留为套餐行不展开
                expanded.append({
                    "item_id":       iid,
                    "quantity":      order_qty,
                    "order_id":      r["order_id"],
                    "customer_name": r["customer_name"],
                    "bundle_group":  bname,
                    "bundle_id":     bid,
                    "is_service":    True,
                })
                continue
            for comp in comps:
                expanded.append({
                    "item_id":       comp["item_id"],
                    "quantity":      comp["quantity"] * order_qty,
                    "order_id":      r["order_id"],
                    "customer_name": r["customer_name"],
                    "bundle_group":  bname,
                    "bundle_id":     bid,
                })
        else:
            expanded.append({
                "item_id":       iid,
                "quantity":      r["quantity"],
                "order_id":      r["order_id"],
                "customer_name": r["customer_name"],
                "bundle_group":  None,
                "bundle_id":     None,
            })
    return expanded


def get_shortage_list() -> list:
    logger.info("计算跨订单补货清单...")
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT oi.item_id, oi.quantity, oi.order_id, o.customer_name "
            "FROM order_items oi "
            "JOIN orders o ON oi.order_id=o.id "
            "WHERE o.status='pending' AND oi.ready=0"
        ).fetchall()

        bundle_count = sum(1 for r in rows if r["item_id"].startswith("__bundle__"))
        logger.info(f"补货清单原始行: {len(rows)} 行, 其中 {bundle_count} 个套餐行")

        expanded = _expand_order_items(rows, conn)
        logger.info(f"展开后: {len(expanded)} 行")

        inv_rows = conn.execute(
            "SELECT item_id, SUM(quantity) as total "
            "FROM inventory i JOIN accounts a ON i.account_id=a.id "
            "WHERE a.active=1 GROUP BY item_id"
        ).fetchall()

        # 各账号库存明细
        acc_inv_rows = conn.execute(
            "SELECT i.item_id, i.account_id, a.name as account_name, SUM(i.quantity) as qty "
            "FROM inventory i JOIN accounts a ON i.account_id=a.id "
            "WHERE a.active=1 GROUP BY i.item_id, i.account_id"
        ).fetchall()

    inv_map = {r["item_id"]: r["total"] for r in inv_rows}

    # {item_id: [{account_id, account_name, quantity}]}
    acc_inv_map = {}
    for r in acc_inv_rows:
        acc_inv_map.setdefault(r["item_id"], []).append({
            "account_id": r["account_id"],
            "account_name": r["account_name"],
            "quantity": r["qty"],
        })
    names   = load_display_names()
    en_names = load_english_names()

    merged: dict = {}
    for r in expanded:
        iid = r["item_id"]
        if iid not in merged:
            merged[iid] = {
                "item_id":       iid,
                "name_zh":       names.get(iid, iid),
                "name_en":       en_names.get(iid, ""),
                "image_url":     f"/api/items/{iid}/image",
                "total_needed":  0,
                "current_stock": inv_map.get(iid, 0),
                "account_stocks": acc_inv_map.get(iid, []),
                "orders":        [],
                "bundle_groups": [],
                "bundle_ids":    [],
            }
        merged[iid]["total_needed"] += r["quantity"]
        if r.get("bundle_group") and r["bundle_group"] not in merged[iid]["bundle_groups"]:
            merged[iid]["bundle_groups"].append(r["bundle_group"])
        bid = r.get("bundle_id")
        if bid:
            bkey = f"__bundle__{bid}"
            if bkey not in merged[iid]["bundle_ids"]:
                merged[iid]["bundle_ids"].append(bkey)
        if not any(o["order_id"] == r["order_id"] for o in merged[iid]["orders"]):
            merged[iid]["orders"].append({
                "order_id":      r["order_id"],
                "customer_name": r["customer_name"],
                "quantity":      r["quantity"],
            })

    result = []
    for item in merged.values():
        item["shortage"] = max(0, item["total_needed"] - item["current_stock"])
        result.append(item)

    result.sort(key=lambda x: -x["shortage"])
    short_count = sum(1 for x in result if x["shortage"] > 0)
    logger.info(f"备货清单: {len(result)} 种物品, 其中 {short_count} 种缺货")
    return result


def get_instock_list() -> list:
    """跨订单存货分布：展开套餐为子物品，按套餐分组展示"""
    logger.info("计算跨订单存货分布...")
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT oi.item_id, oi.quantity, oi.order_id, o.customer_name "
            "FROM order_items oi "
            "JOIN orders o ON oi.order_id=o.id "
            "WHERE o.status='pending' AND oi.ready=0"
        ).fetchall()

        expanded = _expand_order_items(rows, conn)

        inv_rows = conn.execute(
            "SELECT i.item_id, i.quantity, a.id as account_id, a.name as account_name "
            "FROM inventory i JOIN accounts a ON i.account_id=a.id "
            "WHERE a.active=1"
        ).fetchall()

    names   = load_display_names()
    en_names = load_english_names()

    # 按物品汇总需求，记录 bundle 归属
    merged: dict = {}
    for r in expanded:
        iid = r["item_id"]
        if iid not in merged:
            merged[iid] = {
                "item_id":       iid,
                "name_zh":       names.get(iid, iid),
                "name_en":       en_names.get(iid, ""),
                "image_url":     f"/api/items/{iid}/image",
                "total_needed":  0,
                "orders":        [],
                "accounts":      [],
                "total_stock":   0,
                "bundle_groups": [],
            }
        merged[iid]["total_needed"] += r["quantity"]
        if r["bundle_group"] and r["bundle_group"] not in merged[iid]["bundle_groups"]:
            merged[iid]["bundle_groups"].append(r["bundle_group"])
        if not any(o["order_id"] == r["order_id"] for o in merged[iid]["orders"]):
            merged[iid]["orders"].append({
                "order_id":      r["order_id"],
                "customer_name": r["customer_name"],
                "quantity":      r["quantity"],
            })

    # 按物品+账号汇总库存
    acc_stock: dict = {}
    for r in inv_rows:
        iid = r["item_id"]
        if iid not in merged:
            continue
        aid = r["account_id"]
        if iid not in acc_stock:
            acc_stock[iid] = {}
        if aid not in acc_stock[iid]:
            acc_stock[iid][aid] = {"account_id": aid, "account_name": r["account_name"], "quantity": 0}
        acc_stock[iid][aid]["quantity"] += r["quantity"]

    # 组装结果
    result = []
    for iid, item in merged.items():
        accounts = sorted(acc_stock.get(iid, {}).values(), key=lambda x: -x["quantity"])
        item["accounts"] = accounts
        item["total_stock"] = sum(a["quantity"] for a in accounts)
        if item["total_stock"] > 0:
            result.append(item)

    result.sort(key=lambda x: (-x["total_stock"], x["name_zh"]))
    logger.info(f"存货分布: {len(result)} 种物品有库存")
    return result


# ───────── 价格查询 ─────────

def get_item_prices() -> dict:
    """返回所有已设价格的物品 {item_id: {cost, sell}}"""
    with get_conn() as conn:
        rows = conn.execute("SELECT item_id, cost_price, sell_price FROM item_prices").fetchall()
    return {r["item_id"]: {"cost": r["cost_price"] or 0, "sell": r["sell_price"] or 0} for r in rows}


# ───────── 统计 ─────────

def get_stats(date_from: str = "2000-01-01", date_to: str = "2099-12-31") -> dict:
    """计算指定日期范围内的订单统计数据"""
    from datetime import date as dt_date, timedelta

    logger.info(f"计算统计: from={date_from}, to={date_to}")

    with get_conn() as conn:
        orders = conn.execute("""
            SELECT id, customer_name, completed_at, total_cost, total_revenue,
                   total_revenue - total_cost as profit
            FROM orders
            WHERE status='completed'
              AND date(completed_at) >= date(?) AND date(completed_at) <= date(?)
            ORDER BY completed_at DESC
        """, (date_from, date_to)).fetchall()

        items_agg = conn.execute("""
            SELECT oi.item_id, SUM(oi.quantity) as total_qty,
                   SUM(oi.cost_price * oi.quantity) as total_cost,
                   SUM(oi.sell_price * oi.quantity) as total_revenue
            FROM order_items oi
            JOIN orders o ON oi.order_id = o.id
            WHERE o.status='completed'
              AND date(o.completed_at) >= date(?) AND date(o.completed_at) <= date(?)
            GROUP BY oi.item_id
            ORDER BY total_revenue DESC
        """, (date_from, date_to)).fetchall()

        daily_rows = conn.execute("""
            SELECT date(completed_at) as day,
                   SUM(total_cost) as cost,
                   SUM(total_revenue) as revenue,
                   SUM(total_revenue - total_cost) as profit,
                   COUNT(*) as count
            FROM orders
            WHERE status='completed'
              AND date(completed_at) >= date(?) AND date(completed_at) <= date(?)
            GROUP BY date(completed_at)
            ORDER BY day
        """, (date_from, date_to)).fetchall()

    names = load_display_names()
    items_out = []
    for r in items_agg:
        items_out.append({
            **dict(r),
            "name_zh": names.get(r["item_id"], r["item_id"]),
            "profit":  (r["total_revenue"] or 0) - (r["total_cost"] or 0),
        })

    total_cost = sum((o["total_cost"] or 0) for o in orders)
    total_rev  = sum((o["total_revenue"] or 0) for o in orders)

    daily = {r["day"]: dict(r) for r in daily_rows}
    try:
        d_from = dt_date.fromisoformat(date_from)
        d_to   = dt_date.fromisoformat(date_to)
        if (d_to - d_from).days > 365:
            d_from = d_to - timedelta(days=365)
        daily_full = []
        cur = d_from
        while cur <= d_to:
            ds = cur.isoformat()
            dd = daily.get(ds, {"cost": 0, "revenue": 0, "profit": 0, "count": 0})
            daily_full.append({
                "day": ds,
                "cost": dd.get("cost") or 0,
                "revenue": dd.get("revenue") or 0,
                "profit": dd.get("profit") or 0,
                "count": dd.get("count") or 0,
            })
            cur += timedelta(days=1)
    except Exception as e:
        logger.warning(f"日期补全异常: {e}")
        daily_full = [{
            "day": r["day"],
            "cost": r["cost"] or 0,
            "revenue": r["revenue"] or 0,
            "profit": r["profit"] or 0,
            "count": r["count"],
        } for r in daily_rows]

    return {
        "orders":        [dict(o) for o in orders],
        "items":         items_out,
        "daily":         daily_full,
        "total_cost":    total_cost,
        "total_revenue": total_rev,
        "total_profit":  total_rev - total_cost,
        "order_count":   len(orders),
    }


# ───────── 日报导出 ─────────

def export_daily_report(date_from: str, date_to: str, price_type: str = "sell") -> str:
    """
    导出日报文本。
    price_type: "sell" 用售价（给甲方），"cost" 用成本价（给自己）
    """
    logger.info(f"导出日报: from={date_from}, to={date_to}, type={price_type}")
    names = load_display_names()

    with get_conn() as conn:
        orders = conn.execute("""
            SELECT o.id, o.customer_name, o.completed_at, o.total_cost, o.total_revenue
            FROM orders o
            WHERE o.status='completed'
              AND date(o.completed_at) >= date(?) AND date(o.completed_at) <= date(?)
            ORDER BY o.completed_at ASC
        """, (date_from, date_to)).fetchall()

        if not orders:
            return f"订单导出 {date_from} ~ {date_to}\n\n暂无已完成订单"

        # 逐单获取物品
        order_ids = [o["id"] for o in orders]
        placeholders = ",".join("?" * len(order_ids))
        items = conn.execute(f"""
            SELECT order_id, item_id, raw_name, quantity, cost_price, sell_price
            FROM order_items
            WHERE order_id IN ({placeholders})
            ORDER BY order_id, id
        """, order_ids).fetchall()

    # 按订单分组
    from collections import defaultdict
    order_items_map = defaultdict(list)
    for it in items:
        order_items_map[it["order_id"]].append(dict(it))

    lines = [f"订单导出-{date_from}_{date_to}\n"]

    for o in orders:
        customer = o["customer_name"] or f"#{o['id']}"
        lines.append(f"客户id：{customer}")
        lines.append("=" * 24)

        oi_list = order_items_map.get(o["id"], [])
        for it in oi_list:
            name = names.get(it["item_id"], it["raw_name"] or it["item_id"])
            qty = it["quantity"]
            lines.append(f"{name}  x{qty}")

        lines.append("=" * 24)
        if price_type == "sell":
            amount = o["total_revenue"] or 0
        else:
            amount = o["total_cost"] or 0
        lines.append(f"金额：（{amount:.2f}）")
        lines.append("")

    # 汇总
    if price_type == "sell":
        total = sum((o["total_revenue"] or 0) for o in orders)
    else:
        total = sum((o["total_cost"] or 0) for o in orders)
    lines.append("=" * 24)
    lines.append(f"共 {len(orders)} 单，总金额：{total:.2f}")

    return "\n".join(lines)


# ───────── AI 补货建议 ─────────

def get_restock_advice(days: int = 14, restock_days: int = 1) -> list:
    """
    基于历史销售分析 + 当前库存，生成智能补货建议。
    days: 统计销售的回溯天数
    restock_days: 建议补货天数（补够几天的量）
    """
    import math
    logger.info(f"AI补货建议: 回溯{days}天, 补{restock_days}天")
    names = load_display_names()

    with get_conn() as conn:
        # 1. 最近 N 天已完成订单的物品销量（含 bundle 展开）
        sold_rows = conn.execute("""
            SELECT oi.item_id, oi.quantity, oi.order_id, o.customer_name
            FROM order_items oi
            JOIN orders o ON oi.order_id = o.id
            WHERE o.status = 'completed'
              AND date(o.completed_at, 'localtime') >= date('now', 'localtime', ?)
        """, (f'-{days} days',)).fetchall()

        expanded = _expand_order_items(sold_rows, conn)

        # 汇总每个物品的总销量
        sales = {}  # {item_id: total_qty}
        for row in expanded:
            iid = row["item_id"]
            if iid.startswith("__bundle__"):
                continue  # 跳过纯服务套餐行
            sales[iid] = sales.get(iid, 0) + row["quantity"]

        # 2. 待处理订单需求（pending + ready=0）
        pending_rows = conn.execute("""
            SELECT oi.item_id, oi.quantity, oi.order_id, o.customer_name
            FROM order_items oi
            JOIN orders o ON oi.order_id = o.id
            WHERE o.status = 'pending' AND oi.ready = 0
        """).fetchall()
        pending_expanded = _expand_order_items(pending_rows, conn)
        pending_demand = {}
        for row in pending_expanded:
            iid = row["item_id"]
            if iid.startswith("__bundle__"):
                continue
            pending_demand[iid] = pending_demand.get(iid, 0) + row["quantity"]

        # 3. 各账号库存
        inv_rows = conn.execute("""
            SELECT i.item_id, i.quantity, a.id as account_id, a.name as account_name
            FROM inventory i
            JOIN accounts a ON i.account_id = a.id
            WHERE a.active = 1 AND i.quantity > 0
        """).fetchall()

    # 汇总库存
    stock_by_item = {}   # {item_id: total}
    account_stocks = {}  # {item_id: [{account_id, account_name, quantity}]}
    for r in inv_rows:
        iid = r["item_id"]
        stock_by_item[iid] = stock_by_item.get(iid, 0) + r["quantity"]
        if iid not in account_stocks:
            account_stocks[iid] = []
        account_stocks[iid].append({
            "account_id": r["account_id"],
            "account_name": r["account_name"],
            "quantity": r["quantity"],
        })

    # 4. 合并所有有销量或有待处理需求的物品
    all_items = set(sales.keys()) | set(pending_demand.keys())

    result = []
    for iid in all_items:
        daily_avg = round(sales.get(iid, 0) / days, 1) if iid in sales else 0
        current = stock_by_item.get(iid, 0)
        pending = pending_demand.get(iid, 0)
        days_left = round(current / daily_avg, 1) if daily_avg > 0 else 999

        # 补货量 = 补够 restock_days 天用量 + 待处理需求 - 当前库存
        target = math.ceil(daily_avg * restock_days) + pending
        restock_qty = max(0, target - current)

        if restock_qty <= 0:
            continue  # 充足，跳过

        # 紧急度
        if days_left < 2:
            level = "urgent"
        elif days_left < restock_days + 2:
            level = "warning"
        else:
            continue  # 充足

        # 调货建议
        accs = account_stocks.get(iid, [])
        accs_sorted = sorted(accs, key=lambda a: a["quantity"], reverse=True)
        transfer_parts = []
        transferred = 0
        for a in accs_sorted:
            take = min(a["quantity"], restock_qty - transferred)
            if take <= 0:
                break
            transfer_parts.append(f"{a['account_name']}调{take}")
            transferred += take
        ext = restock_qty - transferred
        if ext > 0 and transfer_parts:
            transfer_parts.append(f"外补{ext}")

        result.append({
            "item_id": iid,
            "name_zh": names.get(iid, iid),
            "daily_avg": daily_avg,
            "current_stock": current,
            "pending_demand": pending,
            "days_left": days_left,
            "restock_qty": restock_qty,
            "level": level,
            "account_stocks": accs_sorted,
            "transfer": " ".join(transfer_parts) if transfer_parts else "",
        })

    # 排序：急补在前，再按可撑天数升序
    result.sort(key=lambda x: (0 if x["level"] == "urgent" else 1, x["days_left"]))
    logger.info(f"AI补货建议: {len(result)} 个物品")
    return result