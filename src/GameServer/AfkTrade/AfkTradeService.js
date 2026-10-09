const refreshPartyMemberships = require('../World/PartyMembershipPublication');
const ItemTemplateIndex = require('../Item/ItemTemplateIndex');
const BoardRules = require('./BoardRules');
const { BoardIndex, offerFields, rowOf, recordOf } = require('./BoardIndex');
const TableChannel = require('../Bot/Population/ColdTableChannel');
const Actor = invoke('GameServer/Actor/Actor');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const ServerResponse = invoke('GameServer/Network/Response');
const World = invoke('GameServer/World/World');

const SELL = BoardRules.SELL;
const BUY = BoardRules.BUY;
const PROJECTION_ID_BASE = 900000000;
const { CLIENT_VISIBILITY_RADIUS } = invoke('GameServer/World/WorldConstants');
const ShopPlaces = invoke('GameServer/Bot/Economy/ShopPlaces');
const VISIBILITY_CELL_SIZE = CLIENT_VISIBILITY_RADIUS;
// The board in memory (design section 4). A shop stands in the world as a
// projection (an actor drawn from its snapshot); an ad or an order is an entry
// with its store object and no actor. Every line of both is in the offer
// index (BoardIndex), sorted best first by item and town.
const projectionsById = new Map();
const projectionsByOwner = new Map();
const projectionsByCell = new Map();
const entriesById = new Map();
const entriesByOwner = new Map();
const MarketCounters = invoke('GameServer/Bot/Economy/MarketCounters');
const board = new BoardIndex({ groupOf: MarketCounters.counterOf });
MarketCounters.publish(TableChannel.shared);
// The board goes to the planning workers as the 'board' table (ColdTableChannel):
// a record with stock is one row (BoardIndex.rowOf), its key the record id;
// each worker builds the same index from it.
TableChannel.shared.register('board', {
    eventDriven: true,
    key: (row) => row[0],
    allRows: () => [...boardRows(), ...invoke('GameServer/Bot/Economy/CraftWorkshopService').publicRows()]
});

function boardRows() {
    const rows = [];
    for (const entry of entriesById.values()) if (entry.boardRow) rows.push(entry.boardRow);
    return rows;
}
// Records close by events only (user, 2026-10-05): no deadline. What a deal
// left on the board for cold bots the worker does not lease is merged every
// SETTLE_TICK_MS on the main thread, one run at a time.
const SETTLE_TICK_MS = 5000;
let settleTimer = null;
let settling = false;
const boardChangeListeners = new Set();
let boardReady = false;
let boardChangeDepth = 0;
const changedOwners = new Set();
const changedItemIds = new Set();

function notifyBoardChange(change) {
    // Main and worker economic consumers use the same item->recipe source.
    // Membership changes follow board events, never a per-actor catalogue scan.
    const production = require('../Bot/Population/ColdOccupationSources').recipeIndex(board);
    if (change.reset) production.reset();
    else for (const id of change.selfIds || []) production.update(id);
    for (const listener of boardChangeListeners) {
        try { listener(change); }
        catch (error) { utils.infoWarn('AfkTrade', 'board listener failed: %s', error.message); }
    }
}

// A replacement's remove/put is one logical event. Listeners see the
// completed indexed board, including metadata-only checkpoint refreshes.
function boardChange(work) {
    boardChangeDepth++;
    try { return work(); }
    finally {
        if (--boardChangeDepth === 0 && changedOwners.size) {
            const ownerIds = [...changedOwners];
            const selfIds = [...changedItemIds];
            changedOwners.clear();
            changedItemIds.clear();
            notifyBoardChange({ ownerIds, selfIds, ready: boardReady });
        }
    }
}

function subscribeBoardChanges(listener) {
    if (typeof listener !== 'function') return () => {};
    boardChangeListeners.add(listener);
    return () => boardChangeListeners.delete(listener);
}

function kindOf(shop) {
    return shop?.kind || 'shop';
}

// The store object of an entry: a shop's lives on its projection's actor.
function entryStore(entry) {
    return entry?.actor ? entry.actor.fetchPrivateStore() : entry?.store;
}

// A record leaves the offer index and the board table (its id is kept on the
// entry: a shop's projection may have carried an older record).
function unindexProjection(projection) {
    const recordId = projection?.indexedRecordId;
    if (!recordId) return;
    changedOwners.add(Number(projection.shop.ownerId));
    for (const line of projection.boardRow?.[6] || []) changedItemIds.add(line[1]);
    board.remove(recordId);
    TableChannel.shared.changed('board', { key: recordId, removed: true });
    projection.indexedRecordId = null;
    projection.boardRow = null;
}

function indexProjection(projection) {
    const store = entryStore(projection);
    if (![SELL, BUY].includes(Number(store?.storeType))) return;
    const row = rowOf(store);
    if (!row[6].length) return;
    board.put(recordOf(row), projection);
    changedOwners.add(Number(projection.shop.ownerId));
    for (const line of row[6]) changedItemIds.add(line[1]);
    TableChannel.shared.changed('board', row);
    projection.indexedRecordId = row[0];
    projection.boardRow = row;
}

// Every record, shop or ad, by id and by owner.
function rememberEntry(entry) {
    const id = Number(entry.shop.id);
    const ownerId = Number(entry.shop.ownerId);
    entriesById.set(id, entry);
    const owned = entriesByOwner.get(ownerId) || new Map();
    owned.set(id, entry);
    entriesByOwner.set(ownerId, owned);
}

function forgetEntry(entry) {
    if (!entry?.shop) return;
    const id = Number(entry.shop.id);
    const ownerId = Number(entry.shop.ownerId);
    if (entriesById.get(id) === entry) entriesById.delete(id);
    const owned = entriesByOwner.get(ownerId);
    if (owned?.get(id) === entry) owned.delete(id);
    if (owned && !owned.size) entriesByOwner.delete(ownerId);
}

function isBotSession(session) {
    return !!session && (
        session.botSession === true
        || session.constructor?.name === 'BotSession'
        || String(session.accountId || '').startsWith('bot_')
    );
}

function onlineSession(characterId) {
    return (World.user?.sessions || []).find((session) => (
        Number(session?.actor?.fetchId?.() || 0) === Number(characterId)
    )) || null;
}

function itemTemplate(selfId) {
    return ItemTemplateIndex.find(DataCache.items, selfId) || null;
}

function itemName(selfId) {
    return itemTemplate(selfId)?.template?.name || `Item ${selfId}`;
}

function isStackable(selfId) {
    return itemTemplate(selfId)?.etc?.stackable === true;
}

