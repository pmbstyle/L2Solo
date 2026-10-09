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
function meetingFailure(error, playerId, line, phase) {
    const reason = ({
        trade_meeting_party_busy: 'merchant_party', party_trade_busy: 'merchant_party',
        trade_meeting_stock_changed: line.storeType === BUY ? 'items_missing' : 'stock_changed', inventory_item_changed: 'stock_changed',
        economy_material_protected: 'stock_changed',
        not_enough_adena: line.storeType === BUY ? 'merchant_declined' : 'insufficient_funds',
        trade_meeting_player_at_point: 'player_at_point', trade_meeting_point_changed: 'meeting_point_changed',
        trade_meeting_worker_unavailable: 'merchant_busy', trade_meeting_worker_busy: 'merchant_busy',
        trade_meeting_preparation_busy: 'merchant_busy', trade_meeting_backpressure: 'merchant_busy',
        trade_meeting_preparation_timeout: 'merchant_busy',
        trade_meeting_authority_changed: 'merchant_changed', trade_meeting_stale_worker: 'merchant_changed',
        trade_meeting_preparation_missing: 'merchant_changed', trade_meeting_preparation_discarded: 'merchant_changed',
        trade_meeting_preparation_changed: 'merchant_changed', trade_meeting_source_retired: 'merchant_changed',
        trade_meeting_need_changed: 'merchant_declined', trade_meeting_funding: 'merchant_declined',
        economy_funding_missing: 'merchant_declined', economy_funding_changed: 'merchant_declined',
        trade_meeting_quote_changed: 'record_changed'
    })[error.message] || 'trade_unavailable';
    utils.infoWarn('Board', 'player %d meeting %s record=%d: %s', playerId, phase, line.recordId, error.message);
    return { ok: false, reason };
}

