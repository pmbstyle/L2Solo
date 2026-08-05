const crypto = require('crypto');
const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const BotEconomyPricing = invoke('GameServer/Bot/Economy/BotEconomyPricing');
const BotPersona = invoke('GameServer/Bot/AI/BotPersona');
const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
const BotToolAudit = invoke('GameServer/Bot/AI/BotToolAudit');
const BotMerchantStoreService = invoke('GameServer/Bot/Economy/BotMerchantStoreService');

const NEGOTIATION_TTL_MS = 90 * 1000;
const MAX_ROUNDS = 3;
const MAX_QUANTITY = 100;
const MAX_UNIT_PRICE = 1_000_000_000;
const NEGOTIABLE_BOT_PLANS = new Set(['merchant', 'following']);

const negotiations = new Map();
let sequence = 0;

function now() { return Date.now(); }

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

function pricePolicy(bot, player, item, quantity, listing = null) {
    const template = templateFor(item.fetchSelfId());
    const basePrice = Math.max(1, Number(template?.template?.price || item.fetchPrice?.() || item.model?.price || 1));
    const listingUnitPrice = Math.max(0, Number(listing?.price || 0));
    const referenceUnitPrice = listingUnitPrice || BotEconomyPricing.scalePrice(basePrice, 1);
    const persona = personaFor(bot);
    const relation = relationshipFor(player, bot);
    if (listingUnitPrice) {
        const driveFloorModifier = persona.primaryDrive === 'wealth'
            ? 0.08
            : persona.primaryDrive === 'social' ? -0.03 : 0.02;
        const minimumFactor = Math.max(0.65, Math.min(0.98,
            0.72 + persona.traits.caution * 0.12 + driveFloorModifier + relation.modifier
        ));
        const desiredFactor = Math.max(0.90, Math.min(1,
            1 + relation.modifier + (persona.primaryDrive === 'social' ? -0.02 : 0)
        ));
        const minimumUnitPrice = Math.max(1, Math.floor(referenceUnitPrice * minimumFactor));
        const desiredUnitPrice = Math.max(minimumUnitPrice, Math.round(referenceUnitPrice * desiredFactor));
        const rationale = relation.name === 'trusted'
            ? 'I can move meaningfully below my listed price for someone I trust.'
            : relation.name === 'friendly'
                ? 'I can make a modest discount from my listed price.'
                : persona.primaryDrive === 'wealth'
                    ? 'I need to protect most of my listed value.'
                    : 'I can negotiate within a bounded discount from my current listing.';
        return {
            baseUnitPrice: basePrice,
            listingUnitPrice,
            referenceUnitPrice,
            desiredUnitPrice,
            minimumUnitPrice,
            maximumUnitPrice: MAX_UNIT_PRICE,
            quantity,
            relation: relation.name,
            rationale,
            policyVersion: 2
        };
    }
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
        storeId: negotiation.storeId || null,
        storeRevision: negotiation.storeRevision || null,
        listingUnitPrice: negotiation.listingUnitPrice || null,
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
    const write = () => Database.execute([
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
            JSON.stringify({
                relation: negotiation.relation,
                policyVersion: negotiation.policyVersion,
                storeId: negotiation.storeId || null,
                storeRevision: negotiation.storeRevision || null,
                listingUnitPrice: negotiation.listingUnitPrice || null
            }).slice(0, 1200)
        ]
    ], 'bot-negotiation:upsert').then(() => true).catch(() => false);
    const pending = Promise.resolve(negotiation.persistPromise).catch(() => false).then(write);
    negotiation.persistPromise = pending;
    return pending;
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
    const item = resolveInventoryItem(negotiation.botSession?.actor?.backpack, negotiation.itemObjectId);
    if (!safeItem(item) || Number(item.fetchSelfId()) !== Number(negotiation.itemSelfId) || Number(item.fetchAmount()) < negotiation.quantity) {
        return false;
    }
    if (!negotiation.storeRevision) return true;
    const store = BotMerchantStoreService.storeFor(negotiation.botSession);
    const line = BotMerchantStoreService.lineFor(store, negotiation.itemSelfId);
    return !!line && Number(line.count || 0) >= negotiation.quantity &&
        BotMerchantStoreService.revision(store) === Number(negotiation.storeRevision);
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

