'use strict';

// Server contract for a future client view. Each answer resolves the current
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
    database = () => invoke('Database'), response = () => invoke('GameServer/Network/Response') } = {}) {
    function entries(session, options = {}) {
        if (!human(session)) return { available: false, entries: [], more: false };
        const limit = Math.min(24, Math.max(1, Math.floor(Number(options.limit) || 20)));
        const offset = Math.min(10000, Math.max(0, Math.floor(Number(options.offset) || 0)));
        const playerId = Number(session.actor.fetchId());
        let skipped = 0;
        const result = [];
        const push = (entry) => {
            if (skipped++ < offset) return true;
            result.push(entry); return result.length <= limit;
        };
        if (options.kind === 'workshop') {
            const customer = { characterId: playerId, clanId: Number(session.actor.fetchClanId?.() || 0), stats: {} };
            outer: for (const shop of workshops().boardRecords()) {
                if (shop.ownerId === playerId || options.town && shop.town !== options.town) continue;
                for (const entry of shop.entries) {
                    const quote = workshops().lookup(shop.ownerId, entry.recipeId, customer);
                    if (!quote || !push({ id: shop.id, kind: shop.kind, ownerId: shop.ownerId, ownerName: shop.ownerName,
                        town: shop.town, loc: shop.loc, recipeId: entry.recipeId, price: quote.price, revision: shop.revision })) {
                        if (result.length > limit) break outer;
                    }
                }
            }
        } else {
            const service = afk();
            if (!service.isBoardReady()) return { available: false, entries: [], more: false };
            const board = service.boardIndex();
            const sides = [SELL, BUY].includes(Number(options.side)) ? [Number(options.side)] : [SELL, BUY];
            const lines = options.selfId
                ? (function* () { for (const side of sides) yield* board.list(Number(options.selfId), side, options.town || null); })()
                : (function* () { for (const record of board.records.values()) yield* record; })();
            for (const line of lines) {
                if (line.ownerId === playerId || !sides.includes(line.storeType)
                    || options.town && line.town && line.town !== options.town) continue;
                const offer = service.offerOf(line);
                if (!offer) continue;
                if (!push({ id: line.recordId, kind: line.kind, side: line.storeType, ownerId: line.ownerId,
                    ownerName: offer.sourceName, town: line.town, lineId: line.lineId, selfId: line.selfId,
                    itemName: offer.itemName, enchant: line.enchant, count: line.count, price: line.price,
                    revision: line.revision })) break;
            }
        }
        return { available: true, entries: result.slice(0, limit), more: result.length > limit };
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
                return { ok: true, action: 'meet', ownerId, town: quote.state.currentRegion, loc: { ...quote.state.loc } };
            }
            try {
                const result = await workshops().craft(ownerId, recipeId, playerId, { expectedPrice: Number(request.price) });
                const rows = await database().fetchItems(playerId);
                session.actor.backpack.items = [];
                for (const row of rows) session.actor.backpack.insertItem(row.id, row.selfId, row);
                session.dataSendToMe(response().itemsList(session.actor.backpack.fetchItems()));
                return { ok: true, action: 'crafted', product: result.product || null };
            } catch (error) { return { ok: false, reason: 'craft_unavailable' }; }
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
        const merchant = offer.projection?.actor;
        if (!merchant) {
            const owner = life().cachedState(line.ownerId);
            return { ok: true, action: 'contact', ownerId: line.ownerId, ownerName: offer.sourceName,
                town: owner?.currentRegion || line.town, loc: owner?.loc ? { ...owner.loc } : null };
        }
        const loc = location(merchant);
        if (distance(session.actor, loc) > SHOP_RANGE) return { ok: true, action: 'meet', ownerId: line.ownerId,
            ownerName: offer.sourceName, town: line.town, loc };
        // The normal interaction selects first, then opens the C4 store list.
        // Its existing buy/sell packets perform the real inventory transaction.
        const data = { id: merchant.fetchId(), ...location(session.actor), actionId: 0, ctrl: false };
        session.actor.select(data);
        session.actor.select(data);
        return { ok: true, action: 'store_opened', ownerId: line.ownerId };
    }
    return { entries, answer };
}

const service = create();
module.exports = { ...service, create };
