"""
自动登录服务：使用 Playwright 持久化浏览器会话，自动刷新 arctracker.io Cookie
每个账号独立的浏览器 profile，保存 Steam "Remember me" 状态
全链路自动化：邮箱密码登录 → Steam 重新绑定 → Cookie 提取 → 库存同步
"""
import os, sys, logging, threading, json, time
from config import APP_DIR

logger = logging.getLogger("auto_login")

PROFILES_DIR = os.path.join(APP_DIR, "browser_profiles")
ARCTRACKER_URL = "https://arctracker.io/"
ARCTRACKER_SIGNIN_URL = "https://arctracker.io/zh-CN/signin"
ARCTRACKER_STASH_URL = "https://arctracker.io/zh-CN/stash"
COOKIE_NAMES = ("better-auth.session_token", "better-auth.session_data")

# ARCTracker Chrome 扩展路径（Steam 绑定需要此扩展做 127.0.0.1 → arctracker.io 的重定向）
ARCTRACKER_EXT_ID = "ebaiaeipdgpnjmbgffhiloomegkaphhl"
# 优先：项目内置扩展
_BUNDLED_EXT = os.path.join(APP_DIR, "arctracker-extension")
# 备选：Chrome 已安装的扩展
_CHROME_EXT_BASE = os.path.join(
    os.environ.get("LOCALAPPDATA", ""),
    "Google", "Chrome", "User Data", "Default", "Extensions",
    ARCTRACKER_EXT_ID,
)


def _get_extension_path() -> str | None:
    """查找 ARCTracker 扩展：优先项目内置，其次 Chrome 已安装"""
    # 1. 项目内置
    if os.path.isdir(_BUNDLED_EXT) and os.path.isfile(os.path.join(_BUNDLED_EXT, "manifest.json")):
        return _BUNDLED_EXT
    # 2. Chrome 已安装
    if os.path.isdir(_CHROME_EXT_BASE):
        for name in os.listdir(_CHROME_EXT_BASE):
            candidate = os.path.join(_CHROME_EXT_BASE, name)
            if os.path.isdir(candidate) and os.path.isfile(os.path.join(candidate, "manifest.json")):
                return candidate
    return None


def _browser_args(extra_args: list = None) -> list:
    """构建 Chromium 启动参数，自动加载 ARCTracker 扩展"""
    args = ["--disable-blink-features=AutomationControlled"]
    ext_path = _get_extension_path()
    if ext_path:
        args.append(f"--disable-extensions-except={ext_path}")
        args.append(f"--load-extension={ext_path}")
        logger.info(f"已加载 ARCTracker 扩展: {ext_path}")
    else:
        logger.warning("未找到 ARCTracker 扩展，Steam 绑定可能无法完成")
    if extra_args:
        args.extend(extra_args)
    return args

# 运行状态
_tasks: dict = {}  # account_id → { status, message, thread }


def _ensure_playwright():
    """检查 playwright 是否可用"""
    try:
        from playwright.sync_api import sync_playwright
        return True
    except ImportError:
        return False


def get_profile_dir(account_id: int) -> str:
    """获取账号的浏览器 profile 目录"""
    d = os.path.join(PROFILES_DIR, f"account_{account_id}")
    os.makedirs(d, exist_ok=True)
    return d


def get_auto_login_status() -> dict:
    """返回所有账号的自动登录状态"""
    available = _ensure_playwright()
    profiles = {}
    if os.path.isdir(PROFILES_DIR):
        for name in os.listdir(PROFILES_DIR):
            if name.startswith("account_"):
                aid = name.replace("account_", "")
                try:
                    aid = int(aid)
                    profiles[aid] = True
                except ValueError:
                    pass

    tasks = {}
    for aid, t in _tasks.items():
        tasks[aid] = {"status": t["status"], "message": t.get("message", "")}

    return {
        "available": available,
        "profiles": profiles,
        "tasks": tasks,
    }


def _extract_cookies(context) -> str:
    """从浏览器上下文中提取 arctracker cookie"""
    cookies = context.cookies("https://arctracker.io")
    parts = []
    for name in COOKIE_NAMES:
        for c in cookies:
            if c["name"] == name:
                parts.append(f"{name}={c['value']}")
                break
    return "; ".join(parts)


