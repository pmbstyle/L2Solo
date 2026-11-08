// A party's requirement refresh writes a far member's plan from the copy main
// read before; the member's own review (its class training) runs meanwhile.
// The plan write holds on the revision of that copy and moves it: with no write
// in between it lands, and a training publish landing in between wins: the
// party write is skipped, the row keeps the trained sp and combat profile, and
// the party's re-plan is marked due again so the member is planned anew.
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

        // A plan needing no party where the old one needed this party: the fact rides the
        // plan's write, then party_need_ended wakes the member's stay, which reads both.
        const Situations = invoke('GameServer/Bot/Situations');
        const solo = { status: 'active', strategy: 'market', partyNeed: 'solo_ok', target: { selfId: 9399 }, next: {} };
        const woke = characterId => Situations.woken(Life.cachedState(characterId).stats, 'party_stay');
        const needing = await member('NeedEnds', PARTY, id, { backgroundPartyId: PARTY, equipmentPlan: plan(9301), woken: 0, waiting: 0 });
        const helper = await member('NeverNeeded', PARTY, id, { backgroundPartyId: PARTY, equipmentPlan: null, woken: 0, waiting: 0 });
        assert(!woke(needing) && !woke(helper), 'fixture: no stay woken');
        await Population.applyWorkerPartyRequirements({ ...party, memberIds: [id, needing, helper] },
            { memberPlans: [{ characterId: needing, plan: solo }, { characterId: helper, plan: { ...solo, target: { selfId: 9398 } } }] });
        const ended = JSON.parse((await row(needing)).statsJson);
        assert.equal(ended.equipmentPlan?.target?.selfId, 9399, 'the row holds the new plan');
        assert.equal(ended.partyNeedEnded, PARTY, 'the row holds the party whose need ended');
        assert(woke(needing), 'party_need_ended wakes its stay once the plan is written');
        assert.equal(Life.cachedState(needing).stats.equipmentPlan?.target?.selfId, 9399, 'the woken stay reads the new plan');
        assert.equal(JSON.parse((await row(helper)).statsJson).partyNeedEnded, undefined, 'a plan that never needed the party ends no need');
        assert(!woke(helper), 'nor wakes a stay');
        console.log('PASS a plan that ends a member\'s party need wakes its stay with the plan written');

    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
    process.exit(0);
})().catch(error => {
    console.error(error);
    process.exit(1);
});
