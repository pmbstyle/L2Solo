'use strict';

const { canDeposit } = require('../../Warehouse/WarehouseItemRules');
const Mutations = require('../../Inventory/InventoryMutationQueue');
const Floor = require('../Population/SurvivalFloor');
const Arrows = require('../../Inventory/ArrowStock');
const RETRY_MS = 5 * 60 * 1000;

// Store only enough to get below the first native weight penalty. Keep worn
// gear, quest items, committed craft inputs and at least one combat charge.
function plan(actor, state = null) {
    const backpack = actor?.backpack, maximum = actor?.fetchMaxLoad?.();
    if (!backpack || !(maximum > 0)) return [];
    let excess = Number(backpack.fetchTotalLoad?.() || 0) - (Math.ceil(maximum / 2) - 1);
    if (!(excess > 0)) return [];
    const Shot = invoke('GameServer/Inventory/ShotStock');
    const Beginner = require('../../Items/C4BeginnerShots');
    const sources = backpack.fetchItems();
    const current = state ? { ...state, inventory: invoke('GameServer/Bot/Population/BotLifeState').inventorySummaryFromItems(sources) } : null;
    const available = current ? invoke('GameServer/Bot/Economy/ItemDisposition').unreservedActorItems(current, sources) : sources;
    const weapon = backpack.fetchEquippedWeapon?.();
    const candidates = available.filter(item => canDeposit(item) && !Beginner.isRestricted(item.fetchSelfId())
        && !Arrows.isArrow(item)
        && Number(item.fetchMass?.()) > 0).map(source => {
        const shot = Shot.SHOT_IDS.includes(source.fetchSelfId());
        const consumable = shot || ['Other.Arrow', 'Other.Potion'].includes(source.fetchKind?.());
        const charge = shot ? Number(Shot.kindForSelfId(source.fetchSelfId()) === 'soulshot'
            ? weapon?.fetchSoulshot?.() : weapon?.fetchSpiritshot?.()) || 1 : 1;
        return { source, mass: Number(source.fetchMass()), amount: Math.max(0, source.fetchAmount() - (consumable ? charge : 0)), shot };
    }).sort((a, b) => Number(a.shot) - Number(b.shot) || b.mass * b.amount - a.mass * a.amount);
    const result = [];
    for (const candidate of candidates) {
        if (excess <= 0) break;
        const amount = Math.min(candidate.amount, Math.ceil(excess / candidate.mass));
        if (amount <= 0) continue;
        result.push({ source: candidate.source, amount });
        excess -= amount * candidate.mass;
    }
    return result;
}

function errand(session, actor, BotAI) {
    if (!(actor?.fetchMaxLoad?.() > 0) || Number(session.companionUnloadRetryAt || 0) > Date.now()
        || session.activeTrade || session.trade || session.activeNegotiation
        || session.coldLifeState?.stats?.tradeMeeting || session.pendingSupportCast || session.pendingSupportApproach
        || !Floor.bagMarks(actor).weight) return null;
    const sellArrows = Arrows.unused(actor).length > 0;
    if (!sellArrows && !plan(actor, session.coldLifeState).length) {
        session.companionUnloadRetryAt = Date.now() + RETRY_MS;
        return null;
    }
    const town = BotAI.getClosestTown(actor.fetchLocX(), actor.fetchLocY(), actor.fetchLocZ());
    const Catalog = invoke('GameServer/Bot/Economy/TownServiceCatalog');
    const target = Catalog.targetFor(sellArrows ? Catalog.ROLES.GENERIC_MERCHANT : Catalog.ROLES.WAREHOUSE, town?.name, { from: {
        locX: actor.fetchLocX(), locY: actor.fetchLocY(), locZ: actor.fetchLocZ()
    } });
    if (!target || invoke('GameServer/Bot/AI/PartyCompanionService').staysOutOfTown(actor, target)) {
        session.companionUnloadRetryAt = Date.now() + RETRY_MS;
        return null;
    }
    return { kind: sellArrows ? 'sell_unused_arrows' : 'unload_inventory', target, town };
}

