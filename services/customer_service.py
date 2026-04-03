"""
客户服务层：客户 CRUD、统计数据
"""
import logging
from database import get_conn

logger = logging.getLogger("customer_service")


def get_or_create_customer(name: str) -> int:
    """查找或自动创建客户，返回 customer_id"""
    logger.info(f"查找或创建客户: name={name}")
    with get_conn() as conn:
        row = conn.execute("SELECT id FROM customers WHERE name=?", (name,)).fetchone()
        if row:
            logger.info(f"客户已存在: id={row['id']}, name={name}")
            return row["id"]
        cur = conn.execute("INSERT INTO customers (name) VALUES (?)", (name,))
        cid = cur.lastrowid
        logger.info(f"客户已创建: id={cid}, name={name}")
        return cid


def get_customers(days: int = 7, limit: int = 100) -> list:
    logger.info(f"查询客户列表: days={days}, limit={limit}")
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT c.id, c.name, c.note, c.created_at,
                   COUNT(DISTINCT o.id)   as order_count,
                   COALESCE(SUM(CASE WHEN o.created_at >= datetime('now', ?)
                                THEN o.total_revenue ELSE 0 END), 0) as recent_revenue,
                   COALESCE(SUM(o.total_revenue), 0) as total_revenue,
                   MAX(o.created_at) as last_order_at
            FROM customers c
            LEFT JOIN orders o ON o.customer_id=c.id AND o.status='completed'
            GROUP BY c.id
            ORDER BY recent_revenue DESC
            LIMIT ?
            """,
            (f"-{days} days", limit)
        ).fetchall()
        logger.info(f"查询到 {len(rows)} 个客户")
        return [dict(r) for r in rows]


def get_customer(customer_id: int) -> dict | None:
    logger.info(f"查询客户详情: id={customer_id}")
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM customers WHERE id=?", (customer_id,)).fetchone()
        if not row:
            logger.warning(f"客户不存在: id={customer_id}")
            return None

        orders = conn.execute(
            "SELECT id, status, total_cost, total_revenue, created_at, completed_at "
            "FROM orders WHERE customer_id=? ORDER BY created_at DESC",
            (customer_id,)
        ).fetchall()

        top_items = conn.execute(
            """
            SELECT oi.item_id, SUM(oi.quantity) as total_qty
            FROM order_items oi
            JOIN orders o ON oi.order_id=o.id
            WHERE o.customer_id=? AND o.status='completed'
            GROUP BY oi.item_id
            ORDER BY total_qty DESC
            LIMIT 10
            """,
            (customer_id,)
        ).fetchall()

    logger.info(f"客户 id={customer_id}: {len(orders)} 个订单, Top {len(top_items)} 物品")

    from services.item_service import load_display_names
    names = load_display_names()

    return {
        **dict(row),
        "orders":    [dict(r) for r in orders],
        "top_items": [
            {
                "item_id":   r["item_id"],
                "name_zh":   names.get(r["item_id"], r["item_id"]),
                "image_url": f"/api/items/{r['item_id']}/image",
                "total_qty": r["total_qty"],
            }
            for r in top_items
        ],
        "order_count":   len(orders),
        "total_revenue": sum(r["total_revenue"] for r in orders),
        "total_cost":    sum(r["total_cost"] for r in orders),
    }


def update_customer(customer_id: int, note: str) -> bool:
    logger.info(f"更新客户备注: id={customer_id}, note_len={len(note)}")
    try:
        with get_conn() as conn:
            conn.execute("UPDATE customers SET note=? WHERE id=?", (note, customer_id))
            logger.info(f"客户备注已更新: id={customer_id}")
            return True
    except Exception as e:
        logger.error(f"更新客户备注失败 id={customer_id}", exc_info=True)
        return False


def delete_customer(customer_id: int) -> bool:
    logger.info(f"删除客户: id={customer_id}")
    try:
        with get_conn() as conn:
            conn.execute("UPDATE orders SET customer_id=NULL WHERE customer_id=?", (customer_id,))
            conn.execute("DELETE FROM customers WHERE id=?", (customer_id,))
            logger.info(f"客户已删除: id={customer_id}")
            return True
    except Exception as e:
        logger.error(f"删除客户失败 id={customer_id}", exc_info=True)
        return False