function clone(value, fallback = {}) {
    try {
        return JSON.parse(JSON.stringify(value));
    } catch (_) {
        return fallback;
    }
}

function appearanceSnapshot(actor) {
    return {
        model: clone(actor.model || {}),
        paperdoll: clone(actor.backpack?.paperdoll || utils.tupleAlloc(16, {}), utils.tupleAlloc(16, {})),
        items: (actor.backpack?.fetchItems?.() || [])
            .filter((item) => item.fetchEquipped?.())
            .map((item) => ({ ...clone(item.model || {}), id: Number(item.fetchId()), equipped: true }))
    };
}

function projectionObjectId(shopId) {
    const id = PROJECTION_ID_BASE + Number(shopId);
    if (!Number.isSafeInteger(id) || id > 0x7fffffff) throw new Error('afk_trade_projection_id_exhausted');
    return id;
}

function visibilityCell(x, y) {
    return `${Math.floor(Number(x) / VISIBILITY_CELL_SIZE)}:${Math.floor(Number(y) / VISIBILITY_CELL_SIZE)}`;
}

function indexLocation(projection) {
    const key = visibilityCell(projection.actor.fetchLocX(), projection.actor.fetchLocY());
    const members = projectionsByCell.get(key) || new Set();
    members.add(projection);
    projectionsByCell.set(key, members);
    projection.visibilityCell = key;
    ShopPlaces.occupy(ShopPlaces.afkOwner(projection.shop.ownerId), projection.shop.town, projection.shop);
}

function unindexLocation(projection) {
    if (projection?.shop) ShopPlaces.release(ShopPlaces.afkOwner(projection.shop.ownerId));
    const key = projection?.visibilityCell;
    const members = projectionsByCell.get(key);
    if (!members) return;
    members.delete(projection);
    if (!members.size) projectionsByCell.delete(key);
    projection.visibilityCell = null;
}

class ProjectionSession {
    constructor(shop) {
        this.accountId = `afk_trade_${shop.ownerId}`;
        this.afkTradeProjection = true;
        this.botOwned = String(shop.ownerAccount || '').startsWith('bot_');
        if (this.botOwned) this.plan = 'merchant';
        this.shopId = Number(shop.id);
        this.socket = { write() {}, resetAndDestroy() {} };
    }

    fetchAccountId() { return this.accountId; }
    dataSendToMe() {}
    dataSendToOthers() {}
    dataSendToMeAndOthers() {}
}

function projectionStore(shop) {
    return {
        afkTrade: true,
        nativePlayerStore: true,
        botOwned: String(shop.ownerAccount || '').startsWith('bot_'),
        custodyPolicy: Number(shop.custodyPolicy || 0), conditional: shop.custodyPolicy === 1,
        budgetBacked: shop.custodyPolicy !== 1 && Number(shop.storeType) === BUY,
        shopId: Number(shop.id),
        kind: kindOf(shop),
        ownerId: Number(shop.ownerId),
        storeType: Number(shop.storeType),
        expiresAt: Number(shop.expiresAt || 0),
        title: String(shop.title || ''),
        town: shop.town || null,
        packageSale: Number(shop.packageSale) === 1,
        revision: Number(shop.revision || 1),
        items: (shop.lines || []).filter((line) => Number(line.count) > 0).map((line) => ({
            afkTradeLineId: Number(line.id),
            objectId: Number(line.sourceObjectId || (PROJECTION_ID_BASE - Number(line.id))),
            selfId: Number(line.selfId),
            name: line.name || itemName(line.selfId),
            count: Number(line.count),
            price: Number(line.price),
            ...(line.pricing ? { pricing: line.pricing } : {}),
            fills: Number(line.fills || 0),
            enchant: Number(line.enchant || 0),
            slot: Number(line.slot || 0),
            stackable: Number(line.stackable || 0) === 1
        }))
    };
}

function buildProjection(shop) {
    const appearance = shop.appearance || {};
    const session = new ProjectionSession(shop);
    const store = projectionStore(shop);
    if (store.botOwned) {
        session.coldMarketState = { characterId: Number(shop.ownerId),
            stats: { marketStore: { id: `afk:${shop.id}`, ...store } } };
    }
    const appearanceItems = Array.isArray(appearance.items) ? appearance.items.map((item) => ({ ...item })) : [];
    if (Number(shop.storeType) === SELL) {
        store.items.forEach((line) => {
            appearanceItems.push({
                id: line.objectId,
                selfId: line.selfId,
                name: line.name,
                amount: line.count,
                enchant: line.enchant,
                equipped: false,
                slot: line.slot
            });
        });
    }
    const model = {
        ...(appearance.model || {}),
        id: projectionObjectId(shop.id),
        name: shop.ownerName || appearance.model?.name || `Trader ${shop.ownerId}`,
        locX: Number(shop.locX),
        locY: Number(shop.locY),
        locZ: Number(shop.locZ),
        head: Number(shop.head || 0),
        items: appearanceItems,
        paperdoll: Array.isArray(appearance.paperdoll) ? appearance.paperdoll : utils.tupleAlloc(16, {}),
        privateStoreType: Number(shop.storeType),
        isOnline: true,
        pvpFlag: 0,
        karma: 0
    };
    session.actor = new Actor(session, model);
    session.actor.afkTradeProjection = true;
    session.actor.afkTradeOwnerId = Number(shop.ownerId);
    session.actor.setPrivateStore(store);
    session.actor.setPrivateStoreType(Number(shop.storeType));
    session.actor.setIsOnline(true);
    session.actor.state.setSeated(true);
    return { shop, session, actor: session.actor };
}

function distance2d(left, right) {
    return Math.hypot(
        Number(left.fetchLocX?.() || 0) - Number(right.fetchLocX?.() || 0),
        Number(left.fetchLocY?.() || 0) - Number(right.fetchLocY?.() || 0)
    );
}

function visibleTo(viewer, actor) {
    return !!viewer?.actor
        && viewer.actor.fetchIsOnline?.() === true
        && !isBotSession(viewer)
        && distance2d(viewer.actor, actor) <= CLIENT_VISIBILITY_RADIUS;
}

function sendProjection(viewer, projection) {
    const actor = projection.actor;
    viewer.dataSendToMe(ServerResponse.charInfo(actor));
    viewer.dataSendToMe(ServerResponse.relationChanged(actor));
    const store = actor.fetchPrivateStore();
    viewer.dataSendToMe(store.storeType === BUY
        ? ServerResponse.privateStoreBuyMsg(actor, store.title)
        : ServerResponse.privateStoreMsg(actor, store.title));
    viewer.knownAfkTradeIds ||= new Set();
    viewer.knownAfkTradeIds.add(actor.fetchId());
}