function sellUnusedArrows(session, actor, target) {
    const errand = session.companionShopping, backpack = actor.backpack;
    const Rules = invoke('GameServer/Items/NpcSellRules');
    return Mutations.run(backpack, async () => {
        // Keep the state's reservation guards, but size the arrow stock by
        // the same live load limit that the queued sale validates below.
        const state = { ...invoke('GameServer/Bot/Economy/MarketListingPolicy').actorState(session),
            fetchMaxLoad: () => actor.fetchMaxLoad() };
        const wanted = new Map(invoke('GameServer/Bot/Economy/ItemDisposition').unusedArrowCandidates(state)
            .map(row => [Number(row.selfId), Number(row.count)]));
        const requested = [];
        for (const item of Arrows.unused(actor).filter(Rules.canSell)) {
            const selfId = item.fetchSelfId(), amount = Math.min(item.fetchAmount(), wanted.get(selfId) || 0);
            if (!amount) continue;
            wanted.set(selfId, wanted.get(selfId) - amount);
            requested.push({ item, objectId: item.fetchId(), selfId, amount,
                expectedAmount: item.fetchAmount(), price: Rules.npcBuyPrice(item.fetchPrice()) });
        }
        if (!requested.length) return { count: 0, items: [] };
        const validate = () => {
            const allowed = Arrows.saleAmounts(actor), totals = new Map();
            for (const line of requested) totals.set(line.selfId, (totals.get(line.selfId) || 0) + line.amount);
            const Catalog = invoke('GameServer/Bot/Economy/TownServiceCatalog');
            const npc = (invoke('GameServer/World/World').npc?.spawns || []).find(npc =>
                Number(npc.fetchId?.()) === Number(target.actorId) && Number(npc.fetchSelfId?.()) === Number(target.npcSelfId));
            if (session.actor !== actor || session.plan !== 'shopping' || session.companionShopping !== errand
                || !session.partyCompanion || !session.followPlayerSession
                || session.activeTrade || session.trade || session.activeNegotiation || actor.isDead?.() || actor.fetchIsOnline?.() === false
                || [...totals].some(([id, count]) => count > Number(allowed.get(id) || 0))
                || invoke('GameServer/Bot/AI/BotTownTravel').hasCombatThreat(session, actor)
                || target.serviceRole !== Catalog.ROLES.GENERIC_MERCHANT
                || !npc || !Catalog.GENERIC_MERCHANT_TITLES.has(npc.fetchTitle?.())
                || Math.hypot(actor.fetchLocX() - npc.fetchLocX(), actor.fetchLocY() - npc.fetchLocY()) > 300
                || requested.some(line => !backpack.fetchItems().includes(line.item) || !Rules.canSell(line.item)
                    || line.item.fetchAmount() !== line.expectedAmount)) throw Error('companion_arrow_sale_interrupted');
        };
        validate();
        const sold = await invoke('Database').sellItemsToNpc(actor.fetchId(), requested.map(({ item, ...line }) => line), validate);
        for (const row of sold.sold) {
            const item = requested.find(line => line.objectId === row.objectId).item;
            if (row.amount) item.setAmount(row.amount);
            else backpack.items = backpack.fetchItems().filter(candidate => candidate !== item);
        }
        if (sold.adena) {
            const held = backpack.fetchItemRaw(sold.adena.id);
            if (held) held.setAmount(sold.adena.amount);
            else backpack.insertItem(sold.adena.id, 57, { amount: sold.adena.amount });
        }
        backpack.inventoryRevision = Number(backpack.inventoryRevision || 0) + 1;
        invoke('GameServer/Model/Item').bindInventory(backpack);
        return { count: requested.reduce((sum, line) => sum + line.amount, 0),
            items: requested.map(line => ({ selfId: line.selfId, amount: line.amount })),
            payout: requested.reduce((sum, line) => sum + line.amount * line.price, 0) };
    });
}

function deposit(session, actor, target) {
    const errand = session.companionShopping;
    const Warehouse = invoke('GameServer/Bot/Economy/BotWarehouseService');
    const validate = () => {
        if (session.actor !== actor || session.plan !== 'shopping' || session.companionShopping !== errand
            || !session.partyCompanion || !session.followPlayerSession || actor.isDead?.() || actor.fetchIsOnline?.() === false
            || session.activeTrade || session.trade || session.activeNegotiation
            || invoke('GameServer/Bot/AI/BotTownTravel').hasCombatThreat(session, actor)
            || !Warehouse.isAtWarehouseService(actor, target)) throw Error('companion_unload_interrupted');
    };
    return Mutations.run(actor.backpack, async () => {
        validate();
        const stored = [];
        for (const { source, amount } of plan(actor, session.coldLifeState)) {
            const item = { ...Warehouse.itemData(source), amount };
            const result = await invoke('Database').transferInventoryToWarehouse(actor.fetchId(), item, { validate });
            if (result.inventoryAmount === 0) actor.backpack.items = actor.backpack.fetchItems().filter(item => item !== source);
            else source.setAmount(result.inventoryAmount);
            actor.backpack.inventoryRevision = Number(actor.backpack.inventoryRevision || 0) + 1;
            stored.push({ selfId: item.selfId, name: item.name, amount });
        }
        return { count: stored.reduce((sum, item) => sum + item.amount, 0), items: stored };
    });
}

module.exports = { RETRY_MS, plan, errand, deposit, sellUnusedArrows };
