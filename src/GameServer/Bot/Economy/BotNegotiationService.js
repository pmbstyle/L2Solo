const crypto = require('crypto');
const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const BotEconomyPricing = invoke('GameServer/Bot/Economy/BotEconomyPricing');
const BotPersona = invoke('GameServer/Bot/AI/BotPersona');
const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
const BotToolAudit = invoke('GameServer/Bot/AI/BotToolAudit');

const NEGOTIATION_TTL_MS = 90 * 1000;
const MAX_ROUNDS = 3;
const MAX_QUANTITY = 100;
const MAX_UNIT_PRICE = 10_000_000;
const NEGOTIABLE_BOT_PLANS = new Set(['merchant', 'following']);

const negotiations = new Map();
let sequence = 0;

function now() { return Date.now(); }

function enabled() {
    return options.default.OpenRouter?.negotiationEnabled === true;
}

function actorId(session) { return Number(session?.actor?.fetchId?.() || 0); }
function actorName(session) { return session?.actor?.fetchName?.() || session?.accountId || 'unknown'; }

function negotiationId(bot, player) {
    sequence += 1;
    const suffix = typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `negotiation-${actorId(bot)}-${actorId(player)}-${suffix}-${sequence}`;
}
function isBot(session) { return !!session?.accountId && String(session.accountId).startsWith('bot_'); }
function isPlayer(session) { return !!session?.actor && !isBot(session) && session.actor.fetchIsOnline?.() !== false; }

