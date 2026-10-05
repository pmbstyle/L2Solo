const assert = require('node:assert/strict');
const { createTrialWorld, guildsman, prosperity, finishRoute, abort, realActor, H, Service, Database } = require('./helpers/dwarfProfessionHarness');

const { searcher } = require('./helpers/searcherProfessionHarness');

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
