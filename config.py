import os, sys

# PyInstaller 打包后，资源文件在 _MEIPASS 临时目录中
# 用户数据（DB、自定义图片等）需要放在 exe 所在目录
if getattr(sys, 'frozen', False):
    BUNDLE_DIR = sys._MEIPASS                       # 打包资源目录
    APP_DIR    = os.path.dirname(sys.executable)     # exe 所在目录
else:
    BUNDLE_DIR = os.path.dirname(__file__)
    APP_DIR    = BUNDLE_DIR

BASE_DIR = APP_DIR  # 兼容旧引用
DATA_DIR = os.path.join(BUNDLE_DIR, "arcraiders-data-main")
DB_PATH  = os.path.join(APP_DIR, "arc_manager.db")

# 同步配置
SYNC_INTERVAL_MINUTES = 30   # 最大距上次同步间隔
SYNC_DELAY_SECONDS    = 4    # 多账号同步时每个账号的间隔（防封）

# 定时检查间隔
SCHEDULER_INTERVAL_SECONDS = 300  # 每5分钟检查一次

# 自动刷新冷却（同步失败后自动触发刷新的最小间隔）
AUTO_REFRESH_COOLDOWN_MINUTES = 30

# AI 匹配配置
CLAUDE_API_KEY = os.environ.get("CLAUDE_API_KEY", "")
CLAUDE_MODEL   = "claude-haiku-4-5-20251001"

# 订单配置
COIN_UNIT_PRICE = 7000           # 金币兑换为"伙伴鸭"时的单价
ORDER_CLEANUP_DAYS = 7           # 自动归档已完成订单的天数
UNIT_PRICE_SANITY_MAX = 5        # 游戏物品单价经验上限（用于总价/单价判别）