"""
库存路由
"""
from flask import Blueprint, request, jsonify
from services.inventory_service import get_inventory, search_inventory

inventory_bp = Blueprint("inventory", __name__)


@inventory_bp.route("/api/inventory", methods=["GET"])
def api_get_inventory():
    account_id = request.args.get("account_id", type=int)
    q          = request.args.get("q", "").strip()
    if q:
        return jsonify(search_inventory(q))
    return jsonify(get_inventory(account_id))