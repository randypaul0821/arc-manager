"""
订单报表服务层：统计、日报导出
"""
import logging
from collections import defaultdict
from datetime import date as dt_date, timedelta
from database import get_conn
from services.item_service import load_display_names

logger = logging.getLogger("order_report_service")


# ───────── 统计 ─────────

def get_stats(date_from: str = "2000-01-01", date_to: str = "2099-12-31") -> dict:
    """计算指定日期范围内的订单统计数据"""
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
