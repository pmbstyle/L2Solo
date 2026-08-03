const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const ServerResponse = invoke('GameServer/Network/Response');
const SpeckMath = invoke('GameServer/SpeckMath');

const TRADE_RANGE = 1500;
const TRADE_TTL_MS = 2 * 60 * 1000;
const COMPLETION_REPLAY_TTL_MS = 15 * 1000;
const MAX_TRADE_LINES = 8;
const MAX_ITEM_AMOUNT = 10000;
const MAX_BOT_GIFT_UNITS = 5000;
const MAX_INVENTORY_ITEMS = 80;
const MIN_ADENA_RETAIN = 1000;
let tradeSequence = 0;

function now() {
    return Date.now();
}

function itemTemplate(selfId) {
    return DataCache.items.find((ob) => Number(ob.selfId) === Number(selfId));
}

function isBotSession(session) {
    return session && (session.constructor.name === 'BotSession' || (session.accountId && String(session.accountId).startsWith('bot_')));
}

function isRealPlayerSession(session) {
    return !!session?.actor && !isBotSession(session) && session.actor.fetchIsOnline?.() !== false;
}

function actorName(session) {
    return session?.actor?.fetchName?.() || session?.accountId || 'unknown';
}

function actorDistance(a, b) {
    return new SpeckMath.Point3D(a.fetchLocX(), a.fetchLocY(), a.fetchLocZ())
        .distance(new SpeckMath.Point3D(b.fetchLocX(), b.fetchLocY(), b.fetchLocZ()));
}

function lineFor(item, count) {
    return {
        item,
        count: Math.max(1, Math.floor(Number(count) || 1)),
        objectId: Number(item.fetchId()),
        selfId: Number(item.fetchSelfId()),
        name: item.fetchName(),
        stackable: !!item.fetchStackable?.(),
        slot: Number(item.fetchSlot?.() || 0),
        petData: item.fetchPetData?.() || null
    };
}

function resolveInventoryItem(backpack, identifier) {
    const id = Number(identifier);
    if (!backpack || !Number.isInteger(id) || id <= 0) return null;
    const direct = backpack.fetchItemRaw?.(id);
    if (direct) return direct;
    const candidates = (backpack.fetchItems?.() || [])
        .filter((item) => Number(item.fetchSelfId?.()) === id);
    return candidates.length === 1 ? candidates[0] : null;
}

function isSafeOfferItem(item) {
    if (!item || item.fetchEquipped?.()) return false;
    const kind = String(item.fetchKind?.() || '');
    if (kind === 'Other.Quest' || kind.endsWith('.Quest')) return false;
    if (item.model?.quest === true || item.model?.reserved === true) return false;
    return Number(item.fetchAmount?.() || 0) > 0;
}

function minimumRetain(item) {
    return Number(item.fetchSelfId?.() || 0) === 57 ? MIN_ADENA_RETAIN : 0;
}

function botReservations(session) {
    if (!session.botTradeReservations) session.botTradeReservations = new Map();
    return session.botTradeReservations;
}

function botGiftLedger(session) {
    const ledger = session.botTradeGiftLedger;
    if (!ledger || now() - Number(ledger.startedAt || 0) >= 60 * 60 * 1000) {
        session.botTradeGiftLedger = { startedAt: now(), units: 0 };
    }
    return session.botTradeGiftLedger;
}

function releaseReservations(trade) {
    const bot = trade?.botSession;
    if (!bot) return;
    const reservations = botReservations(bot);
    for (const [objectId, reservation] of reservations.entries()) {
        if (reservation.tradeId === trade.id) reservations.delete(objectId);
    }
}

function clearAttachedTrade(trade) {
    if (!trade) return;
    releaseReservations(trade);
    if (trade.playerSession?.activeTrade === trade) trade.playerSession.activeTrade = null;
    if (trade.botSession?.activeTrade === trade) trade.botSession.activeTrade = null;
}

function sendToPlayer(trade, packet) {
    if (trade?.playerSession?.dataSendToMe) trade.playerSession.dataSendToMe(packet);
}

