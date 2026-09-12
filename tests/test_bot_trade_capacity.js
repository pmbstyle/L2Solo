const assert = require('assert');
require('../src/Global');
const Database = invoke('Database');
const Trade = invoke('GameServer/Bot/BotTradeService');
const Item = invoke('GameServer/Item/Item');

function item(id, selfId = id, amount = 1, stackable = true) {
    return new Item(id, { selfId, name: `Item ${selfId}`, kind: 'Other.Material', amount, stackable, equipped: false, slot: 0 });
}
function session(id, items, bot = false) {
    return {
        accountId: `${bot ? 'bot' : 'player'}_capacity_${id}`, dataSendToMe() {},
        actor: {
            fetchId: () => id, fetchName: () => `Trader ${id}`, fetchIsOnline: () => true,
            fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0, isDead: () => false,
            backpack: { fetchItems: () => items, fetchItemRaw: (key) => items.find((entry) => entry.fetchId() === Number(key)) }
        }
    };
}
const slots = (count, base) => Array.from({ length: count }, (_, i) => item(base + i));
const original = Database.transferInventoryBetweenCharacters;
let databaseCalls = 0;
// Reaching persistence proves admission; stop there so each fixture stays immutable.
Database.transferInventoryBetweenCharacters = async () => { databaseCalls++; throw new Error('capacity admission probe'); };
async function check(label, playerItems, botItems, playerOffer, botOffer, blocked = null) {
    const player = session(900, playerItems);
    const bot = session(901, botItems, true);
    bot.partyCompanion = true;
    bot.followPlayerSession = player;
    assert(Trade.startBotTrade(bot, player).ok, label);
    for (const [id, count] of playerOffer) assert(Trade.addItem(player, id, count).ok, label);
    for (const [id, count] of botOffer) assert(Trade.offerBotItem(bot, id, count).ok, label);
    const before = databaseCalls;
    const result = await Trade.commit(player);
    assert.strictEqual(result.reason, blocked ? 'inventory_capacity' : 'database_failed', label);
    assert.strictEqual(databaseCalls - before, blocked ? 0 : 1, label);
    if (blocked) assert.deepStrictEqual(result.capacityBlocked, blocked, label);
    Trade.cancel(player);
}
(async () => {
    try {
        await check('83-slot sender can give stockings to 15-slot bot', [...slots(82, 1000), item(5000, 471, 1, false)], slots(15, 2000), [[5000, 1]], []);
        await check('full bags can swap whole stacks', slots(80, 1000), slots(80, 2000), [[1000, 1]], [[2000, 1]]);
        await check('partial stack does not free a slot', [item(1000, 1000, 2), ...slots(79, 1001)], slots(80, 2000), [[1000, 1]], [[2000, 1]], { player: true, bot: false });
        await check('new stack needs a slot', [item(1000)], slots(80, 2000), [[1000, 1]], [], { player: false, bot: true });
        await check('existing stack fits full bag', [item(1000, 2000)], slots(80, 2000), [[1000, 1]], []);
        await check('multiple incoming rows share one new stack', [item(1000, 5000), item(1001, 5000)], slots(79, 2000), [[1000, 1], [1001, 1]], []);
        await check('nonstackable needs its own slot', [item(1000, 5000, 1, false)], slots(80, 2000), [[1000, 1]], [], { player: false, bot: true });
        await check('both receivers blocked', [item(1000, 1000, 2), ...slots(79, 1001)], [item(2000, 2000, 2), ...slots(79, 2001)], [[1000, 1]], [[2000, 1]], { player: true, bot: true });
        console.log('Bot trade capacity checks passed');
    } finally { Database.transferInventoryBetweenCharacters = original; }
})().catch((error) => { console.error(error); process.exitCode = 1; });
