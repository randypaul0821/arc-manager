"""
客户路由
"""
from flask import Blueprint, request, jsonify
from services.customer_service import (
    get_customers, get_customer,
    update_customer, delete_customer
)

customers_bp = Blueprint("customers", __name__)


@customers_bp.route("/api/customers", methods=["GET"])
def api_get_customers():
    days  = request.args.get("days", 7, type=int)
    limit = request.args.get("limit", 100, type=int)
    return jsonify(get_customers(days, limit))


@customers_bp.route("/api/customers/<int:cid>", methods=["GET"])
def api_get_customer(cid):
    c = get_customer(cid)
    if not c:
        return jsonify({"error": "客户不存在"}), 404
    return jsonify(c)


@customers_bp.route("/api/customers/<int:cid>", methods=["PUT"])
def api_update_customer(cid):
    note = (request.json or {}).get("note", "")
    update_customer(cid, note)
    return jsonify({"ok": True})


@customers_bp.route("/api/customers/<int:cid>", methods=["DELETE"])
def api_delete_customer(cid):
    delete_customer(cid)
    return jsonify({"ok": True})
