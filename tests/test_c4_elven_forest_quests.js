// Lifecycle certification for Q266 Pleas of Pixies and Q267 Wrath of Verdure.
//
// Both were blocked because two local templates carry each quest-giver's name.
// The mapping is settled here by evidence rather than by resemblance, and the
// evidence is asserted first: the chosen templates are the ones with a world
// spawn, and Pixy Murika's spawn is byte-identical to the pinned reference's.
//
// Q266's four targets each have their own chance AND their own amount, so every
// one is driven at its exact boundary. Q267 pays a leaf per club rather than a
// flat sum, so the count is asserted across several hand-ins, with and without
// the ten-club bonus.
const assert = require('node:assert/strict');
const { createWorld, Service, DataCache } = require('./helpers/c4QuestHarness');

const ADENA = 57;
const ELF = 1;

const MURIKA = 12091;
const BREMEC = 12092;

const GRAY_WOLF = 525;
const YOUNG_RED_KELTIR = 530;
const RED_KELTIR = 534;
const ELDER_RED_KELTIR = 537;
const GOBLIN_RAIDER = 325;

const PREDATOR_FANG = 1334;
const GOBLIN_CLUB = 1335;
const GLASS_SHARD = 1336;
const EMERALD = 1337;
const BLUE_ONYX = 1338;
const ONYX = 1339;
const SILVERY_LEAF = 1340;

const CHARACTERS = [
    { id: 2660, race: ELF, level: 20 }, { id: 2661, race: 0, level: 20 }, { id: 2662, race: ELF, level: 2 },
    // One character per Q266 reward row.
    { id: 2663, race: ELF, level: 20 }, { id: 2664, race: ELF, level: 20 },
    { id: 2665, race: ELF, level: 20 }, { id: 2666, race: ELF, level: 20 },
    { id: 2670, race: ELF, level: 20 }, { id: 2671, race: 0, level: 20 }, { id: 2672, race: ELF, level: 3 }
];

const corpse = (selfId) => ({ fetchSelfId: () => selfId, fetchId: () => 900000 + selfId, isSpoil: () => false });

async function withRolls(values, body) {
    const original = Math.random;
    const queue = [...values];
    let last = values[values.length - 1];
    Math.random = () => (queue.length ? (last = queue.shift()) : last);
    try { return await body(); } finally { Math.random = original; }
}

async function main() {
    const world = await createWorld(CHARACTERS, 'c4-elven-forest');
    try {
        resolvedMapping();
        await pleasOfPixies(world);
        await pixieRewards(world);
        await wrathOfVerdure(world);
        console.log('C4 Q266/Q267: Murika and Bremec resolved by spawn evidence, per-target fang '
            + 'chances and amounts, all four pixie reward rows, and the leaf-per-club hand-in '
            + 'with its ten-club bonus passed');
    } finally {
        await world.close();
    }
}

// The mapping is an evidence claim, so it is asserted like one.
function resolvedMapping() {
    const spawned = new Map();
    for (const group of DataCache.npcSpawns) {
        for (const spawn of group.spawns) {
            if (!spawn.coords?.length) continue;
            spawned.set(Number(spawn.selfId), spawn.coords);
        }
    }

    for (const [selfId, name] of [[MURIKA, 'Pixy Murika'], [BREMEC, 'Treant Bremec']]) {
        const npc = DataCache.npcs.find((entry) => entry.selfId === selfId);
        assert.equal(npc?.template?.name, name, `${selfId} is ${name}`);
        assert.ok(spawned.has(selfId), `${name} ${selfId} stands in the world`);
    }

    // The duplicates that made the mapping ambiguous carry the same names and no
    // world spawn at all, which is exactly why they are not the quest-givers.
    for (const [selfId, name] of [[195, 'Pixy Murika'], [196, 'Treant Bremec']]) {
        const npc = DataCache.npcs.find((entry) => entry.selfId === selfId);
        assert.equal(npc?.template?.name, name, `${selfId} carries the same name`);
        assert.equal(spawned.has(selfId), false, `the ${selfId} alias has no world spawn`);
    }

    // Importing the quests must not move existing quest-givers.
    assert.deepEqual(spawned.get(MURIKA)[0], { locX: 49262, locY: 53607, locZ: -3216, head: 53248 },
        'Pixy Murika stands at the reference position');
    assert.deepEqual(spawned.get(BREMEC)[0], { locX: 35689, locY: 47039, locZ: -3609, head: 0 },
        'Treant Bremec retains the existing local position');
}

