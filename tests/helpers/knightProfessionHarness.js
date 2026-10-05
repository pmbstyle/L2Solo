const assert = require('node:assert/strict');
const shared = require('./fighterProfessionHarness');
const { trust, healer } = require('./clericProfessionHarness');
const { H, Service, withRandom, reloadActor } = shared;

async function equipSword(c) {
    await reloadActor(c);
    const sword = c.session.actor.backpack.fetchItems().find(i => i.fetchSelfId() === 3027);
    assert(sword);
    c.session.actor.backpack.equipGear(c.session, sword);
    await c.session.actor.backpack.updateDatabaseTimer(c.id, [sword]);
    await c.reopen(); await reloadActor(c);
    assert.equal(c.session.actor.backpack.fetchEquippedWeapon().fetchSelfId(), 3027);
}

async function duty(c, foreign = null, { stopAtSword = false, stopAtSpirit = false, beforeArticles = null } = {}) {
    assert.equal(await c.event(212, 'start', 7109), false, 'Duty starts at level 35');
    await c.level(35); assert.equal(await c.event(212, 'start', 7653), false);
    await c.click(212, 'start', 7109); await c.click(212, 'handin', 7653);
    assert.equal(await c.amount(3027), 1); assert.equal(await c.event(212, 'handin', 7653), false);
    assert.equal(await c.event(212, 'recover', 7653), false, 'no spirit before the first successful summon');
    await c.kill(190, 1, .04); assert.equal(H.personalSpawns(c.state(212), 5119).length, 0);
    await withRandom([.039], () => Service.onKill(c.session, { fetchSelfId: () => 191, fetchId: () => 900001,
        fetchLocX: () => -15000, fetchLocY: () => 180000, fetchLocZ: () => -3500 }));
    await c.kill(190, 2);
    assert.equal(H.personalSpawns(c.state(212), 5119).length, 1);
    assert.deepEqual(JSON.parse(c.state(212).get('encounter')), [-15000, 180000, -3500]);
    await c.kill(5119); assert.equal(await c.amount(2635), 0, 'fabricated Herod cannot grant a tear');
    const spirit = H.personalSpawns(c.state(212), 5119)[0];
    if (foreign) {
        await reloadActor({ world: c.world, id: foreign.actor.fetchId(), session: foreign });
        const sword = foreign.actor.backpack.fetchItems().find(i => i.fetchSelfId() === 3027);
        foreign.actor.backpack.equipGear(foreign, sword);
        await foreign.actor.backpack.updateDatabaseTimer(foreign.actor.fetchId(), [sword]);
        assert.equal(foreign.actor.backpack.fetchEquippedWeapon().fetchSelfId(), 3027);
        await Service.onKill(foreign, spirit);
        assert.equal(await c.world.amount(foreign.actor.fetchId(), 2635), 0, 'another equipped Knight cannot claim this spirit');
    }
    await c.ownedKill(212, 5119); assert.equal(c.cond(212), 2, 'carrying the sword does not satisfy wielding it');
    H.clearSpawns(c.state(212)); await c.reopen(); await c.click(212, 'recover', 7653); await c.click(212, 'recover', 7653);
    assert.equal(H.personalSpawns(c.state(212), 5119).length, 1);
    const recovered = H.personalSpawns(c.state(212), 5119)[0];
    assert.deepEqual([recovered.fetchLocX(), recovered.fetchLocY(), recovered.fetchLocZ()], [-15000, 180000, -3500]);
    await equipSword(c);
    // The SQL allowlist rejects this worn sword for another quest, even if its handler asks for it.
    await c.world.talk(c.session, 7644);
    await assert.rejects(invoke('GameServer/Quest/QuestStep').apply(c.state(211), { takes: [[3027, 1]] }), /Required quest items missing/);
    assert.equal(await c.amount(3027), 1);
    if (stopAtSword) return;
    const swordAttack = c.session.actor.fetchCollectivePAtk();
    await c.kill(5119); assert.equal(await c.amount(2635), 0, 'even the right sword cannot turn a fabricated Herod into this encounter');
    await c.ownedKill(212, 5119); assert.equal(await c.amount(2635), 1);
    await c.kill(5119); assert.equal(await c.amount(2635), 1);
    await c.click(212, 'handin', 7653);
    assert.equal(await c.amount(3027), 0); assert.equal(c.session.actor.backpack.fetchEquippedWeapon(), undefined);
    assert.deepEqual(c.session.actor.backpack.paperdoll[14], {});
    assert(c.session.actor.fetchCollectivePAtk() < swordAttack);
    assert(c.session.packets.some(p => p[0] === 0x04), 'retiring the worn sword refreshes user info');
    await c.click(212, 'handin', 7654);
    await c.kill(200, 1, .499); assert.equal(await c.amount(2638), 0);
    await c.kill(200, 9, .5); assert.equal(await c.amount(2638), 9);
    assert.equal(await c.event(212, 'handin', 7654), false);
    await c.reopen(); await c.kill(201, 2, .5);
    assert.equal(await c.amount(2638), 0); assert.equal(await c.amount(2639), 1);
    await c.kill(144); assert.equal(H.personalSpawns(c.state(212), 7656).length, 0, 'mirror must be obtained first');
    await c.click(212, 'handin', 7654);
    assert.equal(await c.amount(2639), 1, 'Kiel keeps the report for Talianus to read');
    await c.kill(144, 1, .33); assert.equal(c.cond(212), 7);
    await c.kill(144, 2, .329); assert.equal(c.cond(212), 8);
    assert.equal(H.personalSpawns(c.state(212), 7656).length, 1);
    const talianus = H.personalSpawns(c.state(212), 7656)[0];
    if (foreign) {
        assert.equal(await c.world.talk(foreign, 7656, talianus.fetchId()), false);
        foreign.activeNpcTalk = { selfId: 7656, objectId: talianus.fetchId() };
        assert.equal(await Service.onEvent(foreign, { questId: 212, name: 'handin' }), false);
    }
    assert.equal(await c.event(212, 'handin', 7656), false, 'template-only spirit dialogue cannot complete a personal hand-in');
    H.clearSpawns(c.state(212)); await c.reopen();
    assert.equal(await c.event(212, 'recover', 7653), false);
    await c.click(212, 'recover', 7654); await c.click(212, 'recover', 7654);
    assert.equal(H.personalSpawns(c.state(212), 7656).length, 1);
    if (stopAtSpirit) return;
    await c.personalEvent(212, 'handin', 7656);
    assert.equal(await c.amount(2636), 0); assert.equal(await c.amount(2639), 0); assert.equal(await c.amount(2637), 1);
    assert.equal(H.personalSpawns(c.state(212)).length, 0); assert.equal(c.session.questWaypoints.size, 0);
    await c.click(212, 'handin', 7654); await c.click(212, 'handin', 7655);
    assert.equal(c.cond(212), 10, 'Isael waits for level 36');
    await c.kill(577); assert.equal(await c.amount(2641), 0);
    await c.level(36); await c.click(212, 'handin', 7655);
    if (beforeArticles) await beforeArticles();
    const articles = await c.amount(2641);
    for (const mob of [577, 578, 579, 580, 581, 582]) await c.kill(mob, 3);
    const collected = Math.min(20, articles + 18);
    assert.equal(await c.amount(2641), collected);
    if (collected < 20) assert.equal(await c.event(212, 'handin', 7655), false);
    await c.reopen(); await c.kill(582, 3); assert.equal(await c.amount(2641), 20);
    await c.click(212, 'handin', 7655);
    await c.kill(270, 3, .5); assert.equal(await c.amount(2643), 0, 'Dustin must explain the bones first');
    await c.click(212, 'handin', 7116);
    await c.kill(270, 1, .499); assert.equal(await c.amount(2643), 0);
    await c.kill(270, 2, .5); assert.equal(await c.amount(2643), 1); assert.equal(await c.amount(2644), 1);
    assert.equal(await c.event(212, 'handin', 7116), false);
    await c.reopen(); await c.kill(270, 3, .5); assert.equal(await c.amount(2645), 1);
    for (const npc of [7116, 7311, 7116]) await c.click(212, 'handin', npc);
    // Measure Duty's final award separately from overlapping trials completed by the hook.
    const before = await c.world.character(c.id), diamonds = await c.amount(7562);
    await c.world.talk(c.session, 7109);
    const results = await Promise.all([c.event(212, 'handin', 7109), c.event(212, 'handin', 7109)]);
    assert.deepEqual(results, [true, false]);
    const after = await c.world.character(c.id);
    assert.equal(after.exp - before.exp, 79832); assert.equal(after.sp - before.sp, 3750);
    assert.equal(await c.amount(2633), 1); assert.equal(await c.amount(7562) - diamonds, 8);
    for (const item of c.state(212).quest.questItems) assert.equal(await c.amount(item), 0);
    await c.reopen(); assert.equal(await c.event(212, 'handin', 7109), false);
}

module.exports = { ...shared, trust, healer, duty, equipSword };
