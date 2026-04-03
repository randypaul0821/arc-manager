"""
物品服务层：物品查询、改名、别名管理
数据来源：arcraiders-data-main（只读） + item_overrides/item_aliases（DB）
"""
import os, json, re, threading, logging
from database import get_conn
from config import DATA_DIR, APP_DIR

logger = logging.getLogger("item_service")

# ───────── 物品基础数据（只读缓存 + 线程锁）─────────

_item_cache: dict = {}
_cache_lock = threading.Lock()

CACHE_FILE = os.path.join(APP_DIR, "data", "items_cache.json")


def load_item_data() -> dict:
    """加载物品 JSON 数据，带双重检查锁的线程安全缓存。"""
    global _item_cache
    if _item_cache:
        logger.debug(f"命中缓存，共 {len(_item_cache)} 个物品")
        return _item_cache

    with _cache_lock:
        if _item_cache:
            logger.debug("等锁期间缓存已就绪")
            return _item_cache

        items_dir = os.path.join(DATA_DIR, "items")
        logger.info(f"开始加载物品数据，目录: {items_dir}")
        logger.info(f"目录存在: {os.path.isdir(items_dir)}")
        result = {}
        if not os.path.isdir(items_dir):
            logger.warning(f"物品目录不存在: {items_dir}")
            _item_cache = result
            return result

        files = [f for f in os.listdir(items_dir) if f.endswith(".json")]
        logger.info(f"发现 {len(files)} 个 JSON 文件")
        load_errors = 0
        for fname in files:
            try:
                with open(os.path.join(items_dir, fname), encoding="utf-8") as f:
                    d = json.load(f)
                item_id = d.get("id") or fname[:-5]
                name    = d.get("name", {})
                icon_url = d.get("imageFilename", "")
                result[item_id] = {
                    "item_id":  item_id,
                    "name_zh":  name.get("zh-CN") or name.get("zh-TW") or name.get("en") or item_id,
                    "name_en":  name.get("en") or item_id,
                    "rarity":   d.get("rarity", ""),
                    "type":     d.get("type", ""),
                    "is_weapon": d.get("isWeapon", False),
                    "craft_bench": d.get("craftBench", ""),
                    "value":    d.get("value", 0),
                    "icon_url": icon_url,
                    "recipe":   d.get("recipe", {}),
                    "recycle":  d.get("recycle", {}),
                }
            except Exception as e:
                load_errors += 1
                logger.warning(f"加载物品文件失败 {fname}: {e}")
                continue

        _item_cache = result
        logger.info(f"物品数据加载完毕: 成功 {len(result)} 个, 失败 {load_errors} 个")
        return result


def clear_item_cache():
    """清除缓存，下次访问时重新加载。线程安全。"""
    global _item_cache
    with _cache_lock:
        old_size = len(_item_cache)
        _item_cache = {}
        logger.info(f"物品缓存已清除（原有 {old_size} 条）")


# ───────── 覆盖层（DB）─────────

def load_overrides() -> dict:
    """返回 {item_id: {name_zh, is_starred, alert_min, alert_enabled}}"""
    try:
        with get_conn() as conn:
            rows = conn.execute("SELECT * FROM item_overrides").fetchall()
            logger.debug(f"加载 {len(rows)} 条 item_overrides")
            return {r["item_id"]: dict(r) for r in rows}
    except Exception as e:
        logger.error("加载 item_overrides 失败", exc_info=True)
        return {}


def load_aliases_map() -> dict:
    """返回 {item_id: [{id, alias}, ...]}"""
    try:
        with get_conn() as conn:
            rows = conn.execute(
                "SELECT id, item_id, alias FROM item_aliases ORDER BY id"
            ).fetchall()
            logger.debug(f"加载 {len(rows)} 条 item_aliases")
        result: dict = {}
        for r in rows:
            if r["item_id"] not in result:
                result[r["item_id"]] = []
            result[r["item_id"]].append({"id": r["id"], "alias": r["alias"]})
        return result
    except Exception as e:
        logger.error("加载 item_aliases 失败", exc_info=True)
        return {}


def load_display_names() -> dict:
    """返回 {item_id: name_zh}，优先用改名，否则用 JSON 原始名"""
    items_db  = load_item_data()
    overrides = load_overrides()
    result = {}
    for item_id, meta in items_db.items():
        ov = overrides.get(item_id, {})
        result[item_id] = ov.get("name_zh") or meta["name_zh"]
    for item_id, ov in overrides.items():
        if item_id not in result and ov.get("name_zh"):
            result[item_id] = ov["name_zh"]
    logger.debug(f"load_display_names: {len(result)} 条")
    return result