function distance(a, b) {
    const dx = Number(a.fetchLocX?.() || 0) - Number(b.fetchLocX?.() || 0);
    const dy = Number(a.fetchLocY?.() || 0) - Number(b.fetchLocY?.() || 0);
    const dz = Number(a.fetchLocZ?.() || 0) - Number(b.fetchLocZ?.() || 0);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function templateFor(selfId) {
    return (DataCache.items || []).find((entry) => Number(entry.selfId) === Number(selfId)) || null;
}

function safeItem(item) {
    if (!item || item.fetchEquipped?.()) return false;
    const kind = String(item.fetchKind?.() || '');
    if (Number(item.fetchSelfId?.() || 0) === 57) return false;
    if (kind === 'Other.Quest' || kind.endsWith('.Quest')) return false;
    if (item.model?.quest === true || item.model?.reserved === true) return false;
    return Number(item.fetchAmount?.() || 0) > 0;
}

function relationshipFor(player, bot) {
    const memory = BotSocialMemory.getSnapshot(player, bot) || {};
    const trust = Number(memory.trust || 0);
    const familiarity = Number(memory.familiarity || 0);
    if (trust >= 8) return { name: 'trusted', trust, familiarity, modifier: -0.08 };
    if (trust >= 3 || familiarity >= 5) return { name: 'friendly', trust, familiarity, modifier: -0.04 };
    if (trust <= -5) return { name: 'wary', trust, familiarity, modifier: 0.06 };
    if (familiarity > 0) return { name: 'familiar', trust, familiarity, modifier: -0.01 };
    return { name: 'stranger', trust, familiarity, modifier: 0 };
}

function personaFor(bot) {
    const persona = bot?.persona || BotPersona.generate({ characterId: actorId(bot) });
    const traits = persona?.traits || {};
    return {
        primaryDrive: ['progression', 'wealth', 'social'].includes(persona?.primaryDrive) ? persona.primaryDrive : 'progression',
        traits: {
            caution: Math.max(0, Math.min(1, Number(traits.caution ?? 0.5))),
            ambition: Math.max(0, Math.min(1, Number(traits.ambition ?? 0.5))),
            assertiveness: Math.max(0, Math.min(1, Number(traits.assertiveness ?? 0.5)))
        }
    };
}

function pricePolicy(bot, player, item, quantity) {
    const template = templateFor(item.fetchSelfId());
    const basePrice = Math.max(1, Number(template?.template?.price || item.fetchPrice?.() || item.model?.price || 1));
    const referenceUnitPrice = BotEconomyPricing.scalePrice(basePrice, 1);
    const persona = personaFor(bot);
    const relation = relationshipFor(player, bot);
    const driveModifier = persona.primaryDrive === 'wealth'
        ? 0.06
        : persona.primaryDrive === 'social' ? -0.04 : 0.02;
    const desiredFactor = 1 + driveModifier + relation.modifier + persona.traits.assertiveness * 0.04;
    const minimumFactor = 0.72 + persona.traits.caution * 0.08 + relation.modifier * 0.35;
    const maximumFactor = 1.18 + persona.traits.ambition * 0.10 + persona.traits.assertiveness * 0.08 + Math.max(0, relation.modifier);
    const minimumUnitPrice = Math.max(1, Math.floor(referenceUnitPrice * minimumFactor));
    const maximumUnitPrice = Math.min(MAX_UNIT_PRICE, Math.max(minimumUnitPrice, Math.ceil(referenceUnitPrice * maximumFactor)));
    const desiredUnitPrice = Math.max(minimumUnitPrice, Math.min(maximumUnitPrice, Math.round(referenceUnitPrice * desiredFactor)));
    const rationale = relation.name === 'trusted'
        ? 'I can offer my trusted companion a meaningful discount.'
        : relation.name === 'friendly'
            ? 'I can make a small discount for a familiar ally.'
            : relation.name === 'wary'
                ? 'I need to keep a little margin until we know each other better.'
                : persona.primaryDrive === 'wealth'
                    ? 'I am protecting the value of my stock.'
                    : 'I am using a steady market reference for this item.';

    return {
        baseUnitPrice: basePrice,
        referenceUnitPrice,
        desiredUnitPrice,
        minimumUnitPrice,
        maximumUnitPrice,
        quantity,
        relation: relation.name,
        rationale,
        // Keep the factors server-owned; they are not model-controlled inputs.
        policyVersion: 1
    };
}

function summary(negotiation) {
    if (!negotiation) return null;
    return {
        id: negotiation.id,
        state: negotiation.state,
        itemObjectId: negotiation.itemObjectId,
        itemSelfId: negotiation.itemSelfId,
        itemName: negotiation.itemName,
        quantity: negotiation.quantity,
        referenceUnitPrice: negotiation.referenceUnitPrice,
        desiredUnitPrice: negotiation.desiredUnitPrice,
        minimumUnitPrice: negotiation.minimumUnitPrice,
        maximumUnitPrice: negotiation.maximumUnitPrice,
        currentUnitPrice: negotiation.currentUnitPrice,
        currentTotalPrice: negotiation.currentUnitPrice * negotiation.quantity,
        agreedTotalPrice: negotiation.agreedTotalPrice || null,
        round: negotiation.round,
        maxRounds: MAX_ROUNDS,
        createdAt: negotiation.createdAt,
        expiresAt: negotiation.expiresAt,
        relation: negotiation.relation,
        rationale: negotiation.rationale,
        botName: actorName(negotiation.botSession),
        playerName: actorName(negotiation.playerSession)
    };
}

function persist(negotiation) {
    if (!Database.isReady?.() || !actorId(negotiation.botSession)) return Promise.resolve(false);
    return Database.execute([
        `INSERT INTO bot_negotiations (
            id, playerId, botId, itemObjectId, itemSelfId, amount,
            referenceUnitPrice, desiredUnitPrice, minimumUnitPrice, maximumUnitPrice,
            currentUnitPrice, agreedTotalPrice, round, state, createdAt, expiresAt, updatedAt, reason, metaJson
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            currentUnitPrice = excluded.currentUnitPrice,
            agreedTotalPrice = excluded.agreedTotalPrice,
            round = excluded.round,
            state = excluded.state,
            expiresAt = excluded.expiresAt,
            updatedAt = excluded.updatedAt,
            reason = excluded.reason,
            metaJson = excluded.metaJson`,
        [
            negotiation.id,
            actorId(negotiation.playerSession),
            actorId(negotiation.botSession),
            negotiation.itemObjectId,
            negotiation.itemSelfId,
            negotiation.quantity,
            negotiation.referenceUnitPrice,
            negotiation.desiredUnitPrice,
            negotiation.minimumUnitPrice,
            negotiation.maximumUnitPrice,
            negotiation.currentUnitPrice,
            negotiation.agreedTotalPrice || null,
            negotiation.round,
            negotiation.state,
            negotiation.createdAt,
            negotiation.expiresAt,
            now(),
            negotiation.reason || '',
            JSON.stringify({ relation: negotiation.relation, policyVersion: negotiation.policyVersion }).slice(0, 1200)
        ]
    ], 'bot-negotiation:upsert').then(() => true).catch(() => false);
}

function audit(negotiation, outcome, reason, meta = {}) {
    BotToolAudit.record({
        playerId: actorId(negotiation.playerSession),
        botId: actorId(negotiation.botSession),
        turnId: `negotiation:${negotiation.id}`,
        toolName: 'negotiation',
        outcome,
        reason,
        meta: { negotiationId: negotiation.id, ...meta }
    }).catch(() => {});
}

function journal(negotiation, event, detail) {
    const BotEventJournal = invoke('GameServer/Bot/AI/BotEventJournal');
    Promise.resolve(BotEventJournal.record({
        playerId: actorId(negotiation.playerSession),
        botId: actorId(negotiation.botSession),
        eventType: `negotiation_${event}`,
        summary: detail,
        weight: event === 'completed' ? 5 : 2,
        dedupeKey: `${negotiation.id}:${event}`,
        meta: { itemSelfId: negotiation.itemSelfId, quantity: negotiation.quantity, totalPrice: negotiation.agreedTotalPrice || negotiation.currentUnitPrice * negotiation.quantity }
    })).catch(() => {});
}

function releaseReservation(negotiation) {
    const reservations = negotiation.botSession?.botNegotiationReservations;
    if (reservations?.get(negotiation.itemObjectId)?.negotiationId === negotiation.id) {
        reservations.delete(negotiation.itemObjectId);
    }
}

function clear(negotiation) {
    releaseReservation(negotiation);
    if (negotiation.botSession?.activeNegotiation === negotiation) negotiation.botSession.activeNegotiation = null;
    if (negotiation.playerSession?.activeNegotiation === negotiation) negotiation.playerSession.activeNegotiation = null;
    negotiations.delete(negotiation.id);
}

function setTerminal(negotiation, state, reason) {
    negotiation.state = state;
    negotiation.reason = reason || '';
    persist(negotiation);
    audit(negotiation, state, reason || state);
    journal(negotiation, state, `${actorName(negotiation.botSession)} negotiation ${state}: ${negotiation.itemName} x${negotiation.quantity}.`);
    clear(negotiation);
}

function stockValid(negotiation) {
    const item = negotiation.botSession?.actor?.backpack?.fetchItemRaw?.(negotiation.itemObjectId);
    return safeItem(item) && Number(item.fetchSelfId()) === Number(negotiation.itemSelfId) && Number(item.fetchAmount()) >= negotiation.quantity;
}

function activeFor(session) {
    const negotiation = session?.activeNegotiation;
    if (!negotiation) return null;
    if (negotiation.state === 'open' || negotiation.state === 'countered' || negotiation.state === 'accepted') {
        if (negotiation.expiresAt <= now()) {
            setTerminal(negotiation, 'expired', 'ttl_expired');
            return null;
        }
        if (!stockValid(negotiation)) {
            setTerminal(negotiation, 'expired', 'stock_changed');
            return null;
        }
    }
    return negotiation;
}

function canAccess(bot, player) {
    if (!isBot(bot) || !isPlayer(player) || !bot.actor) return 'invalid_pair';
    if (!NEGOTIABLE_BOT_PLANS.has(bot.plan) && bot.partyCompanion !== true) return 'bot_not_trading';
    if (bot.partyCompanion === true && bot.followPlayerSession !== player) return 'not_authorized_relationship';
    if (distance(bot.actor, player.actor) > 1500) return 'too_far';
    return null;
}

function quoteItem(bot, player, itemObjectId, amount = 1) {
    if (!enabled()) return { ok: false, reason: 'negotiation_disabled' };
    const access = canAccess(bot, player);
    if (access) return { ok: false, reason: access };
    if (activeFor(bot)) return { ok: false, reason: 'negotiation_active' };
    const item = bot.actor.backpack.fetchItemRaw(Number(itemObjectId));
    if (!safeItem(item)) return { ok: false, reason: 'item_not_negotiable' };
    const quantity = Math.max(1, Math.min(MAX_QUANTITY, Math.floor(Number(amount) || 1)));
    const reservations = bot.botNegotiationReservations || (bot.botNegotiationReservations = new Map());
    const reservation = reservations.get(Number(itemObjectId));
    if (reservation) return { ok: false, reason: 'stock_reserved' };
    if (Number(item.fetchAmount()) < quantity) return { ok: false, reason: 'insufficient_stock' };

    const policy = pricePolicy(bot, player, item, quantity);
    const negotiation = {
        id: negotiationId(bot, player),
        botSession: bot,
        playerSession: player,
        itemObjectId: Number(itemObjectId),
        itemSelfId: Number(item.fetchSelfId()),
        itemName: item.fetchName(),
        quantity,
        ...policy,
        currentUnitPrice: policy.desiredUnitPrice,
        agreedTotalPrice: null,
        round: 0,
        state: 'open',
        reason: 'quoted',
        createdAt: now(),
        expiresAt: now() + NEGOTIATION_TTL_MS
    };
    reservations.set(negotiation.itemObjectId, { negotiationId: negotiation.id, count: quantity });
    negotiations.set(negotiation.id, negotiation);
    bot.activeNegotiation = negotiation;
    player.activeNegotiation = negotiation;
    persist(negotiation);
    audit(negotiation, 'proposed', 'quote_created', { currentTotalPrice: negotiation.currentUnitPrice * quantity });
    journal(negotiation, 'proposed', `${actorName(bot)} quoted ${negotiation.itemName} x${quantity}.`);
    return { ok: true, negotiation: summary(negotiation) };
}

function counterOffer(bot, player, totalPrice) {
    const negotiation = activeFor(bot);
    if (!negotiation || negotiation.playerSession !== player) return { ok: false, reason: 'no_active_negotiation' };
    if (negotiation.state === 'accepted' || negotiation.state === 'trade_open') return { ok: false, reason: 'price_already_accepted' };
    if (negotiation.round >= MAX_ROUNDS) return { ok: false, reason: 'round_limit' };
    const total = Math.floor(Number(totalPrice));
    const minTotal = negotiation.minimumUnitPrice * negotiation.quantity;
    const maxTotal = negotiation.maximumUnitPrice * negotiation.quantity;
    if (!Number.isSafeInteger(total) || total < minTotal || total > maxTotal) {
        audit(negotiation, 'rejected', 'price_out_of_bounds', { requestedTotalPrice: totalPrice, minTotal, maxTotal });
        return { ok: false, reason: 'price_out_of_bounds', negotiation: summary(negotiation) };
    }
    if (total % negotiation.quantity !== 0) return { ok: false, reason: 'price_must_be_whole_unit' };
    negotiation.currentUnitPrice = total / negotiation.quantity;
    negotiation.round += 1;
    negotiation.state = 'countered';
    negotiation.reason = 'counter_offer';
    persist(negotiation);
    audit(negotiation, 'countered', 'price_countered', { currentTotalPrice: total });
    return { ok: true, negotiation: summary(negotiation) };
}

function acceptPrice(bot, player, totalPrice = null) {
    const negotiation = activeFor(bot);
    if (!negotiation || negotiation.playerSession !== player) return { ok: false, reason: 'no_active_negotiation' };
    if (totalPrice !== null && Math.floor(Number(totalPrice)) !== negotiation.currentUnitPrice * negotiation.quantity) {
        return { ok: false, reason: 'price_mismatch', negotiation: summary(negotiation) };
    }
    negotiation.agreedTotalPrice = negotiation.currentUnitPrice * negotiation.quantity;
    negotiation.state = 'accepted';
    negotiation.reason = 'price_accepted';
    persist(negotiation);
    audit(negotiation, 'accepted', 'price_accepted', { agreedTotalPrice: negotiation.agreedTotalPrice });
    journal(negotiation, 'accepted', `${actorName(bot)} and ${actorName(player)} accepted ${negotiation.agreedTotalPrice} Adena.`);
    return { ok: true, negotiation: summary(negotiation) };
}

function declinePrice(bot, player, reason = 'declined') {
    const negotiation = activeFor(bot);
    if (!negotiation || negotiation.playerSession !== player) return { ok: false, reason: 'no_active_negotiation' };
    const result = summary(negotiation);
    setTerminal(negotiation, 'declined', reason);
    return { ok: true, reason: 'price_declined', negotiation: result };
}

function openNegotiatedTrade(bot, player) {
    const negotiation = activeFor(bot);
    if (!negotiation || negotiation.playerSession !== player) return { ok: false, reason: 'no_active_negotiation' };
    if (negotiation.state !== 'accepted' || !negotiation.agreedTotalPrice) return { ok: false, reason: 'price_not_accepted' };
    const adena = player.actor.backpack.fetchItemFromSelfId?.(57);
    if (!adena || Number(adena.fetchAmount?.() || 0) < negotiation.agreedTotalPrice + 1000) {
        return { ok: false, reason: 'insufficient_funds', negotiation: summary(negotiation) };
    }
    const BotTradeService = invoke('GameServer/Bot/BotTradeService');
    const result = BotTradeService.startNegotiatedTrade(bot, player, negotiation);
    if (!result.ok) return result;
    negotiation.state = 'trade_open';
    negotiation.tradeId = result.trade.id;
    negotiation.reason = 'native_trade_open';
    persist(negotiation);
    audit(negotiation, 'trade_open', 'native_trade_open', { tradeId: negotiation.tradeId });
    return {
        ok: true,
        reason: 'native_trade_open',
        trade: BotTradeService.activeTradeSummary(bot),
        negotiation: summary(negotiation)
    };
}

function validateTrade(trade) {
    const negotiation = negotiations.get(trade?.negotiationId);
    if (!negotiation || negotiation.state !== 'trade_open' || negotiation.tradeId !== trade.id) return { ok: false, reason: 'negotiation_missing' };
    if (!stockValid(negotiation)) return { ok: false, reason: 'stock_changed' };
    const itemLines = [...trade.botItems.values()];
    const adenaLines = [...trade.playerItems.values()].filter((line) => Number(line.selfId) === 57);
    if (itemLines.length !== 1 || itemLines[0].objectId !== negotiation.itemObjectId || itemLines[0].count !== negotiation.quantity) {
        return { ok: false, reason: 'negotiated_item_mismatch' };
    }
    if (trade.playerItems.size !== 1 || adenaLines.length !== 1 || adenaLines[0].count !== negotiation.agreedTotalPrice) {
        return { ok: false, reason: 'negotiated_price_mismatch' };
    }
    return { ok: true, negotiation };
}

function completeTrade(trade) {
    const negotiation = negotiations.get(trade?.negotiationId);
    if (!negotiation) return false;
    negotiation.state = 'completed';
    negotiation.reason = 'trade_completed';
    persist(negotiation);
    audit(negotiation, 'completed', 'trade_completed', { tradeId: trade.id, agreedTotalPrice: negotiation.agreedTotalPrice });
    journal(negotiation, 'completed', `${actorName(negotiation.botSession)} sold ${negotiation.itemName} for ${negotiation.agreedTotalPrice} Adena.`);
    clear(negotiation);
    return true;
}

function cancelForTrade(trade, reason = 'trade_cancelled') {
    const negotiation = negotiations.get(trade?.negotiationId);
    if (!negotiation) return false;
    setTerminal(negotiation, reason === 'expired' ? 'expired' : 'cancelled', reason);
    return true;
}

function cleanup(session, reason = 'lifecycle') {
    const negotiation = activeFor(session);
    if (!negotiation) return false;
    setTerminal(negotiation, reason === 'expired' ? 'expired' : 'cancelled', reason);
    return true;
}

function activeSummary(session) {
    return summary(activeFor(session));
}

module.exports = {
    MAX_QUANTITY,
    MAX_ROUNDS,
    MAX_UNIT_PRICE,
    NEGOTIATION_TTL_MS,
    acceptPrice,
    activeSummary,
    cancelForTrade,
    cleanup,
    counterOffer,
    declinePrice,
    enabled,
    completeTrade,
    openNegotiatedTrade,
    quoteItem,
    reset() {
        negotiations.clear();
        sequence = 0;
    },
    summary,
    validateTrade
};
