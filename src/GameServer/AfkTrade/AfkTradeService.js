const Actor = invoke('GameServer/Actor/Actor');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const ServerResponse = invoke('GameServer/Network/Response');
const World = invoke('GameServer/World/World');

const SELL = 1;
const BUY = 3;
const PROJECTION_ID_BASE = 900000000;
const VISIBILITY_RADIUS = 6000;
const projectionsById = new Map();
const projectionsByOwner = new Map();

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
    return (DataCache.items || []).find((entry) => Number(entry.selfId) === Number(selfId)) || null;
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

class ProjectionSession {
    constructor(shop) {
        this.accountId = `afk_trade_${shop.ownerId}`;
        this.afkTradeProjection = true;
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
        budgetBacked: Number(shop.storeType) === BUY,
        shopId: Number(shop.id),
        ownerId: Number(shop.ownerId),
        storeType: Number(shop.storeType),
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
        && distance2d(viewer.actor, actor) <= VISIBILITY_RADIUS;
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
    (World.user?.sessions || []).forEach((viewer) => {
        if (visibleTo(viewer, projection.actor)) sendProjection(viewer, projection);
    });
    return projection;
}

function refreshProjection(shop) {
    if (!shop || shop.status !== 'active' || !(shop.lines || []).some((line) => Number(line.count) > 0)) {
        if (shop) removeProjection(shop.ownerId);
        return null;
    }
    const projection = projectionsByOwner.get(Number(shop.ownerId));
    if (!projection) return spawnProjection(shop);
    const actor = projection.actor;
    const store = projectionStore(shop);
    invalidateTradeWindows(actor);
    projection.shop = shop;
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
    return projection;
}

function refreshVisibility(session, actor = session?.actor) {
    if (!session || !actor || isBotSession(session)) return 0;
    const visible = new Set();
    projectionsById.forEach((projection, objectId) => {
        if (!visibleTo(session, projection.actor)) return;
        visible.add(objectId);
        if (!session.knownAfkTradeIds?.has(objectId)) sendProjection(session, projection);
    });
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
    events.forEach((event) => session.dataSendToMe(ServerResponse.speak(session.actor, {
        kind: 8,
        text: tradeMessage(event)
    })));
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
    owner.dataSendToMe(ServerResponse.speak(owner.actor, { kind: 8, text: tradeMessage(event) }));
    await Database.markAfkTradeNotificationsDelivered(ownerId, [result.eventId]);
}

async function syncColdCharacter(characterId, previousState, reason, rows = []) {
    if (!previousState) return null;
    try {
        const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
        const synced = await LifeState.syncExternalInventory(
            Number(characterId),
            reason,
            previousState
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

async function finalizeTrade(result, kind, counterpartyId, previousState = null) {
    syncOnlineInventory(result.shop.ownerId, result.ownerInventory);
    syncOnlineInventory(counterpartyId, result.counterpartyInventory);
    const coldState = await syncColdCharacter(
        counterpartyId,
        previousState,
        `afk_trade_${kind}`,
        result.counterpartyInventory
    );
    refreshProjection(result.shop);
    await notifyCommitted(result, kind);
    return { ...result, coldState };
}

function commandMessage(session, text) {
    session?.dataSendToMe?.(ServerResponse.speak(session.actor, { kind: 8, text }));
}

async function stop(session) {
    const ownerId = Number(session?.actor?.fetchId?.() || session || 0);
    if (!ownerId) return { stopped: false };
    const result = await Database.closeAfkTradeShop(ownerId);
    removeProjection(ownerId);
    syncOnlineInventory(ownerId, result.ownerInventory);
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
        commandMessage(session, 'AFK trade is active. Use .afkstop to close it remotely.');
        return true;
    } catch (error) {
        utils.infoWarn('AfkTrade', 'failed to activate shop for %s: %s', actor.fetchName(), error.message);
        commandMessage(session, `AFK trade could not be opened: ${error.message}`);
        return false;
    }
}

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
    return finalizeTrade(result, 'sale', characterId, options.coldState);
}

async function sellToShop(characterId, store, selfId, amount, options = {}) {
    const line = (store?.items || []).find((entry) => Number(entry.selfId) === Number(selfId) && Number(entry.count) > 0);
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

function offers(selfId, storeType, options = {}) {
    const town = options.town || null;
    const excluded = Number(options.characterId || 0);
    return [...projectionsByOwner.values()].flatMap((projection) => {
        const store = projection.actor.fetchPrivateStore();
        if (Number(store.storeType) !== Number(storeType) || Number(store.ownerId) === excluded) return [];
        if (town && store.town && String(store.town) !== String(town)) return [];
        const line = store.items.find((entry) => Number(entry.selfId) === Number(selfId) && Number(entry.count) > 0);
        if (!line) return [];
        return [{
            sourceType: storeType === SELL ? 'afk_player_store' : 'afk_player_buy_store',
            sourceId: Number(store.ownerId),
            sourceName: projection.actor.fetchName(),
            sellerKind: 'player',
            playerPriority: true,
            town: store.town || town,
            selfId: Number(line.selfId),
            itemName: line.name || itemName(line.selfId),
            price: Number(line.price),
            count: Number(line.count),
            available: true,
            projection,
            session: projection.session,
            store,
            storeItem: line,
            locX: projection.actor.fetchLocX(),
            locY: projection.actor.fetchLocY(),
            locZ: projection.actor.fetchLocZ()
        }];
    });
}

function activeDemandSelfIds() {
    return [...new Set([...projectionsByOwner.values()].flatMap((projection) => {
        const store = projection.actor.fetchPrivateStore?.();
        if (Number(store?.storeType) !== BUY) return [];
        return (store.items || []).filter((line) => Number(line.count) > 0).map((line) => Number(line.selfId));
    }))];
}

async function init() {
    projectionsById.clear();
    projectionsByOwner.clear();
    const shops = await Database.fetchAfkTradeShops(null, { activeOnly: true });
    shops.forEach((shop) => spawnProjection(shop));
    if (shops.length) utils.infoSuccess('AfkTrade', 'restored %d persistent AFK shops', shops.length);
    return shops.length;
}

module.exports = {
    BUY,
    SELL,
    activeDemandSelfIds,
    activate,
    begin,
    buyFromShop,
    deliverNotifications,
    findOwnerProjection,
    findProjection,
    init,
    offers,
    refreshVisibility,
    sellToShop,
    stop,
    _resetForTests() {
        [...projectionsByOwner.keys()].forEach(removeProjection);
        projectionsById.clear();
        projectionsByOwner.clear();
    }
};