def _do_init_login(account_id: int, account_name: str):
    """首次登录：打开独立 Chromium，用户手动登录，profile 自动保存会话
    同时拦截登录请求，自动抓取邮箱密码存库���省去手动填写凭据步骤
    """
    from playwright.sync_api import sync_playwright

    _tasks[account_id] = {"status": "waiting", "message": "正在启动浏览器..."}

    profile_dir = get_profile_dir(account_id)
    captured_creds = {}  # 用于存放拦截到的邮箱密码

    def _on_request(request):
        """拦截登录/注册请求，提取邮箱密码
        arctracker 登录端点: POST /api/auth/sign-in/email
        arctracker 注册端点: POST /api/auth/sign-up/email
        请求体: {"email":"xxx@xxx.com","password":"xxx"}
        """
        try:
            if request.method == "POST" and ("sign-in" in request.url or "sign-up" in request.url):
                logger.info(f"账号 {account_name} 拦截到登录请求: {request.url}")
                post_data = request.post_data
                if post_data:
                    try:
                        import json as _json
                        body = _json.loads(post_data)
                        email = body.get("email", "")
                        password = body.get("password", "")
                        if email and password:
                            captured_creds["email"] = email
                            captured_creds["password"] = password
                            logger.info(f"账号 {account_name} 自动捕获登录凭据: {email}")
                        else:
                            logger.warning(f"账号 {account_name} 登录请求体中未找到 email/password: {list(body.keys())}")
                    except (ValueError, TypeError) as e:
                        logger.warning(f"账号 {account_name} 登录请求体解析失败: {e}, raw: {post_data[:200]}")
                else:
                    logger.warning(f"账号 {account_name} 登录请求无 post_data")
        except Exception as e:
            logger.warning(f"账号 {account_name} 拦截登录请求异常: {e}")

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch_persistent_context(
                profile_dir,
                headless=False,
                executable_path=p.chromium.executable_path,
                viewport={"width": 1200, "height": 800},
                locale="zh-CN",
                args=_browser_args(),
            )

            page = browser.pages[0] if browser.pages else browser.new_page()
            page.on("request", _on_request)

            # 注册 127.0.0.1 回调拦截（Steam 绑定时，无 ARCTracker 扩展也能完成回调）
            def _handle_callback_redirect(route):
                url = route.request.url
                query = url.split("?", 1)[1] if "?" in url else ""
                redirect_url = f"https://arctracker.io/embark-callback?{query}"
                logger.info(f"[init_login] 拦截 127.0.0.1 回调，重定向到: {redirect_url[:80]}")
                route.fulfill(
                    status=200,
                    content_type="text/html",
                    body=f'<html><head><meta http-equiv="refresh" content="0;url={redirect_url}"></head><body>Redirecting...</body></html>',
                )
            try:
                page.route("**/127.0.0.1:49172/**", _handle_callback_redirect)
            except Exception:
                pass

            page.goto(ARCTRACKER_URL, wait_until="domcontentloaded", timeout=30000)
            page.bring_to_front()

            _tasks[account_id] = {
                "status": "waiting",
                "message": f"请在弹出的浏览器中登录「{account_name}」的 arctracker 账号",
            }

            # ── 阶段1：等待登录（最多 5 分钟）──
            cookie_str = ""
            for _ in range(150):  # 150 × 2s = 300s = 5min
                time.sleep(2)
                try:
                    cookie_str = _extract_cookies(browser)
                except Exception:
                    _tasks[account_id] = {"status": "error", "message": "浏览器已关闭，未完成登录"}
                    return
                if all(name in cookie_str for name in COOKIE_NAMES):
                    break
            else:
                _tasks[account_id] = {"status": "timeout", "message": "等待登录超时（5分钟）"}
                try: browser.close()
                except: pass
                return

            # 登录成功，先保存凭据和 cookie
            if captured_creds.get("email") and captured_creds.get("password"):
                _save_credentials(account_id, captured_creds["email"], captured_creds["password"])
                logger.info(f"账号 {account_name} 凭据已自动捕获: {captured_creds['email']}")

            _save_cookie(account_id, cookie_str)
            logger.info(f"账号 {account_name} 登录成功，Cookie 已保存")

            # ── 阶段2：等待用户绑定 Steam（等用户自己关闭浏览器）──
            _tasks[account_id] = {
                "status": "waiting",
                "message": "三方登录成功，Cookie 已获取！请继续绑定 Steam，完成后关闭浏览器",
            }

            # 轮询直到用户关闭浏览器（最多再等 10 分钟）
            steam_bound = False
            for _ in range(300):  # 300 × 2s = 600s = 10min
                time.sleep(2)
                try:
                    # 检查页面 URL 是否包含 Steam 绑定成功标志
                    try:
                        current_url = page.url
                        if "embark_success=true" in current_url and not steam_bound:
                            steam_bound = True
                            logger.info(f"账号 {account_name} Steam 绑定成功")
                            # 更新 message，前端检测到变化会弹 toast
                            _tasks[account_id] = {
                                "status": "waiting",
                                "message": "Steam 绑定成功！可以关闭浏览器了",
                            }
                    except Exception:
                        pass
                    # 尝试提取 cookie，如果失败说明浏览器已关闭
                    _extract_cookies(browser)
                except Exception:
                    # 浏览器已关闭，正常退出
                    logger.info(f"账号 {account_name} 浏览器已关闭")
                    break

            # 浏览器关闭前重新提取最新 cookie（Steam 绑定可能刷新了）
            try:
                final_cookie = _extract_cookies(browser)
                if final_cookie and all(name in final_cookie for name in COOKIE_NAMES):
                    cookie_str = final_cookie
                    _save_cookie(account_id, cookie_str)
            except Exception:
                pass

            try: browser.close()
            except: pass

            msg_parts = ["登录成功"]
            if captured_creds.get("email"):
                msg_parts.append("凭据已自动保存")
            if steam_bound:
                msg_parts.append("Steam 已绑定")
            else:
                msg_parts.append("请确认 Steam 已绑定")
            _tasks[account_id] = {"status": "ok", "message": "，".join(msg_parts)}
            logger.info(f"账号 {account_name} 首次登录流程完成: {msg_parts}")

    except Exception as e:
        logger.error(f"账号 {account_name} 首次登录失败", exc_info=True)
        msg = str(e)
        if "user data directory is already in use" in msg.lower() or "lock" in msg.lower():
            msg = "Chrome 正在运行，请先关闭所有 Chrome 窗口后重试"
        elif "executable doesn't exist" in msg.lower():
            msg = "未找到 Chrome 浏览器，请确认已安装"
        _tasks[account_id] = {"status": "error", "message": msg}


