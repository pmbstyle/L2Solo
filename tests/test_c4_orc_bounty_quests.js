// Lifecycle coverage for the two imported Orc bounties.
//
// Q275 and Q276 spawn a transient quest monster at the corpse of the mob that
// provoked it, which is what the pinned C4 handlers' addSpawn does. The spawn is
// asserted to carry its owner and quest identity, and to stand where the mob died.
const assert = require('node:assert/strict');
const { createWorld, enableQuestSpawns, Service, Database, DataCache } = require('./helpers/c4QuestHarness');

const ADENA = 57;

const CHARACTERS = [
    // Q275 runners and gate probes.
    { id: 275, race: 3, level: 20 }, { id: 2751, race: 3, level: 20 },
    { id: 2752, race: 0, level: 20 }, { id: 2753, race: 3, level: 10 },
    // Q276 runners and gate probes.
    { id: 276, race: 3, level: 20 }, { id: 2761, race: 3, level: 20 },
    { id: 2762, race: 1, level: 20 }, { id: 2763, race: 3, level: 14 }
];

// A killed mob the quest handlers can read a position and heading from.
const corpse = (selfId, position) => ({
    fetchSelfId: () => selfId,
    fetchId: () => 900000 + selfId,
    fetchLocX: () => position.locX,
    fetchLocY: () => position.locY,
    fetchLocZ: () => position.locZ,
    fetchHead: () => position.head,
    isSpoil: () => false
});

// Forces Math.random to a chosen value for exactly one quest interaction.
async function withRoll(value, body) {
    const original = Math.random;
    Math.random = () => value;
    try { return await body(); } finally { Math.random = original; }
}

async function main() {
    const world = await createWorld(CHARACTERS, 'c4-orc-bounty');
    const runtimeWorld = enableQuestSpawns();
    try {
        await darkWingedSpies(world, runtimeWorld);
        await totemOfTheHestui(world, runtimeWorld);
        console.log('C4 Q275/Q276: source-backed drop chances, list ownership, spawn '
            + 'thresholds and coordinates, ownership metadata, rewards and restart passed');
    } finally {
        await world.close();
    }
}

