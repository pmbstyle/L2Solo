// Lifecycle certification for Q340 Subjugation of Lizardmen.
//
// Every probability here is driven at its exact boundary with a deterministic
// roll rather than sampled. The quest's real substance is its branch structure:
// thirty cargo boxes open a genuine choice between the temple mission and a
// flat payment, and the payment itself splits into "keep hunting" and "we are
// done". All three are walked, and the money is asserted to the adena.
//
// Bifrons' chest is a transient quest spawn: it stands at the corpse, carries
// its owner and quest identity, is refused to anyone else, and is gone after a
// restart even though the quest state survives.
const assert = require('node:assert/strict');
const { createWorld, enableQuestSpawns, Service, Database } = require('./helpers/c4QuestHarness');

const ADENA = 57;
const WEISZ = 7385;
const ADONIUS = 7375;
const LEVIAN = 7037;
const CHEST = 7989;
const BIFRONS = 10146;

const CARGO = 4255;
const HOLY = 4256;
const ROSARY = 4257;
const TOTEM = 4258;

const CARGO_MOBS = [[8, 0.5], [10, 0.52], [14, 0.55]];
const SYMBOL_MOB = 24;
const LAIR = { locX: -13698, locY: 213796, locZ: -3300, head: 16384 };

const CHARACTERS = [
    { id: 3400, level: 20 },   // full main route
    { id: 3401, level: 20 },   // refuse -> keep hunting
    { id: 3402, level: 20 },   // refuse -> take payment and quit
    { id: 3403, level: 16 },   // level gate
    { id: 3404, level: 20 }    // chest ownership probe
];

const corpse = (selfId, position = LAIR) => ({
    fetchSelfId: () => selfId,
    fetchId: () => 900000 + selfId,
    fetchLocX: () => position.locX,
    fetchLocY: () => position.locY,
    fetchLocZ: () => position.locZ,
    fetchHead: () => position.head,
    isSpoil: () => false
});

// Forces Math.random through an exact sequence, then holds the last value.
async function withRolls(values, body) {
    const original = Math.random;
    const queue = [...values];
    let last = values[values.length - 1];
    Math.random = () => (queue.length ? (last = queue.shift()) : last);
    try { return await body(); } finally { Math.random = original; }
}

const withRoll = (value, body) => withRolls([value], body);

// Hands the character enough cargo to reach the hand-in without rolling for it.
async function stockCargo(world, session, amount) {
    const id = session.actor.fetchId();
    const held = await world.amount(id, CARGO);
    if (held < amount) await Service.giveItem(session, CARGO, amount - held);
}

async function main() {
    const world = await createWorld(CHARACTERS, 'c4-lizardmen');
    const runtimeWorld = enableQuestSpawns();
    try {
        await levelGate(world);
        await cargoCollection(world);
        await refuseAndKeepHunting(world);
        await refuseAndQuit(world);
        await templeRoute(world, runtimeWorld);
        console.log('C4 Q340: level gate, source-backed cargo chances, the thirty-box cap, all '
            + 'three Weisz branches, relic probabilities, the transient owned chest and the '
            + 'single 14700 adena completion passed');
    } finally {
        await world.close();
    }
}

async function levelGate(world) {
    const young = await world.session(3403);
    assert.equal(await world.event(young, 340, 'start', WEISZ), false, 'Q340 refuses level 16');
    assert.equal(await world.questRow(3403, 340), null, 'the level refusal left no state');
    await world.talk(young, WEISZ);
    assert.match(world.page(young), /level 17/, 'Weisz names the level he requires');
    assert.deepEqual(await world.links(young, WEISZ, 340), [], 'no quest link is offered below level 17');
}

