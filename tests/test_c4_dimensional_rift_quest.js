// Lifecycle certification for Q635 In the Dimensional Rift.
//
// The pinned C4 handler is not an instance: no rooms, no timers, no party
// admission, no encounter lifecycle. It is a two-way passage, and what has to be
// certified is that the passage remembers where you came from and puts you back
// there - all fourteen of them, from any of the six Rift Post ranks.
//
// The movement stack itself is not under test here and has its own coverage, so
// TeleportTo is replaced by a recorder for the duration of each passage. The
// real module is resolved and asserted first, so the quest is still proven to be
// reaching for the server's own teleport rather than a private one.
const assert = require('node:assert/strict');
const path = require('node:path');
const { createWorld, Service, DataCache } = require('./helpers/c4QuestHarness');

const KEEPERS = Array.from({ length: 14 }, (_, index) => 8494 + index);
const RIFT_POST = Array.from({ length: 6 }, (_, index) => 8488 + index);
const DIMENSION_FRAGMENT = 7079;
const OUTPOST = { locX: -114790, locY: -180576, locZ: -6781 };

// Keeper index -> where the return trip must land. Taken from the reference's
// own COORD table, adapted to the existing C4 dungeon entrances.
const DESTINATIONS = [
    [-41572, 209731, -5087], [43050, 143933, -5383], [45256, 123906, -5411],
    [46192, 170290, -4981], [111273, 174015, -5437], [78042, 78404, -5128],
    [-21726, 77385, -5171], [140405, 79679, -5427], [-52366, 79097, -4741],
    [118311, 132797, -4829], [172185, -17602, -4901], [83000, 209213, -5439],
    [-19500, 13508, -4901], [113865, 84543, -6545]
];

const CHARACTERS = [
    ...KEEPERS.map((_, index) => ({ id: 6350 + index, level: 20 })),
    { id: 6349, level: 19 }, { id: 6348, level: 20 }, { id: 6347, level: 20 }
];

const TELEPORT_MODULE = path.resolve(__dirname, '../src/GameServer/Actor/Generics/TeleportTo.js');

// The quest links the last rendered page offered, whichever route reached it.
function pageLinks(session) {
    const pattern = /bypass -h quest 635 ([A-Za-z0-9_]+)/g;
    const html = session.packets.filter((packet) => packet[0] === 0x0f).at(-1)
        ?.subarray(5).toString('utf16le') || '';
    return [...new Set([...html.matchAll(pattern)].map((match) => match[1]))];
}

// Swaps the server's teleport for a recorder while a passage is driven.
async function recordingTeleports(body) {
    const entry = require.cache[require.resolve(TELEPORT_MODULE)];
    const original = entry.exports;
    const moves = [];
    entry.exports = (session, actor, coords) => {
        moves.push({ characterId: actor.fetchId(), ...coords });
        return true;
    };
    try { await body(moves); } finally { entry.exports = original; }
    return moves;
}

async function main() {
    const world = await createWorld(CHARACTERS, 'c4-rift');
    try {
        realTeleportExists();
        await everyPassage(world);
        await guards(world);
        console.log('C4 Q635: all fourteen keeper passages and their return trips, every Rift '
            + 'Post rank, the fragment toll, the level gate and the quest-slot limit passed');
    } finally {
        await world.close();
    }
}

function realTeleportExists() {
    const teleport = require(TELEPORT_MODULE);
    assert.equal(typeof teleport, 'function', "the server's own teleport resolves");

    // The passage's endpoints are datapack content, so they have to be real.
    for (const selfId of [...KEEPERS, ...RIFT_POST]) {
        assert.ok(DataCache.npcs.some((npc) => npc.selfId === selfId), `NPC ${selfId} resolves`);
    }
    assert.ok(DataCache.items.some((item) => item.selfId === DIMENSION_FRAGMENT),
        'the Fragment of Dimension resolves');
    assert.equal(DESTINATIONS.length, KEEPERS.length, 'one destination per keeper');
}