def _save_credentials(account_id: int, email: str, password: str):
    """保存自动捕获的登录凭据到数据库"""
    from database import get_conn
    try:
        with get_conn() as conn:
            conn.execute(
                "UPDATE accounts SET arc_email=?, arc_password=? WHERE id=?",
                (email, password, account_id),
            )
        logger.info(f"账号 {account_id} 凭据已自动保存")
    except Exception:
        logger.error(f"账号 {account_id} 凭据保存失败", exc_info=True)


def _do_steam_binding(page, account_id: int, account_name: str) -> bool:
    """Steam 重新绑定：模拟用户操作 — 去 stash 页面点 Steam 按钮 → Steam 页面点登录
    返回 True 表示绑定成功，False 表示失败（但不影响 cookie 刷新）
    """
    try:
        _tasks[account_id] = {"status": "binding_steam", "message": "正在绑定 Steam..."}
        logger.info(f"账号 {account_name} 开始 Steam 绑定流程")

        # 注册路由拦截作为安全网（扩展没加载时兜底）
        def _handle_callback_redirect(route):
            url = route.request.url
            query = url.split("?", 1)[1] if "?" in url else ""
            redirect_url = f"https://arctracker.io/embark-callback?{query}"
            logger.info(f"拦截 127.0.0.1 回调，重定向到: {redirect_url[:80]}")
            route.fulfill(
                status=200,
                content_type="text/html",
                body=f'<html><head><meta http-equiv="refresh" content="0;url={redirect_url}"></head><body>Redirecting...</body></html>',
            )

        try:
            page.route("**/127.0.0.1:49172/**", _handle_callback_redirect)
        except Exception:
            pass

        # ── 步骤1：导航到 Steam 认证 API ──
        logger.info(f"账号 {account_name} 导航到 Steam 认证端点")
        page.goto(ARCTRACKER_URL + "api/embark/auth/steam", timeout=60000, wait_until="commit")
        time.sleep(2)
        current_url = page.url
        logger.info(f"账号 {account_name} Steam 认证端点响应后当前URL: {current_url[:120]}")

        # 处理可能出现的"关联您的游戏账号"确认弹窗（有"继续"按钮）
        try:
            continue_btn = page.locator('button:has-text("继续"), button:has-text("Continue")').first
            if continue_btn.is_visible(timeout=3000):
                logger.info(f"账号 {account_name} 检测到关联确认弹窗，点击「继续」")
                continue_btn.click()
        except Exception:
            pass  # 没有弹窗，正常继续

        # ── 步骤2：等待到达 Steam OpenID 页面 ──
        logger.info(f"账号 {account_name} 等待跳转到 Steam 页面...")
        try:
            page.wait_for_url("**/steamcommunity.com/openid/**", timeout=60000)
        except Exception:
            current = page.url
            logger.warning(f"账号 {account_name} 等待 Steam 页面超时，当前URL: {current[:120]}")
            # 尝试获取页面内容帮助排查
            try:
                body_text = page.locator("body").inner_text(timeout=3000)[:300]
                logger.warning(f"账号 {account_name} 页面内容: {body_text}")
            except Exception:
                pass
            if "embark_success=true" in current:
                logger.info(f"账号 {account_name} Steam 已直接绑定成功")
                return True
            return False

        time.sleep(2)
        logger.info(f"账号 {account_name} 已到达 Steam 页面: {page.url[:80]}")
        _tasks[account_id] = {"status": "binding_steam", "message": "正在 Steam 登录..."}

        # ── 步骤3：在 Steam 页面点击"登录"按钮 ──
        # Steam OpenID 的登录按钮是 input#imageLogin，不是 button
        try:
            steam_btn = page.locator('input#imageLogin, input[type="submit"][value="登录"], input[type="submit"][value="Sign In"], button[type="submit"]').first
            steam_btn.wait_for(state="visible", timeout=15000)
            steam_btn.click()
            logger.info(f"账号 {account_name} 已点击 Steam 登录按钮")
        except Exception as e:
            logger.warning(f"账号 {account_name} Steam 登录按钮点击失败: {e}")
            _tasks[account_id] = {
                "status": "steam_expired",
                "message": "Steam 会话已过期，需手动登录 Steam（使用「首次登录」）",
            }
            return False

        # ── 步骤4：等待 OAuth 回调链完成 ──
        # 回调链：Steam → auth.embark.net → arctracker.io/embark-callback(~5s) → stash?embark_success=true
        # 用 wait_for_url 直接等目标 URL，比轮询快得多
        logger.info(f"账号 {account_name} 等待 Steam 回调...")
        _tasks[account_id] = {"status": "binding_steam", "message": "Steam 回调处理中..."}

        try:
            # 等待最终跳转到 stash 页面（embark-callback 服务端处理约 5s，给 30s 超时足够）
            page.wait_for_url("**/stash**", timeout=30000)
            url = page.url

            if "embark_success=true" in url:
                logger.info(f"账号 {account_name} Steam 绑定成功！")
                _tasks[account_id] = {"status": "binding_steam", "message": "Steam 绑定成功！"}
                return True

            # 到了 stash 但没有 success 参数，检查错误
            time.sleep(1)
            try:
                error_el = page.locator('text=已关联到另一个').first
                if error_el.is_visible(timeout=2000):
                    logger.warning(f"账号 {account_name} Steam 绑定失败：该游戏账号已关联到另一个 ARCTracker 账号")
                    _tasks[account_id] = {
                        "status": "error",
                        "message": "Steam 绑定失败：该游戏账号已关联到另一个 ARCTracker 账号",
                    }
                    return False
            except Exception:
                pass

            logger.info(f"账号 {account_name} 已返回 stash 页面（未检测到明确成功标志）")
            return True

        except Exception as e:
            # wait_for_url 超时，检查当前状态
            try:
                url = page.url
            except Exception:
                logger.warning(f"账号 {account_name} Steam 绑定中浏览器异常")
                return False

            if "embark_success=true" in url:
                logger.info(f"账号 {account_name} Steam 绑定成功（在超时前完成）")
                return True

            logger.warning(f"账号 {account_name} Steam 回调超时，当前URL: {url[:80]}")
            return False

    except Exception as e:
        logger.error(f"账号 {account_name} Steam 绑定异常: {e}", exc_info=True)
        return False


