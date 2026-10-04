const assert = require('node:assert/strict');
const shared = require('./clericProfessionHarness');
const { Database, DataCache, H, Service } = shared;
const Actor = invoke('GameServer/Actor/Actor');

async function realActor(c) {
    const row = await c.world.character(c.id), template = DataCache.classTemplates.find(t => t.classId === row.classId);
    const items = await Database.fetchItems(c.id), paperdoll = utils.tupleAlloc(16, {});
    for (const item of items) if (item.equipped) paperdoll[item.slot] = { id: item.id, selfId: item.selfId };
    c.session.actor = new Actor(c.session, { ...row, ...utils.crushOb(template), id: c.id, name: row.name, username: row.username,
        level: row.level, classId: row.classId, locX: 0, locY: 0, locZ: 0, head: 0, title: '', isActive: 1, items, paperdoll });
    c.session.dataSendToOthers = p => c.session.packets.push(p);
    invoke('GameServer/Actor/Generics/CalculateStats')(c.session, c.session.actor);
}

async function equipSpear(c) {
    await realActor(c);
    const item = c.session.actor.backpack.fetchItems().find(i => i.fetchSelfId() === 3026);
    assert(item);
    c.session.actor.backpack.equipGear(c.session, item);
    await c.session.actor.backpack.updateDatabaseTimer(c.id, [item]);
    await c.reopen();
    await realActor(c);
    assert.equal(c.session.actor.backpack.fetchEquippedWeapon().fetchSelfId(), 3026);
}

async function life(c, { equipped = true, stopAtSpear = false, waitAt37 = true, beforeSpearParts = null } = {}) {
    const before = await c.world.character(c.id);
    await c.level(36); assert.equal(await c.event(218, 'start', 7460), false);
    await c.level(37); await c.click(218, 'start', 7460);
    assert.equal(await c.event(218, 'handin', 7300), false);
    for (const npc of [7154, 7371, 7300]) await c.click(218, 'handin', npc);
    for (const [mob, roll, item] of [[550, .5, 3161], [176, .5, 3163], [82, .8, 3162], [87, .5, 3162]]) {
        await c.kill(mob, 1, roll); assert.equal(await c.amount(item), 0);
    }
    await c.kill(550, 12); assert.equal(await c.amount(3161), 10);
    await c.kill(176, 22); assert.equal(await c.amount(3163), 20);
    await c.kill(82, 19); assert.equal(await c.event(218, 'handin', 7300), false);
    await c.reopen(); await c.kill(88, 2, .49); assert.equal(await c.amount(3162), 20);
    for (const npc of [7300, 7371, 7419, 7375]) await c.click(218, 'handin', npc);
    await c.kill(233, 1, .5); await c.kill(145, 1, .5);
    assert.equal(await c.amount(3164), 0); assert.equal(await c.amount(3165), 0);
    await c.kill(233, 21); await c.kill(145, 19);
    assert.equal(await c.event(218, 'handin', 7375), false);
    await c.kill(145, 2); assert.equal(await c.amount(3165), 20);
    for (const npc of [7375, 7419]) await c.click(218, 'handin', npc);
    if (waitAt37) {
        await c.click(218, 'handin', 7371);
        assert.equal(c.cond(218), 11); assert.equal(await c.amount(3148), 1);
        await c.click(218, 'handin', 7371); assert.equal(c.cond(218), 11);
        await c.reopen();
    }
    await c.level(38); await c.click(218, 'handin', 7371);
    assert.equal(await c.amount(3148), 0);
    await c.click(218, 'handin', 7655);
    await c.kill(581, 1, .5); assert.equal(await c.amount(3166), 0);
    if (beforeSpearParts) await beforeSpearParts();
    for (let i = 0; i < 6; i++) await c.kill(i % 2 ? 582 : 581);
    await c.kill(582); assert.equal(await c.amount(3171), 1);
    for (let id = 3166; id <= 3171; id++) assert.equal(await c.amount(id), 1);
    await c.click(218, 'handin', 7655);
    await c.kill(5077); assert.equal(await c.amount(3159), 0, 'the grail must be obtained before the unicorn');
    if (equipped) {
        await equipSpear(c);
        // Equipped-item consumption is restricted to this quest's trial spear.
        await c.world.talk(c.session, 7648);
        await assert.rejects(invoke('GameServer/Quest/QuestStep').apply(c.state(215), { takes: [[3026, 1]] }),
            /Required quest items missing/);
        assert.equal(await c.amount(3026), 1);
        assert.equal(c.session.actor.backpack.fetchEquippedWeapon().fetchSelfId(), 3026);
    }
    if (stopAtSpear) return;
    const spearAttack = equipped ? c.session.actor.fetchCollectivePAtk() : null;
    await c.click(218, 'handin', 7371); await c.kill(5077);
    assert.equal(await c.amount(3159), 1); assert.equal(await c.amount(3026), 0);
    assert.equal(c.session.actor.backpack.fetchEquippedWeapon(), undefined);
    if (equipped) {
        assert(c.session.packets.some(p => p[0] === 0x04), 'worn spear retirement refreshes user info');
        assert.deepEqual(c.session.actor.backpack.paperdoll[14], {});
        assert(c.session.actor.fetchCollectivePAtk() < spearAttack, 'removed spear no longer contributes attack');
    }
    await c.reopen(); await c.kill(5077); assert.equal(await c.amount(3159), 1);
    for (const npc of [7371, 7154, 7460]) await c.click(218, 'handin', npc);
    const after = await c.world.character(c.id);
    assert.equal(after.exp - before.exp, 104591); assert.equal(after.sp - before.sp, 11250);
    assert.equal(await c.amount(3140), 1);
    for (const item of c.state(218).quest.questItems) assert.equal(await c.amount(item), 0);
    assert.equal(await c.event(218, 'handin', 7460), false); assert.deepEqual(await c.world.character(c.id), after);
}

module.exports = { ...shared, life, equipSpear };
