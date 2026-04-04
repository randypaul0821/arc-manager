"""
合成计算服务：计算给定库存下某物品可合成数量（支持多级递归）。

纯函数设计，无状态、无数据库依赖，可被 inventory / orders 等模块复用。
"""
from services.item_service import load_item_data

# ─────────────────────────────────────────────
#  核心计算
# ─────────────────────────────────────────────

def calc_craftable(item_id: str, inventory: dict, _depth: int = 0) -> int:
    """
    计算 inventory 中可以合成多少个 item_id。

    Args:
        item_id:   目标物品 ID
        inventory: {item_id: quantity} 可变字典，计算过程中会被消耗（模拟扣减）
        _depth:    递归深度（防止循环依赖死循环，上限 20）

    Returns:
        可合成数量（不含库存中已有的）
    """
    if _depth > 20:
        return 0

    items = load_item_data()
    item = items.get(item_id)
    if not item:
        return 0

    recipe = item.get("recipe", {})
    if not recipe:
        return 0  # 没有配方，无法合成

    # 二分搜索：最多能合成几份
    lo, hi = 0, _upper_bound(recipe, inventory, items, _depth)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if _can_craft_n(item_id, mid, inventory.copy(), items, _depth):
            lo = mid
        else:
            hi = mid - 1
    return lo


def calc_craftable_with_stock(item_id: str, inventory: dict) -> dict:
    """
    同时返回库存数量和可合成数量。

    Returns:
        {"stock": int, "craftable": int, "total": int}
    """
    stock = inventory.get(item_id, 0)
    # 合成时不消耗已有的目标物品本身，但原料会被消耗
    inv_copy = dict(inventory)
    craftable = calc_craftable(item_id, inv_copy)
    return {"stock": stock, "craftable": craftable, "total": stock + craftable}


def get_recipe_tree(item_id: str, _depth: int = 0) -> dict | None:
    """
    获取物品的完整递归合成树。

    Returns:
        {
            "item_id": str,
            "name_zh": str,
            "recipe": {ingredient_id: quantity, ...},
            "children": [get_recipe_tree(child), ...]
        }
        或 None（无配方的原材料）
    """
    if _depth > 20:
        return None

    items = load_item_data()
    item = items.get(item_id)
    if not item:
        return None

    recipe = item.get("recipe", {})
    if not recipe:
        return None

    children = []
    for ing_id in recipe:
        child = get_recipe_tree(ing_id, _depth + 1)
        if child:
            children.append(child)

    return {
        "item_id": item_id,
        "name_zh": item.get("name_zh", item_id),
        "recipe": recipe,
        "children": children,
    }


# ─────────────────────────────────────────────
#  内部辅助函数
# ─────────────────────────────────────────────

def _upper_bound(recipe: dict, inventory: dict, items: dict, depth: int) -> int:
    """估算合成数量的上限，用于二分搜索。"""
    max_possible = 9999
    for ing_id, qty_per in recipe.items():
        if qty_per <= 0:
            continue
        # 当前库存 + 递归能合成的原料（粗略估算）
        available = inventory.get(ing_id, 0)
        ing_item = items.get(ing_id, {})
        if ing_item.get("recipe"):
            available += _estimate_recursive(ing_id, inventory, items, depth + 1) * qty_per
        max_possible = min(max_possible, available // qty_per)
    return min(max_possible, 9999)


def _estimate_recursive(item_id: str, inventory: dict, items: dict, depth: int) -> int:
    """粗略估算（不消耗库存），用于上限估计。"""
    if depth > 20:
        return 0
    item = items.get(item_id, {})
    recipe = item.get("recipe", {})
    if not recipe:
        return inventory.get(item_id, 0)
    min_craft = 9999
    for ing_id, qty_per in recipe.items():
        if qty_per <= 0:
            continue
        avail = inventory.get(ing_id, 0)
        ing = items.get(ing_id, {})
        if ing.get("recipe"):
            avail += _estimate_recursive(ing_id, inventory, items, depth + 1)
        min_craft = min(min_craft, avail // qty_per)
    return min_craft


def _can_craft_n(item_id: str, n: int, inventory: dict, items: dict, depth: int) -> bool:
    """
    判断能否合成 n 个 item_id（会消耗 inventory 中的原料）。
    递归处理多级合成：先用库存中已有的原料，不足部分尝试合成。
    """
    if n <= 0:
        return True
    if depth > 20:
        return False

    item = items.get(item_id, {})
    recipe = item.get("recipe", {})
    if not recipe:
        return False

    for ing_id, qty_per in recipe.items():
        needed = qty_per * n
        have = inventory.get(ing_id, 0)

        if have >= needed:
            inventory[ing_id] = have - needed
        else:
            # 库存不够，尝试合成差额
            deficit = needed - have
            inventory[ing_id] = 0

            ing_item = items.get(ing_id, {})
            if not ing_item.get("recipe"):
                return False  # 无法合成的原材料，不够就是不够

            # 需要合成 deficit 个 ing_id
            if not _can_craft_n(ing_id, deficit, inventory, items, depth + 1):
                return False

    return True
