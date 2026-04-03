"""
物品库路由：只做参数校验和调用 service，不含业务逻辑
"""
import os
import logging
from flask import Blueprint, request, jsonify, send_file
from services.item_service import (
    search_items, get_item,
    update_name, reset_name,
    get_aliases, add_alias, update_alias, delete_alias,
    set_starred, set_alert,
    get_image_path, load_overrides, DATA_DIR
)
from config import APP_DIR

logger = logging.getLogger("routes.items")
items_bp = Blueprint("items", __name__)

# ───────── 物品列表 / 详情 ─────────

@items_bp.route("/api/items", methods=["GET"])
def api_get_items():
    q      = request.args.get("q", "").strip()
    rarity = request.args.get("rarity", "").strip()
    type_  = request.args.get("type", "").strip()
    logger.info(f"GET /api/items q='{q}' rarity='{rarity}' type='{type_}'")
    return jsonify(search_items(q, rarity, type_))

@items_bp.route("/api/items/<path:item_id>", methods=["GET"])
def api_get_item(item_id):
    logger.info(f"GET /api/items/{item_id}")
    item = get_item(item_id)
    if not item:
        return jsonify({"error": "物品不存在"}), 404
    return jsonify(item)

# ───────── 改名 ─────────

@items_bp.route("/api/items/<path:item_id>/name", methods=["PUT"])
def api_update_name(item_id):
    name_zh = (request.json or {}).get("name_zh", "").strip()
    logger.info(f"PUT /api/items/{item_id}/name → '{name_zh}'")
    if not name_zh:
        return jsonify({"error": "name_zh 不能为空"}), 400
    update_name(item_id, name_zh)
    return jsonify({"ok": True})

@items_bp.route("/api/items/<path:item_id>/name", methods=["DELETE"])
def api_reset_name(item_id):
    logger.info(f"DELETE /api/items/{item_id}/name")
    reset_name(item_id)
    return jsonify({"ok": True})

# ───────── 别名 ─────────

@items_bp.route("/api/items/<path:item_id>/aliases", methods=["GET"])
def api_get_aliases(item_id):
    logger.info(f"GET /api/items/{item_id}/aliases")
    return jsonify(get_aliases(item_id))

@items_bp.route("/api/items/<path:item_id>/aliases", methods=["POST"])
def api_add_alias(item_id):
    alias = (request.json or {}).get("alias", "").strip()
    logger.info(f"POST /api/items/{item_id}/aliases alias='{alias}'")
    if not alias:
        return jsonify({"error": "alias 不能为空"}), 400
    ok, err = add_alias(item_id, alias)
    if not ok:
        return jsonify({"error": err}), 400
    return jsonify({"ok": True})

@items_bp.route("/api/aliases/<int:alias_id>", methods=["PUT"])
def api_update_alias(alias_id):
    alias = (request.json or {}).get("alias", "").strip()
    logger.info(f"PUT /api/aliases/{alias_id} alias='{alias}'")
    if not alias:
        return jsonify({"error": "alias 不能为空"}), 400
    ok, err = update_alias(alias_id, alias)
    if not ok:
        return jsonify({"error": err}), 400
    return jsonify({"ok": True})

@items_bp.route("/api/aliases/<int:alias_id>", methods=["DELETE"])
def api_delete_alias(alias_id):
    logger.info(f"DELETE /api/aliases/{alias_id}")
    delete_alias(alias_id)
    return jsonify({"ok": True})

# ───────── 重点关注 / 告警 ─────────

@items_bp.route("/api/items/<path:item_id>/star", methods=["PUT"])
def api_set_starred(item_id):
    starred = (request.json or {}).get("starred", False)
    logger.info(f"PUT /api/items/{item_id}/star starred={starred}")
    set_starred(item_id, starred)
    return jsonify({"ok": True})

@items_bp.route("/api/items/<path:item_id>/alert", methods=["PUT"])
def api_set_alert(item_id):
    d       = request.json or {}
    min_qty = int(d.get("min_qty", 0))
    enabled = bool(d.get("enabled", False))
    logger.info(f"PUT /api/items/{item_id}/alert min_qty={min_qty} enabled={enabled}")
    set_alert(item_id, min_qty, enabled)
    return jsonify({"ok": True})

# ───────── 图片 ─────────

@items_bp.route("/api/items/unmatched", methods=["GET"])
def api_get_unmatched():
    """返回未匹配中文名的物品列表"""
    logger.info("GET /api/items/unmatched")
    import json as _json
    unmatched_file = os.path.join(APP_DIR, "data", "unmatched_items.json")
    logger.debug(f"unmatched 文件路径: {unmatched_file}, 存在: {os.path.isfile(unmatched_file)}")
    if not os.path.isfile(unmatched_file):
        return jsonify([])
    try:
        with open(unmatched_file, encoding="utf-8") as f:
            data = _json.load(f)
        overrides = load_overrides()
        override_ids = {iid for iid, ov in overrides.items() if ov.get("name_zh")}
        result = [i for i in data if i["item_id"] not in override_ids]
        logger.info(f"unmatched: 总 {len(data)} 个, 过滤后 {len(result)} 个")
        return jsonify(result)
    except Exception as e:
        logger.error(f"读取 unmatched 文件失败: {e}", exc_info=True)
        return jsonify({"error": str(e)}), 500

@items_bp.route("/api/items/<path:item_id>/image", methods=["GET"])
def api_get_image(item_id):
    logger.debug(f"GET /api/items/{item_id}/image")
    from flask import redirect, make_response
    path = get_image_path(item_id)
    if path:
        if isinstance(path, str) and path.startswith("http"):
            return redirect(path)
        import os
        mtime = str(int(os.path.getmtime(path)))
        resp = make_response(send_file(path))
        resp.headers['Cache-Control'] = 'public, max-age=31536000, immutable'  # 长期缓存
        resp.headers['ETag'] = mtime
        return resp
    return "", 204

_ALLOWED_IMAGE_EXTS = {'.png', '.jpg', '.jpeg', '.webp', '.gif'}
_ALLOWED_IMAGE_MIMES = {'image/png', 'image/jpeg', 'image/webp', 'image/gif'}


@items_bp.route("/api/items/<path:item_id>/image", methods=["POST"])
def api_upload_image(item_id):
    logger.info(f"POST /api/items/{item_id}/image")
    if "file" not in request.files:
        return jsonify({"error": "没有文件"}), 400
    f    = request.files["file"]
    ext  = os.path.splitext(f.filename or '')[1].lower()
    if ext not in _ALLOWED_IMAGE_EXTS and f.mimetype not in _ALLOWED_IMAGE_MIMES:
        return jsonify({"error": "只支持 PNG/JPG/WebP/GIF 图片"}), 400
    dest = os.path.join(APP_DIR, "custom_images")
    os.makedirs(dest, exist_ok=True)
    save_path = os.path.join(dest, f"{item_id}.png")
    f.save(save_path)
    logger.info(f"图片已保存: {save_path}")
    return jsonify({"ok": True, "url": f"/api/items/{item_id}/image"})


