const assert = require('node:assert/strict');
const shared = require('./clericProfessionHarness');
const { H } = shared;

async function fate(c, foreign = null) {
    const before = await c.world.character(c.id);
    await c.level(36); assert.equal(await c.event(219, 'start', 7476), false);
    await c.level(37); await c.click(219, 'start', 7476);
    await c.kill(144); assert.equal(await c.amount(3175), 0);
    assert.equal(await c.event(219, 'handin', 7358), false);
    await c.click(219, 'handin', 7614); await c.kill(144, 2); assert.equal(await c.amount(3175), 1);
    await c.click(219, 'handin', 7614); await c.click(219, 'handin', 7463);
    for (const [mob, item, chance] of [[158, 3178, .5], [233, 3179, .5], [202, 3180, .5],
        [192, 3181, .5], [193, 3181, .6], [230, 3182, .3], [157, 3182, .4], [232, 3182, .5], [234, 3182, .6]]) {
        await c.kill(mob, 1, chance); assert.equal(await c.amount(item), 0);
    }
    for (const mob of [158, 233, 202, 193]) await c.kill(mob, 12);
    await c.kill(230, 9); assert.equal(await c.event(219, 'handin', 7463), false);
    await c.reopen(); await c.kill(157, 2); assert.equal(await c.amount(3182), 10);
    for (const npc of [7463, 7614, 7476]) await c.click(219, 'handin', npc);
    const spirit = H.personalSpawns(c.state(219), 7613)[0]; assert(spirit);
    assert.deepEqual([spirit.fetchLocX(), spirit.fetchLocY(), spirit.fetchLocZ()], [78977, 149036, -3597]);
    if (foreign) {
        assert(c.world.state(foreign, 219).isStarted());
        assert.equal(await c.world.talk(foreign, 7613, spirit.fetchId()), false,
            'another participant cannot access this personal spirit');
    }
    // A restart/timeout must not strand the skull or create duplicate spirits.
    c.runtime.despawnQuestNpc(spirit); await c.reopen();
    await c.click(219, 'recover', 7476); await c.click(219, 'recover', 7476);
    assert.equal(H.personalSpawns(c.state(219), 7613).length, 1);
    const restored = H.personalSpawns(c.state(219), 7613)[0];
    await c.world.talk(c.session, 7613, restored.fetchId());
    assert(c.world.page(c.session).includes('moon still shines'));
    for (const npc of [7114, 7210, 7476]) await c.click(219, 'handin', npc);
    assert.equal(H.personalSpawns(c.state(219)).length, 0);
    assert.equal(c.session.questWaypoints?.size || 0, 0);
    assert.equal(c.cond(219), 11); assert.equal(await c.amount(3188), 1);
    await c.click(219, 'handin', 7476); assert.equal(c.cond(219), 11);
    await c.reopen(); await c.level(38);
    for (const npc of [7476, 7358, 7419]) await c.click(219, 'handin', npc);
    await c.kill(554); await c.kill(5079); assert.equal(await c.amount(3194), 0); assert.equal(await c.amount(3200), 0);
    await c.click(219, 'pixy', 12084); await c.click(219, 'treant', 12089);
    assert.equal(await c.event(219, 'pixy', 12084), false); assert.equal(await c.event(219, 'treant', 12089), false);
    assert.equal(await c.event(219, 'handin', 7419), false);
    for (const [mob, item] of [[554, 3194], [600, 3195], [270, 3196], [582, 3197]]) {
        await c.kill(mob, 11); assert.equal(await c.amount(item), 10);
    }
    await c.click(219, 'dust', 12084); await c.kill(554); assert.equal(await c.amount(3194), 0);
    await c.reopen(); await c.kill(5079, 2); assert.equal(await c.amount(3200), 1);
    await c.click(219, 'sap', 12089);
    assert.equal(await c.event(219, 'sap', 12089), false);
    await c.click(219, 'handin', 7419); await c.click(219, 'handin', 7358);
    const after = await c.world.character(c.id);
    assert.equal(after.exp - before.exp, 68183); assert.equal(after.sp - before.sp, 1750);
    assert.equal(await c.amount(3172), 1);
    for (const item of c.state(219).quest.questItems) assert.equal(await c.amount(item), 0);
    assert.equal(await c.event(219, 'handin', 7358), false); assert.deepEqual(await c.world.character(c.id), after);
}

module.exports = { ...shared, fate };