function invalidateTradeWindows(actor) {
    (World.user?.sessions || []).forEach((viewer) => {
        if (viewer?.activeMerchantTrade?.merchant !== actor) return;
        viewer.activeMerchantTrade = null;
        viewer.viewedPrivateStoreSeller = null;
        viewer.dataSendToMe?.(ServerResponse.actionFailed());
    });
}

function removeProjection(ownerId) {
    return boardChange(() => removeProjectionEntry(ownerId));
}

function removeProjectionEntry(ownerId) {
    const projection = projectionsByOwner.get(Number(ownerId));
    if (!projection) return false;
    unindexProjection(projection);
    forgetEntry(projection);
    unindexLocation(projection);
    if (projection.session.botOwned && !projection.session.afkRepricing) {
        invoke('GameServer/Bot/Economy/BotNegotiationService').cleanup(projection.session, 'store_changed');
    }
    invalidateTradeWindows(projection.actor);
    const objectId = projection.actor.fetchId();
    (World.user?.sessions || []).forEach((viewer) => {
        if (!viewer?.knownAfkTradeIds?.has(objectId)) return;
        viewer.dataSendToMe?.(ServerResponse.deleteOb(objectId));
        viewer.knownAfkTradeIds.delete(objectId);
    });
    projectionsByOwner.delete(Number(ownerId));
    projectionsById.delete(objectId);
    projection.actor.attack?.destructor?.();
    projection.actor.automation?.destructor?.(projection.actor);
    return true;
}

function spawnProjection(shop) {
    return boardChange(() => spawnProjectionEntry(shop));
}

function spawnProjectionEntry(shop) {
    removeProjection(shop.ownerId);
    const projection = buildProjection(shop);
    projectionsByOwner.set(Number(shop.ownerId), projection);
    projectionsById.set(projection.actor.fetchId(), projection);
    indexProjection(projection);
    rememberEntry(projection);
    indexLocation(projection);
    (World.user?.sessions || []).forEach((viewer) => {
        if (visibleTo(viewer, projection.actor)) sendProjection(viewer, projection);
    });
    return projection;
}

function refreshProjection(shop) {
    if (!shop || shop.status !== 'active' || !(shop.lines || []).some((line) => Number(line.count) > 0)) {
        // Only the shop that closed leaves: a newer one may stand already.
        const current = shop ? projectionsByOwner.get(Number(shop.ownerId)) : null;
        if (current && Number(current.shop?.id) === Number(shop.id)) removeProjection(shop.ownerId);
        return null;
    }
    const projection = projectionsByOwner.get(Number(shop.ownerId));
    if (!projection) return spawnProjection(shop);
    const actor = projection.actor;
    const store = projectionStore(shop);
    const titleChanged = actor.fetchPrivateStore()?.title !== store.title;
    invalidateTradeWindows(actor);
    unindexProjection(projection);
    forgetEntry(projection);
    projection.shop = shop;
    if (store.botOwned) {
        projection.session.coldMarketState = { characterId: Number(shop.ownerId),
            stats: { marketStore: { id: `afk:${shop.id}`, ...store } } };
    }
    actor.setPrivateStore(store);
    actor.setPrivateStoreType(Number(shop.storeType));
    if (Number(shop.storeType) === SELL) {
        const equipped = actor.backpack.fetchItems()
            .filter((item) => item.fetchEquipped?.())
            .map((item) => ({ ...clone(item.model || {}), id: Number(item.fetchId()) }));
        actor.backpack.items = [];
        equipped.forEach((item) => actor.backpack.insertItem(item.id, item.selfId, item));
        store.items.forEach((line) => actor.backpack.insertItem(line.objectId, line.selfId, {
            name: line.name,
            amount: line.count,
            enchant: line.enchant,
            equipped: false,
            slot: line.slot
        }));
    }
    indexProjection(projection);
    rememberEntry(projection);
    if (titleChanged) {
        const packet = store.storeType === BUY
            ? ServerResponse.privateStoreBuyMsg(actor, store.title)
            : ServerResponse.privateStoreMsg(actor, store.title);
        for (const viewer of World.user?.sessions || []) {
            if (viewer.knownAfkTradeIds?.has(actor.fetchId()) && visibleTo(viewer, actor)) viewer.dataSendToMe(packet);
        }
    }
    return projection;
}

// An ad or an order: no actor, no place in the world; its store object is
// what offers() and the deals read.
function dropAd(id) {
    const entry = entriesById.get(Number(id));
    if (!entry || entry.actor) return false;
    unindexProjection(entry);
    forgetEntry(entry);
    return true;
}

// Puts a record as the database returned it into memory: a shop through its
// projection (the author's), an ad as an entry. A closed or empty record
// leaves memory.
function refreshRecord(shop) {
    return boardChange(() => refreshRecordEntry(shop));
}

function refreshRecordEntry(shop) {
    if (!shop) return null;
    if (kindOf(shop) === 'shop') return refreshProjection(shop);
    dropAd(shop.id);
    if (shop.status !== 'active' || !(shop.lines || []).some((line) => Number(line.count) > 0)) return null;
    const entry = { shop, store: projectionStore(shop), actor: null, indexedRecordId: null };
    indexProjection(entry);
    rememberEntry(entry);
    return entry;
}

// A renamed owner: its records on the board carry the new name (a shop's
// actor shows it to whoever looks next).
function renameOwner(ownerId, name) {
    for (const entry of ownerEntries(ownerId)) {
        entry.shop.ownerName = name;
        if (entry.actor) entry.actor.model.name = name;
    }
}

function ownerEntries(ownerId) {
    return [...(entriesByOwner.get(Number(ownerId))?.values() || [])];
}

function ownerRecords(ownerId) {
    return ownerEntries(ownerId).map((entry) => entry.shop);
}

// The current store object of a record (by its id), for a caller that kept
// an older one.
function recordStore(recordId) {
    return entryStore(entriesById.get(Number(recordId))) || null;
}

function refreshVisibility(session, actor = session?.actor) {
    if (!session || !actor || isBotSession(session)) return 0;
    const visible = new Set();
    const centerX = Math.floor(Number(actor.fetchLocX()) / VISIBILITY_CELL_SIZE);
    const centerY = Math.floor(Number(actor.fetchLocY()) / VISIBILITY_CELL_SIZE);
    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            for (const projection of projectionsByCell.get(`${centerX + dx}:${centerY + dy}`) || []) {
                const objectId = projection.actor.fetchId();
                if (!visibleTo(session, projection.actor)) continue;
                visible.add(objectId);
                if (!session.knownAfkTradeIds?.has(objectId)) sendProjection(session, projection);
            }
        }
    }
    session.knownAfkTradeIds ||= new Set();
    [...session.knownAfkTradeIds].forEach((objectId) => {
        if (visible.has(objectId) && projectionsById.has(objectId)) return;
        session.dataSendToMe?.(ServerResponse.deleteOb(objectId));
        session.knownAfkTradeIds.delete(objectId);
    });
    return visible.size;
}

