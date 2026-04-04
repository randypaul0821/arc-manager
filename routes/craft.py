"""
合成计算路由
"""
from flask import Blueprint, request, jsonify
from services.craft_service import calc_craftable_with_stock, get_recipe_tree
from services.inventory_service import get_inventory

craft_bp = Blueprint("craft", __name__)


@craft_bp.route("/api/craft/craftable", methods=["GET"])
def api_craftable():
    """
    计算各账号对某物品的可合成数量。

    Query params:
        item_id: 目标物品 ID（必需）

    Returns:
        {
            "item_id": str,
            "accounts": [
                {"account_id": int, "account_name": str, "stock": int, "craftable": int, "total": int}
            ],
            "recipe_tree": {...} | null
        }
    """
    item_id = request.args.get("item_id", "").strip()
    if not item_id:
        return jsonify({"error": "item_id required"}), 400

    # 获取全量库存（含各账号明细）
    all_inv = get_inventory()

    # 按账号分组库存
    account_inventories = {}  # {account_id: {item_id: qty}}
    account_names = {}
    for item in all_inv:
        for acc in item.get("accounts", []):
            aid = acc["account_id"]
            account_names[aid] = acc["account_name"]
            if aid not in account_inventories:
                account_inventories[aid] = {}
            account_inventories[aid][item["item_id"]] = \
                account_inventories[aid].get(item["item_id"], 0) + acc["quantity"]

    # 计算每个账号的可合成数量
    results = []
    for aid, inv_map in account_inventories.items():
        info = calc_craftable_with_stock(item_id, inv_map)
        results.append({
            "account_id": aid,
            "account_name": account_names[aid],
            "stock": info["stock"],
            "craftable": info["craftable"],
            "total": info["total"],
        })

    # 合成树
    tree = get_recipe_tree(item_id)

    return jsonify({
        "item_id": item_id,
        "accounts": results,
        "recipe_tree": tree,
    })
