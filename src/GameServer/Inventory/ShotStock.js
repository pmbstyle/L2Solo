const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');

const DEFAULT_TARGET_AMOUNT = 1000;
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

const SOULSHOT_IDS = Object.values(SOULSHOT_BY_RANK);
const SPIRITSHOT_IDS = Object.values(SPIRITSHOT_BY_RANK);
const SHOT_IDS = [...SOULSHOT_IDS, ...SPIRITSHOT_IDS];

function normalizeRank(rank) {
    const value = String(rank || 'none').toLowerCase();
    return SOULSHOT_BY_RANK[value] ? value : 'none';
}

function templateFor(selfId) {
    return (DataCache.items || []).find((item) => Number(item.selfId) === Number(selfId)) || null;
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
    return role === 'mage' || role === 'healer' || role === 'buffer';
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

function planFor({ classId, rank = 'none' } = {}) {
    const normalizedRank = normalizeRank(rank);
    const kind = classWantsSpiritshots(classId) ? 'spiritshot' : 'soulshot';
    return planForKind(kind, normalizedRank);
}

function planForKind(kind, rank = 'none') {
    const normalizedRank = normalizeRank(rank);
    const normalizedKind = kind === 'spiritshot' ? 'spiritshot' : 'soulshot';
    const selfId = normalizedKind === 'spiritshot'
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

function purchaseActorRestock(actor, options = {}) {
    if (!actor?.backpack || typeof actor.fetchId !== 'function') {
        return Promise.resolve({ ok: false, reason: 'missing_actor' });
    }

    const targetAmount = Number(options.targetAmount || DEFAULT_TARGET_AMOUNT);
    const plan = options.plan || planForActor(actor);
    const currentAmount = shotAmount(actor, plan);
    const delta = Math.max(0, targetAmount - currentAmount);
    if (delta <= 0) return Promise.resolve({ ok: true, changed: false, plan, amount: currentAmount, cost: 0 });

    const cost = delta * Number(plan.price || 0);
    const adenaItem = actor.backpack.fetchItemFromSelfId(57);
    const adena = Number(adenaItem?.fetchAmount ? adenaItem.fetchAmount() : 0);
    if (!adenaItem || adena < cost) {
        return Promise.resolve({ ok: false, reason: 'not_enough_adena', plan, cost, adena });
    }

    const nextAdena = adena - cost;
    return Database.updateItemAmount(actor.fetchId(), adenaItem.fetchId(), nextAdena)
        .then(() => {
            adenaItem.setAmount(nextAdena);
            return ensureActorStock(actor, { targetAmount, plan });
        })
        .then((result) => ({ ok: true, ...result, cost, adena: nextAdena }));
}

function needsActorRestock(actor, threshold = 0) {
    return shotAmount(actor) <= Number(threshold || 0);
}

function describe(plan) {
    if (!plan) return 'shots';
    return plan.name || itemName(plan.selfId);
}

module.exports = {
    DEFAULT_TARGET_AMOUNT,
    SOULSHOT_IDS,
    SPIRITSHOT_IDS,
    SHOT_IDS,
    planFor,
    planForKind,
    planForActor,
    planForActorKind,
    planForRows,
    shotAmount,
    ensureActorStock,
    ensureCharacterStock,
    purchaseActorRestock,
    needsActorRestock,
    describe
};
