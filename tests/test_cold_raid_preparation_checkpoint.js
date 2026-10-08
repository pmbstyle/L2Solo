"use strict";
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.N53_GAME_ROOT || path.resolve(__dirname, '..');
require(path.join(root, 'tests/helpers/databaseIsolation'));
const isolated = require(path.join(root, 'tests/helpers/isolatedSocialDatabase'))('raid-preparation-checkpoint', root);
fs.writeFileSync(isolated.ini, fs.readFileSync(isolated.ini, 'utf8')
    .replace(/^knowledgeErrorsEnabled\s*=\s*true$/m, 'knowledgeErrorsEnabled = false'));
const sqlite = require('node:sqlite');
const NativeDatabase = sqlite.DatabaseSync;
const opened = [];
sqlite.DatabaseSync = class OwnDatabase extends NativeDatabase {
    constructor(filename, options = {}) {
        assert([isolated.world, isolated.history].includes(path.resolve(String(filename))), 'only exact own UUID databases');
        super(filename, options);
        opened.push({ filename: String(filename), readOnly: options.readOnly === true });
    }
};
const { DatabaseSync } = sqlite;
require(path.join(root, 'src/Global'));
isolated.assertConfigured(options.default);
const Database = invoke('Database');
const History = invoke('HistoryDatabase');
const Data = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Progression = invoke('GameServer/Bot/BotClassProgression');
const Cap = invoke('GameServer/Progression/ProgressionCap');
const Roles = invoke('GameServer/Bot/AI/BotRoles');
const Catalog = invoke('GameServer/Skills/SkillBookCatalog');
const Resolver = invoke('GameServer/Bot/Population/BackgroundPartyResolver');
const Background = invoke('GameServer/Bot/Population/BackgroundResolver');
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const Raid = invoke('GameServer/Bot/Population/ColdRaidEncounter');
const Protocol = invoke('GameServer/Bot/Population/ColdSimulationProtocol');
const at = Date.now();
const loc = { locX: 50000, locY: 15000, locZ: -5000 };
const spot = { id: 'raid:10372', raidBoss: true, raidBossTemplateId: 10372,
    raidInstanceId: 'native-preparation-deadline', center: loc, npcSelfIds: [10372] };
const copy = value => JSON.parse(JSON.stringify(value));
const tables = ['characters', 'bot_life_state', 'items', 'skills', 'warehouse_items',
    'bot_background_parties', 'bot_raid_encounters', 'character_death_experience'];
const outcomes = [], observations = [];
let party, ids, produced, expectedDuration, expectedDeadline;
let grants = [], batch = null;

function image() {
    const connection = new DatabaseSync(isolated.world, { readOnly: true });
    try {
        return { tables: Object.fromEntries(tables.map(table => [table,
            copy(connection.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())])),
        cache: ids.map(id => copy(Life.cachedState(id))) };
    } finally {
        connection.close();
    }
}

async function check(name, work) {
    try {
        await work();
        outcomes.push({ name, status: 'PASS' });
        console.log('PASS', name);
    } catch (error) {
        outcomes.push({ name, status: 'FAIL', error: error.stack });
        console.error('FAIL', name, error.stack);
    }
}