function refreshActorInventory(actor, rows) {
    if (!actor?.backpack || !Array.isArray(rows)) return;
    actor.backpack.items = [];
    rows.forEach((row) => actor.backpack.insertItem(Number(row.id), Number(row.selfId), { ...row }));
}

function syncOnlineInventory(characterId, rows) {
    const session = onlineSession(characterId);
    if (!session?.actor) return null;
    refreshActorInventory(session.actor, rows);
    if (!isBotSession(session)) {
        session.dataSendToMe?.(ServerResponse.itemsList(session.actor.backpack.fetchItems()));
        session.dataSendToMe?.(ServerResponse.userInfo(session.actor));
    }
    return session;
}

function tradeMessage(event) {
    const action = event.kind === 'purchase' ? 'AFK BUY' : 'AFK SALE';
    const verb = event.kind === 'purchase' ? 'Bought' : 'Sold';
    return `[${action}] ${verb} ${event.amount}x ${event.itemName || itemName(event.selfId)} for ${event.totalPrice} Adena.`;
}

async function deliverNotifications(session) {
    const ownerId = Number(session?.actor?.fetchId?.() || 0);
    if (!ownerId || isBotSession(session)) return 0;
    const events = await Database.fetchAfkTradeNotifications(ownerId, 50);
    if (!events.length) return 0;
    events.forEach((event) => commandMessage(session, tradeMessage(event)));
    // A login backlog gets one sound, not one overlapping sound per trade.
    session.dataSendToMe(ServerResponse.playSound('ItemSound.quest_itemget'));
    await Database.markAfkTradeNotificationsDelivered(ownerId, events.map((event) => event.id));
    return events.length;
}

async function notifyCommitted(result, kind) {
    const ownerId = Number(result.shop?.ownerId || 0);
    const owner = onlineSession(ownerId);
    if (!owner || isBotSession(owner)) return;
    const event = {
        id: result.eventId,
        kind,
        selfId: result.line.selfId,
        itemName: result.line.name,
        amount: result.amount,
        totalPrice: result.totalPrice
    };
    commandMessage(owner, tradeMessage(event));
    owner.dataSendToMe(ServerResponse.playSound('ItemSound.quest_itemget'));
    await Database.markAfkTradeNotificationsDelivered(ownerId, [result.eventId]);
}

async function syncColdCharacter(characterId, previousState, reason, rows = [], options = {}) {
    // The shop write fenced a row the cold worker leases (Database
    // fenceAfkTradePartiesUnsafe): that row is the new state, and a save here
    // would be refused. The worker's retry starts from this cached row.
    const fenced = options.coldLifeRows?.[Number(characterId)];
    if (fenced) return require('../Bot/Economy/EconomyCommit').acceptRow(fenced);
    if (!previousState) return null;
    // A hot row belongs to the actor in the world: syncOnlineInventory has
    // refreshed its backpack and markCold writes the row. A cold snapshot written here would flip it to cold and roll back
    // the experience and location earned while hot.
    if (invoke('GameServer/Bot/Population/BotLifeState').hotRow(characterId)) return null;
    try {
        const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
        const synced = await LifeState.syncExternalInventory(
            Number(characterId),
            reason,
            previousState,
            { autoEquip: options.autoEquip }
        );
        if (synced) return synced;
        const inventory = LifeState.inventorySummaryFromItems(rows);
        return {
            ...previousState,
            adena: Number(inventory['57']?.amount || 0),
            inventory,
            stats: { ...(previousState.stats || {}), lastReason: `${reason}_pending_state_persist` },
            updatedAt: Date.now()
        };
    } catch (error) {
        utils.infoWarn('AfkTrade', 'cold inventory sync failed for %d: %s', characterId, error.message);
        const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
        const inventory = LifeState.inventorySummaryFromItems(rows);
        return {
            ...previousState,
            adena: Number(inventory['57']?.amount || 0),
            inventory,
            stats: { ...(previousState.stats || {}), lastReason: `${reason}_pending_state_persist` },
            updatedAt: Date.now()
        };
    }
}

// What a cold job continues with after a committed AFK trade. The trade is
// done either way. When the bot went hot while the job awaited it, the actor
// holds the result (syncOnlineInventory) and no cold state is synced: the job
// counts the trade, keeps its own state and writes nothing more for the bot
// (LifeState.save rejects a cold row over a hot one).
function committedTrade(trade, characterId) {
    if (trade?.pending) return { committed: false, pending: true, hot: false, state: invoke('GameServer/Bot/Population/BotLifeState').cachedState(characterId) };
    // Hot first: a bot activated after the sync's own check gets a made-up
    // pending state whose write is rejected; the job must stop all the same.
    if (invoke('GameServer/Bot/Population/BotLifeState').hotRow(characterId)) return { committed: true, hot: true, state: null };
    if (trade?.coldState) return { committed: true, hot: false, state: trade.coldState };
    return { committed: false, hot: false, state: null };
}

// What a deal left for cold bots on the board reaches them now, unless the
// worker leases them (its commit merges it): a main-thread save of each.
async function settleOwners(ownerIds = []) {
    const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
    const leasedBy = invoke('GameServer/Bot/Population/ColdSimulationOwner').OWNER_ID;
    for (const ownerId of new Set((ownerIds || []).map(Number).filter(Boolean))) {
        if (LifeState.cachedState(ownerId)?.simulation?.ownerId === leasedBy) continue;
        let result;
        try {
            result = await Database.settleBoardOwner(ownerId);
        } catch (error) {
            // It stays on the board; the next tick tries again.
            utils.infoWarn('AfkTrade', 'settlement for %d waits: %s', ownerId, error.message);
            continue;
        }
        if (!result.settled) continue;
        if (result.row) LifeState.acceptLifecycleRow(result.row);
        syncOnlineInventory(ownerId, result.ownerInventory);
    }
}

