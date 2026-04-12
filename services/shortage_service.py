"""
备货清单服务层：缺货清单、存货分布、补货建议
"""
import logging
import math
from database import get_conn
from services.item_service import load_display_names, load_english_names

logger = logging.getLogger("shortage_service")


# ───────── 展开套餐物品 ─────────

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


# ───────── 跨订单备货清单 ─────────

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


# ───────── AI 补货建议 ─────────

def get_restock_advice(days: int = 14, restock_days: int = 1) -> list:
    """
    基于历史销售分析 + 当前库存，生成智能补货建议。
    days: 统计销售的回溯天数
    restock_days: 建议补货天数（补够几天的量）
    """
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
