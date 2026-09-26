const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Database = invoke('Database'), Life = invoke('GameServer/Bot/Population/BotLifeState');
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Policy = invoke('GameServer/Clan/ClanMembershipPolicy');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clan-goal-recovery-'));
options.default.Database.path = path.join(directory, 'world.sqlite');
const query = (sql, args = []) => Database.execute([sql, args]);
const inventory = { 1864: { selfId: 1864, name: 'Stem', amount: 23, stackable: true } };
const goal = (key, id) => ({ type: 'equipment', goalKey: key, status: 'executing', target: { memberId: id } });
const row = async id => (await query('SELECT * FROM bot_life_state WHERE characterId=?', [id]))[0];
(async () => {
    Database.init();
    await query("INSERT INTO accounts(username,password) VALUES ('recovery','unused')");
    await query("INSERT INTO clans(id,name,leaderId) VALUES (7,'Recovery',1)");
    await query('INSERT INTO clan_simulation_clans(clanId,createdAt,updatedAt,stateJson) VALUES (7,1,1,?)',
        [JSON.stringify({ goal: goal('active', 1), productionGoal: goal('production', 2) })]);
    for (const [id, key] of [[1, 'active'], [2, 'production'], [3, 'orphan']]) {
        await query(`INSERT INTO characters(id,username,name,clanId,classId,race,level,maxHp,maxMp,sex,face,hair,hairColor,locX,locY,locZ)
            VALUES (?,'recovery',?,7,4,0,52,500,250,0,0,0,0,100,100,0)`, [id, `Recovery${id}`]);
        await query(`INSERT INTO bot_life_state(characterId,accountName,characterName,level,activity,phase,hp,maxHp,mp,maxMp,inventorySummary,statsJson,updatedAt)
            VALUES (?,'recovery',?,52,'hunting','cold',321,500,123,250,?,?,1)`, [id, `Recovery${id}`, JSON.stringify(inventory),
            JSON.stringify({ clanId: 7, classId: 4, equipmentPlan: { strategy: 'craft', status: 'active', recipeId: 213,
                target: { selfId: 195, name: 'Cursed Staff', slot: 14 }, clanGoal: { clanId: 7, goalKey: key, beneficiaryId: id } } })]);
    }
    const ended = { activity: 'traveling', inventory, stats: {
        equipmentPlan: { clanGoal: { clanId: 7, goalKey: 'ended' } },
        craftReturn: { loc: { locX: 100 } }, travel: { reason: 'component_craft' },
        clanPartyObjective: { clanGoalKey: 'ended' }, partyRequest: { clanGoalKey: 'ended' },
        clanMaterialDemand: { 1864: 100 }
    } };
    const cleared = Policy.reconcileGoals(ended, Policy.activeGoalKeys({ goal: { ...goal('ended', 3), status: 'completed' } }));
    assert.equal(cleared.activity, 'hunting');
    assert.deepEqual(cleared.stats, {});
    assert.strictEqual(cleared.inventory, inventory, 'goal cleanup never changes inventory');
    const current = { ...ended, stats: { equipmentPlan: { clanGoal: { goalKey: 'production' } } } };
    assert.strictEqual(Policy.reconcileGoals(current, Policy.activeGoalKeys({ goal: goal('active', 1),
        productionGoal: goal('production', 2) })), current);
    assert.deepEqual([...Policy.activeRaidGoalKeys([{
        status: 'active', memberIds: [1, 2, 3, 4, 5, 6, 7],
        stats: {
            objective: { sourceKind: 'raid', clanGoalKey: 'raid-goal', minPartySize: 7 },
            raidPreparation: { status: 'ready' }, raidEncounter: { status: 'active' }
        }
    }])], ['raid-goal'], 'a viable started raid keeps its clan goal alive during membership repair');
    const original = await row(3);
    assert(await Life.init(), 'startup recovery runs before normal bot hydration');
    assert(!JSON.parse((await row(3)).statsJson).equipmentPlan);
    for (const id of [1, 2]) assert(JSON.parse((await row(id)).statsJson).equipmentPlan, 'active and production goals survive');
    assert.equal((await row(3)).inventorySummary, original.inventorySummary);
    assert.equal((await row(3)).hp, original.hp);
    const party = await Parties.createOrUpdate({ partyId: 'clan-goal-party', leaderId: 1, memberIds: [1, 2],
        stats: { objective: { clanGoalKey: 'active', strategy: 'craft' } } });
    const staleParty = structuredClone(party);
    const stale = structuredClone(Life.cachedState(1));
    const result = await Database.updateAutonomousClanGoal({ clanId: 7, goal: goal('replacement', 3) });
    assert(result.ok);
    assert.equal(Parties.find('clan-goal-party').stats.objective, null);
    await Parties.createOrUpdate(staleParty);
    assert.equal(Parties.find('clan-goal-party').stats.objective, null, 'stale party saves do not revive the old objective');
    assert(!Life.cachedState(1).stats.equipmentPlan, 'goal rotation publishes repaired cache state');
    assert(JSON.parse((await row(2)).statsJson).equipmentPlan, 'parallel production remains active');
    await Life.upsertState(stale, 'delayed_old_goal');
    assert(!JSON.parse((await row(1)).statsJson).equipmentPlan, 'late saves cannot resurrect the retired goal');
    const fresh = Life.cachedState(1);
    const restored = Policy.preserveGoalInvalidation({ ...stale, stats: { ...stale.stats,
        clanMembershipVersion: fresh.stats.clanMembershipVersion } }, fresh.stats);
    assert(!restored.stats.equipmentPlan, 'late hot snapshots carrying fresh membership still lose old goals');
    assert.deepEqual(await Database.reconcileBotClanGoals(), { repairedMembers: 0, repairedParties: 0 });
    console.log('Startup, goal rotation, production preservation and delayed goal saves passed');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await Database.close(); fs.rmSync(directory, { recursive: true, force: true });
});
