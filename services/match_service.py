"""
模糊匹配服务：订单文本解析 + 物品/套餐匹配
这是系统的核心算法，从 app.py 剥离并重构
"""
import re
from services.item_service import load_item_data, load_display_names, load_search_aliases
from services.bundle_service import get_all_bundles, load_bundle_search_map, get_bundle_with_items


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


# ───────── 订单文本解析 ─────────

def parse_order_text(text: str) -> dict:
    """
    解析原始订单文本，按客户ID分组返回多个订单。
    返回 {
        "orders": [
            {"customer": "客户ID或空字符串", "items": [{raw_name, quantity}, ...]},
            ...
        ]
    }

    客户ID出现时，它后面的物品属于该客户，直到下一个客户ID出现。
    没有客户ID的物品归入 "" （匿名）组。
    """
    # ── 预处理：拆分多条挤在一行的情况 ──
    text = re.sub(r'(\d+\s*组)\s*(?=区服|名称)', r'\1\n', text)
    lines = text.strip().splitlines()

    # ── 按客户分组 ──
    groups = []           # [{customer, items}]
    current_customer = ""
    current_items    = []

    for line in lines:
        line = line.strip()
        if not line:
            continue

        # ── 客户ID检测 ──
        if '#' in line and '名称' not in line and '购买数量' not in line:
            m = re.search(r'(\S+#\S+)', line)
            if m:
                cid = m.group(1).strip()
                if current_items and not current_customer:
                    # 物品在前、客户名在后 → 这些物品归这个客户
                    groups.append({"customer": cid, "items": current_items})
                    current_items = []
                    current_customer = ""
                elif current_items and current_customer:
                    # 正常：前面有客户有物品，保存后开始新客户
                    groups.append({"customer": current_customer, "items": current_items})
                    current_items = []
                    current_customer = cid
                else:
                    # 还没有物品，客户名在开头
                    current_customer = cid
                continue

        # ── 金币格式：250k / 80w / 100万 / 500000 (后面可带"金币"/"金"/"coin") ──
        m_coin = re.search(
            r'(\d+(?:\.\d+)?)\s*([wW万kK])?\s*(?:金币|金|[Cc]oin[s]?)?',
            line
        )
        if m_coin and '名称' not in line and '购买数量' not in line:
            num_str, unit = m_coin.group(1), (m_coin.group(2) or '').lower()
            num = float(num_str)
            if unit in ('w', '万'):
                num *= 10000
            elif unit == 'k':
                num *= 1000
            # 只有金额 ≥ 1000 才视为金币需求（防止误匹配普通数字）
            if num >= 1000 and (unit or '金' in line or 'coin' in line.lower()):
                current_items.append({
                    "raw_name": m_coin.group(0).strip(),
                    "quantity": 1,
                    "_is_coin": True,
                    "_coin_amount": int(num),
                })
                continue

        # ── 通用物品解析 ──
        for m in re.finditer(
            r'名称\s*[：:]\s*(.+?)\s*购买数量\s*[：:]\s*(\d+)\s*组',
            line
        ):
            raw_name = m.group(1).strip()
            quantity = int(m.group(2))
            if not raw_name or quantity <= 0:
                continue
            # 检查 raw_name 是否是金币格式（如 "100 K", "80w", "500000"）
            m_coin_inner = re.match(r'^(\d+(?:\.\d+)?)\s*([wW万kK])?$', raw_name)
            if m_coin_inner:
                num = float(m_coin_inner.group(1))
                unit = (m_coin_inner.group(2) or '').lower()
                if unit in ('w', '万'): num *= 10000
                elif unit == 'k': num *= 1000
                if num >= 1000:
                    current_items.append({
                        "raw_name": raw_name,
                        "quantity": quantity,
                        "_is_coin": True,
                        "_coin_amount": int(num * quantity),
                    })
                    continue
            current_items.append({"raw_name": raw_name, "quantity": quantity})

    # 保存最后一组
    if current_items:
        groups.append({"customer": current_customer, "items": current_items})

    return {"orders": groups}


def _normalize_raw_name(raw: str) -> str:
    """清理原始名称：去掉方括号前缀、方案标识等"""
    name = raw.strip()
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
    bundle_cands = []
    if not is_blueprint and not is_mk:
        bundle_cands = fuzzy_match_bundles(raw, qty)

    # 改装武器：只接受高分套餐匹配（≥70），低分的是字符碰撞噪声
    if is_modded_plan and plan_letter and bundle_cands:
        good_bundles = [c for c in bundle_cands if c.get("score", 0) >= 70]
        if not good_bundles:
            bundle_cands = []  # 全部丢弃，让 suggest_bundle 接管

    # 物品匹配
    item_cands = fuzzy_match_items(norm, force_blueprint=is_blueprint)
    if norm != raw:
        raw_cands = fuzzy_match_items(raw, force_blueprint=is_blueprint)
        seen = {c["item_id"] for c in item_cands}
        for c in raw_cands:
            if c["item_id"] not in seen:
                item_cands.append(c)
        item_cands.sort(key=lambda x: -x["score"])

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
    result_orders = []

    # 预加载金币套餐（名称含"金币"的套餐）
    _coin_bundle = None
    _coin_item_price = 7000  # 伙伴鸭单价
    search_map = load_bundle_search_map()
    for key, bid in search_map.items():
        if '金币' in key:
            b = get_bundle_with_items(bid)
            if b:
                _coin_bundle = b
                break

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
                matched_items.append(
                    _match_single_item(line["raw_name"], line["quantity"])
                )
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