function cancelTrade(trade, reason = 'cancelled', notify = true) {
    if (!trade || ['cancelled', 'committed'].includes(trade.state)) return false;
    trade.state = 'cancelled';
    trade.cancelReason = reason;
    if (trade.negotiationId) {
        try { invoke('GameServer/Bot/Economy/BotNegotiationService').cancelForTrade(trade, reason); } catch (_) { /* optional negotiation module */ }
    }
    releaseReservations(trade);
    if (notify) sendToPlayer(trade, ServerResponse.tradeDone(false));
    clearAttachedTrade(trade);
    return true;
}

function tradeIsOpen(trade) {
    if (!trade || trade.state !== 'open') return false;
    if (Number(trade.expiresAt || 0) <= now()) {
        cancelTrade(trade, 'expired');
        return false;
    }
    if (!trade.playerSession?.actor || !trade.botSession?.actor) {
        cancelTrade(trade, 'missing_actor');
        return false;
    }
    if (trade.playerSession.actor.fetchIsOnline?.() === false || trade.botSession.actor.fetchIsOnline?.() === false) {
        cancelTrade(trade, 'disconnected');
        return false;
    }
    if (trade.botSession.actor.isDead?.() || actorDistance(trade.playerSession.actor, trade.botSession.actor) > TRADE_RANGE) {
        cancelTrade(trade, 'state_changed');
        return false;
    }
    return true;
}

function activeTradeFor(session) {
    const trade = session?.activeTrade;
    if (!tradeIsOpen(trade)) return null;
    return trade;
}

function attachTrade(trade) {
    trade.playerSession.activeTrade = trade;
    trade.botSession.activeTrade = trade;
}

function createTrade(playerSession, botSession, direction) {
    return {
        id: `bot-trade-${++tradeSequence}`,
        direction,
        playerSession,
        botSession,
        playerItems: new Map(),
        botItems: new Map(),
        playerConfirmed: false,
        botConfirmed: false,
        state: 'open',
        createdAt: now(),
        expiresAt: now() + TRADE_TTL_MS
    };
}

function canStart(playerSession, botSession, { allowMerchant = false } = {}) {
    if (!isRealPlayerSession(playerSession) || !isBotSession(botSession) || !botSession.actor) return 'invalid_target';
    if (botSession.plan === 'merchant' && !allowMerchant) return 'merchant_store';
    if (actorDistance(playerSession.actor, botSession.actor) > TRADE_RANGE) return 'too_far';
    return null;
}

function startPlayerTrade(playerSession, targetSession) {
    const reason = canStart(playerSession, targetSession);
    if (reason) return { ok: false, reason };
    cancel(playerSession, 'replaced', false);
    cancel(targetSession, 'replaced', false);

    const trade = createTrade(playerSession, targetSession, 'player_inbound');
    attachTrade(trade);
    console.info("BotTrade :: %s opened trade with %s", actorName(playerSession), actorName(targetSession));
    return { ok: true, trade };
}

function openBotTrade(botSession, playerSession, negotiation = null) {
    const reason = canStart(playerSession, botSession, { allowMerchant: !!negotiation });
    if (reason) return { ok: false, reason };
    if (!negotiation && (botSession.partyCompanion !== true || botSession.followPlayerSession !== playerSession)) {
        return { ok: false, reason: 'not_authorized_relationship' };
    }
    if (negotiation && (negotiation.botSession !== botSession || negotiation.playerSession !== playerSession || negotiation.state !== 'accepted')) {
        return { ok: false, reason: 'negotiation_not_ready' };
    }
    if (negotiation && (activeTradeFor(playerSession) || activeTradeFor(botSession))) {
        return { ok: false, reason: 'trade_active' };
    }

    cancel(playerSession, 'replaced', false);
    cancel(botSession, 'replaced', false);
    const trade = createTrade(playerSession, botSession, 'bot_outbound');
    if (negotiation) {
        trade.negotiationId = negotiation.id;
        trade.expectedNegotiatedItem = { objectId: negotiation.itemObjectId, count: negotiation.quantity };
        trade.expectedAdena = negotiation.agreedTotalPrice;
    }
    attachTrade(trade);
    if (playerSession.dataSendToMe) {
        playerSession.dataSendToMe(ServerResponse.tradeStart(
            botSession.actor,
            playerSession.actor.backpack.fetchItems()
        ));
    }
    console.info("BotTrade :: %s opened outbound trade with %s", actorName(botSession), actorName(playerSession));
    if (negotiation) {
        const offered = offerBotItem(botSession, negotiation.itemObjectId, negotiation.quantity);
        if (!offered.ok) {
            cancelTrade(trade, offered.reason, true);
            return { ok: false, reason: offered.reason };
        }
    }
    return { ok: true, trade };
}

