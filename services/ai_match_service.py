"""
AI 增强匹配服务：对模糊匹配低分项使用 Claude API 重新匹配。
仅在 API key 已配置且有低分项时调用，否则静默跳过。
"""
import json
import logging
import threading
import time

logger = logging.getLogger("ai_match_service")

# ─── 参考表缓存（线程安全）───
_ref_cache = {"text": None, "ts": 0, "lock": threading.Lock()}
_REF_TTL = 300  # 缓存 5 分钟


def _get_api_key() -> str:
    """获取 API key：环境变量优先，其次数据库"""
    from config import CLAUDE_API_KEY
    if CLAUDE_API_KEY:
        return CLAUDE_API_KEY
    try:
        from database import get_conn
        with get_conn() as conn:
            row = conn.execute(
                "SELECT value FROM settings WHERE key='claude_api_key'"
            ).fetchone()
            return row["value"] if row else ""
    except Exception:
        return ""


def _build_reference_text() -> str:
    """构建物品/套餐参考表文本，带缓存"""
    now = time.time()
    with _ref_cache["lock"]:
        if _ref_cache["text"] and now - _ref_cache["ts"] < _REF_TTL:
            return _ref_cache["text"]

    from services.item_service import load_item_data, load_display_names, load_english_names
    from services.bundle_service import get_all_bundles

    items_db = load_item_data()
    names_zh = load_display_names()
    names_en = load_english_names()

    # 物品表：只保留必要字段
    item_lines = []
    for item_id, meta in items_db.items():
        zh = names_zh.get(item_id, "")
        en = names_en.get(item_id, "")
        rarity = meta.get("rarity", "")
        item_type = meta.get("type", "")
        item_lines.append(f"{item_id} | {zh} | {en} | {item_type} | {rarity}")
    item_lines.sort()

    # 套餐表
    bundles = get_all_bundles()
    bundle_lines = []
    for b in bundles:
        aliases = ", ".join(a["alias"] for a in b.get("aliases", []))
        bundle_lines.append(f"{b['id']} | {b['name']} | {aliases}")

    text = (
        "## 物品列表（item_id | 中文名 | 英文名 | 类型 | 稀有度）\n"
        + "\n".join(item_lines)
        + "\n\n## 套餐列表（bundle_id | 名称 | 别名）\n"
        + "\n".join(bundle_lines)
    )

    with _ref_cache["lock"]:
        _ref_cache["text"] = text
        _ref_cache["ts"] = now
    return text


_SYSTEM_PROMPT = """你是 Arc Raiders 游戏订单匹配助手。你的任务是将用户提供的物品名称匹配到正确的 item_id 或 bundle_id。

规则：
1. 用户输入可能是中文、英文、缩写、别名或拼写错误
2. 你需要从提供的参考表中找到最匹配的物品或套餐
3. 如果是套餐（多个物品的组合），返回 match_type="bundle" 和对应的 bundle_id
4. 如果是单个物品，返回 match_type="item" 和对应的 item_id
5. 如果完全无法匹配，返回 match_type="none"
6. confidence 字段：high（确信匹配正确）、medium（可能正确）、low（猜测）

严格按 JSON 格式返回，不要有任何额外文字。"""


