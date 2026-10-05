const assert = require('node:assert/strict');
const shared = require('./secondProfessionHarness');
const { H, Service } = shared;

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

async function healer(c, donate, foreign = null) {
    const before = await c.world.character(c.id);
    await c.click(226, 'start', 7473);
    assert.equal(await c.event(226, 'finish', 7473), false);
    assert.equal(await c.event(226, 'challenge', 7674), false);
    await c.click(226, 'challenge', 7428);
    const tatoma = H.personalSpawns(c.state(226), 5134)[0];
    assert(tatoma);
    await c.kill(5134); assert.equal(c.cond(226), 2, 'a wild/fabricated Tatoma is not the personal opponent');
    if (foreign) {
        await Service.onKill(foreign, tatoma);
        assert.equal(c.world.state(foreign, 226).getInt('cond'), 1);
    }
    H.clearSpawns(c.state(226)); await c.reopen();
    await c.click(226, 'recover', 7428); await c.click(226, 'recover', 7428);
    assert.equal(H.personalSpawns(c.state(226), 5134).length, 1);
    await c.ownedKill(226, 5134);
    for (const npc of [7428, 7424, 7658]) await c.click(226, 'handin', npc);
    if (donate) {
        await Service.giveItem(c.session, 57, 99999);
        assert.equal(await c.event(226, 'donate', 7658), false); assert.equal(await c.amount(57), 99999);
        await Service.giveItem(c.session, 57, 1);
        await c.click(226, 'donate', 7658);
        assert.equal(await c.amount(57), 0); assert.equal(await c.amount(2812), 1);
        assert.equal(await c.event(226, 'donate', 7658), false);
        await c.click(226, 'handin', 7660); await c.click(226, 'handin', 7658);
        assert.equal(await c.amount(2813), 1);
    } else {
        await c.click(226, 'skip', 7658);
        assert.equal(c.cond(226), 9, 'the no-donation branch reaches the rescue');
        assert.equal(await c.amount(2813), 0); assert.equal(await c.amount(57), 0);
    }
    await c.click(226, 'handin', 7327); await c.click(226, 'challenge', 7674);
    assert.equal(H.personalSpawns(c.state(226), 5122).length, 2);
    assert.equal(H.personalSpawns(c.state(226), 5123).length, 1);
    const leader = H.personalSpawns(c.state(226), 5123)[0];
    assert.deepEqual([leader.fetchLocX(), leader.fetchLocY(), leader.fetchLocZ()], [-97441, 106585, -3405]);
    await c.ownedKill(226, 5122); assert.equal(c.cond(226), 11);
    await c.ownedKill(226, 5123);
    await c.kill(5123); assert.equal(await c.amount(2816), 1);
    assert.equal(H.personalSpawns(c.state(226)).length, 0);
    await c.click(226, 'handin', 7674); assert.equal(await c.amount(2816), 1, 'Daurin keeps the original letter for Kristina');
    await c.click(226, 'guide', 7662);
    assert(c.session.questWaypoints.size > 0);
    for (const [template, item] of [[5124, 2817], [5125, 2818], [5127, 2819]]) {
        await c.click(226, 'challenge', 7661);
        assert.equal(H.personalSpawns(c.state(226)).length, 3);
        // Let an encounter disappear, reopen SQLite, then recover without duplication.
        H.clearSpawns(c.state(226)); await c.reopen();
        await c.click(226, 'recover', 7661); await c.click(226, 'recover', 7661);
        assert.equal(H.personalSpawns(c.state(226)).length, 3);
        await c.ownedKill(226, template);
        assert.equal(await c.amount(item), 1); assert.equal(H.personalSpawns(c.state(226)).length, 0);
        await c.kill(template); assert.equal(await c.amount(item), 1);
    }
    for (const i of [2816, 2817, 2818, 2819]) assert.equal(await c.amount(i), 1);
    await c.click(226, 'handin', 7661); await c.click(226, 'guide', 7663);
    assert.equal(c.cond(226), 21);
    await c.click(226, 'handin', 7665); await c.click(226, 'handin', 7327);
    await c.reopen(); await c.click(226, 'finish', 7473);
    assert.equal(await c.amount(2820), 1);
    const after = await c.world.character(c.id);
    assert.equal(after.exp - before.exp, donate ? 134839 : 118304);
    assert.equal(after.sp - before.sp, donate ? 50000 : 26250);
    for (const i of c.state(226).quest.questItems) assert.equal(await c.amount(i), 0);
    assert.equal(c.session.questWaypoints?.size || 0, 0);
    assert.equal(await c.event(226, 'finish', 7473), false); assert.deepEqual(await c.world.character(c.id), after);
}

