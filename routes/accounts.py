"""
账号路由
"""
import logging
from flask import Blueprint, request, jsonify
from services.account_service import (
    get_all_accounts, get_account,
    create_account, update_account, delete_account,
    get_cookie_status, toggle_sync_paused
)
from services.sync_service import sync_account, sync_accounts, sync_all_active

try:
    from services.auto_login import (
        get_auto_login_status, init_login, auto_refresh,
        batch_refresh, clear_profile
    )
    _auto_login_available = True
except ImportError:
    _auto_login_available = False

logger = logging.getLogger("routes.accounts")

accounts_bp = Blueprint("accounts", __name__)


@accounts_bp.route("/api/accounts", methods=["GET"])
def api_get_accounts():
    logger.info("GET /api/accounts")
    return jsonify(get_all_accounts())


@accounts_bp.route("/api/accounts/<int:aid>", methods=["GET"])
def api_get_account(aid):
    logger.info(f"GET /api/accounts/{aid}")
    acc = get_account(aid)
    if not acc:
        return jsonify({"error": "账号不存在"}), 404
    return jsonify(acc)


@accounts_bp.route("/api/accounts", methods=["POST"])
def api_create_account():
    d    = request.json or {}
    name = d.get("name", "").strip()
    logger.info(f"POST /api/accounts name={name}")
    if not name:
        return jsonify({"error": "账号名不能为空"}), 400
    aid, err = create_account(name, d.get("cookie", ""), d.get("note", ""))
    if err:
        return jsonify({"error": err}), 400
    return jsonify({"ok": True, "id": aid})


@accounts_bp.route("/api/accounts/<int:aid>", methods=["PUT"])
def api_update_account(aid):
    d = request.json or {}
    logger.info(f"PUT /api/accounts/{aid} fields={list(d.keys())}")
    ok, err = update_account(aid, d)
    if not ok:
        return jsonify({"error": err}), 400
    return jsonify({"ok": True})


@accounts_bp.route("/api/accounts/<int:aid>", methods=["DELETE"])
def api_delete_account(aid):
    logger.info(f"DELETE /api/accounts/{aid}")
    if not delete_account(aid):
        return jsonify({"error": "删除失败"}), 500
    return jsonify({"ok": True})


@accounts_bp.route("/api/accounts/<int:aid>/sync", methods=["POST"])
def api_sync_account(aid):
    logger.info(f"POST /api/accounts/{aid}/sync")
    acc = get_account(aid)
    if not acc:
        return jsonify({"error": "账号不存在"}), 404
    ok = sync_account(acc)
    return jsonify({"ok": ok})


@accounts_bp.route("/api/accounts/sync-all", methods=["POST"])
def api_sync_all():
    logger.info("POST /api/accounts/sync-all")
    results = sync_all_active()
    return jsonify({"ok": True, "results": results})


@accounts_bp.route("/api/cookie-status", methods=["GET"])
def api_cookie_status():
    return jsonify(get_cookie_status())


@accounts_bp.route("/api/accounts/<int:aid>/sync-paused", methods=["POST"])
def api_toggle_sync_paused(aid):
    logger.info(f"POST /api/accounts/{aid}/sync-paused")
    return jsonify(toggle_sync_paused(aid))


# ───────── 自动登录（Playwright）─────────

_AUTO_LOGIN_UNAVAILABLE = {"error": "自动登录不可用，请安装 playwright: pip install playwright && playwright install chromium"}


@accounts_bp.route("/api/auto-login/status", methods=["GET"])
def api_auto_login_status():
    if not _auto_login_available:
        return jsonify(_AUTO_LOGIN_UNAVAILABLE), 501
    return jsonify(get_auto_login_status())


@accounts_bp.route("/api/accounts/<int:aid>/auto-login/init", methods=["POST"])
def api_auto_login_init(aid):
    """首次登录：打开有头浏览器，用户手动登录"""
    logger.info(f"POST /api/accounts/{aid}/auto-login/init")
    if not _auto_login_available:
        return jsonify(_AUTO_LOGIN_UNAVAILABLE), 501
    acc = get_account(aid)
    if not acc:
        return jsonify({"error": "账号不存在"}), 404
    return jsonify(init_login(aid, acc["name"]))


@accounts_bp.route("/api/accounts/<int:aid>/auto-login/refresh", methods=["POST"])
def api_auto_login_refresh(aid):
    """自动刷新 Cookie（无头模式）"""
    logger.info(f"POST /api/accounts/{aid}/auto-login/refresh")
    if not _auto_login_available:
        return jsonify(_AUTO_LOGIN_UNAVAILABLE), 501
    acc = get_account(aid)
    if not acc:
        return jsonify({"error": "账号不存在"}), 404
    return jsonify(auto_refresh(aid, acc["name"]))


@accounts_bp.route("/api/auto-login/batch-refresh", methods=["POST"])
def api_auto_login_batch():
    """批量自动刷新所有有 profile 的账号"""
    logger.info("POST /api/auto-login/batch-refresh")
    if not _auto_login_available:
        return jsonify(_AUTO_LOGIN_UNAVAILABLE), 501
    accounts = get_all_accounts()
    active = [a for a in accounts if a["active"]]
    return jsonify(batch_refresh(active))


@accounts_bp.route("/api/accounts/<int:aid>/auto-login/clear", methods=["DELETE"])
def api_auto_login_clear(aid):
    """清除浏览器 profile"""
    logger.info(f"DELETE /api/accounts/{aid}/auto-login/clear")
    if not _auto_login_available:
        return jsonify(_AUTO_LOGIN_UNAVAILABLE), 501
    return jsonify(clear_profile(aid))