def ai_rematch_items(items_to_match: list[dict]) -> dict | None:
    """
    对低分匹配项调用 Claude API 重新匹配。

    参数:
        items_to_match: [{raw_name: str, quantity: int}, ...]

    返回:
        {raw_name: {match_type, match_id, confidence}} 或 None（失败时）
    """
    api_key = _get_api_key()
    if not api_key:
        logger.debug("AI 匹配跳过：未配置 API key")
        return None

    if not items_to_match:
        return {}

    try:
        import anthropic
        from config import CLAUDE_MODEL
    except ImportError:
        logger.warning("anthropic 包未安装，跳过 AI 匹配")
        return None

    ref_text = _build_reference_text()

    # 构建用户消息：只发送需要匹配的项
    user_items = []
    for it in items_to_match:
        user_items.append({"raw_name": it["raw_name"], "quantity": it["quantity"]})

    user_msg = (
        "请将以下物品名称匹配到参考表中的 item_id 或 bundle_id：\n\n"
        + json.dumps(user_items, ensure_ascii=False)
        + "\n\n返回 JSON 数组，每项包含：raw_name, match_type(item/bundle/none), match_id, confidence(high/medium/low)"
    )

    try:
        client = anthropic.Anthropic(api_key=api_key)
        response = client.messages.create(
            model=CLAUDE_MODEL,
            max_tokens=2048,
            system=[
                {
                    "type": "text",
                    "text": _SYSTEM_PROMPT,
                },
                {
                    "type": "text",
                    "text": ref_text,
                    "cache_control": {"type": "ephemeral"},
                },
            ],
            messages=[{"role": "user", "content": user_msg}],
        )

        # 解析响应
        raw_text = response.content[0].text.strip()
        # 提取 JSON（可能被 markdown 包裹）
        if raw_text.startswith("```"):
            raw_text = raw_text.split("\n", 1)[1].rsplit("```", 1)[0].strip()

        matches = json.loads(raw_text)
        result = {}
        for m in matches:
            rn = m.get("raw_name", "")
            if rn:
                result[rn] = {
                    "match_type": m.get("match_type", "none"),
                    "match_id": m.get("match_id"),
                    "confidence": m.get("confidence", "low"),
                }

        # 日志记录用量
        usage = response.usage
        logger.info(
            f"AI 匹配完成: {len(items_to_match)} 项, "
            f"input={usage.input_tokens} (cached={getattr(usage, 'cache_read_input_tokens', 0)}), "
            f"output={usage.output_tokens}"
        )
        return result

    except anthropic.APIError as e:
        logger.error(f"Claude API 调用失败: {e}")
        return None
    except (json.JSONDecodeError, KeyError, IndexError) as e:
        logger.error(f"AI 响应解析失败: {e}")
        return None
    except Exception as e:
        logger.error(f"AI 匹配异常: {e}", exc_info=True)
        return None


def _has_chinese(s: str) -> bool:
    """判断字符串是否包含中文字符"""
    return any('\u4e00' <= c <= '\u9fff' for c in s)


def _has_char_overlap(raw_name: str, name_zh: str, name_en: str) -> bool:
    """
    检查 raw_name 是否和匹配项名称有字符级重叠。
    用于侦测 AI 幻觉：如 "颂歌" → "Arpeggio" 这种零重叠的虚假匹配。

    - 中文 raw_name：至少有 1 个汉字出现在 name_zh / name_en 里
    - 英文 raw_name：至少有 1 个 ≥3 字母的单词出现在 name_zh+name_en 里
    - 完全无重叠 → False（视为 AI 幻觉）
    """
    import re as _re
    # 先剥常见前缀
    raw = raw_name.strip()
    raw = _re.sub(r'^\s*ARC[\s_]*Raiders?\s*[：:]\s*', '', raw, flags=_re.IGNORECASE)
    raw = _re.sub(r'^\s*[\[【][^\]】]*[\]】]\s*', '', raw)
    raw_lower = raw.lower()
    if not raw_lower:
        return False

    pool = (name_zh or "") + " " + (name_en or "")
    pool_lower = pool.lower()

    # 目标项完全没有中文译名（name_zh 全是英文/空）→ 中文 raw 没法字符比对
    # 这种情况给 AI benefit of the doubt，返回 True 不强制核对
    name_zh_has_chinese = any('\u4e00' <= c <= '\u9fff' for c in (name_zh or ""))

    # 中文路径：单字命中
    chinese_chars = [c for c in raw if '\u4e00' <= c <= '\u9fff']
    if chinese_chars:
        if not name_zh_has_chinese:
            return True  # 目标无中文名，跳过中文比对
        return any(c in pool for c in chinese_chars)

    # 英文路径：≥3 字母单词命中
    words = _re.findall(r'[a-z]{3,}', raw_lower)
    return any(w in pool_lower for w in words) if words else False