function startBotTrade(botSession, playerSession) {
    return openBotTrade(botSession, playerSession);
}

function startNegotiatedTrade(botSession, playerSession, negotiation) {
    return openBotTrade(botSession, playerSession, negotiation);
}

function lineMapFor(trade, session) {
    return session === trade.botSession ? trade.botItems : trade.playerItems;
}

function addPlayerItem(playerSession, objectId, amount) {
    const trade = activeTradeFor(playerSession);
    if (!trade || trade.playerSession !== playerSession) return { ok: false, reason: 'no_active_trade' };
    const item = playerSession.actor.backpack.fetchItemRaw(objectId);
    if (!isSafeOfferItem(item)) return { ok: false, reason: 'item_not_tradable' };
    const current = trade.playerItems.get(Number(objectId));
    if (!current && trade.playerItems.size >= MAX_TRADE_LINES) return { ok: false, reason: 'trade_line_limit' };
    const qty = Math.max(1, Math.min(MAX_ITEM_AMOUNT, Math.floor(Number(amount) || 1)));
    const nextCount = Math.min(item.fetchAmount(), (current?.count || 0) + qty);
    if (nextCount <= 0 || nextCount + minimumRetain(item) > Number(item.fetchAmount())) return { ok: false, reason: 'insufficient_item' };
    const line = lineFor(item, nextCount);
    trade.playerItems.set(Number(objectId), line);
    trade.playerConfirmed = false;
    console.info("BotTrade :: %s offered %d %s", actorName(playerSession), line.count, item.fetchName());
    return { ok: true, line };
}

function offerBotItem(botSession, objectId, amount) {
    const trade = activeTradeFor(botSession);
    if (!trade || trade.botSession !== botSession) return { ok: false, reason: 'no_active_trade' };
    const item = resolveInventoryItem(botSession.actor.backpack, objectId);
    if (!isSafeOfferItem(item)) return { ok: false, reason: 'item_not_tradable' };
    const canonicalObjectId = Number(item.fetchId());
    const current = trade.botItems.get(canonicalObjectId);
    if (!current && trade.botItems.size >= MAX_TRADE_LINES) return { ok: false, reason: 'trade_line_limit' };

    const requested = Math.max(1, Math.min(MAX_ITEM_AMOUNT, Math.floor(Number(amount) || 1)));
    const reservations = botReservations(botSession);
    const previousReservation = reservations.get(canonicalObjectId);
    if (previousReservation && previousReservation.tradeId !== trade.id) {
        return { ok: false, reason: 'insufficient_item' };
    }
    const alreadyReserved = previousReservation?.tradeId === trade.id ? Number(previousReservation.count || 0) : 0;
    const available = Number(item.fetchAmount()) - alreadyReserved + (current?.count || 0);
    // Bot tools use an absolute desired quantity; the native player packet
    // path still accumulates additions in addPlayerItem above.
    const nextCount = Math.min(available, requested);
    if (nextCount <= 0 || nextCount + minimumRetain(item) > Number(item.fetchAmount())) {
        return { ok: false, reason: 'insufficient_item' };
    }

    const ledger = botGiftLedger(botSession);
    const delta = Math.max(0, nextCount - (current?.count || 0));
    if (ledger.units + delta > MAX_BOT_GIFT_UNITS) return { ok: false, reason: 'gift_budget_exceeded' };
    ledger.units += delta;
    const line = lineFor(item, nextCount);
    trade.botItems.set(canonicalObjectId, line);
    reservations.set(canonicalObjectId, { tradeId: trade.id, count: nextCount });
    trade.botConfirmed = false;
    sendToPlayer(trade, ServerResponse.tradeOtherAdd(line));
    console.info("BotTrade :: %s offered %d %s to %s", actorName(botSession), line.count, item.fetchName(), actorName(trade.playerSession));
    return { ok: true, line };
}