function create({ afk = () => invoke('GameServer/AfkTrade/AfkTradeService'),
    workshops = () => invoke('GameServer/Bot/Economy/CraftWorkshopService'),
    life = () => invoke('GameServer/Bot/Population/BotLifeState'),
    database = () => invoke('Database'), meetings = () => require('./TradeMeetingService'), response = () => invoke('GameServer/Network/Response') } = {}) {
    function* workshopOffers(session, options = {}) {
        const playerId = Number(session.actor.fetchId());
        const customer = { characterId: playerId, clanId: Number(session.actor.fetchClanId?.() || 0), stats: {} };
        const from = options.cursor;
        for (const shop of workshops().boardRecords().slice().sort((a, b) => a.ownerId - b.ownerId)) {
            if (Number(shop.ownerId) === playerId || options.town && shop.town !== options.town) continue;
            if (from && Number(shop.ownerId) < Number(from.ownerId)) continue;
            for (const entry of shop.entries.slice().sort((a, b) => a.recipeId - b.recipeId)) {
                if (from && Number(shop.ownerId) === Number(from.ownerId) && Number(entry.recipeId) < Number(from.recipeId)) continue;
                const quote = workshops().lookup(shop.ownerId, entry.recipeId, customer);
                if (!quote || options.selfId && Number(quote.recipe?.productId) !== Number(options.selfId)) continue;
                yield { entry: { id: shop.id, kind: shop.kind, ownerId: shop.ownerId, ownerName: shop.ownerName,
                    town: shop.town, loc: shop.loc, recipeId: entry.recipeId, selfId: Number(quote.recipe?.productId) || 0,
                    price: quote.price, revision: shop.revision }, cursor: { ownerId: Number(shop.ownerId), recipeId: Number(entry.recipeId) } };
            }
        }
    }
    function itemIds(session, options = {}) {
        if (!human(session)) return [];
        if (options.kind === 'workshop') return [...new Set([...workshopOffers(session, options)].map(row => row.entry.selfId))];
        return afk().isBoardReady() ? [...afk().boardIndex().itemIds(options.side, options.town)] : [];
    }
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
            for (const row of workshopOffers(session, options)) if (!push(row.entry, row.cursor)) break;
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
        const actor = session.actor;
        const current = () => session.actor === actor;
        const playerId = Number(session.actor.fetchId());
        if (request.kind === 'workshop') {
            if (session.playerBoardCraftPending) return { ok: false, reason: 'craft_busy' };
            const ownerId = Number(request.ownerId), recipeId = Number(request.recipeId);
            if (ownerId === playerId) return { ok: false, reason: 'own_record' };
            const quote = workshops().lookup(ownerId, recipeId, { characterId: playerId,
                clanId: Number(session.actor.fetchClanId?.() || 0), stats: {} });
            if (!quote || Number(quote.state.simulation?.revision || 0) !== Number(request.revision)
                || Number(quote.price) !== Number(request.price)) return { ok: false, reason: 'record_changed' };
            if (request.locateOnly === true) return { ok: true, action: 'locate', ownerName: quote.state.name,
                town: quote.state.currentRegion, loc: { ...quote.state.loc } };
            if (distance(session.actor, quote.state.loc) > WORKSHOP_RANGE) {
                return { ok: true, action: 'meet', ownerId, ownerName: quote.state.name, productId: quote.recipe?.productId,
                    town: quote.state.currentRegion, loc: { ...quote.state.loc } };
            }
            if (request.confirmed !== true) return { ok: true, action: 'confirm', ownerId, recipeId,
                ownerName: quote.state.name, price: quote.price, revision: Number(quote.state.simulation?.revision || 0),
                productId: quote.recipe?.productId, productCount: quote.recipe?.productCount || 1,
                successRate: quote.recipe?.successRate,
                materials: (quote.recipe?.materials || []).map(row => ({ selfId: row.selfId, amount: row.amount })) };
            const pending = { actor, ownerId, recipeId };
            session.playerBoardCraftPending = pending;
            try {
                const result = await workshops().craft(ownerId, recipeId, playerId, {
                    expectedPrice: Number(request.price), expectedRevision: Number(request.revision) });
                const rows = await database().fetchItems(playerId);
                if (!current()) return { ok: false, reason: 'player_unavailable' };
                session.actor.backpack.items = [];
                for (const row of rows) session.actor.backpack.insertItem(row.id, row.selfId, row);
                session.dataSendToMe(response().itemsList(session.actor.backpack.fetchItems()));
                session.dataSendToMe(response().userInfo(session.actor));
                return { ok: true, action: result.product ? 'crafted' : 'craft_failed', product: result.product || null,
                    received: result.product ? { selfId: quote.recipe.productId, amount: quote.recipe.productCount || 1 } : null };
            } catch (error) { return { ok: false, reason: ({ 'workshop materials missing': 'materials_missing',
                'customer craft material changed': 'materials_missing', 'customer adena changed': 'insufficient_funds',
                'workshop ownership changed': 'record_changed', 'workshop price changed': 'record_changed' })[error.message] || 'craft_unavailable' }; }
            finally { if (session.playerBoardCraftPending === pending) session.playerBoardCraftPending = undefined; }
        }
        const consent = session.playerBoardPreparation;
        let saved;
        if (request.confirmed === true && consent && consent.id === request.id && consent.lineId === request.lineId
            && consent.amount === Number(request.amount ?? 1) && consent.price === Number(request.price)
            && consent.revision === request.revision) {
            saved = await meetings().receipt?.(consent.preparationId, playerId);
            if (!current()) return { ok: false, reason: 'player_unavailable' };
            // A staged receipt is only a pending preparation. Explicit player
            // consent still has to call accept before any trade is reserved.
            if (saved && ['accepted', 'completed', 'cancelled'].includes(saved.outcome)) {
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
        // The canonical advertisement exposes its meeting point on the offer;
        // the store contains trade terms, without location coordinates.
        const meetingLoc = line.custodyPolicy === 1 ? { locX: offer.locX, locY: offer.locY, locZ: offer.locZ } : null;
        if (meetingLoc && !Object.values(meetingLoc).every(Number.isFinite)) return { ok: false, reason: 'location_unavailable' };
        if (request.locateOnly === true) {
            const owner = life().cachedState(line.ownerId);
            const loc = line.custodyPolicy === 1 ? meetingLoc
                : offer.projection?.actor ? location(offer.projection.actor) : owner?.loc;
            return loc ? { ok: true, action: 'locate', ownerName: offer.sourceName, conditional: line.custodyPolicy === 1,
                town: line.custodyPolicy === 1 || offer.projection?.actor ? line.town : owner?.currentRegion || line.town, loc: { ...loc } }
                : { ok: false, reason: 'location_unavailable' };
        }
        if (line.custodyPolicy === 1) {
            const loc = meetingLoc;
            if (distance(session.actor, loc) > SHOP_RANGE) return { ok: true, action: 'meet', ownerId: line.ownerId,
                ownerName: offer.sourceName, side: line.storeType, town: line.town, loc, conditional: true };
            const amount = Number(request.amount ?? 1);
            if (!Number.isSafeInteger(amount) || amount <= 0 || amount > line.count) return { ok: false, reason: 'record_changed' };
            if (request.confirmed === true) {
                const prepared = session.playerBoardPreparation;
                if (!prepared || prepared.id !== line.recordId || prepared.lineId !== line.lineId || prepared.amount !== amount
                    || prepared.price !== line.price || prepared.revision !== line.revision) return { ok: false, reason: 'record_changed' };
                try {
                    if (saved?.outcome !== 'preparing') await meetings().prepareTrade(playerId, offer.store, line.selfId, amount,
                        { lineId: line.lineId, expectedPrice: line.price, expectedRevision: line.revision,
                            token: prepared.preparationId, expectedPoint: prepared.point });
                    if (!current()) {
                        meetings().discard(prepared.preparationId);
                        return { ok: false, reason: 'player_unavailable' };
                    }
                    const result = await meetings().accept(prepared.preparationId, playerId);
                    if (!current()) return { ok: false, reason: 'player_unavailable' };
                    session.playerBoardPreparation = undefined;
                    return { ok: true, action: result.outcome === 'completed' || result.outcome === 'cancelled' ? result.outcome : 'agreed', ownerName: offer.sourceName, town: line.town, pending: result.pending }; }
                catch (error) {
                    return meetingFailure(error, playerId, line, 'acceptance');
                }
            }
            if (session.playerBoardPreparation) meetings().discard(session.playerBoardPreparation.preparationId);
            session.playerBoardPreparation = undefined;
            try {
                const prepared = await meetings().prepareTrade(playerId, offer.store, line.selfId, amount,
                    { lineId: line.lineId, expectedPrice: line.price, expectedRevision: line.revision, preview: true });
                if (!current()) {
                    meetings().discard(prepared.preparationId);
                    return { ok: false, reason: 'player_unavailable' };
                }
                session.playerBoardPreparation = { ...request, amount, id: line.recordId, lineId: line.lineId,
                    price: line.price, revision: line.revision, preparationId: prepared.preparationId, point: prepared.point };
                return { ok: true, action: 'confirm_trade', ownerName: offer.sourceName, side: line.storeType,
                    amount, price: line.price, total: prepared.total, selfId: line.selfId, town: line.town };
            } catch (error) {
                return meetingFailure(error, playerId, line, 'preview');
            }
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
    return { entries, itemIds, answer, cancel };
}

const service = create();
module.exports = { ...service, create };
