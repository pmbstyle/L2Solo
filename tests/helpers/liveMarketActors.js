'use strict';
const assert = require('node:assert/strict');
const DB = invoke('Database'), Data = invoke('GameServer/DataCache');
const World = invoke('GameServer/World/World'), Item = invoke('GameServer/Item/Item');
const PrivateStore = invoke('GameServer/PrivateStore'), Life = invoke('GameServer/Bot/Population/BotLifeState');
const POINT = { locX: 83396, locY: 147904, locZ: -3400 };
let serial = 0;
async function character(bot = false, { classId = 1, race = 0, level = 30 } = {}) {
    const accountId = `${bot ? 'bot_' : ''}live_store_${++serial}`;
    await DB.createAccount(accountId, 'test');
    const name = `LiveStore${serial}`;
    const id = Number((await DB.createCharacter(accountId, { name, race, classId,
        maxHp: 100, maxMp: 100, level, sex: 0, face: 0, hair: 0, hairColor: 0, ...POINT })).insertId);
    await DB.setItem(id, { selfId: 57, name: 'Adena', amount: 1000000, equipped: false, slot: 0 });
    const session = { accountId, botSession: bot, plan: 'shopping', packets: [],
        dataSendToMe(packet) { this.packets.push(packet); }, dataSendToOthers() {}, dataSendToMeAndOthers() {} };
    const actor = { session, point: { ...POINT }, storeType: 0, store: null, seated: false, mp: 1000, recipeBook: [], craftLevel: 0,
        fetchId: () => id, fetchName: () => name, fetchLevel: () => level, fetchClassId: () => classId,
        fetchMp() { return this.mp; }, setMp(value) { this.mp = value; },
        fetchMaxMp: () => 1000,
        fetchLocX() { return this.point.locX; }, fetchLocY() { return this.point.locY; }, fetchLocZ() { return this.point.locZ; },
        fetchIsOnline: () => true, isDead: () => false,
        fetchPrivateStore() { return this.store; }, setPrivateStore(value) { this.store = value; },
        fetchPrivateStoreType() { return this.storeType; }, setPrivateStoreType(value) { this.storeType = value; },
        state: { setSeated(value) { actor.seated = value; }, fetchSeated: () => actor.seated },
        backpack: { items: [], paperdoll: {},
            fetchItems() { return this.items; }, fetchItemRaw(id) { return this.items.find(item => item.fetchId() === id); },
            fetchItemFromSelfId(id) { return this.items.find(item => item.fetchSelfId() === id); },
            fetchEquippedWeapon() { return this.items.find(item => item.fetchEquipped() && item.fetchSlot() === 7); },
            fetchTotalAdena() { return this.fetchItemFromSelfId(57)?.fetchAmount() || 0; },
            fetchRecipeBook: () => actor.recipeBook,
            fetchDwarvenCraftLevel: () => actor.craftLevel,
            fetchCommonCraftLevel: () => actor.craftLevel,
            insertItem(objectId, selfId, row) {
                const template = Data.items.find(item => item.selfId === selfId);
                const item = new Item(objectId, { ...template?.etc, ...row, selfId, kind: template?.template?.kind });
                this.items.push(item); return item;
            } }
    };
    session.actor = actor;
    World.user.sessions.push(session);
    await refresh(session);
    return session;
}
async function refresh(session) {
    session.actor.backpack.items = [];
    const rows = await DB.fetchItems(session.actor.fetchId());
    for (const row of rows) session.actor.backpack.insertItem(row.id, row.selfId, row);
    if (session.botSession) session.coldLifeState = { characterId: session.actor.fetchId(), phase: 'hot',
        accountName: session.accountId, name: session.actor.fetchName(),
        activity: 'shopping', level: session.actor.fetchLevel(), spotId: '-10_30', currentRegion: 'Giran', loc: { ...POINT },
        adena: session.actor.backpack.fetchTotalAdena(), inventory: Life.inventorySummaryFromItems(rows),
        vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
        stats: { classId: session.actor.fetchClassId(), money: [77000, 1e-5, 1000, 0, 4e-5, 1000000, 1463] } };
    if (session.botSession) {
        const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
        const state = Economy.stateForActor(session.actor);
        const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
        session.coldLifeState.stats.huntEfficiency = [{ signature: Hunt.signature(state), spotId: '-10_30',
            at: Date.now(), samples: 3, cycleMs: 3600000, adena: 1000000, loot: 0, exp: 100000, kills: 1 }];
        // The kit rates its build publishes (stats.kitRates): main buys no kit for a bot no build rated.
        session.coldLifeState.stats.kitRates = Economy.kitRates(Economy.basics(Economy.stateForActor(session.actor)));
    }
}
async function stock(session, selfId, amount, enchant = 0, equipped = false, slot = 0) {
    const template = Data.items.find(item => item.selfId === selfId);
    const id = Number((await DB.setItem(session.actor.fetchId(), { selfId, name: template.template.name,
        amount, enchant, equipped, slot })).insertId);
    await refresh(session); return id;
}
function publish(session, rows) {
    session.actor.storeType = 2;
    assert.equal(PrivateStore.publishSell(session, false, rows), true);
    return session.actor.store;
}
const sqlAmount = async (session, selfId) => Number((await DB.execute([
    'SELECT COALESCE(SUM(amount),0) amount FROM items WHERE characterId=? AND selfId=?',
    [session.actor.fetchId(), selfId]]))[0].amount);
const memoryAmount = (session, selfId) => session.actor.backpack.fetchItems()
    .filter(item => item.fetchSelfId() === selfId).reduce((sum, item) => sum + item.fetchAmount(), 0);
const balances = async (...sessions) => Promise.all(sessions.map(async session => [
    await sqlAmount(session, 57), await sqlAmount(session, 1463), memoryAmount(session, 57), memoryAmount(session, 1463)]));


module.exports = { POINT, character, refresh, stock, publish, sqlAmount, memoryAmount, balances };
