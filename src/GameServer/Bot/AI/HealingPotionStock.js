const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const ConsumableRestock = invoke('GameServer/Inventory/ConsumableRestock');
const DataCache = invoke('GameServer/DataCache');
const PurchaseFunding = invoke('GameServer/Bot/Economy/PurchaseFunding');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const C4ItemSkills = invoke('GameServer/Items/C4ItemSkills');
const EffectStore = invoke('GameServer/Effects/EffectStore');

const POTIONS = Object.freeze([
    Object.freeze({ selfId: 1060, name: 'Lesser Healing Potion', heal: 112, hot: true, effect: 'lesser_healing_potion' }),
    Object.freeze({ selfId: 727, name: 'Healing Potion', heal: 336, hot: true, effect: 'healing_potion' }),
    Object.freeze({ selfId: 1061, name: 'Healing Potion', heal: 336, hot: true, effect: 'healing_potion' }),
    Object.freeze({ selfId: 1539, name: 'Greater Healing Potion', heal: 700, hot: true, effect: 'greater_healing_potion' }),
    Object.freeze({ selfId: 1540, name: 'Quick Healing Potion', heal: 435, hot: false, effect: null })
]);
const POTION_IDS = Object.freeze(POTIONS.map((potion) => potion.selfId));
const HOT_EFFECT_KEYS = Object.freeze(POTIONS.filter((potion) => potion.hot).map((potion) => potion.effect));
const PURCHASE_BY_LEVEL = Object.freeze([
    Object.freeze({ maxLevel: 19, selfId: 1060 }),
    Object.freeze({ maxLevel: Infinity, selfId: 1061 })
]);
const MELEE_USE_HP_RATIO = 0.35;
const RANGED_USE_HP_RATIO = 0.25;
const QUICK_USE_HP_RATIO = 0.12;
const DESIRED_HP_RATIO = 0.65;
const MAX_USES_PER_ENCOUNTER = 1;

function templateFor(selfId) {
    return ItemTemplateIndex.find(DataCache.items, selfId) || null;
}

function detailsFor(selfId) {
    return POTIONS.find((potion) => potion.selfId === Number(selfId)) || null;
}

function roleFor(value) {
    return typeof value === 'string' ? value : BotRoles.inferRole(value);
}

function useThreshold(value) {
    const role = roleFor(value);
    return BotRoles.isRanged(role) || role === 'healer' || BotRoles.shouldRestForMana(value)
        ? RANGED_USE_HP_RATIO
        : MELEE_USE_HP_RATIO;
}

function targetAmountFor(value) {
    const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
    const state = value?.backpack ? Economy.stateForActor(value) : value;
    return Economy.forState(state).stock('potions').target;
}

function purchasePotionFor(value) {
    const level = Number(value?.fetchLevel?.() ?? value?.level ?? 1) || 1;
    const choice = PURCHASE_BY_LEVEL.find((entry) => level <= entry.maxLevel) || PURCHASE_BY_LEVEL[0];
    const template = templateFor(choice.selfId);
    return {
        ...detailsFor(choice.selfId),
        price: Math.max(0, Number(template?.template?.price || 0))
    };
}

// The shared operating reserve, read from a cold state or a hot actor.
function operationalReserve(value) {
    const adena = Math.max(0, Number(value?.adena ?? value?.backpack?.fetchItemFromSelfId?.(57)?.fetchAmount?.() ?? 0));
    const level = Math.max(1, Number(value?.fetchLevel?.() ?? value?.level ?? 1) || 1);
    return PurchaseFunding.operatingReserve({ adena, level });
}

function inventoryRows(inventory = {}) {
    return Array.isArray(inventory) ? inventory : Object.values(inventory || {});
}

function amountInInventory(inventory, selfId) {
    const row = inventoryRows(inventory).find((item) => Number(item?.selfId) === Number(selfId));
    return Math.max(0, Number(row?.amount || 0));
}

