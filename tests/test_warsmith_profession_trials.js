const assert = require('node:assert/strict');
const { createTrialWorld, guildsman, prosperity, finishRoute, abort, realActor, learn, craft, Service, Database } = require('./helpers/dwarfProfessionHarness');

async function maestro(c, order) {
    const before = await c.world.character(c.id);
    await c.level(38); assert.equal(await c.event(231, 'start', 7531), false);
    await c.level(39); await c.click(231, 'start', 7531);
    for (const branch of order) {
        if (branch === 'arin') {
            await realActor(c); await c.click(231, 'handin', 7536); await c.click(231, 'handin', 7556);
            assert.equal(c.cond(231), 9); assert(c.session.packets.some(p => p[0] === 0x28));
            await new Promise(resolve => setTimeout(resolve, 1150));
            assert.deepEqual([c.session.actor.fetchLocX(), c.session.actor.fetchLocY(), c.session.actor.fetchLocZ()], [140352, -194133, -2028]);
            await invoke('GameServer/Persistence/CharacterWriteQueue').flushCharacter(c.id);
            const row = await c.world.character(c.id); assert.deepEqual([row.locX, row.locY, row.locZ], [140352, -194133, -2028]);
            for (const npc of [7556, 7536]) await c.click(231, 'handin', npc);
        } else if (branch === 'filaur') {
            for (const npc of [7535, 7673]) await c.click(231, 'handin', npc);
            for (const [npc, item] of [[229, 2876], [233, 2877], [225, 2878]]) {
                await c.kill(npc, 11); assert.equal(await c.amount(item), 10);
            }
            await c.reopen(); for (const npc of [7673, 7535]) await c.click(231, 'handin', npc);
        } else {
            for (const npc of [7533, 7671, 7675]) await c.click(231, 'handin', npc);
            await c.kill(5133); for (const npc of [7671, 7533]) await c.click(231, 'handin', npc);
        }
    }
    assert.equal(c.cond(231), 17); await c.click(231, 'handin', 7531);
    const after = await c.world.character(c.id); assert.equal(after.exp - before.exp, 154499); assert.equal(after.sp - before.sp, 37500);
    assert.equal(await c.amount(2867), 1); assert.equal(await c.event(231, 'handin', 7531), false);
}

(async () => {
    const c = await createTrialWorld('warsmith', 179001, [
        { id: 179002, classId: 56, race: 4, level: 34 }, { id: 179003, classId: 54, race: 4, level: 39 },
        { id: 179004, classId: 56, race: 4, level: 34 }
    ], { classId: 56, race: 4, level: 34 });
    try {
        const scavenger = await c.world.session(179003);
        assert.equal(await c.world.event(scavenger, 231, 'start', 7531), false);
        await guildsman(c, { artisan: true }); await prosperity(c, { wait: false, reverse: true });
        await maestro(c, ['filaur', 'arin', 'balanki']);
        assert.equal((await c.world.character(c.id)).exp, 248401);
        assert.equal((await c.world.character(c.id)).sp, 50750); assert.equal(await c.amount(7562), 24);
        await finishRoute(c, 57, [[239, 2], [248, 2], [36, 3]]);
        c.id = 179002; c.session = await c.world.session(c.id);
        await guildsman(c, { artisan: true, weak: true });
        await maestro(c, ['balanki', 'filaur', 'arin']);
        assert.equal(await c.amount(7562), 0, 'weak guildsman and Maestro award no diamonds in historical C4');
        c.id = 179004; c.session = await c.world.session(c.id);
        await guildsman(c, { artisan: true, stopAtRecipe: true });
        await c.level(36); await realActor(c, true); await c.click(216, 'handin', 7298);
        await learn(c, 3025, 316);
        await Service.giveItem(c.session, 3137, 2);
        await craft(c, 316);
        await Service.giveItem(c.session, 57, 123); await abort(c.session, 216); await c.reopen();
        assert.equal((await Database.fetchCharacterRecipes(c.id)).length, 0);
        for (const item of c.state(216).quest.questItems) assert.equal(await c.amount(item), 0);
        assert.equal(await c.amount(57), 123);
        await c.level(39); await c.click(231, 'start', 7531);
        for (const npc of [7535, 7673]) await c.click(231, 'handin', npc);
        await c.kill(229, 2); await abort(c.session, 231); await c.reopen();
        for (const item of c.state(231).quest.questItems) assert.equal(await c.amount(item), 0);
        assert.equal(await c.amount(57), 123);
        await c.click(231, 'start', 7531); await c.click(231, 'handin', 7533);
        assert.equal(c.cond(231), 2);
        console.log('Warsmith: real amber/ring/key crafting, both guild rewards, both prosperity level branches, independent recommendations, real persisted Toma teleport and class skills passed');
    } finally { await c.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
