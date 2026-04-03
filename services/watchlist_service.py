"""
重点关注服务：管理账号关注规则，检查库存告警
rule_type: 'item' | 'bundle' | 'type'
target_id: item_id | bundle_id (数字字符串) | type名 (如 Weapon, Attachment)
"""
import logging
from database import get_conn
from services.item_service import load_item_data, load_display_names, load_english_names

logger = logging.getLogger("watchlist_service")


# ───────── CRUD ─────────

def get_rules(account_id: int) -> list:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM account_watch_rules WHERE account_id=? ORDER BY rule_type, target_id",
            (account_id,)
        ).fetchall()
    return [dict(r) for r in rows]


def add_rule(account_id: int, rule_type: str, target_id: str, threshold: int = 1) -> dict:
    with get_conn() as conn:
        try:
            cur = conn.execute(
                "INSERT INTO account_watch_rules (account_id, rule_type, target_id, threshold) "
                "VALUES (?, ?, ?, ?)",
                (account_id, rule_type, target_id, threshold)
            )
            return {"ok": True, "id": cur.lastrowid}
        except Exception as e:
            if "UNIQUE" in str(e):
                # 已存在，更新阈值
                conn.execute(
                    "UPDATE account_watch_rules SET threshold=? "
                    "WHERE account_id=? AND rule_type=? AND target_id=?",
                    (threshold, account_id, rule_type, target_id)
                )
                return {"ok": True, "updated": True}
            return {"ok": False, "error": str(e)}


def add_rules_batch(account_id: int, rules: list) -> dict:
    """批量添加规则 [{rule_type, target_id, threshold}, ...]"""
    added = 0
    with get_conn() as conn:
        for r in rules:
            try:
                conn.execute(
                    "INSERT OR REPLACE INTO account_watch_rules (account_id, rule_type, target_id, threshold) "
                    "VALUES (?, ?, ?, ?)",
                    (account_id, r["rule_type"], r["target_id"], r.get("threshold", 1))
                )
                added += 1
            except Exception:
                pass
    return {"ok": True, "added": added}


def update_rule(rule_id: int, threshold: int) -> bool:
    with get_conn() as conn:
        conn.execute(
            "UPDATE account_watch_rules SET threshold=? WHERE id=?",
            (threshold, rule_id)
        )
        return True


def delete_rule(rule_id: int) -> bool:
    with get_conn() as conn:
        conn.execute("DELETE FROM account_watch_rules WHERE id=?", (rule_id,))
        return True


def delete_rules_by_account(account_id: int) -> bool:
    with get_conn() as conn:
        conn.execute("DELETE FROM account_watch_rules WHERE account_id=?", (account_id,))
        return True


# ───────── 告警检查 ─────────

