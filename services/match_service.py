"""
模糊匹配服务：订单文本解析 + 物品/套餐匹配
这是系统的核心算法，从 app.py 剥离并重构
"""
import re
import logging
from config import UNIT_PRICE_SANITY_MAX, COIN_UNIT_PRICE
from services.item_service import load_item_data, load_display_names, load_search_aliases
from services.bundle_service import get_all_bundles, load_bundle_search_map, get_bundle_with_items

logger = logging.getLogger("match_service")


# ───────── 工具函数 ─────────

def get_bigrams(s: str) -> set:
    s = s.lower().strip()
    return set(s[i:i+2] for i in range(len(s) - 1)) if len(s) >= 2 else set(s)


def total_common_segments(a: str, b: str) -> tuple[int, int]:
    """返回 (所有连续匹配段总长, 最长单段长度)"""
    a, b = a.lower(), b.lower()
    if not a or not b:
        return 0, 0
    m = [[0] * (len(b) + 1) for _ in range(len(a) + 1)]
    longest = 0
    for i in range(1, len(a) + 1):
        for j in range(1, len(b) + 1):
            if a[i-1] == b[j-1]:
                m[i][j] = m[i-1][j-1] + 1
                longest = max(longest, m[i][j])
    total = 0
    for i in range(1, len(a) + 1):
        for j in range(1, len(b) + 1):
            if m[i][j] >= 2:
                if i == len(a) or j == len(b) or m[i+1][j+1] == 0:
                    total += m[i][j]
    return total, longest


_ROMAN_UNICODE_MAP = {ord(c): '' for c in 'ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅰⅱⅲⅳⅴⅵⅶⅷⅸⅹ'}


def strip_structural(s: str, strip_mk: bool = False) -> str:
    """去掉蓝图/Mk.N/罗马数字等结构关键词，用于打分"""
    s = s.translate(_ROMAN_UNICODE_MAP).lower()
    s = re.sub(r'蓝图|blueprint', '', s)
    if strip_mk:
        s = re.sub(r'mk\.?\s*\d+', '', s)
    s = re.sub(r'(?<![a-z])(i{1,3}|iv|vi{0,3}|ix|x)(?![a-z])', '', s)
    return re.sub(r'\s+', ' ', s).strip()


# 全角罗马数字 → 半角映射（用于 tier 提取前的归一）
_ROMAN_UNICODE_TO_ASCII = {
    'Ⅰ': 'I', 'Ⅱ': 'II', 'Ⅲ': 'III', 'Ⅳ': 'IV', 'Ⅴ': 'V',
    'Ⅵ': 'VI', 'Ⅶ': 'VII', 'Ⅷ': 'VIII', 'Ⅸ': 'IX', 'Ⅹ': 'X',
    'ⅰ': 'I', 'ⅱ': 'II', 'ⅲ': 'III', 'ⅳ': 'IV', 'ⅴ': 'V',
    'ⅵ': 'VI', 'ⅶ': 'VII', 'ⅷ': 'VIII', 'ⅸ': 'IX', 'ⅹ': 'X',
}
_ROMAN_TO_NUM = {'i': 1, 'ii': 2, 'iii': 3, 'iv': 4, 'v': 5, 'vi': 6, 'vii': 7, 'viii': 8, 'ix': 9, 'x': 10}


def _extract_roman_tier(name: str) -> int | None:
    """
    从名称末尾提取罗马数字等级，返回 1-10 或 None。
    只识别结尾处的罗马数字，避免误把英文名里的 I/II 当 tier。
    允许前面是空格/下划线/短横/中文字符（如 "颂歌IV"），但前一个必须不是英文字母。
    示例：
      "铁砧 IV"     → 4
      "风暴Ⅱ"       → 2   (全角已预归一)
      "颂歌IV"      → 4
      "Anvil III"   → 3
      "Iron Sight"  → None  (Sight 全是字母，结尾不是纯罗马数字)
      "Mk III"      → 3
    """
    if not name:
        return None
    # 先把全角罗马数字归一成半角
    s = ''.join(_ROMAN_UNICODE_TO_ASCII.get(c, c) for c in name).strip()
    # 末尾必须是纯罗马数字 token，token 前必须不是英文字母（否则像 "Sight" 也会被匹到 "t"）
    m = re.search(r'(^|[^A-Za-z])([IVX]+)\s*$', s)
    if not m:
        return None
    return _ROMAN_TO_NUM.get(m.group(2).lower())


# ───────── 订单文本解析 ─────────

# ── 单行物品格式匹配器（按优先级排序）──
# 每个函数接收 line: str，返回 dict | list[dict] | None
# 返回 dict 表示匹配到一个物品，list 表示一行多物品，None 表示不匹配

def _parse_coin(line: str):
    """金币格式：250k / 80w / 100万 (后面可带 金币/金/coin)"""
    if '名称' in line or '购买数量' in line:
        return None
    m = re.search(r'(\d+(?:\.\d+)?)\s*([wW万kK])?\s*(?:金币|金|[Cc]oin[s]?)?', line)
    if not m:
        return None
    num_str, unit = m.group(1), (m.group(2) or '').lower()
    num = float(num_str)
    if unit in ('w', '万'):   num *= 10000
    elif unit == 'k':         num *= 1000
    if num >= 1000 and (unit or '金' in line or 'coin' in line.lower()):
        return {"raw_name": m.group(0).strip(), "quantity": 1,
                "_is_coin": True, "_coin_amount": int(num)}
    return None


def _parse_buy_total(line: str):
    """格式 E：<总价>收<数量><名称>  例: '8收50炸药混合物'"""
    m = re.match(r'^\s*(\d+(?:\.\d+)?)\s*收\s*(\d+)\s*(\S.*?)\s*$', line)
    if not m:
        return None
    total, qty, name = float(m.group(1)), int(m.group(2)), m.group(3).strip()
    if name and qty > 0:
        return {"raw_name": name, "quantity": qty, "unit_price": round(total / qty, 6)}
    return None


def _parse_buy_unit(line: str):
    """格式 F：收<数量><名称> <单价>/1  例: '收40arc 线圈 0.25/1'"""
    m = re.match(r'^\s*收\s*(\d+)\s*(\S.*?)\s*(\d+(?:\.\d+)?)\s*/\s*1?\s*$', line)
    if not m:
        return None
    qty, name, price = int(m.group(1)), m.group(2).strip(), float(m.group(3))
    if name and qty > 0:
        return {"raw_name": name, "quantity": qty, "unit_price": price}
    return None


