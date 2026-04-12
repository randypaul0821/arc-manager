"""
AI 文本解析兜底服务：对正则未能识别的订单行调 Claude 解析为结构化物品。

省钱策略（与 ai_match_service 一致）：
- 仅在正则解析后还有未识别行时才调用
- 仅发送未识别行本身（不附带物品参考表）
- prompt 极小，单次调用通常 < 300 input tokens
- 失败/无 key 时静默跳过，绝不阻塞主流程
"""
import json
import logging

logger = logging.getLogger("ai_parse_service")


# 复用 ai_match_service 的 key 获取逻辑
from services.ai_match_service import _get_api_key


_SYSTEM_PROMPT = """你是 Arc Raiders 订单文本解析器。把每行用户输入拆解为结构化的物品列表。

输入格式：JSON 数组，每个元素是一行待解析的原始文本。
输出格式：JSON 数组，长度必须等于输入长度。每个元素是该行解析出的物品对象数组（可能 0、1 或多个）。

每个物品对象的字段：
- raw_name (string, 必填): 物品名称，保持用户原文，不要翻译，不要补蓝图后缀
- quantity (integer > 0, 必填): 数量
- unit_price (number 或 null, 选填): 单价，单位人民币（用户输入的 r/rmb/元/¥ 都是人民币）

严格规则：
1. 数字必须从原文中明确提取，不能猜测、不能心算
2. 不能确定的字段一律返回 null（不要瞎填）
3. 如果一行明显不是物品（如群名、客户名、寒暄、空行），返回空数组 []
4. 不要修改物品名（不要翻译、不要补全、不要改简繁）
5. 如果一行包含多个物品（"5 个磁力 3 块一个 还要 10 个导线"），拆成多个物品对象
6. 总价/数量（如 "8块收50个炸药" = 8 元买 50 个）：unit_price = 总价 ÷ 数量
7. 【价格语义判定 - 非常重要】游戏里几乎所有物品单价都 < 5 元人民币。
   当用户写 "<名称> X<数量> 价格 <金额>"、"<名称>*<数量> <金额>元"、"<数量>个<名称> <金额>" 这类格式时：
   - 如果 (金额 ÷ 数量) 还能 < 5，则金额是总价，unit_price = 金额 ÷ 数量
   - 如果金额本身已经 < 5，则可能是单价，unit_price = 金额
   - "<金额>/个"、"<金额>/1"、"<金额>一个" 这种带"每个"语义的才是明确单价
   宁愿算成总价也不要把 > 5 的数字当单价。
8. 严格 JSON，不要 markdown 代码块，不要任何额外文字"""


# 游戏内物品单价经验上限（人民币/个）。高于此值时强烈怀疑 AI 把总价当单价。
from config import UNIT_PRICE_SANITY_MAX as _UNIT_PRICE_SANITY_MAX


def _validate_item(d) -> dict | None:
    """校验单个物品对象，无效返回 None。绝不接受 AI 幻觉数字。"""
    if not isinstance(d, dict):
        return None
    name = d.get("raw_name")
    if not isinstance(name, str) or not name.strip():
        return None
    qty = d.get("quantity")
    # 严格要求整数 > 0
    if isinstance(qty, bool):
        return None
    if not isinstance(qty, int):
        try:
            qty = int(qty)
        except (TypeError, ValueError):
            return None
    if qty <= 0:
        return None
    item = {"raw_name": name.strip(), "quantity": qty, "_ai_parsed": True}
    price = d.get("unit_price")
    if price is not None:
        try:
            p = float(price)
            if p < 0:
                return None
            # 兜底校正：单价高于经验上限 5 元时，视为总价，自动转成 p/qty
            # 条件：p > 5，且 p/qty 在合理范围（0 < unit <= 5）
            if p > _UNIT_PRICE_SANITY_MAX and qty > 1:
                corrected = round(p / qty, 6)
                if 0 < corrected <= _UNIT_PRICE_SANITY_MAX:
                    logger.info(
                        f"AI 单价纠正: '{name}' unit_price={p} → {corrected} "
                        f"(数量 {qty}，视为总价)"
                    )
                    p = corrected
            item["unit_price"] = p
        except (TypeError, ValueError):
            return None
    return item


def ai_parse_lines(lines: list[str]) -> list[list[dict]] | None:
    """
    把若干行未识别文本发给 Claude，返回与输入等长的二维列表。
    返回:
        list[list[dict]]: 外层等长于 lines，每个内层是该行解析出的 0/1/N 个物品
        None: 失败（API key 缺失、网络异常、JSON 错误等）
    每个物品对象额外带 `_ai_parsed: True` 标记，便于前端展示徽章。
    """
    if not lines:
        return []

    api_key = _get_api_key()
    if not api_key:
        logger.debug("AI 解析跳过：未配置 API key")
        return None

    try:
        import anthropic
        from config import CLAUDE_MODEL
    except ImportError:
        logger.warning("anthropic 包未安装，跳过 AI 解析")
        return None

    user_msg = (
        "请把以下每行文本解析为结构化物品列表：\n\n"
        + json.dumps(lines, ensure_ascii=False)
    )

    try:
        client = anthropic.Anthropic(api_key=api_key)
        response = client.messages.create(
            model=CLAUDE_MODEL,
            max_tokens=1024,
            system=_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_msg}],
        )
        raw_text = response.content[0].text.strip()
        # 保险：剥离 markdown 代码块
        if raw_text.startswith("```"):
            raw_text = raw_text.split("\n", 1)[1].rsplit("```", 1)[0].strip()

        data = json.loads(raw_text)
        if not isinstance(data, list) or len(data) != len(lines):
            logger.warning(
                f"AI 解析返回长度不匹配: 输入 {len(lines)} 行，输出 {len(data) if isinstance(data, list) else 'non-list'}"
            )
            return None

        # 逐行校验
        result: list[list[dict]] = []
        for row in data:
            if not isinstance(row, list):
                # 单个对象也容忍：包成单元素列表
                row = [row] if isinstance(row, dict) else []
            validated = []
            for raw_item in row:
                v = _validate_item(raw_item)
                if v is not None:
                    validated.append(v)
            result.append(validated)

        usage = response.usage
        items_count = sum(len(r) for r in result)
        logger.info(
            f"AI 解析完成: {len(lines)} 行 → {items_count} 个物品, "
            f"input={usage.input_tokens}, output={usage.output_tokens}"
        )
        return result

    except anthropic.APIError as e:
        logger.error(f"Claude API 调用失败: {e}")
        return None
    except (json.JSONDecodeError, KeyError, IndexError, TypeError) as e:
        logger.error(f"AI 解析响应解析失败: {e}")
        return None
    except Exception as e:
        logger.error(f"AI 解析异常: {e}", exc_info=True)
        return None