async function seed(index, classId) {
    const account = `bot_raid_deadline_${index}`;
    const name = `RaidDeadline${index}`;
    await Database.createAccount(account, 'fixture');
    const profile = Profile.profileFor({ level: 20, stats: { classId,
        coldCombat: { skillSource: 'database', skills: [] } }, inventory: {} }, at);
    const id = Number((await Database.createCharacter(account, { name, classId, race: classId === 50 ? 3 : 0,
        sex: 0, face: 0, hair: 0, hairColor: 0, maxHp: profile.maxHp, maxMp: profile.maxMp, ...loc })).insertId);
    const initialSp = classId === 50 ? 2900 : 0;
    const exp = Number(Data.experience[19]);
    assert.equal(Cap.levelForExperience(exp), 20);
    await Database.execute(['UPDATE characters SET level=?,exp=?,sp=? WHERE id=?', [20, exp, initialSp, id]]);
    await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 1000, equipped: false, enchant: 0, slot: 0 });
    await Database.setItem(id, { selfId: 1539, name: 'Greater Healing Potion', amount: 2,
        equipped: false, enchant: 0, slot: 0 });
    const source = { characterId: id, accountName: account, name, level: 20, exp, sp: initialSp, adena: 1000,
        phase: 'cold', activity: 'hunting', spotId: spot.id, loc: { ...loc },
        inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
        vitals: { hp: profile.maxHp, maxHp: profile.maxHp, mp: profile.maxMp, maxMp: profile.maxMp },
        timing: { activityStartedAt: at - 1000, lastResolvedAt: at - 1000, lastHotAt: 0, nextResolveAt: at + 30000 },
        stats: { classId } };
    source.stats.coldCombat = Profile.legacySnapshot(source, [], at);
    assert(await Life.upsertState(source, 'raid_deadline_seed'));
    const cached = Life.cachedState(id);
    const beforeWrite = Database.createColdTrainingGuard(cached, () => assert.equal(Life.cachedState(id), cached));
    if (classId === 50) {
        const training = Catalog.nextTraining(classId, 20, 1009, 0);
        assert.deepEqual({ level: training.level, sp: training.sp, bookId: training.bookId },
            { level: 1, sp: 2900, bookId: null }, 'authored Orc Shaman Chant of Shielding, no attack book');
        const receipt = await Database.learnBotSkill(id, 1009, 1, { beforeWrite });
        assert.equal(receipt.learned, true);
        assert.equal(receipt.spentSp, 2900);
        assert.deepEqual(receipt.consumedBooks, []);
        observations.push({ stage: 'paid_native_skill', id, receipt: copy(receipt) });
    }
    const prefix = await Progression.reconcile({ characterId: id, classId, level: 20, seed: id }, { beforeWrite });
    assert.equal(prefix.classId, classId, 'the declared native class stays coherent at level20');
    assert.equal(prefix.spentSp, 0, 'paid cast skill exhausted SP before the genuine free prefix');
    assert.deepEqual(prefix.consumedBooks, []);
    Life.acceptNewerLifecycleRow(await Database.publishColdTraining(id, prefix, { beforeWrite }));
    const ready = Life.cachedState(id);
    const skills = await Database.fetchSkills(id);
    const next = { ...ready, stats: { ...ready.stats, coldCombat: Profile.legacySnapshot(ready, skills, at) } };
    const complete = Profile.profileFor(next, at);
    next.vitals = { hp: complete.maxHp, maxHp: complete.maxHp, mp: complete.maxMp, maxMp: complete.maxMp };
    await Database.updateCharacterVitals(id, complete.maxHp, complete.maxHp, complete.maxMp, complete.maxMp);
    assert(await Life.upsertState(next, 'raid_deadline_native_profile'));
    observations.push({ stage: 'native_prepared_input', id, classId, prefix: copy(prefix),
        skills: copy(skills), profile: { castSpd: complete.castSpd, maxMp: complete.maxMp } });
    return id;
}

async function prepareBatch(deadlineOverride) {
    const members = ids.map(id => Life.cachedState(id));
    const claims = await Owner.claimBatch(members, { allowParty: true, allowLifecycle: true });
    grants = claims.grants;
    assert.equal(grants.length, 7);
    const stageId = `raid-deadline:${grants[0].leaseId}`;
    const stage = await Raid.stage({ key: 'raid:10372', id: stageId, memberIds: ids }, () =>
        Resolver.resolve({ party, members, spot, targetNpcId: 10372, elapsedMs: 60000, timestamp: at }));
    const resolution = stage.result;
    assert.equal(resolution.debug.reason, 'raid_prepared');
    const nextParty = { ...party, ...resolution.partyPatch, stats: { ...party.stats, ...resolution.partyPatch.stats },
        nextResolveAt: deadlineOverride ?? resolution.nextResolveAt, updatedAt: Math.max(at, party.updatedAt + 1) };
    const atomicGroup = { id: stageId, memberIds: ids,
        partyChanges: [{ partyId: party.partyId, memberIds: ids, expectedUpdatedAt: party.updatedAt,
            updatedAt: nextParty.updatedAt, nextResolveAt: nextParty.nextResolveAt,
            statsJson: JSON.stringify(nextParty.stats), status: 'active' }],
        raidCommit: { key: 'raid:10372', expectedRevision: 0, revision: 1, snapshot: stage.snapshot } };
    const entries = await Promise.all(resolution.memberResults.map(async ({ state, result }) => {
        const nextState = await Life.prepareResolve(state, result,
            { persist: false, projectClassProgression: true, timestamp: at });
        if (deadlineOverride !== undefined) nextState.timing.nextResolveAt = deadlineOverride;
        return { token: grants.find(grant => grant.characterId === state.characterId), nextState, atomicGroup,
            options: { allowParty: true, allowLifecycle: true }, proposal: { baseState: state, result } };
    }));
    return { entries, stageId, resolution, before: image() };
}