async function darkWingedSpies(world, runtimeWorld) {
    const TANTUS = 7567;
    const BAT = 316;
    const TRACKER = 5043;
    const FANG = 1478;
    const PARASITE = 1479;
    const PLACE = { locX: 12345, locY: -54321, locZ: -2500, head: 4321 };

    // Race and level gates leave no state behind.
    const human = await world.session(2752);
    assert.equal(await world.event(human, 275, 'start', TANTUS), false, 'Q275 refuses a non-Orc');
    assert.equal(await world.questRow(2752, 275), null, 'the race refusal left no state');
    const child = await world.session(2753);
    assert.equal(await world.event(child, 275, 'start', TANTUS), false, 'Q275 refuses level 10');

    let session = await world.session(275);
    assert.ok(await world.event(session, 275, 'start', TANTUS), 'Tantus accepts a level 11 Orc');

    // Ordinary collection: one fang per bat, no tracker below the lower bound.
    for (let i = 0; i < 10; i++) {
        await withRoll(0, () => Service.onKill(session, corpse(BAT, PLACE)));
    }
    assert.equal(await world.amount(275, FANG), 10, 'each bat yields exactly one fang');
    assert.equal(await world.amount(275, PARASITE), 0,
        'the tracker cannot appear at ten fangs even on the best roll');

    // The lower bound is exclusive: eleven fangs is the first eligible count.
    await withRoll(0.05, () => Service.onKill(session, corpse(BAT, PLACE)));
    assert.equal(await world.amount(275, FANG), 11, 'the eleventh fang landed');
    assert.equal(await world.amount(275, PARASITE), 1, 'the tracker appears from eleven fangs');

    const spawned = runtimeWorld.npc.spawns.filter(npc => Number(npc.fetchSelfId()) === TRACKER);
    assert.equal(spawned.length, 1, "exactly one Varangka's Tracker was spawned");
    const tracker = spawned[0];
    assert.equal(tracker.fetchLocX(), PLACE.locX, 'the tracker stands where the bat died (X)');
    assert.equal(tracker.fetchLocY(), PLACE.locY, 'the tracker stands where the bat died (Y)');
    assert.equal(tracker.fetchLocZ(), PLACE.locZ, 'the tracker stands where the bat died (Z)');
    assert.equal(tracker.questSpawn.ownerId, 275, 'the tracker belongs to the character who provoked it');
    assert.equal(tracker.questSpawn.questId, 275, 'the tracker carries its quest identity');

    // The 10% boundary is exclusive.
    await withRoll(0.1, () => Service.onKill(session, corpse(BAT, PLACE)));
    assert.equal(await world.amount(275, PARASITE), 1, 'a roll of exactly 0.1 spawns nothing');
    await withRoll(0.099, () => Service.onKill(session, corpse(BAT, PLACE)));
    assert.equal(await world.amount(275, PARASITE), 2, 'a roll just below 0.1 spawns the tracker');

    // The tracker pays nothing without a parasite in hand.
    const bare = await world.session(2751);
    assert.ok(await world.event(bare, 275, 'start', TANTUS));
    await withRoll(0, () => Service.onKill(bare, corpse(TRACKER, PLACE)));
    assert.equal(await world.amount(2751, FANG), 0, 'the tracker pays nothing without a parasite');

    // The tracker pays five fangs and consumes every parasite.
    const before = await world.amount(275, FANG);
    await withRoll(0.5, () => Service.onKill(session, corpse(TRACKER, PLACE)));
    assert.equal(await world.amount(275, FANG), before + 5, 'the tracker pays five fangs');
    assert.equal(await world.amount(275, PARASITE), 0, 'every parasite is consumed');

    // Ordinary collection survives a restart.
    session = await world.reopen(275);
    assert.equal(world.state(session, 275).getInt('cond'), 1, 'the hunt survives a restart');
    const carried = await world.amount(275, FANG);
    await withRoll(0.5, () => Service.onKill(session, corpse(BAT, PLACE)));
    assert.equal(await world.amount(275, FANG), carried + 1, 'collection continues after a restart');

    // Reaching seventy advances, and Tantus pays exactly 4200 adena.
    await Service.giveItem(session, FANG, 70 - (await world.amount(275, FANG)));
    session = await world.session(275);
    await withRoll(0.5, () => Service.onKill(session, corpse(BAT, PLACE)));
    assert.equal(world.state(session, 275).getInt('cond'), 2, 'seventy fangs advance the cond');

    assert.ok(await world.event(session, 275, 'reward', TANTUS), 'Tantus accepts the fangs');
    assert.equal(await world.amount(275, ADENA), 4200, 'Q275 pays exactly 4200 adena');
    assert.equal(await world.amount(275, FANG), 0, 'every fang is consumed');
    assert.equal(await world.amount(275, PARASITE), 0, 'every parasite is consumed');
    assert.equal(world.state(session, 275).state, 'created', 'Q275 is repeatable');
    assert.ok(await world.event(session, 275, 'start', TANTUS), 'the bounty can be taken again');
}

