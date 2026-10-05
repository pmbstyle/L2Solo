const ItemTemplateIndex = require('../Item/ItemTemplateIndex');
const BoardRules = require('./BoardRules');
const BoardExpiryQueue = require('./BoardExpiryQueue');
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
const pendingMatchContinuations = new Set();
let matchGeneration = 0;
const board = new BoardIndex();
// The board goes to the planning workers as the 'board' table (ColdTableChannel):
// a record with stock is one row (BoardIndex.rowOf), its key the record id;
// each worker builds the same index from it.
TableChannel.shared.register('board', {
    key: (row) => row[0],
    allRows: () => boardRows()
});

function boardRows() {
    const rows = [];
    for (const entry of entriesById.values()) if (entry.boardRow) rows.push(entry.boardRow);
    return rows;
}
// Record deadlines (12 h of server uptime), checked every EXPIRY_TICK_MS on
// the main thread; the clock beat records the server alive every BEAT_MS.
const expiryQueue = new BoardExpiryQueue();
const EXPIRY_TICK_MS = 5000;
const EXPIRY_BATCH = 64;
const BEAT_MS = 60 * 1000;
let expiryTimer = null;
let beatTimer = null;
let lastBeatAt = 0;
let expiring = false;
let expiryRun = Promise.resolve(0);

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
    TableChannel.shared.changed('board', row);
    projection.indexedRecordId = row[0];
    projection.boardRow = row;
}

