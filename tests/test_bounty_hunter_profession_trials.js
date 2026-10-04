const assert = require('node:assert/strict');
const { createTrialWorld, guildsman, prosperity, finishRoute, abort, realActor, H, Service, Database } = require('./helpers/dwarfProfessionHarness');

async function searcher(c, foreign) {
    await c.level(38); assert.equal(await c.event(225, 'start', 7690), false);
    await c.level(39); await c.click(225, 'start', 7690);
    for (const npc of [7291, 7728]) await c.click(225, 'handin', npc);
    await c.kill(781); const assassin = H.personalSpawns(c.state(225), 5094)[0]; assert(assassin);
    await Service.onKill(foreign, assassin); assert.equal(await c.world.amount(foreign.actor.fetchId(), 2787), 0);
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
    foreign.activeNpcTalk = { selfId: 7628, objectId: chest.fetchId() };
    assert.equal(await Service.onEvent(foreign, { questId: 225, name: 'handin' }), false);
    c.runtime.despawnQuestNpc(chest); await c.reopen(); await c.click(225, 'recover', 7627);
    await c.personalEvent(225, 'handin', 7628); assert.equal(await c.amount(2807), 20);
    for (const npc of [7291, 7690]) await c.click(225, 'handin', npc);
    assert.equal(H.personalSpawns(c.state(225)).length, 0); assert.equal(c.session.questWaypoints.size, 0);
    assert.equal(await c.event(225, 'handin', 7690), false);
}

(async () => {
    const c = await createTrialWorld('bounty-hunter', 178001, [
        { id: 178002, classId: 7, race: 0, level: 39 }, { id: 178003, classId: 54, race: 4, level: 34 }
    ], { classId: 54, race: 4, level: 34 });
    try {
        const foreign = await c.world.session(178002);
        assert.equal(await c.world.event(foreign, 216, 'start', 7103), false);
        assert.equal(await c.world.event(foreign, 221, 'start', 7104), false);
        await c.world.event(foreign, 225, 'start', 7690);
        await guildsman(c); await prosperity(c); await searcher(c, foreign);
        const row = await c.world.character(c.id);
        assert.equal(row.exp, 131733); assert.equal(row.sp, 32000); assert.equal(await c.amount(7562), 24);
        await finishRoute(c, 55, [[239, 2], [60, 1], [36, 3]]);
        c.id = 178003; c.session = await c.world.session(c.id);
        await guildsman(c, { stopAtRecipe: true });
        await Database.setCharacterRecipe(c.id, 1, 'dwarven');
        await Service.giveItem(c.session, 1880, 3); await realActor(c);
        // A stale quest revision must roll back recipe retirement with the inventory.
        const stale = { ...c.state(216), variables: { ...c.state(216).variables, revision: '999' } };
        stale.getInt = key => Number(stale.variables[key] || 0);
        await assert.rejects(invoke('GameServer/Quest/QuestStep').apply(stale, { removeRecipes: [315] }), /Quest step changed/);
        assert((await Database.fetchCharacterRecipes(c.id)).some(r => r.recipeId === 315));
        await abort(c.session, 216); await c.reopen(); await realActor(c);
        assert.deepEqual((await Database.fetchCharacterRecipes(c.id)).map(r => r.recipeId), [1]);
        assert.equal(await c.amount(1880), 3);
        for (const item of c.state(216).quest.questItems) assert.equal(await c.amount(item), 0);
        await prosperity(c, { stopAtRecipe: true }); await abort(c.session, 221);
        await c.reopen(); await realActor(c);
        assert.deepEqual((await Database.fetchCharacterRecipes(c.id)).map(r => r.recipeId), [1]);
        for (const item of c.state(221).quest.questItems) assert.equal(await c.amount(item), 0);
        assert.equal(await c.amount(1880), 3);
        await abort(foreign, 225);
        console.log('Bounty Hunter: complete real craft/Spoil route, independent proofs/maps, personal chest recovery, atomic recipe cleanup, SQLite restart and class skills passed');
    } finally { await c.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
