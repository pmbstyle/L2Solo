const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const Negotiation = invoke('GameServer/Bot/Economy/BotNegotiationService');
const BotMarketPricing = invoke('GameServer/Bot/Economy/BotMarketPricing');
const DataCache = invoke('GameServer/DataCache');

const BUY_NEGOTIATION_MS = 90 * 1000;
const buyNegotiations = new Map();

function buyKey(ownerId, playerId) { return `${ownerId}:${playerId}`; }

function activeBuy(shop, playerSession) {
    const key = buyKey(shop.store.ownerId, playerSession?.actor?.fetchId?.());
    const offer = buyNegotiations.get(key);
    if (!offer) return null;
    if (offer.expiresAt <= Date.now() || offer.shopId !== shop.store.shopId
        || offer.revision !== shop.store.revision) {
        buyNegotiations.delete(key);
        return null;
    }
    return offer;
}

function activeShop(state) {
    const projection = AfkTrade.findOwnerProjection(state?.characterId);
    const store = projection?.actor?.fetchPrivateStore?.();
    return store?.botOwned && [AfkTrade.SELL, AfkTrade.BUY].includes(Number(store.storeType))
        ? { session: projection.session, store } : null;
}

function priceInMessage(message) {
    const compact = message.match(/\b(\d+(?:[.,]\d+)?)\s*([km])\b/i);
    if (compact) {
        const multiplier = compact[2].toLowerCase() === 'm' ? 1000000 : 1000;
        const amount = Number(compact[1].replace(',', '.')) * multiplier;
        if (Number.isSafeInteger(amount) && amount > 0) return amount;
    }
    const plain = message.match(/\b([\d][\d\s,]*)\s*(?:adena|аден[а-я]*)(?:\s|$)/i)
        || message.match(/(?:offer|pay|предлагаю|дам|for|за)\s+([\d][\d\s,]*)\b/i);
    const amount = plain ? Number(plain[1].replace(/[\s,]/g, '')) : 0;
    return Number.isSafeInteger(amount) && amount > 0 ? amount : 0;
}

function mentionedLine(lines, message) {
    const candidates = lines.filter((line) => Number(line.count) > 0).map((line) => {
        const name = String(line.name || '').toLowerCase();
        const words = name.split(/[^a-z0-9]+/).filter((word) => word.length >= 4);
        const hits = words.filter((word) => message.includes(word)).length;
        return { line, score: message.includes(name) ? 100 + hits : hits };
    }).filter((candidate) => candidate.score > 0)
        .sort((a, b) => b.score - a.score);
    if (candidates.length && (candidates.length === 1 || candidates[0].score > candidates[1].score)) {
        return candidates[0].line;
    }
    return lines.filter((line) => Number(line.count) > 0).length === 1
        ? lines.find((line) => Number(line.count) > 0) : null;
}

function context(state, playerSession = null) {
    const shop = activeShop(state);
    if (!shop) return null;
    const active = Number(shop.store.storeType) === AfkTrade.BUY
        ? activeBuy(shop, playerSession)
        : Negotiation.activeSummary(shop.session);
    const ownActive = active && (!active.playerName
        || active.playerName === playerSession?.actor?.fetchName?.());
    return {
        side: Number(shop.store.storeType) === AfkTrade.BUY ? 'buy' : 'sell',
        town: shop.store.town,
        items: shop.store.items.filter((line) => Number(line.count) > 0).map((line) => ({
            selfId: Number(line.selfId), name: line.name,
            count: Number(line.count), unitPrice: Number(line.price)
        })),
        activeNegotiation: Boolean(ownActive)
    };
}