// Each Felim target drops at its own authored chance, and the collection stops
// dead at thirty boxes.
async function cargoCollection(world) {
    const session = await world.session(3400);
    assert.deepEqual(await world.links(session, WEISZ, 340), ['start'], 'Weisz offers the subjugation');
    assert.ok(await world.event(session, 340, 'start', WEISZ), 'a level 20 adventurer may start');
    assert.equal(world.state(session, 340).getInt('cond'), 1, 'the subjugation begins at cond 1');

    for (const [mob, chance] of CARGO_MOBS) {
        const before = await world.amount(3400, CARGO);
        await withRoll(chance - 0.01, () => Service.onKill(session, corpse(mob)));
        assert.equal(await world.amount(3400, CARGO), before + 1,
            `mob ${mob} drops cargo just below its ${chance} chance`);
        await withRoll(chance, () => Service.onKill(session, corpse(mob)));
        assert.equal(await world.amount(3400, CARGO), before + 1,
            `mob ${mob} drops nothing at exactly its ${chance} chance`);
        await withRoll(0.999, () => Service.onKill(session, corpse(mob)));
        assert.equal(await world.amount(3400, CARGO), before + 1,
            `mob ${mob} drops nothing on a high roll`);
    }

    // A Langk target yields nothing while the cargo hunt is still running.
    const carried = await world.amount(3400, CARGO);
    await withRolls([0, 0], () => Service.onKill(session, corpse(SYMBOL_MOB)));
    assert.equal(await world.amount(3400, HOLY), 0, 'no relic drops before Adonius asks for one');
    assert.equal(await world.amount(3400, CARGO), carried, 'a Langk target yields no cargo');

    await stockCargo(world, session, 29);
    const almost = await world.session(3400);
    assert.match(world.page(await talked(world, almost)), /29\/30/, 'Weisz counts the boxes');

    await withRoll(0, () => Service.onKill(almost, corpse(CARGO_MOBS[0][0])));
    assert.equal(await world.amount(3400, CARGO), 30, 'the thirtieth box lands');
    await withRoll(0, () => Service.onKill(almost, corpse(CARGO_MOBS[0][0])));
    assert.equal(await world.amount(3400, CARGO), 30, 'collection stops at thirty boxes');

    assert.deepEqual((await world.links(almost, WEISZ, 340)).sort(), ['refuse', 'temple'],
        'thirty boxes open the real choice');
}

async function talked(world, session) {
    session.packets.length = 0;
    await world.talk(session, WEISZ);
    return session;
}

// Refusing the temple mission pays 4090 adena and leaves the cargo hunt running.
async function refuseAndKeepHunting(world) {
    const session = await world.session(3401);
    await world.event(session, 340, 'start', WEISZ);
    await stockCargo(world, session, 30);
    const stocked = await world.session(3401);

    // The refusal page is pure dialogue, exactly as in the reference: it changes
    // no state and simply offers the two paid outcomes.
    const before = await world.questRow(3401, 340);
    await world.event(stocked, 340, 'refuse', WEISZ);
    assert.deepEqual(await world.questRow(3401, 340), before, 'refusing changes no state by itself');
    assert.equal(await world.amount(3401, CARGO), 30, 'refusing consumes no cargo by itself');
    assert.deepEqual((await pageLinks(world, stocked, 340)).sort(), ['paid_continue', 'paid_quit'],
        'refusing offers both paid outcomes');

    assert.ok(await world.event(stocked, 340, 'paid_continue', WEISZ), 'Weisz pays for the cargo');
    assert.equal(await world.amount(3401, ADENA), 4090, 'the refusal pays exactly 4090 adena');
    assert.equal(await world.amount(3401, CARGO), 0, 'every box is handed over');
    assert.equal(world.state(stocked, 340).getInt('cond'), 1, 'the cargo hunt continues');
    assert.equal(world.state(stocked, 340).state, 'started', 'the quest is still running');

    // And the hunt really does continue.
    await withRoll(0, () => Service.onKill(stocked, corpse(CARGO_MOBS[0][0])));
    assert.equal(await world.amount(3401, CARGO), 1, 'boxes can be collected again');
}

async function pageLinks(world, session, questId) {
    const pattern = new RegExp(`bypass -h quest ${questId} ([A-Za-z0-9_]+)`, 'g');
    return [...new Set([...world.page(session).matchAll(pattern)].map((match) => match[1]))];
}