async function pleasOfPixies(world) {
    const human = await world.session(2661);
    assert.equal(await world.event(human, 266, 'start', MURIKA), false, 'Q266 refuses a non-Elf');
    const young = await world.session(2662);
    assert.equal(await world.event(young, 266, 'start', MURIKA), false, 'Q266 refuses level 2');

    let session = await world.session(2660);
    assert.ok(await world.event(session, 266, 'start', MURIKA), 'a level 3 Elf may start');

    // The grey wolf always yields, two or three fangs on an even split.
    await withRolls([0, 0.49], () => Service.onKill(session, corpse(GRAY_WOLF)));
    assert.equal(await world.amount(2660, PREDATOR_FANG), 2, 'the grey wolf yields two on a low roll');
    await withRolls([0, 0.51], () => Service.onKill(session, corpse(GRAY_WOLF)));
    assert.equal(await world.amount(2660, PREDATOR_FANG), 5, 'the grey wolf yields three on a high roll');

    // The elder red keltir always yields exactly two.
    await withRolls([0.999], () => Service.onKill(session, corpse(ELDER_RED_KELTIR)));
    assert.equal(await world.amount(2660, PREDATOR_FANG), 7, 'the elder keltir always yields two');

    // The young red keltir yields one, four times in five.
    await withRolls([0.8], () => Service.onKill(session, corpse(YOUNG_RED_KELTIR)));
    assert.equal(await world.amount(2660, PREDATOR_FANG), 7, 'nothing at exactly its 0.8 chance');
    await withRolls([0.79], () => Service.onKill(session, corpse(YOUNG_RED_KELTIR)));
    assert.equal(await world.amount(2660, PREDATOR_FANG), 8, 'one fang just below its 0.8 chance');

    // The red keltir yields three times in five, one fang a third of the time.
    await withRolls([0.6], () => Service.onKill(session, corpse(RED_KELTIR)));
    assert.equal(await world.amount(2660, PREDATOR_FANG), 8, 'nothing at exactly its 0.6 chance');
    await withRolls([0.59, 0.32], () => Service.onKill(session, corpse(RED_KELTIR)));
    assert.equal(await world.amount(2660, PREDATOR_FANG), 9, 'one fang on the low third');
    await withRolls([0.59, 0.34], () => Service.onKill(session, corpse(RED_KELTIR)));
    assert.equal(await world.amount(2660, PREDATOR_FANG), 11, 'two fangs otherwise');

    // The collection stops at a hundred and survives a restart.
    await Service.giveItem(session, PREDATOR_FANG, 88);
    session = await world.reopen(2660);
    assert.equal(await world.amount(2660, PREDATOR_FANG), 99, 'ninety-nine fangs survive a restart');
    await withRolls([0], () => Service.onKill(session, corpse(ELDER_RED_KELTIR)));
    assert.equal(await world.amount(2660, PREDATOR_FANG), 100, 'the collection stops at a hundred');
    assert.equal(world.state(session, 266).getInt('cond'), 2, 'a hundred fangs advance the quest');
    await withRolls([0], () => Service.onKill(session, corpse(GRAY_WOLF)));
    assert.equal(await world.amount(2660, PREDATOR_FANG), 100, 'no fang is collected past a hundred');
}

// Murika's reward is a four-way draw; each row is asserted at its own roll.
async function pixieRewards(world) {
    const ROWS = [[0.05, EMERALD], [0.2, BLUE_ONYX], [0.45, ONYX], [0.8, GLASS_SHARD]];
    for (let index = 0; index < ROWS.length; index++) {
        const [roll, item] = ROWS[index];
        const id = 2663 + index;
        let session = await world.session(id);
        await world.event(session, 266, 'start', MURIKA);
        await Service.giveItem(session, PREDATOR_FANG, 100);
        session = await world.session(id);
        await withRolls([roll], () => world.talk(session, MURIKA));
        assert.equal(await world.amount(id, item), 1, `a roll of ${roll} pays item ${item}`);
        assert.equal(await world.amount(id, PREDATOR_FANG), 0, `row ${index}: the fangs are consumed`);
        assert.equal(world.state(session, 266).state, 'created', `row ${index}: Q266 is repeatable`);
        for (const other of [EMERALD, BLUE_ONYX, ONYX, GLASS_SHARD].filter((entry) => entry !== item)) {
            assert.equal(await world.amount(id, other), 0, `row ${index}: only one reward is paid`);
        }
    }
}

