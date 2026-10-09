'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'l2solo-giran-shops-'));
const config = fs.readFileSync(path.resolve('config/default.ini'), 'utf8');
const fixtureConfig = path.join(directory, 'fixture.ini');
fs.writeFileSync(fixtureConfig, `[Database]\npath = ${directory}/world.sqlite\nhistoryPath = ${directory}/history.sqlite\n\n${config.slice(config.indexOf('[AuthServer]'))}`);
process.env.L2NODE_CONFIG_FILE = fixtureConfig;
delete process.env.L2NODE_SHARED_CONFIG_FILE;
require('./helpers/databaseIsolation');
require('../src/Global');

const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const World = invoke('GameServer/World/World');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const ShopPlaces = invoke('GameServer/Bot/Economy/ShopPlaces');
const Distribution = require('../src/GameServer/AfkTrade/GiranShopDistribution');
const Geo = invoke('GameServer/Geodata/GeodataEngine');
const Placement = invoke('GameServer/Bot/Population/ActivationPlacement');

const location = row => [row.locX, row.locY, row.locZ];
const distance = (a, b) => Math.hypot(a.locX - b.locX, a.locY - b.locY);
let heightReads = 0;
Geo.getHeight = (x, y, z) => { heightReads++; return z + (x + y) % 7; };
Geo.hasGeo = () => false;

function coverage(all, occupied) {
    return Math.max(...all.map(point => Math.min(...occupied.map(shop => distance(point, shop)))));
}

function geometry() {
    ShopPlaces._resetForTests();
    const all = ShopPlaces.places('Giran');
    const reads = heightReads;
    const selected = Array.from({ length: 163 }, (_, id) => ShopPlaces.take('Giran', `coverage:${id}`));
    assert(coverage(all, selected) < 140, '163 shops must cover the whole usable square, including its outer edges');
    for (let i = 0; i < selected.length; i++) {
        assert(ShopPlaces.isStallArea('Giran', selected[i]), 'no shop may occupy a margin or the column clearance');
        for (let j = 0; j < i; j++) assert(distance(selected[i], selected[j]) >= 100, 'a partly filled square must spread shops apart');
    }
    for (let i = 0; i < 1000; i++) {
        ShopPlaces.take('Giran', 'repeat');
        ShopPlaces.release('repeat');
    }
    assert.equal(heightReads, reads, 'opening and releasing shops must reuse the table without rebuilding geodata/order');
    ShopPlaces.release('coverage:20');
    assert.deepEqual(location(ShopPlaces.take('Giran', 'replacement')), location(selected[20]), 'a freed distributed place is reused');
    ShopPlaces._resetForTests();
    assert.deepEqual(ShopPlaces.places('Giran'), all, 'the layout must be deterministic');

    const resolve = Placement.resolve;
    let checks = 0;
    Geo.hasGeo = () => true;
    Placement.resolve = ({ loc }) => { checks++; return loc.locX > 82500 && loc.locY < 148000 ? null : loc; };
    ShopPlaces._resetForTests();
    const walkable = ShopPlaces.places('Giran');
    assert.equal(checks, all.length, 'each grid point is checked only at build');
    assert(walkable.length < all.length);
    assert(walkable.every(loc => !(loc.locX > 82500 && loc.locY < 148000)), 'uniform order must exclude unwalkable geodata');
    assert(walkable.every(loc => loc.locZ === -3466 + (loc.locX + loc.locY) % 7), 'each place keeps its ground height');
    Placement.resolve = resolve;
    Geo.hasGeo = () => false;
    ShopPlaces._resetForTests();
    return all;
}

let nextName = 0;
async function owner(account) {
    await Database.createAccount(account, 'pw');
    return Number((await Database.createCharacter(account, { name: `Giran${++nextName}`, race: 0, classId: 0,
        maxHp: 100, maxMp: 100, sex: 0, face: 0, hair: 0, hairColor: 0,
        locX: 82000, locY: 148000, locZ: -3466 })).insertId);
}

async function shop(account, loc, town = 'Giran', kind = 'shop') {
    const id = await owner(account);
    const stock = Number((await Database.setItem(id, { selfId: 1865, name: 'Varnish', amount: 7,
        enchant: 0, equipped: false, slot: 0 })).insertId);
    await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 1000, enchant: 0, equipped: false, slot: 0 });
    return (await Database.createAfkTradeShop(id, { kind, storeType: 1, town, ...loc, title: 'Varnish',
        lines: [{ objectId: stock, selfId: 1865, name: 'Varnish', count: 5, price: 100, stackable: true }] })).shop;
}

async function snapshot() {
    return {
        shops: await Database.execute(['SELECT * FROM afk_trade_shops ORDER BY id']),
        lines: await Database.execute(['SELECT * FROM afk_trade_lines ORDER BY id']),
        items: await Database.execute(['SELECT * FROM items ORDER BY id']),
        life: await Database.execute(['SELECT * FROM bot_life_state ORDER BY characterId'])
    };
}