// Taking the payment and walking away releases the quest without completing it.
async function refuseAndQuit(world) {
    const session = await world.session(3402);
    await world.event(session, 340, 'start', WEISZ);
    await stockCargo(world, session, 30);
    const stocked = await world.session(3402);

    await world.event(stocked, 340, 'refuse', WEISZ);
    assert.ok(await world.event(stocked, 340, 'paid_quit', WEISZ), 'Weisz settles up');
    assert.equal(await world.amount(3402, ADENA), 4090, 'quitting pays exactly 4090 adena');
    assert.equal(await world.amount(3402, CARGO), 0, 'every box is handed over');

    const row = await world.questRow(3402, 340);
    assert.equal(row.state, 'created', 'quitting releases the quest instead of completing it');

    // The release survives a restart, and the subjugation can be taken again.
    const reopened = await world.reopen(3402);
    assert.equal(world.state(reopened, 340).isStarted(), false, 'the release survived a restart');
    assert.ok(await world.event(reopened, 340, 'start', WEISZ), 'the subjugation can be taken again');
    assert.equal(await world.amount(3402, ADENA), 4090, 'restarting pays nothing extra');
}

// The temple mission: relics, Levian, Bifrons, the chest and the single reward.
async function templeRoute(world, runtimeWorld) {
    let session = await world.session(3400);
    assert.ok(await world.event(session, 340, 'temple', WEISZ), 'Weisz accepts the temple mission');
    assert.equal(await world.amount(3400, CARGO), 0, 'the cargo is consumed by the temple branch');
    assert.equal(world.state(session, 340).getInt('cond'), 2, 'the temple mission begins at cond 2');
    assert.equal(await world.amount(3400, ADENA), 0, 'the temple branch pays nothing up front');

    assert.deepEqual(await world.links(session, ADONIUS, 340), ['adonius'], 'Adonius has work');
    assert.ok(await world.event(session, 340, 'adonius', ADONIUS), 'Adonius sends you after the relics');
    assert.equal(world.state(session, 340).getInt('cond'), 3, 'the relic hunt is cond 3');

    // The relic roll is exclusive at a tenth, and the rosary rides on a second
    // roll of its own.
    await withRolls([0.1], () => Service.onKill(session, corpse(SYMBOL_MOB)));
    assert.equal(await world.amount(3400, HOLY), 0, 'a roll of exactly 0.1 yields no relic');

    await withRolls([0.09, 0.1], () => Service.onKill(session, corpse(SYMBOL_MOB)));
    assert.equal(await world.amount(3400, HOLY), 1, 'the holy symbol drops below 0.1');
    assert.equal(await world.amount(3400, ROSARY), 0, 'the rosary needs its own roll below 0.1');

    // Holding the symbol alone must not strand the hunt: the rosary is still
    // reachable, and the symbol is never duplicated.
    await withRolls([0.09, 0.09], () => Service.onKill(session, corpse(SYMBOL_MOB)));
    assert.equal(await world.amount(3400, ROSARY), 1, 'the rosary is still reachable on a later kill');
    assert.equal(await world.amount(3400, HOLY), 1, 'the holy symbol is never duplicated');

    // With both relics held the target yields nothing more.
    await withRolls([0, 0], () => Service.onKill(session, corpse(SYMBOL_MOB)));
    assert.equal(await world.amount(3400, HOLY), 1, 'no further symbol drops');
    assert.equal(await world.amount(3400, ROSARY), 1, 'no further rosary drops');

    await world.talk(session, ADONIUS);
    assert.equal(await world.amount(3400, HOLY), 0, 'Adonius takes the holy symbol');
    assert.equal(await world.amount(3400, ROSARY), 0, 'Adonius takes the rosary');
    assert.equal(world.state(session, 340).getInt('cond'), 4, 'the relics advance to cond 4');

    // Stage boundaries survive a restart.
    session = await world.reopen(3400);
    assert.equal(world.state(session, 340).getInt('cond'), 4, 'cond 4 survived a restart');

    assert.deepEqual(await world.links(session, LEVIAN, 340), ['levian'], 'Levian has work');
    assert.ok(await world.event(session, 340, 'levian', LEVIAN), 'Levian sends you after Bifrons');
    assert.equal(world.state(session, 340).getInt('cond'), 5, 'the hunt for Bifrons is cond 5');

    // The chest is spawned by the kill, at the corpse, for thirty seconds.
    const requests = [];
    const spawn = runtimeWorld.spawnQuestNpc.bind(runtimeWorld);
    runtimeWorld.spawnQuestNpc = (options) => { requests.push(options); return spawn(options); };
    try {
        await Service.onKill(session, corpse(BIFRONS));
    } finally {
        runtimeWorld.spawnQuestNpc = spawn;
    }
    assert.equal(requests.length, 1, 'killing Bifrons spawns exactly one chest');
    assert.equal(requests[0].selfId, CHEST, 'the spawn is the Chest of Bifrons');
    assert.equal(requests[0].despawnDelay, 30000, 'the chest lasts exactly thirty seconds');
    assert.equal(requests[0].ownerId, 3400, 'the chest belongs to the character who felled Bifrons');
    assert.equal(requests[0].questId, 340, 'the chest carries its quest identity');

    const chests = runtimeWorld.npc.spawns.filter((npc) => Number(npc.fetchSelfId()) === CHEST);
    assert.equal(chests.length, 1, 'exactly one chest stands in the world');
    assert.equal(chests[0].fetchLocX(), LAIR.locX, 'the chest stands where Bifrons fell (X)');
    assert.equal(chests[0].fetchLocY(), LAIR.locY, 'the chest stands where Bifrons fell (Y)');
    assert.equal(chests[0].fetchLocZ(), LAIR.locZ, 'the chest stands where Bifrons fell (Z)');

    // Nobody else's quest can open it.
    const stranger = await world.session(3404);
    await world.event(stranger, 340, 'start', WEISZ);
    await world.talk(stranger, CHEST, chests[0].fetchId());
    assert.match(world.page(stranger), /does not open for you/, "a stranger cannot open another's chest");
    assert.equal(await world.event(stranger, 340, 'chest', CHEST), false,
        'a stranger cannot claim the totem by bypass either');
    assert.equal(await world.amount(3404, TOTEM), 0, 'the stranger gained nothing');

    assert.deepEqual(await world.links(session, CHEST, 340), ['chest'], 'the owner may search the chest');
    assert.ok(await world.event(session, 340, 'chest', CHEST), 'the chest yields the totem');
    assert.equal(await world.amount(3400, TOTEM), 1, 'the totem is recovered');
    assert.equal(world.state(session, 340).getInt('cond'), 6, 'the totem advances to cond 6');

    // A restart keeps the quest but not the transient chest.
    runtimeWorld.despawnQuestNpc(chests[0]);
    session = await world.reopen(3400);
    assert.equal(world.state(session, 340).getInt('cond'), 6, 'cond 6 survived a restart');
    assert.equal(runtimeWorld.npc.spawns.filter((npc) => Number(npc.fetchSelfId()) === CHEST).length, 0,
        'the chest is not restored across a restart');

    await world.talk(session, LEVIAN);
    assert.equal(await world.amount(3400, TOTEM), 0, 'Levian destroys the totem');
    assert.equal(world.state(session, 340).getInt('cond'), 7, 'the report is cond 7');

    await world.talk(session, WEISZ);
    assert.equal(await world.amount(3400, ADENA), 14700, 'Weisz pays exactly 14700 adena');
    assert.equal(world.state(session, 340).state, 'completed', 'the subjugation is completed');

    // A completed subjugation pays once and cannot be retaken.
    await world.talk(session, WEISZ);
    assert.equal(await world.amount(3400, ADENA), 14700, 'talking again pays nothing more');
    assert.equal(await world.event(session, 340, 'start', WEISZ), false, 'a completed quest cannot restart');
    assert.deepEqual(await world.links(session, WEISZ, 340), [], 'no link is offered after completion');

    const reopened = await world.reopen(3400);
    assert.equal(world.state(reopened, 340).state, 'completed', 'completion survived a restart');
    assert.equal(await world.amount(3400, ADENA), 14700, 'the reward is not paid twice after a restart');
}

main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
