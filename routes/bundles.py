"""
套餐路由
"""
from flask import Blueprint, request, jsonify
from services.bundle_service import (
    get_all_bundles, get_bundle_with_items, get_bundle_sources,
    create_bundle, update_bundle, delete_bundle,
    add_bundle_alias, update_bundle_alias, delete_bundle_alias,
    calc_bundle_cost, cleanup_duplicate_items,
    generate_hideout_bundles, generate_project_bundles
)

bundles_bp = Blueprint("bundles", __name__)


@bundles_bp.route("/api/bundles", methods=["GET"])
def api_get_bundles():
    source = request.args.get("source", "").strip()
    return jsonify(get_all_bundles(source))


@bundles_bp.route("/api/bundles/sources", methods=["GET"])
def api_get_sources():
    return jsonify(get_bundle_sources())


@bundles_bp.route("/api/bundles/<int:bid>", methods=["GET"])
def api_get_bundle(bid):
    b = get_bundle_with_items(bid)
    if not b:
        return jsonify({"error": "套餐不存在"}), 404
    return jsonify(b)


@bundles_bp.route("/api/bundles", methods=["POST"])
def api_create_bundle():
    d     = request.json or {}
    name  = d.get("name", "").strip()
    items = d.get("items", [])
    bundle_type = d.get("type", "item")
    price = d.get("price")
    description = d.get("description", "")
    bid, err = create_bundle(name, items, bundle_type=bundle_type,
                             price=price, description=description)
    if err:
        return jsonify({"error": err}), 400
    return jsonify({"ok": True, "id": bid})


@bundles_bp.route("/api/bundles/<int:bid>", methods=["PUT"])
def api_update_bundle(bid):
    d     = request.json or {}
    name  = d.get("name", "").strip()
    items = d.get("items", [])
    bundle_type = d.get("type", "item")
    price = d.get("price")
    description = d.get("description", "")
    ok, err = update_bundle(bid, name, items, bundle_type=bundle_type,
                            price=price, description=description)
    if not ok:
        return jsonify({"error": err}), 400
    return jsonify({"ok": True})


@bundles_bp.route("/api/bundles/<int:bid>", methods=["DELETE"])
def api_delete_bundle(bid):
    delete_bundle(bid)
    return jsonify({"ok": True})


@bundles_bp.route("/api/bundles/<int:bid>/aliases", methods=["POST"])
def api_add_bundle_alias(bid):
    alias = (request.json or {}).get("alias", "").strip()
    ok, err = add_bundle_alias(bid, alias)
    if not ok:
        return jsonify({"error": err}), 400
    return jsonify({"ok": True})


@bundles_bp.route("/api/bundle-aliases/<int:aid>", methods=["PUT"])
def api_update_bundle_alias(aid):
    alias = (request.json or {}).get("alias", "").strip()
    ok, err = update_bundle_alias(aid, alias)
    if not ok:
        return jsonify({"error": err}), 400
    return jsonify({"ok": True})


@bundles_bp.route("/api/bundle-aliases/<int:aid>", methods=["DELETE"])
def api_delete_bundle_alias(aid):
    delete_bundle_alias(aid)
    return jsonify({"ok": True})


@bundles_bp.route("/api/bundles/<int:bid>/cost", methods=["GET"])
def api_bundle_cost(bid):
    return jsonify(calc_bundle_cost(bid))


@bundles_bp.route("/api/cleanup/bundle-duplicates", methods=["POST"])
def api_cleanup_bundle_duplicates():
    """一次性清理套餐中的重复物品行"""
    cleaned = cleanup_duplicate_items()
    return jsonify({"ok": True, "cleaned": cleaned})


@bundles_bp.route("/api/bundles/generate-hideout", methods=["POST"])
def api_generate_hideout_bundles():
    """从 hideout 数据生成系统套餐（删除旧的 + 全量重建）"""
    result = generate_hideout_bundles()
    return jsonify({"ok": True, **result})


@bundles_bp.route("/api/bundles/generate-projects", methods=["POST"])
def api_generate_project_bundles():
    """从 projects.json 生成任务套餐（删除旧的 + 全量重建）"""
    result = generate_project_bundles()
    return jsonify({"ok": True, **result})