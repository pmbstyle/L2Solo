// Shared fighter trials, driven through actual dialogue, quest handlers and SQLite.
const assert = require('node:assert/strict');
const shared = require('./secondProfessionHarness');
const { H, withRandom, Database, DataCache } = shared;
const Actor = invoke('GameServer/Actor/Actor');

async function reloadActor(c) {
    const row = await c.world.character(c.id), template = DataCache.classTemplates.find(t => t.classId === row.classId);
    const items = await Database.fetchItems(c.id), paperdoll = utils.tupleAlloc(16, {});
    for (const item of items) if (item.equipped) paperdoll[item.slot] = { id: item.id, selfId: item.selfId };
    c.session.actor = new Actor(c.session, { ...row, ...utils.crushOb(template), id: c.id, name: row.name, username: row.username,
        level: row.level, classId: row.classId, locX: 0, locY: 0, locZ: 0, head: 0, title: '', isActive: 1,
        items, paperdoll });
    c.session.dataSendToOthers = p => c.session.packets.push(p);
    await c.session.actor.skillset.populate(c.id);
    invoke('GameServer/Actor/Generics/CalculateStats')(c.session, c.session.actor);
}

function master(c, selfId) {
    const npc = { fetchSelfId: () => selfId, fetchId: () => 190000 + selfId, fetchName: () => H.npcName(selfId), fetchTitle: () => '',
        fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0, isDead: () => false };
    c.runtime.npc.spawns.push(npc); c.session.activeNpcTalk = { selfId, objectId: npc.fetchId() };
    return npc;
}

async function challenger(c, foreign) {
    const before = await c.world.character(c.id), diamonds = await c.amount(7562);
    assert.equal(await c.event(211, 'start', 7644), false, 'Challenger requires level 35');
    await c.level(35); await c.click(211, 'start', 7644);
    await c.kill(5110, 2); assert.equal(await c.amount(2632), 1);
    const chest = H.personalSpawns(c.state(211), 7647)[0]; assert(chest);
    if (foreign) {
        foreign.activeNpcTalk = { selfId: 7647, objectId: chest.fetchId() };
        assert.equal(await shared.Service.onEvent(foreign, { questId: 211, name: 'open' }), false);
        assert.equal(await shared.Service.onTalk(foreign, chest), false);
    }
    H.clearSpawns(c.state(211)); await c.reopen(); await c.click(211, 'recover', 7644);
    await withRandom([.9, .5], () => c.personalEvent(211, 'open', 7647));
    await c.click(211, 'letter', 7644); await c.click(211, 'martien', 7645);
    await c.kill(5112); await c.click(211, 'eye', 7645); await c.kill(5113);
    await c.personalEvent(211, 'raldo', 7646); await c.click(211, 'filaur', 7535);
    assert.equal(c.cond(211), 8, 'Filaur waits until level 36');
    await c.kill(5114); assert.equal(c.cond(211), 8);
    await c.level(36); await c.click(211, 'filaur', 7535); await c.kill(5114);
    H.clearSpawns(c.state(211)); await c.reopen(); await c.click(211, 'recover', 7535);
    await c.personalEvent(211, 'finish', 7646);
    const after = await c.world.character(c.id);
    assert.equal(after.exp - before.exp, 72394); assert.equal(after.sp - before.sp, 11250);
    assert.equal(await c.amount(7562) - diamonds, 8); assert.equal(await c.amount(2627), 1);
    assert.equal(H.personalSpawns(c.state(211)).length, 0); assert.equal(c.session.questWaypoints.size, 0);
    assert.equal(await c.event(211, 'start', 7644), false);
}

async function duelist(c, { started = false } = {}) {
    const before = await c.world.character(c.id), diamonds = await c.amount(7562);
    if (!started) {
        assert.equal(await c.event(222, 'start', 7623), false, 'Duelist requires level 39');
        await c.level(39); await c.click(222, 'start', 7623);
    }
    for (let id = 2763; id <= 2767; id++) assert.equal(await c.amount(id), 1);
    assert.equal(await c.event(222, 'handin', 7623), false);
    for (const [npc, item] of [[85, 2768], [90, 2769], [234, 2770], [202, 2771], [270, 2772],
        [552, 2773], [582, 2774], [564, 2775], [601, 2776], [602, 2777]]) {
        await c.kill(npc, 11); assert.equal(await c.amount(item), 10);
    }
    await c.click(222, 'handin', 7623); await c.reopen();
    assert.equal(c.state(222).getInt('step'), 2); assert.equal(await c.amount(2778), 1);
    for (const [npc, item] of [[214, 2779], [217, 2780], [554, 2781], [588, 2782]]) {
        await c.kill(npc, 4); assert.equal(await c.amount(item), 3);
    }
    await c.kill(604, 2); assert.equal(await c.event(222, 'handin', 7623), false);
    await c.kill(604, 2); assert.equal(await c.amount(2783), 3);
    const results = await Promise.all([c.event(222, 'handin', 7623), c.event(222, 'handin', 7623)]);
    assert.deepEqual(results, [true, false], 'concurrent completion grants one mark');
    const after = await c.world.character(c.id);
    assert.equal(after.exp - before.exp, 47015); assert.equal(after.sp - before.sp, 20000);
    assert.equal(await c.amount(2762), 1); assert.equal(await c.amount(7562), diamonds);
    await c.reopen(); assert.equal(await c.event(222, 'handin', 7623), false);
}

module.exports = { ...shared, challenger, duelist, reloadActor, master };