def load_english_names() -> dict:
    """返回 {item_id: name_en}"""
    items_db = load_item_data()
    return {item_id: meta.get("name_en", item_id) for item_id, meta in items_db.items()}


def load_search_aliases() -> dict:
    """返回 {alias_lower: item_id}，用于订单模糊匹配"""
    try:
        with get_conn() as conn:
            rows = conn.execute("SELECT item_id, alias FROM item_aliases").fetchall()
            result = {r["alias"].lower().strip(): r["item_id"] for r in rows}
            logger.debug(f"load_search_aliases: {len(result)} 条")
            return result
    except Exception as e:
        logger.error("load_search_aliases 失败", exc_info=True)
        return {}


# ───────── 查询 ─────────

def search_items(q: str = "", rarity: str = "", type_: str = "") -> list:
    logger.info(f"搜索物品: q='{q}', rarity='{rarity}', type='{type_}'")
    items_db  = load_item_data()
    overrides = load_overrides()
    aliases   = load_aliases_map()

    result = []
    for item_id, meta in items_db.items():
        ov       = overrides.get(item_id, {})
        name_zh  = ov.get("name_zh") or meta["name_zh"]
        alias_objs = aliases.get(item_id, [])

        if rarity and meta["rarity"] != rarity:
            continue
        if type_ and meta["type"] != type_:
            continue
        if q:
            q_lower = q.lower()
            hit = (q_lower in name_zh.lower() or
                   q_lower in meta["name_zh"].lower() or
                   q_lower in meta["name_en"].lower() or
                   q_lower in item_id.replace('_', ' ') or
                   any(q_lower in a["alias"].lower() for a in alias_objs))
            if not hit:
                continue

        result.append(_build_item(item_id, meta, ov, alias_objs))

    result.sort(key=lambda x: x["name_zh"])
    logger.info(f"搜索结果: {len(result)} 个物品")
    return result


def get_item(item_id: str) -> dict | None:
    logger.info(f"查询物品: {item_id}")
    items_db  = load_item_data()
    meta      = items_db.get(item_id)
    if not meta:
        logger.warning(f"物品不存在: {item_id}")
        return None
    overrides  = load_overrides()
    aliases    = load_aliases_map()
    ov         = overrides.get(item_id, {})
    alias_objs = aliases.get(item_id, [])
    return _build_item(item_id, meta, ov, alias_objs)


def _build_item(item_id, meta, ov, alias_list) -> dict:
    return {
        "item_id":         item_id,
        "name_zh":         ov.get("name_zh") or meta["name_zh"],
        "name_zh_original": meta["name_zh"],
        "name_en":         meta["name_en"],
        "rarity":          meta["rarity"],
        "type":            meta["type"],
        "is_weapon":       meta.get("is_weapon", False),
        "craft_bench":     meta.get("craft_bench", ""),
        "value":           meta.get("value", 0),
        "image_url":       f"/api/items/{item_id}/image",
        "is_starred":      ov.get("is_starred", 0),
        "alert_min":       ov.get("alert_min", 0),
        "alert_enabled":   ov.get("alert_enabled", 0),
        "aliases":         alias_list,
    }


# ───────── 改名 ─────────

def update_name(item_id: str, name_zh: str) -> bool:
    logger.info(f"改名: {item_id} → {name_zh}")
    try:
        with get_conn() as conn:
            conn.execute(
                "INSERT INTO item_overrides (item_id, name_zh) VALUES (?, ?) "
                "ON CONFLICT(item_id) DO UPDATE SET name_zh=excluded.name_zh, updated_at=datetime('now')",
                (item_id, name_zh)
            )
        logger.info(f"改名成功: {item_id}")
        return True
    except Exception as e:
        logger.error(f"改名失败 {item_id}", exc_info=True)
        return False


def reset_name(item_id: str) -> bool:
    logger.info(f"重置名称: {item_id}")
    try:
        with get_conn() as conn:
            conn.execute(
                "UPDATE item_overrides SET name_zh=NULL, updated_at=datetime('now') WHERE item_id=?",
                (item_id,)
            )
        logger.info(f"名称已重置: {item_id}")
        return True
    except Exception as e:
        logger.error(f"重置名称失败 {item_id}", exc_info=True)
        return False


# ───────── 别名 ─────────

def get_aliases(item_id: str) -> list:
    logger.debug(f"查询别名: {item_id}")
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, alias FROM item_aliases WHERE item_id=? ORDER BY id",
            (item_id,)
        ).fetchall()
        logger.debug(f"别名数量: {len(rows)}")
        return [{"id": r["id"], "alias": r["alias"]} for r in rows]


