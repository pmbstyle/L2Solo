'use strict';

// Server contract for the player board. Each answer resolves the current
// canonical record; a displayed quote never becomes a remote purchase.
const { SELL, BUY } = require('./BoardIndex');
const SHOP_RANGE = 200;
const WORKSHOP_RANGE = 1200;

function location(actor) {
    return { locX: Number(actor.fetchLocX()), locY: Number(actor.fetchLocY()), locZ: Number(actor.fetchLocZ()) };
}
function distance(actor, loc) {
    const own = location(actor);
    return Math.hypot(own.locX - loc.locX, own.locY - loc.locY, own.locZ - loc.locZ);
}
function human(session) {
    return !!session?.actor && !String(session.accountId || '').startsWith('bot_')
        && !session.actor.isDead?.() && Number(session.actor.fetchHp?.() ?? 1) > 0;
}

function create({ afk = () => invoke('GameServer/AfkTrade/AfkTradeService'),
    workshops = () => invoke('GameServer/Bot/Economy/CraftWorkshopService'),
    life = () => invoke('GameServer/Bot/Population/BotLifeState'),
    database = () => invoke('Database'), meetings = () => require('./TradeMeetingService'), response = () => invoke('GameServer/Network/Response') } = {}) {
    function entries(session, options = {}) {
        if (!human(session)) return { available: false, entries: [], next: null };
        const limit = Math.min(24, Math.max(1, Math.floor(Number(options.limit) || 20)));
        const playerId = Number(session.actor.fetchId());
        const result = [];
        let next = null;
        const push = (entry, cursor) => {
            if (result.length === limit) { next = cursor; return false; }
            result.push({ ...entry, cursor }); return true;
        };
        if (options.kind === 'workshop') {
            const customer = { characterId: playerId, clanId: Number(session.actor.fetchClanId?.() || 0), stats: {} };
            const from = options.cursor;
            outer: for (const shop of workshops().boardRecords().slice().sort((a, b) => a.ownerId - b.ownerId)) {
                if (shop.ownerId === playerId || options.town && shop.town !== options.town) continue;
                if (from && Number(shop.ownerId) < Number(from.ownerId)) continue;
                for (const entry of shop.entries.slice().sort((a, b) => a.recipeId - b.recipeId)) {
                    if (from && Number(shop.ownerId) === Number(from.ownerId) && Number(entry.recipeId) < Number(from.recipeId)) continue;
                    const quote = workshops().lookup(shop.ownerId, entry.recipeId, customer);
                    if (!quote || options.selfId && Number(quote.recipe?.productId) !== Number(options.selfId)) continue;
                    if (!push({ id: shop.id, kind: shop.kind, ownerId: shop.ownerId, ownerName: shop.ownerName,
                        town: shop.town, loc: shop.loc, recipeId: entry.recipeId, selfId: Number(quote.recipe?.productId) || 0,
                        price: quote.price, revision: shop.revision },
                    { ownerId: Number(shop.ownerId), recipeId: Number(entry.recipeId) })) break outer;
                }
            }
        } else {
            const service = afk();
            if (!service.isBoardReady()) return { available: false, entries: [], next: null };
            const board = service.boardIndex();
            const sides = [SELL, BUY].includes(Number(options.side)) ? [Number(options.side)] : [SELL, BUY];
            let resume = !options.cursor?.side;
            outer: for (const side of sides) {
                if (!resume && side !== Number(options.cursor.side)) continue;
                resume = true;
                const cursor = !options.cursor?.side || side === Number(options.cursor.side) ? options.cursor : null;
                for (const row of board.page(side, { town: options.town || null, selfId: Number(options.selfId) || 0, cursor })) {
                    const line = row.line;
                    if (line.ownerId === playerId) continue;
                    const offer = service.offerOf(line);
                    if (!offer) continue;
                    if (!push({ id: line.recordId, kind: line.kind, side: line.storeType, ownerId: line.ownerId,
                        ownerName: offer.sourceName, town: line.town, lineId: line.lineId, selfId: line.selfId,
                        itemName: offer.itemName, enchant: line.enchant, count: line.count, price: line.price,
                        revision: line.revision, conditional: line.custodyPolicy === 1 }, { ...row.cursor, side })) break outer;
                }
            }
        }
        return { available: true, entries: result, next };
    }

    async function answer(session, request = {}) {
        if (!human(session)) return { ok: false, reason: 'player_unavailable' };
        const playerId = Number(session.actor.fetchId());
        if (request.kind === 'workshop') {
            const ownerId = Number(request.ownerId), recipeId = Number(request.recipeId);
            if (ownerId === playerId) return { ok: false, reason: 'own_record' };
            const quote = workshops().lookup(ownerId, recipeId, { characterId: playerId,
                clanId: Number(session.actor.fetchClanId?.() || 0), stats: {} });
            if (!quote || Number(quote.state.simulation?.revision || 0) !== Number(request.revision)
                || Number(quote.price) !== Number(request.price)) return { ok: false, reason: 'record_changed' };
            if (distance(session.actor, quote.state.loc) > WORKSHOP_RANGE) {
                return { ok: true, action: 'meet', ownerId, ownerName: quote.state.name, productId: quote.recipe?.productId,
                    town: quote.state.currentRegion, loc: { ...quote.state.loc } };
            }
            if (request.confirmed !== true) return { ok: true, action: 'confirm', ownerId, recipeId,
                ownerName: quote.state.name, price: quote.price, revision: Number(quote.state.simulation?.revision || 0),
                productId: quote.recipe?.productId };
            try {
                const result = await workshops().craft(ownerId, recipeId, playerId, { expectedPrice: Number(request.price) });
                const rows = await database().fetchItems(playerId);
                session.actor.backpack.items = [];
                for (const row of rows) session.actor.backpack.insertItem(row.id, row.selfId, row);
                session.dataSendToMe(response().itemsList(session.actor.backpack.fetchItems()));
                return { ok: true, action: 'crafted', product: result.product || null };
            } catch (error) { return { ok: false, reason: 'craft_unavailable' }; }
        }
        const consent = session.playerBoardPreparation;
        if (request.confirmed === true && consent && consent.id === request.id && consent.lineId === request.lineId
            && consent.amount === Number(request.amount ?? 1) && consent.price === Number(request.price)
            && consent.revision === request.revision) {
            const saved = await meetings().receipt?.(consent.preparationId, playerId);
            if (saved) {
                session.playerBoardPreparation = undefined;
                return { ok: true, action: saved.outcome === 'completed' || saved.outcome === 'cancelled' ? saved.outcome : 'agreed', pending: saved.pending };
            }
        }
        const service = afk();
        if (!service.isBoardReady()) return { ok: false, reason: 'board_unavailable' };
        const line = service.boardIndex().records.get(Number(request.id))
            ?.find(row => row.lineId === Number(request.lineId));
        if (!line || line.revision !== request.revision || line.price !== Number(request.price)
            || line.selfId !== Number(request.selfId) || line.count <= 0) return { ok: false, reason: 'record_changed' };
        if (line.ownerId === playerId) return { ok: false, reason: 'own_record' };
        const offer = service.offerOf(line);
        if (!offer) return { ok: false, reason: 'record_changed' };
        if (line.custodyPolicy === 1) {
            const loc = { locX: Number(offer.store.locX), locY: Number(offer.store.locY), locZ: Number(offer.store.locZ) };
            if (distance(session.actor, loc) > SHOP_RANGE) return { ok: true, action: 'meet', ownerId: line.ownerId,
                ownerName: offer.sourceName, side: line.storeType, town: line.town, loc };
            const amount = Number(request.amount ?? 1);
            if (!Number.isSafeInteger(amount) || amount <= 0 || amount > line.count) return { ok: false, reason: 'record_changed' };
            if (request.confirmed === true) {
                const prepared = session.playerBoardPreparation;
                if (!prepared || prepared.id !== line.recordId || prepared.lineId !== line.lineId || prepared.amount !== amount
                    || prepared.price !== line.price || prepared.revision !== line.revision) return { ok: false, reason: 'record_changed' };
                try { const result = await meetings().accept(prepared.preparationId);
                    session.playerBoardPreparation = undefined;
                    return { ok: true, action: result.outcome === 'completed' || result.outcome === 'cancelled' ? result.outcome : 'agreed', ownerName: offer.sourceName, town: line.town, pending: result.pending }; }
                catch (_) { return { ok: false, reason: 'record_changed' }; }
            }
            if (session.playerBoardPreparation) meetings().discard(session.playerBoardPreparation.preparationId);
            session.playerBoardPreparation = undefined;
            try {
                const prepared = await meetings().prepareTrade(playerId, offer.store, line.selfId, amount,
                    { lineId: line.lineId, expectedPrice: line.price, expectedRevision: line.revision });
                session.playerBoardPreparation = { ...request, amount, id: line.recordId, lineId: line.lineId,
                    price: line.price, revision: line.revision, preparationId: prepared.preparationId };
                return { ok: true, action: 'confirm_trade', ownerName: offer.sourceName, side: line.storeType,
                    amount, price: line.price, total: prepared.total, selfId: line.selfId, town: line.town };
            } catch (_) { return { ok: false, reason: 'record_changed' }; }
        }
        const merchant = offer.projection?.actor;
        if (!merchant) {
            const owner = life().cachedState(line.ownerId);
            return { ok: true, action: 'contact', ownerId: line.ownerId, ownerName: offer.sourceName,
                side: line.storeType,
                town: owner?.currentRegion || line.town, loc: owner?.loc ? { ...owner.loc } : null };
        }
        const loc = location(merchant);
        if (distance(session.actor, loc) > SHOP_RANGE) return { ok: true, action: 'meet', ownerId: line.ownerId,
            ownerName: offer.sourceName, side: line.storeType, town: line.town, loc };
        // The normal interaction selects first, then opens the C4 store list.
        // Its existing buy/sell packets perform the real inventory transaction.
        const data = { id: merchant.fetchId(), ...location(session.actor), actionId: 0, ctrl: false };
        session.actor.select(data);
        session.actor.select(data);
        return { ok: true, action: 'store_opened', ownerId: line.ownerId };
    }
    async function cancel(session) {
        if (!human(session)) return { ok: false, reason: 'player_unavailable' };
        if (session.playerBoardPreparation) meetings().discard(session.playerBoardPreparation.preparationId);
        session.playerBoardPreparation = undefined;
        return meetings().cancel(Number(session.actor.fetchId()));
    }
    return { entries, answer, cancel };
}

const service = create();
module.exports = { ...service, create };
