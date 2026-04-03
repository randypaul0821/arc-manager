"""重点关注路由"""
import logging
from flask import Blueprint, request, jsonify

logger = logging.getLogger("routes.watchlist")
watchlist_bp = Blueprint("watchlist", __name__)


@watchlist_bp.route("/api/watch/rules/<int:account_id>", methods=["GET"])
def api_get_rules(account_id):
    from services.watchlist_service import get_rules
    return jsonify(get_rules(account_id))


@watchlist_bp.route("/api/watch/rules/<int:account_id>", methods=["POST"])
def api_add_rule(account_id):
    data = request.json or {}
    from services.watchlist_service import add_rule
    result = add_rule(
        account_id,
        data.get("rule_type", "item"),
        data.get("target_id", ""),
        data.get("threshold", 1)
    )
    return jsonify(result)


@watchlist_bp.route("/api/watch/rules/<int:account_id>/batch", methods=["POST"])
def api_add_rules_batch(account_id):
    data = request.json or {}
    from services.watchlist_service import add_rules_batch
    return jsonify(add_rules_batch(account_id, data.get("rules", [])))


@watchlist_bp.route("/api/watch/rule/<int:rule_id>", methods=["PUT"])
def api_update_rule(rule_id):
    data = request.json or {}
    from services.watchlist_service import update_rule
    ok = update_rule(rule_id, data.get("threshold", 1))
    return jsonify({"ok": ok})


@watchlist_bp.route("/api/watch/rule/<int:rule_id>", methods=["DELETE"])
def api_delete_rule(rule_id):
    from services.watchlist_service import delete_rule
    ok = delete_rule(rule_id)
    return jsonify({"ok": ok})


@watchlist_bp.route("/api/watch/alerts", methods=["GET"])
def api_check_alerts():
    account_id = request.args.get("account_id", type=int)
    from services.watchlist_service import check_alerts
    return jsonify(check_alerts(account_id))


@watchlist_bp.route("/api/watch/item-types", methods=["GET"])
def api_item_types():
    from services.watchlist_service import get_item_types
    return jsonify(get_item_types())


