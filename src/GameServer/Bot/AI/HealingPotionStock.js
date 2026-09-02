const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
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
    return (DataCache.items || []).find((item) => Number(item.selfId) === Number(selfId)) || null;
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
    const role = roleFor(value);
    if (role === 'tank') return 12;
    if (BotRoles.isRanged(role) || role === 'healer' || BotRoles.shouldRestForMana(value)) return 4;
    return 8;
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

function operationalReserve(value) {
    const adena = Math.max(0, Number(value?.adena ?? value?.backpack?.fetchItemFromSelfId?.(57)?.fetchAmount?.() ?? 0));
    const level = Math.max(1, Number(value?.fetchLevel?.() ?? value?.level ?? 1) || 1);
    return Math.max(500, level * 250, Math.ceil(adena * 0.10));
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

function restockPlan(value, options = {}) {
    const potion = options.potion || purchasePotionFor(value);
    const targetAmount = Math.max(0, Number(options.targetAmount ?? targetAmountFor(value)) || 0);
    const currentAmount = options.inventory
        ? amountInInventory(options.inventory, potion.selfId)
        : value?.inventory ? amountInInventory(value.inventory, potion.selfId) : actorAmount(value, potion.selfId);
    const adena = Math.max(0, Number(options.adena ?? value?.adena
        ?? value?.backpack?.fetchItemFromSelfId?.(57)?.fetchAmount?.() ?? 0));
    const unitPrice = Math.max(0, Number(options.unitPrice ?? potion.price) || 0);
    const reserve = Math.max(0, Number(options.reserve ?? operationalReserve(value)) || 0);
    const desired = Math.max(0, targetAmount - currentAmount);
    const affordable = unitPrice > 0 ? Math.floor(Math.max(0, adena - reserve) / unitPrice) : 0;
    const amount = Math.min(desired, affordable);
    return {
        potion,
        targetAmount,
        currentAmount,
        amount,
        unitPrice,
        cost: amount * unitPrice,
        adena,
        reserve,
        needed: desired > 0,
        affordable: amount > 0
    };
}

function ensureActorStock(actor, plan) {
    const current = actor.backpack.fetchItemFromSelfId(plan.potion.selfId);
    const nextAmount = plan.currentAmount + plan.amount;
    if (current) {
        return Database.updateItemAmount(actor.fetchId(), current.fetchId(), nextAmount).then(() => {
            current.setAmount(nextAmount);
            return nextAmount;
        });
    }
    return Database.setItem(actor.fetchId(), {
        selfId: plan.potion.selfId,
        name: plan.potion.name,
        amount: nextAmount,
        equipped: false,
        slot: 0
    }).then((packet) => {
        actor.backpack.insertItem(Number(packet.insertId), plan.potion.selfId, { amount: nextAmount });
        return nextAmount;
    });
}

function purchaseActorRestock(actor, options = {}) {
    if (!actor?.backpack || typeof actor.fetchId !== 'function') {
        return Promise.resolve({ ok: false, reason: 'missing_actor' });
    }
    const plan = restockPlan(actor, options);
    if (!plan.needed) return Promise.resolve({ ok: true, changed: false, ...plan });
    if (!plan.affordable) return Promise.resolve({ ok: false, reason: 'wallet_reserve', ...plan });

    const adenaItem = actor.backpack.fetchItemFromSelfId(57);
    if (!adenaItem) return Promise.resolve({ ok: false, reason: 'missing_adena', ...plan });
    const nextAdena = plan.adena - plan.cost;
    return Database.updateItemAmount(actor.fetchId(), adenaItem.fetchId(), nextAdena)
        .then(() => {
            adenaItem.setAmount(nextAdena);
            return ensureActorStock(actor, plan);
        })
        .then((amount) => ({ ok: true, changed: true, ...plan, nextAdena, nextAmount: amount }));
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

function availablePotions(inventory, hpRatio) {
    return POTIONS.filter((potion) => amountInInventory(inventory, potion.selfId) > 0)
        .filter((potion) => potion.selfId !== 1540 || hpRatio <= QUICK_USE_HP_RATIO);
}

function selectPotion(inventory, hp, maxHp, roleOrActor) {
    const safeMaxHp = Math.max(1, Number(maxHp || hp || 1));
    const safeHp = Math.max(0, Number(hp || 0));
    const hpRatio = safeHp / safeMaxHp;
    if (hpRatio > useThreshold(roleOrActor)) return null;
    const available = availablePotions(inventory, hpRatio);
    if (!available.length) return null;

    if (hpRatio <= QUICK_USE_HP_RATIO) {
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
    if (actor.state?.fetchCasts?.() || activePotionHot(actor)) return null;

    const targetId = Number(target.fetchId?.() ?? target.id ?? 0);
    const encounter = session.healingPotionEncounter?.targetId === targetId
        ? session.healingPotionEncounter
        : { targetId, used: 0 };
    session.healingPotionEncounter = encounter;
    if (encounter.used >= Number(options.maxUses ?? MAX_USES_PER_ENCOUNTER)) return null;

    const inventory = actorInventory(actor);
    const potion = selectPotion(inventory, actor.fetchHp?.(), actor.fetchMaxHp?.(), actor);
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
    const inventory = { ...(state.inventory || {}) };
    const key = String(plan.potion.selfId);
    inventory[key] = {
        ...(inventory[key] || {}),
        selfId: plan.potion.selfId,
        name: plan.potion.name,
        amount: plan.currentAmount + plan.amount
    };
    inventory['57'] = {
        ...(inventory['57'] || {}),
        selfId: 57,
        name: 'Adena',
        amount: plan.adena - plan.cost
    };
    return {
        adena: plan.adena - plan.cost,
        inventory,
        purchase: {
            selfId: plan.potion.selfId,
            name: plan.potion.name,
            amount: plan.amount,
            unitPrice: plan.unitPrice,
            cost: plan.cost,
            at: Date.now()
        }
    };
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
    selectPotion,
    targetAmountFor,
    tryUseInCombat,
    useThreshold
};
