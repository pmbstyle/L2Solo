const ServerResponse = invoke('GameServer/Network/Response');

const SELL = 1;
const BUY = 3;
const SELL_MANAGE = 2;
const BUY_MANAGE = 4;
const MAX_ROWS = 4;

function store(actor, type) {
    const current = actor.fetchPrivateStore?.();
    if (!current || current.ownerId !== actor.fetchId() || current.kind !== 'player' || current.storeType !== type) {
        actor.setPrivateStore({ kind: 'player', ownerId: actor.fetchId(), storeType: type, title: '', items: [] });
    }
    return actor.fetchPrivateStore();
}

function broadcast(session, actor, titlePacket) {
    // C4 handles the owner's sit/stand locally. The native private-store
    // transition only refreshes CharInfo and the shop title for observers;
    // sending CharInfo/UserInfo back to the owner after both Sell and Buy
    // transitions corrupts the old client-side status panel.
    session.dataSendToOthers?.(ServerResponse.charInfo(actor), actor);
    if (titlePacket) session.dataSendToOthers?.(titlePacket, actor);
}

function sendSitState(session, actor) {
    session.dataSendToMeAndOthers?.(ServerResponse.sitAndStand(actor), actor);
}

function canManage(actor) {
    return actor && !actor.isDead?.() && !actor.fetchMounted?.() && !actor.state?.fetchCasts?.() && !actor.state?.fetchHits?.();
}

function open(session, type) {
    const actor = session?.actor;
    if (!canManage(actor)) return false;
    const manageType = type === SELL ? SELL_MANAGE : BUY_MANAGE;
    actor.setPrivateStoreType(manageType);
    actor.state?.setSeated?.(false);
    sendSitState(session, actor);
    broadcast(session, actor);
    const current = store(actor, type);
    session.dataSendToMe(type === SELL
        ? ServerResponse.privateStoreManageListSell(actor, current)
        : ServerResponse.privateStoreManageListBuy(actor, current));
    return true;
}

function setTitle(session, type, value) {
    const actor = session?.actor;
    if (!actor || Number(actor.fetchPrivateStoreType()) !== (type === SELL ? SELL_MANAGE : BUY_MANAGE)) return false;
    store(actor, type).title = String(value || '').slice(0, 52);
    session.dataSendToMe(type === SELL ? ServerResponse.privateStoreMsg(actor, store(actor, type).title) : ServerResponse.privateStoreBuyMsg(actor, store(actor, type).title));
    return true;
}

function publishSell(session, packageSale, rows) {
    const actor = session?.actor;
    if (!actor || Number(actor.fetchPrivateStoreType()) !== SELL_MANAGE || !Array.isArray(rows) || rows.length < 1 || rows.length > MAX_ROWS) return false;
    const ids = new Set();
    const items = rows.map((row) => {
        const item = actor.backpack.fetchItemRaw(row.objectId);
        if (!item || item.fetchEquipped() || item.fetchSelfId() === 57 || !Number.isSafeInteger(row.count) || row.count < 1 || row.count > item.fetchAmount() || !Number.isSafeInteger(row.price) || row.price < 0 || ids.has(item.fetchId())) return null;
        ids.add(item.fetchId());
        return { objectId: item.fetchId(), selfId: item.fetchSelfId(), count: row.count, price: row.price };
    });
    if (items.some((row) => !row)) return false;
    const current = store(actor, SELL); current.items = items; current.packageSale = !!packageSale;
    actor.setPrivateStoreType(SELL); actor.state?.setSeated?.(true);
    sendSitState(session, actor);
    broadcast(session, actor, ServerResponse.privateStoreMsg(actor, current.title));
    return true;
}

function publishBuy(session, rows) {
    const actor = session?.actor;
    if (!actor || Number(actor.fetchPrivateStoreType()) !== BUY_MANAGE || !Array.isArray(rows) || rows.length < 1 || rows.length > MAX_ROWS) return false;
    const ids = new Set(); let total = 0;
    const items = rows.map((row) => {
        if (!Number.isSafeInteger(row.selfId) || row.selfId < 1 || !Number.isSafeInteger(row.count) || row.count < 1 || !Number.isSafeInteger(row.price) || row.price < 1 || ids.has(row.selfId)) return null;
        ids.add(row.selfId); total += row.count * row.price;
        return { selfId: row.selfId, enchant: row.enchant || 0, count: row.count, price: row.price };
    });
    if (items.some((row) => !row) || !Number.isSafeInteger(total) || total > actor.backpack.fetchTotalAdena()) return false;
    const current = store(actor, BUY); current.items = items;
    actor.setPrivateStoreType(BUY); actor.state?.setSeated?.(true);
    sendSitState(session, actor);
    broadcast(session, actor, ServerResponse.privateStoreBuyMsg(actor, current.title));
    return true;
}

function quit(session, type) {
    const actor = session?.actor;
    if (!actor || ![type, type === SELL ? SELL_MANAGE : BUY_MANAGE].includes(Number(actor.fetchPrivateStoreType()))) return false;
    actor.setPrivateStoreType(0); actor.state?.setSeated?.(false); sendSitState(session, actor); broadcast(session, actor); return true;
}

module.exports = { SELL, BUY, open, setTitle, publishSell, publishBuy, quit };
