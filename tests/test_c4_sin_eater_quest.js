// Lifecycle certification for Q422 Repent Your Sins.
//
// The Sin Eater itself is not this quest's invention: PetRules already maps the
// Penitent's Manacles to summon 12564 and the pet runtime already levels and
// persists it. That wiring is asserted first, because the quest is only real if
// the collar it pays out actually summons something.
//
// What the quest owns is the errand and the reckoning, and the reckoning is the
// only authoritative way a character's PK count falls. It is therefore probed
// hard: no reckoning without a Sin Eater that has grown, none while it is
// summoned, none twice from one collar, and none at all for a character with a
// clean record.
const assert = require('node:assert/strict');
const { createWorld, Service, Database, DataCache } = require('./helpers/c4QuestHarness');

const BLACK_JUDGE = 7981;
const KATARI = 7668;
const PIOTUR = 7597;
const CASIAN = 7612;
const JOAN = 7718;
const PUSHKIN = 7300;

const RATMAN_SKULL = 4326;
const WAR_HOUND_TAIL = 4327;
const KINGPIN_HEART = 4328;
const VENOM_SAC = 4329;
const CRAFTED_MANACLES = 4330;
const MANUAL_OF_MANACLES = 4331;
const PENITENT_MANACLES = 4425;
const LEFTOVER_MANACLES = 4426;

const FORGE_COST = [[1873, 10], [1877, 2], [1879, 10], [1880, 5], [1892, 1]];
const SIN_EATER_NPC = 12564;

// [band level, sentencing NPC, hunting cond, done cond, target, item, required]
const SENTENCES = [
    [18, KATARI, 6, 10, 39, RATMAN_SKULL, 10],
    [25, PIOTUR, 7, 11, 494, WAR_HOUND_TAIL, 10],
    [35, CASIAN, 8, 12, 193, KINGPIN_HEART, 1],
    [50, JOAN, 9, 13, 561, VENOM_SAC, 3]
];

const CHARACTERS = [
    // One runner per sentencing band, all with sins to answer for.
    ...SENTENCES.map(([level], index) => ({ id: 4220 + index, level, pk: 20 })),
    { id: 4229, level: 40, pk: 0 },     // a clean record
    { id: 4228, level: 40, pk: 3 }      // few enough sins to be cleared outright
];

const corpse = (selfId) => ({ fetchSelfId: () => selfId, fetchId: () => 900000 + selfId, isSpoil: () => false });

async function withRoll(value, body) {
    const original = Math.random;
    Math.random = () => value;
    try { return await body(); } finally { Math.random = original; }
}

// Writes the Sin Eater's saved state onto the collar, which is where this
// server keeps a pet's level and where the quest reads it from.
async function setSinEaterLevel(world, id, level) {
    const [row] = await Database.execute(
        ['SELECT id FROM items WHERE characterId = ? AND selfId = ? ORDER BY id LIMIT 1', [id, PENITENT_MANACLES]]);
    assert.ok(row, 'the character carries the collar');
    await Database.execute(['UPDATE items SET petData = ? WHERE id = ?',
        [JSON.stringify({ version: 1, npcId: SIN_EATER_NPC, level, exp: 0, hp: 31, mp: 26 }), row.id]]);
}

async function main() {
    const world = await createWorld(CHARACTERS, 'c4-sin-eater');
    try {
        existingPetWiring();
        await sentencingBands(world);
        await theReckoning(world);
        await cleanRecordRefused(world);
        console.log('C4 Q422: the existing Sin Eater pet wiring, all four sentencing bands, '
            + "Pushkin's forge, the collar hand-over and every guard on the PK reckoning passed");
    } finally {
        await world.close();
    }
}

// The quest pays out a pet collar; the pet it summons must already be real.
function existingPetWiring() {
    const PetRules = require('../src/GameServer/Pets/PetRules');
    assert.equal(PetRules.TYPES[PENITENT_MANACLES]?.npcId, SIN_EATER_NPC,
        'the collar summons the Sin Eater');
    assert.equal(PetRules.TYPES[PENITENT_MANACLES].name, 'Sin Eater', 'and it is named as one');
    assert.ok(PetRules.typeForNpc(SIN_EATER_NPC), 'the Sin Eater is a known pet type');
    assert.ok(PetRules.stats(SIN_EATER_NPC, 1), 'it has a level-one stat row');
    assert.ok(PetRules.stats(SIN_EATER_NPC, 40), 'and it can grow');

    const summon = require('../src/GameServer/Items/C4ItemSkills').ITEM_SKILLS[PENITENT_MANACLES];
    assert.equal(summon?.npcId, SIN_EATER_NPC, 'the collar carries its summon wiring');
    assert.equal(summon.consume, false, 'and using it does not consume the collar');

    const collar = DataCache.items.find((item) => item.selfId === PENITENT_MANACLES);
    assert.equal(collar?.template?.kind, 'Other.PetCollar', 'the collar is a pet collar');
    const leftover = DataCache.items.find((item) => item.selfId === LEFTOVER_MANACLES);
    assert.ok(leftover, 'the spent pair resolves');

    // The Black Judge was absent and is restored; without him the quest has no
    // start at all.
    const judge = DataCache.npcs.find((npc) => npc.selfId === BLACK_JUDGE);
    assert.equal(judge?.template?.name, 'Black Judge', 'the Black Judge resolves');
    const spawns = DataCache.npcSpawns.flatMap((group) => group.spawns)
        .filter((spawn) => Number(spawn.selfId) === BLACK_JUDGE)
        .flatMap((spawn) => spawn.coords);
    assert.equal(spawns.length, 3, 'the Black Judge stands in all three of his places');
}

