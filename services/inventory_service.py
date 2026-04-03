"""
库存服务层：库存聚合查询
"""
import logging
from database import get_conn
from services.item_service import load_display_names, load_english_names, load_item_data, load_aliases_map

logger = logging.getLogger("inventory_service")


def get_inventory(account_id: int | None = None) -> list:
    logger.info(f"查询库存: account_id={account_id}")
    names = load_display_names()

    with get_conn() as conn:
        if account_id:
            rows = conn.execute(
                "SELECT i.item_id, i.quantity, i.slot, i.durability, i.updated_at, "
                "a.id as account_id, a.name as account_name "
                "FROM inventory i JOIN accounts a ON i.account_id=a.id "
                "WHERE i.account_id=? AND a.active=1 ORDER BY i.item_id",
                (account_id,)
            ).fetchall()
            logger.info(f"单账号库存: {len(rows)} 行")
            return [_row_to_dict(r, names) for r in rows]

        rows = conn.execute(
            "SELECT i.item_id, SUM(i.quantity) as quantity, "
            "a.id as account_id, a.name as account_name "
            "FROM inventory i JOIN accounts a ON i.account_id=a.id "
            "WHERE a.active=1 GROUP BY i.item_id, i.account_id ORDER BY i.item_id"
        ).fetchall()

    items_db = load_item_data()
    en_names = load_english_names()
    logger.info(f"全账号库存: {len(rows)} 行")

    merged: dict = {}
    for r in rows:
        iid = r["item_id"]
        if iid not in merged:
            meta = items_db.get(iid, {})
            merged[iid] = {
                "item_id":    iid,
                "name_zh":    names.get(iid, iid),
                "name_en":    en_names.get(iid, ""),
                "image_url":  f"/api/items/{iid}/image",
                "total":      0,
                "accounts":   [],
                "rarity":     meta.get("rarity", ""),
                "type":       meta.get("type", ""),
                "is_weapon":  meta.get("is_weapon", False),
                "craft_bench": meta.get("craft_bench", ""),
            }
        merged[iid]["total"] += r["quantity"]
        merged[iid]["accounts"].append({
            "account_id":   r["account_id"],
            "account_name": r["account_name"],
            "quantity":     r["quantity"]
        })

    result = sorted(merged.values(), key=lambda x: x["item_id"])
    logger.info(f"库存聚合后: {len(result)} 种物品")
    return result


def search_inventory(q: str) -> list:
    logger.info(f"搜索库存: q='{q}'")
    names   = load_display_names()
    aliases = load_aliases_map()
    all_inv = get_inventory()

    q_lower = q.lower().strip()
    result  = []
    for item in all_inv:
        iid      = item["item_id"]
        name     = names.get(iid, iid).lower()
        alias_hit = any(q_lower in a["alias"].lower() for a in aliases.get(iid, []))
        if q_lower in name or alias_hit:
            result.append(item)
    logger.info(f"搜索库存结果: {len(result)} 种物品")
    return result


def _row_to_dict(r, names: dict) -> dict:
    iid = r["item_id"]
    return {
        "item_id":      iid,
        "name_zh":      names.get(iid, iid),
        "image_url":    f"/api/items/{iid}/image",
        "quantity":     r["quantity"],
        "account_id":   r["account_id"],
        "account_name": r["account_name"],
        "slot":         r["slot"],
        "durability":   r["durability"],
    }