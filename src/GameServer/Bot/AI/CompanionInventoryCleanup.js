'use strict';

const Floor = require('../Population/SurvivalFloor');
const InventoryLimits = require('../../Inventory/InventoryLimits');
const RETRY_MS = 5 * 60 * 1000;
const LOCAL_ERRANDS = new Set(['unload_inventory', 'sell_unused_arrows', 'sell_resources', 'sell_junk', 'restock_shots']);

function playerLeader(session) {
    const leader = session.partyCompanion === true ? session.followPlayerSession : null;
    return leader?.actor && !invoke('GameServer/World/World').isBotSession(leader) ? leader : null;
}

function sharedTown(actor, leader) {
    const transit = invoke('GameServer/Bot/AI/TownTransitPolicy');
    const town = transit.townAt(actor);
    return town && transit.townAt(leader.actor) === town ? town : null;
}

function canContinue(session, actor, kind, target) {
    if (!LOCAL_ERRANDS.has(kind)) return true;
    const leader = playerLeader(session);
    if (!leader) return true;
    const town = sharedTown(actor, leader);
    return !!town && (!target || (
        (!target.town || target.town === town) && invoke('GameServer/Bot/AI/TownTransitPolicy').townAt(target) === town
    ));
}

function announceCapacity(session, actor) {
    const leader = playerLeader(session);
    const backpack = actor.backpack;
    if (!leader || !backpack) return;
    const maxLoad = actor.fetchMaxLoad?.();
    const load = backpack.fetchTotalLoad?.() || 0;
    const slots = backpack.fetchItems?.()?.length || 0;
    const weight = maxLoad > 0 ? load * 100 / maxLoad : 0;
    const occupied = slots * 100 / InventoryLimits.forActor(actor);
    const percent = Math.min(100, Math.max(weight, occupied));
    if (percent <= 60) {
        delete session.inventoryCapacityWarning;
        return;
    }

    const threshold = Math.floor(percent / 10) * 10;
    const leaderId = leader.actor.fetchId?.();
    const previous = session.inventoryCapacityWarning;
    if (previous && previous.leaderId === leaderId && previous.threshold >= threshold) return;
    if (invoke('GameServer/Bot/AI/TownTransitPolicy').townAt(leader.actor)) return;
    const capacity = weight >= occupied ? 'my carry weight limit' : 'my inventory slots';
    if (invoke('GameServer/Bot/AI/BotPartyChat').announce(session, {
        priority: 'coordination',
        key: `inventory-capacity:${actor.fetchId()}:${threshold}`,
        text: `I've used ${Math.floor(percent)}% of ${capacity}. Can we head to town so I can unload?`
    })) session.inventoryCapacityWarning = { leaderId, threshold };
}

function errand(session, actor, BotAI) {
    if (!(actor?.fetchMaxLoad?.() > 0) || Number(session.companionUnloadRetryAt || 0) > Date.now()
        || session.activeTrade || session.trade || session.activeNegotiation
        || session.coldLifeState?.stats?.tradeMeeting || session.pendingSupportCast || session.pendingSupportApproach
        || !Floor.bagMarks(actor).weight) return null;
    const leader = playerLeader(session);
    const townName = leader && sharedTown(actor, leader);
    if (leader && !townName) return null;
    const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
    const sellArrows = Disposition.unusedArrowCandidates(invoke('GameServer/Bot/Economy/MarketListingPolicy').actorState(session)).length > 0;
    if (!sellArrows && !invoke('GameServer/Bot/Economy/BotWarehouseService')
        .hasActorDepositCandidates(actor, session.coldLifeState, null, { unload: true })) {
        session.companionUnloadRetryAt = Date.now() + RETRY_MS;
        return null;
    }
    const town = leader ? { name: townName } : BotAI.getClosestTown(actor.fetchLocX(), actor.fetchLocY(), actor.fetchLocZ());
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

module.exports = { RETRY_MS, announceCapacity, canContinue, errand, playerLeader };
