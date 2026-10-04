const ItemTemplateIndex = require('../Item/ItemTemplateIndex');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const BotWeaponCompatibility = invoke('GameServer/Bot/AI/BotWeaponCompatibility');

const DEFAULT_TARGET_AMOUNT = 1000;
const PURCHASE_TARGET_AMOUNT = 3000;
const WEAPON_SLOTS = new Set([7, 14]);

const SOULSHOT_BY_RANK = {
    none: 1835,
    d: 1463,
    c: 1464,
    b: 1465,
    a: 1466,
    s: 1467
};

const SPIRITSHOT_BY_RANK = {
    none: 2509,
    d: 2510,
    c: 2511,
    b: 2512,
    a: 2513,
    s: 2514
};

const BLESSED_SPIRITSHOT_BY_RANK = {
    none: 3947,
    d: 3948,
    c: 3949,
    b: 3950,
    a: 3951,
    s: 3952
};

// Quest rewards use these no-grade variants. They carry the same charge
// skills as the shop shots, but are separate item ids and must remain usable.
const BEGINNER_SOULSHOT_IDS = [5789];
const BEGINNER_SPIRITSHOT_IDS = [5790];
const SOULSHOT_IDS = Object.values(SOULSHOT_BY_RANK);
const SPIRITSHOT_IDS = Object.values(SPIRITSHOT_BY_RANK);
const BLESSED_SPIRITSHOT_IDS = Object.values(BLESSED_SPIRITSHOT_BY_RANK);
const SHOT_IDS = [...SOULSHOT_IDS, ...SPIRITSHOT_IDS, ...BLESSED_SPIRITSHOT_IDS, ...BEGINNER_SOULSHOT_IDS, ...BEGINNER_SPIRITSHOT_IDS];

function normalizeRank(rank) {
    const value = String(rank || 'none').toLowerCase();
    return SOULSHOT_BY_RANK[value] ? value : 'none';
}

function templateFor(selfId) {
    return ItemTemplateIndex.find(DataCache.items, selfId) || null;
}

function itemName(selfId) {
    return templateFor(selfId)?.template?.name || `Item ${selfId}`;
}

function itemPrice(selfId) {
    return Number(templateFor(selfId)?.template?.price || 0);
}

function itemRank(selfId) {
    return normalizeRank(templateFor(selfId)?.etc?.rank);
}

function classWantsSpiritshots(classId) {
    const role = BotRoles.inferRole(Number(classId || 0));
    return BotWeaponCompatibility.isCasterRole(role, classId);
}

function actorClassId(actor) {
    return typeof actor?.fetchClassId === 'function' ? actor.fetchClassId() : actor?.classId;
}

function weaponRankFromActor(actor) {
    const weapon = actor?.backpack?.fetchEquippedWeapon ? actor.backpack.fetchEquippedWeapon() : null;
    if (weapon && typeof weapon.fetchRank === 'function') {
        return normalizeRank(weapon.fetchRank());
    }
    if (weapon && typeof weapon.fetchSelfId === 'function') {
        return itemRank(weapon.fetchSelfId());
    }
    return 'none';
}

function weaponRankFromRows(rows = []) {
    const equippedWeapon = rows.find((row) => {
        if (Number(row.equipped) !== 1 && row.equipped !== true) return false;
        return WEAPON_SLOTS.has(Number(row.slot || 0));
    });
    return equippedWeapon ? itemRank(equippedWeapon.selfId) : 'none';
}

function isEquipped(item) {
    return item?.equipped === true || Number(item?.equipped) === 1 || Number(item?.equippedCount || 0) > 0;
}

// The weapon equipped in a bot's inventory summary (the cold state), or null.
function equippedWeaponInState(state) {
    const inventory = state?.inventory || {};
    for (const key in inventory) {
        const item = inventory[key];
        if (isEquipped(item) && WEAPON_SLOTS.has(Number(item.slot || 0))) return item;
    }
    return null;
}

// A bot's shot from its cold state, as hot auto shots load it (planFor): its
// class's kind at the equipped weapon's grade.
function planForState(state) {
    const weapon = equippedWeaponInState(state);
    return planFor({
        classId: Number(state?.stats?.classId || state?.classId || 0),
        rank: weapon ? itemRank(weapon.selfId) : 'none'
    });
}