// Every band sends the character to its own NPC, for its own proof.
async function sentencingBands(world) {
    for (let index = 0; index < SENTENCES.length; index++) {
        const [, npc, hunting, done, target, item, required] = SENTENCES[index];
        const id = 4220 + index;
        let session = await world.session(id);

        assert.deepEqual(await world.links(session, BLACK_JUDGE, 422), ['start'],
            `band ${index}: the Black Judge offers the sentence`);
        assert.ok(await world.event(session, 422, 'start', BLACK_JUDGE), `band ${index}: sentenced`);
        assert.equal(world.state(session, 422).getInt('cond'), index + 2,
            `band ${index}: the sentence lands on its own cond`);

        // Another band's NPC will not take this sentence.
        const stranger = SENTENCES[(index + 1) % SENTENCES.length][1];
        await world.talk(session, stranger);
        assert.equal(world.state(session, 422).getInt('cond'), index + 2,
            `band ${index}: another sentencing NPC changes nothing`);

        await world.talk(session, npc);
        assert.equal(world.state(session, 422).getInt('cond'), hunting,
            `band ${index}: the errand begins`);

        // Only this band's target yields, and only up to what was asked.
        await Service.onKill(session, corpse(SENTENCES[(index + 1) % SENTENCES.length][4]));
        assert.equal(await world.amount(id, item), 0, `band ${index}: another band's target yields nothing`);
        for (let n = 0; n < required + 2; n++) await Service.onKill(session, corpse(target));
        assert.equal(await world.amount(id, item), required, `band ${index}: the collection is capped`);

        session = await world.reopen(id);
        await world.talk(session, npc);
        assert.equal(await world.amount(id, item), 0, `band ${index}: the proof is surrendered`);
        assert.equal(world.state(session, 422).getInt('cond'), done, `band ${index}: the sentence is served`);

        // The Black Judge issues the manual, and Pushkin forges the manacles.
        await world.talk(session, BLACK_JUDGE);
        assert.equal(await world.amount(id, MANUAL_OF_MANACLES), 1, `band ${index}: the manual is issued`);
        assert.equal(world.state(session, 422).getInt('cond'), 14, `band ${index}: the forge stage`);

        await world.talk(session, PUSHKIN);
        assert.equal(await world.amount(id, CRAFTED_MANACLES), 0,
            `band ${index}: Pushkin forges nothing without the materials`);
        assert.equal(await world.amount(id, MANUAL_OF_MANACLES), 1, `band ${index}: and keeps the manual`);

        for (const [selfId, amount] of FORGE_COST) await Service.giveItem(session, selfId, amount);
        session = await world.session(id);
        await world.talk(session, PUSHKIN);
        assert.equal(await world.amount(id, CRAFTED_MANACLES), 1, `band ${index}: the manacles are forged`);
        assert.equal(await world.amount(id, MANUAL_OF_MANACLES), 0, `band ${index}: the manual is consumed`);
        for (const [selfId] of FORGE_COST) {
            assert.equal(await world.amount(id, selfId), 0, `band ${index}: material ${selfId} is consumed`);
        }
        assert.equal(world.state(session, 422).getInt('cond'), 15, `band ${index}: ready for the collar`);
    }
}

