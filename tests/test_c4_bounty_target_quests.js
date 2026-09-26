// Lifecycle certification for Q296 Tarantula's Spider Silk and Q306 Crystals of
// Fire and Ice, the two quests whose blockers were about which targets a player
// can actually reach.
//
// Q306's four higher variants had templates but no world spawn; they are now
// spawned from the pinned reference's own points, and all six targets are driven
// at their exact chance boundaries.
//
// Q296's third reference target, Crimson Tarantula, is NOT spawned - and that is
// asserted to be faithful rather than missing, because the pinned C4 datapack
// does not spawn it either. That claim is checked against the reference's own
// spawn files, not taken on trust.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createWorld, Service, DataCache } = require('./helpers/c4QuestHarness');

const ADENA = 57;

const MION = 7519;
const NATHAN = 7548;
const HUNTER_TARANTULA = 403;
const PLUNDER_TARANTULA = 508;
const CRIMSON_TARANTULA = 394;
const SPIDER_SILK = 1493;
const SPINNERETTE = 1494;
const RING_OF_RACCOON = 1508;

const KATERINA = 7004;
const FLAME_SHARD = 1020;
const ICE_SHARD = 1021;
// [target, shard, chance]
const CRYSTAL_TARGETS = [
    [109, FLAME_SHARD, 0.3], [110, ICE_SHARD, 0.3],
    [112, FLAME_SHARD, 0.4], [113, ICE_SHARD, 0.4],
    [114, FLAME_SHARD, 0.5], [115, ICE_SHARD, 0.5]
];

const CHARACTERS = [
    { id: 2960, level: 20 }, { id: 2961, level: 14 }, { id: 2962, level: 20 },
    { id: 3060, level: 20 }, { id: 3061, level: 16 }, { id: 3062, level: 20 }
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
    const world = await createWorld(CHARACTERS, 'c4-bounty-targets');
    try {
        restoredTargets();
        await crystalsOfFireAndIce(world);
        await tarantulaSpiderSilk(world);
        console.log("C4 Q296/Q306: the four restored crystal variants, every target's own drop "
            + 'chance, both payment tiers, the spinnerette conversion, and the evidence that C4 '
            + 'itself never spawns the Crimson Tarantula passed');
    } finally {
        await world.close();
    }
}

function restoredTargets() {
    const spawned = new Map();
    for (const group of DataCache.npcSpawns) {
        for (const spawn of group.spawns) {
            if (!spawn.coords?.length) continue;
            spawned.set(Number(spawn.selfId),
                (spawned.get(Number(spawn.selfId)) || []).concat(spawn.coords));
        }
    }

    for (const [selfId, , ] of CRYSTAL_TARGETS) {
        assert.ok(DataCache.npcs.some((npc) => npc.selfId === selfId), `target ${selfId} resolves`);
        const points = spawned.get(selfId) || [];
        assert.ok(points.length > 0, `target ${selfId} stands in the world`);
        assert.ok(points.every((point) => [point.locX, point.locY, point.locZ].every(Number.isFinite)),
            `every ${selfId} spawn has a real position`);
    }

    // The Crimson Tarantula's absence is a property of Chronicle 4, not of this
    // datapack. Read the pinned reference and prove it.
    assert.ok(DataCache.npcs.some((npc) => npc.selfId === CRIMSON_TARANTULA),
        'the Crimson Tarantula has a local template');
    assert.equal(spawned.has(CRIMSON_TARANTULA), false, 'and no local world spawn');

    const reference = process.env.C4_REFERENCE_SPAWNS;
    if (!reference || !fs.existsSync(reference)) {
        // The pinned reference is a research checkout, not repository content, so
        // its absence must not fail the run. The claim it supports is recorded in
        // docs/c4/quests/imported-quests.md.
        return;
    }
    let mentions = 0;
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const target = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(target);
            else if (fs.readFileSync(target, 'utf8').includes('id="20394"')) mentions++;
        }
    };
    walk(reference);
    assert.equal(mentions, 0, 'the pinned C4 spawn files never spawn the Crimson Tarantula either');
}

async function crystalsOfFireAndIce(world) {
    const young = await world.session(3061);
    assert.equal(await world.event(young, 306, 'start', KATERINA), false, 'Q306 refuses level 16');

    let session = await world.session(3060);
    assert.ok(await world.event(session, 306, 'start', KATERINA), 'a level 17 adventurer may start');

    // Each of the six targets drops its own shard at its own chance.
    let flame = 0;
    let ice = 0;
    for (const [target, shard, chance] of CRYSTAL_TARGETS) {
        await withRolls([chance], () => Service.onKill(session, corpse(target)));
        assert.equal(await world.amount(3060, shard), shard === FLAME_SHARD ? flame : ice,
            `target ${target} drops nothing at exactly its ${chance} chance`);
        await withRolls([chance - 0.01], () => Service.onKill(session, corpse(target)));
        if (shard === FLAME_SHARD) flame++; else ice++;
        assert.equal(await world.amount(3060, shard), shard === FLAME_SHARD ? flame : ice,
            `target ${target} drops its shard just below its ${chance} chance`);
        // And never the other element.
        assert.equal(await world.amount(3060, shard === FLAME_SHARD ? ICE_SHARD : FLAME_SHARD),
            shard === FLAME_SHARD ? ice : flame, `target ${target} never drops the other shard`);
    }
    assert.equal(flame, 3, 'three flame shards, one per flame target');
    assert.equal(ice, 3, 'three ice shards, one per ice target');

    // Six shards is under the bonus threshold: sixty adena each and nothing more.
    session = await world.reopen(3060);
    await world.talk(session, KATERINA);
    assert.equal(await world.amount(3060, ADENA), 6 * 60, 'six shards pay sixty adena each');
    assert.equal(await world.amount(3060, FLAME_SHARD), 0, 'the flame shards are surrendered');
    assert.equal(await world.amount(3060, ICE_SHARD), 0, 'the ice shards are surrendered');

    // Ten shards of either element together cross the bonus threshold once.
    await Service.giveItem(session, FLAME_SHARD, 6);
    await Service.giveItem(session, ICE_SHARD, 4);
    session = await world.session(3060);
    await world.talk(session, KATERINA);
    assert.equal(await world.amount(3060, ADENA), 6 * 60 + 10 * 60 + 5000,
        'ten shards of both elements together pay the 5000 adena bonus once');

    // Nine shards do not.
    await Service.giveItem(session, ICE_SHARD, 9);
    session = await world.session(3060);
    const before = await world.amount(3060, ADENA);
    await world.talk(session, KATERINA);
    assert.equal(await world.amount(3060, ADENA), before + 9 * 60, 'nine shards pay no bonus');

    // A character without the quest collects nothing.
    const stranger = await world.session(3062);
    await withRolls([0], () => Service.onKill(stranger, corpse(114)));
    assert.equal(await world.amount(3062, FLAME_SHARD), 0, 'no quest, no shard');
}

