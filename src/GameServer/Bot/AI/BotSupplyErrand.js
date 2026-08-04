const DataCache = invoke('GameServer/DataCache');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const TradeService = invoke('GameServer/Bot/TradeService');
const ServerResponse = invoke('GameServer/Network/Response');
const TownPathfinder = invoke('GameServer/Bot/AI/TownPathfinder');
const TownRespawn = invoke('GameServer/World/TownRespawn');

const MAX_REQUEST_AMOUNT = 5000;

function actorAdena(actor) {
    return Number(actor?.backpack?.fetchItemFromSelfId?.(57)?.fetchAmount?.() || 0);
}

function itemTemplate(selfId) {
    return (DataCache.items || []).find((item) => Number(item.selfId) === Number(selfId)) || null;
}

function townDestination(offer, bot, BotAI) {
    const town = TownPathfinder.towns?.find((candidate) => candidate.name === offer?.town);
    if (town?.center) {
        return { name: town.name, x: town.center.locX, y: town.center.locY, z: town.center.locZ };
    }
    const respawn = Object.values(TownRespawn.towns || {}).find((candidate) => candidate.name === offer?.town);
    if (respawn) return { name: respawn.name, x: respawn.locX, y: respawn.locY, z: respawn.locZ };
    // Never silently replace “the city that sells this” with the nearest
    // restart town. An incomplete atlas entry is safer as an explicit
    // destination error than a bot arriving at a city without the item.
    return null;
}

function hideForSupply(session, bot) {
    if (session.supplyErrandHidden === true) return;
    session.supplyErrandHidden = true;
    session.dataSendToOthers?.(ServerResponse.deleteOb(bot.fetchId()), bot);
}

function request(session, playerSession, itemSelfId, requestedAmount) {
    const bot = session?.actor;
    const player = playerSession?.actor;
    const selfId = Number(itemSelfId || 0);
    const amount = Math.floor(Number(requestedAmount || 0));
    if (!bot || !player || session.partyCompanion !== true || session.followPlayerSession !== playerSession) {
        return { ok: false, reason: 'not_a_party_companion' };
    }
    if (!itemTemplate(selfId)) return { ok: false, reason: 'unsupported_supply_item' };
    if (amount < 1 || amount > MAX_REQUEST_AMOUNT) return { ok: false, reason: 'invalid_supply_amount' };
    if (session.companionShopping || session.pendingResourceDelivery || session.activeTrade) {
        return { ok: false, reason: 'supply_errand_active' };
    }

    const Market = MarketOpportunity.bestSupplyOffer(selfId);
    if (!Market) return { ok: false, reason: 'supply_not_available' };

    const template = itemTemplate(selfId);
    // Unknown metadata is treated as non-stackable.  That prevents an armor,
    // weapon, or quest object from being requested in a quantity that the
    // native inventory path cannot represent.
    const stackable = template?.etc?.stackable === true;
    if (!stackable && amount !== 1) return { ok: false, reason: 'non_stackable_supply_amount' };

    const cost = Number(Market.price) * amount;
    const adena = actorAdena(bot);
    if (cost <= 0) return { ok: false, reason: 'supply_price_invalid' };
    if (adena < cost) return { ok: false, reason: 'not_enough_adena', cost, adena, itemName: Market.itemName };

    const BotAI = invoke('GameServer/Bot/BotAI');
    const town = townDestination(Market, bot, BotAI);
    if (!town) return { ok: false, reason: 'supply_destination_missing' };

    // Do this check before touching the combat target, automation, visibility,
    // or shopping state.  BotTownTravel performs the same guard, but by that
    // point the errand must not have disturbed an active fight.
    const TownTravel = invoke('GameServer/Bot/AI/BotTownTravel');
    if (TownTravel.inCombat(session, bot)) {
        return { ok: false, reason: 'unsafe_combat_state' };
    }

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
        itemName: Market.itemName,
        amount,
        unitPrice: Number(Market.price),
        totalCost: cost,
        sourceType: Market.sourceType,
        sourceId: Market.sourceId,
        target: {
            actorId: Market.sourceType === 'private_store' ? Number(Market.sourceId) : null,
            name: Market.sourceName || `${town.name} general shop`,
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

    // Hide the actor before the escape cast. The actual movement and purchase
    // remain server-side; only the final return and native trade are visible.
    hideForSupply(session, bot);
    const travel = TownTravel.request(
        session,
        bot,
        BotAI,
        null,
        {
            allowCompanion: true,
            preserveShoppingTarget: true,
            destinationTown: town,
            forceScrollOfEscape: true,
            announce: false
        }
    );
    if (travel === 'deferred') {
        TownTravel.clearCombatTrip(session);
        session.companionShopping = undefined;
        session.shoppingTarget = undefined;
        session.resumeAfterShopping = undefined;
        session.supplyErrandHidden = false;
        session.dataSendToOthers?.(ServerResponse.charInfo(bot), bot);
        session.dataSendToOthers?.(ServerResponse.relationChanged(bot), bot);
        return { ok: false, reason: 'unsafe_combat_state' };
    }
    return {
        ok: true,
        outcome: 'pending',
        reason: 'supply_errand_started',
        itemSelfId: selfId,
        itemName: Market.itemName,
        amount,
        cost,
        town: town.name,
        sourceType: Market.sourceType,
        travel
    };
}

async function purchaseAtDestination(bot, errand) {
    if (!errand || !bot) return { ok: false, reason: 'missing_supply_errand' };
    if (!['npc', 'configured_store'].includes(errand.sourceType)) {
        return { ok: false, reason: 'supply_source_unavailable' };
    }

    const store = {
        storeType: 1,
        items: [{
            selfId: Number(errand.itemId),
            price: Number(errand.unitPrice),
            count: Number(errand.amount)
        }]
    };
    try {
        const bought = await TradeService.buyFromStore(bot, store, Number(errand.itemId), Number(errand.amount));
        if (Number(bought.qty) !== Number(errand.amount)) {
            return { ok: false, reason: 'purchase_quantity_mismatch', bought };
        }
        const item = bot.backpack?.fetchItemFromSelfId?.(Number(errand.itemId));
        if (!item) return { ok: false, reason: 'purchase_inventory_sync_failed' };
        return {
            ok: true,
            delta: Number(bought.qty),
            cost: Number(bought.totalAdena),
            item
        };
    } catch (error) {
        const message = String(error?.message || error || 'purchase_failed');
        return { ok: false, reason: /not enough adena/i.test(message) ? 'not_enough_adena' : message };
    }
}

module.exports = {
    MAX_REQUEST_AMOUNT,
    actorAdena,
    itemTemplate,
    purchaseAtDestination,
    request
};
