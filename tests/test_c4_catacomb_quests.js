// Lifecycle certification for Q385 Yoke of the Past and Q634 In Search of
// Fragments of the Dimension.
//
// Both were blocked as needing Seven Signs integration. The pinned C4 handlers
// contain no Seven Signs condition of any kind, so the first thing asserted here
// is what they really are: two standing catacomb errands, one paying a blank
// scroll per scroll and one paying fragments that scale with what died.
//
// Q385 gives all forty-one targets their own chance, so every one is driven at
// its exact boundary rather than sampled. Q634's amount formula is checked
// against real monster levels, including where its truncation changes the payout.
const assert = require('node:assert/strict');
const { createWorld, Service, DataCache } = require('./helpers/c4QuestHarness');

const ANCIENT_SCROLL = 5902;
const BLANK_SCROLL = 5965;
const DIMENSION_FRAGMENT = 7079;

const FIRST_GATEKEEPER = 8095;
const LAST_GATEKEEPER = 8126;
const FIRST_KEEPER = 8494;
const LAST_KEEPER = 8507;

const CHARACTERS = [
    { id: 3850, level: 20 }, { id: 3851, level: 19 }, { id: 3852, level: 20 },
    { id: 6340, level: 20 }, { id: 6341, level: 19 }, { id: 6342, level: 20 }
];

const corpse = (selfId, level = 20) => ({
    fetchSelfId: () => selfId,
    fetchId: () => 900000 + selfId,
    fetchLevel: () => level,
    isSpoil: () => false
});

async function withRoll(value, body) {
    const original = Math.random;
    Math.random = () => value;
    try { return await body(); } finally { Math.random = original; }
}

const questFor = (id) => Service.quests().find((quest) => quest.id === id);

async function main() {
    const world = await createWorld(CHARACTERS, 'c4-catacombs');
    try {
        restoredKeepers();
        await yokeOfThePast(world);
        await fragmentsOfDimension(world);
        console.log('C4 Q385/Q634: restored Dimension Keepers, every one of the forty-one catacomb '
            + 'drop chances, the scroll-for-scroll exchange, the level-scaled fragment payout and '
            + 'both quests reachable from every one of their NPCs passed');
    } finally {
        await world.close();
    }
}

function restoredKeepers() {
    const spawned = new Set();
    for (const group of DataCache.npcSpawns) {
        for (const spawn of group.spawns) {
            if (spawn.coords?.length) spawned.add(Number(spawn.selfId));
        }
    }

    // The fourteen Dimension Keepers were absent entirely; one stands at each
    // catacomb or necropolis, exactly as the reference places them.
    for (let selfId = FIRST_KEEPER; selfId <= LAST_KEEPER; selfId++) {
        const npc = DataCache.npcs.find((entry) => entry.selfId === selfId);
        assert.equal(npc?.template?.name, 'Dimension Keeper', `${selfId} is a Dimension Keeper`);
        assert.ok(spawned.has(selfId), `Dimension Keeper ${selfId} stands in the world`);
    }

    // The Gatekeepers Ziggurat were already present; assert it rather than assume.
    const gatekeepers = questFor(385).npcs;
    assert.equal(gatekeepers.length, 29, 'twenty-nine Gatekeeper Ziggurat serve this errand');
    for (const selfId of gatekeepers) {
        assert.ok(selfId >= FIRST_GATEKEEPER && selfId <= LAST_GATEKEEPER, `${selfId} is in range`);
        assert.ok(DataCache.npcs.some((entry) => entry.selfId === selfId), `${selfId} resolves`);
        assert.ok(spawned.has(selfId), `Gatekeeper Ziggurat ${selfId} stands in the world`);
    }

    // Both quests hunt the same forty-one catacomb dwellers.
    const yoke = new Set(questFor(385).killNpcs);
    const fragments = new Set(questFor(634).killNpcs);
    assert.equal(yoke.size, 41, 'Q385 lists forty-one targets');
    assert.equal(fragments.size, 41, 'Q634 lists the same forty-one');
    assert.deepEqual([...yoke].sort(), [...fragments].sort(), 'and they are the same set');
    for (const selfId of yoke) {
        assert.ok(DataCache.npcs.some((entry) => entry.selfId === selfId), `target ${selfId} resolves`);
        assert.ok(spawned.has(selfId), `target ${selfId} stands in the world`);
    }
    // The seven unspawned ids are excluded on purpose.
    for (const selfId of [1212, 1216, 1220, 1232, 1233, 1234, 1235]) {
        assert.equal(yoke.has(selfId), false, `unspawned ${selfId} is not a target`);
    }
}

