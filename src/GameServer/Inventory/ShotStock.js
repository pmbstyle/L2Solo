const ItemTemplateIndex = require('../Item/ItemTemplateIndex');
// ARCH-NOTE: Pure stock plans also run in guarded workers; load SQL only
// when an existing persistence branch is reached, before actor mutations.
let database;
const persistenceDatabase = () => database ||= invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const BotWeaponCompatibility = invoke('GameServer/Bot/AI/BotWeaponCompatibility');
const PurchaseFunding = invoke('GameServer/Bot/Economy/PurchaseFunding');

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

function isEquipped(item) {
    return item?.equipped === true || Number(item?.equipped) === 1 || Number(item?.equippedCount || 0) > 0;
}

// The equipped weapon among a bot's items, database rows or the cold inventory
// summary, or null. With two equipped weapons the lowest template id (selfId)
// wins: the summary has no item object id to compare.
function equippedWeapon(items) {
    let weapon = null;
    for (const item of Object.values(items || {})) {
        if (!isEquipped(item) || !WEAPON_SLOTS.has(Number(item.slot || 0))) continue;
        if (!weapon || Number(item.selfId) < Number(weapon.selfId)) weapon = item;
    }
    return weapon;
}

// A bot's shot from its cold state, as hot auto shots load it (planFor): its
// class's kind at the equipped weapon's grade, and how many the weapon takes
// per charge (perAction, the weapon's count as hot charges it; 0 without a
// weapon, so no shot loads).
function planForState(state) {
    const weapon = equippedWeapon(state?.inventory);
    const plan = planFor({
        classId: Number(state?.stats?.classId || state?.classId || 0),
        rank: weapon ? itemRank(weapon.selfId) : 'none'
    });
    const count = weapon ? templateFor(weapon.selfId)?.etc?.[plan.kind === 'soulshot' ? 'soulshot' : 'spiritshot'] : 0;
    return { ...plan, perAction: Math.max(0, Number(count) || 0) };
}

