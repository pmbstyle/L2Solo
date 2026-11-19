const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const Database = invoke('Database');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const DataCache = invoke('GameServer/DataCache');
const EnchantRules = invoke('GameServer/Items/C4EnchantRules');
const GearGrade = invoke('GameServer/Bot/AI/GearGradeRule');

const MAX_OPERATIONS = 64;

function templateFor(selfId) {
    return ItemTemplateIndex.findLast(DataCache.items, selfId, templateFor) || null;
}

function itemKind(item, template = templateFor(item?.selfId)) {
    return String(item?.kind || template?.template?.kind || '');
}

function itemRank(item, template = templateFor(item?.selfId)) {
    return String(item?.rank || template?.etc?.rank || 'none');
}

// What a cold bot enchants up to the safe level: its worn D weapon and armour,
// and its worn C, B or A weapon (the economy's enchant sink, our cheat: the hunt
// reads no enchant; the scroll is bought at a town visit, scrollPurchase).
const BOUGHT_WEAPON_GRADES = new Set(['C', 'B', 'A']);
function enchantable(rank, kind) {
    return rank === 'D' ? kind.startsWith('Weapon.') || kind.startsWith('Armor.')
        : BOUGHT_WEAPON_GRADES.has(rank) && kind.startsWith('Weapon.');
}
function scrollEnchants(scroll) {
    return scroll?.grade === 'D' ? ['weapon', 'armor'].includes(scroll.target)
        : BOUGHT_WEAPON_GRADES.has(scroll?.grade) && scroll.target === 'weapon';
}

function hasPotential(state = {}) {
    const items = Object.values(state.inventory || {});
    const grades = new Set(items.filter((item) => Number(item?.amount || 0) > 0)
        .map((item) => EnchantRules.resolveScroll(item?.selfId))
        .filter(scrollEnchants).map((scroll) => scroll.grade));
    if (!grades.size) return false;
    return items.some((item) => {
        const rank = itemRank(item).toUpperCase();
        return item?.equipped && grades.has(rank) && enchantable(rank, itemKind(item));
    });
}

// The scrolls the worn gear takes to its safe level, by `${grade}:${target}`.
// A C, B or A weapon counts only at its level's kit grade (an S level wears A:
// no store sells an S weapon).
function targetNeeds(state = {}, options = {}) {
    const config = EnchantRules.configWith({
        ...(globalThis.options?.default?.Enchant || {}),
        ...(options.config || {})
    });
    const kitGrade = ({ s: 'A' })[GearGrade.gradeForLevel(state.level)] || GearGrade.gradeForLevel(state.level).toUpperCase();
    return Object.values(state.inventory || {}).reduce((needs, item) => {
        const kind = itemKind(item), rank = itemRank(item).toUpperCase();
        if (!item?.equipped || !enchantable(rank, kind) || (rank !== 'D' && rank !== kitGrade)) return needs;
        const target = kind.startsWith('Weapon.') ? 'weapon' : 'armor';
        const key = `${rank}:${target}`;
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
            needs[key] = Number(needs[key] || 0) + Math.max(0, cap - Math.max(0, Number(instance.enchant || 0)));
        });
        return needs;
    }, {});
}

// The held scrolls by `${grade}:${target}` (targetNeeds' keys).
function inventoryScrolls(state = {}) {
    return Object.values(state.inventory || {}).reduce((amounts, item) => {
        const scroll = EnchantRules.resolveScroll(item?.selfId);
        if (scrollEnchants(scroll)) {
            const key = `${scroll.grade}:${scroll.target}`;
            amounts[key] = Number(amounts[key] || 0) + Math.max(0, Number(item.amount || 0));
        }
        return amounts;
    }, {});
}

// The weapon scrolls a cold bot buys at a town visit, or null: the normal Scroll:
// Enchant Weapon of its worn C, B or A weapon's grade, for the tries to the safe
// level its held scrolls do not cover, paid from at most `money`: what keeps its
// money after the scrolls above ENCHANT_WALLET_WEAPONS times the weapon's price.
// weaponPrice(selfId): the weapon's cheapest fixed price (0: not sold, no
// purchase). No store sells the scroll (C4: drop, spoil and raid bosses only):
// the purchase reads the board's asks. Our rule (the model's weaponEnchant).
const ENCHANT_WALLET_WEAPONS = 3;
const NORMAL_WEAPON_SCROLL = Object.freeze({ C: 951, B: 947, A: 729 });
function scrollPurchase(state = {}, weaponPrice = () => 0) {
    const needs = targetNeeds(state), held = inventoryScrolls(state);
    for (const grade of BOUGHT_WEAPON_GRADES) {
        const missing = Math.max(0, Number(needs[`${grade}:weapon`] || 0) - Number(held[`${grade}:weapon`] || 0));
        if (!missing) continue;
        const weapon = Object.values(state.inventory || {}).find((item) => item?.equipped
            && itemRank(item).toUpperCase() === grade && itemKind(item).startsWith('Weapon.'));
        const floor = ENCHANT_WALLET_WEAPONS * Number(weaponPrice(Number(weapon?.selfId)) || 0);
        const money = Math.floor(Number(state.adena || 0) - floor - 1);
        return floor > 0 && money > 0 ? { selfId: NORMAL_WEAPON_SCROLL[grade], amount: missing, money,
            weaponSelfId: Number(weapon.selfId) } : null;
    }
    return null;
}