async function run() {
    DataCache.init();
    const all = geometry();
    Database.init();
    World.user = { sessions: [], revision: 0 };
    const centre = ShopPlaces.fillCenter('Giran');
    const clustered = all.slice().sort((a, b) => distance(a, centre) - distance(b, centre));
    assert(coverage(all, clustered.slice(0, 163)) > 700, 'fixture must reproduce the old centre cluster');
    const bots = [];
    for (let i = 0; i < 163; i++) bots.push(await shop(`bot_giran_${i}`, clustered[i]));
    const player = await shop('giran_player', { ...all[0], locX: all[0].locX + 10, locY: all[0].locY + 10 });
    const otherTown = await shop('bot_giran_other', { locX: -14570, locY: 123220, locZ: -3117 }, 'Gludio');
    const ad = await shop('bot_giran_ad', all[0], 'Giran', 'sell_ad');
    const crafter = await owner('bot_giran_crafter');
    await LifeState.upsertState({ characterId: crafter, accountName: 'bot_giran_crafter', name: 'GiranCrafter',
        phase: 'cold', activity: 'crafting', level: 40, adena: 0, loc: all[1], currentRegion: 'Giran', inventory: {},
        vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
        stats: { craftShop: { town: 'Giran', loc: all[1] } }, timing: {} }, 'distribution_fixture');
    ShopPlaces._resetForTests(); // Startup before the life-state cache has been restored.
    const before = await snapshot();
    const plan = bots.map((row, i) => ({ id: Number(row.id), ownerId: Number(row.ownerId),
        expectedRevision: Number(row.revision), ...all[i] }));
    const stale = plan.map((row, i) => i === plan.length - 1 ? { ...row, expectedRevision: row.expectedRevision + 1 } : row);
    await assert.rejects(Database.relocateBotAfkTradeShops('Giran', stale, Distribution.MIGRATION_KEY), /shop_changed/);
    assert.deepEqual(await snapshot(), before, 'stale final record must leave every preceding shop and asset unchanged');
    await assert.rejects(Database.relocateBotAfkTradeShops('Giran', [...plan, { ...plan[0], id: player.id,
        ownerId: player.ownerId }], Distribution.MIGRATION_KEY), /shop_changed/, 'player shop cannot enter a bot relocation plan');

    const records = await Database.fetchAfkTradeShops();
    records.filter(row => row.kind === 'shop').forEach(row => ShopPlaces.occupy(ShopPlaces.afkOwner(row.ownerId), row.town, row));
    ShopPlaces.syncState(crafter, { activity: 'crafting', stats: { craftShop: { town: 'Giran', loc: all[1] } } });
    const free = ShopPlaces.freeCount('Giran');
    const relocate = Database.relocateBotAfkTradeShops;
    Database.relocateBotAfkTradeShops = async () => { throw Error('relocation_refused'); };
    await assert.rejects(Distribution.restore(records), /relocation_refused/);
    Database.relocateBotAfkTradeShops = relocate;
    assert.equal(ShopPlaces.freeCount('Giran'), free, 'failed native relocation releases every provisional place and restores old reservations');
    assert.deepEqual(await snapshot(), before);
    const take = ShopPlaces.take;
    let takes = 0;
    ShopPlaces.take = (...args) => ++takes === 6 ? null : take(...args);
    assert.deepEqual(await Distribution.restore(records), { skipped: true, reason: 'plaza_full:Giran' });
    ShopPlaces.take = take;
    assert.equal(ShopPlaces.freeCount('Giran'), free, 'a full plaza restores all original reservations');
    assert.deepEqual(await snapshot(), before);

    assert.equal(await AfkTrade.init(), 166);
    const after = await snapshot();
    const moved = (await Database.fetchAfkTradeShops()).filter(row => bots.some(bot => bot.id === row.id));
    assert.equal(moved.length, 163);
    assert(coverage(all, [...moved, player, all[1]]) < 140,
        'restored shops and fixed occupants must cover the usable square');
    assert.deepEqual(after.items, before.items, 'no wallet or inventory movement');
    assert.deepEqual(after.life, before.life, 'no bot progression/crafting state movement');
    assert.deepEqual(after.lines.map(({ pricingJson, ...line }) => line), before.lines.map(({ pricingJson, ...line }) => line),
        'line ids, quantities, prices and custody must survive startup');
    for (const fixed of [player, otherTown, ad]) {
        assert.deepEqual(after.shops.find(row => row.id === fixed.id), before.shops.find(row => row.id === fixed.id),
            'player shops, other towns and nonphysical ads stay in place');
    }
    for (const row of moved) {
        assert(distance(row, player) >= ShopPlaces.SPACING, 'respect off-grid player shops');
        assert(distance(row, all[1]) >= ShopPlaces.SPACING, 'respect persisted crafting stations before cache load');
        assert.deepEqual(location(AfkTrade.findOwnerProjection(row.ownerId).actor.model), location(row), 'client projection uses durable coordinates');
        assert.equal(row.revision, before.shops.find(shop => shop.id === row.id).revision + 1);
    }
    const [marker] = await Database.execute(['SELECT value FROM world_meta WHERE key = ?', [Distribution.MIGRATION_KEY]]);
    assert(marker, 'migration is durable');
    await AfkTrade._resetForTests();
    await Database.close();
    ShopPlaces._resetForTests();
    Database.init();
    assert.equal(await AfkTrade.init(), 166);
    assert.deepEqual(await snapshot(), after, 'next startup preserves positions/revisions/assets without repeating redistribution');
    assert.deepEqual(await Database.relocateBotAfkTradeShops('Giran', [], Distribution.MIGRATION_KEY), { skipped: true });
    console.log('Giran distribution: 163 shops cover the square; geodata, players, crafting, atomicity, assets and restart verified');
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await AfkTrade._resetForTests();
    await Database.close();
    fs.rmSync(directory, { recursive: true, force: true });
});