async function finalizeTrade(result, kind, counterpartyId, previousState = null, options = {}) {
    const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
    if (result.replayed) {
        syncOnlineInventory(counterpartyId, result.counterpartyInventory);
        const row = result.coldLifeRows?.[Number(counterpartyId)];
        const coldState = row ? require('../Bot/Economy/EconomyCommit').acceptRow(row) : null;
        return { ...result, coldState };
    }
    for (const [id, counts] of Object.entries(result.marketTrades || {})) {
        LifeState.acceptMarketTrades(Number(id), counts);
        const session = onlineSession(Number(id));
        for (const key of ['coldLifeState', 'coldMarketState', 'coldCraftState']) {
            if (session?.[key]) session[key] = { ...session[key],
                marketTrades: LifeState.snapshot(Number(id))?.marketTrades || counts };
        }
        if (session) refreshPartyMemberships([session], invoke);
    }
    MarketCounters.deal(result.line?.selfId, result.line?.price, result.amount, Date.now(),
        kind === 'sale' ? result.shop?.ownerId : counterpartyId, result.shop?.town || null,
        kind === 'sale' ? counterpartyId : result.shop?.ownerId);
    syncOnlineInventory(result.shop.ownerId, result.ownerInventory);
    syncOnlineInventory(counterpartyId, result.counterpartyInventory);
    await settleOwners(result.settlementOwners);
    const coldState = await syncColdCharacter(
        counterpartyId,
        previousState,
        `afk_trade_${kind}`,
        result.counterpartyInventory,
        { ...options, coldLifeRows: result.coldLifeRows }
    );
    refreshRecord(result.shop);
    await notifyCommitted(result, kind);
    if (invoke('GameServer/Skills/SkillBookCatalog').isBook(Number(result.line?.selfId))) {
        const buyer = onlineSession(kind === 'sale' ? counterpartyId : result.shop.ownerId);
        if (buyer && isBotSession(buyer)) {
            await invoke('GameServer/Bot/BotSkillTraining').review(buyer).catch((error) => {
                utils.infoWarn('BotSkills', 'training after book purchase failed: %s', error.message);
            });
        }
    }
    if (String(result.shop?.ownerAccount || '').startsWith('bot_')
        && Number(result.shop.storeType) === SELL && kindOf(result.shop) === 'shop') {
        await invoke('GameServer/Bot/Economy/BotAfkMarketService').pruneResourceLots(result.shop.ownerId);
    }
    return { ...result, coldState };
}

function commandMessage(session, text) {
    session?.dataSendToMe?.(ServerResponse.systemMessage.text(text));
}

async function stop(session) {
    const ownerId = Number(session?.actor?.fetchId?.() || session || 0);
    if (!ownerId) return { stopped: false };
    const cachedState = invoke('GameServer/Bot/Population/BotLifeState').snapshot(ownerId);
    const ownerState = findOwnerProjection(ownerId)?.actor?.fetchPrivateStore?.()?.botOwned
        || String(cachedState?.accountName || '').startsWith('bot_') ? cachedState : null;
    const result = await Database.closeAfkTradeShop(ownerId);
    removeProjection(ownerId);
    syncOnlineInventory(ownerId, result.ownerInventory);
    if (ownerState) await syncColdCharacter(ownerId, ownerState, 'afk_trade_closed', result.ownerInventory,
        { coldLifeRows: result.coldLifeRows });
    if (session?.actor) {
        session.afkTradeDraft = null;
        session.actor.setPrivateStoreType?.(0);
        session.actor.setPrivateStore?.(null);
        session.actor.state?.setSeated?.(false);
        session.dataSendToMeAndOthers?.(ServerResponse.sitAndStand(session.actor), session.actor);
        session.dataSendToOthers?.(ServerResponse.charInfo(session.actor), session.actor);
        commandMessage(session, result.closed ? 'AFK trade stopped. Reserved assets returned.' : 'You do not have an active AFK trade.');
    }
    return { ...result, stopped: result.closed };
}

// A bot opens a record from its bag: its shop (replacing the one it has) or
// an ad (`config.kind`).
async function publishBot(ownerId, config) {
    const characterId = Number(ownerId);
    const kind = config?.kind || 'shop';
    if (!characterId || !BoardRules.isKind(kind) || ![SELL, BUY].includes(BoardRules.storeTypeFor(kind, config?.storeType))) {
        throw new Error('invalid_bot_afk_trade');
    }
    const result = await Database.createAfkTradeShop(characterId, { ...config, kind, replace: kind === 'shop' });
    await syncOwnerAfterMove(characterId, result, 'bot_afk_trade_published');
    if (kind === 'shop') spawnProjection(result.shop);
    else refreshRecord(result.shop);
    return result.shop;
}

// The owner's own move took from or gave back to its bag: the actor and the
// bot's cold state follow (the author's sync after a publish).
async function syncOwnerAfterMove(ownerId, result, reason) {
    syncOnlineInventory(ownerId, result.ownerInventory);
    const ownerState = invoke('GameServer/Bot/Population/BotLifeState').snapshot(ownerId);
    if (ownerState) await syncColdCharacter(ownerId, ownerState, reason, result.ownerInventory,
        { coldLifeRows: result.coldLifeRows });
}

// A bot's records of one kind become `configs` in one move (its buy ads
// follow its goal). `expected` maps the records it saw to their revisions.
async function replaceBotRecords(ownerId, kind, configs, options = {}) {
    const characterId = Number(ownerId);
    const diagnostics = require('../Bot/Economy/EconomyDiagnostics');
    const observed = kind === 'buy_ad' && diagnostics.enabled(characterId);
    const reserve = observed ? () => board.ownerLines(characterId).filter(line => line.kind === 'buy_ad' && line.custodyPolicy !== 1)
        .reduce((sum, line) => sum + line.count * line.price, 0) : null;
    const oldReserve = observed ? reserve() : 0;
    let result;
    try { result = await Database.replaceBoardRecords(characterId, kind, configs, options); }
    catch (error) {
        if (observed) diagnostics.push({ owner: characterId, phase: 'buy_ad_reconcile', trigger: 'goal_review',
            reason: /^(economy_[a-z_]+|shop_changed|board_[a-z_]+|not_enough_adena)$/.test(error.message) ? error.message : 'native_refused',
            reserveDelta: 0 });
        throw error;
    }
    result.closed.forEach(refreshRecord);
    (result.changed || result.opened).forEach(refreshRecord);
    if (result.ownerInventory) await syncOwnerAfterMove(characterId, result, 'bot_board_records_replaced');
    if (observed) diagnostics.push({ owner: characterId, phase: 'buy_ad_reconcile', trigger: 'goal_review',
        reason: result.closed.length || result.opened.length || result.changed?.length ? 'changed' : 'unchanged',
        reserveDelta: reserve() - oldReserve, recordId: result.retained?.[0]?.id || result.opened?.[0]?.id,
        revision: result.retained?.[0]?.revision || result.opened?.[0]?.revision });
    return result;
}

