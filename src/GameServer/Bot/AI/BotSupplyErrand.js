const DataCache = invoke('GameServer/DataCache');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const TradeService = invoke('GameServer/Bot/TradeService');
const ServerResponse = invoke('GameServer/Network/Response');
const TownPathfinder = invoke('GameServer/Bot/AI/TownPathfinder');
const TownRespawn = invoke('GameServer/World/TownRespawn');
const WorkflowTelemetry = invoke('GameServer/Bot/AI/BotWorkflowTelemetry');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');

const MAX_REQUEST_AMOUNT = 5000;

function actorAdena(actor) {
    return Number(actor?.backpack?.fetchItemFromSelfId?.(57)?.fetchAmount?.() || 0);
}

function itemTemplate(selfId) {
    return (DataCache.items || []).find((item) => Number(item.selfId) === Number(selfId)) || null;
}

function townDestination(offer, bot, BotAI) {
    if (Number.isFinite(Number(offer?.locX)) && Number.isFinite(Number(offer?.locY)) && Number.isFinite(Number(offer?.locZ))) {
        return { name: offer.town, x: Number(offer.locX), y: Number(offer.locY), z: Number(offer.locZ) };
    }
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

    const Market = MarketOpportunity.bestSupplyOffer(selfId, { amount });
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
    const workflowStartedAt = Date.now();
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
        sourceName: Market.sourceName,
        workflowId: `supply-${bot.fetchId()}-${player.fetchId()}-${workflowStartedAt}-${Math.random().toString(36).slice(2, 8)}`,
        startedAt: workflowStartedAt,
        expiresAt: workflowStartedAt + 10 * 60 * 1000,
        target: {
            actorId: ['private_store', 'configured_store'].includes(Market.sourceType) ? Number(Market.sourceId) || null : null,
            name: Market.sourceName || `${town.name} general shop`,
            locX: Number(Market.locX ?? town.x),
            locY: Number(Market.locY ?? town.y),
            locZ: Number(Market.locZ ?? town.z),
            town: town.name
        }
    };
    session.shoppingTarget = session.companionShopping.target;
    session.shoppingDoneAnnounced = false;
    session.currentTargetId = undefined;
    session.botStay = false;
    bot.unselect?.();
    bot.automation?.abortAll?.(bot);

    // Hide and park the actor before the escape cast. The supply workflow is
    // persisted as cold and the normal AI loop is stopped while it is away;
    // the actor is intentionally retained only as a server-side inventory
    // handle until the destination purchase has completed.
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
            announce: false,
            onArrival: () => {
                session.supplyErrandPhase = 'shopping';
                BotAI.init?.(session);
                BotAI.wakeup?.(session, { urgent: true });
            }
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
    if (travel === 'escape') {
        session.supplyErrandPhase = 'cold';
        BotAI.stop?.(session);
        const workflowId = session.companionShopping.workflowId;
        Promise.resolve().then(() => LifeState.markCold(session, 'supply_errand')).then((state) => {
            if (state && session.companionShopping?.workflowId === workflowId) {
                session.coldLifeState = state;
            }
        }).catch(() => {});
    }
    WorkflowTelemetry.recordSupply(session.companionShopping.workflowId, 'requested', {
        botId: bot.fetchId(),
        playerId: player.fetchId(),
        itemSelfId: selfId,
        amount,
        cost,
        sourceType: Market.sourceType,
        sourceId: Market.sourceId,
        town: town.name,
        travel
    }, 'pending', 'supply_errand_started');
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
        workflowId: session.companionShopping.workflowId,
        travel
    };
}

async function purchaseAtDestination(bot, errand) {
    if (!errand || !bot) return { ok: false, reason: 'missing_supply_errand' };
    if (!['npc', 'configured_store'].includes(errand.sourceType)) {
        return { ok: false, reason: 'supply_source_unavailable' };
    }

    let store = null;
    if (errand.sourceType === 'configured_store') {
        const World = invoke('GameServer/World/World');
        const sessions = World.user?.sessions || [];
        const source = sessions.find((candidate) => {
            const actor = candidate?.actor;
            const candidateStore = actor?.fetchPrivateStore?.();
            return Number(candidateStore?.storeType) === 1 && (
                Number(actor.fetchId?.() || 0) === Number(errand.sourceId) ||
                actor.fetchName?.() === errand.sourceName
            );
        });
        store = source?.actor?.fetchPrivateStore?.() || null;
        const line = store?.items?.find((entry) => Number(entry.selfId) === Number(errand.itemId));
        if (!source || !line) {
            WorkflowTelemetry.recordSupply(errand.workflowId, 'purchase', { botId: bot.fetchId(), itemSelfId: errand.itemId, amount: errand.amount }, 'failed', 'configured_store_unavailable');
            return { ok: false, reason: 'configured_store_unavailable' };
        }
        if (Number(line.count) < Number(errand.amount)) {
            WorkflowTelemetry.recordSupply(errand.workflowId, 'purchase', { botId: bot.fetchId(), itemSelfId: errand.itemId, amount: errand.amount, available: Number(line.count) }, 'rejected', 'configured_store_stock_changed');
            return { ok: false, reason: 'configured_store_stock_changed', available: Number(line.count) };
        }
        if (Number(line.price) !== Number(errand.unitPrice)) {
            WorkflowTelemetry.recordSupply(errand.workflowId, 'purchase', { botId: bot.fetchId(), itemSelfId: errand.itemId, amount: errand.amount, price: Number(line.price) }, 'rejected', 'configured_store_price_changed');
            return { ok: false, reason: 'configured_store_price_changed', price: Number(line.price) };
        }
    } else {
        store = {
            storeType: 1,
            items: [{
                selfId: Number(errand.itemId),
                price: Number(errand.unitPrice),
                count: Number(errand.amount)
            }]
        };
    }
    try {
        const bought = await TradeService.buyFromStore(bot, store, Number(errand.itemId), Number(errand.amount), {
            expectedUnitPrice: Number(errand.unitPrice)
        });
        if (Number(bought.qty) !== Number(errand.amount)) {
            WorkflowTelemetry.recordSupply(errand.workflowId, 'purchase', {
                botId: bot.fetchId(),
                itemSelfId: errand.itemId,
                amount: Number(bought.qty || 0),
                requestedAmount: Number(errand.amount)
            }, 'failed', 'purchase_quantity_mismatch');
            return { ok: false, reason: 'purchase_quantity_mismatch', bought };
        }
        const item = bot.backpack?.fetchItemFromSelfId?.(Number(errand.itemId));
        if (!item) {
            WorkflowTelemetry.recordSupply(errand.workflowId, 'purchase', { botId: bot.fetchId(), itemSelfId: errand.itemId, amount: errand.amount }, 'failed', 'purchase_inventory_sync_failed');
            return { ok: false, reason: 'purchase_inventory_sync_failed' };
        }
        WorkflowTelemetry.recordSupply(errand.workflowId, 'purchase', {
            botId: bot.fetchId(),
            itemSelfId: errand.itemId,
            amount: Number(bought.qty),
            cost: Number(bought.totalAdena)
        });
        return {
            ok: true,
            delta: Number(bought.qty),
            cost: Number(bought.totalAdena),
            item
        };
    } catch (error) {
        const message = String(error?.message || error || 'purchase_failed');
        WorkflowTelemetry.recordSupply(errand.workflowId, 'purchase', { botId: bot.fetchId(), itemSelfId: errand.itemId, amount: errand.amount }, 'failed', /not enough adena/i.test(message) ? 'not_enough_adena' : message);
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
