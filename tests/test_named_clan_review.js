'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'named-clan-review-'));
const databasePath = path.join(directory, 'world.sqlite');
process.env.L2NODE_CONFIG_FILE = path.join(directory, 'config.ini');
delete process.env.L2NODE_SHARED_CONFIG_FILE;
fs.writeFileSync(process.env.L2NODE_CONFIG_FILE, `[Database]\npath=${databasePath}\nhistoryPath=${directory}/history.sqlite\n`);
const seed = new DatabaseSync(databasePath);
seed.exec(fs.readFileSync(path.join(__dirname, '../database/sql/sqlite.sql'), 'utf8'));
seed.exec("INSERT INTO accounts(username,password) VALUES('bot_named_clan','pw')");
for (let i = 1; i <= 8; i++) {
    seed.prepare(`INSERT INTO characters(id,username,name,classId,race,level,maxHp,maxMp,sex,face,hair,hairColor,locX,locY,locZ,clanId)
        VALUES(?,'bot_named_clan',?,0,0,20,500,300,0,0,0,0,0,0,0,?)`).run(718100 + i, `NamedClan${i}`, i <= 3 ? 718200 + i : 0);
    seed.prepare(`INSERT INTO bot_life_state(characterId,accountName,characterName,level,phase,activity,statsJson,inventorySummary,updatedAt)
        VALUES(?,'bot_named_clan',?,20,'cold','hunting',?,'{}',1)`).run(718100 + i, `NamedClan${i}`,
            JSON.stringify({ generatedCold: true, classId: 0, clanId: i <= 3 ? 718200 + i : 0, classProgressionLevel: 20, classProgressionClassId: 0 }));
}
for (let i = 1; i <= 3; i++) {
    seed.prepare("INSERT INTO clans(id,name,leaderId) VALUES(?,?,?)").run(718200 + i, `NamedClan${i}`, 718100 + i);
    seed.prepare("INSERT INTO clan_simulation_clans(clanId,mode,createdAt,updatedAt,stateJson) VALUES(?,'autonomous',1,1,'{}')").run(718200 + i);
}
seed.close();
require('../src/Global');
invoke('GameServer/DataCache').init();
const Database = invoke('Database'), Life = invoke('GameServer/Bot/Population/BotLifeState');
const Events = invoke('GameServer/Clan/ClanReviewEvents');
async function main() {
    Database.init();
    try {
        await Life.init();
        let subscribed = 0, wake = 0;
        const board = { subscribeBoardChanges() { subscribed++; return () => subscribed--; } };
        await Events.start({ subscribePublications() { throw Error('whole-state detector must be absent'); } }, board, () => wake++);
        assert.deepEqual(await Events.drain({ execute() { throw Error('drain must not SELECT members'); } }),
            [1, 2, 3].map(i => ({ clanId: 718200 + i, causes: ['startup'] })));
        await Events.start(null, board, () => wake++);
        assert.equal(subscribed, 1); assert.equal(Events.pending(), 0);
        const clanId = 718201;
        Events.track({ id: clanId, state: { goal: { target: { itemId: 391 } } }, members: [] });
        assert(Events.tracks(clanId, 391)); assert(!Events.tracks(clanId, 1864));
        const old = Life.cachedState(718101);
        Events.committedMember(old, { ...old, adena: 40000, stats: { ...old.stats, exp: 1000 },
            inventory: { 1864: { amount: 12 }, 57: { amount: 40000 } } });
        assert.equal(Events.pending(), 0, 'ordinary loot and income are irrelevant to the clan');
        Events.committedMember(old, { ...old, inventory: { 391: { amount: 1 } } });
        assert.deepEqual(await Events.drain(), [{ clanId, causes: ['member_item'] }]);
        Events.committedMember({ ...old, inventory: { 391: { amount: 1 } } }, { ...old, inventory: { 391: { amount: 10 } } });
        assert.equal(Events.pending(), 0, 'a positive tracked stack stays present');
        const { ColdSimulationCoordinator } = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
        const coordinator = new ColdSimulationCoordinator();
        // Exercise the native prepare -> post-commit boundary; unrelated post-
        // commit effects have their own physical/ACK regressions.
        coordinator.step = async (name, _id, work) => name === 'clanEvents' ? work() : undefined;
        const proposal = { characterId: old.characterId, token: old.simulation || {},
            nextState: { ...old, inventory: { 391: { selfId: 391, amount: 1 } } }, result: {} };
        const prepared = await coordinator.prepareProposal(proposal);
        const cachedState = Life.cachedState;
        try {
            Life.cachedState = id => Number(id) === old.characterId ? prepared : cachedState(id);
            await coordinator.afterCommit({ proposal, nextState: prepared });
        } finally { Life.cachedState = cachedState; }
        assert.deepEqual(await Events.drain(), [{ clanId, causes: ['member_item'] }],
            'the coordinator compares against the pre-commit native inventory');
        Events.committedMember(old, { ...old, level: 21 });
        assert.deepEqual(await Events.drain(), [{ clanId, causes: ['member_level'] }]);
        for (let i = 0; i < 1000; i++) {
            const state = Life.cachedState(718104);
            await Life.upsertState({ ...state, stats: { ...state.stats, expEarned: i } });
        }
        assert.equal(Events.pending(), 0, 'a thousand native non-member writes retain no detector state');
        assert.equal(wake, 6, 'only startup, item presence and level woke a clan');
        const created = await Database.createAutonomousClan({ name: 'NamedFourth', leaderId: 718104,
            memberIds: [718104, 718105, 718106], founderQuorum: 3, maxBotMemberShare: 1 });
        assert(created.ok, JSON.stringify(created));
        assert.deepEqual(await Events.drain(), [{ clanId: created.clanId, causes: ['membership'] }]);
        const joined = await Database.joinAutonomousClan({ clanId: created.clanId, characterId: 718107, maxBotMemberShare: 1 });
        assert(joined.ok, JSON.stringify(joined));
        assert.deepEqual(await Events.drain(), [{ clanId: created.clanId, causes: ['membership'] }]);
        await Database.removeCharacterFromClan(718107);
        assert.deepEqual(await Events.drain(), [{ clanId: created.clanId, causes: ['membership'] }]);
        await Database.updateCharacterClan(718107, clanId, 0, 0, 0);
        await Events.drain();
        await Database.updateCharacterClan(718107, 718202, 0, 0, 0);
        assert.deepEqual(await Events.drain(), [clanId, 718202].map(id => ({ clanId: id, causes: ['membership'] })));
        assert((await Database.dissolveClan({ clanId: created.clanId, leaderId: 718104 })).ok);
        assert.deepEqual(await Events.drain(), [{ clanId: created.clanId, causes: ['membership'] }]);
        assert(!(await Database.dissolveClan({ clanId: 999999, leaderId: 718104 })).ok);
        assert.equal(Events.pending(), 0, 'rejected writes emit no membership event');
        const Item = invoke('GameServer/Model/Item');
        const item = new Item({ selfId: 391, amount: 1, enchant: 0 });
        const ids = [], backpack = { items: [item], fetchItems() { return this.items; }, onInventoryChange: id => ids.push(id) };
        Item.bindInventory(backpack); item.setAmount(0); item.setEnchantLevel(1);
        assert.deepEqual(ids, [391, 391], 'native item callbacks name the item changed');
        console.log('Named clan review: native startup, 1000 writes, tracked presence, level, membership and item callbacks passed');
    } finally { Events.stop(); await Database.close(); fs.rmSync(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
