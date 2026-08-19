const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const EnchantRules = invoke('GameServer/Items/C4EnchantRules');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');

const MAX_OPERATIONS = 64;
let templateSource = null;
let templateIndex = new Map();

function templateFor(selfId) {
    const items = DataCache.items || [];
    if (items !== templateSource) {
        templateSource = items;
        templateIndex = new Map(items.map((item) => [Number(item.selfId), item]));
    }
    return templateIndex.get(Number(selfId)) || null;
}

function itemKind(item, template = templateFor(item?.selfId)) {
    return String(item?.kind || template?.template?.kind || '');
}

function itemRank(item, template = templateFor(item?.selfId)) {
    return String(item?.rank || template?.etc?.rank || 'none');
}

function hasPotential(state = {}) {
    const items = Object.values(state.inventory || {});
    const hasScroll = items.some((item) => {
        const scroll = EnchantRules.resolveScroll(item?.selfId);
        return scroll?.grade === 'D' && Number(item?.amount || 0) > 0;
    });
    if (!hasScroll) return false;
    return items.some((item) => item?.equipped
        && itemRank(item).toUpperCase() === 'D'
        && (itemKind(item).startsWith('Weapon.') || itemKind(item).startsWith('Armor.')));
}

function targetNeeds(state = {}, options = {}) {
    const config = EnchantRules.configWith({
        ...(globalThis.options?.default?.Enchant || {}),
        ...(options.config || {})
    });
    return Object.values(state.inventory || {}).reduce((needs, item) => {
        const kind = itemKind(item);
        if (!item?.equipped || itemRank(item).toUpperCase() !== 'D'
            || (!kind.startsWith('Weapon.') && !kind.startsWith('Armor.'))) return needs;
        const target = kind.startsWith('Weapon.') ? 'weapon' : 'armor';
        const equippedSlots = Array.isArray(item.equippedSlots) && item.equippedSlots.length
            ? item.equippedSlots
            : [item.slot];
        const instances = Array.isArray(item.instances)
            ? item.instances.filter((instance) => instance?.equipped)
            : equippedSlots.slice(0, Math.max(1, Number(item.equippedCount || 1))).map((slot) => ({
                enchant: Number(item.enchant || 0),
                slot: Number(slot || item.slot || 0)
            }));
        instances.forEach((instance) => {
            const category = kind.toLowerCase().includes('jewel') ? 'accessory' : target;
            const cap = category === 'armor' && Number(instance.slot || item.slot || 0) === 15
                ? Number(config.safeMaxFull || 4)
                : Number(config.safeMax || 3);
            needs[target] += Math.max(0, cap - Math.max(0, Number(instance.enchant || 0)));
        });
        return needs;
    }, { weapon: 0, armor: 0 });
}

function inventoryScrolls(state = {}) {
    return Object.values(state.inventory || {}).reduce((amounts, item) => {
        const scroll = EnchantRules.resolveScroll(item?.selfId);
        if (scroll?.grade === 'D' && ['weapon', 'armor'].includes(scroll.target)) {
            amounts[scroll.target] += Math.max(0, Number(item.amount || 0));
        }
        return amounts;
    }, { weapon: 0, armor: 0 });
}

function warehouseRequests(state = {}, warehouseItems = [], options = {}) {
    const needs = targetNeeds(state, options);
    const inventory = inventoryScrolls(state);
    const missing = {
        weapon: Math.max(0, needs.weapon - inventory.weapon),
        armor: Math.max(0, needs.armor - inventory.armor)
    };
    const priority = { normal: 0, crystal: 1, blessed: 2 };
    return (warehouseItems || []).map((item) => ({
        ...item,
        rule: EnchantRules.resolveScroll(item.selfId)
    })).filter((item) => item.rule?.grade === 'D' && missing[item.rule.target] > 0 && Number(item.amount || 0) > 0)
        .sort((left, right) => (
            Number(priority[left.rule.scrollType] ?? 9) - Number(priority[right.rule.scrollType] ?? 9)
            || Number(left.selfId) - Number(right.selfId)
        )).flatMap((item) => {
            const amount = Math.min(missing[item.rule.target], Math.max(0, Number(item.amount || 0)));
            missing[item.rule.target] -= amount;
            return amount > 0 ? [{ selfId: Number(item.selfId), amount, reason: 'enchant' }] : [];
        });
}

function adapterFor(row) {
    const template = templateFor(row.selfId);
    const kind = itemKind(row, template);
    const rank = itemRank(row, template);
    return {
        selfId: Number(row.selfId),
        amount: Number(row.amount),
        enchant: Math.max(0, Number(row.enchant || 0)),
        equipped: !!row.equipped,
        slot: Number(row.slot || 0),
        kind,
        rank,
        basePrice: Number(template?.template?.price || 0),
        isWeapon: () => kind.startsWith('Weapon.'),
        isArmor: () => kind.startsWith('Armor.'),
        fetchSelfId: () => Number(row.selfId),
        fetchAmount: () => Number(row.amount),
        fetchEnchantLevel: () => Math.max(0, Number(row.enchant || 0)),
        fetchKind: () => kind,
        fetchRank: () => rank,
        fetchSlot: () => Number(row.slot || 0)
    };
}

