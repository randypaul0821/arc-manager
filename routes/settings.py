"""
系统设置路由
"""
from flask import Blueprint, request, jsonify
from database import get_conn

settings_bp = Blueprint("settings", __name__)


@settings_bp.route("/api/settings/ai", methods=["GET"])
def api_get_ai_settings():
    """返回 AI 配置状态（不返回 key 明文）"""
    from config import CLAUDE_API_KEY, CLAUDE_MODEL
    # 检查环境变量
    env_configured = bool(CLAUDE_API_KEY)
    # 检查数据库
    db_configured = False
    try:
        with get_conn() as conn:
            row = conn.execute(
                "SELECT value FROM settings WHERE key='claude_api_key'"
            ).fetchone()
            db_configured = bool(row and row["value"])
    except Exception:
        pass

    return jsonify({
        "configured": env_configured or db_configured,
        "source": "env" if env_configured else ("db" if db_configured else "none"),
        "model": CLAUDE_MODEL,
    })


@settings_bp.route("/api/settings/ai", methods=["POST"])
def api_set_ai_settings():
    """保存 API key 到数据库"""
    d = request.json or {}
    api_key = d.get("api_key", "").strip()
    if not api_key:
        return jsonify({"error": "API key 不能为空"}), 400

    try:
        with get_conn() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES ('claude_api_key', ?)",
                (api_key,)
            )
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@settings_bp.route("/api/settings/ai", methods=["DELETE"])
def api_delete_ai_settings():
    """删除数据库中的 API key"""
    try:
        with get_conn() as conn:
            conn.execute("DELETE FROM settings WHERE key='claude_api_key'")
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