def _parse_star_paren(line: str):
    """格式 B：*<数量>(<名称>) <单价>/  例: '*3(发动机) 0.4/'"""
    m = re.match(
        r'^\s*\*\s*(\d+)\s*[(（]\s*(.+?)\s*[)）]\s*(\d+(?:\.\d+)?)\s*/?\s*$', line)
    if not m:
        return None
    qty, name, price = int(m.group(1)), m.group(2).strip(), float(m.group(3))
    if name and qty > 0:
        return {"raw_name": name, "quantity": qty, "unit_price": price}
    return None


def _parse_name_star(line: str):
    """格式 A：<名称>*<数量> [<单价>]  例: '火箭手*21', '处理器*10 0.15'"""
    m = re.match(
        r'^\s*(\S.*?)\s*\*\s*(\d+)(?:\s+(\d+(?:\.\d+)?)\s*[rR元¥]?\s*(?:/\s*[个组张]?)?)?\s*$',
        line)
    if not m:
        return None
    name, qty, price = m.group(1).strip(), int(m.group(2)), m.group(3)
    if name and qty > 0:
        item = {"raw_name": name, "quantity": qty}
        if price is not None:
            item["unit_price"] = float(price)
        return item
    return None


def _parse_qty_star(line: str):
    """格式 A2：<数量>*<名称>  例: '100*高级机械元件'"""
    m = re.match(r'^\s*(\d+)\s*\*\s*(\S.+?)\s*$', line)
    if not m:
        return None
    qty, name = int(m.group(1)), m.group(2).strip()
    if name and qty > 0:
        return {"raw_name": name, "quantity": qty}
    return None


def _parse_qty_x_name(line: str):
    """格式 A3：<数量>x<名称> [<单价>/个]  例: '2x 跳跃者脉冲单元', '8x 投弹手电池 0.8/个'"""
    m = re.match(
        r'^\s*(\d+)\s*[xX×][\s\t]+(\S.*?)(?:[\s\t]+(\d+(?:\.\d+)?)\s*/\s*[个组]?)?\s*$',
        line)
    if not m:
        return None
    qty, name, price = int(m.group(1)), m.group(2).strip(), m.group(3)
    if name and qty > 0:
        item = {"raw_name": name, "quantity": qty}
        if price is not None:
            item["unit_price"] = float(price)
        return item
    return None


def _parse_name_x_total(line: str):
    """格式 C2：<名称> X<数量> 价格 <总价>  例: '掩埋废城市政厅钥匙 X3 价格 7.5'"""
    m = re.match(
        r'^\s*(\S.*?)\s*[xX×]\s*(\d+)\s*价格\s*(\d+(?:\.\d+)?)\s*$', line)
    if not m:
        return None
    name, qty, total = m.group(1).strip(), int(m.group(2)), float(m.group(3))
    if name and qty > 0:
        return {"raw_name": name, "quantity": qty, "unit_price": round(total / qty, 6)}
    return None


def _parse_name_x_qty(line: str):
    """格式 C：<名称>X<数量> [<单价>]  例: '钢制弹簧X35', '(勘测师保险库) x 4 0.8'"""
    m = re.match(r'^\s*(\S.*?)\s*[xX×]\s*(\d+)(?:\s+(\d+(?:\.\d+)?))?\s*$', line)
    if not m:
        return None
    name, qty, price = m.group(1).strip(), int(m.group(2)), m.group(3)
    if name and qty > 0:
        item = {"raw_name": name, "quantity": qty}
        if price is not None:
            item["unit_price"] = float(price)
        return item
    return None


def _parse_compact(line: str):
    """紧凑格式：<数量><名称><单价>[r/元]一个  例: '2女王1.2一个', '4汽化1.5r一个'"""
    m = re.match(
        r'^\s*(\d+)\s*(\S.*?)\s*(\d+(?:\.\d+)?)\s*[rR元]?\s*(?:一个|一组|一张|个|张)\s*$',
        line)
    if not m:
        return None
    qty, name, price = int(m.group(1)), m.group(2).strip(), float(m.group(3))
    if name and qty > 0:
        return {"raw_name": name, "quantity": qty, "unit_price": price}
    return None


def _parse_generic(line: str):
    """通用格式：名称：xxx 购买数量：N组"""
    results = []
    for m in re.finditer(
        r'名称\s*[：:]\s*(.+?)\s*购买数量\s*[：:]\s*(\d+)\s*组', line
    ):
        raw_name = m.group(1).strip()
        quantity = int(m.group(2))
        if not raw_name or quantity <= 0:
            continue
        # 检查是否是金币格式
        m_coin = re.match(r'^(\d+(?:\.\d+)?)\s*([wW万kK])?$', raw_name)
        if m_coin:
            num = float(m_coin.group(1))
            unit = (m_coin.group(2) or '').lower()
            if unit in ('w', '万'):   num *= 10000
            elif unit == 'k':         num *= 1000
            if num >= 1000:
                results.append({"raw_name": raw_name, "quantity": quantity,
                                "_is_coin": True, "_coin_amount": int(num * quantity)})
                continue
        results.append({"raw_name": raw_name, "quantity": quantity})
    return results if results else None


_QTY_WORDS = '个卷根条块把张片颗支瓶箱组套份只'


def _parse_qty_unit_total(line: str):
    """格式 J：<数量>[量词]<名称> <价格>[/][个|组|r]?
    例: '3 个发动机  1.5'  → 待定（历史对比）
        '4个脉冲单元 0.5/' → 有 / 后缀 → 明确单价
        '10个ARC线圈 2'   → 待定
    有单价标记（/、r、/个）时直接当单价，否则标记为待定交给 parse_and_match 判别。"""
    m = re.match(
        r'^\s*(\d+)\s*([' + _QTY_WORDS + r'])\s*(\S.*?)'
        r'\s+(\d+(?:\.\d+)?)\s*([rR/]?\s*[' + _QTY_WORDS + r']?)?\s*$',
        line
    )
    if not m:
        return None
    qty    = int(m.group(1))
    name   = m.group(3).strip()
    price  = float(m.group(4))
    suffix = (m.group(5) or '').strip()  # 如 "/"、"r"、"/个"、""

    if not name or len(name) < 2 or qty <= 0 or price <= 0:
        return None

    # 有单价标记（/ 或 r）→ 明确是单价
    if suffix:
        if price <= UNIT_PRICE_SANITY_MAX:
            return {"raw_name": name, "quantity": qty, "unit_price": price}
        return None

    # 无标记 → 待定，由 parse_and_match 参照历史判别
    if price <= UNIT_PRICE_SANITY_MAX * qty:
        return {
            "raw_name": name, "quantity": qty,
            "_price_ambiguous": True,
            "_raw_price": price,
        }
    return None


