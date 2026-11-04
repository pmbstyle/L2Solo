'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('henna-snapshot');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const DB = invoke('Database'), Life = invoke('GameServer/Bot/Population/BotLifeState');
const Native = require('./helpers/nativeMarketFixture');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const InventorySummary = invoke('GameServer/Bot/Population/InventorySummary');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Henna = invoke('GameServer/Henna/HennaRules');
const Policy = invoke('GameServer/Bot/Economy/BotImprovementPolicy');
const id = 9761, slots = [133, 37, 124], loc = { locX: 83396, locY: 147904, locZ: -3400 };
async function stored() {
    return JSON.parse((await DB.execute(['SELECT statsJson FROM bot_life_state WHERE characterId=?', [id]]))[0].statsJson).hennas;
}
// The cache a lifecycle save leaves is the state its stored row reads back as,
// whether SQL rewrote the stats on the way (the symbols) or kept them as sent.
async function assertCachedAsStored(saved) {
    const [row] = await DB.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [id]]);
    const stored = Life.acceptLifecycleRow(row);
    assert.deepEqual(saved.stats, stored.stats);
    assert.deepEqual(saved.inventory, stored.inventory);
    assert.equal(saved.simulation.revision, stored.simulation.revision);
    // Both are what the stored texts parse to now (a parse handed on is that parse).
    assert.deepEqual(stored.inventory, Life.normalizeInventoryStackability(InventorySummary.read(row.inventorySummary)));
    for (const [key, value] of Object.entries(JSON.parse(row.mindJson || '{}'))) assert.deepEqual(stored.stats[key], value, key);
}
async function run() {
    try {
        await DB.init();
        await Native.character(DB, id, 'HennaBuyer', 'bot_henna_buyer', loc);
        await DB.execute(['UPDATE characters SET level=52,classId=55,race=4 WHERE id=?', [id]]);
        await DB.setItem(id, { selfId: 57, name: 'Adena', amount: 10000000 });
        for (let i = 0; i < slots.length; i++) await DB.setCharacterHenna(id, i + 1, slots[i]);
        const legacy = { classId: 55, hennas: [], coldCombat: Profile.legacySnapshot({ level: 52, stats: { classId: 55 } }) };
        await DB.execute([`INSERT INTO bot_life_state(characterId,accountName,characterName,level,phase,activity,
            currentRegion,locX,locY,locZ,statsJson,inventorySummary) VALUES(?, 'bot_henna_buyer','HennaBuyer',52,'cold','shopping','Giran',?,?,?,?,'{}')`,
            [id, loc.locX, loc.locY, loc.locZ, JSON.stringify(legacy)]]);
        await Life.init();
        let state = Life.cachedState(id);
        assert.deepEqual(state.stats.hennas, slots, 'startup restores existing native symbols');
        assert.deepEqual(await stored(), slots, 'startup repair is durable before publishing the worker state');
        const bonused = Profile.profileFor(state).base;
        const plain = Profile.profileFor({ ...state, stats: { ...state.stats, hennas: [] } }).base;
        assert.notDeepEqual(bonused, plain, 'physical tattoos affect cold combat stats');

        state = await Life.upsertState({ ...state, stats: { ...state.stats, hennas: [] } }, 'stale_actor_snapshot');
        assert.deepEqual(state.stats.hennas, slots, 'a generic lifecycle save cannot erase physical symbols');
        await assertCachedAsStored(state);
        state = await Life.upsertState(Life.cachedState(id), 'kit_unchanged');
        assert.deepEqual(state.stats.hennas, slots);
        await assertCachedAsStored(state);
        // A save that moves the bag and the mind reads back the moved ones.
        state = await Life.upsertState({ ...state, inventory: { ...state.inventory, 1835: { selfId: 1835, amount: 100 } },
            stats: { ...state.stats, decisionSeq: Number(state.stats.decisionSeq || 0) + 1 } }, 'bag_and_mind_moved');
        assert.equal(state.inventory[1835].amount, 100);
        assert.equal(state.inventory[1835].stackable, true);
        assert.equal(Life.cachedState(id).stats.decisionSeq, state.stats.decisionSeq);
        await assertCachedAsStored(state);
        const stepped = Life.cachedState(id);
        // The worker writes the kit of the row it stepped from: a henna writer
        // moves the revision, so a proposal with older symbols is refused, not merged.
        const committed = await Owner.commitBatch([{ revision: stepped.simulation.revision,
            nextState: { ...stepped, stats: { ...stepped.stats } },
            proposal: InventorySummary.bagChange(stepped.inventory, stepped.inventory), options: { allowLifecycle: true } }]);
        assert(committed[0].ok);
        state = Life.cachedState(id);
        assert.deepEqual(state.stats.hennas, slots, 'an accepted worker round preserves native symbols');
        assert.deepEqual(await stored(), slots);
        await DB.execute(["UPDATE bot_life_state SET statsJson=json_set(statsJson,'$.hennas',json('[]')) WHERE characterId=?", [id]]);
        state = await Life.syncExternalInventory(id, 'stale_economy_projection', state);
        assert.deepEqual(state.stats.hennas, slots, 'native inventory publication repairs a stale persisted kit too');

        await DB.deleteCharacterHenna(id, 2);
        state = await Life.upsertState({ ...state, stats: { ...state.stats, hennas: slots } }, 'stale_before_removal');
        assert.deepEqual(state.stats.hennas, [133, null, 124], 'a genuine native removal is not restored by a stale writer');
        await assertCachedAsStored(state);
        const symbol = Henna.symbolForClass(55, 37);
        assert(symbol);
        await DB.setItem(id, { selfId: symbol.dyeSelfId, name: 'Dye', amount: symbol.dyeAmount });
        state = await Life.syncExternalInventory(id, 'dye_acquired', state);
        const beforeCash = state.adena;
        const drawn = await DB.applyBotImprovement(id, { kind: 'henna', symbolId: symbol.id }, { coldState: state });
        state = Life.acceptLifecycleRow(drawn.coldLifeRow);
        assert.deepEqual(state.stats.hennas, slots);
        assert.equal(state.adena, beforeCash - symbol.price);
        assert(!state.inventory[symbol.dyeSelfId]);
        const opportunities = Policy.opportunities(state, { timestamp: Date.now(), price: () => 100,
            hunt: { perHour: 100000, expPerHour: 100000 }, persona: { primaryDrive: 'progression', traits: {} }, deathHours: 1 });
        assert(!opportunities.some(row => row.kind === 'henna'), 'a full native kit cannot nominate a fourth tattoo');
        console.log('PASS native henna startup repair, stale lifecycle/worker/economy snapshots, actual removal, paid redraw and no fourth-slot retry');
    } finally { await DB.close(); fs.rmSync(fixture.directory, { recursive: true, force: true }); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