def _do_auto_refresh(account_id: int, account_name: str):
    """全链路自动刷新：邮箱密码登录 → Steam 重新绑定 → Cookie 提取 → 同步"""
    from playwright.sync_api import sync_playwright
    from services.account_service import get_account

    _tasks[account_id] = {"status": "refreshing", "message": "自动刷新中..."}

    acc = get_account(account_id)
    email = (acc or {}).get("arc_email", "").strip()
    password = (acc or {}).get("arc_password", "").strip()

    if not email or not password:
        _tasks[account_id] = {
            "status": "error",
            "message": "未设置 arctracker 邮箱密码，请先在账号设置中填写",
        }
        return

    profile_dir = get_profile_dir(account_id)

    try:
        with sync_playwright() as p:
            # 静默模式：把窗口移到屏幕外。页面仍正常渲染（不同于 headless —
            # headless 下 Steam OpenID 会走不同代码路径导致登录按钮找不到），
            # 只是视觉上不可见，避免打断用户当前操作。
            silent_args = [
                "--window-position=-32000,-32000",
                "--window-size=1200,800",
            ]
            browser = p.chromium.launch_persistent_context(
                profile_dir,
                headless=False,
                executable_path=p.chromium.executable_path,
                viewport={"width": 1200, "height": 800},
                args=_browser_args(silent_args),
            )

            page = browser.pages[0] if browser.pages else browser.new_page()

            # ── 第1步：邮箱密码登录 arctracker ──
            # arctracker 的登录是首页上的弹窗（Modal），不是独立页面
            _tasks[account_id] = {"status": "refreshing", "message": "正在登录 arctracker..."}
            page.goto(ARCTRACKER_URL, wait_until="domcontentloaded", timeout=30000)
            time.sleep(2)

            login_ok = False
            try:
                # 先检查是否已经登录（cookie 可能还没过期）
                cookie_str_check = _extract_cookies(browser)
                if cookie_str_check and all(name in cookie_str_check for name in COOKIE_NAMES):
                    logger.info(f"账号 {account_name} 已登录（cookie 未过期），跳过登录步骤")
                    login_ok = True
                else:
                    # 直接导航到登录页，避免"首页弹窗 vs 独立登录页"两种情况带来的不确定性
                    if "/signin" not in page.url and "/sign-in" not in page.url:
                        try:
                            page.goto(ARCTRACKER_SIGNIN_URL, wait_until="domcontentloaded", timeout=30000)
                            time.sleep(1)
                        except Exception as e:
                            logger.warning(f"账号 {account_name} 导航到登录页失败: {e}")

                    # 填写邮箱密码（Playwright fill 会先清空再输入，覆盖浏览器自动填充并触发 React 事件）
                    email_input = page.locator('input[type="email"], input[name="email"]').first
                    pwd_input = page.locator('input[type="password"], input[name="password"]').first
                    email_input.wait_for(state="visible", timeout=10000)
                    email_input.fill(email)
                    pwd_input.fill(password)
                    logger.info(f"账号 {account_name} 已填写邮箱密码")

                    # 点击提交按钮 — 严格限定在 form 或 dialog 范围内，避免页眉里的"登录"导航链接
                    submitted = False
                    try:
                        submit = page.locator(
                            'form button[type="submit"], dialog button[type="submit"]'
                        ).first
                        submit.wait_for(state="visible", timeout=5000)
                        submit.click()
                        submitted = True
                        logger.info(f"账号 {account_name} 已点击表单 submit 按钮")
                    except Exception as e:
                        logger.warning(f"账号 {account_name} 表单 submit 按钮点击失败: {e}")

                    # 兜底 1：直接在密码框按回车提交
                    if not submitted:
                        try:
                            pwd_input.press("Enter")
                            submitted = True
                            logger.info(f"账号 {account_name} 已通过 Enter 键提交登录表单")
                        except Exception as e:
                            logger.warning(f"账号 {account_name} Enter 键提交失败: {e}")

                    # 兜底 2：文本匹配任意可见的"登录/Sign In"按钮（严格限定在 form/dialog 范围）
                    if not submitted:
                        try:
                            btn = page.locator(
                                'form :is(button, input[type="submit"]):has-text("登录"), '
                                'form :is(button, input[type="submit"]):has-text("Sign In"), '
                                'dialog :is(button, input[type="submit"]):has-text("登录"), '
                                'dialog :is(button, input[type="submit"]):has-text("Sign In")'
                            ).first
                            btn.click(timeout=3000)
                            submitted = True
                            logger.info(f"账号 {account_name} 已通过文本匹配点击登录按钮")
                        except Exception as e:
                            logger.warning(f"账号 {account_name} 文本匹配登录按钮失败: {e}")

                    login_ok = submitted
            except Exception as e:
                logger.warning(f"账号 {account_name} 登录操作失败: {e}", exc_info=True)
                # 可能已经登录了，继续检查 cookie

            # 等待登录完成，轮询 cookie（最多 30 秒）
            cookie_str = ""
            for _ in range(15):
                time.sleep(2)
                try:
                    cookie_str = _extract_cookies(browser)
                except Exception:
                    break
                if all(name in cookie_str for name in COOKIE_NAMES):
                    break

            if not cookie_str or not all(name in cookie_str for name in COOKIE_NAMES):
                try: browser.close()
                except: pass
                _tasks[account_id] = {
                    "status": "error",
                    "message": "自动登录失败，可能邮箱或密码有误",
                }
                return

            logger.info(f"账号 {account_name} arctracker 登录成功")
            _tasks[account_id] = {"status": "binding_steam", "message": "三方登录成功，Cookie 已获取！正在绑定 Steam..."}

            # ── 第2步：Steam 重新绑定 ──
            steam_ok = _do_steam_binding(page, account_id, account_name)

            # Steam 绑定后可能刷新了 cookie，重新提取
            if steam_ok:
                try:
                    new_cookie = _extract_cookies(browser)
                    if new_cookie and all(name in new_cookie for name in COOKIE_NAMES):
                        cookie_str = new_cookie
                except Exception:
                    pass

            try: browser.close()
            except: pass

            # ── 第3步：保存 Cookie 并触发同步 ──
            _save_cookie(account_id, cookie_str)

            # 更新 last_auto_refresh 时间戳
            _update_last_auto_refresh(account_id)

            if steam_ok:
                _tasks[account_id] = {"status": "ok", "message": "全链路刷新完成：登录 + Steam 绑定 + 同步"}
                logger.info(f"账号 {account_name} 全链路自动刷新成功")
            elif _tasks[account_id].get("status") == "steam_expired":
                # Steam 过期的状态已在 _do_steam_binding 中设置，但 cookie 仍然保存了
                logger.info(f"账号 {account_name} 登录成功但 Steam 需手动绑定")
            else:
                _tasks[account_id] = {"status": "ok", "message": "登录成功，Cookie 已刷新（Steam 绑定跳过）"}
                logger.info(f"账号 {account_name} 登录成功，Steam 绑定未完成但 Cookie 已更新")

    except Exception as e:
        logger.error(f"账号 {account_name} 自动刷新失败", exc_info=True)
        _tasks[account_id] = {"status": "error", "message": str(e)}