function updateOffer(session, objectId, amount) {
    if (isBotSession(session)) return offerBotItem(session, objectId, amount);
    return addPlayerItem(session, objectId, amount);
}

function validateLine(trade, session, line, { botSide = false } = {}) {
    const liveItem = session.actor.backpack.fetchItemRaw(line.objectId);
    if (!isSafeOfferItem(liveItem) || Number(liveItem.fetchSelfId()) !== Number(line.selfId)) return { ok: false, reason: 'item_changed' };
    if (Number(liveItem.fetchAmount()) < Number(line.count)) return { ok: false, reason: 'item_changed' };
    if (Number(liveItem.fetchAmount()) - Number(line.count) < minimumRetain(liveItem)) return { ok: false, reason: 'retain_minimum' };
    if (botSide) {
        const reservation = botReservations(session).get(line.objectId);
        if (!reservation || reservation.tradeId !== trade.id || Number(reservation.count) !== Number(line.count)) return { ok: false, reason: 'reservation_lost' };
    }
    return { ok: true, item: liveItem };
}

function incomingSlots(session, outgoingLines) {
    const inventory = session.actor.backpack.fetchItems();
    const existingSelfIds = new Set(inventory.filter((item) => item.fetchStackable?.()).map((item) => Number(item.fetchSelfId())));
    const incomingNew = outgoingLines.filter((line) => !line.stackable && !existingSelfIds.has(Number(line.selfId))).length;
    return inventory.length + incomingNew <= MAX_INVENTORY_ITEMS;
}

function transferEntries(trade) {
    const entries = [];
    for (const line of trade.playerItems.values()) {
        entries.push({
            direction: 'player_to_bot',
            fromSession: trade.playerSession,
            toSession: trade.botSession,
            line
        });
    }
    for (const line of trade.botItems.values()) {
        entries.push({
            direction: 'bot_to_player',
            fromSession: trade.botSession,
            toSession: trade.playerSession,
            line
        });
    }
    return entries;
}

function applyLocalTransfers(moved, entries) {
    const byKey = new Map(entries.map((entry) => [`${entry.fromSession.actor.fetchId()}:${entry.line.objectId}`, entry]));
    moved.forEach((record) => {
        const entry = byKey.get(`${record.fromCharacterId}:${record.sourceItemId}`);
        if (!entry) return;
        const sourceItems = entry.fromSession.actor.backpack.items || entry.fromSession.actor.backpack.fetchItems();
        const sourceItem = sourceItems.find((item) => Number(item.fetchId()) === Number(record.sourceItemId));
        if (sourceItem) {
            if (Number(record.remaining) > 0) sourceItem.setAmount(Number(record.remaining));
            else entry.fromSession.actor.backpack.items = sourceItems.filter((item) => Number(item.fetchId()) !== Number(record.sourceItemId));
        }

        const targetBackpack = entry.toSession.actor.backpack;
        const existing = entry.line.stackable
            ? targetBackpack.fetchItemFromSelfId?.(entry.line.selfId)
            : null;
        if (existing) existing.setAmount(Number(existing.fetchAmount()) + Number(entry.line.count));
        else if (targetBackpack.insertItem) {
            targetBackpack.insertItem(Number(record.targetItemId), entry.line.selfId, {
                name: entry.line.name,
                amount: entry.line.count,
                equipped: false,
                slot: entry.line.slot,
                petData: entry.line.petData
            });
        }
    });
}

function publicMoved(entries) {
    return entries.map((entry) => ({
        selfId: entry.line.selfId,
        name: entry.line.name,
        count: entry.line.count,
        direction: entry.direction
    }));
}