function parse(state, text, playerSession = null) {
    const shop = activeShop(state);
    if (!shop) return null;
    const message = String(text || '').trim();
    const lower = message.toLowerCase();
    const buying = Number(shop.store.storeType) === AfkTrade.BUY;
    const active = buying ? activeBuy(shop, playerSession) : Negotiation.activeSummary(shop.session);
    const ownActive = active && (!active.playerName
        || active.playerName === playerSession?.actor?.fetchName?.());
    if (/^(?:accept|agree|deal|согласен|согласна|договорились|беру)(?:\s|$)/i.test(lower)
        || (ownActive && /^(?:yes|yep|sure|ok|okay|да|ага)(?:[\s,!.?]|$)/i.test(lower))) {
        return { ...shop, action: 'accept' };
    }
    if (/^(?:decline|cancel|отмена|нет|передумал)(?:\s|$)/i.test(lower)) {
        return { ...shop, action: 'decline' };
    }
    if (/(?:update|change|refresh).{0,16}(?:shop|store|price)|(?:обнови|поменяй|измени).{0,16}(?:лавк|магазин|цен)/i.test(lower)) {
        return { ...shop, action: ownActive ? 'accept' : 'status' };
    }
    const price = priceInMessage(lower);
    const tradeCue = buying
        ? /\b(?:sell|ask|offer|for)\b|продам|продаю|предлагаю|прошу|за/i.test(lower)
        : /\b(?:offer|buy|pay|for)\b|предлагаю|куплю|дам\s|торг|за/i.test(lower);
    if (!tradeCue) return null;
    const quantityMatch = lower.match(/(?:x|х|×)\s*(\d+)/i);
    const quantity = quantityMatch ? Number(quantityMatch[1]) : 1;
    const line = mentionedLine(shop.store.items, lower);
    if (!price || !line || !Number.isSafeInteger(price) || !Number.isSafeInteger(quantity)) {
        return { ...shop, action: 'help' };
    }
    return { ...shop, action: ownActive ? 'counter' : 'quote',
        itemId: Number(line.selfId), quantity, totalPrice: price };
}

function intentForAction(state, playerSession, action, data = {}) {
    const shop = activeShop(state);
    if (!shop) return null;
    if (action === 'shop_status') return { ...shop, action: 'status' };
    if (action === 'shop_accept') return { ...shop, action: 'accept' };
    if (action === 'shop_decline') return { ...shop, action: 'decline' };
    if (action !== 'shop_offer') return null;
    const itemId = Number(data.shopItemId);
    const quantity = Number(data.shopQuantity || 1);
    const totalPrice = Number(data.shopTotalPrice);
    if (!shop.store.items.some((line) => Number(line.selfId) === itemId && Number(line.count) >= quantity)
        || !Number.isSafeInteger(quantity) || quantity < 1
        || !Number.isSafeInteger(totalPrice) || totalPrice < 1) {
        return { ...shop, action: 'help' };
    }
    const active = Number(shop.store.storeType) === AfkTrade.BUY
        ? activeBuy(shop, playerSession) : Negotiation.activeSummary(shop.session);
    const ownActive = active && (!active.playerName
        || active.playerName === playerSession?.actor?.fetchName?.());
    return { ...shop, action: ownActive ? 'counter' : 'quote', itemId, quantity, totalPrice };
}

function buyPriceLimit(line) {
    const template = DataCache.items.find((item) => Number(item.selfId) === Number(line.selfId));
    const reference = BotMarketPricing.referencePrice({
        selfId: line.selfId, basePrice: Number(template?.template?.price || line.price),
        enchant: line.enchant
    });
    return Math.max(Number(line.price), Math.min(
        Math.floor(reference * 0.95), Math.floor(Number(line.price) * 1.12)
    ));
}

async function handleBuy(playerSession, intent) {
    const shop = intent.store;
    const key = buyKey(shop.ownerId, playerSession?.actor?.fetchId?.());
    const current = activeBuy(intent, playerSession);
    if (intent.action === 'decline') {
        buyNegotiations.delete(key);
        return { handled: true, ok: true, action: 'shop_decline',
            reply: 'No deal. My buy shop keeps its current bid.' };
    }
    if (intent.action === 'accept' && !current) return {
        handled: true, ok: false, action: 'shop_accept', reason: 'shop_offer_changed',
        reply: 'That offer has changed. Check my shop and send a new price.'
    };
    if (intent.action === 'accept') {
        const line = shop.items.find((item) => Number(item.afkTradeLineId) === current.lineId);
        if (!line || Number(line.count) < current.quantity) {
            buyNegotiations.delete(key);
            return { handled: true, ok: false, action: 'shop_accept', reason: 'shop_offer_changed',
                reply: 'That offer has changed. Check my shop and send a new price.' };
        }
        try {
            const updated = await AfkTrade.repriceBot(shop.ownerId, current.lineId,
                current.unitPrice, current.revision, current.quantity);
            buyNegotiations.delete(key);
            return { handled: true, ok: true, action: 'shop_accept',
                reply: `Deal. My buy shop now offers ${current.unitPrice} Adena each for ${current.quantity}x ${line.name}.`,
                store: updated };
        } catch (error) {
            buyNegotiations.delete(key);
            return { handled: true, ok: false, action: 'shop_accept', reason: error.message,
                reply: 'I cannot fund that price now. Check my shop and try again.' };
        }
    }
    const line = shop.items.find((item) => Number(item.selfId) === intent.itemId);
    if (!line || intent.quantity < 1 || intent.quantity > Number(line.count)
        || intent.totalPrice % intent.quantity !== 0) return {
        handled: true, ok: false, action: 'shop_quote', reason: 'invalid_shop_offer',
        reply: 'Tell me: sell Item Name x1 for 500 Adena. Use a whole price per item.'
    };
    const proposed = intent.totalPrice / intent.quantity;
    const limit = buyPriceLimit(line);
    const unitPrice = Math.min(proposed, limit);
    const offer = { shopId: shop.shopId, revision: shop.revision,
        lineId: line.afkTradeLineId, quantity: intent.quantity, unitPrice,
        expiresAt: Date.now() + BUY_NEGOTIATION_MS };
    buyNegotiations.set(key, offer);
    return { handled: true, ok: true,
        action: intent.action === 'counter' ? 'shop_counter' : 'shop_quote',
        reply: `I can pay ${unitPrice * intent.quantity} Adena for ${intent.quantity}x ${line.name}. Reply accept, or send another offer.`,
        negotiation: offer };
}