function planFor({ classId, rank = 'none' } = {}) {
    const normalizedRank = normalizeRank(rank);
    const kind = classWantsSpiritshots(classId) ? 'spiritshot' : 'soulshot';
    return planForKind(kind, normalizedRank);
}

function planForKind(kind, rank = 'none') {
    const normalizedRank = normalizeRank(rank);
    const normalizedKind = kind === 'blessedSpiritshot'
        ? 'blessedSpiritshot'
        : kind === 'spiritshot' ? 'spiritshot' : 'soulshot';
    const selfId = normalizedKind === 'blessedSpiritshot'
        ? BLESSED_SPIRITSHOT_BY_RANK[normalizedRank]
        : normalizedKind === 'spiritshot'
            ? SPIRITSHOT_BY_RANK[normalizedRank]
            : SOULSHOT_BY_RANK[normalizedRank];

    return {
        kind: normalizedKind,
        rank: normalizedRank,
        selfId,
        name: itemName(selfId),
        price: itemPrice(selfId)
    };
}

function planForActor(actor) {
    return planFor({
        classId: actorClassId(actor),
        rank: weaponRankFromActor(actor)
    });
}

function planForActorKind(kind, actor) {
    return planForKind(kind, weaponRankFromActor(actor));
}

function kindForSelfId(selfId) {
    const id = Number(selfId);
    if (SOULSHOT_IDS.includes(id) || BEGINNER_SOULSHOT_IDS.includes(id)) return 'soulshot';
    if (SPIRITSHOT_IDS.includes(id) || BEGINNER_SPIRITSHOT_IDS.includes(id)) return 'spiritshot';
    if (BLESSED_SPIRITSHOT_IDS.includes(id)) return 'blessedSpiritshot';
    return null;
}

// The shot an action loads (Attack.chargeShotForSkill, used by hot and cold
// combat): a spell a spiritshot, a physical skill a soulshot unless its
// ssBoost is 0, a normal attack (no skill, so no ssBoost) a soulshot. A cast
// or a skill spends its shot at use; a normal attack only when the hit lands.
function actionShotKind(magic, ssBoost) {
    if (magic) return 'spiritshot';
    return Number(ssBoost) <= 0 ? null : 'soulshot';
}

function isCompatibleWithActor(kind, selfId, actor) {
    const id = Number(selfId);
    const rank = weaponRankFromActor(actor);
    if (planForActorKind(kind, actor).selfId === id) return true;
    return rank === 'none' && (
        (kind === 'soulshot' && BEGINNER_SOULSHOT_IDS.includes(id)) ||
        (kind === 'spiritshot' && BEGINNER_SPIRITSHOT_IDS.includes(id))
    );
}

function enableAutoShot(actor) {
    if (!actor?.backpack) return null;

    const plan = planForActor(actor);
    if (!actor.backpack.fetchItemFromSelfId?.(plan.selfId)) return null;

    const enabled = actor.autoSoulshots instanceof Set
        ? actor.autoSoulshots
        : new Set(actor.autoSoulshots || []);
    // A bot has one combat profile. Remove an old grade/kind after an equipment
    // upgrade so a physical weapon never keeps a caster shot (or vice versa).
    SHOT_IDS.forEach((selfId) => enabled.delete(selfId));
    enabled.add(plan.selfId);
    actor.autoSoulshots = enabled;
    return plan;
}

function planForRows(rows, classId) {
    return planFor({
        classId,
        rank: weaponRankFromRows(rows || [])
    });
}

function shotAmount(actor, plan = planForActor(actor)) {
    const item = actor?.backpack?.fetchItemFromSelfId
        ? actor.backpack.fetchItemFromSelfId(plan.selfId)
        : null;
    return Number(item?.fetchAmount ? item.fetchAmount() : 0);
}

function existingRow(rows, selfId) {
    return (rows || []).find((row) => Number(row.selfId) === Number(selfId));
}