function warehouseRequests(state = {}, warehouseItems = [], options = {}) {
    if (state.phase === 'cold') {
        const Decision = require('../Population/ColdEconomyDecision');
        const economy = Decision.economyFor(state);
        const materials = economy.materials || Decision.capture(economy, state).materials;
        return materials.flatMap(([selfId, missing]) => {
            const row = warehouseItems.find(item => Number(item.selfId) === selfId);
            const amount = Math.min(missing, Math.max(0, Number(row?.amount || 0)));
            // ARCH-NOTE: the captured worker materials use the existing town
            // withdrawal reasons; enchant also triggers the physical safe batch.
            const reason = EnchantRules.resolveScroll(selfId) ? 'enchant' : 'craft';
            return amount > 0 ? [{ selfId, amount, reason }] : [];
        });
    }
    const needs = targetNeeds(state, options);
    const inventory = inventoryScrolls(state);
    const missing = Object.fromEntries(Object.entries(needs)
        .map(([key, need]) => [key, Math.max(0, need - Number(inventory[key] || 0))]));
    const priority = { normal: 0, crystal: 1, blessed: 2 };
    return (warehouseItems || []).map((item) => ({
        ...item,
        rule: EnchantRules.resolveScroll(item.selfId)
    })).filter((item) => scrollEnchants(item.rule) && missing[`${item.rule.grade}:${item.rule.target}`] > 0
        && Number(item.amount || 0) > 0)
        .sort((left, right) => (
            Number(priority[left.rule.scrollType] ?? 9) - Number(priority[right.rule.scrollType] ?? 9)
            || Number(left.selfId) - Number(right.selfId)
        )).flatMap((item) => {
            const key = `${item.rule.grade}:${item.rule.target}`;
            const amount = Math.min(missing[key], Math.max(0, Number(item.amount || 0)));
            missing[key] -= amount;
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
    })).filter((row) => scrollEnchants(row.rule) && row.amount > 0);
    const targets = rows.filter((row) => Number(row.equipped) === 1 && Number(row.amount) === 1)
        .map((row) => ({ row: { ...row }, item: adapterFor(row) }))
        .filter(({ item }) => enchantable(item.rank.toUpperCase(), item.kind));
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

// ARCH-NOTE: restores the authored guaranteed D-grade safe batch;
// the delivered adapter discarded its operations and enchanted only one item.
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

// The weapon scrolls a bot the reserve sells them to (the spoiler line,
// MerchantStoreConfigs enchantReserve) stocks for the board at a town visit, as
// [{ selfId, amount, money }]: up to RESTOCK_HELD of each normal weapon scroll of a
// grade its level wears or has passed (C 40, B 52, A 61) that it holds fewer of,
// sold here (sold(selfId): the reserve admits it in this town) at price(selfId)
// (0: none), as many as leave its money after the purchase at least
// RESTOCK_WALLET_COSTS times the purchase's cost; money: that cost. Stock for
// resale: the floor follows its own cost, not the worn weapon. Its sale listing
// puts them on the board as a dropper's (ItemDisposition.saleCandidates). Our rule.
const RESTOCK_HELD = 3;
const RESTOCK_WALLET_COSTS = 2;
function scrollRestock(state = {}, sold = () => false, price = () => 0) {
    const adena = Math.max(0, Number(state.adena || 0));
    return Object.entries(NORMAL_WEAPON_SCROLL).flatMap(([grade, selfId]) => {
        const unit = Number(price(selfId) || 0);
        if (!(unit > 0) || Number(state.level || 0) < GearGrade.levelForGrade(grade.toLowerCase()) || !sold(selfId)) return [];
        const missing = RESTOCK_HELD - Math.max(0, Number(state.inventory?.[selfId]?.amount || 0));
        const amount = Math.min(missing, Math.floor(adena / ((1 + RESTOCK_WALLET_COSTS) * unit)));
        return amount > 0 ? [{ selfId, amount, money: amount * unit }] : [];
    });
}

async function enchantSafe(state, options = {}) {
    if (!state || state.phase === 'hot' || !state.characterId || !hasPotential(state)) {
        return { state, enchanted: false, operations: [] };
    }
    const rows = await Database.fetchItems(state.characterId, 'cold_safe_enchant');
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
    ENCHANT_WALLET_WEAPONS,
    enchantSafe,
    hasPotential,
    inventoryScrolls,
    plan,
    scrollPurchase,
    scrollRestock,
    summary,
    targetNeeds,
    warehouseRequests
};