// A bot opens several records of one kind from its bag in one move.
async function openBotRecords(ownerId, kind, configs) {
    const characterId = Number(ownerId);
    const result = await Database.openBoardRecords(characterId, kind, configs);
    result.opened.forEach(refreshRecord);
    await syncOwnerAfterMove(characterId, result, 'bot_board_records_opened');
    return result;
}

// The owner withdraws one of its records; what it holds comes back.
async function closeBotRecord(ownerId, recordId, options = {}) {
    const characterId = Number(ownerId);
    const result = await Database.closeBoardRecord(characterId, recordId, options);
    if (!result.closed) return result;
    refreshRecord(result.record);
    await syncOwnerAfterMove(characterId, result, 'bot_board_record_closed');
    return result;
}

// The leave rule (design 2.7): an owner leaving the game closes all its
// records; items and escrow go back to it.
async function leave(ownerId) {
    const characterId = Number(ownerId);
    const result = await Database.closeOwnerBoardRecords(characterId);
    result.closed.forEach(refreshRecord);
    syncOnlineInventory(characterId, result.ownerInventory);
    await settleOwners(result.settlementOwners);
    return result;
}

async function repriceBot(ownerId, lineId, price, expectedRevision = null, quantity = null) {
    const current = ownerEntries(ownerId).find((entry) => (entryStore(entry)?.items || [])
        .some((line) => Number(line.afkTradeLineId) === Number(lineId)));
    const store = entryStore(current);
    if (!store?.botOwned) throw new Error('bot_afk_trade_unavailable');
    const line = store.items.find(item => Number(item.afkTradeLineId) === Number(lineId));
    const rival = board.first(Number(line.selfId), Number(store.storeType),
        { excludeOwner: Number(ownerId), enchant: 0 })?.price || 0;
    const result = await Database.repriceAfkTradeShop(ownerId, lineId, price, expectedRevision, quantity, rival);
    await syncAfterReprice(ownerId, result);
    refreshRecord(result.shop);
    return entriesById.get(Number(result.shop?.id))?.shop || null;
}

// A bot's look reprices several of its lines (E59): one transaction, and the
// syncs only when an item or Adena moved. Returns { changed, skipped }.
async function repriceBotLines(ownerId, reprices = [], { withdrawals = [], updates = [],
    coldAuthority = null, hotAuthority = null, canCommitReview = null } = {}) {
    const botLines = new Set();
    for (const entry of ownerEntries(ownerId)) {
        const store = entryStore(entry);
        if (store?.botOwned) for (const line of store.items || []) botLines.add(Number(line.afkTradeLineId));
    }
    const owned = reprices.filter((reprice) => botLines.has(Number(reprice.lineId)));
    const leaving = withdrawals.filter((move) => botLines.has(Number(move.lineId)));
    const observations = updates.filter((move) => botLines.has(Number(move.lineId)));
    if (!owned.length && !leaving.length && !observations.length) return { changed: 0, updated: 0,
        skipped: reprices.length + withdrawals.length + updates.length };
    const result = await Database.repriceBoardLines(ownerId, owned,
        { withdrawals: leaving, updates: observations, coldAuthority, hotAuthority, canCommitReview });
    await syncAfterReprice(ownerId, result);
    result.shops.forEach(refreshRecord);
    return { changed: result.changed, updated: result.updated,
        skipped: reprices.length - owned.length + withdrawals.length - leaving.length
            + updates.length - observations.length + result.skipped.length };
}

// A reprice that moved an item or Adena: the actor and the bot's cold state
// follow its bag (the author's sync after a publish). A price-only change
// moved nothing: no inventory to read, no state to save.
async function syncAfterReprice(ownerId, result) {
    if (!result.ownerInventory) return;
    syncOnlineInventory(ownerId, result.ownerInventory);
    const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
    const ownerState = LifeState.snapshot(ownerId);
    if (ownerState) await syncColdCharacter(ownerId, ownerState, 'bot_afk_trade_repriced', result.ownerInventory,
        { coldLifeRows: result.coldLifeRows });
    invoke('GameServer/Bot/Economy/BotAfkMarketService').rememberInventory(ownerId, LifeState.snapshot(ownerId));
}

// A failed publish or relocation leaves the owner's shop as it was: its place
// goes back to where the shop still stands (or is freed when none stands).
function restorePlace(ownerId) {
    const projection = projectionsByOwner.get(Number(ownerId));
    if (projection) ShopPlaces.occupy(ShopPlaces.afkOwner(ownerId), projection.shop.town, projection.shop);
    else ShopPlaces.release(ShopPlaces.afkOwner(ownerId));
}

// Every record on the board: shops and ads (an ad is a shout heard in every
// town, design 4.2).
function activeShops() {
    return [...entriesById.values()].map((entry) => entry.shop);
}

async function begin(session, storeType) {
    const actor = session?.actor;
    if (!actor || isBotSession(session) || ![SELL, BUY].includes(Number(storeType))) return false;
    if (!utils.isInPeaceZone(actor.fetchLocX(), actor.fetchLocY())) {
        commandMessage(session, 'AFK trade can only be opened in a peace zone.');
        return false;
    }
    if (actor.isDead?.() || actor.fetchMounted?.() || actor.state?.fetchCasts?.() || actor.state?.fetchHits?.()) {
        commandMessage(session, 'You cannot open AFK trade right now.');
        return false;
    }
    const existing = projectionsByOwner.has(Number(actor.fetchId()));
    if (existing) await stop(actor.fetchId());
    session.afkTradeDraft = Number(storeType);
    const opened = invoke('GameServer/PrivateStore').open(session, Number(storeType));
    if (!opened) session.afkTradeDraft = null;
    else commandMessage(session, `Configure the AFK ${storeType === SELL ? 'sell' : 'buy'} shop in the standard store window.`);
    return opened;
}

