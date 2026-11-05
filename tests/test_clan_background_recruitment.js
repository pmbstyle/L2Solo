'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const isolated = require('./helpers/isolatedSocialDatabase')('clan-background-recruitment');
require('../src/Global');
isolated.assertConfigured(options.default);
const Database = invoke('Database');
const Policy = invoke('GameServer/Clan/ClanSimulationPolicy');
const Rules = invoke('GameServer/Clan/ClanRules');
const Demand = require('../src/GameServer/Clan/ClanRosterDemand');
const Simulation = invoke('GameServer/Clan/ClanSimulationService');
const ClanService = invoke('GameServer/Clan/ClanService');
const base = 840000;
const roles = [4, 15, 21, 11, 54, 3, 57];
const candidate = at => ({ characterId: base + at, classId: 3, level: 50, clanId: 0,
    stats: { generatedCold: true }, persona: { traits: { commitment: 1 } }, partyHistory: { peer: { runs: 4 } } });
const members = count => Array.from({ length: count }, (_, at) => ({ characterId: base + at,
    classId: roles[at] ?? 3, level: 50 }));
const select = (clan, recruit = candidate(10)) => Policy.selectExistingClan(recruit, [clan], { contextForClan: Demand.intakeContext });

function policyChecks() {
    for (const [level, limit] of [10, 15, 20, 30, 40, 40].entries()) {
        assert.equal(Policy.desiredMemberCount(level), limit);
        assert.equal(limit, Rules.memberLimit(level));
        const clan = { id: 77, level, members: members(limit - 1), state: { mode: 'autonomous' } };
        const available = select(clan, candidate(100));
        assert(available, `level ${level} accepts the last suitable member`);
        assert.equal(available.suitability.targetMemberCount, limit);
        assert.equal(select({ ...clan, members: members(limit) }, candidate(100)), null, `level ${level} stops at capacity`);
    }
    for (const objective of ['equip_roster', 'raid_preparation', 'treasury', 'advance_clan', 'clan_hall', 'maintain', 'recruit']) {
        const clan = { id: 77, level: 3, members: members(22), state: { mode: 'autonomous',
            strategy: { version: 1, objective, status: 'active', target: { members: 20, roles: ['healer'] } } } };
        const before = structuredClone(clan);
        assert(select(clan, candidate(100)), `${objective} permits ordinary growth, including past a saved reduced target`);
        assert.deepEqual(clan, before, 'background recruitment preserves the equipment or strategic owner');
        assert.equal(select(clan, { ...candidate(100), partyHistory: {}, persona: { traits: { commitment: 0 } } }), null,
            'ordinary candidates still need sufficient suitability');
        assert.equal(select(clan, { ...candidate(100), stats: { craftStationId: 1 } }), null,
            'static services remain ineligible');
    }
}

