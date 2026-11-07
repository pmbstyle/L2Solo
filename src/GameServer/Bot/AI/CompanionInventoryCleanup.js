'use strict';

// When an overweight party companion leaves for town (FollowingState,
// hot only), and to which service: the merchant when the hot NPC sale takes
// arrows (SellJunk over MarketListingPolicy's NPC lines), else the warehouse
// when its unload stores something (BotWarehouseService.storableActorItems).
// The visit itself goes through those owners (ShoppingState).
const Floor = require('../Population/SurvivalFloor');
const RETRY_MS = 5 * 60 * 1000;

function errand(session, actor, BotAI) {
    if (!(actor?.fetchMaxLoad?.() > 0) || Number(session.companionUnloadRetryAt || 0) > Date.now()
        || session.activeTrade || session.trade || session.activeNegotiation
        || session.coldLifeState?.stats?.tradeMeeting || session.pendingSupportCast || session.pendingSupportApproach
        || !Floor.bagMarks(actor).weight) return null;
    const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
    const sellArrows = Disposition.unusedArrowCandidates(invoke('GameServer/Bot/Economy/MarketListingPolicy').actorState(session)).length > 0;
    if (!sellArrows && !invoke('GameServer/Bot/Economy/BotWarehouseService')
        .hasActorDepositCandidates(actor, session.coldLifeState, null, { unload: true })) {
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

module.exports = { RETRY_MS, errand };