def _update_last_auto_refresh(account_id: int):
    """更新自动刷新时间戳"""
    from datetime import datetime
    from database import get_conn
    try:
        with get_conn() as conn:
            conn.execute(
                "UPDATE accounts SET last_auto_refresh=? WHERE id=?",
                (datetime.now().isoformat(), account_id),
            )
    except Exception:
        logger.debug(f"更新 last_auto_refresh 失败（字段可能还没迁移）", exc_info=True)


def _save_cookie(account_id: int, cookie_str: str):
    """保存 cookie 到数据库并触发同步"""
    from services.account_service import get_account
    from services.sync_service import sync_account
    from database import get_conn

    with get_conn() as conn:
        conn.execute(
            "UPDATE accounts SET cookie=?, pending_cookie=0, sync_status='syncing' WHERE id=?",
            (cookie_str, account_id),
        )
    logger.info(f"账号 {account_id} Cookie 已更新到数据库")

    # 后台同步
    def _sync():
        try:
            acc = get_account(account_id)
            if acc:
                sync_account(acc)
        except Exception:
            logger.error(f"账号 {account_id} 自动同步失败", exc_info=True)

    threading.Thread(target=_sync, daemon=True).start()


# ═══ 外部调用接口 ═══


def init_login(account_id: int, account_name: str) -> dict:
    """首次登录（有头浏览器，需手动操作）"""
    if not _ensure_playwright():
        return {"ok": False, "error": "playwright 未安装，请运行: pip install playwright && playwright install chromium"}

    if account_id in _tasks and _tasks[account_id].get("status") in ("waiting", "refreshing"):
        return {"ok": False, "error": "该账号正在处理中"}

    t = threading.Thread(target=_do_init_login, args=(account_id, account_name), daemon=True)
    _tasks[account_id] = {"status": "starting", "message": "正在启动浏览器...", "thread": t}
    t.start()
    return {"ok": True}