def _parse_qty_name_price(line: str):
    """格式 I：<数量>[空格?]<名称><单价>（价格紧贴名称、无量词 → 单价模式）
    例: '10勘探师保险库0.6', '20 ARC合成树脂0.5'
    单价必须 ≤ UNIT_PRICE_SANITY_MAX（经验上限），超过则视为物品名的一部分。
    名称部分必须 ≥2 字符且含中文或英文字母，防止误匹配纯数字行。"""
    m = re.match(
        r'^\s*(\d+)\s*([A-Za-z\u4e00-\u9fff][\S\s]*?)(\d+(?:\.\d+)?)\s*$', line
    )
    if not m:
        return None
    qty   = int(m.group(1))
    name  = m.group(2).strip()
    price = float(m.group(3))
    if name and len(name) >= 2 and qty > 0 and 0 < price <= UNIT_PRICE_SANITY_MAX:
        return {"raw_name": name, "quantity": qty, "unit_price": price}
    return None


def _parse_qty_bare(line: str):
    """格式 G：<数量>[量词]<名称>  例: '50ARC线圈', '100个处理器'"""
    m = re.match(r'^\s*(\d+)\s*([个卷根条块把张片颗支瓶箱组套份只])(\S{2,}.*?)\s*$', line)
    if not m:
        m = re.match(r'^\s*(\d+)([A-Za-z\u4e00-\u9fff]\S*.*?)\s*$', line)
    if not m:
        return None
    qty = int(m.group(1))
    name = m.group(len(m.groups())).strip()
    if name and qty > 0:
        return {"raw_name": name, "quantity": qty}
    return None


def _parse_name_num(line: str):
    """格式 H：<中文名><数量>  例: '导线60', '高级机械零件 20'"""
    m = re.match(r'^\s*([\u4e00-\u9fff][\u4e00-\u9fff\w]*?)\s*(\d+)\s*$', line)
    if not m:
        return None
    name, qty = m.group(1).strip(), int(m.group(2))
    if name and qty > 0:
        return {"raw_name": name, "quantity": qty}
    return None


# 格式匹配器优先级列表（顺序很重要，具体格式在前、宽泛格式在后）
_LINE_PARSERS = [
    _parse_coin,
    # E/F（含"收"字的格式）已在 parse_order_text 主循环中优先处理，不放这里
    _parse_star_paren,     # B: *<数量>(<名称>) <单价>/
    _parse_name_star,      # A: <名称>*<数量> [<单价>]
    _parse_qty_star,       # A2: <数量>*<名称>
    _parse_qty_x_name,     # A3: <数量>x<名称> [<单价>/个]
    _parse_name_x_total,   # C2: <名称> X<数量> 价格 <总价>
    _parse_name_x_qty,     # C: <名称>X<数量> [<单价>]
    _parse_compact,        # 紧凑: <数量><名称><单价>一个
    _parse_generic,        # 通用: 名称：xxx 购买数量：N组
    _parse_qty_unit_total, # J: <数量>[量词]<名称> <总价> (÷数量得单价)
    _parse_qty_name_price, # I: <数量><名称><单价> (单价≤5)
    _parse_qty_bare,       # G: <数量>[量词]<名称>
    _parse_name_num,       # H: <中文名><数量>
]


def _preprocess_lines(text: str) -> list[str]:
    """预处理原始文本：拆行、逗号分隔、多物品拆分"""
    text = re.sub(r'(\d+\s*组)\s*(?=区服|名称)', r'\1\n', text)
    raw_lines = text.strip().splitlines()

    # 逗号 / 加号分隔的多物品拆行
    # "100处理器+100高级电子+200机械元件" → 3 行
    # "50个轻型枪械零件，50个中型枪械零件" → 2 行
    expanded = []
    for raw_line in raw_lines:
        stripped = raw_line.strip()
        if '，' in stripped or ',' in stripped or '+' in stripped:
            segments = re.split(r'[，,+]\s*', stripped)
            if len(segments) >= 2 and all(re.search(r'\d', s) for s in segments if s.strip()):
                expanded.extend(s for s in segments if s.strip())
                continue
        expanded.append(raw_line)

    # 单行多物品拆分（2+空格分隔的 name*qty 模式）
    lines = []
    for raw_line in expanded:
        stripped = raw_line.strip()
        if len(re.findall(r'\*\s*\d+', stripped)) >= 2:
            segments = re.split(r'\s{2,}', stripped)
            if len(segments) >= 2 and all(
                re.search(r'[*xX×]\s*\d+', s) for s in segments
            ):
                lines.extend(segments)
                continue
        lines.append(raw_line)
    return lines


def _detect_customer(line: str):
    """检测客户ID（含#号的标识符），返回 customer_id 或 None"""
    if '#' not in line or '名称' in line or '购买数量' in line:
        return None
    m = re.search(r'(\S+#\S+)', line)
    return m.group(1).strip() if m else None


def parse_order_text(text: str) -> dict:
    """
    解析原始订单文本，按客户ID分组返回多个订单。
    返回 {"orders": [{"customer": "客户ID或空", "items": [...]}, ...]}
    """
    lines = _preprocess_lines(text)

    groups = []
    current_customer = ""
    current_items    = []
    collect_mode     = False

    for line in lines:
        line = line.strip()
        if not line:
            continue

        # ── 客户ID检测 ──
        cid = _detect_customer(line)
        if cid:
            if current_items and not current_customer:
                groups.append({"customer": cid, "items": current_items})
                current_items = []
                current_customer = ""
            elif current_items and current_customer:
                groups.append({"customer": current_customer, "items": current_items})
                current_items = []
                current_customer = cid
            else:
                current_customer = cid
            continue

        # ── "收" 相关格式：先用原始行尝试格式 E/F（它们的正则含"收"字）──
        _shou_result = _parse_buy_total(line) or _parse_buy_unit(line)
        if _shou_result:
            current_items.append(_shou_result)
            continue

        # ── "收" 前缀处理：剥离"收"后继续走通用匹配器 ──
        if re.match(r'^\s*收\s*$', line):
            collect_mode = True
            continue
        m_shou = re.match(r'^\s*收\s*(.+)$', line)
        if m_shou:
            collect_mode = True
            line = m_shou.group(1).strip()

        # ── 按优先级尝试所有格式匹配器 ──
        matched = False
        for parser in _LINE_PARSERS:
            result = parser(line)
            if result is not None:
                if isinstance(result, list):
                    current_items.extend(result)
                else:
                    current_items.append(result)
                matched = True
                break
        if matched:
            continue

        # ── 兜底：collect_mode 下裸物品名按数量=1 ──
        if collect_mode:
            current_items.append({"raw_name": line, "quantity": 1})
            continue

        # ── 最终兜底：未识别行，占位符等 AI 兜底 ──
        current_items.append({"raw_name": line, "quantity": 1, "_unparsed": True})

    if current_items:
        groups.append({"customer": current_customer, "items": current_items})

    return {"orders": groups}