// Every record, shop or ad, by id and by owner; its deadline in the queue.
function rememberEntry(entry) {
    const id = Number(entry.shop.id);
    const ownerId = Number(entry.shop.ownerId);
    entriesById.set(id, entry);
    const owned = entriesByOwner.get(ownerId) || new Map();
    owned.set(id, entry);
    entriesByOwner.set(ownerId, owned);
    const deadline = Number(entry.shop.expiresAt || 0);
    if (deadline > 0 && entry.queuedDeadline !== deadline) {
        expiryQueue.push(deadline, id);
        entry.queuedDeadline = deadline;
    }
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
        budgetBacked: Number(shop.storeType) === BUY,
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
    if (Number(projection.shop?.id) !== Number(shop.id)) projection.queuedDeadline = null;
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
    if (fenced) return invoke('GameServer/Bot/Population/BotLifeState').acceptLifecycleRow(fenced);
    if (!previousState) return null;
    // A hot row belongs to the actor in the world: syncOnlineInventory has
    // refreshed its backpack and markCold or syncMarketSession writes the
    // row. A cold snapshot written here would flip it to cold and roll back
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
    const result = await Database.replaceBoardRecords(characterId, kind, configs, options);
    result.closed.forEach(refreshRecord);
    result.opened.forEach(refreshRecord);
    await syncOwnerAfterMove(characterId, result, 'bot_board_records_replaced');
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

async function repriceBot(ownerId, lineId, price, expectedRevision = null, quantity = null, options = {}) {
    const current = ownerEntries(ownerId).find((entry) => (entryStore(entry)?.items || [])
        .some((line) => Number(line.afkTradeLineId) === Number(lineId)));
    if (!entryStore(current)?.botOwned) throw new Error('bot_afk_trade_unavailable');
    const result = await Database.repriceAfkTradeShop(ownerId, lineId, price, expectedRevision, quantity);
    syncOnlineInventory(ownerId, result.ownerInventory);
    const ownerState = invoke('GameServer/Bot/Population/BotLifeState').snapshot(ownerId);
    if (ownerState) await syncColdCharacter(ownerId, ownerState, 'bot_afk_trade_repriced', result.ownerInventory,
        { coldLifeRows: result.coldLifeRows });
    invoke('GameServer/Bot/Economy/BotAfkMarketService').rememberInventory(ownerId,
        invoke('GameServer/Bot/Population/BotLifeState').snapshot(ownerId));
    refreshRecord(result.shop);
    if (options.match !== false) await matchAfkOrders(ownerId);
    return entriesById.get(Number(result.shop?.id))?.shop || null;
}

// The best line on the other side that crosses an own line's price: the same
// item and enchant, another owner, a bot on at least one side. The other
// side's list is sorted best price first, so the walk stops at the first
// line whose price no longer crosses.
function crossingOffer(ownStore, line, ownerId) {
    const selling = ownStore.storeType === SELL;
    const price = Number(line.price);
    const enchant = Number(line.enchant || 0);
    for (const other of board.list(line.selfId, selling ? BUY : SELL)) {
        if (selling ? other.price < price : other.price > price) return null;
        if (other.ownerId === Number(ownerId) || other.enchant !== enchant) continue;
        if (!ownStore.botOwned && !other.botOwned) continue;
        const offer = offerOf(other);
        if (offer) return offer;
    }
    return null;
}

async function matchAfkOrders(ownerId, maxTrades = 64) {
    const batchLimit = Math.max(1, Math.min(64, Math.floor(Number(maxTrades) || 64)));
    const trades = [];
    for (let attempt = 0; attempt < batchLimit; attempt++) {
        // Every record of the owner (its shop and its ads) meets the board.
        let pair = null;
        for (const own of ownerEntries(ownerId)) {
            const ownStore = entryStore(own);
            for (const line of ownStore?.items || []) {
                const offer = crossingOffer(ownStore, line, ownerId);
                if (offer) { pair = { ownStore, line, offer }; break; }
            }
            if (pair) break;
        }
        if (!pair) break;
        const ownStore = pair.ownStore;
        const selling = ownStore.storeType === SELL;
        const seller = selling ? ownStore : pair.offer.store;
        const buyer = selling ? pair.offer.store : ownStore;
        const sellLine = selling ? pair.line : pair.offer.storeItem;
        const buyLine = selling ? pair.offer.storeItem : pair.line;
        let trade;
        try {
            trade = await Database.matchAfkTradeShops({
                sellerId: seller.ownerId, buyerId: buyer.ownerId,
                sellShopId: seller.shopId, buyShopId: buyer.shopId,
                sellLineId: sellLine.afkTradeLineId, buyLineId: buyLine.afkTradeLineId,
                sellRevision: seller.revision, buyRevision: buyer.revision,
                amount: Math.min(Number(sellLine.count), Number(buyLine.count))
            });
        } catch (error) {
            if (['afk_trade_shop_changed', 'afk_trade_offer_changed', 'afk_trade_budget_changed'].includes(error.message)) break;
            throw error;
        }
        // Records only: what each owner gets is in its bag (a player, a hot
        // actor) or waits on the board for a cold bot's next save.
        syncOnlineInventory(seller.ownerId, trade.sellerInventory);
        syncOnlineInventory(buyer.ownerId, trade.buyerInventory);
        await settleOwners(trade.settlementOwners);
        refreshRecord(trade.sellerShop);
        refreshRecord(trade.buyerShop);
        await notifyCommitted({ shop: trade.sellerShop, eventId: trade.sellerEventId,
            line: trade.line, amount: trade.amount, totalPrice: trade.totalPrice }, 'sale');
        await notifyCommitted({ shop: trade.buyerShop, eventId: trade.buyerEventId,
            line: trade.line, amount: trade.amount, totalPrice: trade.totalPrice }, 'purchase');
        trades.push(trade);
        const lotPolicy = invoke('GameServer/Bot/Economy/MarketLotPolicy');
        if (trade.sellerShop.ownerAccount?.startsWith('bot_') && kindOf(trade.sellerShop) === 'shop'
            && trade.sellerShop.lines.some(line => Number(line.count) > 0
                && lotPolicy.shot(line) && !lotPolicy.viable(line))) {
            await invoke('GameServer/Bot/Economy/BotAfkMarketService').pruneResourceLots(trade.sellerShop.ownerId);
        }
    }
    if (trades.length >= batchLimit && !pendingMatchContinuations.has(Number(ownerId))) {
        const owner = Number(ownerId);
        const generation = matchGeneration;
        pendingMatchContinuations.add(owner);
        setImmediate(() => {
            pendingMatchContinuations.delete(owner);
            if (generation !== matchGeneration) return;
            matchAfkOrders(owner, batchLimit).catch((error) => {
                utils.infoWarn('AfkTrade', 'continued matching failed for %d: %s', owner, error.message);
            });
        });
    }
    return { matched: trades.length > 0, trades };
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
        let matched = null;
        try {
            matched = await matchAfkOrders(actor.fetchId());
        } catch (error) {
            utils.infoWarn('AfkTrade', 'initial bot matching failed for %s: %s', actor.fetchName(), error.message);
        }
        if (matched?.matched) {
            utils.infoSuccess(
                'AfkTrade',
                'matched player shop %s trades=%d items=%d adena=%d',
                actor.fetchName(), matched.trades.length,
                matched.trades.reduce((sum, trade) => sum + Number(trade.amount || 0), 0),
                matched.trades.reduce((sum, trade) => sum + Number(trade.totalPrice || 0), 0)
            );
        }
        commandMessage(session, findOwnerProjection(actor.fetchId())
            ? 'AFK trade is active. Use .afkstop to close it remotely.'
            : 'AFK trade was filled immediately by bot demand.');
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
        && Number(entry.count) > 0
        && (!options.lineId || Number(entry.afkTradeLineId) === Number(options.lineId))
    ));
    if (!store?.afkTrade || Number(store.storeType) !== SELL || !line) throw new Error('afk_trade_stock_changed');
    const result = await Database.buyFromAfkTradeShop(characterId, {
        shopId: store.shopId,
        ownerId: store.ownerId,
        lineId: line.afkTradeLineId,
        amount,
        expectedPrice: options.expectedPrice ?? line.price,
        expectedRevision: options.expectedRevision
    });
    return finalizeTrade(result, 'sale', characterId, options.coldState, options);
}