def add_alias(item_id: str, alias: str) -> tuple[bool, str]:
    alias = alias.strip()
    logger.info(f"添加别名: item_id={item_id}, alias={alias}")
    if not alias:
        return False, "别名不能为空"
    try:
        with get_conn() as conn:
            conn.execute(
                "INSERT INTO item_aliases (item_id, alias) VALUES (?, ?)",
                (item_id, alias)
            )
            logger.info(f"别名添加成功: {item_id} ← {alias}")
            return True, ""
    except Exception as e:
        err = "别名已存在" if "UNIQUE" in str(e) else str(e)
        logger.warning(f"添加别名失败: {err}")
        return False, err


def update_alias(alias_id: int, alias: str) -> tuple[bool, str]:
    alias = alias.strip()
    logger.info(f"更新别名: alias_id={alias_id}, new_alias={alias}")
    if not alias:
        return False, "别名不能为空"
    try:
        with get_conn() as conn:
            conn.execute("UPDATE item_aliases SET alias=? WHERE id=?", (alias, alias_id))
            logger.info(f"别名更新成功: id={alias_id}")
            return True, ""
    except Exception as e:
        err = "别名已存在" if "UNIQUE" in str(e) else str(e)
        logger.warning(f"更新别名失败: {err}")
        return False, err


def delete_alias(alias_id: int) -> bool:
    logger.info(f"删除别名: id={alias_id}")
    try:
        with get_conn() as conn:
            conn.execute("DELETE FROM item_aliases WHERE id=?", (alias_id,))
            logger.info(f"别名已删除: id={alias_id}")
            return True
    except Exception as e:
        logger.error(f"删除别名失败 id={alias_id}", exc_info=True)
        return False


# ───────── 重点关注 / 告警配置 ─────────

def set_starred(item_id: str, starred: bool) -> bool:
    logger.info(f"设置关注: {item_id} → starred={starred}")
    return _upsert_override(item_id, {"is_starred": 1 if starred else 0})


def set_alert(item_id: str, min_qty: int, enabled: bool) -> bool:
    logger.info(f"设置告警: {item_id} → min_qty={min_qty}, enabled={enabled}")
    return _upsert_override(item_id, {"alert_min": min_qty, "alert_enabled": 1 if enabled else 0})


_OVERRIDE_FIELDS = {"name_zh", "is_starred", "alert_min", "alert_enabled"}


def _upsert_override(item_id: str, fields: dict) -> bool:
    invalid = set(fields) - _OVERRIDE_FIELDS
    if invalid:
        logger.error(f"_upsert_override 非法字段: {invalid}")
        return False
    try:
        with get_conn() as conn:
            keys   = ", ".join(fields.keys())
            values = list(fields.values())
            update = ", ".join(f"{k}=excluded.{k}" for k in fields)
            conn.execute(
                f"INSERT INTO item_overrides (item_id, {keys}) VALUES (?, {','.join('?'*len(values))}) "
                f"ON CONFLICT(item_id) DO UPDATE SET {update}, updated_at=datetime('now')",
                [item_id] + values
            )
            logger.debug(f"_upsert_override 成功: {item_id}, {fields}")
            return True
    except Exception as e:
        logger.error(f"_upsert_override 失败 {item_id}", exc_info=True)
        return False


# ───────── 图片 ─────────

def get_image_path(item_id: str):
    logger.debug(f"查找图片: {item_id}")
    # 1. 用户自定义上传
    custom_dir = os.path.join(APP_DIR, "custom_images")
    custom = os.path.join(custom_dir, f"{item_id}.png")
    if os.path.isfile(custom):
        logger.debug(f"使用自定义图片: {custom}")
        return custom

    # 2. 本地 arcraiders-data 图片
    for ext in ("png", "jpg", "webp"):
        for folder in ("items_ingame", "workshop"):
            path = os.path.join(DATA_DIR, "images", folder, f"{item_id}.{ext}")
            if os.path.isfile(path):
                logger.debug(f"使用本地图片: {path}")
                return path

    # 3. MetaForge CDN
    items_db = load_item_data()
    meta     = items_db.get(item_id, {})
    icon_url = meta.get("icon_url", "")
    if icon_url and icon_url.startswith("http"):
        cached = os.path.join(custom_dir, f"{item_id}.png")
        try:
            import requests as _req
            os.makedirs(custom_dir, exist_ok=True)
            logger.debug(f"尝试从 CDN 下载图片: {icon_url}")
            resp = _req.get(icon_url, timeout=8)
            if resp.status_code == 200:
                with open(cached, "wb") as f:
                    f.write(resp.content)
                logger.debug(f"CDN 图片已缓存: {cached}")
                return cached
        except Exception as e:
            logger.warning(f"CDN 图片下载失败 {item_id}: {e}")
        return icon_url

    logger.debug(f"未找到图片: {item_id}")
    return None