def _normalize_raw_name(raw: str) -> str:
    """清理原始名称：去掉列表标记、方括号前缀、方案标识等"""
    name = raw.strip()
    # 去掉列表标记前缀：· / - / * / • / ◦ / ‣ 等
    name = re.sub(r'^[\s·\-\*•◦‣]+', '', name).strip()
    # 去掉中文量词前缀（个/卷/根/条/块/把/张/片/颗/支/瓶/箱/组/套/份/只）
    # 仅当量词后跟 ≥2 字符时才剥离，防止 "组件" 被拆
    name = re.sub(r'^[个卷根条块把张片颗支瓶箱组套份只](?=\S{2})', '', name).strip()
    # 去掉整体包裹的圆括号：(名称) / （名称）
    name = re.sub(r'^[（(]\s*(.+?)\s*[）)]$', r'\1', name)
    # 去掉游戏名前缀："ARC Raiders：" / "Arc Raiders:" / "ARCRaiders：" 等
    # 这类前缀里的 "ARC" 字面量会污染 bigram 匹配，必须先剥离
    name = re.sub(
        r'^\s*ARC[\s_]*Raiders?\s*[：:]\s*', '', name, flags=re.IGNORECASE
    ).strip()
    # 去掉 [xxx] / 【xxx】 前缀（分类标签，对匹配无用）
    name = re.sub(r'^\s*[\[【][^\]】]*[\]】]\s*', '', name).strip()
    # 【改装武器】风暴（方案 A）→ 风暴A
    name = re.sub(r'【[^】]*】', '', name).strip()
    # （方案 A）/ (Plan B) → A / B
    name = re.sub(r'[（(]\s*方案\s*([A-Za-z])\s*[）)]', r'\1', name)
    name = re.sub(r'[（(]\s*[Pp]lan\s*([A-Za-z])\s*[）)]', r'\1', name)
    return re.sub(r'\s+', ' ', name).strip()


# ───────── 物品模糊匹配 ─────────

def _word_fuzzy_match(a: str, b: str) -> bool:
    """两个英文单词是否匹配：完全相同，或一个是另一个的前缀（>=4字符）"""
    if a == b:
        return True
    if len(a) >= 4 and b.startswith(a):
        return True
    if len(b) >= 4 and a.startswith(b):
        return True
    return False


def _clean_word(w: str) -> str:
    """清理单词中的标点：(survivor) → survivor, mk.3 → mk3, 'Nade → nade"""
    return re.sub(r'[()（）\[\]【】.,;:!?\'\"\'\'\"\"\`~]+', '', w).strip()