async function handle(playerSession, state, intent) {
    if (!intent) return null;
    const bot = intent.session;
    if (intent.action === 'status') {
        const lines = intent.store.items.filter((line) => Number(line.count) > 0)
            .map((line) => `${line.count}x ${line.name} at ${line.price} Adena each`);
        return { handled: true, ok: true, action: 'shop_status',
            reply: lines.length
                ? `My shop currently lists ${lines.join('; ')}. Send me a price offer to change a listing.`
                : 'My shop has no available stock right now.' };
    }
    if (intent.action === 'help') return {
        handled: true, ok: false, reason: 'shop_offer_format', action: 'shop_quote',
        reply: Number(intent.store.storeType) === AfkTrade.BUY
            ? 'Tell me: sell Item Name x1 for 500 Adena. I can negotiate only listed items.'
            : 'Tell me: offer 500 Adena for Item Name x1. I can negotiate only listed stock.'
    };
    if (Number(intent.store.storeType) === AfkTrade.BUY) return handleBuy(playerSession, intent);
    if (['quote', 'counter'].includes(intent.action)) {
        const line = intent.store.items.find((item) => Number(item.selfId) === Number(intent.itemId));
        const quantity = Number(intent.quantity);
        const unitPrice = Number(intent.totalPrice) / quantity;
        const lots = invoke('GameServer/Bot/Economy/BotAfkMarketService');
        if (line && (!Number.isSafeInteger(unitPrice)
            || !lots.viableSellLine({ ...line, count: quantity, price: unitPrice }))) {
            return { handled: true, ok: false, reason: 'invalid_shop_offer', action: 'shop_quote',
                reply: 'Offer a positive whole quantity and a whole Adena price per item.' };
        }
    }
    let result;
    if (intent.action === 'quote') {
        result = Negotiation.quoteItem(bot, playerSession,
            intent.itemId, intent.quantity, intent.totalPrice);
    } else if (intent.action === 'counter') {
        const active = Negotiation.activeSummary(bot);
        result = active && Number(active.itemSelfId) === Number(intent.itemId)
            ? Negotiation.counterOffer(bot, playerSession, intent.totalPrice)
            : { ok: false, reason: 'negotiation_item_changed' };
    } else if (intent.action === 'accept') {
        result = await Negotiation.acceptPrice(bot, playerSession);
    } else {
        result = Negotiation.declinePrice(bot, playerSession);
    }
    if (!result?.ok) return { handled: true, ok: false,
        reason: result?.reason || 'shop_negotiation_failed', action: `shop_${intent.action}`,
        reply: result?.reason === 'price_out_of_bounds'
            ? 'That price is outside the range I can accept.'
            : 'That offer is no longer available. Check my shop and try again.' };
    const quote = result.negotiation;
    const reply = intent.action === 'accept'
        ? `Deal. My shop now lists ${quote.quantity}x ${quote.itemName} for ${quote.currentUnitPrice} Adena each.`
        : intent.action === 'decline'
            ? 'No deal. My shop keeps its current price.'
            : `I can do ${quote.currentTotalPrice} Adena for ${quote.quantity}x ${quote.itemName}. Reply accept, or send another offer.`;
    return { handled: true, ok: true, reason: result.reason || `shop_${intent.action}`,
        action: `shop_${intent.action}`, reply, negotiation: quote };
}

module.exports = { context, handle, intentForAction, parse };