async function wrathOfVerdure(world) {
    const human = await world.session(2671);
    assert.equal(await world.event(human, 267, 'start', BREMEC), false, 'Q267 refuses a non-Elf');
    const young = await world.session(2672);
    assert.equal(await world.event(young, 267, 'start', BREMEC), false, 'Q267 refuses level 3');

    let session = await world.session(2670);
    assert.deepEqual(await world.links(session, BREMEC, 267), ['start'], 'Bremec offers the task');
    assert.ok(await world.event(session, 267, 'start', BREMEC), 'a level 4 Elf may start');

    // Clubs drop half the time, with no cap of any kind.
    await withRolls([0.5], () => Service.onKill(session, corpse(GOBLIN_RAIDER)));
    assert.equal(await world.amount(2670, GOBLIN_CLUB), 0, 'nothing at exactly a half');
    for (let i = 0; i < 4; i++) {
        await withRolls([0.49], () => Service.onKill(session, corpse(GOBLIN_RAIDER)));
    }
    assert.equal(await world.amount(2670, GOBLIN_CLUB), 4, 'four clubs below a half');

    // A small hand-in pays one leaf per club and no bonus.
    assert.deepEqual((await world.links(session, BREMEC, 267)).sort(), ['quit', 'reward'],
        'Bremec offers both the hand-in and an end to the task');
    await world.event(session, 267, 'reward', BREMEC);
    assert.equal(await world.amount(2670, SILVERY_LEAF), 4, 'four clubs pay four leaves');
    assert.equal(await world.amount(2670, GOBLIN_CLUB), 0, 'the clubs are surrendered');
    assert.equal(await world.amount(2670, ADENA), 0, 'four clubs pay no bonus');
    assert.equal(world.state(session, 267).state, 'started', 'the task continues after a hand-in');

    // An empty hand-in pays nothing at all.
    assert.equal(await world.event(session, 267, 'reward', BREMEC), false, 'no clubs, no payment');
    assert.equal(await world.amount(2670, SILVERY_LEAF), 4, 'and nothing is paid twice');

    // Ten clubs add the bonus, and the leaves still match the clubs exactly.
    await Service.giveItem(session, GOBLIN_CLUB, 10);
    session = await world.reopen(2670);
    assert.equal(await world.amount(2670, GOBLIN_CLUB), 10, 'ten clubs survive a restart');
    await world.event(session, 267, 'reward', BREMEC);
    assert.equal(await world.amount(2670, SILVERY_LEAF), 14, 'ten more clubs pay ten more leaves');
    assert.equal(await world.amount(2670, ADENA), 600, 'ten clubs pay exactly 600 adena');

    // Nine clubs are one short of the bonus.
    await Service.giveItem(session, GOBLIN_CLUB, 9);
    session = await world.session(2670);
    await world.event(session, 267, 'reward', BREMEC);
    assert.equal(await world.amount(2670, SILVERY_LEAF), 23, 'nine clubs pay nine leaves');
    assert.equal(await world.amount(2670, ADENA), 600, 'nine clubs pay no further bonus');

    // Ending the task releases it and keeps nothing back.
    await Service.giveItem(session, GOBLIN_CLUB, 3);
    session = await world.session(2670);
    await world.event(session, 267, 'quit', BREMEC);
    assert.equal(world.state(session, 267).state, 'created', 'the task is released, not completed');
    assert.equal(await world.amount(2670, GOBLIN_CLUB), 0, 'unpaid clubs are surrendered on quitting');
    assert.equal(await world.amount(2670, SILVERY_LEAF), 23, 'quitting pays nothing');
    assert.ok(await world.event(session, 267, 'start', BREMEC), 'the task can be taken again');
}

main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