async function theReckoning(world) {
    const id = 4220;
    let session = await world.session(id);

    assert.deepEqual(await world.links(session, BLACK_JUDGE, 422), ['manacles'],
        'the Black Judge takes the forged manacles');
    await world.event(session, 422, 'manacles', BLACK_JUDGE);
    assert.equal(await world.amount(id, PENITENT_MANACLES), 1, 'the collar is issued');
    assert.equal(await world.amount(id, CRAFTED_MANACLES), 0, 'the forged pair is consumed');
    assert.equal(world.state(session, 422).getInt('cond'), 16, 'the reckoning stage');
    const issuedAt = world.state(session, 422).getInt('level');
    assert.equal(issuedAt, 18, 'the level at issue is recorded');

    // A Sin Eater that has not grown buys nothing.
    await setSinEaterLevel(world, id, issuedAt);
    session = await world.session(id);
    assert.equal(await world.event(session, 422, 'repent', BLACK_JUDGE), true,
        'the Black Judge answers');
    assert.equal(await world.amount(id, PENITENT_MANACLES), 1, 'but the collar is not spent');
    assert.equal((await world.character(id)).pk, 20, 'and no sin is struck off');

    // Nor does one that has grown but is still summoned.
    await setSinEaterLevel(world, id, issuedAt + 1);
    session = await world.session(id);
    session.actor.pet = { fetchSelfId: () => SIN_EATER_NPC };
    await world.event(session, 422, 'repent', BLACK_JUDGE);
    assert.equal(await world.amount(id, PENITENT_MANACLES), 1, 'a summoned Sin Eater blocks the reckoning');
    assert.equal((await world.character(id)).pk, 20, 'and no sin is struck off');
    session.actor.pet = null;

    // With it grown and dismissed, the reckoning runs: the collar is spent, the
    // spent pair is issued, and between one and ten sins are struck off.
    await withRoll(0.35, () => world.event(session, 422, 'repent', BLACK_JUDGE));
    assert.equal(await world.amount(id, PENITENT_MANACLES), 0, 'the collar is spent');
    assert.equal(await world.amount(id, LEFTOVER_MANACLES), 1, 'the spent pair is issued');
    assert.equal((await world.character(id)).pk, 16, 'exactly four sins were struck off');
    assert.equal(world.state(session, 422).getInt('cond'), 16, 'the reckoning can continue');
    assert.equal(world.state(session, 422).getInt('level'), 18, 'and a new level is recorded');

    // The reckoning cannot be replayed without a collar.
    await world.event(session, 422, 'repent', BLACK_JUDGE);
    assert.equal((await world.character(id)).pk, 16, 'no collar, no further reckoning');

    // The spent pair buys a fresh collar, and the count survives a restart.
    session = await world.reopen(id);
    assert.equal((await world.character(id)).pk, 16, 'the struck-off sins survived a restart');
    await world.event(session, 422, 'quit', BLACK_JUDGE);
    assert.equal(world.state(session, 422).state, 'created', 'the sentence is released');
    assert.equal(await world.amount(id, LEFTOVER_MANACLES), 1, 'the spent pair is not confiscated');

    assert.deepEqual((await world.links(session, BLACK_JUDGE, 422)).sort(), ['quit', 'reissue'],
        'the spent pair opens the renewal');
    await world.event(session, 422, 'reissue', BLACK_JUDGE);
    assert.equal(await world.amount(id, PENITENT_MANACLES), 1, 'a fresh collar is issued');
    assert.equal(await world.amount(id, LEFTOVER_MANACLES), 0, 'in exchange for the spent pair');
    assert.equal(world.state(session, 422).getInt('cond'), 16, 'straight back to the reckoning');

    // Enough sins struck off at once clears the record and ends the quest.
    const cleared = 4228;
    let clearedSession = await world.session(cleared);
    await world.event(clearedSession, 422, 'start', BLACK_JUDGE);
    await Service.giveItem(clearedSession, CRAFTED_MANACLES, 1);
    clearedSession = await world.session(cleared);
    await Database.execute(["UPDATE character_quests SET variables = json_set(variables,'$.cond','15') WHERE characterId = ? AND questId = 422", [cleared]]);
    clearedSession = await world.session(cleared);
    await world.event(clearedSession, 422, 'manacles', BLACK_JUDGE);
    await setSinEaterLevel(world, cleared, 99);
    clearedSession = await world.session(cleared);
    await withRoll(0.35, () => world.event(clearedSession, 422, 'repent', BLACK_JUDGE));
    assert.equal((await world.character(cleared)).pk, 0, 'three sins against four struck off clears the record');
    assert.equal(world.state(clearedSession, 422).state, 'created', 'and the sentence is discharged');
    assert.equal(await world.amount(cleared, LEFTOVER_MANACLES), 1, 'the spent pair is still issued');
}

async function cleanRecordRefused(world) {
    const session = await world.session(4229);
    assert.equal(await world.event(session, 422, 'start', BLACK_JUDGE), false,
        'a character with no sins cannot take the sentence');
    assert.equal(await world.questRow(4229, 422), null, 'and the refusal leaves no state');
    await world.talk(session, BLACK_JUDGE);
    assert.match(world.page(session), /nothing to judge/, 'the Black Judge says why');
    assert.deepEqual(await world.links(session, BLACK_JUDGE, 422), [], 'and offers no link');
}

main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