async function nativeChecks() {
    const seed = new DatabaseSync(isolated.world);
    seed.exec(fs.readFileSync(path.join(__dirname, '../database/sql/sqlite.sql'), 'utf8'));
    seed.exec("INSERT INTO accounts(username,password) VALUES('bot_pop_background','fixture')");
    const insert = seed.prepare(`INSERT INTO characters(id,username,name,classId,race,level,maxHp,maxMp,sex,face,hair,hairColor,locX,locY,locZ)
        VALUES(?,'bot_pop_background',?,?,0,50,500,300,0,0,0,0,0,0,0)`);
    const life = seed.prepare("INSERT INTO bot_life_state(characterId,accountName,characterName,level,statsJson) VALUES(?,'bot_pop_background',?,50,'{}')");
    for (let at = 0; at < 20; at++) {
        insert.run(base + at, `Background${at}`, roles[at] ?? 3);
        life.run(base + at, `Background${at}`);
    }
    seed.close();
    Database.init();
    const reload = ClanService.reload;
    ClanService.reload = async () => {};
    try {
        const goal = { type: 'equipment', goalKey: 'background-equipment', status: 'preparing' };
        const demand = { ownerSection: 'productionGoal', goalKey: goal.goalKey, generation: 'background-generation',
            newMemberIds: [base + 7, base + 8], minLevel: 45, maxLevel: 58, neededKinds: ['healer'] };
        const created = await Database.createAutonomousClan({ name: 'BackgroundClan', leaderId: base,
            memberIds: members(7).map(member => member.characterId), founderQuorum: 5, maxBotMemberShare: 1,
            stateJson: { productionGoal: goal, recruitmentDemand: demand,
                strategy: { version: 1, objective: 'equip_roster', status: 'active', target: { upgrades: [] } } } });
        assert(created.ok);
        const [clan] = await Simulation.autonomousClanProjection();
        assert(select(clan), 'equipment recruitment leaves the unreserved slot open to ordinary growth');
        const joined = await Simulation.resolveCandidate(candidate(10), { clans: [clan] });
        assert(joined.ok, JSON.stringify(joined));
        assert.equal(joined.clanId, clan.id, 'ordinary intake uses the native join without a specialist generation');

        // A stale projection still sees seven members, but the native transaction
        // must protect both specialist places after the ordinary eighth joined.
        assert(select(clan, candidate(11)));
        const reserved = await Database.joinAutonomousClan({ clanId: clan.id, characterId: base + 11,
            memberLimit: 10, maxBotMemberShare: 1 });
        assert.equal(reserved.code, 'recruitment_slots_reserved');
        const bypass = await Database.joinAutonomousClan({ clanId: clan.id, characterId: base + 7,
            memberLimit: 10, maxBotMemberShare: 1 });
        assert.equal(bypass.code, 'recruitment_owner_changed', 'selected specialists must keep their native proof checks');

        const [current] = await Simulation.autonomousClanProjection();
        assert.equal(current.members.length, 8);
        assert.equal(select(current, candidate(11)), null, 'only the selected specialists can occupy reserved places');
        assert.deepEqual(current.state.productionGoal, goal);
        assert.deepEqual(current.state.recruitmentDemand, demand);

        const stale = { ...current, state: { ...current.state, productionGoal: { ...goal, status: 'completed' } } };
        assert(select(stale, candidate(11)), 'completed equipment tasks no longer reserve recruitment slots');
        const player = { ...current, state: { ...current.state, productionGoal: { ...goal, controlledBy: 'player' } } };
        assert(select(player, candidate(11)), 'player-owned goals do not claim autonomous recruitment');
        await Database.execute(['UPDATE clan_simulation_clans SET stateJson = ? WHERE clanId = ?',
            [JSON.stringify(stale.state), clan.id]]);
        assert((await Simulation.resolveCandidate(candidate(11), { clans: [stale] })).ok,
            'the native join also ignores completed recruitment demands');
        const [nearFull] = await Simulation.autonomousClanProjection();
        assert.equal(nearFull.members.length, 9);
        const population = await Database.joinAutonomousClan({ clanId: clan.id, characterId: base + 12,
            memberLimit: 10, maxBotMemberShare: 0.45 });
        assert.equal(population.code, 'join_population_limit', 'background growth respects the population share');
        assert((await Simulation.resolveCandidate(candidate(12), { clans: [nearFull] })).ok);
        const full = await Database.joinAutonomousClan({ clanId: clan.id, characterId: base + 13,
            memberLimit: 10, maxBotMemberShare: 1 });
        assert.equal(full.code, 'join_clan_full');
    } finally {
        ClanService.reload = reload;
        await Database.close();
    }
}

(async () => {
    policyChecks();
    await nativeChecks();
    console.log('Clan background recruitment: full capacity, concurrent equipment work and native reservation guards passed');
})().catch(error => { console.error(error); process.exitCode = 1; })
    .finally(() => fs.rmSync(isolated.directory, { recursive: true, force: true }));
