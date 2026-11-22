'use strict';
// A bot that bought a weapon of a new grade at 0 of its shots crosses no shot line (it
// starts below it), so the line raises nothing. When the build that sees the weapon
// cannot fund the shots yet (the weapon took the wallet), it arms their money as its
// threshold: the wallet reaching it wakes the build, which sends the bot to the town
// where a crafter lists the shots. Before, a build that funded its focus armed nothing
// for the shots and the bot hunted without them until another situation came.
const assert = require('node:assert/strict');
const { useRate } = require('./helpers/progressionRate');
require('./helpers/databaseIsolation');
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.env.L2NODE_CONFIG_FILE = 'config/default.ini';
require('../src/Global');
useRate('x50');
const Data = invoke('GameServer/DataCache'); Data.init();
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Providers = invoke('GameServer/Bot/Economy/WishProviders');
const Situations = invoke('GameServer/Bot/Situations');
const ShotStock = invoke('GameServer/Inventory/ShotStock');
const Generation = require('../src/GameServer/Bot/Population/RecomputeGeneration');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
invoke('GameServer/Bot/Economy/PersonalWarehouseIndex').useRowSource(() => null, () => true);
const generation = Generation.metadata();
Generation.configure({ code: '1'.repeat(40), config: '2'.repeat(64) });
const spots = invoke('GameServer/Bot/Population/SpotProfiles').ensure();

try {
    // A level 28 fighter in its D gear, no D soulshot in its bag, hunting near Gludin.
    const level = 28;
    const fighter = { characterId: 991280, name: 'NoShots', level, phase: 'cold', activity: 'hunting', adena: 60000,
        currentRegion: 'Gludin', loc: { locX: -80000, locY: 150000, locZ: -3000 },
        stats: { classId: 1, exp: Data.experience[level - 1] + 1 }, inventory: {}, timing: {},
        vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 } };
    for (const [, items] of Providers.gearCandidates(fighter)) {
        const item = items[0]; if (!item) continue;
        fighter.inventory[item.selfId] = { selfId: Number(item.selfId), amount: 1, equipped: true, equippedCount: 1,
            slot: Number(item.etc.slot), enchant: 0 };
    }
    const shotId = Number(ShotStock.planForState(fighter).selfId);
    assert.equal(shotId, 1463, 'fixture: its weapon fires D soulshots');
    // Only a crafter in Dion lists them (no shot store sells to a bot); Gludin, where it is, has none.
    const board = new BoardIndex();
    board.put({ id: 1, ownerId: 2, storeType: 1, kind: 'afk_shop', town: 'Dion',
        lines: [{ lineId: 1, selfId: shotId, count: 15000, price: 70 }] });
    const trip = Object.assign(town => town === 'Dion' ? .1 : town === 'Gludin' ? .05 : Infinity,
        { details: town => ({ known: town === 'Dion' || town === 'Gludin', hours: town === 'Dion' ? .1 : .05,
            fees: town === 'Dion' ? 1000 : 0 }) });
    let at = 1791335800000;
    const build = adena => {
        Economy.forget(fighter.characterId);
        at += 60000;
        return Economy.forState({ ...fighter, adena }, { spots, board, tripCost: trip, timestamp: at, caller: 'step', fullReview: true });
    };
    const shots = context => context.network.queue.find(row => row.key === 'stock:shots');
    const shotStop = context => [context.network.activity, ...(context.network.agenda || [])]
        .find(step => step?.rootKey === 'stock:shots' || String(step?.key || '').startsWith('stock:shots:'));

    // The build after the weapon: the shots are wished for, below their line, and not funded.
    let wallet = fighter.adena, context = build(wallet);
    assert.equal(context.stock('shots').current, 0, 'fixture: no D soulshot in the bag');
    assert(shots(context) && !shots(context).funded, 'fixture: the broke bot wishes for its shots, unfunded');
    // Each build arms the money the wallet waits for; the step whose wallet reaches it raises
    // goal_affordable:focus, which wakes the build. Followed from the broke wallet, the wakes
    // reach the build that funds the shots and sends the bot to Dion for them.
    const wakes = [];
    for (let wake = 0; wake < 4 && !shots(context).funded; wake++) {
        const armed = context.statsPacket.wishSections.affordAt;
        assert(armed?.at > wallet, `a build that does not fund the shots arms the money it waits for (wallet ${Math.round(wallet)}, wake ${wake})`);
        const baseline = context.statsPacket.wishSections;
        const before = { ...fighter, adena: wallet, stats: { ...fighter.stats, wishSections: baseline } };
        const after = { ...before, adena: Math.ceil(armed.at) };
        assert(Situations.detect(before, after).includes('goal_affordable:focus'), 'the wallet reaching it is a situation');
        assert(!Situations.detect(before, { ...before, adena: wallet + 1 }).includes('goal_affordable:focus'), 'a drift below it is none');
        wallet = Math.ceil(armed.at);
        wakes.push(wallet);
        context = build(wallet);
    }
    assert(shots(context).funded, `the wakes reach the build that funds the shots (wallets ${wakes.join(', ')})`);
    const stop = shotStop(context);
    assert(stop, 'that build plans the shot purchase');
    assert.equal(stop.town, 'Dion', 'in the town where the crafter lists them');
    assert.equal(Number(stop.itemId), shotId);
    console.log(`PASS a shot-less D fighter's build arms the shots' money; ${wakes.length} wake(s) send it to Dion for them`);
} finally {
    Generation.configure(generation);
}