async function yokeOfThePast(world) {
    const young = await world.session(3851);
    assert.equal(await world.event(young, 385, 'start', FIRST_GATEKEEPER), false,
        'Q385 refuses level 19');

    let session = await world.session(3850);
    assert.deepEqual(await world.links(session, FIRST_GATEKEEPER, 385), ['start'],
        'a gatekeeper offers the errand');
    assert.ok(await world.event(session, 385, 'start', FIRST_GATEKEEPER), 'a level 20 adventurer may start');

    // Every one of the forty-one targets drops at its own authored chance. The
    // table is restated here on purpose: it is the contract, and each entry is
    // driven at its exact boundary rather than sampled.
    const CHANCES = [
        [1208, 0.07], [1209, 0.08], [1210, 0.11], [1211, 0.11], [1213, 0.14],
        [1214, 0.19], [1215, 0.19], [1217, 0.24], [1218, 0.3], [1219, 0.3],
        [1221, 0.37], [1222, 0.46], [1223, 0.45], [1224, 0.5], [1225, 0.54],
        [1226, 0.66], [1227, 0.64], [1228, 0.7], [1229, 0.75], [1230, 0.91],
        [1231, 0.86], [1236, 0.12], [1237, 0.14], [1238, 0.19], [1239, 0.19],
        [1240, 0.22], [1241, 0.24], [1242, 0.3], [1243, 0.3], [1244, 0.34],
        [1245, 0.37], [1246, 0.46], [1247, 0.45], [1248, 0.5], [1249, 0.54],
        [1250, 0.66], [1251, 0.64], [1252, 0.7], [1253, 0.75], [1254, 0.91],
        [1255, 0.86]
    ];
    assert.deepEqual(CHANCES.map(([selfId]) => selfId).sort(), [...questFor(385).killNpcs].sort(),
        'the table covers exactly the targets the quest lists');

    let expected = 0;
    for (const [selfId, chance] of CHANCES) {
        await withRoll(chance, () => Service.onKill(session, corpse(selfId)));
        assert.equal(await world.amount(3850, ANCIENT_SCROLL), expected,
            `target ${selfId} drops nothing at exactly its ${chance} chance`);
        await withRoll(chance - 0.001, () => Service.onKill(session, corpse(selfId)));
        expected++;
        assert.equal(await world.amount(3850, ANCIENT_SCROLL), expected,
            `target ${selfId} drops just below its ${chance} chance`);
    }
    assert.equal(expected, 41, 'every target yielded exactly one scroll');

    // A target from outside the catacombs yields nothing.
    await withRoll(0, () => Service.onKill(session, corpse(20)));
    assert.equal(await world.amount(3850, ANCIENT_SCROLL), expected, 'an outside monster yields nothing');

    // The exchange is one blank scroll per scroll, and survives a restart.
    session = await world.reopen(3850);
    const carried = await world.amount(3850, ANCIENT_SCROLL);
    assert.equal(carried, expected, 'the scrolls survived a restart');
    await world.event(session, 385, 'exchange', LAST_GATEKEEPER);
    assert.equal(await world.amount(3850, BLANK_SCROLL), carried, 'one blank scroll per scroll');
    assert.equal(await world.amount(3850, ANCIENT_SCROLL), 0, 'every scroll is surrendered');
    assert.equal(world.state(session, 385).state, 'started', 'the errand continues');

    // An empty exchange pays nothing, and any gatekeeper serves.
    assert.equal(await world.event(session, 385, 'exchange', 8114), false, 'no scrolls, no exchange');
    await withRoll(0, () => Service.onKill(session, corpse(1208)));
    await world.event(session, 385, 'exchange', 8114);
    assert.equal(await world.amount(3850, BLANK_SCROLL), carried + 1,
        'a different gatekeeper honours the same errand');

    // Ending the errand surrenders uncashed scrolls and releases the quest.
    await withRoll(0, () => Service.onKill(session, corpse(1208)));
    await world.event(session, 385, 'quit', FIRST_GATEKEEPER);
    assert.equal(await world.amount(3850, ANCIENT_SCROLL), 0, 'quitting surrenders uncashed scrolls');
    assert.equal(await world.amount(3850, BLANK_SCROLL), carried + 1, 'quitting pays nothing');
    assert.equal(world.state(session, 385).state, 'created', 'the errand is released, not completed');
    assert.ok(await world.event(session, 385, 'start', 8126), 'and it can be taken again anywhere');

    // Somebody else's kills are not credited.
    const stranger = await world.session(3852);
    await withRoll(0, () => Service.onKill(stranger, corpse(1208)));
    assert.equal(await world.amount(3852, ANCIENT_SCROLL), 0, 'no quest, no scroll');
}