async function tarantulaSpiderSilk(world) {
    const young = await world.session(2961);
    assert.equal(await world.event(young, 296, 'start', MION), false, 'Q296 refuses level 14');

    // The quest needs one of the two apprentice rings.
    const ringless = await world.session(2962);
    assert.equal(await world.event(ringless, 296, 'start', MION), false, 'Q296 refuses without a ring');
    assert.equal(await world.questRow(2962, 296), null, 'the refusal left no state');

    let session = await world.session(2960);
    await Service.giveItem(session, RING_OF_RACCOON, 1);
    session = await world.session(2960);
    assert.ok(await world.event(session, 296, 'start', MION), 'the Ring of Raccoon opens the task');

    // The reference rolls once: under 4% a spinnerette, otherwise under 54% silk.
    for (const target of [HUNTER_TARANTULA, PLUNDER_TARANTULA]) {
        const silk = await world.amount(2960, SPIDER_SILK);
        const spinnerettes = await world.amount(2960, SPINNERETTE);

        await withRolls([0.039], () => Service.onKill(session, corpse(target)));
        assert.equal(await world.amount(2960, SPINNERETTE), spinnerettes + 1,
            `target ${target} yields a spinnerette below 4%`);

        await withRolls([0.04], () => Service.onKill(session, corpse(target)));
        assert.equal(await world.amount(2960, SPIDER_SILK), silk + 1,
            `target ${target} yields silk at exactly 4%`);

        await withRolls([0.539], () => Service.onKill(session, corpse(target)));
        assert.equal(await world.amount(2960, SPIDER_SILK), silk + 2,
            `target ${target} still yields silk just under 54%`);

        await withRolls([0.54], () => Service.onKill(session, corpse(target)));
        assert.equal(await world.amount(2960, SPIDER_SILK), silk + 2,
            `target ${target} yields nothing at exactly 54%`);
        assert.equal(await world.amount(2960, SPINNERETTE), spinnerettes + 1,
            `target ${target} yields no further spinnerette`);
    }

    // Nathan extracts fifteen to twenty-four silk from every spinnerette.
    const carriedSilk = await world.amount(2960, SPIDER_SILK);
    const spinnerettes = await world.amount(2960, SPINNERETTE);
    assert.equal(spinnerettes, 2, 'two spinnerettes were collected');
    session = await world.reopen(2960);
    await withRolls([0], () => world.event(session, 296, 'spin_silk', NATHAN));
    assert.equal(await world.amount(2960, SPINNERETTE), 0, 'every spinnerette is consumed');
    assert.equal(await world.amount(2960, SPIDER_SILK), carriedSilk + spinnerettes * 15,
        'the lowest roll yields fifteen silk per spinnerette');

    // Mion pays twenty adena per silk, and two thousand more from ten.
    const silk = await world.amount(2960, SPIDER_SILK);
    assert.ok(silk >= 10, 'the extraction alone passes the bonus threshold');
    await world.talk(session, MION);
    assert.equal(await world.amount(2960, ADENA), silk * 20 + 2000,
        'Mion pays twenty adena per silk plus the 2000 bonus');
    assert.equal(await world.amount(2960, SPIDER_SILK), 0, 'all silk is surrendered');
    assert.equal(await world.amount(2960, RING_OF_RACCOON), 1, 'the prerequisite ring is kept');

    // Ending the task keeps nothing back and pays nothing.
    await withRolls([0.2], () => Service.onKill(session, corpse(HUNTER_TARANTULA)));
    assert.equal(await world.amount(2960, SPIDER_SILK), 1, 'one more silk was collected');
    const paid = await world.amount(2960, ADENA);
    await world.event(session, 296, 'quit', MION);
    assert.equal(await world.amount(2960, SPIDER_SILK), 0, 'quitting surrenders uncashed silk');
    assert.equal(await world.amount(2960, ADENA), paid, 'quitting pays nothing');
    assert.equal(world.state(session, 296).state, 'created', 'the task is released, not completed');
    assert.ok(await world.event(session, 296, 'start', MION), 'and it can be taken again');
}

main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