function actorAmount(actor, selfId) {
    return Math.max(0, Number(actor?.backpack?.fetchItemFromSelfId?.(selfId)?.fetchAmount?.() || 0));
}

let potionsStrongestFirst = null;
const EMERGENCY_POTIONS = POTIONS.filter((potion) => !potion.hot);

// How many of a potion the bot holds: from its inventory (keyed or rows) or its actor.
function heldAmount(value, inventory, selfId) {
    if (!inventory) return actorAmount(value, selfId);
    return Array.isArray(inventory) ? amountInInventory(inventory, selfId)
        : Math.max(0, Number(inventory[String(selfId)]?.amount || 0));
}

// The healing potions a bot keeps, by selfId: potions at least as strong as
// the one it buys at its level (stronger ones from loot count too), strongest
// first, up to its restock target; a weaker potion is junk, as for a player who
// moved on to better potions. One definition for the sale (it keeps these) and
// the restock (it buys only what is missing).
function stockAmounts(value, options = {}) {
    // Only the potions a bot drinks in an ordinary fight (Quick Healing is kept for near death).
    potionsStrongestFirst ||= POTIONS.filter((potion) => potion.hot).sort((a, b) => b.heal - a.heal);
    const inventory = options.inventory || value?.inventory;
    const minimumHeal = Number(detailsFor(purchasePotionFor(value).selfId)?.heal || 0);
    let left = Math.max(0, Number(options.targetAmount ?? targetAmountFor(value)) || 0);
    const kept = {};
    for (const potion of potionsStrongestFirst) {
        if (potion.heal < minimumHeal) break;
        if (left <= 0) break;
        const amount = Math.min(left, heldAmount(value, inventory, potion.selfId));
        if (amount > 0) kept[potion.selfId] = amount;
        left -= amount;
    }
    return kept;
}

// What a bot keeps of its healing potions: the stock above, plus every potion
// it drinks only when nearly dead (Quick Healing, selectPotion): the sale reserve.
function keptAmounts(value, options = {}) {
    const kept = stockAmounts(value, options);
    const inventory = options.inventory || value?.inventory;
    for (const potion of EMERGENCY_POTIONS) {
        const held = heldAmount(value, inventory, potion.selfId);
        if (held > 0) kept[potion.selfId] = held;
    }
    return kept;
}

// The price of the bot's potion at the cheapest NPC of a town; 0 = not sold there.
// One lookup for the hot trip (ShoppingState) and the cold visit (PopulationService).
function localNpcPrice(potion, town) {
    if (!town) return 0;
    let price = 0;
    for (const offer of invoke('GameServer/Bot/Economy/MarketOpportunity').npcOffers(potion.selfId, town)) {
        const offerPrice = Number(offer.price || 0);
        if (offer.available === false || offerPrice <= 0) continue;
        if (price === 0 || offerPrice < price) price = offerPrice;
    }
    return price;
}

function restockPlan(value, options = {}) {
    const potion = options.potion || purchasePotionFor(value);
    const targetAmount = Math.max(0, Number(options.targetAmount ?? targetAmountFor(value)) || 0);
    // The purchased potion's own row (written by the purchase) and the whole stock (what is missing).
    const currentAmount = options.inventory
        ? amountInInventory(options.inventory, potion.selfId)
        : value?.inventory ? amountInInventory(value.inventory, potion.selfId) : actorAmount(value, potion.selfId);
    const stockAmount = Object.values(stockAmounts(value, { inventory: options.inventory, targetAmount }))
        .reduce((sum, amount) => sum + amount, 0);
    const adena = Math.max(0, Number(options.adena ?? value?.adena
        ?? value?.backpack?.fetchItemFromSelfId?.(57)?.fetchAmount?.() ?? 0));
    const unitPrice = Math.max(0, Number(options.unitPrice ?? potion.price) || 0);
    const reserve = Math.max(0, Number(options.reserve ?? operationalReserve(value)) || 0);
    const desired = Math.max(0, targetAmount - stockAmount);
    const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
    const state = value?.backpack ? Economy.stateForActor(value) : value;
    const allowance = options.targetAmount !== undefined ? Math.max(0, adena - reserve)
        : Economy.forState(state).purchaseBudget(potion.selfId);
    const affordable = unitPrice > 0 ? Math.floor(Math.min(allowance, Math.max(0, adena - reserve)) / unitPrice) : 0;
    const amount = Math.min(desired, affordable);
    return {
        potion,
        targetAmount,
        currentAmount,
        stockAmount,
        amount,
        unitPrice,
        cost: amount * unitPrice,
        adena,
        reserve,
        needed: desired > 0,
        affordable: amount > 0
    };
}