function resolveListedInventoryItem(backpack, selfId) {
    const id = Number(selfId);
    if (!backpack || !Number.isInteger(id) || id <= 0) return null;
    const direct = backpack.fetchItemFromSelfId?.(id);
    if (direct && Number(direct.fetchSelfId?.()) === id) return direct;
    return (backpack.fetchItems?.() || []).find((item) => Number(item.fetchSelfId?.()) === id) || null;
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

function canNegotiateStore(bot) {
    return !!(bot?.coldMarketState?.stats?.marketStore && BotMerchantStoreService.storeFor(bot));
}

function quoteItem(bot, player, itemObjectId, amount = 1, offeredTotalPrice = null) {
    const access = canAccess(bot, player);
    if (access) return { ok: false, reason: access };
    if (activeFor(bot)) return { ok: false, reason: 'negotiation_active' };
    const merchantStore = bot.plan === 'merchant' ? BotMerchantStoreService.storeFor(bot) : null;
    if (bot.plan === 'merchant' && !canNegotiateStore(bot)) return { ok: false, reason: 'merchant_store_unavailable' };
    const listedLine = merchantStore ? BotMerchantStoreService.lineFor(merchantStore, itemObjectId) : null;
    if (merchantStore && !listedLine) return { ok: false, reason: 'item_not_listed' };
    const item = listedLine
        ? resolveListedInventoryItem(bot.actor.backpack, listedLine.selfId)
        : resolveInventoryItem(bot.actor.backpack, itemObjectId);
    if (!safeItem(item)) return { ok: false, reason: 'item_not_negotiable' };
    const canonicalObjectId = Number(item.fetchId());
    const quantity = Math.max(1, Math.min(MAX_QUANTITY, Math.floor(Number(amount) || 1)));
    if (listedLine && Number(listedLine.count || 0) < quantity) return { ok: false, reason: 'insufficient_listed_stock' };
    const reservations = bot.botNegotiationReservations || (bot.botNegotiationReservations = new Map());
    const reservation = merchantStore ? null : reservations.get(canonicalObjectId);
    if (reservation) return { ok: false, reason: 'stock_reserved' };
    if (Number(item.fetchAmount()) < quantity) return { ok: false, reason: 'insufficient_stock' };

    const policy = pricePolicy(bot, player, item, quantity, listedLine);
    let currentUnitPrice = policy.desiredUnitPrice;
    let state = 'open';
    let reason = 'quoted';
    if (offeredTotalPrice !== null && offeredTotalPrice !== undefined) {
        const offeredTotal = Math.floor(Number(offeredTotalPrice));
        if (!Number.isSafeInteger(offeredTotal) || offeredTotal < 1 || offeredTotal % quantity !== 0) {
            return { ok: false, reason: 'price_must_be_whole_unit' };
        }
        const offeredUnitPrice = offeredTotal / quantity;
        if (offeredUnitPrice >= policy.minimumUnitPrice) {
            currentUnitPrice = Math.min(MAX_UNIT_PRICE, offeredUnitPrice);
            reason = 'player_offer_in_range';
        } else {
            state = 'countered';
            reason = 'player_offer_too_low';
        }
    }
    const negotiation = {
        id: negotiationId(bot, player),
        botSession: bot,
        playerSession: player,
        itemObjectId: canonicalObjectId,
        itemSelfId: Number(item.fetchSelfId()),
        itemName: listedLine?.name || item.fetchName(),
        quantity,
        ...policy,
        storeId: merchantStore ? String(bot.coldMarketState.stats.marketStore.id || '') : null,
        storeRevision: merchantStore ? BotMerchantStoreService.revision(merchantStore) : null,
        currentUnitPrice,
        agreedTotalPrice: null,
        round: 0,
        state,
        reason,
        createdAt: now(),
        expiresAt: now() + NEGOTIATION_TTL_MS
    };
    if (!merchantStore) reservations.set(negotiation.itemObjectId, { negotiationId: negotiation.id, count: quantity });
    negotiations.set(negotiation.id, negotiation);
    bot.activeNegotiation = negotiation;
    player.activeNegotiation = negotiation;
    persist(negotiation);
    audit(negotiation, state === 'countered' ? 'countered' : 'proposed', reason, { currentTotalPrice: negotiation.currentUnitPrice * quantity });
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

async function republishAcceptedStore(bot, negotiation) {
    const reopened = await BotMerchantStoreService.republish(bot, {
        storeId: negotiation.storeId,
        storeRevision: negotiation.storeRevision,
        itemSelfId: negotiation.itemSelfId,
        quantity: negotiation.quantity,
        unitPrice: negotiation.currentUnitPrice
    });
    if (!reopened.ok) {
        negotiation.state = 'countered';
        negotiation.reason = reopened.reason;
        negotiation.agreedTotalPrice = null;
        persist(negotiation);
        audit(negotiation, 'rejected', reopened.reason);
        return { ok: false, reason: reopened.reason, negotiation: summary(negotiation) };
    }
    negotiation.state = 'completed';
    negotiation.reason = 'store_reopened';
    const result = summary(negotiation);
    persist(negotiation);
    audit(negotiation, 'completed', 'store_reopened', { storeRevision: reopened.store?.revision });
    journal(negotiation, 'completed', `${actorName(bot)} reopened the store with ${negotiation.itemName} x${negotiation.quantity} at ${negotiation.currentUnitPrice} Adena each.`);
    clear(negotiation);
    return { ok: true, reason: 'store_reopened', negotiation: result, store: reopened.store };
}

function acceptPrice(bot, player, totalPrice = null, itemIdentifier = null, amount = 1) {
    let negotiation = activeFor(bot);
    if (!negotiation && itemIdentifier && totalPrice !== null) {
        const quoted = quoteItem(bot, player, itemIdentifier, amount, totalPrice);
        if (!quoted.ok) return quoted;
        negotiation = activeFor(bot);
    }
    if (!negotiation || negotiation.playerSession !== player) return { ok: false, reason: 'no_active_negotiation' };
    if (totalPrice !== null) {
        const total = Math.floor(Number(totalPrice));
        const minTotal = negotiation.minimumUnitPrice * negotiation.quantity;
        const maxTotal = negotiation.maximumUnitPrice * negotiation.quantity;
        if (!Number.isSafeInteger(total) || total < minTotal || total > maxTotal) {
            return { ok: false, reason: 'price_out_of_bounds', negotiation: summary(negotiation) };
        }
        if (total % negotiation.quantity !== 0) {
            return { ok: false, reason: 'price_must_be_whole_unit', negotiation: summary(negotiation) };
        }
        negotiation.currentUnitPrice = total / negotiation.quantity;
    }
    negotiation.agreedTotalPrice = negotiation.currentUnitPrice * negotiation.quantity;
    negotiation.state = 'accepted';
    negotiation.reason = 'price_accepted';
    persist(negotiation);
    audit(negotiation, 'accepted', 'price_accepted', { agreedTotalPrice: negotiation.agreedTotalPrice });
    journal(negotiation, 'accepted', `${actorName(bot)} and ${actorName(player)} accepted ${negotiation.agreedTotalPrice} Adena.`);
    if (negotiation.storeRevision) {
        return republishAcceptedStore(bot, negotiation);
    }
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
    if (negotiation.storeRevision || bot.plan === 'merchant') return { ok: false, reason: 'merchant_uses_store' };
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

function storeContext(bot, player) {
    const store = BotMerchantStoreService.storeFor(bot);
    if (!store || !canNegotiateStore(bot)) return null;
    const lines = store.items.flatMap((line) => {
        const item = resolveListedInventoryItem(bot.actor?.backpack, line.selfId);
        if (!safeItem(item) || Number(item.fetchAmount()) < 1 || Number(line.count || 0) < 1) return [];
        const policy = pricePolicy(bot, player, item, 1, line);
        return [{
            selfId: Number(line.selfId),
            name: line.name || item.fetchName(),
            count: Math.min(Number(line.count), Number(item.fetchAmount())),
            unitPrice: Number(line.price),
            preferredUnitPrice: policy.desiredUnitPrice,
            minimumUnitPrice: policy.minimumUnitPrice,
            relation: policy.relation,
            rationale: policy.rationale
        }];
    });
    return {
        id: String(bot.coldMarketState.stats.marketStore.id || ''),
        revision: BotMerchantStoreService.revision(store),
        type: 'sell',
        title: store.title || '',
        town: store.town || bot.coldMarketState.stats.marketStore.town || null,
        lines,
        activeNegotiation: activeSummary(bot)
    };
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
    completeTrade,
    canNegotiateStore,
    openNegotiatedTrade,
    quoteItem,
    storeContext,
    reset() {
        negotiations.clear();
        sequence = 0;
    },
    summary,
    validateTrade
};
