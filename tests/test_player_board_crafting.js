'use strict';
const assert = require('node:assert/strict');
const { createWorld, Database } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Workshop = invoke('GameServer/Bot/Economy/CraftWorkshopService');
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const Rules = invoke('GameServer/Bot/Economy/CraftShopService');
const Profit = invoke('GameServer/Bot/Economy/CraftProfitPolicy');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const World = invoke('GameServer/World/World');
const Actor = invoke('GameServer/Actor/Actor');
const Data = invoke('GameServer/DataCache');
const Board = require('../src/GameServer/AfkTrade/PlayerBoardWindow');
const HtmlLink = invoke('GameServer/Network/Request/HtmlLink');
const crafter = 730601, customer = 730602, fee = 123;
const point = { locX: 83396, locY: 147904, locZ: -3404 };
const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 10000;
    while (!await predicate()) {
        if (Date.now() > deadline) throw Error('timeout: ' + label);
        await new Promise(resolve => setTimeout(resolve, 10));
    }
};
(async () => {
    const fixture = await createWorld([{ id: crafter, name: 'BoardCrafter', classId: 57, race: 4, level: 70 },
        { id: customer, name: 'CraftCustomer' }], 'player-board-crafting');
    const nativeCraft = Workshop.craft, nativeExchange = Database.craftForCustomer;
    let release, gate, nativeCalls = 0, roll = 0;
    try {
        World.user = { sessions: [], revision: 0 };
        await Database.createAccount('bot_board_crafter', 'test');
        await Database.execute(["UPDATE characters SET username='bot_board_crafter' WHERE id=?", [crafter]]);
        await Database.execute(['UPDATE characters SET locX=?,locY=?,locZ=? WHERE id IN (?,?)',
            [point.locX, point.locY, point.locZ, crafter, customer]]);
        const success = Recipes.resolveByRecipeId(1);
        const failure = Object.values(Recipes.loadRecipeItems()).find(recipe => recipe.type === 'dwarven'
            && recipe.successRate < 100 && Rules.canCraft({ classId: 57, level: 70 }, recipe));
        assert(failure);
        for (const id of [crafter, customer]) await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 10000000 });
        const required = new Map();
        for (const recipe of [success, failure]) {
            await Database.setCharacterRecipe(crafter, recipe.recipeId, recipe.type);
            for (const [id, count] of Profit.requirements(recipe)) required.set(id, (required.get(id) || 0) + count * 3);
        }
        for (const [selfId, amount] of required) await Database.setItem(customer, { selfId, name: 'Material', amount });
        await Database.setItem(customer, { selfId: success.productId, name: 'Wooden Arrow', amount: 1000 });
        await Life.init(); Workshop.init();
        await Life.upsertState({ characterId: crafter, name: 'BoardCrafter', phase: 'cold', activity: 'shopping',
            level: 70, loc: point, currentRegion: 'Giran', adena: 10000000,
            inventory: Life.inventorySummaryFromItems(await Database.fetchItems(crafter)),
            vitals: { hp: 1000, maxHp: 1000, mp: 100000, maxMp: 100000 },
            stats: { classId: 57, workshop: { title: 'Board workshop', entries: [success, failure]
                .map(recipe => ({ recipeId: recipe.recipeId, price: fee })) } }, timing: {} }, 'board_craft_fixture');
        const [row] = await Database.execute(['SELECT * FROM characters WHERE id=?', [customer]]);
        const session = { accountId: 'quests', packets: [], socket: { write() {} },
            dataSendToMe(packet) { this.packets.push(packet); }, dataSendToOthers() {}, dataSendToMeAndOthers() {} };
        const template = Data.classTemplates.find(row => row.classId === 0);
        session.actor = new Actor(session, { ...row, ...utils.crushOb(template), ...point,
            items: await Database.fetchItems(customer), paperdoll: utils.tupleAlloc(16, {}) });
        session.actor.setIsOnline(true); World.insertUser(session);
        Workshop.craft = (...args) => nativeCraft(...args.slice(0, 3), { ...args[3], random: () => roll });
        Database.craftForCustomer = async (...args) => { nativeCalls++; if (gate) await gate; return nativeExchange(...args); };
        const html = () => session.packets.filter(packet => packet[0] === 0x0f).at(-1)?.subarray(5).toString('utf16le') || '';
        const status = () => session.packets.filter(packet => packet[0] === 0x64 && packet.readInt32LE(1) === 614)
            .map(packet => packet.subarray(13).toString('utf16le').split('\0')[0]);
        const pickups = () => session.packets.filter(packet => packet[0] === 0x64 && [28, 29, 30].includes(packet.readInt32LE(1)));
        const send = command => HtmlLink(session, Buffer.concat([Buffer.from([0x21]), Buffer.from(command + '\0', 'utf16le')]));
        const click = async command => {
            const before = session.packets.filter(packet => packet[0] === 0x0f).length;
            send(command); await waitFor(() => session.packets.filter(packet => packet[0] === 0x0f).length > before, command);
        };
        const commandFor = async recipe => {
            Board.show(session, { side: 'workshop', town: 'Giran', selfId: recipe.productId });
            const link = /action="bypass -h (board answer workshop [^"]+)"><font[^>]*>Craft<\/font>/.exec(html());
            assert(link, html()); await click(link[1]);
            assert(html().includes('Confirm craft'), html());
            return /action="bypass -h (board craft [^"]+)"/.exec(html())[1];
        };
        const balance = async () => ({ customer: await fixture.amount(customer, 57), crafter: await fixture.amount(crafter, 57),
            mp: Number((await Database.execute(['SELECT mp FROM characters WHERE id=?', [crafter]]))[0].mp),
            items: await Database.fetchItems(customer) });
        const command = await commandFor(success), before = await balance();
        gate = new Promise(resolve => { release = resolve; });
        const pending = click(command);
        await waitFor(() => nativeCalls === 1, 'first craft native admission');
        send(command); await new Promise(resolve => setImmediate(resolve));
        assert.equal(nativeCalls, 1, 'a second client click cannot start another native craft');
        release(); gate = null; await pending;
        assert.equal(session.playerBoardCraftPending, undefined);
        assert(html().includes('Craft completed'), html());
        const after = await balance();
        assert.equal(after.customer, before.customer - fee); assert.equal(after.crafter, before.crafter + fee);
        assert.equal(Life.cachedState(crafter).vitals.mp, 100000 - success.mpCost);
        for (const [id, count] of Profit.requirements(success)) {
            assert.equal(await fixture.amount(customer, id), required.get(id) - count);
        }
        assert.equal(await fixture.amount(customer, success.productId), 1000 + success.productCount);
        assert.equal(pickups().length, 1);
        assert.deepEqual([1, 9, 13, 17, 21].map(offset => pickups()[0].readInt32LE(offset)),
            [29, 3, success.productId, 1, success.productCount], 'pickup shows the crafted batch, not the accumulated stack');
        assert.equal(status().filter(text => /Craft in progress/.test(text)).length, 1);
        assert.equal(status().filter(text => /Craft completed/.test(text)).length, 1);
        assert(session.packets.some(packet => packet[0] === 0x04), 'user info refreshes actor load after crafting');
        await click(command);
        assert(html().includes('offer has changed'), html());
        assert.equal(nativeCalls, 1); assert.deepEqual(await balance(), after, 'replaying the stale confirmation spends nothing');

        roll = 0.999999;
        const failCommand = await commandFor(failure), beforeFailure = await balance();
        await click(failCommand);
        assert(html().includes('Crafting failed'), html());
        const afterFailure = await balance();
        assert.equal(afterFailure.customer, beforeFailure.customer - fee); assert.equal(afterFailure.crafter, beforeFailure.crafter + fee);
        for (const [id, count] of Profit.requirements(failure)) {
            const prior = beforeFailure.items.filter(row => row.selfId === id).reduce((n, row) => n + row.amount, 0);
            assert.equal(await fixture.amount(customer, id), prior - count);
        }
        assert.equal(await fixture.amount(customer, failure.productId), 0);
        assert.equal(pickups().length, 1); assert(status().some(text => /Crafting failed.*no item/.test(text)));
        const rangeCommand = await commandFor(success), beforeRange = await balance();
        session.actor.setLocXYZ({ ...point, locX: point.locX + 5000 });
        await click(rangeCommand);
        assert(status().some(text => /Move closer/.test(text))); assert.deepEqual(await balance(), beforeRange);
        session.actor.setLocXYZ(point);
        await Database.execute(['DELETE FROM items WHERE characterId=? AND selfId=?', [customer, success.materials[0].selfId]]);
        Afk.syncOnlineInventory(customer, await Database.fetchItems(customer));
        const missingCommand = await commandFor(success), beforeMissing = await balance();
        await click(missingCommand);
        assert(status().some(text => /required crafting materials/.test(text)));
        assert.deepEqual(await balance(), beforeMissing); assert.equal(nativeCalls, 2);
        await Database.setItem(customer, { selfId: success.materials[0].selfId, name: 'Material',
            amount: required.get(success.materials[0].selfId) });
        await Database.execute(['UPDATE items SET amount=0 WHERE characterId=? AND selfId=57', [customer]]);
        Afk.syncOnlineInventory(customer, await Database.fetchItems(customer));
        const unpaidCommand = await commandFor(success), beforeUnpaid = await balance();
        await click(unpaidCommand);
        assert(status().some(text => /not have enough adena/.test(text)));
        assert.deepEqual(await balance(), beforeUnpaid); assert.equal(pickups().length, 1);
        console.log('PASS real player craft HTML, native fees/materials/MP, net pickup, load refresh, duplicate click, stale quote, failure and range');
    } finally {
        release?.(); Workshop.craft = nativeCraft; Database.craftForCustomer = nativeExchange;
        await fixture.close();
    }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