async function releaseBatch() {
    const beforeRelease = ids?.length && Database.isReady() ? image() : null;
    const stageId = batch?.stageId || null;
    const heldGrants = copy(grants);
    if (batch) Raid.abort(batch.stageId);
    const releases = grants.length ? await Owner.releaseBatch(grants) : [];
    observations.push({ stage: 'explicit_authority_release', stageId, grants: heldGrants,
        results: copy(releases), before: beforeRelease,
        after: ids?.length && Database.isReady() ? image() : null });
    grants = [];
    batch = null;
}

async function main() {
    Database.init();
    assert(Database.isReady());
    Data.init();
    assert(Data.npcs.some(npc => Number(npc.selfId) === 10372), 'authored raid template exists');
    await Life.init();
    await Parties.init();
    ids = [];
    for (const [index, classId] of [4, 50, 15, 1, 1, 1, 1].entries()) ids.push(await seed(index, classId));
    const prepared = Parties.prepareCommit({ partyId: 'raid-native-deadline', leaderId: ids[0], memberIds: ids,
        spotId: spot.id, status: 'active', startedAt: at, nextResolveAt: at + 45000,
        stats: { objective: { sourceKind: 'raid', raidBossTemplateId: 10372, minPartySize: 7 } } });
    const assigned = ids.map(id => {
        const state = Life.cachedState(id);
        return Life.preparePartyAssignment(state, prepared.row.partyId, Roles.inferRole(state.stats.classId), ids[0], at + 45000);
    });
    assert.equal((await Database.commitBackgroundPartyMembership({ party: prepared.row, members: assigned })).ok, true);
    Life.acceptPartyAssignments(assigned);
    party = Parties.acceptCommit(prepared);
    const members = ids.map(id => Life.cachedState(id));
    const inputs = copy(members);
    const buffer = members[1];
    const profile = Profile.profileFor(buffer, at);
    const skill = profile.skills.find(row => row.selfId === 1009 && row.level === 1);
    assert(skill && skill.spell && skill.hitTime === 2500 && skill.mp === 77);
    expectedDuration = Math.max(500, 2500 * 333 / profile.castSpd);
    assert(expectedDuration > 3000 && !Number.isInteger(expectedDuration), 'native authored cast reaches the fractional branch');
    expectedDeadline = Math.ceil(at + expectedDuration);
    produced = Background.prepareRaidParty(members, at);
    observations.push({ stage: 'native_producer', inputs, expectedDuration, expectedDeadline, result: copy(produced),
        castSpd: profile.castSpd });

    await check('native cast duration and physical MP remain exact', () => {
        assert.equal(produced.buffCasts, 1);
        assert.equal(produced.ready, true);
        assert.equal(produced.durationMs, expectedDuration);
        assert.equal(produced.memberResults[1].result.patch.vitals.mp, buffer.vitals.mp - 77);
        assert.deepEqual(members, inputs, 'projection never mutates canonical source');
        for (const { result } of produced.memberResults) assert.deepEqual(result.materialize,
            { exp: 0, sp: 0, adena: 0, items: [] }, 'preparation earns no combat reward');
    });
    await check('deadline is integral and preparation never completes early', () => {
        assert.equal(produced.nextResolveAt, expectedDeadline);
        assert(Number.isSafeInteger(produced.nextResolveAt));
        assert(produced.nextResolveAt >= at + expectedDuration);
        assert(produced.nextResolveAt - (at + expectedDuration) < 1);
        assert(produced.memberResults.every(({ result }) => result.nextResolveAt === expectedDeadline));
    });
    await check('malformed incoming scalar remains refused instead of normalized', () => {
        const current = Life.cachedState(ids[0]);
        assert(Protocol.commandCheckpoint(current));
        const changed = { ...current, timing: { ...current.timing, nextResolveAt: current.timing.nextResolveAt + 0.25 } };
        assert.equal(Protocol.commandCheckpoint(changed), null);
        assert.deepEqual(Life.cachedState(ids[0]), current);
    });
    await check('malformed outgoing party deadline still refuses with whole-image conservation', async () => {
        batch = await prepareBatch(at + expectedDuration);
        const results = await Owner.commitAndReleaseBatch(batch.entries, { timestamp: at, journalReason: 'raid' });
        observations.push({ stage: 'malformed_group_refusal', results: copy(results),
            before: batch.before, after: image() });
        assert.equal(results.length, 7);
        assert(results.every(result => !result.ok));
        assert.deepEqual(image(), batch.before);
        await releaseBatch();
    });
    await check('genuine BackgroundParty→Life→SQL batch and final ACK conserve physical state', async () => {
        batch = await prepareBatch();
        const results = await Owner.commitAndReleaseBatch(batch.entries, { timestamp: at, journalReason: 'raid' });
        observations.push({ stage: 'actual_commit', results: copy(results), before: batch.before, after: image() });
        assert.equal(results.length, 7);
        assert(results.every(result => result.ok), JSON.stringify(results));
        const after = image();
        for (const name of ['items', 'skills', 'warehouse_items', 'character_death_experience']) {
            assert.deepEqual(after.tables[name], batch.before.tables[name], `${name} exact conservation`);
        }
        for (const original of batch.before.tables.characters) {
            const current = after.tables.characters.find(row => row.id === original.id);
            for (const key of Object.keys(original).filter(key => !['hp', 'maxHp', 'mp', 'maxMp'].includes(key))) {
                assert.equal(current[key], original[key], `characters.${key} no reward or training grant`);
            }
        }
        for (const member of members) {
            const row = after.tables.bot_life_state.find(value => value.characterId === member.characterId);
            assert.equal(row.nextResolveAt, expectedDeadline);
            assert(Number.isSafeInteger(row.nextResolveAt));
            assert.equal(row.exp, member.exp);
            assert.equal(row.sp, 0);
            assert.equal(row.adena, 1000);
            assert.equal(row.simulationOwner, 'legacy_main');
            assert.equal(row.simulationLeaseId, null);
            assert(Protocol.commandCheckpoint(Life.cachedState(member.characterId)), 'durable/cache checkpoint accepted');
        }
        assert.equal(after.tables.bot_background_parties[0].nextResolveAt, expectedDeadline);
        assert.equal(after.tables.bot_raid_encounters[0].revision, 1);
        const persistedRaid = JSON.parse(after.tables.bot_raid_encounters[0].snapshotJson);
        assert.equal(persistedRaid.hp, null, 'preparation never damages the boss');
        for (const result of results.slice(0, 6)) Raid.acknowledge(batch.stageId, result.characterId, true);
        await assert.rejects(Raid.stage({ key: 'raid:10372', id: 'before-final', memberIds: ids }, () => null),
            /raid_step_pending/, 'partial acknowledgements keep the genuine raid fence');
        Raid.acknowledge(batch.stageId, results[6].characterId, true);
        const completed = await Raid.stage({ key: 'raid:10372', id: 'after-final', memberIds: ids }, () => null);
        assert.equal(completed.result, null);
        Raid.abort('after-final');
        const replay = await Owner.commitAndReleaseBatch(batch.entries, { timestamp: at, journalReason: 'raid' });
        assert(replay.every(result => !result.ok));
        assert.deepEqual(image(), after, 'replay pays no MP twice and grants no reward');
        grants = [];
        batch = null;
    });
}

main().catch(error => {
    outcomes.push({ name: 'fixture setup/native chain', status: 'FAIL', error: error.stack });
    console.error(error);
}).finally(async () => {
    await releaseBatch();
    Raid.resetForTests();
    await Database.close();
    assert.equal(History.stats().running, false, 'native history worker joined');
    assert.equal(History.stats().path, null);
    const evidence = { pid: process.pid, outcomes, observations, opened, own: isolated,
        history: History.stats(), world: false, inspector: false, nativeWorkerTransport: false,
        scope: 'Native producer/main projection/atomic SQL/final raid ACK functional proof; no World/performance acceptance' };
    if (process.env.N53_TEST_EVIDENCE) fs.writeFileSync(process.env.N53_TEST_EVIDENCE, JSON.stringify(evidence, null, 2) + '\n');
    fs.rmSync(isolated.directory, { recursive: true, force: true });
    sqlite.DatabaseSync = NativeDatabase;
    if (outcomes.some(row => row.status === 'FAIL')) process.exitCode = 1;
});