def auto_refresh(account_id: int, account_name: str) -> dict:
    """自动刷新 Cookie（无头模式）"""
    if not _ensure_playwright():
        return {"ok": False, "error": "playwright 未安装"}

    profile_dir = get_profile_dir(account_id)
    # 检查是否有 profile
    if not os.path.isdir(profile_dir) or not os.listdir(profile_dir):
        return {"ok": False, "error": "该账号尚未首次登录，请先使用「首次登录」"}

    if account_id in _tasks and _tasks[account_id].get("status") in ("waiting", "refreshing", "binding_steam"):
        return {"ok": False, "error": "该账号正在处理中"}

    t = threading.Thread(target=_do_auto_refresh, args=(account_id, account_name), daemon=True)
    _tasks[account_id] = {"status": "starting", "message": "正在自动刷新...", "thread": t}
    t.start()
    return {"ok": True}


def batch_refresh(accounts: list) -> dict:
    """批量自动刷新所有有 profile 的账号"""
    if not _ensure_playwright():
        return {"ok": False, "error": "playwright 未安装"}

    started = []
    skipped = []
    for acc in accounts:
        aid = acc["id"]
        profile_dir = get_profile_dir(aid)
        if not os.path.isdir(profile_dir) or not os.listdir(profile_dir):
            skipped.append(acc["name"])
            continue
        if aid in _tasks and _tasks[aid].get("status") in ("waiting", "refreshing", "binding_steam"):
            skipped.append(acc["name"])
            continue

        # 串行执行，避免同时打开太多浏览器
        def _batch_worker(accounts_queue):
            for a in accounts_queue:
                _do_auto_refresh(a["id"], a["name"])
                time.sleep(2)  # 间隔 2 秒

        started.append(acc)

    if started:
        t = threading.Thread(target=_batch_worker, args=(started,), daemon=True)
        t.start()

    return {
        "ok": True,
        "started": len(started),
        "skipped": len(skipped),
        "skipped_names": skipped,
    }


def clear_profile(account_id: int) -> dict:
    """清除账号的浏览器 profile"""
    import shutil
    profile_dir = get_profile_dir(account_id)
    if os.path.isdir(profile_dir):
        shutil.rmtree(profile_dir, ignore_errors=True)
    if account_id in _tasks:
        del _tasks[account_id]
    return {"ok": True}