def fuzzy_match_items(name_q: str, top: int = 6, force_blueprint: bool = False) -> list:
    """
    对单个物品名称做模糊匹配，返回最多 top 个候选。
    force_blueprint=True 时，即使 name_q 里没有"蓝图"关键词，也只在蓝图池里搜索。
    """
    items_db       = load_item_data()
    display_names  = load_display_names()
    search_aliases = load_search_aliases()

    name_q = re.sub(r'^\s*[\[【][^\]】]*[\]】]\s*', '', name_q).strip()
    name_q_lower = name_q.lower().strip()
    if not name_q_lower:
        return []

    # 特征提取
    q_has_blueprint = force_blueprint or '蓝图' in name_q_lower or 'blueprint' in name_q_lower
    mk_match        = re.search(r'mk\.?\s*(\d+)', name_q_lower)
    q_mk_num        = mk_match.group(1) if mk_match else None
    # 罗马数字等级（I/II/III/IV）：用于武器 tier 判别
    # 同时支持全角罗马数字 Ⅰ-Ⅳ 和半角 I-IV
    q_tier = _extract_roman_tier(name_q)

    # ── 搜索别名精确匹配 ──
    q_norm = name_q.replace(" ", "").lower()
    if q_norm in search_aliases:
        item_id = search_aliases[q_norm]
        meta    = items_db.get(item_id, {})
        if meta:
            return [{
                "item_id":  item_id,
                "name_zh":  display_names.get(item_id, meta.get("name_zh", item_id)),
                "name_en":  meta.get("name_en", item_id),
                "rarity":   meta.get("rarity", ""),
                "score":    100,
                "image_url": f"/api/items/{item_id}/image",
            }]

    # ── 候选池过滤 ──
    if q_has_blueprint and q_mk_num:
        pool = {k: v for k, v in items_db.items()
                if 'blueprint' in k and f'mk{q_mk_num}' in k}
    elif q_has_blueprint:
        pool = {k: v for k, v in items_db.items() if 'blueprint' in k}
    elif q_mk_num:
        pool = {k: v for k, v in items_db.items()
                if f'mk{q_mk_num}' in k and 'blueprint' not in k}
    else:
        pool = {k: v for k, v in items_db.items() if 'blueprint' not in k}

    # ── item_id 精确匹配（英文名直接转 item_id 格式）──
    # 清理标点：mk.3 → mk3, (survivor) → survivor, 'Nade → nade
    q_as_id = re.sub(r'[()（）\[\]【】.,;:!?\'\"\'\'\"\"\`~]+', '', name_q_lower)
    q_as_id = re.sub(r'\s+', '_', q_as_id.strip()).replace('-', '_')
    # 蓝图模式下，给 item_id 加 _blueprint 后缀尝试
    id_candidates = [q_as_id]
    if q_has_blueprint and not q_as_id.endswith('_blueprint'):
        id_candidates.insert(0, q_as_id + '_blueprint')
    for try_id in id_candidates:
        if try_id in pool:
            meta = pool[try_id]
            return [{
                "item_id":  try_id,
                "name_zh":  display_names.get(try_id, meta.get("name_zh", try_id)),
                "name_en":  meta.get("name_en", try_id),
                "rarity":   meta.get("rarity", ""),
                "score":    100,
                "image_url": f"/api/items/{try_id}/image",
            }]

    # ── 打分 ──
    score_q    = strip_structural(name_q_lower, strip_mk=bool(q_mk_num))
    q_bigrams  = get_bigrams(score_q)
    q_paren_m  = re.search(r'[（(]([^）)]+)[）)]', score_q)
    q_paren    = q_paren_m.group(1).strip() if q_paren_m else ""
    # 检测查询是否为纯英文（无中文字符）
    is_english_query = not bool(re.search(r'[\u4e00-\u9fff]', name_q_lower))
    # 英文词集（用于词级匹配）— 只排除真正的结构性前缀
    _noise = {'', 'the', 'a', 'an', 'of', 'blueprint', 'modded', 'weapon', 'expedition', 'material'}
    q_words    = set(_clean_word(w) for w in re.split(r'[\s_]+', name_q_lower)) - _noise

    scores = []
    for item_id, meta in pool.items():
        name_zh   = display_names.get(item_id, meta.get("name_zh", ""))
        name_en   = meta.get("name_en") or ""
        score_s   = strip_structural(name_zh, strip_mk=bool(q_mk_num))
        best      = _score(score_q, score_s, q_bigrams)

        # 字符级英文打分
        for en_name in [name_en, item_id.replace('_', ' ')]:
            if en_name:
                en_s = strip_structural(en_name, strip_mk=bool(q_mk_num))
                en_score = _score(score_q, en_s, q_bigrams)
                best = max(best, en_score)

        # 词级匹配：把查询和候选都拆成单词，算重叠率
        word_best = 0
        if q_words and len(q_words) >= 2:
            id_words = set(_clean_word(w) for w in item_id.split('_')) - _noise
            en_words = set(_clean_word(w) for w in re.split(r'[\s_]+', name_en.lower())) - _noise if name_en else set()
            for target_words in [id_words, en_words]:
                if target_words:
                    common = sum(1 for qw in q_words if any(_word_fuzzy_match(qw, tw) for tw in target_words))
                    total  = max(len(q_words), len(target_words))
                    if common > 0:
                        word_score = int(common / total * 100)
                        if common == len(q_words) == len(target_words):
                            word_score = 100
                        elif common == len(q_words):
                            word_score = max(word_score, 85)
                        word_best = max(word_best, word_score)

        # 纯英文查询时：词级匹配才是可靠信号
        # 如果词级匹配很低但字符级评分较高，说明是噪声碰撞，要压制
        if is_english_query and q_words and len(q_words) >= 2:
            if word_best >= 60:
                best = max(best, word_best)  # 词级高分直接采用
            elif word_best > 0:
                best = max(min(best, 50), word_best)  # 词级低但有，压制字符级
            else:
                best = min(best, 30)  # 词级完全没命中，字符级最高30分
        else:
            best = max(best, word_best)

        # 罗马数字等级匹配（武器 tier）
        # 查询带等级时：相同等级 +5，不同等级 -30；
        # 查询不带等级但候选带等级时：保持原分（不惩罚，让用户未指定时返回任意）
        if best > 0 and q_tier is not None:
            s_tier = _extract_roman_tier(name_zh) or _extract_roman_tier(name_en)
            if s_tier is not None:
                if s_tier == q_tier:
                    best = min(100, best + 5)
                else:
                    best = max(1, best - 30)

        # 括号加减分
        if best > 0 and q_paren:
            s_paren_m = re.search(r'[（(]([^）)]+)[）)]', name_zh.lower())
            if not s_paren_m:
                s_paren_m = re.search(r'[（(]([^）)]+)[）)]', name_en.lower())
            if s_paren_m:
                s_paren = s_paren_m.group(1).strip()
                overlap = sum(1 for c in q_paren if c in s_paren) / max(len(q_paren), 1)
                lcs_p, _ = total_common_segments(q_paren, s_paren)
                if lcs_p >= 1 or overlap >= 0.5:
                    best = min(100, best + int(overlap * 20))
                else:
                    best = max(1, best - 15)

        if best > 0:
            scores.append((best, item_id, name_zh, meta.get("rarity", "")))

    scores.sort(key=lambda x: -x[0])
    results = [
        {
            "item_id":   s[1],
            "name_zh":   s[2],
            "name_en":   items_db[s[1]].get("name_en", s[1]),
            "rarity":    s[3],
            "score":     s[0],
            "image_url": f"/api/items/{s[1]}/image",
        }
        for s in scores[:top]
    ]

    # jieba 兜底
    if not results or results[0]["score"] < 50:
        results = _jieba_fallback(name_q, pool, display_names, results, top)

    return results


def _score(score_q: str, score_s: str, q_bigrams: set) -> int:
    s = score_s.lower().strip()
    if not s:
        return 0
    q_norm = score_q.replace(" ", "")
    s_norm = s.replace(" ", "")
    if not q_norm:
        return 0
    if q_norm == s_norm:
        return 100
    if q_norm in s_norm:
        diff = len(s_norm) - len(q_norm)
        return max(55, 85 - diff * 10)
    if s_norm in q_norm:
        diff = len(q_norm) - len(s_norm)
        return max(20, 50 - diff * 10)

    total_seg, lcs = total_common_segments(score_q, s)
    lcs_ratio      = lcs / max(len(score_q), 1)
    s_bigrams      = get_bigrams(s)
    bigram_overlap = len(q_bigrams & s_bigrams) / max(len(q_bigrams), 1) if q_bigrams and s_bigrams else 0.0
    char_overlap   = sum(1 for c in score_q if c in s) / max(len(score_q), 1)
    pos_score      = 0
    if abs(len(score_q) - len(s)) <= 1 and min(len(score_q), len(s)) >= 2:
        diff_chars = sum(1 for a, b in zip(score_q, s) if a != b) + abs(len(score_q) - len(s))
        if diff_chars <= 1:
            pos_score = 80
        elif diff_chars <= 2:
            pos_score = 55
        elif diff_chars <= 3:
            pos_score = 35

    lcs_weight = 90 if lcs >= 3 else 70
    lcs_score  = lcs_ratio * lcs_weight + (20 if lcs >= 3 else 0)
    extra_bonus = (total_seg - lcs) * 8
    score = max(lcs_score + extra_bonus, bigram_overlap * 65, char_overlap * 45, pos_score)

    if lcs < 2 and total_seg < 2 and bigram_overlap == 0 and char_overlap < 0.5 and pos_score < 30:
        return 0

    len_penalty = min(20, max(0, len(s_norm) - len(q_norm)) * 3)
    return max(1, int(score - len_penalty))