// The plan's purchase as a restock line (Inventory/ConsumableRestock).
function purchaseLine(plan) {
    return { selfId: plan.potion.selfId, name: plan.potion.name, currentAmount: plan.currentAmount,
        amount: plan.amount, unitPrice: plan.unitPrice, cost: plan.cost, adena: plan.adena };
}

function purchaseActorRestock(actor, options = {}) {
    if (!actor?.backpack || typeof actor.fetchId !== 'function') {
        return Promise.resolve({ ok: false, reason: 'missing_actor' });
    }
    const plan = restockPlan(actor, options);
    if (!plan.needed) return Promise.resolve({ ok: true, changed: false, ...plan });
    if (!plan.affordable) return Promise.resolve({ ok: false, reason: 'wallet_reserve', ...plan });
    return ConsumableRestock.buyForActor(actor, purchaseLine(plan)).then((bought) => (bought.ok
        ? { ok: true, changed: true, ...plan, nextAdena: bought.nextAdena, nextAmount: bought.nextAmount }
        : { ok: false, reason: bought.reason, ...plan }));
}

function activePotionHot(actor) {
    return EffectStore.list(actor).some((effect) => HOT_EFFECT_KEYS.includes(effect.key));
}

function targetAlive(target) {
    if (!target) return false;
    if (typeof target.isDead === 'function' && target.isDead()) return false;
    if (target.state?.fetchDead?.()) return false;
    return Number(target.fetchHp?.() ?? target.hp ?? 1) > 0;
}

function availablePotions(inventory, hpRatio, options = {}) {
    return POTIONS.filter((potion) => amountInInventory(inventory, potion.selfId) > 0)
        .filter((potion) => potion.selfId !== 1540 || hpRatio <= (options.pvp ? 0.25 : QUICK_USE_HP_RATIO))
        .filter(potion => !options.activeHot || !potion.hot);
}

function selectPotion(inventory, hp, maxHp, roleOrActor, options = {}) {
    const safeMaxHp = Math.max(1, Number(maxHp || hp || 1));
    const safeHp = Math.max(0, Number(hp || 0));
    const hpRatio = safeHp / safeMaxHp;
    if (hpRatio > (options.pvp ? 0.65 : useThreshold(roleOrActor))) return null;
    const available = availablePotions(inventory, hpRatio, options);
    if (!available.length) return null;

    if (hpRatio <= (options.pvp ? 0.25 : QUICK_USE_HP_RATIO)) {
        const quick = available.find((potion) => potion.selfId === 1540);
        if (quick) return quick;
    }

    const required = Math.max(1, safeMaxHp * DESIRED_HP_RATIO - safeHp);
    const gradual = available.filter((potion) => potion.hot).sort((left, right) => left.heal - right.heal);
    return gradual.find((potion) => potion.heal >= required)
        || gradual[gradual.length - 1]
        || available.sort((left, right) => right.heal - left.heal)[0]
        || null;
}

function actorInventory(actor) {
    return (actor?.backpack?.fetchItems?.() || []).map((item) => ({
        selfId: Number(item.fetchSelfId?.() || 0),
        amount: Number(item.fetchAmount?.() || 0),
        objectId: Number(item.fetchId?.() || 0),
        source: item
    }));
}

