'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('cold-loot-instances');
require('../src/Global');
fixture.assertConfigured(options.default);
const DB = invoke('Database'), Data = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Native = require('./helpers/nativeMarketFixture');

(async () => {
    Data.init(); await DB.init();
    try {
        const id = 9404, account = 'bot_cold_loot_instances';
        await Native.character(DB, id, 'ColdLootInstances', account);
        const oldSword = await DB.setItem(id, { selfId: 1, name: 'Short Sword', amount: 1, enchant: 7, slot: 0 });
        const oldGloves = await DB.setItem(id, { selfId: 604, name: 'Crafted Leather Gloves', amount: 1, enchant: 4, slot: 0 });
        const earrings = [];
        for (const [slot, enchant] of [[1, 5], [2, 2]]) earrings.push({ slot, enchant, id: Number((await DB.setItem(id,
            { selfId: 114, name: 'Earring of Strength', amount: 1, enchant, equipped: true, slot })).insertId) });
        await DB.setItem(id, { selfId: 1864, name: 'Stem', amount: 10, slot: 0 });
        await Life.init();
        let state = await Life.upsertState({ characterId: id, accountName: account, name: 'ColdLootInstances',
            phase: 'cold', activity: 'hunting', level: 1, exp: 0, adena: 0, loc: { locX: 83000, locY: 148000, locZ: -3400 },
            vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }, timing: {},
            inventory: Life.inventorySummaryFromItems(await DB.fetchItems(id)),
            stats: { classId: 0, role: 'dps', classProgressionLevel: 1, classProgressionClassId: 0 } }, 'loot_fixture');
        for (let round = 0; round < 2; round++) {
            const before = structuredClone(state);
            const result = { patch: {}, events: [], nextResolveAt: Date.now()+30000,
                materialize: { exp: 0, sp: 0, adena: 0, items: [
                    { selfId: 1, amount: 2 }, { selfId: 604, amount: 2 },
                    { selfId: 19, amount: 2 }, { selfId: 114, amount: 2 }, { selfId: 1864, amount: 5 }
                ] }, debug: {} };
            // The same projection is used by the worker before its native commit.
            const projected = await Life.prepareResolve(state, result, { persist: false });
            assert.deepEqual(state, before, 'projecting loot does not mutate the input snapshot');
            for (const itemId of [1, 604, 19, 114]) {
                const item = projected.inventory[itemId];
                assert.equal(item.stackable, false, `loot ${itemId} inherits non-stackable template metadata`);
                assert.equal(item.instances.length, Number(before.inventory[itemId]?.amount || 0)+2);
                assert(item.instances.every(copy => copy.amount === 1));
                assert(item.instances.filter(copy => !copy.id).every(copy => copy.enchant === 0), 'new loot is +0');
            }
            state = await Life.applyResolve(state, result);
            assert(state);
            const rows = await DB.fetchItems(id);
            for (const itemId of [1, 604, 19, 114]) {
                const copies = rows.filter(item => item.selfId === itemId);
                assert.equal(copies.length, Number(before.inventory[itemId]?.amount || 0)+2);
                assert(copies.every(copy => copy.amount === 1), 'each weapon/armour copy owns one physical row');
            }
            assert.equal(rows.find(item => item.id === Number(oldSword.insertId)).enchant, 7);
            assert.equal(rows.find(item => item.id === Number(oldGloves.insertId)).enchant, 4);
            for (const earring of earrings) {
                const copy = rows.find(item => item.id === earring.id);
                assert.equal(copy.enchant, earring.enchant);
                assert.equal(copy.equipped, 1, 'new jewellery never displaces the existing better physical copies');
                assert.equal(copy.slot, earring.slot);
            }
            const stems = rows.filter(item => item.selfId === 1864);
            assert.equal(stems.length, 1, 'materials remain one physical stack');
            assert.equal(stems[0].amount, 10+(round+1)*5);
            state = await Life.reloadRow(id);
        }
        console.log('PASS cold loot: native projection/commit/reload preserves gear copies, IDs, enchant and material stacks');
    } finally { await DB.close(); fs.rmSync(fixture.directory, { recursive: true, force: true }); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