def _jieba_fallback(name_q: str, pool: dict, display_names: dict, existing: list, top: int) -> list:
    try:
        import jieba.posseg as pseg
        STOP = set("的了和与在是一个这那小大很好新旧有无不也都")
        word_pairs = [(w.word, w.flag) for w in pseg.cut(name_q)
                      if w.word.strip() and w.word not in STOP]
        nouns  = [w for w, f in word_pairs if f.startswith('n') and len(w) >= 2]
        others = [w for w, f in word_pairs if not f.startswith('n') and len(w) >= 2]
        single = []
        for w in (nouns or [w for w, _ in word_pairs]):
            for ch in w:
                if ch not in STOP and ch not in single and ch.strip():
                    single.append(ch)

        seen = {r["item_id"] for r in existing}
        extra = []

        def _kw_search(kw):
            for item_id, meta in pool.items():
                if item_id in seen:
                    continue
                nz = display_names.get(item_id, meta.get("name_zh", ""))
                if kw in nz.lower():
                    seen.add(item_id)
                    extra.append({
                        "item_id":  item_id,
                        "name_zh":  nz,
                        "name_en":  meta.get("name_en", item_id),
                        "rarity":   meta.get("rarity", ""),
                        "score":    30,
                        "image_url": f"/api/items/{item_id}/image",
                    })

        for w in nouns + others + single:
            if len(existing) + len(extra) >= top:
                break
            _kw_search(w)

        return (existing + extra)[:top]
    except ImportError:
        return existing


# ───────── 套餐模糊匹配 ─────────

# 圈数字 → 普通数字映射
_CIRCLED_DIGITS = {
    '①':'1','②':'2','③':'3','④':'4','⑤':'5',
    '⑥':'6','⑦':'7','⑧':'8','⑨':'9','⑩':'10',
    '⓪':'0','⑪':'11','⑫':'12','⑬':'13','⑭':'14','⑮':'15',
}

def _normalize_bundle_query(s: str) -> str:
    """标准化套餐查询：圈数字→数字，~→-，去括号符号"""
    for c, d in _CIRCLED_DIGITS.items():
        s = s.replace(c, d)
    s = re.sub(r'[【】\[\]()（）]', '', s)
    s = s.replace('~', '-').replace('～', '-')
    return re.sub(r'\s+', ' ', s).strip().lower()


def fuzzy_match_bundles(raw_name: str, qty: int, top: int = 6) -> list:
    """对套餐做模糊匹配。使用原始名称（含【】前缀）进行匹配。"""
    cleaned    = _normalize_bundle_query(raw_name)
    normalized = _normalize_raw_name(raw_name).lower()

    if not cleaned and not normalized:
        return []

    # 必须包含数字、Lv、或末尾方案字母才尝试匹配套餐
    _roman = {'i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x'}
    def _check_hint(s):
        if not s: return False
        if re.search(r'[0-9]|lv', s): return True
        tail = re.search(r'(?<![a-z])([a-z])$', s.strip())
        return bool(tail and tail.group(1) not in _roman)

    if not _check_hint(cleaned) and not _check_hint(normalized):
        return []

    search_map = load_bundle_search_map()

    # ── 远征/Expedition 专用匹配 ──
    # 识别模式: "远征N材料底座 X-Y" / "Expedition N Material Foundation X~Y"
    expedition_match = re.search(
        r'(?:远征|expedition)\s*(\d+)\s*(?:材料|material)\s*(?:底座|foundation)\s*(\d+(?:[~\-]\d+)?)',
        cleaned, re.IGNORECASE
    )
    if expedition_match:
        season_num = expedition_match.group(1)  # e.g. "3" or "1"
        stage_range = expedition_match.group(2).replace('~', '-')  # e.g. "1-4"
        # 尝试匹配: "远征项目 (第N赛季) 阶段X-Y" 或 "远征 (season N) 阶段X-Y"
        for key, bundle_id in search_map.items():
            # 检查 key 是否包含相同赛季号和阶段范围
            key_season = re.search(r'(?:第(\d+)赛季|season\s*(\d+))', key, re.IGNORECASE)
            key_stage  = re.search(r'阶段\s*(\d+(?:-\d+)?)', key)
            if key_season and key_stage:
                ks = key_season.group(1) or key_season.group(2)
                kstage = key_stage.group(1)
                if ks == season_num and kstage == stage_range:
                    b = get_bundle_with_items(bundle_id)
                    if b:
                        return [_bundle_to_candidate(b, qty, 100)]

    # ── 精确匹配（优先 normalized） ──
    for candidate in [normalized, cleaned]:
        if candidate and candidate in search_map:
            b = get_bundle_with_items(search_map[candidate])
            if b:
                return [_bundle_to_candidate(b, qty, 100)]

    # ── 模糊匹配 ──
    scores = []
    for key, bundle_id in search_map.items():
        sc1 = _bundle_score(cleaned, key)
        sc2 = _bundle_score(normalized, key) if normalized != cleaned else 0
        sc  = max(sc1, sc2)
        if sc > 0:
            scores.append((sc, bundle_id))

    scores.sort(key=lambda x: -x[0])
    seen  = set()
    result = []
    for sc, bid in scores[:top]:
        if bid in seen:
            continue
        seen.add(bid)
        b = get_bundle_with_items(bid)
        if b:
            result.append(_bundle_to_candidate(b, qty, sc))
    return result


def _bundle_score(query: str, key: str) -> int:
    """计算查询字符串与套餐名/别名的匹配分数"""
    if query == key:
        return 100
    if query in key or key in query:
        return 80
    _, lcs = total_common_segments(query, key)
    return int(lcs / max(len(query), 1) * 70) if lcs >= 2 else 0