def apply_ai_matches(result: dict, threshold: int = 80) -> dict:
    """
    对 parse_and_match() 的结果做 AI 增强：
    - 物品名包含中文 → AI 匹配（中文模糊匹配效果差）
    - 英文物品名但分数 < threshold → AI 匹配
    其余保留原有模糊匹配结果。

    参数:
        result: parse_and_match() 的返回值
        threshold: 英文名低于此分数时触发 AI 匹配

    返回:
        增强后的 result（原地修改）
    """
    ai_items = []
    ai_refs = []

    for order in result.get("orders", []):
        for item in order.get("items", []):
            if item.get("_is_coin"):
                continue
            raw = item.get("raw_name", "")
            matched = item.get("matched")
            score = matched.get("score", 0) if matched else 0
            is_chinese = _has_chinese(raw)
            # 中文名：精准匹配（score≥95）直接保留，否则走AI
            # 英文名：低分（score<threshold）走AI，高分保留
            if (is_chinese and score < 95) or (not is_chinese and score < threshold):
                ai_items.append({
                    "raw_name": raw,
                    "quantity": item["quantity"],
                })
                ai_refs.append(item)

    if not ai_items:
        logger.debug("无需 AI 增强的匹配项，跳过")
        return result

    cn_count = sum(1 for it in ai_items if _has_chinese(it["raw_name"]))
    en_count = len(ai_items) - cn_count
    logger.info(f"触发 AI 增强：中文名 {cn_count} 项，英文低分 {en_count} 项")

    ai_results = ai_rematch_items(ai_items)
    if not ai_results:
        return result

    # 应用 AI 结果
    from services.item_service import load_item_data, load_display_names, load_english_names
    from services.bundle_service import get_bundle_with_items

    items_db = load_item_data()
    names_zh = load_display_names()
    names_en = load_english_names()

    for item_ref in ai_refs:
        ai_match = ai_results.get(item_ref["raw_name"])
        if not ai_match or ai_match["match_type"] == "none":
            # AI 也无法识别 → 标记需要人工处理
            item_ref["_needs_manual"] = True
            continue

        confidence = ai_match.get("confidence", "low")
        confidence_score = {"high": 98, "medium": 85, "low": 70}.get(confidence, 70)
        # 非 high 自信的 AI 匹配一律要求人工核对：AI 在中文别名上容易幻觉
        # （例："颂歌" 被 AI 猜成 "Arpeggio/三连奏"）
        low_confidence = confidence != "high"

        # 第二道闸：raw_name 和匹配项名称必须有字符/词重叠
        # 阻止 "颂歌 → Arpeggio" 这种 AI 报 high 自信的纯幻觉
        target_id = ai_match.get("match_id")
        if ai_match["match_type"] == "item" and target_id in items_db:
            tgt_zh = names_zh.get(target_id, "")
            tgt_en = names_en.get(target_id, "")
            if not _has_char_overlap(item_ref["raw_name"], tgt_zh, tgt_en):
                logger.info(
                    f"AI 幻觉拦截: '{item_ref['raw_name']}' → {target_id} "
                    f"({tgt_zh}/{tgt_en}) 字符零重叠，强制核对"
                )
                low_confidence = True

        if ai_match["match_type"] == "item":
            item_id = ai_match["match_id"]
            if item_id not in items_db:
                item_ref["_needs_manual"] = True
                continue
            meta = items_db[item_id]
            new_matched = {
                "item_id": item_id,
                "name_zh": names_zh.get(item_id, item_id),
                "name_en": names_en.get(item_id, ""),
                "rarity": meta.get("rarity", ""),
                "score": confidence_score,
                "image_url": f"/api/items/{item_id}/image",
                "_ai_matched": True,
            }
            # 把原来的 matched 放入 candidates
            old_matched = item_ref.get("matched")
            candidates = item_ref.get("candidates", [])
            if old_matched and old_matched.get("item_id") != item_id:
                candidates.insert(0, old_matched)
            item_ref["matched"] = new_matched
            item_ref["candidates"] = candidates
            if low_confidence:
                item_ref["_needs_manual"] = True

        elif ai_match["match_type"] == "bundle":
            from services.match_service import _bundle_to_candidate
            bundle_id = int(ai_match["match_id"])
            b = get_bundle_with_items(bundle_id)
            if not b:
                item_ref["_needs_manual"] = True
                continue
            new_matched = _bundle_to_candidate(b, item_ref["quantity"], confidence_score)
            new_matched["_ai_matched"] = True
            old_matched = item_ref.get("matched")
            candidates = item_ref.get("candidates", [])
            if old_matched:
                candidates.insert(0, old_matched)
            item_ref["matched"] = new_matched
            item_ref["candidates"] = candidates
            if low_confidence:
                item_ref["_needs_manual"] = True

    return result
