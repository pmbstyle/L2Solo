const assert = require('assert');
const { useRate } = require('./helpers/progressionRate');
const world = require('./fixtures/native_stock_world')();
const previousRate = process.env.L2NODE_PROGRESSION_RATE;
// The existing x10 world input matches the user's world. x1 may honestly
// prefer hunting without shots even with a large purse.
useRate('x10');
require('../src/Global');
const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const Exchange = invoke('GameServer/Clan/ClanWarehouseEquipmentService');
const ShotStock = invoke('GameServer/Inventory/ShotStock');
const Backpack = invoke('GameServer/Actor/Backpack');
const Actor = invoke('GameServer/Actor/Actor');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const World = invoke('GameServer/World/World');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const previousCatalog = { npc: World.npc, user: World.user, spots: SpotService.spots, profiles: SpotProfiles.cache };

// Shots are bought, never granted: a clan warehouse exchange restocks like any
// other weapon change, and only for a weapon.
async function main() {
    DataCache.init();
    const sword = DataCache.items.find((item) => item.etc?.rank === 'd' && item.template?.kind === 'Weapon.Sword' && item.etc?.slot === 7);
    assert(sword);
    Database.init();
    assert(Database.isReady());
    // One available authored camp, using the persisted native NPC mix and
    // a published coordinate belonging to the same native cell. No world spawn.
    // T43 table: at '-5_26' (lower loot after the Mobius spawns) a two-hour shot stock no longer pays; '4_22' is a level-23 camp where it does.
    const id = '4_22', table = require('../data/Bots/spot-table.json');
    const index = table.spots.findIndex(row => row[0] === id);
    const source = require('../data/Bots/spot-reward-npcs.json').rows.find(row => row[0] === id);
    assert(index >= 0 && source);
    const declared = { id, avgLevel: table.spots[index][1], density: table.spots[index][2],
        npcEntries: source[1].map(([selfId, count]) => ({ selfId, count })),
        npcSelfIds: source[1].map(([selfId]) => selfId), tags: [], tagsAuthoritative: true };
    const locations = source[1].flatMap(([selfId]) => invoke('GameServer/Knowledge/SpawnCatalog')
        .spawnsForNpc(selfId).flatMap(row => [...(row.definition.coords || []), ...(row.group.bounds || [])
            .map(point => ({ locX: point.locX, locY: point.locY, locZ: point.maxZ }))]));
    declared.center = locations.find(loc => SpotService.findCurrentSpot(loc, [declared]) === declared);
    assert(declared.center, 'the camp center is an unchanged published coordinate in its native cell');
    const levels = source[1].map(([selfId]) => Number(DataCache.npcs.find(row => row.selfId === selfId).template.level));
    declared.minLevel = Math.min(...levels); declared.maxLevel = Math.max(...levels);
    SpotService.spots = [invoke('GameServer/World/WorldAreaCatalog').decorateSpot(declared)]; SpotProfiles.reset();
    const spot = invoke('GameServer/Bot/AI/SpotIndex').spotById(
        SpotProfiles.ensure(), id);
    assert(spot && !spot.raidBoss, 'the member uses an actual ordinary hunting spot');
    assert.deepStrictEqual(spot.npcEntries, declared.npcEntries, 'the native profile preserves the persisted NPC mix');
    const Table = invoke('GameServer/Bot/AI/SpotValueTable');
    const originalValues = [false, true].map(shots => Table.value(id, 'dps', 25, shots));
    const sourceFile = require('node:path').join(process.env.L2NODE_CONFIG_FILE, '..', 'one-shot-spot.json');
    require('node:fs').writeFileSync(sourceFile, JSON.stringify({ ...table,
        spots: [table.spots[index]], rows: [table.rows[index]] }));
    Table.useFile(sourceFile); Economy.reset();
    for (const [at, shots] of [false, true].entries()) assert.deepStrictEqual(Table.value(id, 'dps', 25, shots), originalValues[at]);
    async function member(id, cash) {
        const account = `gear_stock_${id}`;
        await Database.createAccount(account, 'fixture');
        const createdId = Number((await Database.createCharacter(account, { name: `Gear${id}`, race: 0, classId: 0,
            maxHp: 100, maxMp: 100, sex: 0, face: 0, hair: 0, hairColor: 0, ...world.town() })).insertId);
        await Database.execute(['UPDATE characters SET id = ?, level = 25, exp = ? WHERE id = ?',
            [id, DataCache.experience[24], createdId]]);
        if (cash) await Database.setItem(id, { selfId: 57, name: 'Adena', amount: cash });
        const kit = require('./fixtures/profitable_stock_state').kitFor(0, 25);
        for (const entry of kit.entries.filter(row => row.slot !== 7))
            await Database.setItem(id, { selfId: entry.selfId, name: entry.name, amount: 1, equipped: true, slot: entry.slot });
        await Database.setItem(id, { selfId: Number(sword.selfId), name: sword.template.name, amount: 1, equipped: true, slot: 7 });
        const items = await Database.fetchItems(id), paperdoll = Array.from({ length: 16 }, () => ({}));
        for (const row of items.filter(row => row.equipped)) paperdoll[row.slot] = { id: row.id, selfId: row.selfId };
        // No coldLifeState.characterId: this is the original non-bot purchase adapter.
        const session = { accountId: account, currentSpot: spot, plan: 'shopping',
            coldLifeState: { phase: 'hot', currentRegion: 'Giran', stats: {} }, dataSendToMe() {}, dataSendToOthers() {} };
        session.actor = new Actor(session, { ...(await Database.fetchCharacters(account))[0],
            ...utils.crushOb(DataCache.classTemplates.find(row => row.classId === 0)), items, paperdoll });
        // The original adapter represents a player: use its native persisted
        // learning path, rather than declaring a bot session for paid trading.
        await session.actor.skillset.awardSkills(id, 0, 25);
        invoke(global.path.actor).calculateStats(session, session.actor);
        return session.actor;
    }
    const poor = await member(31, 0), rich = await member(32, 10000000);
    const shotId = ShotStock.planForActor(rich).selfId;
    const quotePrice = Number(DataCache.items.find(row => row.selfId === shotId).template.price);
    // Declare a real player's physical surplus large enough for the native
    // table's full town-visit interval; this does not author the buyer target.
    const supplyUnits = Math.ceil(Table.value(id, 'dps', 25, true).shots
        * invoke('GameServer/Bot/Economy/TownVisitInterval').targetHours(Economy.stateForActor(rich).stats));
    const sellerAccount = 'shot_surplus_seller';
    await Database.createAccount(sellerAccount, 'fixture');
    const sellerId = Number((await Database.createCharacter(sellerAccount, { name: 'ShotSeller', race: 0, classId: 0,
        maxHp: 100, maxMp: 100, sex: 0, face: 0, hair: 0, hairColor: 0, ...world.town() })).insertId);
    assert.notStrictEqual(sellerId, rich.fetchId());
    await Database.setItem(sellerId, { selfId: shotId, name: 'Soulshot: D-grade', amount: supplyUnits });
    const sellerStock = (await Database.fetchItems(sellerId)).find(row => row.selfId === shotId);
    assert.strictEqual(sellerStock.amount, supplyUnits);
    const created = await Database.createAfkTradeShop(sellerId, { kind: 'shop', storeType: 1,
        town: 'Giran', ...world.town(), lines: [{ objectId: sellerStock.id, selfId: shotId, count: supplyUnits,
            price: quotePrice, enchant: 0, stackable: true }] });
    assert.strictEqual(created.ownerInventory.filter(row => row.selfId === shotId).reduce((sum, row) => sum + row.amount, 0), 0,
        'publishing the native SELL transfers the physical surplus into custody');
    assert.strictEqual(created.shop.lines[0].count, supplyUnits);
    Afk.refreshRecord(created.shop);
    World.user = { sessions: [poor.session, rich.session], revision: 0 };
    Economy.forget(31); Economy.forget(32);
    world.economyFor(Economy.stateForActor(poor));
    const richEconomy = world.economyFor(Economy.stateForActor(rich));
    const originals = [];
    function stub(object, name, replacement) {
        const original = object[name];
        originals.push(() => { object[name] = original; });
        object[name] = replacement;
    }
    const writes = [];
    const setItem = Database.setItem, updateAmount = Database.updateItemAmount;
    stub(Database, 'setItem', (...args) => { writes.push({ characterId: args[0], ...args[1] }); return setItem.apply(Database, args); });
    stub(Database, 'updateItemAmount', (...args) => { writes.push({ characterId: args[0], itemId: args[1], amount: args[2] }); return updateAmount.apply(Database, args); });
    const backpack = (items = []) => new Backpack({ paperdoll: Array.from({ length: 16 }, () => ({})), items });
    const actor = (id, bag) => ({ backpack: bag, fetchId: () => id, fetchLevel: () => 25, fetchClassId: () => 0, fetchName: () => `Gear${id}` });
    try {
        // A member without adena gets no free shots.
        await ShotStock.restockAfterWeaponChange(poor, [7]);
        assert.strictEqual(ShotStock.shotAmount(poor), 0, 'a member without adena must not receive free shots');
        assert.strictEqual(writes.length, 0, `no shot or adena row may be written, got ${JSON.stringify(writes)}`);

        // Armour does not change the shot grade: nothing is bought.
        // The shared queue first funds the member's gear wishes. This purse
        // also funds its measured shot stock, rather than assuming any cash
        // must force an otherwise unfunded consumable purchase.
        await ShotStock.restockAfterWeaponChange(rich, [10]);
        assert.strictEqual(writes.length, 0, 'an armour change must not touch shots');

        // A weapon change buys the restock with the member's adena.
        const offers = Afk.offers(shotId, Afk.SELL, { characterId: rich.fetchId(), town: 'Giran' });
        assert.strictEqual(offers[0].price, quotePrice, 'the current physical offer keeps the canonical template quote');
        const nativeRestock = ShotStock.restockPlan(rich, { offers });
        const policy = ShotStock.usePolicy(Economy.stateForActor(rich), { unitPrice: offers[0].price });
        const stockWish = richEconomy.network.queue.find(row => row.key === 'stock:shots');
        console.log('Native paid shot input:', JSON.stringify({ policy, stockWish: stockWish && {
            key: stockWish.key, funded: stockWish.funded, price: stockWish.price },
            target: nativeRestock.targetAmount, amount: nativeRestock.amount, cost: nativeRestock.cost,
            npcPrice: nativeRestock.unitPrice, quotePrice }));
        assert(policy.purchaseUsePerHour > 0, 'the native XP gain covers this actual physical offer price');
        assert(stockWish && stockWish.funded, 'the actual shared queue funds the shot stock wish');
        assert(nativeRestock.amount > 0 && nativeRestock.shops.length === 1, 'the native restock chooses the funded external physical supply');
        assert(supplyUnits >= nativeRestock.targetAmount, 'the real seller holds enough units for the unmodified native target');
        if (!(nativeRestock.amount > 0)) {
            const state = Economy.stateForActor(rich), context = Economy.forState(state);
            console.error('Native member restock:', JSON.stringify({ restock: nativeRestock,
                hunt: context.hunt, stock: context.stock('shots'),
                queue: context.network.queue.filter(row => row.key === 'stock:shots')
                    .map(row => ({ key: row.key, benefit: row.benefit, price: row.price, funded: row.funded })) }));
        }
        await ShotStock.restockAfterWeaponChange(rich, [7]);
        assert(Number(rich.backpack.fetchItemFromSelfId(57).fetchAmount()) < 10000000, 'the funded restock is paid from the member adena');
        assert(ShotStock.shotAmount(rich) > 0, 'the bought shots are in the bag');
        const bought = ShotStock.shotAmount(rich), spent = 10000000 - rich.backpack.fetchItemFromSelfId(57).fetchAmount();
        assert.strictEqual(spent, bought * quotePrice, 'the native transaction pays the current seller quote for actual physical shots');
        const buyerRows = await Database.fetchItems(32), sellerRows = await Database.fetchItems(sellerId);
        assert.strictEqual(buyerRows.filter(row => row.selfId === shotId).reduce((sum, row) => sum + row.amount, 0), bought);
        assert.strictEqual(sellerRows.filter(row => row.selfId === 57).reduce((sum, row) => sum + row.amount, 0), spent);
        assert.strictEqual(sellerRows.filter(row => row.selfId === shotId).reduce((sum, row) => sum + row.amount, 0), 0,
            'the seller has no duplicate physical shots after custody is filled');
        const [afterShop] = await Database.fetchAfkTradeShops(sellerId, { activeOnly: false });
        const remaining = afterShop?.lines[0]?.count || 0;
        assert.strictEqual(remaining + bought, supplyUnits, 'custody plus the buyer bag conserves the physical seller stock');
        assert.strictEqual(buyerRows.filter(row => row.selfId === 57).reduce((sum, row) => sum + row.amount, 0) + spent, 10000000);

        // The warehouse exchange goes through the same restock.
        const restocks = [];
        stub(ShotStock, 'restockAfterWeaponChange', (target, slots) => { restocks.push(slots); return Promise.resolve(); });
        stub(invoke(global.path.actor), 'calculateStats', () => {});
        stub(invoke('GameServer/Skills/ToggleSkills'), 'syncEquipment', () => {});
        stub(invoke('GameServer/Network/Response'), 'itemsList', () => Buffer.alloc(0));
        stub(invoke('GameServer/Network/Response'), 'charInfo', () => Buffer.alloc(0));
        const receiver = actor(33, backpack());
        Exchange.publish({ actor: receiver, dataSendToMe() {}, dataSendToOthers() {} }, {
            returned: [], slot: 7,
            received: { id: 503, selfId: Number(sword.selfId), amount: 1, enchant: 0, equipped: true, slot: 7 }
        });
        assert.deepStrictEqual(restocks, [[7]], 'the clan exchange must use the bought restock');
        console.log('Clan warehouse gear shot checks passed');
    } finally {
        originals.reverse().forEach((restore) => restore());
    }
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
    World.npc = previousCatalog.npc; World.user = previousCatalog.user;
    SpotService.spots = previousCatalog.spots; SpotProfiles.cache = previousCatalog.profiles;
    invoke('GameServer/Bot/AI/SpotValueTable').useFile();
    useRate(previousRate);
    await world.close();
});