function ensureActorStock(actor, options = {}) {
    if (!actor?.backpack || typeof actor.fetchId !== 'function') {
        return Promise.resolve({ changed: false, reason: 'missing_actor' });
    }

    const targetAmount = Number(options.targetAmount || DEFAULT_TARGET_AMOUNT);
    const plan = options.plan || planForActor(actor);
    const current = actor.backpack.fetchItemFromSelfId(plan.selfId);
    const currentAmount = Number(current?.fetchAmount ? current.fetchAmount() : 0);

    if (current && currentAmount >= targetAmount) {
        return Promise.resolve({ changed: false, plan, amount: currentAmount, delta: 0 });
    }

    if (current) {
        const delta = targetAmount - currentAmount;
        return Database.updateItemAmount(actor.fetchId(), current.fetchId(), targetAmount).then(() => {
            current.setAmount(targetAmount);
            return { changed: true, plan, amount: targetAmount, delta };
        });
    }

    return Database.setItem(actor.fetchId(), {
        selfId: plan.selfId,
        name: plan.name,
        amount: targetAmount,
        equipped: false,
        slot: 0
    }).then((packet) => {
        actor.backpack.insertItem(Number(packet.insertId), plan.selfId, { amount: targetAmount });
        return { changed: true, plan, amount: targetAmount, delta: targetAmount };
    });
}

function ensureCharacterStock(characterId, options = {}) {
    const id = Number(characterId?.id || characterId || 0);
    if (!id) return Promise.resolve({ changed: false, reason: 'missing_character' });

    const targetAmount = Number(options.targetAmount || DEFAULT_TARGET_AMOUNT);
    return Database.fetchItems(id).then((rows) => {
        const plan = options.plan || planForRows(rows || [], options.classId ?? characterId?.classId);
        const current = existingRow(rows, plan.selfId);
        const currentAmount = Number(current?.amount || 0);

        if (current && currentAmount >= targetAmount) {
            return { changed: false, plan, amount: currentAmount, delta: 0 };
        }

        if (current) {
            const delta = targetAmount - currentAmount;
            return Database.updateItemAmount(id, current.id, targetAmount).then(() => ({
                changed: true,
                plan,
                amount: targetAmount,
                delta
            }));
        }

        return Database.setItem(id, {
            selfId: plan.selfId,
            name: plan.name,
            amount: targetAmount,
            equipped: false,
            slot: 0
        }).then(() => ({
            changed: true,
            plan,
            amount: targetAmount,
            delta: targetAmount
        }));
    });
}

async function purchaseActorRestock(actor, options = {}) {
    if (!actor?.backpack || typeof actor.fetchId !== 'function') {
        return { ok: false, reason: 'missing_actor' };
    }

    const targetAmount = Number(options.targetAmount || PURCHASE_TARGET_AMOUNT);
    const plan = options.plan || planForActor(actor);
    const currentAmount = shotAmount(actor, plan);
    const missingAmount = Math.max(0, targetAmount - currentAmount);
    if (missingAmount <= 0) return { ok: true, changed: false, plan, amount: currentAmount, cost: 0 };

    const staticPrice = invoke('GameServer/Bot/Economy/StaticMerchantPricing')
        .cheapestPurchase(plan.selfId);
    const unitPrice = Number.isFinite(staticPrice) ? Math.max(1, Number(plan.price || 0), staticPrice)
        : Math.max(1, Number(plan.price || 0));
    const fullCost = missingAmount * unitPrice;
    const adenaItem = actor.backpack.fetchItemFromSelfId(57);
    let adena = Number(adenaItem?.fetchAmount ? adenaItem.fetchAmount() : 0);
    let remaining = missingAmount;
    let marketCost = 0;
    const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
    const offers = AfkTrade.offers(plan.selfId, AfkTrade.SELL, { characterId: actor.fetchId() })
        .filter((offer) => Number(offer.price) > 0 && Number(offer.price) < unitPrice && Number(offer.count) > 0)
        .sort((a, b) => Number(a.price) - Number(b.price)).slice(0, 4);
    for (const offer of offers) {
        const quantity = Math.min(remaining, Number(offer.count), Math.floor(adena / Number(offer.price)));
        if (quantity <= 0) continue;
        try {
            await AfkTrade.buyFromShop(actor.fetchId(), offer.store, plan.selfId, quantity,
                { expectedPrice: Number(offer.price) });
            marketCost += quantity * Number(offer.price);
            remaining -= quantity;
            adena = Number(actor.backpack.fetchItemFromSelfId(57)?.fetchAmount?.() || 0);
        } catch (_) {
            // An AFK listing may change between selection and purchase.
        }
        if (remaining <= 0) break;
    }
    if (remaining <= 0) return { ok: true, changed: true, plan, amount: targetAmount, delta: missingAmount, cost: marketCost };

    const affordableAmount = unitPrice > 0 ? Math.floor(adena / unitPrice) : missingAmount;
    const delta = Math.min(remaining, affordableAmount);
    const currentAdenaItem = actor.backpack.fetchItemFromSelfId(57);
    if (!currentAdenaItem || delta <= 0) {
        return marketCost > 0
            ? { ok: true, changed: true, plan, amount: targetAmount - remaining, delta: missingAmount - remaining, cost: marketCost, adena }
            : { ok: false, reason: 'not_enough_adena', plan, cost: fullCost, adena };
    }

    const cost = delta * unitPrice;
    const nextAdena = adena - cost;
    const nextAmount = targetAmount - remaining + delta;
    return Database.updateItemAmount(actor.fetchId(), currentAdenaItem.fetchId(), nextAdena)
        .then(() => {
            currentAdenaItem.setAmount(nextAdena);
            return ensureActorStock(actor, { targetAmount: nextAmount, plan });
        })
        .then((result) => ({ ok: true, ...result, cost: marketCost + cost, adena: nextAdena }));
}