def _bundle_to_candidate(b: dict, qty: int, score: int) -> dict:
    aliases = b.get("aliases", [])
    alias_zh = aliases[0]["alias"] if aliases else ""
    bundle_type = b.get("type", "item")
    candidate = {
        "item_id":      f"__bundle__{b['id']}",
        "name_zh":      alias_zh or b["name"],
        "name_en":      b["name"] if alias_zh else "",
        "rarity":       "套餐",
        "score":        score,
        "image_url":    "",
        "is_bundle":    True,
        "bundle_id":    b["id"],
        "bundle_type":  bundle_type,
        "bundle_items": [
            {"item_id": it["item_id"], "name_zh": it["name_zh"], "quantity": it["quantity"] * qty}
            for it in b.get("items", [])
        ],
    }
    # 服务型/混合型附带价格
    if bundle_type in ("service", "mixed") and b.get("price") is not None:
        candidate["bundle_price"] = b["price"]
    return candidate


# ───────── 完整订单解析 ─────────

def _match_single_item(raw: str, qty: int) -> dict:
    """对单个物品行做匹配，返回 {raw_name, quantity, matched, candidates, suggest_bundle}"""
    norm = _normalize_raw_name(raw)

    is_blueprint = '蓝图' in raw or 'blueprint' in raw.lower()
    is_mk        = bool(re.search(r'mk\.?\s*\d+', raw.lower()))

    # 检测"改装武器 + 方案"模式
    is_modded_plan = bool(re.search(r'改装武器|modded\s*weapon', raw, re.IGNORECASE))
    plan_match     = re.search(r'[（(]\s*(?:方案|[Pp]lan)\s*([A-Za-z])\s*[）)]', raw)
    plan_letter    = plan_match.group(1).upper() if plan_match else ""

    # 套餐匹配（改装武器也要尝试，因为可能已经创建了对应套餐）
    # 用 norm 而不是 raw，避免 "ARC Raiders：" 之类前缀里的字面量污染 bigram 匹配
    bundle_cands = []
    if not is_blueprint and not is_mk:
        bundle_cands = fuzzy_match_bundles(norm, qty)

    # 改装武器：只接受高分套餐匹配（≥70），低分的是字符碰撞噪声
    if is_modded_plan and plan_letter and bundle_cands:
        good_bundles = [c for c in bundle_cands if c.get("score", 0) >= 70]
        if not good_bundles:
            bundle_cands = []  # 全部丢弃，让 suggest_bundle 接管

    # 物品匹配（始终用 norm，raw 可能含游戏名前缀干扰打分）
    item_cands = fuzzy_match_items(norm, force_blueprint=is_blueprint)

    # 改装武器 + 方案但没匹配到高质量套餐 → 建议创建套餐
    suggest_bundle = None
    if is_modded_plan and plan_letter and not bundle_cands:
        weapon_name = re.sub(r'^\s*[\[【][^\]】]*[\]】]\s*', '', raw).strip()
        weapon_name = re.sub(r'[（(]\s*(?:方案|[Pp]lan)\s*[A-Za-z]\s*[）)]', '', weapon_name).strip()
        if weapon_name:
            weapon_cands = fuzzy_match_items(weapon_name, force_blueprint=False)
            if weapon_cands and weapon_cands[0]["score"] >= 60:
                best_weapon = weapon_cands[0]
                weapon_zh = best_weapon["name_zh"] or weapon_name
                alias_base = re.sub(r'\s*[IVXivx]+\s*$', '', weapon_zh).strip()
                alias_base = re.sub(r'\s*\d+\s*$', '', alias_base).strip()
                if not alias_base:
                    alias_base = weapon_zh
                suggest_bundle = {
                    "bundle_name":    raw.strip(),
                    "bundle_alias":   f"{alias_base}{plan_letter}",
                    "weapon_item_id": best_weapon["item_id"],
                    "weapon_name_zh": best_weapon["name_zh"],
                    "plan_letter":    plan_letter,
                }
                if not item_cands or item_cands[0]["score"] < weapon_cands[0]["score"]:
                    item_cands = weapon_cands

    # 套餐优先，去重
    all_cands = bundle_cands + item_cands
    seen_ids  = set()
    deduped   = []
    for c in all_cands:
        if c["item_id"] not in seen_ids:
            seen_ids.add(c["item_id"])
            deduped.append(c)

    return {
        "raw_name":       raw,
        "quantity":       qty,
        "matched":        deduped[0] if deduped else None,
        "candidates":     deduped[1:8],
        "suggest_bundle": suggest_bundle,
    }


def _ai_replace_unparsed(parsed: dict) -> None:
    """
    扫描所有 group 的 items，找出 _unparsed=True 占位符，调 AI 解析后原地替换。
    AI 失败/无 key/网络错误时静默跳过，占位符保留（quantity=1）继续走模糊匹配。
    支持 1 行 → N 个物品（AI 拆分）。
    """
    # 收集占位符位置
    refs = []  # [(group_idx, item_idx)]
    for gi, group in enumerate(parsed.get("orders", [])):
        for ii, item in enumerate(group.get("items", [])):
            if item.get("_unparsed"):
                refs.append((gi, ii))

    if not refs:
        return

    try:
        from services.ai_parse_service import ai_parse_lines
    except Exception as e:
        logger.warning(f"加载 ai_parse_service 失败，跳过 AI 兜底解析: {e}")
        return

    lines_to_parse = [parsed["orders"][gi]["items"][ii]["raw_name"] for gi, ii in refs]
    logger.info(f"AI 兜底解析：{len(lines_to_parse)} 行未识别文本")

    try:
        ai_results = ai_parse_lines(lines_to_parse)
    except Exception as e:
        logger.warning(f"AI 兜底解析异常: {e}")
        ai_results = None

    if not ai_results:
        # AI 不可用：占位符保留（quantity=1），下游模糊匹配仍会试一次
        return

    # 按 group 聚合替换映射 {group_idx: {item_idx: [new_items]}}
    group_replacements: dict = {}
    for (gi, ii), parsed_items in zip(refs, ai_results):
        group_replacements.setdefault(gi, {})[ii] = parsed_items

    # 应用替换：用列表重建避免下标错位（1 行可能拆成多个物品）
    for gi, repls in group_replacements.items():
        old_items = parsed["orders"][gi]["items"]
        new_items = []
        for ii, item in enumerate(old_items):
            if ii in repls:
                new_for_line = repls[ii]
                if new_for_line:
                    new_items.extend(new_for_line)
                else:
                    # AI 返回空列表 = 这行不是物品（群名/寒暄等）→ 丢弃
                    logger.debug(f"AI 判定非物品行，丢弃: {item.get('raw_name', '')[:40]}")
            else:
                new_items.append(item)
        parsed["orders"][gi]["items"] = new_items