async function totemOfTheHestui(world, runtimeWorld) {
    const TANAPI = 7571;
    const BEAR = 479;
    const SPIRIT = 5044;
    const PARASITE = 1480;
    const CRYSTAL = 1481;
    const TOTEM = 1500;
    const PANTS = 29;
    const PLACE = { locX: -22222, locY: 33333, locZ: -3100, head: 1234 };

    const elf = await world.session(2762);
    assert.equal(await world.event(elf, 276, 'start', TANAPI), false, 'Q276 refuses a non-Orc');
    const child = await world.session(2763);
    assert.equal(await world.event(child, 276, 'start', TANAPI), false, 'Q276 refuses level 14');

    // Every authored threshold, driven at its exact boundary. `roll` is the
    // reference's getRandom(100), so a roll of r/100 reproduces integer r.
    const BOUNDARIES = [
        { parasites: 39, spawns: 0, holds: 2 },
        { parasites: 49, spawns: 10, holds: 11 },
        { parasites: 59, spawns: 15, holds: 16 },
        { parasites: 69, spawns: 20, holds: 21 },
        { parasites: 79, spawns: 99, holds: null }
    ];
    for (const boundary of BOUNDARIES) {
        for (const [roll, shouldSpawn] of [[boundary.spawns, true], [boundary.holds, false]]) {
            if (roll === null) continue;
            const probe = await world.session(2761);
            await Database.execute(['DELETE FROM items WHERE characterId = 2761']);
            await Database.execute(["DELETE FROM character_quests WHERE characterId = 2761 AND questId = 276"]);
            const fresh = await world.session(2761);
            assert.ok(await world.event(fresh, 276, 'start', TANAPI));
            await Service.giveItem(fresh, PARASITE, boundary.parasites);
            const armed = await world.session(2761);
            const before = runtimeWorld.npc.spawns
                .filter(npc => Number(npc.fetchSelfId()) === SPIRIT).length;
            await withRoll(roll / 100, () => Service.onKill(armed, corpse(BEAR, PLACE)));
            const after = runtimeWorld.npc.spawns
                .filter(npc => Number(npc.fetchSelfId()) === SPIRIT).length;
            assert.equal(after > before, shouldSpawn,
                `${boundary.parasites} parasites with roll ${roll} must ${shouldSpawn ? '' : 'not '}spawn the spirit`);
            if (shouldSpawn) {
                assert.equal(await world.amount(2761, PARASITE), 0,
                    'provoking the spirit consumes the parasites');
            } else {
                assert.equal(await world.amount(2761, PARASITE), boundary.parasites + 1,
                    'a held roll adds another parasite instead');
            }
            assert.ok(probe, 'probe session created');
        }
    }

    // The ordinary route, its spawn metadata and the reward.
    let session = await world.session(276);
    assert.ok(await world.event(session, 276, 'start', TANAPI), 'Tanapi accepts a level 15 Orc');
    await withRoll(0.99, () => Service.onKill(session, corpse(BEAR, PLACE)));
    assert.equal(await world.amount(276, PARASITE), 1, 'an ordinary bear yields one parasite');

    session = await world.reopen(276);
    assert.equal(world.state(session, 276).getInt('cond'), 1, 'collection survives a restart');
    await withRoll(0.99, () => Service.onKill(session, corpse(BEAR, PLACE)));
    assert.equal(await world.amount(276, PARASITE), 2, 'collection continues after a restart');

    await Service.giveItem(session, PARASITE, 79 - (await world.amount(276, PARASITE)));
    session = await world.session(276);
    const before = runtimeWorld.npc.spawns
        .filter(npc => Number(npc.fetchSelfId()) === SPIRIT).length;
    await withRoll(0.99, () => Service.onKill(session, corpse(BEAR, PLACE)));
    const spawned = runtimeWorld.npc.spawns
        .filter(npc => Number(npc.fetchSelfId()) === SPIRIT);
    assert.equal(spawned.length, before + 1, 'seventy-nine parasites always provoke the spirit');
    const spirit = spawned.at(-1);
    assert.equal(spirit.fetchLocX(), PLACE.locX, 'the spirit stands where the bear died (X)');
    assert.equal(spirit.fetchLocY(), PLACE.locY, 'the spirit stands where the bear died (Y)');
    assert.equal(spirit.fetchLocZ(), PLACE.locZ, 'the spirit stands where the bear died (Z)');
    assert.equal(spirit.questSpawn.ownerId, 276, 'the spirit belongs to the character who provoked it');
    assert.equal(spirit.questSpawn.questId, 276, 'the spirit carries its quest identity');
    assert.equal(await world.amount(276, PARASITE), 0, 'the parasites are consumed');

    await withRoll(0.5, () => Service.onKill(session, corpse(SPIRIT, PLACE)));
    assert.equal(await world.amount(276, CRYSTAL), 1, 'the spirit yields the Kasha Crystal');
    assert.equal(world.state(session, 276).getInt('cond'), 2, 'the crystal advances the cond');

    // With the crystal in hand ordinary bears stop producing parasites.
    await withRoll(0.99, () => Service.onKill(session, corpse(BEAR, PLACE)));
    assert.equal(await world.amount(276, PARASITE), 0, 'bears are ignored once the crystal is held');
    await withRoll(0.5, () => Service.onKill(session, corpse(SPIRIT, PLACE)));
    assert.equal(await world.amount(276, CRYSTAL), 1, 'a second spirit yields no duplicate crystal');

    assert.ok(await world.event(session, 276, 'reward', TANAPI), 'Tanapi accepts the crystal');
    assert.equal(await world.amount(276, TOTEM), 1, 'the Totem of Hestui is awarded');
    assert.equal(await world.amount(276, PANTS), 1, 'the Leather Pants are awarded');
    assert.equal(await world.amount(276, CRYSTAL), 0, 'the crystal is consumed');
    assert.equal(world.state(session, 276).state, 'created', 'Q276 is repeatable');
    assert.ok(await world.event(session, 276, 'start', TANAPI), 'the bounty can be taken again');
    assert.ok(DataCache.npcs.find(npc => npc.selfId === SPIRIT), 'the spirit template exists locally');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