// A weapon change can switch the shot grade and kind: buy the restock with the
// bot's own adena and re-enable auto shots. Other slots leave the shots alone.
function restockAfterWeaponChange(actor, slots = [], logTag = 'BotGear') {
    if (!slots.some((slot) => WEAPON_SLOTS.has(Number(slot)))) return Promise.resolve(null);
    // Through the module object, as the callers did before: tests replace these.
    const shots = module.exports;
    return shots.purchaseActorRestock(actor, { targetAmount: DEFAULT_TARGET_AMOUNT })
        .then(() => shots.enableAutoShot(actor))
        .catch((error) => utils.infoWarn(logTag, 'failed to refresh shots for %s: %s', actor.fetchName?.(), error.message));
}

function needsActorRestock(actor, threshold = 0) {
    return shotAmount(actor) <= Number(threshold || 0);
}

function restockTarget(actor, town, excludedIds = []) {
    const excluded = new Set(excludedIds.map(Number));
    const offers = invoke('GameServer/Bot/Economy/MarketOpportunity')
        .hotOffers(planForActor(actor).selfId, { town, buyerCharacterId: actor.fetchId() });
    for (const offer of offers) {
        if (excluded.has(Number(offer.sourceId)) || Number(offer.sourceId) === Number(actor.fetchId())) continue;
        if (offer.sellerKind !== 'fixed' && !String(offer.sourceType).startsWith('afk_')) continue;
        const seller = offer.projection?.actor || offer.session?.actor;
        if (!seller) continue;
        return { actorId: seller.fetchId(), sourceId: Number(offer.sourceId), name: offer.sourceName,
            locX: seller.fetchLocX(), locY: seller.fetchLocY(), locZ: seller.fetchLocZ(), town };
    }
    return null;
}

function describe(plan) {
    if (!plan) return 'shots';
    return plan.name || itemName(plan.selfId);
}

module.exports = {
    restockTarget,
    DEFAULT_TARGET_AMOUNT,
    PURCHASE_TARGET_AMOUNT,
    SOULSHOT_IDS,
    SPIRITSHOT_IDS,
    BLESSED_SPIRITSHOT_IDS,
    SHOT_IDS,
    planFor,
    planForKind,
    planForActor,
    planForActorKind,
    planForState,
    equippedWeaponInState,
    actionShotKind,
    kindForSelfId,
    isCompatibleWithActor,
    enableAutoShot,
    planForRows,
    shotAmount,
    ensureActorStock,
    ensureCharacterStock,
    purchaseActorRestock,
    restockAfterWeaponChange,
    needsActorRestock,
    describe
};