function targetPriority(target) {
    const category = EnchantRules.categoryOf(target);
    if (category === 'weapon') return 0;
    if (category === 'armor') return 1;
    return 2;
}

function plan(rows = [], options = {}) {
    const limit = Math.max(1, Math.min(MAX_OPERATIONS, Number(options.maxOperations) || MAX_OPERATIONS));
    const config = EnchantRules.configWith({
        ...(globalThis.options?.default?.Enchant || {}),
        ...(options.config || {})
    });
    const scrolls = rows.map((row) => ({
        ...row,
        amount: Math.max(0, Number(row.amount || 0)),
        rule: EnchantRules.resolveScroll(row.selfId)
    })).filter((row) => row.rule?.grade === 'D' && row.amount > 0);
    const targets = rows.filter((row) => Number(row.equipped) === 1 && Number(row.amount) === 1)
        .map((row) => ({ row: { ...row }, item: adapterFor(row) }))
        .filter(({ item }) => item.rank.toUpperCase() === 'D' && (item.isWeapon() || item.isArmor()));
    const operations = [];

    while (operations.length < limit) {
        const candidates = [];
        for (const scroll of scrolls) {
            if (scroll.amount <= 0) continue;
            for (const target of targets) {
                target.item.enchant = Math.max(0, Number(target.row.enchant || 0));
                if (!EnchantRules.validTarget(target.item, scroll.rule)
                    || !EnchantRules.isSafe(target.item, target.row.enchant, config)) continue;
                candidates.push({ scroll, target });
            }
        }
        candidates.sort((left, right) => (
            Number(left.target.row.enchant || 0) - Number(right.target.row.enchant || 0)
            || targetPriority(left.target.item) - targetPriority(right.target.item)
            || Number(right.target.item.basePrice || 0) - Number(left.target.item.basePrice || 0)
            || Number(left.target.row.id) - Number(right.target.row.id)
            || Number(left.scroll.id) - Number(right.scroll.id)
        ));
        const selected = candidates[0];
        if (!selected) break;
        const expectedEnchant = Math.max(0, Number(selected.target.row.enchant || 0));
        operations.push({
            scrollId: Number(selected.scroll.id),
            scrollSelfId: Number(selected.scroll.selfId),
            targetId: Number(selected.target.row.id),
            targetSelfId: Number(selected.target.row.selfId),
            expectedEnchant,
            enchantLevel: expectedEnchant + 1
        });
        selected.scroll.amount -= 1;
        selected.target.row.enchant = expectedEnchant + 1;
    }
    return operations;
}

function summary(operations = []) {
    return [...operations.reduce((items, operation) => {
        const key = Number(operation.targetId);
        const previous = items.get(key);
        items.set(key, previous ? {
            ...previous,
            to: Number(operation.enchantLevel),
            scrolls: previous.scrolls + 1
        } : {
            selfId: Number(operation.targetSelfId),
            from: Number(operation.expectedEnchant),
            to: Number(operation.enchantLevel),
            scrolls: 1
        });
        return items;
    }, new Map()).values()];
}

function consumedInventory(state = {}, operations = []) {
    const consumed = operations.reduce((amounts, operation) => {
        const selfId = Number(operation.scrollSelfId || 0);
        if (selfId > 0) amounts.set(selfId, Number(amounts.get(selfId) || 0) + 1);
        return amounts;
    }, new Map());
    const inventory = { ...(state.inventory || {}) };
    consumed.forEach((amount, selfId) => {
        const key = String(selfId);
        const item = inventory[key];
        if (!item) return;
        const remaining = Math.max(0, Number(item.amount || 0) - amount);
        if (remaining <= 0) delete inventory[key];
        else inventory[key] = { ...item, amount: remaining };
    });
    return inventory;
}

async function enchantSafe(state, options = {}) {
    if (!state || state.phase === 'hot' || !state.characterId || !hasPotential(state)) {
        return { state, enchanted: false, operations: [] };
    }
    const rows = await Database.fetchItems(state.characterId);
    const operations = plan(rows, options);
    if (!operations.length) return { state, enchanted: false, operations: [] };

    const persisted = await Database.enchantColdInventoryItems(state.characterId, operations);
    const refreshed = await LifeState.refreshInventory({
        ...state,
        inventory: consumedInventory(state, persisted.operations)
    });
    const timestamp = Number(options.now) || Date.now();
    const nextState = {
        ...refreshed,
        stats: {
            ...(refreshed.stats || {}),
            lastSafeEnchant: {
                at: timestamp,
                operations: persisted.operations.length,
                items: summary(persisted.operations)
            }
        },
        updatedAt: timestamp
    };
    const saved = await LifeState.upsertState(nextState, 'cold_safe_enchant');
    return {
        state: saved || nextState,
        enchanted: true,
        operations: persisted.operations,
        items: nextState.stats.lastSafeEnchant.items
    };
}

module.exports = {
    MAX_OPERATIONS,
    enchantSafe,
    hasPotential,
    inventoryScrolls,
    plan,
    summary,
    targetNeeds,
    warehouseRequests
};