// The shots a bot keeps, by selfId: its own shot up to the amount a restock
// buys it to (restockPlan); any more of it, and shots of another grade, are
// spare. One rule for the sale set (ItemDisposition.saleCandidates) and the
// shot crafters' surplus (ColdShotEconomyService), so nothing the restock has
// just bought is sold back.
function keptAmounts(state, basics = null) {
    // The stock rule needs no wish network (L25).
    const stock = (basics || invoke('GameServer/Bot/Economy/EconomyContext').basics(state)).stock('shots');
    return { [stock.itemId]: stock.target };
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
    const weapon = equippedWeapon(rows);
    return planFor({
        classId,
        rank: weapon ? itemRank(weapon.selfId) : 'none'
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
        return persistenceDatabase().updateItemAmount(actor.fetchId(), current.fetchId(), targetAmount).then(() => {
            current.setAmount(targetAmount);
            return { changed: true, plan, amount: targetAmount, delta };
        });
    }

    return persistenceDatabase().setItem(actor.fetchId(), {
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
    return persistenceDatabase().fetchItems(id).then((rows) => {
        const plan = options.plan || planForRows(rows || [], options.classId ?? characterId?.classId);
        const current = existingRow(rows, plan.selfId);
        const currentAmount = Number(current?.amount || 0);

        if (current && currentAmount >= targetAmount) {
            return { changed: false, plan, amount: currentAmount, delta: 0 };
        }

        if (current) {
            const delta = targetAmount - currentAmount;
            return persistenceDatabase().updateItemAmount(id, current.id, targetAmount).then(() => ({
                changed: true,
                plan,
                amount: targetAmount,
                delta
            }));
        }

        return persistenceDatabase().setItem(id, {
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

// What the bot's healing-potion restock (HealingPotionStock.restockPlan) costs
// now: survival first, so the shot restock leaves this money for the potions.
// The potion price is the caller's local NPC price, else the cheapest NPC price.
function potionRestockCost(value, inventory, adena, reserve, potionUnitPrice) {
    const Potions = invoke('GameServer/Bot/AI/HealingPotionStock');
    const potion = Potions.purchasePotionFor(value);
    const unitPrice = Number(potionUnitPrice ?? invoke('GameServer/Bot/Economy/StaticMerchantPricing')
        .cheapestPurchase(potion.selfId));
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) return 0;
    return Potions.restockPlan(value, { potion, inventory: inventory || undefined, adena, reserve, unitPrice }).cost;
}

// One restock rule for hot and cold bots, like HealingPotionStock.restockPlan:
// below 1,000 shots a bot buys up to 3,000, first from players' shops cheaper
// than the NPC (cheapest first, as many as needed), then from the NPC, and
// spends only what is above its consumables reserve (PurchaseFunding) and the
// cost of its healing-potion restock (survival first, user 2026-10-04).
// `value` is a hot actor or a cold state; the NPC price is the one unit price.
function restockPlan(value, options = {}) {
    const actor = !!value?.backpack;
    const plan = options.plan || (actor ? planForActor(value) : planForState(value));
    const inventory = options.inventory || (actor ? null : value?.inventory);
    const currentAmount = inventory
        ? Number(inventory[String(plan.selfId)]?.amount || 0)
        : shotAmount(value, plan);
    const adena = Math.max(0, Number(options.adena ?? (actor
        ? value.backpack.fetchItemFromSelfId?.(57)?.fetchAmount?.() : value?.adena) ?? 0) || 0);
    const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
    const state = actor ? Economy.stateForActor(value) : value;
    const coldMain = require('node:worker_threads').isMainThread && state?.phase === 'cold';
    const context = coldMain ? Economy.basics(state) : Economy.forState(state);
    const stock = context.stock('shots');
    const targetAmount = Math.max(0, Number(options.targetAmount ?? stock.target) || 0);
    const reserve = PurchaseFunding.operatingReserve(state);
    const unitPrice = Number(options.unitPrice ?? invoke('GameServer/Bot/Economy/StaticMerchantPricing')
        .botPurchasePrice(plan.selfId));
    const npcPrice = Number.isFinite(unitPrice) && unitPrice > 0 ? unitPrice : 0;
    const allowance = coldMain || options.targetAmount !== undefined ? PurchaseFunding.spendable(state, 0,
        { itemId: plan.selfId, survivalCost: context.kitCost(plan.selfId) }) : context.purchaseBudget(plan.selfId);
    const maxPrice = npcPrice > 0 ? npcPrice - 1 : invoke('GameServer/Bot/Population/ColdEconomyDecision').economyFor(state).worth(plan.selfId);
    const needed = allowance > 0 && currentAmount < (options.targetAmount !== undefined ? targetAmount : stock.usePerHour);
    const left = needed ? Math.max(0, targetAmount - currentAmount) : 0;
    const potionCost = needed ? potionRestockCost(value, inventory, adena, reserve, options.potionUnitPrice) : 0;
    const money = Math.min(allowance, Math.max(0, adena - potionCost));
    // The players' lines cheaper than the NPC, cheapest first, then the NPC:
    // the one rule for a stack purchase (OfferQuery.fill).
    const offers = [...(options.offers || [])].sort((a, b) => Number(a.price) - Number(b.price));
    const filled = invoke('GameServer/Bot/Economy/OfferQuery').fill(offers, left, { money, maxPrice });
    const shops = filled.lines.map(({ line, count, price }) => ({ offer: line, price, amount: count, cost: count * price }));
    const shopAmount = shops.reduce((sum, line) => sum + line.amount, 0);
    const shopCost = shops.reduce((sum, line) => sum + line.cost, 0);
    const npcAmount = npcRestockAmount({ needed, targetAmount, currentAmount,
        unitPrice: npcPrice, adena: Math.min(adena, money + potionCost), reserve: 0, potionCost }, shopAmount, shopCost);
    return {
        plan,
        currentAmount,
        targetAmount,
        needed,
        shops,
        npcAmount,
        unitPrice: npcPrice,
        amount: shopAmount + npcAmount,
        cost: shopCost + npcAmount * npcPrice,
        spendBudget: money,
        adena,
        reserve,
        potionCost
    };
}

// The NPC part of a restock (restockPlan): the remaining hours of stock with the money
// left after the players' shops. `bought` and `spent` are what the shop lines
// bought, so a line that fails at purchase leaves its shots and money to the NPC.
function npcRestockAmount(restock, bought = 0, spent = 0) {
    if (!restock.needed || !(restock.unitPrice > 0)) return 0;
    const left = restock.targetAmount - restock.currentAmount - bought;
    const money = Math.max(0, (restock.spendBudget ?? (restock.adena - restock.reserve - restock.potionCost)) - spent);
    return Math.max(0, Math.min(left, Math.floor(money / restock.unitPrice)));
}

// A hot bot's restock (restockPlan) on its trip: the players' shops, then the NPC.
async function purchaseActorRestock(actor, options = {}) {
    if (!actor?.backpack || typeof actor.fetchId !== 'function') {
        return { ok: false, reason: 'missing_actor' };
    }

    const plan = options.plan || planForActor(actor);
    const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
    // The board's lines of the town the bot stands in (б5: a deal is made in
    // the seller's town); away from a town, only the merchant's price.
    const town = options.town ?? invoke('GameServer/Bot/AI/TownTransitPolicy').townAt(actor);
    const restock = restockPlan(actor, { plan, targetAmount: options.targetAmount, unitPrice: options.unitPrice, potionUnitPrice: options.potionUnitPrice,
        offers: town ? AfkTrade.offers(plan.selfId, AfkTrade.SELL, { characterId: actor.fetchId(), town }) : [] });
    if (!restock.needed) return { ok: true, changed: false, plan, amount: restock.currentAmount, cost: 0 };
    if (restock.amount <= 0) {
        return { ok: false, reason: 'not_enough_adena', plan, adena: restock.adena,
            cost: (restock.targetAmount - restock.currentAmount) * restock.unitPrice };
    }

    let delta = 0;
    let cost = 0;
    for (const line of restock.shops) {
        try {
            await AfkTrade.buyFromShop(actor.fetchId(), line.offer.store, plan.selfId, line.amount,
                { lineId: line.offer.lineId, expectedPrice: line.price });
            delta += line.amount;
            cost += line.cost;
        } catch (_) {
            // An AFK listing may change between selection and purchase.
        }
    }
    const adenaItem = actor.backpack.fetchItemFromSelfId(57);
    const adena = Number(adenaItem?.fetchAmount ? adenaItem.fetchAmount() : 0);
    const npcAmount = npcRestockAmount(restock, delta, cost);
    const npcCost = npcAmount * restock.unitPrice;
    if (!adenaItem || npcAmount <= 0 || adena < npcCost) {
        return delta > 0
            ? { ok: true, changed: true, plan, amount: shotAmount(actor, plan), delta, cost, adena }
            : { ok: false, reason: 'not_enough_adena', plan, cost: restock.cost, adena };
    }

    const nextAdena = adena - npcCost;
    const nextAmount = shotAmount(actor, plan) + npcAmount;
    await persistenceDatabase().updateItemAmount(actor.fetchId(), adenaItem.fetchId(), nextAdena);
    adenaItem.setAmount(nextAdena);
    const result = await ensureActorStock(actor, { targetAmount: nextAmount, plan });
    return { ok: true, ...result, delta: delta + npcAmount, cost: cost + npcCost, adena: nextAdena };
}

// A weapon change can switch the shot grade and kind: buy the restock with the
// bot's own adena and re-enable auto shots. Other slots leave the shots alone.
function restockAfterWeaponChange(actor, slots = [], logTag = 'BotGear') {
    if (!slots.some((slot) => WEAPON_SLOTS.has(Number(slot)))) return Promise.resolve(null);
    // Through the module object, as the callers did before: tests replace these.
    const shots = module.exports;
    return shots.purchaseActorRestock(actor)
        .then(() => shots.enableAutoShot(actor))
        .catch((error) => utils.infoWarn(logTag, 'failed to refresh shots for %s: %s', actor.fetchName?.(), error.message));
}

function needsActorRestock(actor) {
    const context = invoke('GameServer/Bot/Economy/EconomyContext').forActor(actor);
    const stock = context.stock('shots');
    return stock.needed && context.purchaseBudget(stock.itemId) > 0;
}

// Where a hot bot goes for its shots in `town`: the best seller there, a
// city merchant's or a shop's stall, or an ad dealt with by record at its
// place (D6). The purchase itself is the restock (purchaseActorRestock).
function restockTarget(actor, town, excludedIds = []) {
    const excluded = new Set(excludedIds.map(Number));
    const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
    const offers = MarketOpportunity.hotOffers(planForActor(actor).selfId, { town, buyerCharacterId: actor.fetchId() });
    for (const offer of offers) {
        if (excluded.has(Number(offer.sourceId)) || Number(offer.sourceId) === Number(actor.fetchId())) continue;
        if (offer.sellerKind !== 'fixed' && !String(offer.sourceType).startsWith('afk_')) continue;
        if (offer.sellerKind === 'fixed' && !offer.session?.actor) continue;
        return MarketOpportunity.offerTarget(offer, town);
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
    actionShotKind,
    kindForSelfId,
    isCompatibleWithActor,
    keptAmounts,
    enableAutoShot,
    planForRows,
    shotAmount,
    ensureActorStock,
    ensureCharacterStock,
    restockPlan,
    npcRestockAmount,
    purchaseActorRestock,
    restockAfterWeaponChange,
    needsActorRestock,
    describe
};
