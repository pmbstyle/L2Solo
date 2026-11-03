// A party's requirement refresh writes a far member's plan from the copy main
// read before; the member's own review (its class training) runs meanwhile.
// The plan write holds on the revision of that copy and moves it: with no write
// in between it lands, and a training publish landing in between wins: the
// party write is skipped, the row keeps the trained sp and combat profile, and
// the party's re-plan is marked due again so the member is planned anew.
// The same refresh releasing a member no longer required (its departure) holds
// on the revision of the copy it read the same way.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
require('../src/Global');
const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Population = invoke('GameServer/Bot/Population/PopulationService');
const Data = invoke('GameServer/DataCache');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'l2solo-party-requirement-member-write-'));
const ACCOUNT = 'bot_party_requirement_write';
const PARTY = 'bgp-requirement-write';
const DEPARTURE_PARTY = 'bgp-requirement-departure';
const LEADER_PARTY = 'bgp-requirement-leader-departure';

async function row(id) {
    return (await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [id]]))[0];
}
const plan = target => ({ status: 'active', strategy: 'direct_drop', partyNeed: 'required', requiresParty: true,
    target: { selfId: target, name: `Probe ${target}`, slot: 7 }, next: { spotId: 'requirement-spot', npcId: 0, itemId: target } });

(async () => {
    try {
        options.default.Database.path = path.join(directory, 'world.sqlite');
        options.default.Database.historyPath = path.join(directory, 'history.sqlite');
        Config.knowledgeErrorsEnabled = false;
        await new Promise(resolve => Database.init(resolve));
        Data.init();
        await Database.createAccount(ACCOUNT, 'fixture');
        await Life.init();
        await Parties.init();
        const member = async (name, partyId, leaderId, stats = {}, fields = {}) => {
            const characterId = Number((await Database.createCharacter(ACCOUNT, { name,
                race: 0, classId: 0, maxHp: 100, maxMp: 100, sex: 0, face: 0, hair: 0, hairColor: 0,
                locX: 1, locY: 1, locZ: 0 })).insertId);
            await Life.upsertState({ characterId, accountName: ACCOUNT, name,
                phase: 'cold', activity: 'hunting', level: 20, inventory: {},
                party: { partyId, role: 'member', leaderId: leaderId || characterId },
                stats: { classId: 0, generatedCold: true, leaderId: leaderId || characterId, ...stats },
                loc: { locX: 1, locY: 1, locZ: 0 }, vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
                timing: { nextResolveAt: Date.now() + 86400000 }, ...fields }, 'party_requirement_write_fixture');
            return characterId;
        };
        const id = await member('PartyMember', PARTY);
        const party = { partyId: PARTY, status: 'active', leaderId: id, memberIds: [id], stats: {} };
        assert.equal(Life.cachedState(id).party?.partyId, PARTY, 'fixture: the member is in the party');

        // No write in between: the plan lands on the revision read and moves it.
        const read = Number(Life.cachedState(id).simulation.revision);
        await Population.applyWorkerPartyRequirements(party, { memberPlans: [{ characterId: id, plan: plan(9101) }] });
        const planned = await row(id);
        assert.equal(Number(planned.simulationRevision), read + 1, 'the party write moves the member revision once');
        assert.equal(JSON.parse(planned.statsJson).equipmentPlan?.target?.selfId, 9101, 'the row holds the party plan');
        assert.equal(Life.cachedState(id).stats.equipmentPlan?.target?.selfId, 9101, 'the cache holds the party plan');
        assert.equal(Life.cachedState(id).simulation.revision, read + 1, 'the cache takes the written revision');
        assert.equal(Population.partyRequirementRefreshDue.has(PARTY), false, 'a landed write marks no re-plan');

        // The member's review trains it (serialized on the member like
        // reviewTrainingAfterCommit, moving the revision) while the leader's
        // deferred party write is read from the copy before it.
        const coldCombat = { probe: 'trained' };
        const training = Life.serializeClanLevelUp(id, async () => {
            const [trained] = await Database.execute([`UPDATE bot_life_state SET sp = 777,
                statsJson = json_set(statsJson, '$.coldCombat', json(?)), simulationRevision = simulationRevision + 1
                WHERE characterId = ? RETURNING *`, [JSON.stringify(coldCombat), id], { read: true }]);
            return Life.acceptLifecycleRow(trained);
        });
        const partyWrite = Population.applyWorkerPartyRequirements(party, { memberPlans: [{ characterId: id, plan: plan(9202) }] });
        await Promise.all([training, partyWrite]);
        const after = await row(id);
        assert.equal(Number(after.simulationRevision), read + 2, 'only the training moved the row');
        assert.equal(Number(after.sp), 777, 'the row keeps the trained sp');
        const stats = JSON.parse(after.statsJson);
        assert.deepEqual(stats.coldCombat, coldCombat, 'the row keeps the trained combat profile');
        assert.equal(stats.equipmentPlan?.target?.selfId, 9101, 'the skipped party write leaves the plan');
        const cached = Life.cachedState(id);
        assert.equal(cached.sp, 777, 'the cache keeps the trained sp');
        assert.equal(cached.stats.equipmentPlan?.target?.selfId, 9101, 'nothing is published on a skip');
        assert.equal(Population.partyRequirementRefreshDue.has(PARTY), true, 'a skipped write marks the party re-plan due again');
        console.log('PASS a party requirement write holds on the member revision it read');

        // A required party of two members who still need it and one who no
        // longer does: the refresh releases the third.
        const leader = await member('DepartureLead', DEPARTURE_PARTY, 0, { equipmentPlan: plan(9301) });
        const needing = await member('DepartureNeed', DEPARTURE_PARTY, leader, { equipmentPlan: plan(9302) });
        const done = await member('DepartureDone', DEPARTURE_PARTY, leader);
        const required = { partyId: DEPARTURE_PARTY, status: 'active', leaderId: leader, memberIds: [leader, needing, done],
            spotId: 'requirement-spot', stats: { objective: { priority: 'required', spotId: 'requirement-spot' } } };
        const refresh = { memberPlans: [], requirementRefreshedAt: Date.now() };
        const doneRead = Number(Life.cachedState(done).simulation.revision);

        // Its own review moves the released member while the departure is
        // built from the copy before it: the review wins, the member stays.
        const doneTraining = Life.serializeClanLevelUp(done, async () => {
            const [trained] = await Database.execute([`UPDATE bot_life_state SET sp = 888,
                simulationRevision = simulationRevision + 1 WHERE characterId = ? RETURNING *`, [done], { read: true }]);
            return Life.acceptLifecycleRow(trained);
        });
        Population.partyRequirementRefreshDue.clear();
        const beaten = Population.applyWorkerPartyRequirements(required, refresh);
        await Promise.all([doneTraining, beaten]);
        const kept = await row(done);
        assert.equal(Number(kept.simulationRevision), doneRead + 1, 'only the review moved the released member');
        assert.equal(kept.partyId, DEPARTURE_PARTY, 'a beaten departure leaves the member in the party');
        assert.equal(Number(kept.sp), 888, 'the row keeps the reviewed sp');
        assert.equal(Life.cachedState(done).party?.partyId, DEPARTURE_PARTY, 'nothing is published on a skipped departure');
        assert.deepEqual(Parties.find(DEPARTURE_PARTY)?.memberIds?.map(Number), [leader, needing, done],
            'the party row keeps the member whose departure was skipped');
        assert.equal(Population.partyRequirementRefreshDue.has(DEPARTURE_PARTY), true,
            'a skipped departure marks the party re-plan due again');

        // No write in between: the departure lands on the revision read and moves it.
        const departed = await Population.applyWorkerPartyRequirements(Parties.find(DEPARTURE_PARTY), refresh);
        assert.deepEqual(departed, [DEPARTURE_PARTY], 'the landed departure changes the party');
        const left = await row(done);
        assert.equal(Number(left.simulationRevision), doneRead + 2, 'the departure moves the member revision once');
        assert.equal(left.partyId, null, 'the landed departure clears the member party');
        assert.equal(Number(left.sp), 888, 'the departure writes only its own fields');
        assert.equal(JSON.parse(left.statsJson).partyBreakReason, 'party_objective_complete');
        assert.equal(Life.cachedState(done).party?.partyId, null, 'the cache takes the departure');
        assert.equal(Life.cachedState(done).simulation.revision, doneRead + 2, 'the cache takes the written revision');
        assert.deepEqual(Parties.find(DEPARTURE_PARTY)?.memberIds?.map(Number), [leader, needing],
            'the party row drops the departed member');
        assert.equal(Population.partyRequirementRefreshDue.has(DEPARTURE_PARTY), false, 'a landed departure clears the re-plan mark');
        console.log('PASS a party departure holds on the member revision it read');

        // A required party of four: its grouped leader and one member no
        // longer need it, two still do. The leader's departure lands and a
        // new leader is synced onto the members kept; the other released
        // member's review moves it first, so its departure is skipped and the
        // leader sync writes it from the copy after that review.
        const grouped = await member('LeaderGrouped', LEADER_PARTY, 0, {}, { activity: 'grouped', spotId: 'requirement-spot' });
        const reviewed = await member('LeaderReviewed', LEADER_PARTY, grouped);
        const needA = await member('LeaderNeedA', LEADER_PARTY, grouped, { equipmentPlan: plan(9401) });
        const needB = await member('LeaderNeedB', LEADER_PARTY, grouped, { equipmentPlan: plan(9402) });
        const leaderParty = { partyId: LEADER_PARTY, status: 'active', leaderId: grouped, memberIds: [grouped, reviewed, needA, needB],
            spotId: 'requirement-spot', stats: { objective: { priority: 'required', spotId: 'requirement-spot' } } };
        const groupedBefore = await row(grouped);
        assert.equal(groupedBefore.activity, 'grouped', 'fixture: the leader is grouped');
        const reviewedRead = Number(Life.cachedState(reviewed).simulation.revision);
        const review = Life.serializeClanLevelUp(reviewed, async () => {
            const [trained] = await Database.execute([`UPDATE bot_life_state SET sp = 999,
                simulationRevision = simulationRevision + 1 WHERE characterId = ? RETURNING *`, [reviewed], { read: true }]);
            return Life.acceptLifecycleRow(trained);
        });
        Population.partyRequirementRefreshDue.clear();
        const leaderRefresh = Population.applyWorkerPartyRequirements(leaderParty, refresh);
        await Promise.all([review, leaderRefresh]);
        const groupedLeft = await row(grouped);
        assert.equal(groupedLeft.partyId, null, 'the grouped leader departs');
        assert.equal(groupedLeft.activity, 'hunting', 'a grouped member departs to the solo resume activity');
        assert.ok(Number(groupedLeft.nextResolveAt) < Number(groupedBefore.nextResolveAt),
            'a grouped member departs with its next resolve moved to the solo resume');
        assert.ok(Number(groupedLeft.activityStartedAt) >= Number(groupedBefore.updatedAt || 0),
            'a grouped member departs with its activity restarted');
        assert.equal(groupedLeft.spotId, 'requirement-spot', 'a non-raid departure keeps its spot');
        assert.equal(Life.cachedState(grouped).activity, 'hunting', 'the cache takes the solo resume');
        const kept2 = await row(reviewed);
        assert.equal(kept2.partyId, LEADER_PARTY, 'the beaten departure keeps the reviewed member in the party');
        assert.equal(Number(kept2.sp), 999, 'the leader sync keeps the reviewed sp');
        assert.ok(Number(kept2.simulationRevision) > reviewedRead, 'the review moved the reviewed member');
        const newLeader = Number(Parties.find(LEADER_PARTY)?.leaderId);
        assert.notEqual(newLeader, grouped, 'the departed leader is replaced');
        assert.equal(Number(Life.cachedState(reviewed).party?.leaderId), newLeader, 'the kept member follows the new leader');
        assert.equal(Number(Life.cachedState(reviewed).sp), 999, 'the cache keeps the reviewed sp after the leader sync');
        assert.equal(Population.partyRequirementRefreshDue.has(LEADER_PARTY), true,
            'a skipped departure marks the party re-plan due again');
        console.log('PASS a leader sync after a departure writes the kept members from their newest copy');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
    process.exit(0);
})().catch(error => {
    console.error(error);
    process.exit(1);
});
