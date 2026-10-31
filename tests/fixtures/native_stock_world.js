'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const taskPath = require('node:path');
const { randomUUID } = require('node:crypto');

// Each process (including its history worker) uses this test's own world.
module.exports = function nativeStockWorld() {
    const root = taskPath.resolve(__dirname, '../..');
    const directory = taskPath.join(root, 'tmp', `stock-world-${randomUUID()}`);
    fs.mkdirSync(directory, { recursive: true });
    const config = taskPath.join(directory, 'config.ini');
    const previous = { main: process.env.L2NODE_CONFIG_FILE, shared: process.env.L2NODE_SHARED_CONFIG_FILE };
    fs.writeFileSync(config, fs.readFileSync(taskPath.join(root, 'config/default.ini'), 'utf8')
        + `\n[Database]\npath=${taskPath.join(directory, 'world.sqlite')}\nhistoryPath=${taskPath.join(directory, 'history.sqlite')}\n`);
    process.env.L2NODE_CONFIG_FILE = process.env.L2NODE_SHARED_CONFIG_FILE = config;
    let sourceActive = false;

    function usePotionSpot(spotId = '-10_30') {
        const table = invoke('GameServer/Bot/AI/SpotValueTable');
        const canonical = JSON.parse(fs.readFileSync(table.DEFAULT_FILE, 'utf8'));
        const index = canonical.spots.findIndex(row => row[0] === spotId);
        assert(index >= 0, 'the potion case uses an authored canonical spot');
        const before = [false, true].map(shots => table.value(spotId, 'dps', 30, shots));
        const file = taskPath.join(directory, 'one-spot.json');
        // A unit world with one available spot, not a knowledge filter. Every
        // curve, field and value is retained; the spot and row share index 0.
        fs.writeFileSync(file, JSON.stringify({ ...canonical,
            spots: [canonical.spots[index]], rows: [canonical.rows[index]] }));
        const subset = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.deepEqual(subset.spots, [canonical.spots[index]]);
        assert.deepEqual(subset.rows, [canonical.rows[index]]);
        for (const key of ['header', 'roles', 'shots', 'gaps', 'rowFields', 'curveFields', 'curves'])
            assert.deepEqual(subset[key], canonical[key], `the canonical ${key} is unchanged`);
        table.useFile(file);
        sourceActive = true;
        invoke('GameServer/Bot/Economy/EconomyContext').reset();
        for (const [at, shots] of [false, true].entries())
            assert.deepEqual(table.value(spotId, 'dps', 30, shots), before[at], `native values are unchanged with shots=${shots}`);
    }

    function town() {
        const { locX, locY, locZ } = invoke('GameServer/World/TownRespawn').towns.giran_town;
        return { locX, locY, locZ };
    }

    function economyFor(state) {
        const trip = invoke('GameServer/Bot/Economy/EconomicTrip');
        const steps = trip.prepare(state);
        let step;
        do { step = steps.next(); } while (!step.done);
        const economy = invoke('GameServer/Bot/Economy/EconomyContext').forState(state,
            { routeRows: step.value, board: invoke('GameServer/AfkTrade/AfkTradeService').boardIndex() });
        assert.deepEqual(economy.trip.details('Giran'), { known: true, hours: 0, fees: 0 },
            'a seller already shopping in Giran uses the native completed route');
        return economy;
    }

    async function buyer(goods, sellerId) {
        const database = invoke('Database');
        const data = invoke('GameServer/DataCache');
        const afk = invoke('GameServer/AfkTrade/AfkTradeService');
        const account = `stock_buyer_${randomUUID()}`;
        await database.createAccount(account, 'fixture');
        const ownerId = Number((await database.createCharacter(account, {
            name: 'StockBuyer', race: 0, classId: 0, maxHp: 100, maxMp: 100,
            sex: 0, face: 0, hair: 0, hairColor: 0, ...town()
        })).insertId);
        assert.notEqual(ownerId, sellerId, 'a seller cannot answer his own buy order');
        const lines = goods.map(([selfId, count]) => {
            const entry = data.items.find(row => Number(row.selfId) === selfId);
            const price = Number(entry.template.price);
            assert(price > invoke('GameServer/Items/NpcSellRules').npcBuyPrice(price), 'the funded bid uses the canonical item price');
            return { selfId, name: entry.template.name, count, price, enchant: 0, stackable: true };
        });
        const escrow = lines.reduce((sum, line) => sum + line.count * line.price, 0);
        const cash = escrow * 2;
        await database.setItem(ownerId, { selfId: 57, name: 'Adena', amount: cash, equipped: false, slot: 0 });
        const created = await database.createAfkTradeShop(ownerId, { kind: 'shop', storeType: 3,
            town: 'Giran', ...town(), lines });
        const wallet = created.ownerInventory.filter(row => Number(row.selfId) === 57)
            .reduce((sum, row) => sum + Number(row.amount), 0);
        assert.equal(wallet, cash - escrow, 'publishing the native BUY deducts the actual wallet');
        assert.equal(Number(created.shop.escrowAdena), escrow, 'the full current BUY is physically funded');
        assert.equal(wallet + Number(created.shop.escrowAdena), cash, 'wallet plus escrow conserves the buyer money');
        afk.refreshRecord(created.shop);
        for (const line of lines) {
            const advertised = afk.boardIndex().first(line.selfId, 3, { excludeOwner: sellerId, enchant: 0 });
            assert.equal(advertised.ownerId, ownerId);
            assert.equal(advertised.count, line.count);
            assert.equal(advertised.enchant, 0);
            assert.equal(advertised.custodyPolicy, 0, 'the board uses the actual backed source');
        }
        return created.shop;
    }

    async function close() {
        if (sourceActive) invoke('GameServer/Bot/AI/SpotValueTable').useFile();
        invoke('GameServer/Bot/Economy/EconomyContext').reset();
        invoke('GameServer/AfkTrade/AfkTradeService')._resetForTests();
        await invoke('Database').close();
        fs.rmSync(directory, { recursive: true, force: true });
        for (const [key, value] of [['L2NODE_CONFIG_FILE', previous.main], ['L2NODE_SHARED_CONFIG_FILE', previous.shared]]) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }

    return { usePotionSpot, town, economyFor, buyer, close };
};
