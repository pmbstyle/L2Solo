'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
async function nativeFixture() {
const isolated = require('./helpers/isolatedSocialDatabase')('clan-goal-recruitment');
require('../src/Global');
isolated.assertConfigured(options.default);
const Data = invoke('GameServer/DataCache'); Data.init();
// Recruitment/ownership fixture: a bounded native encounter, independent of
// the strength of the live C4 raid catalogue.
Data.npcs.push({ ...structuredClone(Data.npcs.find(npc=>npc.selfId===10137)), selfId:9900139,
    template:{kind:'Boss',name:'Recruitment fixture',level:50,raidBoss:true},
    stats:{pAtk:1,mAtk:1,pDef:1000,mDef:1000,atkSpd:278,accur:1},
    vitals:{maxHp:1000,maxMp:1000,revHp:0,revMp:0} });
const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Combat = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Gear = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Raid = require('../src/GameServer/Clan/ClanRaidPolicy');
const Demand = require('../src/GameServer/Clan/ClanRosterDemand');
const Equipment = invoke('GameServer/Clan/ClanEquipmentService');
const Goals = invoke('GameServer/Clan/ClanGoalService');
const Policy = invoke('GameServer/Clan/ClanSimulationPolicy');
const Events = invoke('GameServer/Clan/ClanReviewEvents');
const Config = invoke('GameServer/Clan/ClanSimulationConfig');
const Scope = require('../src/GameServer/RaidBoss/RaidEncounterScope');
const Catalog = invoke('GameServer/RaidBoss/RaidBossSourceCatalog');
const Runtime = require('../src/GameServer/Clan/ClanPlanningCoordinator');
const base = 830000;
const heal = [{ selfId: 1015, level: 1 }], buff = [{ selfId: 1068, level: 1 }];
function member(id, classId, skills = []) {
    const value = { characterId: id, classId, clanId: 0, level: 50, phase: 'cold', activity: 'hunting', spotId: 'ordinary:fixture',
        partyId: null, simulationRevision: 0, inventory: {}, accountName: 'bot_pop_recruitment',
        stats: { generatedCold: true, classId, partyHistory: { peer: { runs: 4 } }, coldCombat: {
            version: Combat.PROFILE_VERSION, classId, skillSource: 'database', skills: Combat.skillSnapshotsFromRecords(skills) } } };
    const role = Gear.roleFor(value);
    for (const slot of [7, 14, 8, 6, 9, 10, 11, 12]) {
        if (slot === 14 && Object.values(value.inventory).some(row => row.slot === 7)) continue;
        const item = Data.items.find(row => row.etc?.slot === slot && row.etc?.rank === 'c' && Gear.suitable(row, value, role, 'c'));
        if (item) value.inventory[item.selfId] = { selfId: item.selfId, slot, amount: 1, equipped: true };
    }
    for(const selfId of [1463,1464,2511]) value.inventory[selfId]={selfId,amount:100000,stackable:true};
    return value;
}
const roster = [member(base, 4), member(base + 1, 17, buff), ...[7, 9, 10, 21, 0].map((classId, i) => member(base + 2 + i, classId))];
const healer = member(base + 7, 15, heal), damage = member(base + 8, 9);
const spot = { id: 'raid:recruitment', avgLevel: 50, raidBoss: true, raidBossTemplateId: 9900139,
    raidInstanceId: 'fixture-boss', raidAuthorityRevision: 1, raidWorldAvailable: true };
const seed = new DatabaseSync(isolated.world);
seed.exec(fs.readFileSync(path.join(__dirname, '../database/sql/sqlite.sql'), 'utf8'));
seed.exec("INSERT INTO accounts(username,password) VALUES('bot_pop_recruitment','fixture')");
const character = seed.prepare(`INSERT INTO characters(id,username,name,classId,race,level,maxHp,maxMp,sex,face,hair,hairColor,locX,locY,locZ)
 VALUES(?,'bot_pop_recruitment',?,?,0,50,500,300,0,0,0,0,0,0,0)`);
const life = seed.prepare(`INSERT INTO bot_life_state(characterId,accountName,characterName,level,phase,activity,spotId,hp,maxHp,mp,maxMp,
 inventorySummary,statsJson,updatedAt) VALUES(?,'bot_pop_recruitment',?,50,'cold','hunting','ordinary:fixture',500,500,300,300,?,?,?)`);
for (const value of [...roster, healer, damage,
    ...Array.from({ length: 71 }, (_, i) => member(base + 100 + i, 15, i === 70 ? heal : [])),
    ...Array.from({ length: 80 }, (_, i) => member(base + 200 + i, 17, buff))]) {
    character.run(value.characterId, `Recruit${value.characterId}`, value.classId);
    for (const skill of value.stats.coldCombat.skills) seed.prepare('INSERT INTO skills(selfId,name,passive,level,characterId) VALUES(?,?,?,?,?)')
        .run(skill.selfId, skill.name || '', skill.passive ? 1 : 0, skill.level, value.characterId);
    life.run(value.characterId, `Recruit${value.characterId}`, JSON.stringify(value.inventory), JSON.stringify(value.stats), value.characterId);
    seed.prepare(`INSERT INTO bot_personas(characterId,seed,primaryDrive,archetype,traitsJson) VALUES(?,'fixture','power','fighter',?)`)
        .run(value.characterId, JSON.stringify({ commitment: 1 }));
}
seed.close();
const query = (sql, args = []) => Database.execute([sql, args]);
const originals = { find: Catalog.findById, project: Scope.projectSource, share: Config.maxBotMemberShare,
    reload: invoke('GameServer/Clan/ClanService').reload };
const plan = { status: 'active', strategy: 'direct_drop', partyNeed: 'required', expectedKills: 10, expectedEffort: 10,
    target: { selfId: 80, name: 'Sword', slot: 7 }, next: { spotId: spot.id, npcId: spot.raidBossTemplateId, itemId: 80,
        sourceKind: 'raid', raidBoss: true, raidBossTemplateId: spot.raidBossTemplateId } };
function planning(clan, prospects) {
    const prepared = Demand.prepare(clan, [spot], prospects, clan.state.productionGoal || null);
    return { ...prepared, spots: prepared.raids, occupancy: {}, plans: new Map([[base, plan]]),
        selection: { member: clan.members[0], plan }, recruitment: { ...prepared, ownerSection: 'productionGoal',
            scan: { key: Demand.scanKey(clan, [spot], clan.state.productionGoal, 'productionGoal'), sources: Demand.scanSources([spot]),
                ownerSection: 'productionGoal', prospects: prepared.retainedProspects, refused: [], classIds: [15], minLevel: 45, maxLevel: 58 } } };
}
async function pureAndWorker(clan, prospects) {
    const before = JSON.stringify([clan, prospects]);
    const prepared = Demand.prepare(clan, [spot], prospects);
    assert.equal(prepared.raids.length, 1, JSON.stringify({ assessment: Raid.assessment({ members: [...clan.members, ...prospects] }, spot, null, { desiredMembers: 9 }).reason, readiness: [...clan.members, ...prospects].map(m => [m.classId, Gear.combatReadiness(m)]) })); assert.equal(prepared.teams[spot.id].actualReady, false);
    assert.equal(prepared.teams[spot.id].prospectiveIds.length, 2);
    assert.equal(JSON.stringify([clan, prospects]), before, 'read-only conditional input');
    const sparse = { ...clan, members: [...clan.members, { ...healer, stats: { classId: 15 } }, damage] };
    assert(!Demand.prepare(sparse, [spot]).raids.length, 'owned class-only healer has no learned proof');
    const noMain = { ...clan, members: clan.members.map(m => m.classId === 17 ? member(m.characterId, 21, buff) : m) };
    assert(Demand.prepare(noMain, [spot]).requests.some(request => request.kinds.includes('mainBuffer')), 'music cannot satisfy main buff');
    const full = { ...clan, physicalMemberCount: 10, members: [...clan.members, member(base + 30, 0), member(base + 31, 0), member(base + 32, 0)] };
    assert.equal(Demand.prepare(full, [spot], prospects).raids.length, 0, 'full level0 clan never expels old members to make room');
    assert.equal(full.members.length, 10);
    const team = prepared.teams[spot.id];
    const goal = invoke('GameServer/Clan/ClanEquipmentPolicy').buildGoal(clan, { member: clan.members[0], plan });
    goal.assignedMemberIds = [];
    const demand = Demand.buildDemand(clan, goal, team, 'productionGoal');
    const noise = structuredClone(clan); noise.state.updatedAt += 100; noise.members[0].adena = 999999; noise.members[0].sp = 9999;
    noise.members[0].stats.sp = 9999; noise.members[0].stats.coldCombat.sp = 9999;
    assert.equal(Demand.scanKey(noise, [spot], goal, 'productionGoal'), Demand.scanKey(clan, [spot], goal, 'productionGoal'));
    assert.equal(Demand.buildDemand(noise, goal, team, 'productionGoal').generation, demand.generation);

    const changed = structuredClone(team); changed.rows[0][2] = 5; changed.rows[0][4] = 'different-class-proof';
    assert.notEqual(Demand.buildDemand(clan, goal, changed, 'productionGoal').generation, demand.generation, 'relevant selected class proof changes generation');
    const body = structuredClone(clan.members[0]); body.stats.coldCombat.base = { pAtk: 1000 };
    assert.notEqual(Demand.memberFingerprint(body), Demand.memberFingerprint(clan.members[0]), 'native combat base is a proof input');

    const legacyCandidate = { ...prospects[0], persona: { traits: { commitment: 1 } }, partyHistory: { peer: { runs: 4 } } };
    const defaultScore = Policy.clanSuitability(legacyCandidate, clan, { threshold: 0 });
    assert.deepEqual(defaultScore, Policy.clanSuitability(legacyCandidate, clan, { threshold: 0, roleNeed: defaultScore.roleNeed,
        growthNeed: defaultScore.growthNeed, targetMemberCount: defaultScore.targetMemberCount }), 'explicit old context is exact parity');
    const context = Demand.intakeContext(legacyCandidate, { ...clan, state: { ...clan.state, productionGoal: goal, recruitmentDemand: demand } });
    assert(context.roleNeed && context.growthNeed, 'missing selected-task healer matters after7');

    const missingMain = { ...clan, physicalMemberCount: 8, members: [clan.members[0],
        { ...member(clan.members[1].characterId, 15, heal), clanId: clan.id }, ...clan.members.slice(2),
        { ...member(base + 501, 17, buff), clanId: clan.id, phase: 'hot' }] };
    const prospectiveBuff = member(base + 500, 17, buff);
    const buffTeam = Demand.prepare(missingMain, [spot], [prospectiveBuff, damage]).teams[spot.id];
    assert(buffTeam && !buffTeam.actualReady);
    const buffDemand = Demand.buildDemand(missingMain, goal, buffTeam, 'productionGoal');
    const buffContext = Demand.intakeContext(prospectiveBuff, { ...missingMain, state: { ...clan.state,
        productionGoal: goal, recruitmentDemand: buffDemand } });
    assert(buffContext.roleNeed && buffContext.growthNeed, 'main buff after7 matters despite owned music and unavailable outside-group Prophet');

    assert(Policy.clanSuitability(legacyCandidate, clan, { ...context }).ok);
    assert(!Policy.clanSuitability(legacyCandidate, clan, { ...context, threshold: 1 }).ok, 'native threshold rejection remains');
    const worker = new Runtime.ClanPlanningCoordinator();
    try {
        await worker.withJob(Date.now() + 30000, Data, async jobKey => {
            const actual = await worker.prepareRaids({ jobKey, deadlineAt: Date.now() + 30000, clan, spots: [spot], prospects }, Data, [spot]);
            assert.deepEqual(actual, { ...prepared,
                economicProspects: Demand.retainedEconomicProspects(prospects, [], prepared.retainedProspects) },
            'new actual RPC uses identical learned capabilities, native estimate and full shared proof');
            // The next page of the same job: the clan, spots and sent
            // prospects are not cloned again, and the answer is the same as
            // one planned from scratch with the grown pool.
            const pages = [], send = worker.send;
            worker.send = (type, payload) => { pages.push(require('node:v8').serialize(payload).length); return send.call(worker, type, payload); };
            try {
                const grown = [...prospects, member(base + 300, 9)];
                const next = await worker.prepareRaids({ jobKey, deadlineAt: Date.now() + 30000, clan, spots: [spot], prospects: grown }, Data, [spot]);
                const fresh = Demand.prepare(clan, [spot], grown);
                assert.deepEqual(next, { ...fresh, economicProspects: Demand.retainedEconomicProspects(grown, [], fresh.retainedProspects) },
                    'a later page plans as if the whole pool were sent');
                const first = require('node:v8').serialize({ clan, prospects: grown }).length;
                assert(pages[0] < first / 3, `a later page sends only its new prospect (${pages[0]} of ${first} bytes)`);
            } finally { worker.send = send; }
            if (process.argv.includes('--lifecycle-failure')) assert.fail('intentional caught fixture lifecycle failure');
        });
        assert.equal(worker.activeJob, null);
    } finally { await worker.shutdown(); }
    const oldRewards = Data.npcRewards;
    try {
        const mobs = [Data.npcs.find(npc => npc.selfId === spot.raidBossTemplateId),
            Data.npcs.find(npc => npc.template?.level >= 45 && npc.template?.level <= 55 && Gear.isBotEligibleSourceNpcId(npc.selfId))];
        assert.equal(mobs.length, 2);
        Data.npcRewards = mobs.map(npc => ({ selfId: npc.selfId, template: npc.template, rewards: [{ overall: 100,
            items: [{ selfId: 79, chance: 100, min: 1, max: 1 }] }], spoils: [] }));
        const profiles = [{ ...prepared.raids[0], npcEntries: [{ selfId: mobs[0].selfId, count: 1 }], raidBossTemplateId: mobs[0].selfId },
            { id: 'ordinary:alternative', avgLevel: 50, npcEntries: [{ selfId: mobs[1].selfId, count: 1 }] }];
        // The C-equipped roster can pursue B drops; A stays market-only until B is ready.
        const sources = Gear.sourceForItem(79, profiles, clan.members[0], { allowRaidSources: true });
        assert.equal(sources.length, 2);
        assert.equal(sources[0].spotId, 'ordinary:alternative', 'same native sourceEffort ranks real cheaper alternative above conditional raid');
    } finally { Data.npcRewards = oldRewards; }
}

async function boundedContinuation(clan) {
    const oldPlan = Gear.planFor, oldQuery = Life.clanOperationCandidates;
    const queries = [];
    Gear.planFor = (state, options = {}) => options.spots?.some(s => s.raidBoss) ? structuredClone(plan) : { status: 'blocked', strategy: 'none' };
    Life.clanOperationCandidates = async options => { const rows = await oldQuery.call(Life, options); queries.push({ options, count: rows.length }); return rows; };
    await query("UPDATE bot_life_state SET phase='hot' WHERE characterId=?", [healer.characterId]);
    try {
        const first = await Equipment.planningForClan(clan, null, { spots: [spot], occupancy: {}, planningDeadline: Date.now() + 30000 });
        assert(first.recruitment.continuation && !first.recruitment.raids.length);
        assert.equal(queries.length, 1); assert.equal(queries[0].count, 64);
        assert(queries[0].options.classIds.includes(15) && !queries[0].options.classIds.includes(0), 'heal deficit never broadens to fighters before LIMIT');
        assert.equal(first.recruitment.scan.cursor.characterId, base + 163);
        assert(!(await query('SELECT stateJson FROM clan_simulation_clans WHERE clanId=?', [clan.id]))[0].stateJson.includes('recruitmentDemand'));
        const saved = await Database.updateAutonomousClanGoal({ clanId: clan.id, ownerSection: 'productionGoal', goal: null,
            recruitmentScan: first.recruitment.scan, eventType: null });
        assert(saved.ok); assert.equal(Events.recruitmentCount(), 1);

        await Events.drain();
        await query('BEGIN IMMEDIATE');
        await query('INSERT INTO board_trade_participants(characterId,meetingId) VALUES(?,99)', [base + 164]);
        assert.deepEqual(await Events.drain(), [], 'meeting claim cannot wake recruitment before COMMIT');
        await query('ROLLBACK'); assert.deepEqual(await Events.drain(), [], 'rolled back meeting input is quiet');
        await query('BEGIN IMMEDIATE');
        await query('INSERT INTO board_trade_participants(characterId,meetingId) VALUES(?,99)', [base + 164]);
        await query('COMMIT');
        assert((await Events.drain()).some(event => event.clanId === clan.id && event.causes.includes('recruitment_input')));
        await query('UPDATE board_trade_participants SET meetingId=NULL WHERE characterId=?', [base + 164]);
        assert((await Events.drain()).some(event => event.clanId === clan.id), 'committed meeting release wakes finite request');
        await query('UPDATE board_trade_participants SET meetingId=NULL WHERE characterId=?', [base + 164]);
        assert.deepEqual(await Events.drain(), [], 'unchanged meeting replay is quiet');

        const farming = structuredClone(clan);
        farming.members[0].activity = 'resting';
        farming.members[0].spotId = 'ordinary:next-camp';
        farming.members[0].stats.coldCombat.effects = [{ selfId: 1068, level: 1, remainingMs: 120000 }];
        assert.notEqual(Demand.ownFingerprint(farming), Demand.ownFingerprint(clan),
            'the final roster proof still detects changes while discovery continues');
        let conditional;
        for (const [label, current, causes, source] of [
            ['ordinary farming', farming, [], spot],
            ['candidate commit', clan, ['recruitment_input'], spot],
            ['respawn authority', clan, [], { ...spot, raidInstanceId: 'next-spawn', raidAuthorityRevision: 2 }]
        ]) {
            const offset = queries.length;
            const second = await Equipment.planningForClan({ ...current, state: saved.state }, null,
                { spots: [source], occupancy: {}, reviewCauses: causes, planningDeadline: Date.now() + 30000 });
            assert.equal(second.recruitment.raids.length, 1, `${label}: continuation reaches learned healer beyond first64`);
            assert.equal(queries[offset].options.cursor?.characterId, base + 163, `${label}: the next page keeps its cursor`);
            assert(queries.slice(offset).reduce((n, entry) => n + entry.count, 0) <= 64,
                `${label}: continuation keeps the existing candidate budget`);
            if (label === 'candidate commit') conditional = second;
        }
        const alternativesOffset = queries.length;
        await Equipment.planningForClan({ ...clan, state: { ...saved.state,
            recruitmentScan: conditional.recruitment.scan } }, null,
            { spots: [spot], occupancy: {}, planningDeadline: Date.now() + 30000 });
        assert(queries.length > alternativesOffset, 'a conditional raid not yet adopted by the clan must not freeze discovery');
        assert.equal(queries[alternativesOffset].options.cursor?.characterId, conditional.recruitment.scan.cursor.characterId);
        assert(queries.slice(alternativesOffset).reduce((n, entry) => n + entry.count, 0) <= 64);
        const exhausted = { ...saved.state, recruitmentScan: { ...first.recruitment.scan, done: true, prospects: [] } };
        const count = queries.length;
        const stopped = await Equipment.planningForClan({ ...clan, state: exhausted }, null,
            { spots: [spot], occupancy: {}, planningDeadline: Date.now() + 30000 });
        assert(!stopped.recruitment.continuation); assert.equal(queries.length, count, 'exhausted unchanged logical scan performs no repeated first-page read');

        // A candidate behind the cursor learns healing during the sweep. The
        // event must neither rewind this page nor lose that candidate forever.
        const behind = await Life.findByCharacterId(base + 100);
        const trained = { ...behind, stats: { ...behind.stats, coldCombat: { ...behind.stats.coldCombat,
            skills: Combat.skillSnapshotsFromRecords(heal) } } };
        await Database.setSkill({ selfId: 1015, level: 1, name: 'Heal' }, behind.characterId);
        assert(await Life.upsertState(trained, 'fixture_learned_heal'));
        await query("UPDATE bot_life_state SET phase='hot' WHERE characterId>? AND characterId<?", [base + 170, base + 300]);
        await query("UPDATE bot_life_state SET phase='hot' WHERE characterId=?", [base + 170]);
        const offset = queries.length;
        const finishing = await Equipment.planningForClan({ ...clan, state: saved.state }, null,
            { spots: [spot], occupancy: {}, reviewCauses: ['recruitment_input'], planningDeadline: Date.now() + 30000 });
        assert.equal(queries[offset].options.cursor?.characterId, base + 163);
        assert(finishing.recruitment.scan.done && finishing.recruitment.continuation,
            'candidate changes schedule a new sweep after the current one ends');
        const nextOffset = queries.length;
        const revisited = await Equipment.planningForClan({ ...clan, state: { ...saved.state, recruitmentScan: finishing.recruitment.scan } }, null,
            { spots: [spot], occupancy: {}, planningDeadline: Date.now() + 30000 });
        assert.equal(queries[nextOffset].options.cursor, null, 'the completed dirty sweep revisits earlier candidates');
        const learned = revisited.recruitment.prospects.find(value => value.characterId === behind.characterId);
        assert(learned, 'the restarted query includes the changed earlier candidate');
        assert(require('../src/GameServer/Clan/ClanCandidateCapabilities').contextualCapability(learned, 'healer'),
            JSON.stringify(learned.stats.coldCombat));
        assert(revisited.recruitment.retainedProspects.includes(behind.characterId),
            'the newly learned capability behind the cursor is retained for the next roster assessment');
        await query('DELETE FROM skills WHERE characterId=? AND selfId=1015', [behind.characterId]);
        assert(await Life.upsertState(behind, 'fixture_restore_heal'));
        await query("UPDATE bot_life_state SET phase='cold' WHERE characterId=?", [base + 170]);
        await Database.updateAutonomousClanGoal({ clanId: clan.id, ownerSection: 'productionGoal', goal: null,
            recruitmentDemand: null, recruitmentScan: null, eventType: null });
    } finally { Gear.planFor = oldPlan; Life.clanOperationCandidates = oldQuery;
        await query("UPDATE bot_life_state SET phase='cold' WHERE characterId=?", [healer.characterId]); }
}

async function recruitMissingRoles() {
    const own = Array.from({ length: 6 }, (_, i) => member(base + 1000 + i, [7, 9, 10, 21, 0, 9][i]));
    const supports = [member(base + 1006, 4), member(base + 1007, 17, buff), member(base + 1008, 15, heal)];
    for (const value of [...own, ...supports]) {
        await query(`INSERT INTO characters(id,username,name,classId,race,level,maxHp,maxMp,sex,face,hair,hairColor,locX,locY,locZ)
            VALUES(?,'bot_pop_recruitment',?,?,0,50,500,300,0,0,0,0,0,0,0)`, [value.characterId, `Roles${value.characterId}`, value.classId]);
        for (const skill of value.stats.coldCombat.skills) await Database.setSkill({ ...skill,
            name: skill.name || `Fixture skill ${skill.selfId}` }, value.characterId);
        assert(await Life.upsertState({ ...value, name: `Roles${value.characterId}`,
            vitals: { hp: 500, maxHp: 500, mp: 300, maxMp: 300 }, loc: { locX: 0, locY: 0, locZ: 0 } }, 'fixture_missing_roles'));
        await query(`INSERT INTO bot_personas(characterId,seed,primaryDrive,archetype,traitsJson)
            VALUES(?,'fixture','power','fighter',?)`, [value.characterId, JSON.stringify({ commitment: 1 })]);
    }
    const created = await Database.createAutonomousClan({ name: 'RaidRoleIntake', leaderId: own[0].characterId,
        memberIds: own.map(value => value.characterId), founderQuorum: 5, maxBotMemberShare: 1,
        stateJson: { goal: { type: 'level', status: 'preparing', goalKey: 'roles-level', target: { level: 1 } } } });
    assert(created.ok);
    const oldPlan = Gear.planFor, oldQuery = Life.clanOperationCandidates;
    let hydrated = 0, accepted = 0, ready = null;
    const passes = [];
    Gear.planFor = (state, options = {}) => options.spots?.some(source => source.raidBoss)
        ? structuredClone(plan) : { status: 'blocked', strategy: 'none' };
    Life.clanOperationCandidates = async options => {
        // The next discovery page need not contain people already selected
        // before the first join. Their addressed IDs must survive that join.
        if (accepted) return [];
        const page = await oldQuery.call(Life, options); hydrated += page.length; return page;
    };
    try {
        for (let pass = 0; pass < 10 && !ready; pass++) {
            const clan = await Goals.clanProjectionById(created.clanId);
            const before = hydrated;
            const computed = await Equipment.planningForClan(clan, clan.state.productionGoal,
                { spots: [spot], ownerSection: 'productionGoal', reviewCauses: ['recruitment_input'], planningDeadline: Date.now() + 30000 });
            if (accepted) assert(computed.recruitment.raids.some(source => source.id === spot.id),
                'a partial native join must retain the remaining selected roles across the membership scan reset');
            assert(hydrated - before <= 64, 'multi-role discovery retains the per-pass candidate budget');
            const result = await Equipment.resolveClan(clan, clan.state.productionGoal,
                { ownerSection: 'productionGoal', planning: computed });
            assert(result.ok, JSON.stringify(result));
            passes.push({ members: clan.members.length, raids: computed.recruitment.raids.length,
                cursor: computed.recruitment.scan.cursor, prospects: computed.recruitment.scan.prospects,
                accepted: result.joined?.accepted, refused: result.joined?.refused, reason: result.reason });
            if (result.joined?.accepted) accepted++;
            if (result.goal?.fullRoster) ready = result.goal;
            else if (!result.persistedGoal) {
                assert((await Database.updateAutonomousClanGoal({ clanId: clan.id, ownerSection: 'productionGoal',
                    goal: result.goal || null, recruitmentDemand: result.recruitmentDemand,
                    recruitmentScan: result.recruitmentScan, eventType: null })).ok);
            }
        }
        assert(ready, `bounded continuation and native joins produce a complete raid roster: ${JSON.stringify(passes)}`);
        assert.equal(accepted, 3, 'the clan physically recruits its three missing roles');
        const actual = await Goals.clanProjectionById(created.clanId);
        assert.equal(actual.members.length, 9);
        assert(Raid.composition(actual.members, { desiredMembers: 9, requireCapabilities: true }).ready,
            'the joined nine have a learned healer, main buffer, tank and damage coverage');
        assert.deepEqual([...ready.fullRoster.memberIds].sort(), actual.members.map(value => value.characterId).sort());
        for (const value of actual.members) assert.deepEqual(value.stats.clanPartyObjective?.fullRoster, ready.fullRoster,
            'all nine receive the same native raid objective after membership is durable');
        const shopping = actual.members[0];
        assert(await Life.upsertState({ ...shopping, activity: 'shopping' }, 'fixture_finish_purchase'));
        const assembling = await Goals.clanProjectionById(created.clanId);
        const alternative = { ...plan, target: { selfId: 91, name: 'Other upgrade', slot: 7 },
            next: { spotId: 'ordinary:fixture', npcId: 0, itemId: 91 } };
        const competing = { plans: new Map([[assembling.members[0].characterId, alternative]]),
            selection: { member: assembling.members[0], plan: alternative } };
        const oldDebt = { ...ready, createdAt: Date.now() - 24 * 60 * 60 * 1000 };
        const kept = await Equipment.resolveClan(assembling, oldDebt, { planning: competing });
        assert.equal(kept.reason, 'raid_assembling',
            'an admitted nine finishing purchases must reach assembly before another economic wish replaces it');
        assert.deepEqual(kept.goal, oldDebt, 'assembly starts when the raid route is assigned, even for an older equipment debt');
        const empty = { plans: new Map(), selection: null };
        const alternate = { ...shopping, characterId: base + 2000, id: base + 2000, activity: 'hunting',
            stats: { ...shopping.stats, clanPartyObjective: null, partyRequest: null } };
        const availableClan = { ...assembling, physicalMemberCount: 10, members: [...assembling.members, alternate] };
        const immediatelyReady = Raid.assessment(availableClan, spot, ready,
            { desiredMembers: 9, preferredMemberIds: availableClan.members.map(value => value.characterId) });
        assert(immediatelyReady.ready);
        assert(immediatelyReady.eligible.some(value => value.characterId === alternate.characterId),
            'an equally capable available role must precede an occupied member');
        assert.notEqual((await Equipment.resolveClan(availableClan, ready, { planning: empty })).reason, 'raid_assembling',
            'an available complete alternative releases a roster waiting for personal town work');
        spot.raidWorldAvailable = false;
        assert.notEqual((await Equipment.resolveClan(assembling, ready, { planning: empty })).reason, 'raid_assembling',
            'a missing boss releases the assembly commitment');
        spot.raidWorldAvailable = true;
        assert.notEqual((await Equipment.resolveClan({ ...assembling, members: assembling.members.slice(1) }, ready,
            { planning: empty })).reason, 'raid_assembling', 'a lost member releases the assembly commitment');
        const expired = { ...ready, plan: { ...ready.plan, selectedAt: Date.now() - 24 * 60 * 60 * 1000 } };
        assert.notEqual((await Equipment.resolveClan(assembling, expired, { planning: empty })).reason, 'raid_assembling',
            'assembly cannot hold an equipment goal indefinitely');
        const oldInstance = spot.raidInstanceId;
        spot.raidInstanceId = 'replacement-boss';
        assert.notEqual((await Equipment.resolveClan(assembling, ready, { planning: empty })).reason, 'raid_assembling',
            'a new boss life requires a new native admission');
        spot.raidInstanceId = oldInstance;
    } finally { Gear.planFor = oldPlan; Life.clanOperationCandidates = oldQuery; }
}


async function fundedOwners() {
    const Actions = invoke('GameServer/Clan/ClanActionService');
    const Contribution = invoke('GameServer/Clan/ClanContributionPolicy');
    const ids = Array.from({ length: 10 }, (_, i) => base + 100 + i);
    const productionGoal = { type: 'equipment', status: 'preparing', goalKey: 'funded-owner-equipment', assignedMemberIds: [],
        target: { memberId: ids[0], itemId: 80 }, plan: { kind: 'farm', sourceId: spot.raidBossTemplateId } };
    const recruitmentDemand = { ownerSection: 'productionGoal', goalKey: productionGoal.goalKey, generation: 'funded-owner',
        classIds: [17], neededKinds: ['mainBuffer'], minLevel: 45, maxLevel: 58, newMemberIds: [], status: 'waiting',
        source: { id: spot.id, npcId: spot.raidBossTemplateId, avgLevel: 50, raidInstanceId: spot.raidInstanceId, fingerprint: Demand.sourceFingerprint(spot) } };
    const created = await Database.createAutonomousClan({ name: 'FundedOwner', leaderId: ids[0], memberIds: ids,
        founderQuorum: 5, maxBotMemberShare: 1, stateJson: { productionGoal, recruitmentDemand } });
    assert(created.ok);
    for (const fromLevel of [0, 1]) {
        const required = Contribution.scaledAdenaRequirement(fromLevel);
        await query('UPDATE characters SET sp=? WHERE id=?', [fromLevel === 0 ? 30000 : 150000, ids[0]]);
        await query('UPDATE bot_life_state SET sp=? WHERE characterId=?', [fromLevel === 0 ? 30000 : 150000, ids[0]]);
        await query(`INSERT INTO clan_contributions(clanId,characterId,targetLevel,amount,resolveKey,createdAt) VALUES(?,?,?,?,?,?)`,
            [created.clanId, ids[0], fromLevel, required, `fixture-funded-${fromLevel}`, Date.now()]);
        await query(`INSERT INTO clan_warehouse_items(clanId,selfId,name,amount) VALUES(?,57,'Adena',?)`, [created.clanId, required]);
        const owner = await Goals.clanProjectionById(created.clanId);
        assert(owner.state.productionGoal.goalKey === productionGoal.goalKey && owner.members.length === 10);
        assert(!owner.members.some(m => require('../src/GameServer/Clan/ClanCandidateCapabilities').contextualCapability(m, 'mainBuffer')));
        const queued = await Database.enqueueClanAction({ clanId: created.clanId, actionKey: `fixture-funded-plan:${fromLevel}`,
            actionType: 'goal_plan', payload: fromLevel === 0 ? { reason: 'runtime_bootstrap' } : { reasons: ['leader_sp', 'recruitment_input'] } });
        const [action] = await query('SELECT * FROM clan_actions WHERE id=?', [queued.actionId]);
        const resolved = await Actions.resolveAction(action);
        assert(resolved.ok && resolved.status === 'succeeded', 'funded main goal must bypass recruitment deferral');
        const [payer] = await query(`SELECT * FROM clan_actions WHERE clanId=? AND actionType='contribution'
            AND status='pending' ORDER BY id DESC LIMIT 1`, [created.clanId]);
        assert(payer, 'bootstrap/coalesced leaderSP+recruitment preserve native contribution executor');
        const paid = await Actions.resolveAction(payer);
        assert(paid.ok);
        const next = await Goals.clanProjectionById(created.clanId);
        assert.equal(next.level, fromLevel + 1, 'native money+SP payer advances funded level despite full/noBuff production demand');
        assert.equal(next.state.productionGoal.goalKey, productionGoal.goalKey);
        assert.equal((await query('SELECT COALESCE(SUM(amount),0) AS n FROM clan_warehouse_items WHERE clanId=? AND selfId=57', [created.clanId]))[0].n, 0);
    }
}


function scalarSourceCase() {
    const World = invoke('GameServer/World/World'), Index = invoke('GameServer/World/RaidEntityIndex');
    const Authority = invoke('GameServer/Bot/Population/ColdRaidAuthority');
    const old = { user: World.user, boss: Index.bossByTemplateId, entities: Index.entitiesForRaid, get: Authority.get };
    let sessionsReads = 0, snapshotReads = 0, dead = false;
    const boss = { raidInstanceId: 'scalar-fixture', fetchId: () => 9876, fetchSelfId: () => spot.raidBossTemplateId,
        fetchHp: () => dead ? 0 : 1000, isDead: () => dead };
    World.user = { get sessions() { sessionsReads++; return []; } };
    Index.bossByTemplateId = () => boss; Index.entitiesForRaid = () => [boss];
    Authority.get = () => ({ revision: 42, get snapshot() { snapshotReads++; return { large: Array(1000).fill('unused') }; } });
    try {
        const scalar = originals.project(spot);
        assert.equal(sessionsReads, 0); assert.equal(snapshotReads, 0);
        assert(!Object.hasOwn(scalar, 'raidAuthority') && !Object.hasOwn(scalar, 'raidExternallyEngaged'));
        const full = { ...spot, ...Scope.raidRow(spot.raidBossTemplateId) };
        assert.equal(Demand.sourceFingerprint(scalar), Demand.sourceFingerprint(full));
        assert.equal(sessionsReads, 1); assert.equal(snapshotReads, 1, 'the raids table row still reads the full encounter inputs');
        dead = true;
        const gone = originals.project(spot);
        assert.equal(gone.raidWorldAvailable, false); assert.equal(gone.raidInstanceId, scalar.raidInstanceId);
        assert.equal(sessionsReads, 1); assert.equal(snapshotReads, 1, 'dead source projection still performs no hot-session/snapshot read');
    } finally { World.user = old.user; Index.bossByTemplateId = old.boss; Index.entitiesForRaid = old.entities; Authority.get = old.get; }
}
async function criticDeliveryCases(clan) {
    const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
    const EquipmentPolicy = invoke('GameServer/Clan/ClanEquipmentPolicy');
    await Parties.init();
    const dissolved = async partyId => {
        assert.equal(Parties.find(partyId), null, 'dissolved group leaves the active cache');
        assert.equal((await query('SELECT status FROM bot_background_parties WHERE partyId=?', [partyId]))[0].status, 'dissolved');
    };
    const write = async (id, patch) => { const current = await Life.findByCharacterId(id);
        assert(await Life.upsertState({ ...current, ...patch, stats: { ...current.stats, ...patch.stats } }, 'critic_fixture')); };
    const attach = async (ids, goal, partyId, marker = null, started = false) => {
        await Life.statesByIds(ids); // Native canonical membership before authoring a clan assignment.
        const objective = { clanId: clan.id, clanGoalKey: goal.goalKey, objectiveKey: `direct_drop:${spot.id}:${spot.raidBossTemplateId}`,
            reason: 'clan_equipment', sourceKind: 'raid', raidBoss: true, npcId: spot.raidBossTemplateId, spotId: spot.id,
            minPartySize: marker ? 9 : 7, maxPartySize: 9, priority: 'required', status: 'open', ...(marker ? { fullRoster: marker } : {}) };
        assert(await Parties.createOrUpdate({ partyId, leaderId: ids[0], memberIds: ids, status: 'active', spotId: spot.id,
            startedAt: Date.now(), nextResolveAt: Date.now() + 60000, stats: { objective,
                ...(started ? { raidEncounter: { status: 'active' } } : {}) } }));
        for (const id of ids) { const current = await Life.findByCharacterId(id);
            await write(id, { partyId, party: { ...current.party, partyId }, stats: { clanPartyObjective: objective, partyRequest: objective,
                ...(id === base ? { equipmentPlan: { ...structuredClone(plan), clanGoal: { clanId: clan.id, goalKey: goal.goalKey } } } : {}) } }); }
        for (const id of ids) assert.equal((await Life.findByCharacterId(id)).stats.clanPartyObjective?.clanGoalKey, goal.goalKey);
    };
    const paidId = base + 100;
    assert((await Database.joinAutonomousClan({ clanId: clan.id, characterId: paidId, memberLimit: 10, maxBotMemberShare: 1 })).ok);
    const personal = { status: 'active', strategy: 'market', target: { selfId: 123, slot: 7 } };
    await write(paidId, { stats: { equipmentPlan: personal, tradeMeeting: { id: 99 }, travel: { reason: 'afk_trade_meeting', token: 'paid' } } });
    await query('INSERT INTO board_trade_participants(characterId,meetingId) VALUES(?,99)', [paidId]);
    clan = await Goals.clanProjectionById(clan.id);
    const oldGoal = EquipmentPolicy.buildGoal(clan, { member: clan.members[0], plan }, null, Date.now(), { assignedMemberIds: roster.map(m => m.characterId) });
    assert((await Database.updateAutonomousClanGoal({ clanId: clan.id, ownerSection: 'productionGoal', goal: oldGoal })).ok);
    await attach(oldGoal.assignedMemberIds, oldGoal, 'critic-old7');
    const detached = await Life.findByCharacterId(base);
    await write(base, { partyId: null, party: { ...detached.party, partyId: null }, stats: { backgroundPartyId: null } });
    assert((await Life.findByCharacterId(base)).stats.equipmentPlan, 'ungrouped beneficiary still owns its old clan plan');
    // A legacy waiting request can remain outside its group alongside a
    // personal paid trade. Clear only the superseded clan owner fields.
    await Life.statesByIds([paidId]);
    const waitingRequest = (await Life.findByCharacterId(base)).stats.clanPartyObjective;
    await write(paidId, { stats: { clanPartyObjective: waitingRequest, partyRequest: waitingRequest } });
    clan = await Goals.clanProjectionById(clan.id);
    const withPaidProof = value => ({ ...value, members: value.members.map(m => ({ ...m, recruitmentReserved: m.characterId === paidId })) });
    const prospects = await Life.statesByIds([healer.characterId, damage.characterId]);
    await query('UPDATE characters SET clanJoinExpiryTime=? WHERE id=?', [Date.now() + 60000, healer.characterId]);
    const waiting = await Equipment.resolveClan(clan, oldGoal, { ownerSection: 'productionGoal', planning: planning(withPaidProof(clan), prospects) });
    assert(waiting.ok && waiting.suspension?.parties === 1, JSON.stringify({ok:waiting.ok,code:waiting.code,reason:waiting.reason,suspension:waiting.suspension}));
    await dissolved('critic-old7');
    assert.equal(waiting.goal.goalKey, oldGoal.goalKey); assert.deepEqual(waiting.goal.assignedMemberIds, []);
    for (const id of oldGoal.assignedMemberIds) { const state = await Life.findByCharacterId(id);
        assert(!state.stats.equipmentPlan && !state.stats.clanPartyObjective && !state.stats.partyRequest, JSON.stringify({ id, clanId: state.clanId, statsClanId: state.stats.clanId, plan: state.stats.equipmentPlan?.clanGoal, objective: state.stats.clanPartyObjective?.clanGoalKey, request: state.stats.partyRequest?.clanGoalKey }));
        if (id === base) assert(state.stats.clanGoalInvalidationVersion > 0, 'standalone beneficiary uses native owner invalidation');
        else assert.equal(state.stats.partyBreakReason, 'clan_equipment_party_reformed', 'native departure publishes the cleared solo snapshot'); }
    const paid = await Life.findByCharacterId(paidId);
    assert(!paid.stats.clanPartyObjective && !paid.stats.partyRequest);
    assert(paid.stats.clanGoalInvalidationVersion > 0, 'changed standalone owner fields use native delayed-snapshot invalidation');
    assert.deepEqual(paid.stats.equipmentPlan, personal); assert.deepEqual(paid.stats.tradeMeeting, { id: 99 });
    assert.equal(paid.stats.travel.token, 'paid'); assert.equal((await query('SELECT meetingId FROM board_trade_participants WHERE characterId=?', [paidId]))[0].meetingId, 99);
    await query('UPDATE characters SET clanJoinExpiryTime=0 WHERE id=?', [healer.characterId]);
    clan = await Goals.clanProjectionById(clan.id);
    assert((await Equipment.resolveClan(clan, clan.state.productionGoal, { ownerSection: 'productionGoal',
        planning: planning(withPaidProof(clan), await Life.statesByIds([healer.characterId])) })).ok);
    clan = await Goals.clanProjectionById(clan.id);
    const ids = clan.members.filter(m => m.characterId !== paidId).map(m => m.characterId);
    assert.equal(ids.length, 9);
    const unmarked = { ...clan.state.productionGoal, assignedMemberIds: ids };
    assert((await Database.updateAutonomousClanGoal({ clanId: clan.id, ownerSection: 'productionGoal', goal: unmarked,
        recruitmentDemand: null, recruitmentScan: null })).ok);
    await attach(ids, unmarked, 'critic-old9');
    clan = await Goals.clanProjectionById(clan.id);
    const ready = await Equipment.resolveClan(clan, unmarked, { ownerSection: 'productionGoal', planning: planning(withPaidProof(clan), []) });
    assert(ready.ok && ready.goal.fullRoster);
    await dissolved('critic-old9');
    const delivered = async (goal, members) => { for (const id of members) { const state = await Life.findByCharacterId(id);
        assert.equal(state.stats.clanPartyObjective.minPartySize, 9); assert.equal(state.stats.partyRequest.minPartySize, 9);
        assert.deepEqual(state.stats.clanPartyObjective.fullRoster, goal.fullRoster); assert.deepEqual(state.stats.partyRequest.fullRoster, goal.fullRoster); } };
    await delivered(ready.goal, ids);
    await attach(ids, ready.goal, 'critic-same-route-generation', ready.goal.fullRoster);
    spot.raidAuthorityRevision++;
    clan = await Goals.clanProjectionById(clan.id);
    const regenerated = await Equipment.resolveClan(clan, clan.state.productionGoal, { ownerSection: 'productionGoal', planning: planning(withPaidProof(clan), []) });
    assert(regenerated.ok); assert.notEqual(regenerated.goal.fullRoster.generation, ready.goal.fullRoster.generation);
    await dissolved('critic-same-route-generation'); await delivered(regenerated.goal, ids);
    await attach(ids, regenerated.goal, 'critic-stale-preparation', regenerated.goal.fullRoster);
    const stale = Parties.find('critic-stale-preparation');
    assert(await Parties.createOrUpdate({ ...stale, stats: { ...stale.stats, raidPreparation: { status: 'preparing' } } }));
    const previousInstance = spot.raidInstanceId;
    spot.raidInstanceId = 'new-world-boss';
    clan = await Goals.clanProjectionById(clan.id);
    const restartedWorld = await Equipment.resolveClan(clan, clan.state.productionGoal,
        { ownerSection: 'productionGoal', planning: planning(withPaidProof(clan), []) });
    assert.equal(restartedWorld.reason, 'clan_planning_deferred', 'old-life preparation must release its false in-progress lock');
    assert.equal(restartedWorld.continuation, true);
    await dissolved('critic-stale-preparation');
    spot.raidInstanceId = previousInstance;
    // The former trade has finished; a now unavailable fighter changes the
    // selected native nine from the existing ten without expelling anybody.
    await query('UPDATE board_trade_participants SET meetingId=NULL WHERE characterId=?', [paidId]);
    const finished = await Life.findByCharacterId(paidId); const stats = { ...finished.stats }; delete stats.tradeMeeting; delete stats.travel;
    assert(await Life.upsertState({ ...finished, stats }, 'critic_trade_finished'));
    const excluded = await Life.findByCharacterId(base + 6); assert(await Life.upsertState({ ...excluded, phase: 'hot' }, 'critic_unavailable'));
    clan = await Goals.clanProjectionById(clan.id);
    const changed = await Equipment.resolveClan(clan, clan.state.productionGoal, { ownerSection: 'productionGoal', planning: planning(clan, []) });
    assert(changed.ok && changed.goal.fullRoster); assert(changed.goal.fullRoster.memberIds.includes(paidId));
    assert(!changed.goal.fullRoster.memberIds.includes(base + 6)); await delivered(changed.goal, changed.goal.fullRoster.memberIds);
    assert.equal((await Goals.clanProjectionById(clan.id)).physicalMemberCount, 10);
    // Started unmarked legacy encounter remains protected by the native owner.
    const state = await Life.findByCharacterId(base + 6);
    assert(await Life.upsertState({ ...state, phase: 'cold' }, 'critic_available', { releaseHot: true }));
    await attach(ids, regenerated.goal, 'critic-started7', null, true);
    const before = Parties.find('critic-started7');
    const result = await Equipment.releaseConflictingRosterParties(ids, changed.goal, { minPartySize: 9, maxPartySize: 9, fullRoster: changed.goal.fullRoster });
    assert.equal(result.parties, 0); assert.equal(Parties.find('critic-started7'), before);
    clan = await Goals.clanProjectionById(clan.id);
    assert.equal((await Equipment.resolveClan(clan, clan.state.productionGoal, { ownerSection: 'productionGoal' })).reason, 'raid_in_progress');
}

async function main() {
    Database.init();
    try {
        assert(await Life.init());
        const created = await Database.createAutonomousClan({ name: 'DemandNative', leaderId: base, memberIds: roster.map(m => m.characterId),
            founderQuorum: 5, maxBotMemberShare: 1, stateJson: { goal: { type: 'level', status: 'preparing', goalKey: 'cash-goal', target: { level: 1 } } } });
        assert(created.ok);
        Config.maxBotMemberShare = 1;
        Catalog.findById = value => value === spot.id ? spot : originals.find(value);
        Scope.projectSource = value => value.id === spot.id ? { ...spot } : originals.project(value);
        invoke('GameServer/Clan/ClanService').reload = async () => {}; // Fixture has no online bot actors.
        let clan = await Goals.clanProjectionById(created.clanId);
        if (process.argv.includes('--critic-fixes')) {
            scalarSourceCase(); await criticDeliveryCases(clan);
            console.log('Clan recruitment critic fixes: same-key cleanup, min9/generation/roster delivery, started preservation and scalar source checks passed');
            return;
        }
        let prospects = await Life.statesByIds([healer.characterId, damage.characterId], { unassigned: true });
        await pureAndWorker(clan, prospects);
        await boundedContinuation(clan); clan = await Goals.clanProjectionById(clan.id);
        let captured = planning(clan, prospects);
        const team = captured.teams[spot.id];
        const goal = invoke('GameServer/Clan/ClanEquipmentPolicy').buildGoal(clan, captured.selection); goal.assignedMemberIds = [];
        const demand = Demand.buildDemand(clan, goal, team, 'productionGoal');
        const proof = { ...demand.proof, source: team.source, ownerSection: 'productionGoal', ownerGoal: Demand.goalFingerprint(null) };
        const apply = (extra = {}) => Database.updateAutonomousClanGoal({ clanId: clan.id, goal, ownerSection: 'productionGoal',
            expectedUpdatedAt: clan.state.updatedAt, recruitmentDemand: demand, recruitmentScan: captured.recruitment.scan, rosterProof: proof, ...extra });
        assert(Buffer.byteLength(JSON.stringify({ recruitmentDemand: demand, recruitmentScan: captured.recruitment.scan })) <= 2048);

        const operation = await query(`INSERT INTO clan_operations(clanId,operationKey,operationType,leaderId,memberIdsJson) VALUES(?,'fixture:pob','pob',?,'[]')`, [clan.id, base]);
        await query('INSERT INTO clan_operation_members(operationId,clanId,characterId) VALUES(?,?,?)', [operation.insertId, clan.id, base]);
        assert.equal((await apply()).code, 'recruitment_snapshot_changed', 'new own operation reservation invalidates captured proof');
        const savedPlan = Gear.planFor; Gear.planFor = () => ({ status: 'blocked', strategy: 'none' });
        try {
            const reserved = await Equipment.planningForClan(clan, null, { spots: [spot], occupancy: {}, planningDeadline: Date.now() + 30000 });
            assert.equal(reserved.recruitment.raids.length, 0, 'own reserved tank cannot be borrowed with empty life.partyId');
        } finally { Gear.planFor = savedPlan; }
        await query("UPDATE clan_operation_members SET status='released' WHERE characterId=?", [base]);
        await query('INSERT INTO board_trade_participants(characterId,meetingId) VALUES(?,99)', [base]);
        assert.equal((await apply()).code, 'recruitment_snapshot_changed', 'paid trade ownership invalidates captured proof');

        const beforeBusy = (await query('SELECT stateJson FROM clan_simulation_clans WHERE clanId=?', [clan.id]))[0].stateJson;
        const oldEnabled = Runtime.enabled, oldJob = Runtime.withJob, oldHydrate = Life.statesByIds;
        let hydrateCount = 0;
        Runtime.enabled = () => true; Runtime.withJob = async () => { throw Error('clan planning worker job busy'); };
        Life.statesByIds = async (...args) => { hydrateCount++; return oldHydrate.call(Life, ...args); };
        try { await assert.rejects(Equipment.resolveClan(clan, null, { ownerSection: 'productionGoal', spots: [spot] }),
            error => error.code === 'clan_planning_deferred'); }
        finally { Runtime.enabled = oldEnabled; Runtime.withJob = oldJob; Life.statesByIds = oldHydrate; }
        assert.equal(hydrateCount, 0); assert.equal((await query('SELECT stateJson FROM clan_simulation_clans WHERE clanId=?', [clan.id]))[0].stateJson, beforeBusy);
        assert.equal((await query('SELECT meetingId FROM board_trade_participants WHERE characterId=?', [base]))[0].meetingId, 99,
            'busy planning preserves goal and accepted trade owner');

        await query('UPDATE board_trade_participants SET meetingId=NULL WHERE characterId=?', [base]);

        await query('UPDATE characters SET classId=17 WHERE id=?', [healer.characterId]);
        assert.equal((await apply()).code, 'recruitment_snapshot_changed', 'canonical class stale even before life revision changes');
        await query('UPDATE characters SET classId=15 WHERE id=?', [healer.characterId]);
        spot.raidAuthorityRevision++;
        assert.equal((await apply()).code, 'recruitment_snapshot_changed', 'source revision stale'); spot.raidAuthorityRevision--;
        await query("UPDATE bot_life_state SET activity='resting' WHERE characterId=?", [base]);
        assert.equal((await apply()).code, 'recruitment_snapshot_changed', 'owned member availability stale');
        await query("UPDATE bot_life_state SET activity='hunting' WHERE characterId=?", [base]);
        await query("UPDATE clan_simulation_clans SET stateJson=json_set(stateJson,'$.productionGoal',json(?)) WHERE clanId=?",
            [JSON.stringify({ goalKey: 'replacement' }), clan.id]);
        assert.equal((await apply()).code, 'recruitment_snapshot_changed', 'same-timestamp goal replacement fenced');
        await query("UPDATE clan_simulation_clans SET stateJson=json_remove(stateJson,'$.productionGoal') WHERE clanId=?", [clan.id]);
        assert.equal((await apply({ expectedUpdatedAt: clan.state.updatedAt - 1 })).code, 'ownership_conflict');
        await query('UPDATE characters SET clanJoinExpiryTime=? WHERE id=?', [Date.now() + 60000, healer.characterId]);
        const waiting = await Equipment.resolveClan(clan, null, { ownerSection: 'productionGoal', planning: captured });
        assert(waiting.ok && waiting.persistedGoal && waiting.retryable);
        assert.equal(waiting.joined.accepted, damage.characterId, 'native cooldown refusal skips to next selected candidate');
        assert(waiting.joined.refused.includes(healer.characterId));
        let current = await Goals.clanProjectionById(clan.id);
        assert.equal(current.state.goal.goalKey, 'cash-goal', 'main monetary goal survives equipment production CAS');
        assert.deepEqual(current.state.productionGoal.assignedMemberIds, [], 'prospects never actual assignments');
        assert(current.state.recruitmentScan.refused.includes(healer.characterId));
        for (const m of current.members) assert(!m.stats.equipmentPlan && !m.stats.clanPartyObjective, 'waiting applies no plan, pay or party objective');
        assert.equal((await query("SELECT COUNT(*) AS n FROM clan_operation_members WHERE status='active'"))[0].n, 0);
        await query('UPDATE characters SET clanJoinExpiryTime=0 WHERE id=?', [healer.characterId]);
        prospects = await Life.statesByIds([healer.characterId], { unassigned: true });
        const joining = await Equipment.resolveClan(current, current.state.productionGoal,
            { ownerSection: 'productionGoal', planning: planning(current, prospects) });
        assert.equal(joining.joined.accepted, healer.characterId);
        current = await Goals.clanProjectionById(clan.id);
        assert.equal(current.members.length, 9);
        const ready = await Equipment.resolveClan(current, current.state.productionGoal,
            { ownerSection: 'productionGoal', planning: planning(current, []) });
        assert(ready.ok && ready.persistedGoal);
        assert.equal(ready.goal.fullRoster.memberIds.length, 9);
        assert.deepEqual([...ready.goal.fullRoster.memberIds].sort(), current.members.map(m => m.characterId).sort());
        assert.equal(ready.goal.fullRoster.minPartySize, 9); assert.equal(ready.goal.fullRoster.maxPartySize, 9);
        assert.equal(ready.goal.fullRoster.ownerSection, 'productionGoal'); assert.equal(ready.goal.fullRoster.raidInstanceId, spot.raidInstanceId);
        assert.equal(Events.recruitmentCount(), 0, 'actual9 clears demand/watch');
        current = await Goals.clanProjectionById(clan.id);
        const scan = { ownerSection: 'productionGoal', goalKey: current.state.productionGoal.goalKey, key: 'continuation', classIds: [15], minLevel: 45, maxLevel: 58 };
        await Database.updateAutonomousClanGoal({ clanId: clan.id, goal: current.state.productionGoal, ownerSection: 'productionGoal', recruitmentScan: scan });
        assert.equal(Events.recruitmentCount(), 1, 'recovery restores finite preselection watch');
        await Database.updateAutonomousClanGoal({ clanId: clan.id, goal: { ...current.state.productionGoal, status: 'completed' }, ownerSection: 'productionGoal' });
        assert.equal(Events.recruitmentCount(), 0, 'completion clears finite request');
        Events.syncRecruitment({ id: clan.id, state: { mode: 'player_managed', recruitmentScan: scan } }); assert.equal(Events.recruitmentCount(), 0);
        Events.stop(); assert.equal(Events.recruitmentCount(), 0);
        await recruitMissingRoles();
        await fundedOwners();
        console.log('Clan goal recruitment: native conditional RPC, alternatives, capacity, stale CAS, refusal, accepted9 and owner/watch tests passed');
    } finally {
        Catalog.findById = originals.find; Scope.projectSource = originals.project; Config.maxBotMemberShare = originals.share;
        invoke('GameServer/Clan/ClanService').reload = originals.reload;
        Events.stop(); await Runtime.shutdown(); await Database.close(); fs.rmSync(isolated.directory, { recursive: true, force: true });
    }
}
await main();
}

async function completeFixture(work) {
    let completed = false;
    // A pending Promise and an idle unref'ed worker do not keep Node alive.
    // Hold only this fixture until native work AND its cleanup have settled.
    const held = setInterval(() => {}, 1000);
    process.once('exit', () => {
        if (!completed) {
            console.error('Clan goal recruitment fixture did not complete successfully');
            process.exitCode = 1;
        }
    });
    try {
        await work();
        completed = true;
    } catch (error) {
        console.error(error);
        process.exitCode = 1;
    } finally { clearInterval(held); }
}
completeFixture(nativeFixture);
