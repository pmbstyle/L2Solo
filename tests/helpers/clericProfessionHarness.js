const assert = require('node:assert/strict');
const shared = require('./secondProfessionHarness');

async function createClericWorld(label, id, extra = []) {
    return shared.createTrialWorld(label, id, extra, { classId: 15, race: 0, level: 34 });
}

async function trust(c) {
    const before = await c.world.character(c.id);
    assert.equal(await c.event(217, 'start', 7191), false);
    await c.level(37); await c.click(217, 'start', 7191);
    await c.click(217, 'handin', 7154);
    await c.kill(36); await c.ownedKill(217, 5120);
    await c.kill(13); await c.ownedKill(217, 5121);
    for (const npc of [7154, 7358, 7464]) await c.click(217, 'handin', npc);
    await c.kill(550, 10); await c.kill(82, 10);
    await c.reopen(); await c.kill(234, 10);
    for (const npc of [7464, 7358, 7191, 7657]) await c.click(217, 'handin', npc);
    assert.equal(c.cond(217), 11, 'Seresin waits until level 38');
    await c.level(38);
    for (const npc of [7657, 7565, 7515]) await c.click(217, 'handin', npc);
    await c.kill(553, 10, .9);
    for (const npc of [7515, 7565, 7531, 7621]) await c.click(217, 'handin', npc);
    await c.kill(213, 10);
    for (const npc of [7621, 7531, 7191, 7031]) await c.click(217, 'handin', npc);
    const after = await c.world.character(c.id);
    assert.equal(after.exp - before.exp, 39571); assert.equal(after.sp - before.sp, 2500);
    assert.equal(await c.amount(2734), 1); assert.equal(await c.amount(7562), 24);
}

module.exports = { ...shared, createClericWorld, trust };
