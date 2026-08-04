const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const ShotStock = invoke('GameServer/Inventory/ShotStock');

const MAX_REQUEST_AMOUNT = 5000;

function actorAdena(actor) {
    return Number(actor?.backpack?.fetchItemFromSelfId?.(57)?.fetchAmount?.() || 0);
}

function request(session, playerSession, itemSelfId, requestedAmount) {
    const bot = session?.actor;
    const player = playerSession?.actor;
    const selfId = Number(itemSelfId || 0);
    const amount = Math.floor(Number(requestedAmount || 0));
    if (!bot || !player || session.partyCompanion !== true || session.followPlayerSession !== playerSession) {
        return { ok: false, reason: 'not_a_party_companion' };
    }
    if (!ShotStock.kindForSelfId(selfId)) return { ok: false, reason: 'unsupported_supply_item' };
    if (amount < 1 || amount > MAX_REQUEST_AMOUNT) return { ok: false, reason: 'invalid_supply_amount' };
    if (session.companionShopping || session.pendingResourceDelivery || session.activeTrade) {
        return { ok: false, reason: 'supply_errand_active' };
    }

    const BotAI = invoke('GameServer/Bot/BotAI');
    const town = BotAI.getClosestTown(bot.fetchLocX(), bot.fetchLocY());
    const offer = MarketOpportunity.npcOffers(selfId, town.name)
        .sort((left, right) => Number(left.price) - Number(right.price))[0];
    if (!offer) return { ok: false, reason: 'supply_not_sold_in_town', town: town.name };

    const cost = Number(offer.price) * amount;
    const adena = actorAdena(bot);
    if (cost <= 0 || adena < cost) return { ok: false, reason: 'not_enough_adena', cost, adena };

    session.resumeAfterShopping = {
        plan: 'following',
        followPlayerSession: playerSession,
        partyCompanion: true,
        botStay: false,
        stayLocation: null
    };
    session.companionShopping = {
        kind: 'player_resource_purchase',
        playerSession,
        playerId: player.fetchId(),
        itemId: selfId,
        itemName: offer.itemName,
        amount,
        unitPrice: Number(offer.price),
        totalCost: cost,
        target: {
            actorId: null,
            name: `${town.name} general shop`,
            locX: town.x,
            locY: town.y,
            locZ: town.z,
            town: town.name
        }
    };
    session.shoppingTarget = session.companionShopping.target;
    session.shoppingDoneAnnounced = false;
    session.currentTargetId = undefined;
    session.botStay = false;
    bot.unselect?.();
    bot.automation?.abortAll?.(bot);

    const travel = invoke('GameServer/Bot/AI/BotTownTravel').request(
        session,
        bot,
        BotAI,
        null,
        { allowCompanion: true, preserveShoppingTarget: true, announce: false }
    );
    if (travel === 'deferred') {
        invoke('GameServer/Bot/AI/BotTownTravel').clearCombatTrip(session);
        session.companionShopping = undefined;
        session.shoppingTarget = undefined;
        session.resumeAfterShopping = undefined;
        return { ok: false, reason: 'unsafe_combat_state' };
    }
    return {
        ok: true,
        outcome: 'pending',
        reason: 'supply_errand_started',
        itemSelfId: selfId,
        itemName: offer.itemName,
        amount,
        cost,
        town: town.name,
        travel
    };
}

module.exports = { MAX_REQUEST_AMOUNT, request };
