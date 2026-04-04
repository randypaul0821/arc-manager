"""
Arc Raiders 仓库管理系统
入口文件：只负责创建 Flask 实例、注册蓝图、启动服务
"""
import logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S"
)

import os
from flask import Flask, send_from_directory, jsonify
from database import init_db
from config import BUNDLE_DIR

app = Flask(__name__,
            template_folder=os.path.join(BUNDLE_DIR, "templates"),
            static_folder=os.path.join(BUNDLE_DIR, "static"))
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024 * 1024

# ───────── 注册蓝图 ─────────
from routes.items     import items_bp
from routes.inventory import inventory_bp
from routes.accounts  import accounts_bp
from routes.bundles   import bundles_bp
from routes.orders    import orders_bp
from routes.customers import customers_bp
from routes.watchlist import watchlist_bp
from routes.settings import settings_bp
from routes.craft import craft_bp

app.register_blueprint(items_bp)
app.register_blueprint(inventory_bp)
app.register_blueprint(accounts_bp)
app.register_blueprint(bundles_bp)
app.register_blueprint(orders_bp)
app.register_blueprint(customers_bp)
app.register_blueprint(watchlist_bp)
app.register_blueprint(settings_bp)
app.register_blueprint(craft_bp)

# ───────── 全局错误处理 ─────────
logger = logging.getLogger("app")


@app.errorhandler(Exception)
def handle_error(e):
    logger.error("未处理异常", exc_info=True)
    return jsonify({"error": "服务器内部错误"}), 500


@app.errorhandler(404)
def handle_404(e):
    return jsonify({"error": "接口不存在"}), 404


# ───────── 页面入口 ─────────
@app.route("/")
def index():
    return send_from_directory(os.path.join(BUNDLE_DIR, "templates"), "index.html")

# ───────── 启动 ─────────
if __name__ == "__main__":
    import sys
    init_db()
    from services.sync_service import start_scheduler
    start_scheduler()

    frozen = getattr(sys, 'frozen', False)
    print("启动 Arc Raiders 仓库管理系统...")
    print("浏览器打开: http://localhost:5000")

    # 打包模式下自动打开浏览器
    if frozen:
        import webbrowser, threading
        threading.Timer(1.5, lambda: webbrowser.open("http://localhost:5000")).start()

    app.run(host='0.0.0.0', debug=not frozen, use_reloader=False, port=5000, threaded=True)