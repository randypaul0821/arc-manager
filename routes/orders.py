"""
订单路由
"""
import logging
from flask import Blueprint, request, jsonify
from services.match_service import parse_and_match
from services.order_service import (
    get_orders, get_order,
    create_order, update_order, delete_order,
    complete_order, cancel_order,
    get_item_prices,
    update_order_item_ready, update_order_item_price,
    replace_order_item, rematch_order_item,
)
from services.shortage_service import (
    get_shortage_list, get_instock_list, get_restock_advice,
)
from services.order_report_service import (
    get_stats, export_daily_report,
)

logger = logging.getLogger("routes.orders")

orders_bp = Blueprint("orders", __name__)


@orders_bp.route("/api/orders", methods=["GET"])
def api_get_orders():
    status      = request.args.get("status", "")
    customer_id = request.args.get("customer_id", 0, type=int)
    days        = request.args.get("days", 0, type=int)
    logger.info(f"GET /api/orders status='{status}' customer_id={customer_id} days={days}")
    return jsonify(get_orders(status, customer_id, days))


@orders_bp.route("/api/orders/<int:oid>", methods=["GET"])
def api_get_order(oid):
    logger.info(f"GET /api/orders/{oid}")
    order = get_order(oid)
    if not order:
        return jsonify({"error": "订单不存在"}), 404
    return jsonify(order)


@orders_bp.route("/api/orders", methods=["POST"])
def api_create_order():
    d     = request.json or {}
    items = d.get("items", [])
    logger.info(f"POST /api/orders items={len(items)} customer='{d.get('customer_name', '')}'")
    if not items:
        return jsonify({"error": "订单必须包含物品"}), 400
    oid, err = create_order(
        items,
        raw_text=d.get("raw_text", ""),
        customer_name=d.get("customer_name", "")
    )
    if err:
        return jsonify({"error": err}), 400
    return jsonify({"ok": True, "id": oid})


@orders_bp.route("/api/orders/<int:oid>", methods=["PUT"])
def api_update_order(oid):
    logger.info(f"PUT /api/orders/{oid}")
    ok, err = update_order(oid, request.json or {})
    if not ok:
        return jsonify({"error": err}), 400
    return jsonify({"ok": True})


@orders_bp.route("/api/orders/<int:oid>", methods=["DELETE"])
def api_delete_order(oid):
    logger.info(f"DELETE /api/orders/{oid}")
    delete_order(oid)
    return jsonify({"ok": True})


@orders_bp.route("/api/orders/<int:oid>/complete", methods=["POST"])
def api_complete_order(oid):
    d = request.json or {}
    sync_ids = d.get("sync_account_ids", [])
    logger.info(f"POST /api/orders/{oid}/complete sync_accounts={sync_ids}")
    ok, result = complete_order(oid, sync_account_ids=sync_ids)
    if not ok:
        return jsonify({"error": result}), 400
    return jsonify({"ok": True, "synced_accounts": result})


@orders_bp.route("/api/orders/<int:oid>/cancel", methods=["POST"])
def api_cancel_order(oid):
    logger.info(f"POST /api/orders/{oid}/cancel")
    cancel_order(oid)
    return jsonify({"ok": True})


@orders_bp.route("/api/order-items/<int:iid>/ready", methods=["PUT"])
def api_toggle_ready(iid):
    ready = int((request.json or {}).get("ready", 0))
    logger.info(f"PUT /api/order-items/{iid}/ready ready={ready}")
    update_order_item_ready(iid, ready)
    return jsonify({"ok": True})


@orders_bp.route("/api/order-items/<int:iid>/price", methods=["PUT"])
def api_update_item_price(iid):
    d = request.json or {}
    cost_price = d.get("cost_price")
    sell_price = d.get("sell_price")
    logger.info(f"PUT /api/order-items/{iid}/price cost={cost_price} sell={sell_price}")
    ok = update_order_item_price(iid, cost_price, sell_price)
    if not ok:
        return jsonify({"error": "更新失败"}), 400
    return jsonify({"ok": True})


@orders_bp.route("/api/order-items/<int:iid>/item", methods=["PUT"])
def api_replace_item(iid):
    new_item_id = (request.json or {}).get("item_id", "").strip()
    logger.info(f"PUT /api/order-items/{iid}/item new_item_id={new_item_id}")
    if not new_item_id:
        return jsonify({"error": "item_id 不能为空"}), 400
    ok = replace_order_item(iid, new_item_id)
    if not ok:
        return jsonify({"error": "替换失败"}), 400
    return jsonify({"ok": True})


@orders_bp.route("/api/order-items/<int:iid>/rematch", methods=["POST"])
def api_rematch_item(iid):
    """用原始名称重新跑匹配，返回候选列表供用户选择"""
    logger.info(f"POST /api/order-items/{iid}/rematch")
    result = rematch_order_item(iid)
    if "error" in result:
        return jsonify(result), 400
    return jsonify(result)


@orders_bp.route("/api/orders/shortage", methods=["GET"])
def api_shortage():
    logger.info("GET /api/orders/shortage")
    return jsonify(get_shortage_list())


@orders_bp.route("/api/orders/instock", methods=["GET"])
def api_instock():
    logger.info("GET /api/orders/instock")
    return jsonify(get_instock_list())


@orders_bp.route("/api/item-prices", methods=["GET"])
def api_item_prices():
    return jsonify(get_item_prices())


@orders_bp.route("/api/stats", methods=["GET"])
def api_stats():
    date_from = request.args.get("from", "2000-01-01")
    date_to   = request.args.get("to",   "2099-12-31")
    logger.info(f"GET /api/stats from={date_from} to={date_to}")
    return jsonify(get_stats(date_from, date_to))


# ───────── 日报导出 ─────────
@orders_bp.route("/api/orders/export", methods=["GET"])
def api_export_daily():
    date_from = request.args.get("from", "")
    date_to = request.args.get("to", "")
    price_type = request.args.get("type", "sell")  # sell=售价给甲方, cost=成本给自己
    logger.info(f"GET /api/orders/export from={date_from} to={date_to} type={price_type}")
    if not date_from or not date_to:
        return jsonify({"error": "需要 from 和 to 日期参数"}), 400
    text = export_daily_report(date_from, date_to, price_type)
    return jsonify({"text": text})


# ───────── 订单解析（修复：原版缺少路由装饰器）─────────
@orders_bp.route("/api/orders/parse", methods=["POST"])
def api_parse_order():
    text = (request.json or {}).get("text", "").strip()
    logger.info(f"POST /api/orders/parse text_len={len(text)}")
    if not text:
        return jsonify({"error": "文本为空"}), 400
    result = parse_and_match(text)
    orders = result.get('orders', [])
    total_items = sum(len(o.get('items', [])) for o in orders)
    logger.info(f"解析结果: {len(orders)} 个订单, {total_items} 个物品")
    return jsonify(result)


# ───────── AI 补货建议 ─────────
@orders_bp.route("/api/restock-advice", methods=["GET"])
def api_restock_advice():
    days = request.args.get("days", 14, type=int)
    restock_days = request.args.get("restock_days", 1, type=int)
    logger.info(f"GET /api/restock-advice days={days} restock_days={restock_days}")
    return jsonify(get_restock_advice(days, restock_days))