async function reformer(c, foreign = null) {
    const before = await c.world.character(c.id);
    await c.click(227, 'start', 7118);
    assert.equal(await c.event(227, 'handin', 7666), false);
    await c.kill(5099, 6); assert.equal(await c.amount(2831), 6); assert.equal(c.cond(227), 1);
    await c.reopen(); await c.kill(5099, 2);
    assert.equal(c.cond(227), 2); assert.equal(await c.amount(2831), 0);
    assert.equal(H.personalSpawns(c.state(227), 5128).length, 1);
    const boss = H.personalSpawns(c.state(227), 5128)[0];
    if (foreign) { await Service.onKill(foreign, boss); assert.equal(c.world.state(foreign, 227).getInt('cond'), 1); }
    await c.kill(5128); assert.equal(await c.amount(2832), 0, 'a wild Aruraune cannot grant the personal objective');
    H.clearSpawns(c.state(227)); await c.reopen();
    await c.click(227, 'recover', 7118); await c.click(227, 'recover', 7118);
    assert.equal(H.personalSpawns(c.state(227), 5128).length, 1);
    await c.ownedKill(227, 5128); assert.equal(await c.amount(2832), 1);
    await c.click(227, 'handin', 7118); await c.click(227, 'handin', 7666);
    await c.click(227, 'challenge', 7668);
    assert.equal(H.personalSpawns(c.state(227), 7732).length, 1);
    assert.equal(H.personalSpawns(c.state(227), 5129).length, 1);
    assert.equal(await c.event(227, 'challenge', 7668), false);
    assert.equal(await c.event(227, 'handin', 7668), false);
    const pilgrimNpc = H.personalSpawns(c.state(227), 7732)[0];
    c.session.activeNpcTalk = { selfId: 7732, objectId: pilgrimNpc.fetchId() };
    assert.equal(await Service.onEvent(c.session, { questId: 227, name: 'thanks' }), false, 'save the pilgrim before claiming his gift');
    await c.ownedKill(227, 5129);
    if (foreign) {
        foreign.activeNpcTalk = { selfId: 7732, objectId: pilgrimNpc.fetchId() };
        assert.equal(await Service.onEvent(foreign, { questId: 227, name: 'thanks' }), false);
    }
    H.clearSpawns(c.state(227)); await c.reopen();
    await c.click(227, 'recover', 7668); await c.click(227, 'recover', 7668);
    assert.equal(H.personalSpawns(c.state(227), 7732).length, 1);
    assert.equal(H.personalSpawns(c.state(227), 5129).length, 0, 'recover only the survivor after the inspector was defeated');
    await c.personalEvent(227, 'thanks', 7732);
    assert.equal(await c.amount(2826), 1);
    assert.equal(H.personalSpawns(c.state(227), 7732).length, 0);
    assert.equal(await Service.onEvent(c.session, { questId: 227, name: 'thanks' }), false);
    await c.click(227, 'handin', 7668);
    assert.equal(await c.amount(2826), 1, 'Katari preserves the money for Sla');
    await c.ownedKill(227, 5130); await c.click(227, 'handin', 7668);
    assert.equal(await c.event(227, 'handin', 7668), false);
    await c.click(227, 'handin', 7666);
    assert.equal(await c.amount(2827), 1); assert.equal(await c.amount(2826), 0); assert.equal(await c.amount(2825), 3);
    for (const [npc, mob, letter, greetings] of [[7669, 5131, 3037, 2], [7670, 5132, 2828, 1]]) {
        await c.click(227, 'challenge', npc);
        await c.kill(mob); assert.equal(H.personalSpawns(c.state(227), mob).length, 1);
        H.clearSpawns(c.state(227)); await c.reopen();
        await c.click(227, 'recover', npc); await c.click(227, 'recover', npc);
        assert.equal(H.personalSpawns(c.state(227), mob).length, 1);
        await c.ownedKill(227, mob); await c.click(227, 'handin', npc);
        assert.equal(await c.amount(letter), 1); assert.equal(await c.amount(2825), greetings);
    }
    await c.click(227, 'handin', 7667); assert.equal(await c.amount(2825), 0);
    assert.equal(await c.event(227, 'handin', 7667), false);
    for (const [mob, item] of [[100, 2838], [22, 2837], [102, 2836], [104, 2835]]) {
        await c.kill(mob, 2); assert.equal(await c.amount(item), 1);
    }
    assert.equal(c.cond(227), 17); await c.reopen();
    await c.kill(404, 2); assert.equal(await c.amount(2834), 1); assert.equal(c.cond(227), 18);
    await c.click(227, 'handin', 7667); await c.click(227, 'handin', 7666);
    assert.equal(await c.amount(2821), 1);
    const row = await c.world.character(c.id); assert.equal(row.exp - before.exp, 164032); assert.equal(row.sp - before.sp, 17500);
    assert.equal(await c.event(227, 'handin', 7666), false); assert.deepEqual(await c.world.character(c.id), row);
    for (const item of c.state(227).quest.questItems) assert.equal(await c.amount(item), 0);
}

module.exports = { ...shared, createClericWorld, trust, healer, reformer };