async function activate(session, store) {
    const actor = session?.actor;
    const storeType = Number(store?.storeType || 0);
    if (!actor || Number(session.afkTradeDraft) !== storeType || ![SELL, BUY].includes(storeType)) return false;
    if (storeType === SELL && store.packageSale) {
        commandMessage(session, 'Package sale is not supported for AFK trade. Disable package sale and try again.');
        return false;
    }
    const lines = (store.items || []).map((line) => {
        const inventoryItem = storeType === SELL ? actor.backpack.fetchItemRaw(line.objectId) : null;
        const selfId = Number(line.selfId || inventoryItem?.fetchSelfId?.() || 0);
        return {
            objectId: Number(line.objectId || 0),
            selfId,
            name: inventoryItem?.fetchName?.() || itemName(selfId),
            count: Number(line.count),
            price: Number(line.price),
            enchant: Number(line.enchant ?? inventoryItem?.fetchEnchantLevel?.() ?? 0),
            slot: Number(inventoryItem?.fetchSlot?.() || itemTemplate(selfId)?.etc?.slot || 0),
            stackable: isStackable(selfId),
            petData: inventoryItem?.fetchPetData?.() || null
        };
    });
    const town = invoke('GameServer/Bot/BotAI').getClosestTownName(
        actor.fetchLocX(), actor.fetchLocY(), actor.fetchLocZ()
    );
    try {
        const created = await Database.createAfkTradeShop(actor.fetchId(), {
            storeType,
            title: store.title,
            town,
            locX: actor.fetchLocX(),
            locY: actor.fetchLocY(),
            locZ: actor.fetchLocZ(),
            head: actor.fetchHead(),
            appearance: appearanceSnapshot(actor),
            packageSale: store.packageSale,
            lines
        });
        session.afkTradeDraft = null;
        actor.setPrivateStoreType(0);
        actor.setPrivateStore(null);
        actor.state?.setSeated?.(false);
        syncOnlineInventory(actor.fetchId(), created.ownerInventory);
        session.dataSendToMeAndOthers?.(ServerResponse.sitAndStand(actor), actor);
        session.dataSendToOthers?.(ServerResponse.charInfo(actor), actor);
        spawnProjection(created.shop);
        // A deal needs someone in the town (design 4.4, 4.6, E45): bots who
        // want this shop's lines travel to it, nothing crosses from afar.
        commandMessage(session, 'AFK trade is active. Use .afkstop to close it remotely.');
        return true;
    } catch (error) {
        utils.infoWarn('AfkTrade', 'failed to activate shop for %s: %s', actor.fetchName(), error.message);
        commandMessage(session, `AFK trade could not be opened: ${error.message}`);
        return false;
    }
}

// A deal on one line of a record: options.lineId names it (a record may hold
// two lines of one item, at two enchants); without it the first with stock.
async function buyFromShop(characterId, store, selfId, amount, options = {}) {
    const line = (store?.items || []).find((entry) => (
        Number(entry.selfId) === Number(selfId)
        && (Number(entry.count) > 0 || options.economyCommand)
        && (!options.lineId || Number(entry.afkTradeLineId) === Number(options.lineId))
    ));
    if (!store?.afkTrade || Number(store.storeType) !== SELL || (!line && !options.economyCommand)) throw new Error('afk_trade_stock_changed');
    if (store.conditional) return require('./TradeMeetingService').trade(characterId, store, selfId, amount, options);
    const admission = await admitBotTrade(characterId, require('../Bot/Economy/EconomyCommit').KINDS.afkBuy, options);
    let result;
    try { result = await Database.buyFromAfkTradeShop(characterId, {
        shopId: store.shopId,
        ownerId: store.ownerId,
        lineId: options.lineId || line?.afkTradeLineId,
        amount,
        expectedPrice: options.expectedPrice ?? line?.price,
        expectedRevision: options.expectedRevision,
        economyCommand: admission.command,
        validate: admission.validate,
        funding: options.funding,
        autoEquip: options.autoEquip
    }); } finally { require('../Bot/Economy/EconomyCommit').finish(characterId, admission.command); }
    return deliverTrade({ ...result, economyCommand: admission.command }, 'sale', characterId, admission.state || options.coldState, options);
}

async function sellToShop(characterId, store, selfId, amount, options = {}) {
    const line = (store?.items || []).find((entry) => (
        Number(entry.selfId) === Number(selfId)
        && (Number(entry.count) > 0 || options.economyCommand)
        && (!options.lineId || Number(entry.afkTradeLineId) === Number(options.lineId))
    ));
    if (!store?.afkTrade || Number(store.storeType) !== BUY || (!line && !options.economyCommand)) throw new Error('afk_trade_demand_changed');
    if (store.conditional) return require('./TradeMeetingService').trade(characterId, store, selfId, amount, options);
    const admission = await admitBotTrade(characterId, require('../Bot/Economy/EconomyCommit').KINDS.afkSell, options);
    let result;
    try { result = await Database.sellToAfkTradeShop(characterId, {
        shopId: store.shopId,
        ownerId: store.ownerId,
        lineId: options.lineId || line?.afkTradeLineId,
        objectId: options.objectId,
        amount,
        expectedPrice: options.expectedPrice ?? line?.price,
        expectedRevision: options.expectedRevision,
        economyCommand: admission.command,
        validate: admission.validate
    }); } finally { require('../Bot/Economy/EconomyCommit').finish(characterId, admission.command); }
    return deliverTrade({ ...result, economyCommand: admission.command }, 'purchase', characterId, admission.state || options.coldState, options);
}

async function admitBotTrade(characterId, kind, options) {
    const session = onlineSession(characterId);
    if (!options.coldState && !isBotSession(session) && !options.economyCommand) return {};
    const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
    const state = options.coldState || LifeState.cachedState(characterId);
    if (!state) throw Error('economy_owner_missing');
    const validate = session ? () => {
        if (onlineSession(characterId) !== session || session.actor?.isDead?.()) throw Error('economy_session_changed');
    } : null;
    validate?.();
    const admitted = await require('../Bot/Economy/EconomyCommit').admit(state, kind, options.economyCommand);
    // The original is retained by the caller for an ordinary retry.
    if (Object.isExtensible(options)) options.economyCommand = admitted.command;
    return { ...admitted, validate };
}

async function deliverTrade(result, kind, characterId, state, options) {
    try { return await finalizeTrade(result, kind, characterId, state, options); }
    catch (error) {
        // The physical transaction already committed. Auxiliary delivery may
        // wait, but a counter/notification failure cannot become a new debit.
        utils.infoWarn('AfkTrade', 'postcommit delivery waits for %d: %s', characterId, error.message || error);
        const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
        const row = result.coldLifeRows?.[Number(characterId)];
        const coldState = row ? require('../Bot/Economy/EconomyCommit').acceptRow(row) : LifeState.cachedState(characterId);
        return { ...result, coldState, deliveryPending: true };
    }
}

function findProjection(objectId) {
    return projectionsById.get(Number(objectId)) || null;
}

function findOwnerProjection(ownerId) {
    return projectionsByOwner.get(Number(ownerId)) || null;
}