function tryUseInCombat(session, actor, target, options = {}) {
    if (!session || !actor || !targetAlive(target) || actor.state?.fetchDead?.()) return null;
    const activeHot = activePotionHot(actor);
    if (actor.state?.fetchCasts?.() || (activeHot && !options.pvp)) return null;

    const targetId = Number(target.fetchId?.() ?? target.id ?? 0);
    const encounter = session.healingPotionEncounter?.targetId === targetId
        ? session.healingPotionEncounter
        : { targetId, used: 0 };
    session.healingPotionEncounter = encounter;
    if (encounter.used >= Number(options.pvp ? Infinity : options.maxUses ?? MAX_USES_PER_ENCOUNTER)) return null;

    const inventory = actorInventory(actor);
    const potion = selectPotion(inventory, actor.fetchHp?.(), actor.fetchMaxHp?.(), actor, { ...options, activeHot });
    if (!potion) return null;
    const item = inventory.find((entry) => entry.selfId === potion.selfId && entry.amount > 0);
    if (!item?.objectId) return null;

    const itemSkill = C4ItemSkills.resolve(potion.selfId);
    const skill = itemSkill && actor.backpack.buildItemSkill?.(itemSkill);
    if (!skill || actor.canUseSkill?.(skill) === false) return null;

    actor.backpack.useItem(session, item.objectId);
    encounter.used += 1;
    session.lastCombatDecision = {
        action: 'use_healing_potion',
        reason: 'low_hp_active_combat',
        role: roleFor(options.role || actor),
        itemId: potion.selfId,
        itemName: potion.name,
        hp: Number(actor.fetchHp?.() || 0),
        maxHp: Number(actor.fetchMaxHp?.() || 0),
        targetId: targetId || null,
        at: Date.now()
    };
    return potion;
}

function consumeColdPotion(inventory, hp, maxHp, roleOrActor) {
    const potion = selectPotion(inventory, hp, maxHp, roleOrActor);
    if (!potion) return null;
    const key = Object.keys(inventory || {}).find((entryKey) => (
        Number(inventory[entryKey]?.selfId ?? entryKey) === potion.selfId
        && Number(inventory[entryKey]?.amount || 0) > 0
    ));
    if (key === undefined) return null;
    inventory[key] = { ...inventory[key], amount: Math.max(0, Number(inventory[key].amount || 0) - 1) };
    return potion;
}

function coldEffectFor(potion, usedAt = 0) {
    if (!potion) return null;
    if (!potion.hot) {
        return { immediateHeal: potion.heal, hot: null };
    }
    return {
        immediateHeal: 0,
        hot: {
            heal: potion.heal / 7,
            remaining: 7,
            intervalMs: 2000,
            nextAt: Number(usedAt || 0) + 2000
        }
    };
}

function coldPurchasePatch(state, options = {}) {
    const plan = restockPlan(state, { ...options, inventory: state?.inventory || {} });
    if (!plan.affordable) return null;
    return ConsumableRestock.coldPatch(state, purchaseLine(plan));
}

module.exports = {
    DESIRED_HP_RATIO,
    HOT_EFFECT_KEYS,
    MAX_USES_PER_ENCOUNTER,
    MELEE_USE_HP_RATIO,
    POTIONS,
    POTION_IDS,
    QUICK_USE_HP_RATIO,
    RANGED_USE_HP_RATIO,
    activePotionHot,
    amountInInventory,
    coldEffectFor,
    coldPurchasePatch,
    consumeColdPotion,
    operationalReserve,
    purchaseActorRestock,
    purchasePotionFor,
    restockPlan,
    stockAmounts,
    keptAmounts,
    localNpcPrice,
    selectPotion,
    targetAmountFor,
    tryUseInCombat,
    useThreshold
};
