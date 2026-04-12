"""
套餐服务层：套餐 CRUD、成本计算、别名管理
"""
import json
import logging
import os
from database import get_conn
from config import DATA_DIR
from services.item_service import load_display_names, load_english_names

logger = logging.getLogger("bundle_service")


# ───────── 查询 ─────────

def get_all_bundles(source: str = "") -> list:
    logger.info(f"查询所有套餐, source='{source}'")
    with get_conn() as conn:
        if source:
            rows = conn.execute(
                "SELECT * FROM bundles WHERE source=? ORDER BY name", (source,)
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM bundles ORDER BY source, name").fetchall()

        bundle_ids = [r["id"] for r in rows]
        aliases_map: dict = {bid: [] for bid in bundle_ids}
        items_map: dict   = {bid: [] for bid in bundle_ids}
        if bundle_ids:
            placeholders = ','.join('?' * len(bundle_ids))
            alias_rows = conn.execute(
                f"SELECT id, bundle_id, alias FROM bundle_aliases "
                f"WHERE bundle_id IN ({placeholders})",
                bundle_ids
            ).fetchall()
            for a in alias_rows:
                aliases_map[a["bundle_id"]].append({"id": a["id"], "alias": a["alias"]})

            item_rows = conn.execute(
                f"SELECT bundle_id, item_id, MAX(quantity) as quantity FROM bundle_items "
                f"WHERE bundle_id IN ({placeholders}) GROUP BY bundle_id, item_id",
                bundle_ids
            ).fetchall()
            for it in item_rows:
                items_map[it["bundle_id"]].append({
                    "item_id": it["item_id"], "quantity": it["quantity"]
                })

    names = load_display_names()
    en_names = load_english_names()
    logger.info(f"查询到 {len(rows)} 个套餐")
    return [
        {
            **dict(r),
            "aliases": aliases_map.get(r["id"], []),
            "items": [
                {**it, "name_zh": names.get(it["item_id"], it["item_id"]),
                 "name_en": en_names.get(it["item_id"], ""),
                 "image_url": f"/api/items/{it['item_id']}/image"}
                for it in items_map.get(r["id"], [])
            ],
        }
        for r in rows
    ]


def get_bundle_with_items(bundle_id: int) -> dict | None:
    logger.info(f"查询套餐详情: id={bundle_id}")
    with get_conn() as conn:
        b = conn.execute("SELECT * FROM bundles WHERE id=?", (bundle_id,)).fetchone()
        if not b:
            logger.warning(f"套餐不存在: id={bundle_id}")
            return None
        items = conn.execute(
            "SELECT item_id, MAX(quantity) as quantity FROM bundle_items WHERE bundle_id=? GROUP BY item_id",
            (bundle_id,)
        ).fetchall()
        aliases = conn.execute(
            "SELECT id, alias FROM bundle_aliases WHERE bundle_id=?",
            (bundle_id,)
        ).fetchall()

    names = load_display_names()
    en_names = load_english_names()
    logger.info(f"套餐 id={bundle_id} 包含 {len(items)} 个物品, {len(aliases)} 个别名")
    return {
        **dict(b),
        "items": [
            {
                "item_id":  r["item_id"],
                "name_zh":  names.get(r["item_id"], r["item_id"]),
                "name_en":  en_names.get(r["item_id"], ""),
                "quantity": r["quantity"],
                "image_url": f"/api/items/{r['item_id']}/image",
            }
            for r in items
        ],
        "aliases": [{"id": r["id"], "alias": r["alias"]} for r in aliases],
        "cost":    calc_bundle_cost(bundle_id),
    }


def get_bundle_sources() -> list:
    logger.info("查询套餐 source 列表")
    with get_conn() as conn:
        rows = conn.execute("SELECT DISTINCT source FROM bundles ORDER BY source").fetchall()
        sources = [r["source"] for r in rows]
        logger.info(f"套餐 source: {sources}")
        return sources


# ───────── 创建 / 修改 ─────────

def _dedup_items(items: list) -> list:
    """合并相同 item_id 的数量"""
    merged = {}
    for it in items:
        iid = it["item_id"]
        if iid in merged:
            merged[iid]["quantity"] += it.get("quantity", 1)
        else:
            merged[iid] = {"item_id": iid, "quantity": it.get("quantity", 1)}
    return list(merged.values())


def cleanup_duplicate_items() -> int:
    """清理所有套餐中的重复物品行"""
    logger.info("开始清理套餐重复物品...")
    cleaned = 0
    with get_conn() as conn:
        bundles = conn.execute("SELECT id FROM bundles").fetchall()
        for b in bundles:
            bid = b["id"]
            items = conn.execute(
                "SELECT item_id, quantity, COUNT(*) as cnt FROM bundle_items WHERE bundle_id=? GROUP BY item_id",
                (bid,)
            ).fetchall()
            dups = [r for r in items if r["cnt"] > 1]
            if dups:
                # Delete all and re-insert deduped
                conn.execute("DELETE FROM bundle_items WHERE bundle_id=?", (bid,))
                for it in items:
                    conn.execute(
                        "INSERT INTO bundle_items (bundle_id, item_id, quantity) VALUES (?, ?, ?)",
                        (bid, it["item_id"], it["quantity"])
                    )
                cleaned += len(dups)
                logger.info(f"套餐 #{bid}: 清理了 {len(dups)} 个重复物品")
    logger.info(f"清理完成: 共 {cleaned} 个重复项")
    return cleaned


def create_bundle(name: str, items: list, source: str = "manual",
                   bundle_type: str = "item", price: float | None = None,
                   description: str = "") -> tuple[int | None, str]:
    name = name.strip()
    items = _dedup_items(items)
    logger.info(f"创建套餐: name={name}, type={bundle_type}, items={len(items)}个, source={source}")
    if not name:
        return None, "套餐名不能为空"
    if bundle_type == "item" and not items:
        return None, "物品套餐必须包含至少一个物品"
    if bundle_type == "service" and price is None:
        return None, "服务套餐必须设置价格"
    try:
        with get_conn() as conn:
            cur = conn.execute(
                "INSERT INTO bundles (name, source, type, price, description) VALUES (?, ?, ?, ?, ?)",
                (name, source, bundle_type, price, description)
            )
            bundle_id = cur.lastrowid
            for it in items:
                conn.execute(
                    "INSERT INTO bundle_items (bundle_id, item_id, quantity) VALUES (?, ?, ?)",
                    (bundle_id, it["item_id"], it["quantity"])
                )
            logger.info(f"套餐创建成功: id={bundle_id}, name={name}")
            return bundle_id, ""
    except Exception as e:
        err = "套餐名已存在" if "UNIQUE" in str(e) else str(e)
        logger.error(f"创建套餐失败: {err}")
        return None, err


def update_bundle(bundle_id: int, name: str, items: list,
                  bundle_type: str = "item", price: float | None = None,
                  description: str = "") -> tuple[bool, str]:
    name = name.strip()
    items = _dedup_items(items)
    logger.info(f"更新套餐: id={bundle_id}, name={name}, type={bundle_type}, items={len(items)}个")
    if not name:
        return False, "套餐名不能为空"
    if bundle_type == "item" and not items:
        return False, "物品套餐必须包含至少一个物品"
    if bundle_type == "service" and price is None:
        return False, "服务套餐必须设置价格"
    try:
        with get_conn() as conn:
            conn.execute(
                "UPDATE bundles SET name=?, type=?, price=?, description=? WHERE id=?",
                (name, bundle_type, price, description, bundle_id)
            )
            conn.execute("DELETE FROM bundle_items WHERE bundle_id=?", (bundle_id,))
            for it in items:
                conn.execute(
                    "INSERT INTO bundle_items (bundle_id, item_id, quantity) VALUES (?, ?, ?)",
                    (bundle_id, it["item_id"], it["quantity"])
                )
            logger.info(f"套餐更新成功: id={bundle_id}")
            return True, ""
    except Exception as e:
        logger.error(f"更新套餐失败 id={bundle_id}", exc_info=True)
        return False, str(e)


def delete_bundle(bundle_id: int) -> bool:
    logger.info(f"删除套餐: id={bundle_id}")
    try:
        with get_conn() as conn:
            conn.execute("DELETE FROM account_watch_rules WHERE rule_type='bundle' AND target_id=?", (bundle_id,))
            conn.execute("DELETE FROM bundle_alerts WHERE bundle_id=?", (bundle_id,))
            conn.execute("DELETE FROM bundles WHERE id=?", (bundle_id,))
            logger.info(f"套餐已删除: id={bundle_id}")
            return True
    except Exception as e:
        logger.error(f"删除套餐失败 id={bundle_id}", exc_info=True)
        return False


# ───────── 别名 ─────────

def add_bundle_alias(bundle_id: int, alias: str) -> tuple[bool, str]:
    alias = alias.strip()
    logger.info(f"添加套餐别名: bundle_id={bundle_id}, alias={alias}")
    if not alias:
        return False, "别名不能为空"
    try:
        with get_conn() as conn:
            conn.execute(
                "INSERT INTO bundle_aliases (bundle_id, alias) VALUES (?, ?)",
                (bundle_id, alias)
            )
            logger.info(f"套餐别名添加成功")
            return True, ""
    except Exception as e:
        err = "别名已存在" if "UNIQUE" in str(e) else str(e)
        logger.warning(f"添加套餐别名失败: {err}")
        return False, err


def update_bundle_alias(alias_id: int, alias: str) -> tuple[bool, str]:
    alias = alias.strip()
    logger.info(f"更新套餐别名: alias_id={alias_id}, new_alias={alias}")
    if not alias:
        return False, "别名不能为空"
    try:
        with get_conn() as conn:
            conn.execute("UPDATE bundle_aliases SET alias=? WHERE id=?", (alias, alias_id))
            logger.info(f"套餐别名更新成功: id={alias_id}")
            return True, ""
    except Exception as e:
        err = "别名已存在" if "UNIQUE" in str(e) else str(e)
        logger.warning(f"更新套餐别名失败: {err}")
        return False, err


def delete_bundle_alias(alias_id: int) -> bool:
    logger.info(f"删除套餐别名: id={alias_id}")
    try:
        with get_conn() as conn:
            conn.execute("DELETE FROM bundle_aliases WHERE id=?", (alias_id,))
            logger.info(f"套餐别名已删除: id={alias_id}")
            return True
    except Exception as e:
        logger.error(f"删除套餐别名失败 id={alias_id}", exc_info=True)
        return False


def load_bundle_search_map() -> dict:
    logger.debug("加载套餐搜索映射表")
    with get_conn() as conn:
        bundles = conn.execute("SELECT id, name FROM bundles").fetchall()
        aliases = conn.execute("SELECT bundle_id, alias FROM bundle_aliases").fetchall()
    result = {}
    import re
    def _add_key(name, bid):
        """添加原始和清理后的版本"""
        result[name.lower()] = bid
        # 也添加去掉括号的版本
        cleaned = re.sub(r'[【】\[\]()（）]', '', name)
        cleaned = re.sub(r'\s+', ' ', cleaned).strip().lower()
        if cleaned and cleaned != name.lower():
            result[cleaned] = bid
    for b in bundles:
        _add_key(b["name"], b["id"])
    for a in aliases:
        _add_key(a["alias"], a["bundle_id"])
    logger.debug(f"套餐搜索映射: {len(result)} 条")
    return result


# ───────── Hideout 套餐生成 ─────────

def _generate_combos(phase_bundles: list, base_zh: str, base_en: str, source: str) -> int:
    """为多阶段系列生成所有连续范围组合套餐（如 Lv1-2, Lv1-3, Lv2-3）"""
    combo_count = 0
    n = len(phase_bundles)
    for i in range(n):
        for j in range(i + 1, n):
            # 合并 i..j 范围的物品
            merged_items = []
            for k in range(i, j + 1):
                merged_items.extend(phase_bundles[k]["items"])
            merged_items = _dedup_items(merged_items)

            combo_name = f"{base_zh} Lv{i + 1}-{j + 1}"
            bid, err = create_bundle(
                name=combo_name,
                items=merged_items,
                source=source,
                bundle_type="item",
            )
            if bid:
                combo_count += 1
                alias_en = f"{base_en} Lv{i + 1}-{j + 1}"
                if alias_en != combo_name:
                    add_bundle_alias(bid, alias_en)
            else:
                logger.warning(f"创建组合套餐失败: {combo_name} - {err}")
    return combo_count


def _delete_bundles_by_source(source: str) -> int:
    """删除指定 source 的所有套餐及关联的监控规则，返回删除数量"""
    with get_conn() as conn:
        old = conn.execute("SELECT id FROM bundles WHERE source=?", (source,)).fetchall()
        old_ids = [r["id"] for r in old]
        if old_ids:
            ph = ",".join("?" * len(old_ids))
            conn.execute(f"DELETE FROM account_watch_rules WHERE rule_type='bundle' AND target_id IN ({ph})", old_ids)
            conn.execute(f"DELETE FROM bundle_alerts WHERE bundle_id IN ({ph})", old_ids)
            conn.execute("DELETE FROM bundles WHERE source=?", (source,))
        return len(old_ids)


def generate_hideout_bundles() -> dict:
    """从 hideout JSON 生成系统套餐，先删除旧的 hideout 套餐再全量重建"""
    hideout_dir = os.path.join(DATA_DIR, "hideout")
    if not os.path.isdir(hideout_dir):
        logger.error(f"hideout 目录不存在: {hideout_dir}")
        return {"created": 0, "deleted": 0, "skipped": 0, "error": "hideout 目录不存在"}

    stations = []
    for fname in sorted(os.listdir(hideout_dir)):
        if not fname.endswith(".json"):
            continue
        with open(os.path.join(hideout_dir, fname), encoding="utf-8") as f:
            stations.append(json.load(f))

    deleted = _delete_bundles_by_source("hideout")

    created = 0
    skipped = 0
    details = []

    for station in stations:
        name_zh = station.get("name", {}).get("zh-CN", station.get("id", ""))
        name_en = station.get("name", {}).get("en", station.get("id", ""))
        phase_bundles = []  # 收集各阶段数据，用于生成组合

        for lvl_data in station.get("levels", []):
            level = lvl_data.get("level", 0)
            req_items = lvl_data.get("requirementItemIds", [])

            if not req_items:
                skipped += 1
                continue

            items = [{"item_id": it["itemId"], "quantity": it["quantity"]} for it in req_items]
            bundle_name = f"{name_zh} Lv{level}"

            # 其它需求作为描述
            other = lvl_data.get("otherRequirements", [])
            desc_parts = []
            if other:
                desc_parts.append("额外需求: " + ", ".join(other))
            raw_desc = lvl_data.get("description", "")
            if isinstance(raw_desc, dict):
                raw_desc = raw_desc.get("zh-CN", "") or raw_desc.get("en", "")
            if raw_desc:
                desc_parts.append(raw_desc)
            description = " | ".join(desc_parts)

            bid, err = create_bundle(
                name=bundle_name,
                items=items,
                source="hideout",
                bundle_type="item",
                description=description,
            )
            if bid:
                created += 1
                alias_en = f"{name_en} Lv{level}"
                if alias_en != bundle_name:
                    add_bundle_alias(bid, alias_en)
                details.append(f"  + {bundle_name} ({len(items)} 个物品)")
                phase_bundles.append({"bid": bid, "items": items})
            else:
                logger.warning(f"创建 hideout 套餐失败: {bundle_name} - {err}")
                details.append(f"  ! {bundle_name}: {err}")

        # 生成组合套餐
        if len(phase_bundles) >= 2:
            combo_count = _generate_combos(phase_bundles, name_zh, name_en, "hideout")
            created += combo_count
            if combo_count:
                details.append(f"  + {name_zh} 组合 ×{combo_count}")

    logger.info(f"Hideout 套餐生成完成: 删除 {deleted}, 创建 {created}, 跳过 {skipped}")
    return {
        "deleted": deleted,
        "created": created,
        "skipped": skipped,
        "details": details,
    }


# ───────── Projects 套餐生成 ─────────

def generate_project_bundles() -> dict:
    """从 projects.json 生成系统套餐，先删除旧的 projects 套餐再全量重建"""
    proj_file = os.path.join(DATA_DIR, "projects", "projects.json")
    if not os.path.isfile(proj_file):
        logger.error(f"projects.json 不存在: {proj_file}")
        return {"created": 0, "deleted": 0, "skipped": 0, "error": "projects.json 不存在"}

    with open(proj_file, encoding="utf-8") as f:
        projects = json.load(f)

    deleted = _delete_bundles_by_source("projects")

    created = 0
    skipped = 0
    details = []

    for proj in projects:
        name_obj = proj.get("name", {})
        proj_zh = name_obj.get("zh-CN", "") if isinstance(name_obj, dict) else str(name_obj)
        proj_en = name_obj.get("en", "") if isinstance(name_obj, dict) else ""

        phases = proj.get("phases", [])
        phase_seq = 0  # 有物品的阶段计数
        phase_bundles = []  # 收集各阶段数据，用于生成组合
        for pi, phase in enumerate(phases):
            req_items = phase.get("requirementItemIds", [])
            if not req_items:
                skipped += 1
                continue

            phase_seq += 1
            phase_name_obj = phase.get("name", {})
            if isinstance(phase_name_obj, dict):
                phase_zh = phase_name_obj.get("zh-CN", "") or phase_name_obj.get("en", "")
                phase_en = phase_name_obj.get("en", "")
            else:
                phase_zh = str(phase_name_obj)
                phase_en = phase_zh

            items = [{"item_id": it["itemId"], "quantity": it["quantity"]} for it in req_items]
            bundle_name = f"{proj_zh} - {phase_seq}. {phase_zh}"

            # 其它需求作为描述
            other = phase.get("otherRequirements", [])
            desc = ""
            if other:
                desc = "额外需求: " + ", ".join(other)

            bid, err = create_bundle(
                name=bundle_name,
                items=items,
                source="projects",
                bundle_type="item",
                description=desc,
            )
            if bid:
                created += 1
                alias_en = f"{proj_en} - {phase_seq}. {phase_en}"
                if alias_en != bundle_name and alias_en.strip(" -"):
                    add_bundle_alias(bid, alias_en)
                details.append(f"  + {bundle_name} ({len(items)} 个物品)")
                phase_bundles.append({"bid": bid, "items": items})
            else:
                logger.warning(f"创建 projects 套餐失败: {bundle_name} - {err}")
                details.append(f"  ! {bundle_name}: {err}")

        # 生成组合套餐
        if len(phase_bundles) >= 2:
            combo_count = _generate_combos(phase_bundles, proj_zh, proj_en, "projects")
            created += combo_count
            if combo_count:
                details.append(f"  + {proj_zh} 组合 ×{combo_count}")

    logger.info(f"Projects 套餐生成完成: 删除 {deleted}, 创建 {created}, 跳过 {skipped}")
    return {
        "deleted": deleted,
        "created": created,
        "skipped": skipped,
        "details": details,
    }


# ───────── 成本计算 ─────────

def calc_bundle_cost(bundle_id: int) -> dict:
    logger.debug(f"计算套餐成本: id={bundle_id}")
    with get_conn() as conn:
        bundle = conn.execute(
            "SELECT type, price FROM bundles WHERE id=?", (bundle_id,)
        ).fetchone()
        if not bundle:
            return {"total_cost": 0, "breakdown": []}

        items = conn.execute(
            "SELECT item_id, MAX(quantity) as quantity FROM bundle_items WHERE bundle_id=? GROUP BY item_id",
            (bundle_id,)
        ).fetchall()
        prices = {
            r["item_id"]: r["sell_price"]
            for r in conn.execute("SELECT item_id, sell_price FROM item_prices").fetchall()
        }

    names     = load_display_names()
    total     = 0
    breakdown = []
    for it in items:
        unit_price = prices.get(it["item_id"], 0)
        subtotal   = unit_price * it["quantity"]
        total     += subtotal
        breakdown.append({
            "item_id":    it["item_id"],
            "name_zh":    names.get(it["item_id"], it["item_id"]),
            "quantity":   it["quantity"],
            "unit_price": unit_price,
            "subtotal":   subtotal,
        })

    # 服务型/混合型：加上套餐售价
    bundle_price = bundle["price"] or 0
    if bundle["type"] in ("service", "mixed") and bundle_price:
        total += bundle_price

    logger.debug(f"套餐 id={bundle_id} 成本: {total}")
    return {"total_cost": total, "breakdown": breakdown, "service_price": bundle_price}