def check_alerts(account_id: int = None) -> list:
    """
    检查关注规则的告警状态。
    返回 [{account_id, account_name, rule_id, rule_type, target_id, target_name,
            threshold, current, shortage, status, components (仅套餐)}]
    """
    items_db = load_item_data()
    names    = load_display_names()
    en_names = load_english_names()

    with get_conn() as conn:
        # 获取规则
        if account_id:
            rules = conn.execute(
                "SELECT r.*, a.name as account_name FROM account_watch_rules r "
                "JOIN accounts a ON r.account_id=a.id WHERE r.account_id=?",
                (account_id,)
            ).fetchall()
        else:
            rules = conn.execute(
                "SELECT r.*, a.name as account_name FROM account_watch_rules r "
                "JOIN accounts a ON r.account_id=a.id WHERE a.active=1"
            ).fetchall()

        # 获取各账号库存（按账号分组）
        inv_rows = conn.execute(
            "SELECT account_id, item_id, SUM(quantity) as qty "
            "FROM inventory GROUP BY account_id, item_id"
        ).fetchall()

        # 全部账号库存（用于跨账号查看）
        all_inv_rows = conn.execute(
            "SELECT i.account_id, a.name as account_name, i.item_id, SUM(i.quantity) as qty "
            "FROM inventory i JOIN accounts a ON i.account_id=a.id "
            "WHERE a.active=1 GROUP BY i.account_id, i.item_id"
        ).fetchall()

        # 套餐组件
        bundle_rows = conn.execute(
            "SELECT bi.bundle_id, bi.item_id, MAX(bi.quantity) as quantity "
            "FROM bundle_items bi GROUP BY bi.bundle_id, bi.item_id"
        ).fetchall()
        bundle_names_rows = conn.execute("SELECT id, name FROM bundles").fetchall()
        bundle_alias_rows = conn.execute(
            "SELECT bundle_id, alias FROM bundle_aliases"
        ).fetchall()

    # 构建库存映射 {account_id: {item_id: qty}}
    inv_map = {}
    for r in inv_rows:
        inv_map.setdefault(r["account_id"], {})[r["item_id"]] = r["qty"]

    # 全部库存映射 {item_id: [{account_id, account_name, qty}]}
    all_inv_map = {}
    for r in all_inv_rows:
        all_inv_map.setdefault(r["item_id"], []).append({
            "account_id": r["account_id"],
            "account_name": r["account_name"],
            "quantity": r["qty"]
        })

    # 套餐组件映射
    bundle_comps = {}  # {bundle_id: [{item_id, quantity}]}
    for r in bundle_rows:
        bundle_comps.setdefault(r["bundle_id"], []).append({
            "item_id": r["item_id"], "quantity": r["quantity"]
        })
    bundle_name_map = {r["id"]: r["name"] for r in bundle_names_rows}
    bundle_alias_map = {}
    for r in bundle_alias_rows:
        if r["bundle_id"] not in bundle_alias_map:
            bundle_alias_map[r["bundle_id"]] = r["alias"]

    results = []

    for rule in rules:
        aid  = rule["account_id"]
        aname = rule["account_name"]
        rt   = rule["rule_type"]
        tid  = rule["target_id"]
        thr  = rule["threshold"]
        my_inv = inv_map.get(aid, {})

        if rt == "item":
            current = my_inv.get(tid, 0)
            shortage = max(0, thr - current)
            results.append({
                "account_id":   aid,
                "account_name": aname,
                "rule_id":      rule["id"],
                "rule_type":    "item",
                "target_id":    tid,
                "target_name":  names.get(tid, tid),
                "target_en":    en_names.get(tid, ""),
                "image_url":    f"/api/items/{tid}/image",
                "threshold":    thr,
                "current":      current,
                "shortage":     shortage,
                "status":       "ok" if shortage == 0 else "alert",
                "other_accounts": all_inv_map.get(tid, []),
            })

        elif rt == "bundle":
            bid = int(tid)
            comps = bundle_comps.get(bid, [])
            bname = bundle_alias_map.get(bid, bundle_name_map.get(bid, f"套餐#{bid}"))
            comp_details = []
            worst_shortage = 0
            for comp in comps:
                need = comp["quantity"] * thr
                have = my_inv.get(comp["item_id"], 0)
                short = max(0, need - have)
                if short > worst_shortage:
                    worst_shortage = short
                comp_details.append({
                    "item_id":    comp["item_id"],
                    "name_zh":    names.get(comp["item_id"], comp["item_id"]),
                    "image_url":  f"/api/items/{comp['item_id']}/image",
                    "need":       need,
                    "have":       have,
                    "shortage":   short,
                    "other_accounts": all_inv_map.get(comp["item_id"], []),
                })

            results.append({
                "account_id":   aid,
                "account_name": aname,
                "rule_id":      rule["id"],
                "rule_type":    "bundle",
                "target_id":    tid,
                "target_name":  bname,
                "target_en":    bundle_name_map.get(bid, ""),
                "image_url":    "",
                "threshold":    thr,
                "current":      0,
                "shortage":     worst_shortage,
                "status":       "ok" if worst_shortage == 0 else "alert",
                "components":   comp_details,
            })

        elif rt == "type":
            # 关注某类型的所有物品
            type_items = [iid for iid, meta in items_db.items() if meta.get("type") == tid]
            for iid in type_items:
                current = my_inv.get(iid, 0)
                if current > 0 or thr > 0:
                    shortage = max(0, thr - current)
                    results.append({
                        "account_id":   aid,
                        "account_name": aname,
                        "rule_id":      rule["id"],
                        "rule_type":    "type",
                        "target_id":    iid,
                        "target_name":  names.get(iid, iid),
                        "target_en":    en_names.get(iid, ""),
                        "image_url":    f"/api/items/{iid}/image",
                        "threshold":    thr,
                        "current":      current,
                        "shortage":     shortage,
                        "status":       "ok" if shortage == 0 else "alert",
                        "type_rule":    tid,
                        "other_accounts": all_inv_map.get(iid, []),
                    })

    # 告警的排前面
    results.sort(key=lambda x: (0 if x["status"] == "alert" else 1, x["account_name"], -x["shortage"]))
    return results


def get_item_types() -> list:
    """返回所有物品类型及数量"""
    items_db = load_item_data()
    type_count = {}
    for meta in items_db.values():
        t = meta.get("type", "")
        if t:
            type_count[t] = type_count.get(t, 0) + 1
    return sorted(type_count.keys())