async function fragmentsOfDimension(world) {
    const young = await world.session(6341);
    assert.equal(await world.event(young, 634, 'start', FIRST_KEEPER), false, 'Q634 refuses level 19');

    let session = await world.session(6340);
    assert.deepEqual(await world.links(session, FIRST_KEEPER, 634), ['start'], 'a keeper offers the errand');
    assert.ok(await world.event(session, 634, 'start', FIRST_KEEPER), 'a level 20 adventurer may start');

    // The drop is one kill in twelve and a half, exclusive at the boundary.
    await withRoll(0.08, () => Service.onKill(session, corpse(1208, 20)));
    assert.equal(await world.amount(6340, DIMENSION_FRAGMENT), 0, 'nothing at exactly 0.08');

    // The amount is floor(level * 0.15 + 2.6): five at level 20, six at 23,
    // seven at 30, eight at 36.
    const PAYOUTS = [[20, 5], [23, 6], [30, 7], [36, 8], [50, 10]];
    let total = 0;
    for (const [level, amount] of PAYOUTS) {
        await withRoll(0.079, () => Service.onKill(session, corpse(1208, level)));
        total += amount;
        assert.equal(await world.amount(6340, DIMENSION_FRAGMENT), total,
            `a level ${level} kill yields ${amount} fragments`);
    }

    // An id the reference loops over but C4 never spawns is not a target.
    await withRoll(0, () => Service.onKill(session, corpse(1212, 30)));
    assert.equal(await world.amount(6340, DIMENSION_FRAGMENT), total,
        'an unspawned catacomb id yields nothing');

    // The fragments are ordinary goods, so ending the errand leaves them alone.
    session = await world.reopen(6340);
    assert.equal(await world.amount(6340, DIMENSION_FRAGMENT), total, 'the fragments survived a restart');
    await world.event(session, 634, 'quit', LAST_KEEPER);
    assert.equal(world.state(session, 634).state, 'created', 'the errand is released');
    assert.equal(await world.amount(6340, DIMENSION_FRAGMENT), total, 'and the fragments are kept');
    assert.ok(await world.event(session, 634, 'start', LAST_KEEPER), 'any keeper can reopen it');

    const stranger = await world.session(6342);
    await withRoll(0, () => Service.onKill(stranger, corpse(1208, 40)));
    assert.equal(await world.amount(6342, DIMENSION_FRAGMENT), 0, 'no quest, no fragment');
}

main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