async function sellToShop(characterId, store, selfId, amount, options = {}) {
    const line = (store?.items || []).find((entry) => (
        Number(entry.selfId) === Number(selfId)
        && Number(entry.count) > 0
        && (!options.lineId || Number(entry.afkTradeLineId) === Number(options.lineId))
    ));
    if (!store?.afkTrade || Number(store.storeType) !== BUY || !line) throw new Error('afk_trade_demand_changed');
    const result = await Database.sellToAfkTradeShop(characterId, {
        shopId: store.shopId,
        ownerId: store.ownerId,
        lineId: line.afkTradeLineId,
        objectId: options.objectId,
        amount,
        expectedPrice: options.expectedPrice ?? line.price,
        expectedRevision: options.expectedRevision
    });
    return finalizeTrade(result, 'purchase', characterId, options.coldState);
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
    expiryQueue.clear();
    board.clear();
}

// Restores the board at start. The old world's bot records close once
// (Database.migrateBoardWorld); the deadlines move by the downtime, so a record
// lives 12 hours of server uptime; then every record comes back into memory.
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
    const startedAt = Date.now();
    const aliveAt = await Database.fetchBoardAliveAt();
    const shifted = await Database.shiftBoardDeadlines(aliveAt > 0 ? Math.max(0, startedAt - aliveAt) : 0, startedAt);
    if (shifted.moved) utils.infoSuccess('AfkTrade', 'board deadlines moved by the downtime %d s (%d records)',
        Math.round(shifted.shift / 1000), shifted.moved);
    const shops = await Database.fetchAfkTradeShops(null, { activeOnly: true });
    shops.forEach((shop) => (kindOf(shop) === 'shop' ? spawnProjection(shop) : refreshRecord(shop)));
    if (shops.length) utils.infoSuccess('AfkTrade', 'restored %d board records', shops.length);
    startTimers(startedAt);
    return shops.length;
}

function startTimers(at = Date.now()) {
    stopTimers();
    lastBeatAt = at;
    expiryTimer = setInterval(() => {
        if (expiring) return;
        expireDue().catch((error) => utils.infoWarn('AfkTrade', 'board expiry failed: %s', error.message));
    }, EXPIRY_TICK_MS);
    expiryTimer.unref?.();
    beatTimer = setInterval(() => {
        beat().catch((error) => utils.infoWarn('AfkTrade', 'board clock failed: %s', error.message));
    }, BEAT_MS);
    beatTimer.unref?.();
}

function stopTimers() {
    clearInterval(expiryTimer);
    clearInterval(beatTimer);
    expiryTimer = null;
    beatTimer = null;
}

