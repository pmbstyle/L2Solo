const assert = require('node:assert/strict');
const { H, Service } = require('./secondProfessionHarness');
async function searcher(c, foreign = null) {
    await c.level(38); assert.equal(await c.event(225, 'start', 7690), false);
    await c.level(39); await c.click(225, 'start', 7690);
    for (const npc of [7291, 7728]) await c.click(225, 'handin', npc);
    await c.kill(781); const assassin = H.personalSpawns(c.state(225), 5094)[0]; assert(assassin);
    if (foreign) { await Service.onKill(foreign, assassin); assert.equal(await c.world.amount(foreign.actor.fetchId(), 2787), 0); }
    await c.ownedKill(225, 5094); await c.kill(781, 9); assert.equal(await c.amount(2787), 10);
    assert.equal(H.personalSpawns(c.state(225), 5094).length, 0);
    await c.click(225, 'handin', 7728); await c.kill(5093);
    for (const npc of [7728, 7291, 7729, 7420]) await c.click(225, 'handin', npc);
    await c.kill(555, 11); assert.equal(await c.amount(2797), 10);
    for (const npc of [7420, 7729, 7730]) await c.click(225, 'handin', npc);
    await c.kill(551, 1, .5); assert.equal(await c.amount(2801), 0);
    await c.kill(144, 4); await c.reopen(); await c.kill(551, 4);
    assert.equal(await c.amount(2801), 0); assert.equal(await c.amount(2802), 0);
    await c.click(225, 'handin', 7730); await c.click(225, 'handin', 7627);
    const chest = H.personalSpawns(c.state(225), 7628)[0]; assert(chest);
    if (foreign) { foreign.activeNpcTalk = { selfId: 7628, objectId: chest.fetchId() };
    assert.equal(await Service.onEvent(foreign, { questId: 225, name: 'handin' }), false); }
    c.runtime.despawnQuestNpc(chest); await c.reopen(); await c.click(225, 'recover', 7627);
    await c.personalEvent(225, 'handin', 7628); assert.equal(await c.amount(2807), 20);
    for (const npc of [7291, 7690]) await c.click(225, 'handin', npc);
    assert.equal(H.personalSpawns(c.state(225)).length, 0); assert.equal(c.session.questWaypoints.size, 0);
    assert.equal(await c.event(225, 'handin', 7690), false);
}

module.exports = { searcher };