// An index line as the offer the callers read: the record's store object and
// its line; a shop's projection, which stands in the world.
function offerOf(line, town = null) {
    const entry = line.ref;
    const store = entryStore(entry);
    const storeItem = (store?.items || []).find((item) => Number(item.afkTradeLineId) === line.lineId);
    if (!storeItem) return null;
    // A shop stands in the world; an ad has no actor and no place.
    const projection = entry.actor ? entry : null;
    return {
        ...offerFields(line, town),
        sourceName: projection ? projection.actor.fetchName() : (entry.shop.ownerName || `Trader ${store.ownerId}`),
        itemName: storeItem.name || itemName(line.selfId),
        projection,
        session: projection?.session || null,
        store,
        storeItem,
        locX: projection ? projection.actor.fetchLocX() : Number(entry.shop.locX || 0),
        locY: projection ? projection.actor.fetchLocY() : Number(entry.shop.locY || 0),
        locZ: projection ? projection.actor.fetchLocZ() : Number(entry.shop.locZ || 0)
    };
}

// The board's offers of an item on one side, every line of every record, best
// first (BoardIndex order): in `town` (records without a town count in every
// town) or in every town; never the `characterId`'s own; only `enchant` when
// given; `accept(offer)` filters, `limit` stops early.
function offers(selfId, storeType, options = {}) {
    const excluded = Number(options.characterId || 0);
    const enchant = options.enchant === undefined || options.enchant === null ? null : Number(options.enchant);
    const limit = Number(options.limit) > 0 ? Number(options.limit) : Infinity;
    const result = [];
    for (const line of board.list(selfId, storeType, options.town || null)) {
        if (excluded && line.ownerId === excluded) continue;
        if (enchant !== null && line.enchant !== enchant) continue;
        const offer = offerOf(line, options.town || null);
        if (!offer || (options.accept && !options.accept(offer))) continue;
        result.push(offer);
        if (result.length >= limit) break;
    }
    return result;
}

function activeDemandSelfIds() {
    return board.selfIds(BUY);
}

function clearBoard() {
    boardReady = false;
    notifyBoardChange({ reset: true, ready: false });
    stopTimers();
    for (const entry of entriesById.values()) {
        if (entry.indexedRecordId) TableChannel.shared.changed('board', { key: entry.indexedRecordId, removed: true });
    }
    projectionsByOwner.forEach((projection) => ShopPlaces.release(ShopPlaces.afkOwner(projection.shop.ownerId)));
    projectionsById.clear();
    projectionsByOwner.clear();
    projectionsByCell.clear();
    entriesById.clear();
    entriesByOwner.clear();
    board.clear();
    changedOwners.clear();
    changedItemIds.clear();
}

// Restores the board at start. The old world's bot records close once
// (Database.migrateBoardWorld); then every record comes back into memory.
async function init() {
    clearBoard();
    const migrated = await Database.migrateBoardWorld();
    // A cached bot state follows the bags and states the migration changed.
    const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
    (migrated.rows || []).forEach((row) => LifeState.acceptLifecycleRow(row));
    if (!migrated.skipped && (migrated.closedShops || migrated.cancelledStores)) {
        utils.infoSuccess('AfkTrade', 'board started: bot records closed=%d lines=%d escrow=%d owners=%d, cold stores cancelled=%d, kept records=%d',
            migrated.closedShops, migrated.closedLines, migrated.returnedEscrow, migrated.owners,
            migrated.cancelledStores, migrated.keptRecords);
    }
    // NodeL2 starts this after history/DataCache and before player listeners
    // or bot workers. Migrated open lines begin at the durable world counts.
    // Retained confirmed deals are an incomplete lower bound of the old world.
    // Preserve already committed counters; the once-only marker prevents replay.
    invoke('GameServer/Bot/AI/KnowledgeLearning').stages();
    const experience = await Database.initializeBotMarketTrades('history');
    (experience.rows || []).forEach(row => LifeState.acceptMarketTrades(row.characterId, row.marketTrades));
    for (;;) {
        const owners = await Database.fetchConditionalMigrationOwners();
        if (!owners.length) break;
        for (const owner of owners) {
            const migrated = await Database.migrateConditionalTradeAds(owner);
            if (migrated.row) LifeState.acceptLifecycleRow(migrated.row);
        }
        await new Promise(resolve => setImmediate(resolve));
    }
    await Database.initializeBoardPricing();
    const shops = await Database.fetchAfkTradeShops(null, { activeOnly: true });
    shops.forEach((shop) => (kindOf(shop) === 'shop' ? spawnProjection(shop) : refreshRecord(shop)));
    if (shops.length) utils.infoSuccess('AfkTrade', 'restored %d board records', shops.length);
    // The market counters learn the board's last deals again (group E, E58).
    MarketCounters.useSpots(() => invoke('GameServer/Bot/Population/SpotProfiles').ensure() || []);
    MarketCounters.reset();
    MarketCounters.load(await Database.fetchRecentBoardDeals({ perItem: MarketCounters.REPLAY_DEALS }));
    boardReady = true;
    await require('./TradeMeetingService').init();
    notifyBoardChange({ ready: true });
    startTimers();
    return shops.length;
}

function startTimers() {
    stopTimers();
    settleTimer = setInterval(() => {
        if (settling) return;
        settling = true;
        settlePending()
            .catch((error) => utils.infoWarn('AfkTrade', 'board settlement failed: %s', error.message))
            .finally(() => { settling = false; });
    }, SETTLE_TICK_MS);
    settleTimer.unref?.();
}

function stopTimers() {
    clearInterval(settleTimer);
    settleTimer = null;
}

// The owners with settlements still on the board (a lease ended without a
// commit, a settle that failed) get them merged.
function settlePending() {
    const owners = Database.boardSettlementOwners();
    return owners.length ? settleOwners(owners) : Promise.resolve();
}

module.exports = {
    BUY,
    SELL,
    restorePlace,
    activeShops,
    boardIndex: () => board,
    isBoardReady: () => boardReady,
    subscribeBoardChanges,
    offerOf,
    itemName,
    activeDemandSelfIds,
    activate,
    begin,
    buyFromShop,
    closeBotRecord,
    committedTrade,
    deliverNotifications,
    findOwnerProjection,
    findProjection,
    init,
    leave,
    offers,
    openBotRecords,
    ownerRecords,
    publishBot,
    recordStore,
    refreshRecord,
    replaceBotRecords,
    repriceBot,
    repriceBotLines,
    refreshVisibility,
    renameOwner,
    sellToShop,
    settleOwners,
    syncOnlineInventory,
    settlePending,
    stop,
    _resetForTests() {
        require('./TradeMeetingService').reset();
        [...projectionsByOwner.keys()].forEach(removeProjection);
        clearBoard();
    }
};