async function commit(playerSession) {
    const replay = playerSession?.lastBotTradeCompletion;
    if (!playerSession?.activeTrade && replay && now() - Number(replay.completedAt || 0) <= COMPLETION_REPLAY_TTL_MS) {
        return { ...replay.result, idempotent: true };
    }

    const trade = activeTradeFor(playerSession);
    if (!trade || trade.playerSession !== playerSession) return { ok: false, reason: 'no_active_trade' };
    if (trade.playerItems.size === 0 && trade.botItems.size === 0) return { ok: false, reason: 'empty_or_invalid_trade' };

    if (trade.negotiationId) {
        const validation = invoke('GameServer/Bot/Economy/BotNegotiationService').validateTrade(trade);
        if (!validation.ok) return validation;
    }

    const entries = transferEntries(trade);
    for (const entry of entries) {
        const validation = validateLine(trade, entry.fromSession, entry.line, { botSide: entry.fromSession === trade.botSession });
        if (!validation.ok) return validation;
    }
    if (!incomingSlots(trade.playerSession, [...trade.botItems.values()]) || !incomingSlots(trade.botSession, [...trade.playerItems.values()])) {
        return { ok: false, reason: 'inventory_capacity' };
    }

    const databaseTransfers = entries.map((entry) => ({
        fromCharacterId: entry.fromSession.actor.fetchId(),
        toCharacterId: entry.toSession.actor.fetchId(),
        sourceItemId: entry.line.objectId,
        selfId: entry.line.selfId,
        amount: entry.line.count,
        stackable: entry.line.stackable,
        name: entry.line.name,
        slot: entry.line.slot,
        petData: entry.line.petData
    }));

    let moved;
    try {
        moved = await Database.transferInventoryBetweenCharacters(databaseTransfers);
    } catch (error) {
        return { ok: false, reason: 'database_failed', error };
    }

    applyLocalTransfers(moved, entries);
    trade.state = 'committed';
    trade.playerConfirmed = true;
    trade.botConfirmed = true;
    trade.completedAt = now();
    const result = {
        ok: true,
        tradeId: trade.id,
        direction: trade.direction,
        negotiationId: trade.negotiationId || null,
        partnerSession: trade.botSession,
        moved: publicMoved(entries)
    };
    if (trade.negotiationId) {
        try { invoke('GameServer/Bot/Economy/BotNegotiationService').completeTrade(trade); } catch (_) { /* optional negotiation module */ }
    }
    releaseReservations(trade);
    clearAttachedTrade(trade);
    // Keep replay data serializable and detached from live session graphs.
    playerSession.lastBotTradeCompletion = {
        completedAt: trade.completedAt,
        result: { ...result, partnerSession: null }
    };
    return result;
}

function cancel(session, reason = 'cancelled', notify = true) {
    const trade = session?.activeTrade;
    return cancelTrade(trade, reason, notify);
}

function cleanup(session, reason = 'lifecycle') {
    const cancelled = cancel(session, reason, true);
    if (cancelled) return true;
    try { return invoke('GameServer/Bot/Economy/BotNegotiationService').cleanup(session, reason); } catch (_) { return false; }
}

function activeTradeSummary(session) {
    const trade = activeTradeFor(session);
    if (!trade) return null;
    const lineSummary = (line) => ({ objectId: line.objectId, selfId: line.selfId, name: line.name, count: line.count });
    return {
        id: trade.id,
        direction: trade.direction,
        negotiationId: trade.negotiationId || null,
        expectedAdena: trade.expectedAdena || null,
        createdAt: trade.createdAt,
        expiresAt: trade.expiresAt,
        playerConfirmed: trade.playerConfirmed,
        botConfirmed: trade.botConfirmed,
        playerItems: [...trade.playerItems.values()].map(lineSummary),
        botItems: [...trade.botItems.values()].map(lineSummary)
    };
}

module.exports = {
    MAX_BOT_GIFT_UNITS,
    MAX_ITEM_AMOUNT,
    MAX_TRADE_LINES,
    TRADE_RANGE,
    TRADE_TTL_MS,
    activeTradeSummary,
    resolveInventoryItem,
    addItem: addPlayerItem,
    cancel,
    cleanup,
    commit,
    isTradableItem: isSafeOfferItem,
    offerBotItem,
    startNegotiatedTrade,
    startBotTrade,
    startPlayerTrade,
    updateOffer
};
