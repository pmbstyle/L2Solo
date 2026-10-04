const assert = require('node:assert/strict');
const { createClericWorld, pilgrim, trust, finishRoute, abort, H, Service, withRandom } = require('./helpers/clericProfessionHarness');

(async () => {
    const c = await createClericWorld('prophet', 175001, [
        { id: 175002, classId: 42, race: 2, level: 39 }, { id: 175003, classId: 29, race: 1, level: 39 }
    ]);
    try {
        await pilgrim(c); await trust(c);
        assert.equal(await c.event(227, 'start', 7118), false, 'Reformer starts at 39');
        const oracle = await c.world.session(175003);
        assert.equal(await c.world.event(oracle, 227, 'start', 7118), false, 'Elven Oracle cannot take Reformer');
        const foreign = await c.world.session(175002);
        assert.equal(await c.world.event(foreign, 227, 'start', 7118), true, 'Shillien Oracle is eligible');
        await c.level(39); await c.click(227, 'start', 7118);
        assert.equal(await c.event(227, 'handin', 7666), false);
        await c.kill(5099, 6); assert.equal(await c.amount(2831), 6); assert.equal(c.cond(227), 1);
        await c.reopen(); await c.kill(5099, 2);
        assert.equal(c.cond(227), 2); assert.equal(await c.amount(2831), 0);
        assert.equal(H.personalSpawns(c.state(227), 5128).length, 1);
        const boss = H.personalSpawns(c.state(227), 5128)[0];
        await Service.onKill(foreign, boss); assert.equal(c.world.state(foreign, 227).getInt('cond'), 1);
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
        foreign.activeNpcTalk = { selfId: 7732, objectId: pilgrimNpc.fetchId() };
        assert.equal(await Service.onEvent(foreign, { questId: 227, name: 'thanks' }), false);
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
        assert.equal(await c.amount(2821), 1); assert.equal(await c.amount(7562), 24);
        const row = await c.world.character(c.id); assert.equal(row.exp, 281435); assert.equal(row.sp, 36000);
        assert.equal(await c.event(227, 'handin', 7666), false); assert.deepEqual(await c.world.character(c.id), row);
        for (const item of c.state(227).quest.questItems) assert.equal(await c.amount(item), 0);
        // The Shillien Oracle's own boss and diary fragments are removed by abort.
        const resumed = await c.world.session(175002);
        await withRandom(Array(7).fill(0), async () => { for (let i = 0; i < 7; i++) await c.world.kill(resumed, 5099); });
        const foreignState = c.world.state(resumed, 227);
        assert.equal(H.personalSpawns(foreignState, 5128).length, 1);
        await Service.giveItem(resumed, 57, 123); await Service.giveItem(resumed, 2723, 1);
        await c.world.talk(resumed, 7648); c.world.state(resumed, 215).addRadar(90, 80, 70);
        await abort(resumed, 227);
        assert.equal(H.personalSpawns(foreignState).length, 0);
        for (const item of foreignState.quest.questItems) assert.equal(await c.world.amount(175002, item), 0);
        assert.equal(await c.world.amount(175002, 57), 123); assert.equal(await c.world.amount(175002, 2723), 1);
        assert.equal(resumed.questWaypoints.size, 1);
        assert.equal(await c.world.event(resumed, 227, 'start', 7118), true);
        await finishRoute(c, 17, [[1068, 3], [1240, 1], [1242, 1], [239, 2]]);
        console.log('Prophet: complete Cleric route, owned/recovered encounters, pilgrim hand-in, greetings, bone quotas, rewards, abort and persisted skills passed');
    } finally { await c.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