def _build_category_price_stats(saved_prices: dict, items_db: dict) -> dict:
    """构建 {rarity|type: {median, prices}} 分类价格统计，用于无历史记录时的兜底参照。"""
    from collections import defaultdict
    buckets = defaultdict(list)
    for item_id, price in saved_prices.items():
        meta = items_db.get(item_id)
        if not meta or price <= 0:
            continue
        key = f"{meta.get('rarity', '')}|{meta.get('type', '')}"
        buckets[key].append(price)

    stats = {}
    for key, prices in buckets.items():
        if len(prices) < 2:
            continue
        prices.sort()
        mid = len(prices) // 2
        median = prices[mid] if len(prices) % 2 else (prices[mid - 1] + prices[mid]) / 2
        stats[key] = {"median": median, "count": len(prices)}
    return stats


def _resolve_ambiguous_price(raw_price: float, qty: int, matched: dict | None,
                             saved_prices: dict, category_stats: dict,
                             items_db: dict) -> float:
    """判别待定价格是单价还是总价，返回单价。
    策略分三级：
    1. 有该物品历史单价 → 直接对比
    2. 无历史但有同品质同类型物品价格 → 用分类中位数对比
    3. 都没有 → 兜底按总价÷数量"""
    as_unit  = raw_price
    as_total = round(raw_price / qty, 6) if qty > 1 else raw_price

    if not matched or not matched.get("item_id"):
        return as_total

    item_id = matched["item_id"]

    # ── 第 1 级：该物品有历史单价 ──
    ref_price = saved_prices.get(item_id)

    # ── 第 2 级：同品质同类型的中位数 ──
    if not ref_price or ref_price <= 0:
        meta = items_db.get(item_id)
        if meta:
            key = f"{meta.get('rarity', '')}|{meta.get('type', '')}"
            cat = category_stats.get(key)
            if cat:
                ref_price = cat["median"]
                logger.debug(f"价格判别: {item_id} 无历史，用分类 {key} 中位数 {ref_price:.3f}（{cat['count']}个样本）")

    # ── 第 3 级：兜底 ──
    if not ref_price or ref_price <= 0:
        logger.debug(f"价格判别: {item_id} 无任何参照，兜底按总价÷{qty}")
        return as_total

    # 比较哪种解释更接近参照价
    diff_unit  = abs(as_unit - ref_price)
    diff_total = abs(as_total - ref_price)

    if diff_unit <= diff_total:
        logger.debug(f"价格判别: {raw_price} → 单价（参照={ref_price:.3f}, 差={diff_unit:.3f} vs {diff_total:.3f}）")
        return as_unit
    else:
        logger.debug(f"价格判别: {raw_price} → 总价÷{qty}={as_total}（参照={ref_price:.3f}, 差={diff_total:.3f} vs {diff_unit:.3f}）")
        return as_total


def parse_and_match(text: str) -> dict:
    """
    解析订单文本并按客户分组做模糊匹配。
    返回 {
        "orders": [
            {
                "customer": "客户ID或空",
                "items": [{raw_name, quantity, matched, candidates, suggest_bundle}, ...]
            },
            ...
        ]
    }
    """
    parsed = parse_order_text(text)

    # ── AI 兜底解析：把正则没识别的行交给 Claude 拆成结构化物品 ──
    # 仅在 API key 已配置且确实有未识别行时调用，发送量 = 未识别行数（极小）
    _ai_replace_unparsed(parsed)

    result_orders = []

    # 预加载金币套餐（名称含"金币"的套餐）
    _coin_bundle = None
    _coin_item_price = COIN_UNIT_PRICE
    search_map = load_bundle_search_map()
    for key, bid in search_map.items():
        if '金币' in key:
            b = get_bundle_with_items(bid)
            if b:
                _coin_bundle = b
                break

    # 预加载历史价格 + 分类统计，用于判别"待定价格"是单价还是总价
    _saved_prices = {}
    try:
        from database import get_conn
        with get_conn() as conn:
            for r in conn.execute("SELECT item_id, sell_price FROM item_prices").fetchall():
                if r["sell_price"] and r["sell_price"] > 0:
                    _saved_prices[r["item_id"]] = r["sell_price"]
    except Exception:
        pass
    _items_db = load_item_data()
    _category_stats = _build_category_price_stats(_saved_prices, _items_db) if _saved_prices else {}

    for group in parsed["orders"]:
        matched_items = []
        for line in group["items"]:
            if line.get("_is_coin") and _coin_bundle:
                # 金币需求：计算伙伴鸭数量
                coin_amount = line.get("_coin_amount", 0)
                duck_qty = coin_amount // _coin_item_price
                if coin_amount % _coin_item_price > 0:
                    duck_qty += 1
                actual_value = duck_qty * _coin_item_price
                matched = _bundle_to_candidate(_coin_bundle, 1, 100)
                matched["_is_coin"] = True
                matched["_coin_amount"] = coin_amount
                matched["_duck_qty"] = duck_qty
                matched["_actual_value"] = actual_value
                matched_items.append({
                    "raw_name":       line["raw_name"],
                    "quantity":       duck_qty,
                    "matched":        matched,
                    "candidates":     [],
                    "suggest_bundle": None,
                    "_is_coin":       True,
                    "_coin_amount":   coin_amount,
                    "_actual_value":  actual_value,
                })
            else:
                item = _match_single_item(line["raw_name"], line["quantity"])

                # 处理待定价格：参照历史单价判别是单价还是总价
                if line.get("_price_ambiguous") and line.get("_raw_price") is not None:
                    raw_p = line["_raw_price"]
                    qty   = line["quantity"]
                    item["unit_price"] = _resolve_ambiguous_price(
                        raw_p, qty, item.get("matched"),
                        _saved_prices, _category_stats, _items_db
                    )
                elif line.get("unit_price") is not None:
                    item["unit_price"] = line["unit_price"]

                # 透传来源标记：AI 解析出的 / 正则未识别的
                if line.get("_ai_parsed"):
                    item["_ai_parsed"] = True
                if line.get("_unparsed"):
                    item["_unparsed"] = True
                matched_items.append(item)
        result_orders.append({
            "customer": group["customer"],
            "items":    matched_items,
        })

    result = {"orders": result_orders}

    # AI 增强：对低分匹配项调用 Claude API
    try:
        from services.ai_match_service import apply_ai_matches
        result = apply_ai_matches(result)
    except Exception as e:
        logger.warning(f"AI 增强跳过: {e}")

    return result