// Every keeper sends you to the same outpost and brings you back to its own door.
async function everyPassage(world) {
    for (let index = 0; index < KEEPERS.length; index++) {
        const keeper = KEEPERS[index];
        const id = 6350 + index;
        const [locX, locY, locZ] = DESTINATIONS[index];
        let session = await world.session(id);

        // A Dimension Keeper offers Q634 as well, so the client sees his quest
        // list first and this quest is reached through its start link.
        assert.deepEqual(await world.links(session, keeper, 635), ['start'],
            `keeper ${keeper} lists the passage among his errands`);

        // No fragment, no passage.
        assert.ok(await world.event(session, 635, 'start', keeper),
            `keeper ${keeper} answers about the passage`);
        assert.match(world.page(session), /Fragment of Dimension/,
            `keeper ${keeper} names the fragment he requires`);
        assert.deepEqual(await pageLinks(session), [],
            `keeper ${keeper} offers no passage without a fragment`);
        assert.equal(await world.event(session, 635, 'passage', keeper), false,
            `keeper ${keeper} refuses without a fragment`);

        await Service.giveItem(session, DIMENSION_FRAGMENT, 1);
        session = await world.session(id);
        await world.event(session, 635, 'start', keeper);
        assert.deepEqual(await pageLinks(session), ['passage'],
            `keeper ${keeper} offers the passage`);

        await recordingTeleports(async (moves) => {
            assert.ok(await world.event(session, 635, 'passage', keeper), `keeper ${keeper} opens the rift`);
            assert.equal(moves.length, 1, `keeper ${keeper} teleports exactly once`);
            assert.deepEqual(moves[0], { characterId: id, ...OUTPOST },
                `keeper ${keeper} sends you to the rift outpost`);
        });
        assert.equal(await world.amount(id, DIMENSION_FRAGMENT), 1,
            `keeper ${keeper} does not consume the fragment`);
        assert.equal(world.state(session, 635).getInt('keeper'), index,
            `keeper ${keeper} records its own index`);

        // The bearing survives a restart, which is the only durable thing the
        // passage keeps.
        session = await world.reopen(id);
        assert.equal(world.state(session, 635).getInt('keeper'), index,
            `keeper ${keeper}'s bearing survived a restart`);

        // Any Rift Post rank sends you back, and to this keeper's own door.
        const rank = RIFT_POST[index % RIFT_POST.length];
        assert.deepEqual(await world.links(session, rank, 635), ['enter'],
            `Rift Post ${rank} offers the way back`);
        assert.match(world.page(session), /You came from/, `Rift Post ${rank} knows where you came from`);
        await recordingTeleports(async (moves) => {
            assert.ok(await world.event(session, 635, 'enter', rank), `Rift Post ${rank} opens the way back`);
            assert.equal(moves.length, 1, `Rift Post ${rank} teleports exactly once`);
            assert.deepEqual(moves[0], { characterId: id, locX, locY, locZ },
                `Rift Post ${rank} returns you to keeper ${keeper}'s door`);
        });
        assert.equal(world.state(session, 635).isStarted(), false, 'the passage is closed behind you');
        assert.equal(world.state(session, 635).getInt('crossings'), 1, 'and the crossing is counted');

        // A second return trip has nothing to open.
        await recordingTeleports(async (moves) => {
            assert.equal(await world.event(session, 635, 'enter', rank), false,
                'the way back cannot be opened twice');
            assert.equal(moves.length, 0, 'and nothing moves');
        });

        // The passage can be taken again, and the crossings keep counting.
        await recordingTeleports(async () => {
            await world.event(session, 635, 'passage', keeper);
        });
        assert.equal(world.state(session, 635).getInt('crossings'), 2, 'the second crossing is counted');
    }
}

async function guards(world) {
    const young = await world.session(6349);
    await Service.giveItem(young, DIMENSION_FRAGMENT, 1);
    const stocked = await world.session(6349);
    await recordingTeleports(async (moves) => {
        assert.equal(await world.event(stocked, 635, 'passage', KEEPERS[0]), false,
            'the rift refuses level 19');
        assert.equal(moves.length, 0, 'and nothing moves');
    });
    await world.event(stocked, 635, 'start', KEEPERS[0]);
    assert.match(world.page(stocked), /level 20/, 'the keeper names the level he requires');

    // A Rift Post soldier will not send back somebody who never came through.
    const outsider = await world.session(6348);
    await recordingTeleports(async (moves) => {
        assert.equal(await world.event(outsider, 635, 'enter', RIFT_POST[0]), false,
            'the outpost refuses someone who did not arrive through the rift');
        assert.equal(moves.length, 0, 'and nothing moves');
    });
    // A rift NPC is not a start NPC, so somebody who never came through gets no
    // quest dialogue from it at all.
    outsider.packets.length = 0;
    await world.talk(outsider, RIFT_POST[0]);
    assert.equal(world.page(outsider), '', 'and the outpost has nothing to say to them');

    // Too many errands in hand and the rift will not take you. The limit is the
    // reference's own: more than twenty-three active quests.
    const busy = await world.session(6347);
    await Service.giveItem(busy, DIMENSION_FRAGMENT, 1);
    const loaded = await world.session(6347);
    const QuestState = invoke('GameServer/Quest/QuestState');
    const quests = Service.quests().filter((quest) => quest.id !== 635).slice(0, 24);
    assert.equal(quests.length, 24, 'enough quests exist to exceed the limit');
    for (const quest of quests) {
        loaded.questStates.set(quest.id, new QuestState(loaded, quest, { state: 'started', variables: '{}' }));
    }
    await recordingTeleports(async (moves) => {
        assert.equal(await world.event(loaded, 635, 'passage', KEEPERS[0]), false,
            'twenty-four active errands are too many');
        assert.equal(moves.length, 0, 'and nothing moves');
    });
    await world.event(loaded, 635, 'start', KEEPERS[0]);
    assert.match(world.page(loaded), /too many errands/, 'and the keeper says why');

    // One fewer and the passage opens.
    loaded.questStates.delete(quests[0].id);
    await recordingTeleports(async (moves) => {
        assert.ok(await world.event(loaded, 635, 'passage', KEEPERS[0]),
            'twenty-three active errands are within the limit');
        assert.equal(moves.length, 1, 'and the passage opens');
    });
}

main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