// The board's clock beat: the server is alive. A beat that comes far too
// late means the server did not run in between (the machine slept); no
// record lives through that time, so every deadline moves by it.
async function beat(at = Date.now()) {
    const gap = lastBeatAt > 0 ? at - lastBeatAt - BEAT_MS : 0;
    lastBeatAt = at;
    const shift = gap > BEAT_MS ? gap : 0;
    await Database.shiftBoardDeadlines(shift, at);
    if (!shift) return 0;
    expiryQueue.clear();
    entriesById.forEach((entry) => {
        if (Number(entry.shop.expiresAt) > 0) entry.shop.expiresAt = Number(entry.shop.expiresAt) + shift;
        entry.queuedDeadline = null;
        rememberEntry(entry);
    });
    return shift;
}

// Closes the records whose deadline passed, a batch per tick; then merges
// what waits on the board for bots the worker does not lease. One run at a
// time: a call during a run waits for it.
function expireDue(at = Date.now()) {
    const run = expiryRun.then(() => expireOnce(at));
    expiryRun = run.catch(() => 0);
    return run;
}

async function expireOnce(at) {
    expiring = true;
    try {
        const due = [];
        while (expiryQueue.peekDeadline() <= at && due.length < EXPIRY_BATCH) {
            const next = expiryQueue.pop();
            const entry = entriesById.get(next.id);
            if (!entry || Number(entry.shop.expiresAt) !== next.deadline) continue;
            entry.queuedDeadline = null;
            due.push(next.id);
        }
        let closed = [];
        if (due.length) {
            const result = await Database.expireBoardRecords(due, at);
            closed = result.closed;
            closed.forEach((shop) => {
                refreshRecord(shop);
                const owner = onlineSession(shop.ownerId);
                syncOnlineInventory(shop.ownerId, result.ownerInventories?.[shop.ownerId]);
                if (owner && !isBotSession(owner)) commandMessage(owner, 'AFK trade expired. Reserved assets returned.');
            });
        }
        await settlePending();
        return closed.length;
    } finally {
        expiring = false;
    }
}

// The owners with settlements still on the board (a lease ended without a
// commit, a settle that failed) get them merged.
function settlePending() {
    const owners = Database.boardSettlementOwners();
    return owners.length ? settleOwners(owners) : Promise.resolve();
}

async function matchBotDemand() {
    const ready = await invoke('GameServer/Bot/Population/BotLifeState').init();
    if (!ready) return { matched: false, shops: 0, trades: 0, itemCount: 0, adena: 0 };

    const summaries = [];
    for (const ownerId of [...entriesByOwner.keys()]) {
        const peer = await matchAfkOrders(ownerId);
        if (peer.matched) summaries.push({
            trades: peer.trades,
            itemCount: peer.trades.reduce((sum, trade) => sum + Number(trade.amount || 0), 0),
            adena: peer.trades.reduce((sum, trade) => sum + Number(trade.totalPrice || 0), 0)
        });
    }
    const result = {
        matched: summaries.length > 0,
        shops: summaries.length,
        trades: summaries.reduce((sum, summary) => sum + Number(summary.trades?.length || 0), 0),
        itemCount: summaries.reduce((sum, summary) => sum + Number(summary.itemCount || 0), 0),
        adena: summaries.reduce((sum, summary) => sum + Number(summary.adena || 0), 0)
    };
    if (result.matched) {
        utils.infoSuccess(
            'AfkTrade',
            'matched restored shops=%d trades=%d items=%d adena=%d',
            result.shops, result.trades, result.itemCount, result.adena
        );
    }
    return result;
}

module.exports = {
    BUY,
    SELL,
    restorePlace,
    activeShops,
    boardIndex: () => board,
    offerOf,
    activeDemandSelfIds,
    activate,
    beat,
    begin,
    buyFromShop,
    closeBotRecord,
    committedTrade,
    deliverNotifications,
    expireDue,
    findOwnerProjection,
    findProjection,
    init,
    leave,
    matchBotDemand,
    matchAfkOrders,
    offers,
    openBotRecords,
    ownerRecords,
    publishBot,
    recordStore,
    refreshRecord,
    replaceBotRecords,
    repriceBot,
    refreshVisibility,
    renameOwner,
    sellToShop,
    settleOwners,
    settlePending,
    stop,
    _resetForTests() {
        matchGeneration += 1;
        pendingMatchContinuations.clear();
        [...projectionsByOwner.keys()].forEach(removeProjection);
        clearBoard();
    }
};
