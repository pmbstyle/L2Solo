const assert = require('assert');
const fs = require('fs');
const path = require('path');

const gameRoot = process.env.N53_GAME_ROOT || path.resolve(__dirname, '..');
require(path.join(gameRoot, 'tests/helpers/databaseIsolation'));
const isolated = require(path.join(gameRoot, 'tests/helpers/isolatedSocialDatabase'))('cold-owner-batches', gameRoot);
require(path.join(gameRoot, 'src/Global'));
isolated.assertConfigured(options.default);

const Database = invoke('Database');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
const Data = invoke('GameServer/DataCache');
const Skillset = invoke('GameServer/Actor/Skillset');
const Progression = invoke('GameServer/Progression/ProgressionCap');
Data.init();

// ARCH-NOTE: FX-E6 keeps native paid training outside the leased skill payload.
// These declared100SP profiles pay100 once, then earn only their original10/11/12.
const authoredProfiles = [0, 1, 2].map(index => ({
    initialLevel: 20 + index,
    nextLevel: 21 + index,
    earnedExp: 1100 + index,
    earnedSp: 10 + index,
    initialExp: Number(Data.experience[20 + index]) - (1100 + index),
    committedExp: Number(Data.experience[20 + index])
}));
for (const profile of authoredProfiles) {
    assert.strictEqual(Progression.levelForExperience(profile.initialExp), profile.initialLevel);
    assert.strictEqual(Progression.levelForExperience(profile.committedExp), profile.nextLevel);
    assert(profile.nextLevel <= Progression.effectiveLevelCap());
}
const clone = value => JSON.parse(JSON.stringify(value));
const profileById = new Map();
const preparedSkills = new Map();
async function wholeImage(id) {
    const result = {};
    for (const table of ['characters', 'bot_life_state', 'skills', 'items', 'warehouse_items', 'afk_trade_shops']) {
        const column = table === 'characters' ? 'id' : table === 'afk_trade_shops' ? 'ownerId' : 'characterId';
        result[table] = clone(await Database.execute([`SELECT * FROM ${table} WHERE ${column} = ? ORDER BY rowid`, [id]]));
    }
    result.afk_trade_lines = clone(await Database.execute([
        'SELECT * FROM afk_trade_lines WHERE shopId IN (SELECT id FROM afk_trade_shops WHERE ownerId = ?) ORDER BY rowid', [id]
    ]));
    result.cache = clone(LifeState.cachedState(id));
    return result;
}
async function nativeAncestorPrefix(id) {
    const input = LifeState.cachedState(id);
    const before = await wholeImage(id);
    const beforeWrite = Database.createColdTrainingGuard(input, () => {
        assert.strictEqual(LifeState.cachedState(id), input, 'the actual prepared source remains current');
    });
    const training = await new Skillset().awardSkills(id, 0, input.level, { botTraining: true, beforeWrite });
    assert.strictEqual(training.spentSp, 100);
    assert.strictEqual(training.learnedCount, 5);
    assert.deepStrictEqual(training.consumedBooks, []);
    const row = await Database.publishColdTraining(id, { ...training, transitions: [] }, { beforeWrite });
    const prepared = LifeState.acceptNewerLifecycleRow(row);
    assert(prepared, 'the actual paid publisher row rebases the cached lease input');
    assert.strictEqual(prepared.sp, 0);
    assert.strictEqual(prepared.stats.classId, 0, 'ancestor-only preparation preserves the class CAS boundary');
    assert.strictEqual(prepared.simulation.revision, input.simulation.revision + 1);
    const after = await wholeImage(id);
    assert.strictEqual(after.characters[0].classId, 0);
    assert.strictEqual(after.characters[0].level, input.level);
    assert.strictEqual(after.characters[0].exp, input.exp);
    assert.strictEqual(after.characters[0].sp, 0);
    const nativeRanks = after.skills.filter(skill => skill.selfId !== 239)
        .map(skill => [skill.selfId, skill.level]).sort((a, b) => a[0] - b[0]);
    assert.deepStrictEqual(nativeRanks, [[3, 2], [194, 1], [1320, 1], [1322, 1]]);
    for (const table of ['items', 'warehouse_items', 'afk_trade_shops', 'afk_trade_lines']) assert.deepStrictEqual(after[table], before[table]);
    preparedSkills.set(id, clone(after.skills).sort((a, b) => a.selfId - b.selfId));
    console.log('NATIVE_ANCESTOR_PREFIX', JSON.stringify({ id, authored: profileById.get(id), training,
        physicalSp: after.characters[0].sp, skills: after.skills,
        revisionBefore: input.simulation.revision, revisionAfter: prepared.simulation.revision }));
    return prepared;
}
Database.init();

function lifecycle(character, profile, inventory, revision = 0) {
    return {
        characterId: Number(character.id),
        accountName: character.accountName,
        name: character.name,
        level: profile.initialLevel,
        exp: profile.initialExp,
        sp: 100,
        adena: 500,
        phase: 'cold',
        activity: 'hunting',
        loc: { locX: 10, locY: 20, locZ: -30 },
        vitals: { hp: 100, maxHp: 100, mp: 50, maxMp: 50 },
        timing: { activityStartedAt: 100, nextResolveAt: 1000, lastResolvedAt: 500, lastHotAt: null },
        party: { partyId: null },
        stats: { probe: character.name },
        inventory,
        simulation: { ownerId: Owner.LEGACY_OWNER_ID, revision, leaseId: null, leaseUntil: 0 },
        updatedAt: 1000
    };
}

async function createProbe(index) {
    const accountName = `bot_batch_probe_${index}`;
    const name = `BatchProbe${index}`;
    await Database.createAccount(accountName, 'secret');
    await Database.createCharacter(accountName, {
        name, race: 0, classId: 0, maxHp: 100, maxMp: 50,
        sex: 0, face: 0, hair: 0, hairColor: 0, locX: 10, locY: 20, locZ: -30
    });
    const character = (await Database.fetchCharacters(accountName))[0];
    const profile = authoredProfiles[index - 1];
    const id = Number(character.id);
    await Database.execute(['UPDATE characters SET level = ?, exp = ?, sp = ? WHERE id = ?',
        [profile.initialLevel, profile.initialExp, 100, id]]);
    await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 500, equipped: false, enchant: 0, slot: 0 });
    const inventory = LifeState.inventorySummaryFromItems(await Database.fetchItems(id));
    const state = lifecycle({ ...character, accountName, name }, profile, inventory);
    profileById.set(id, profile);
    await Database.execute([
        `INSERT INTO bot_life_state (
            characterId, accountName, characterName, level, exp, sp, adena, activity, phase,
            activityStartedAt, nextResolveAt, lastResolvedAt, locX, locY, locZ,
            hp, maxHp, mp, maxMp, statsJson, inventorySummary, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [state.characterId, accountName, name, state.level, state.exp, state.sp, state.adena,
            state.activity, state.phase, state.timing.activityStartedAt, state.timing.nextResolveAt,
            state.timing.lastResolvedAt, state.loc.locX, state.loc.locY, state.loc.locZ,
            state.vitals.hp, state.vitals.maxHp, state.vitals.mp, state.vitals.maxMp,
            JSON.stringify(state.stats), JSON.stringify(state.inventory), state.updatedAt]
    ]);
    LifeState.acceptSimulationOwnership(state.characterId, state.simulation, state);
    return state;
}

(async () => {
    let states = await Promise.all([1, 2, 3].map(createProbe));
    await Database.setSkill({ selfId: 239, name: 'Expertise', passive: true, level: 2 }, states[0].characterId);
    // Preserve the original earned higher-rank/delevel input, without claiming level20 learned it.
    states = await Promise.all(states.map(state => nativeAncestorPrefix(state.characterId)));
    await Database.execute(['UPDATE characters SET karma = 45, pk = 1 WHERE id IN (?, ?)', [states[0].characterId, states[1].characterId]]);
    await Database.execute(['UPDATE characters SET karma = 1 WHERE id = ?', [states[2].characterId]]);
    const claimed = await Owner.claimBatch(states.map((state, index) => ({
        state,
        leaseId: `batch-lease-${index + 1}`
    })), { timestamp: 2000, leaseMs: 10000 });
    assert.strictEqual(claimed.grants.length, 3, 'one transaction must claim every eligible row');
    assert.strictEqual(claimed.rejected.length, 0);

    await Promise.all([states[0], states[2]].map((state) => Database.execute([
        'UPDATE bot_life_state SET statsJson = ? WHERE characterId = ?',
        [JSON.stringify({ ...state.stats, sex: 1, appearanceVersion: 2 }), state.characterId]
    ])));

    const staleClaims = await Owner.claimBatch([{
        state: states[0],
        leaseId: 'stale-batch-lease'
    }], { timestamp: 2100, leaseMs: 10000 });
    assert.strictEqual(staleClaims.grants.length, 0);
    assert.strictEqual(staleClaims.rejected[0].reason, 'stale_revision');
    assert.strictEqual(staleClaims.rejected[0].expectedRevision, states[0].simulation.revision);
    assert.strictEqual(staleClaims.rejected[0].actualRevision, states[0].simulation.revision + 1);
    assert.strictEqual(staleClaims.rejected[0].actualOwner, Owner.OWNER_ID);
    const staleTelemetry = Metrics.snapshot().coldOwner;
    assert.strictEqual(staleTelemetry.staleRevisionGaps['+1'], 1, 'stale claims must expose revision distance');
    assert.strictEqual(staleTelemetry.staleOwners[Owner.OWNER_ID], 1, 'stale claims must expose the current owner');

    const fenced = claimed.grants[1];
    const handoffState = LifeState.cachedState(fenced.characterId);
    const handoff = await Owner.handoffToMain(handoffState);
    assert.strictEqual(handoff.ok, true, 'activation handoff should invalidate one grant');
    const staleBefore = await wholeImage(states[1].characterId);

    const nextStates = claimed.grants.map((grant, index) => ({
        ...LifeState.cachedState(grant.characterId),
        level: 21 + index,
        exp: authoredProfiles[index].committedExp,
        sp: authoredProfiles[index].earnedSp,
        adena: 550 + index,
        timing: { ...LifeState.cachedState(grant.characterId).timing, lastResolvedAt: 3000, nextResolveAt: 6000 },
        updatedAt: 3000
    }));
    nextStates.forEach((state, index) => {
        state.inventory = { 57: { selfId: 57, name: 'Adena', amount: 550 + index, stackable: true } };
    });
    nextStates[0].inventory = {
        57: { selfId: 57, name: 'Adena', amount: 550, stackable: true }
    };
    nextStates[1].inventory = {
        57: { selfId: 57, name: 'Adena', amount: 999999, stackable: true }
    };
    const entries = claimed.grants.map((grant, index) => ({
        token: grant,
        nextState: nextStates[index],
        proposal: {
            baseState: states[index],
            durable: index < 2 ? {
                classId: index + 1,
                skills: [{ selfId: 1000 + index, name: `Batch Skill ${index}`, passive: index === 0, level: 2 },
                    { selfId: 239, name: 'Expertise', passive: true, level: 1 }]
            } : null
        }
    }));
    // The committed row handed back to the owner is the row as stored:
    // compare it with a fresh read of every column.
    const commitLeases = Database.commitAndReleaseColdSimulationLeases;
    const rawResults = [];
    Database.commitAndReleaseColdSimulationLeases = async (...args) => {
        const out = await commitLeases.apply(Database, args); rawResults.push(...out); return out; };
    const results = await Owner.commitAndReleaseBatch(entries, { timestamp: 3000 });
    Database.commitAndReleaseColdSimulationLeases = commitLeases;
    const committedRows = rawResults.filter((result) => result.ok);
    assert(committedRows.length >= 1, 'the batch must commit at least one row');
    for (const result of committedRows) {
        const [stored] = await Database.execute(['SELECT * FROM bot_life_state WHERE characterId = ?', [result.characterId]]);
        assert.deepStrictEqual({ ...result.row }, { ...stored }, `committed row ${result.characterId} equals the stored row`);
    }
    const byId = new Map(results.map((result) => [Number(result.characterId), result]));
    assert.strictEqual(byId.get(states[0].characterId).ok, true);
    assert.strictEqual(byId.get(states[1].characterId).reason, 'stale_revision', 'one stale row must not roll back valid peers');
    assert.strictEqual(byId.get(states[2].characterId).ok, true);
    assert.deepStrictEqual(await wholeImage(states[1].characterId), staleBefore,
        'the rejected member retains its exact prepared physical/cache image');
    for (const state of states) {
        assert.deepStrictEqual(clone(await Database.fetchSkills(state.characterId)).sort((a, b) => a.selfId - b.selfId), preparedSkills.get(state.characterId),
            'leased CAS ignores synthetic skills and preserves every actual paid/historical rank');
        assert.deepStrictEqual(await Database.fetchSkill(state.characterId, 1000), []);
        assert.deepStrictEqual(await Database.fetchSkill(state.characterId, 1001), []);
    }

    const rows = await Database.execute([
        `SELECT characterId, exp, sp, adena, lastResolvedAt, statsJson, simulationOwner,
                simulationRevision, simulationLeaseId, simulationLeaseUntil
         FROM bot_life_state ORDER BY characterId`, []
    ]);
    const persisted = new Map(rows.map((row) => [Number(row.characterId), row]));
    for (const index of [0, 2]) {
        const row = persisted.get(states[index].characterId);
        assert.strictEqual(Number(row.exp), authoredProfiles[index].committedExp);
        assert.strictEqual(Number(row.sp), authoredProfiles[index].earnedSp);
        assert.strictEqual(Number(row.adena), 550 + index);
        assert.strictEqual(Number(row.lastResolvedAt), 3000);
        const stats = JSON.parse(row.statsJson);
        assert.strictEqual(stats.appearanceVersion, 2,
            'batch commits must not erase a newer appearance migration version');
        assert.strictEqual(stats.sex, 1,
            'batch commits must preserve the sex paired with the newer appearance version');
        assert.strictEqual(row.simulationOwner, Owner.LEGACY_OWNER_ID);
        assert.strictEqual(row.simulationLeaseId, null);
        assert.strictEqual(Number(row.simulationLeaseUntil), 0);
    }
    const physical = await Database.execute([
        `SELECT c.id, c.classId, c.level, c.exp, c.sp, c.karma, c.pk,
                (SELECT amount FROM items WHERE characterId = c.id AND selfId = 57 LIMIT 1) AS adenaItem,
                (SELECT level FROM skills WHERE characterId = c.id AND selfId = 1000 LIMIT 1) AS skillLevel
         FROM characters c WHERE c.id IN (?, ?) ORDER BY c.id`,
        [states[0].characterId, states[1].characterId]
    ]);
    assert.deepStrictEqual(
        [Number(physical[0].classId), Number(physical[0].level), Number(physical[0].exp), Number(physical[0].sp)],
        [1, 21, authoredProfiles[0].committedExp, authoredProfiles[0].earnedSp],
        'accepted CAS must atomically persist class and physical progression'
    );
    assert.strictEqual(Number(physical[0].adenaItem), 550, 'accepted CAS must atomically persist materialized inventory');
    assert.strictEqual(physical[0].skillLevel, null, 'leased CAS must not grant an unowned synthetic worker skill');
    assert.strictEqual(Number((await Database.fetchSkill(states[0].characterId, 239))[0].level), 2,
        'a lower-level worker tree after delevel must not downgrade persisted Expertise');
    assert.deepStrictEqual(
        [Number(physical[1].classId), Number(physical[1].exp), physical[1].adenaItem],
        [0, authoredProfiles[1].initialExp, 500],
        'stale CAS must not partially mutate character or inventory rows'
    );

    assert.strictEqual(Number(physical[0].karma), 41, '1100 earned XP must wash four karma in the same commit');
    assert.strictEqual(Number(physical[0].pk), 1, 'washing karma must preserve historical PK count');
    assert.strictEqual(Number(physical[1].karma), 45, 'rejected commits must not wash karma');
    const karmaRows = () => Database.execute(['SELECT karma FROM characters ORDER BY id', []]);
    assert.deepStrictEqual((await karmaRows()).map(row => Number(row.karma)), [41, 45, 0], 'karma must stop at zero');
    const beforeReplay = await Promise.all(states.map(state => wholeImage(state.characterId)));
    const replay = await Owner.commitAndReleaseBatch(entries, { timestamp: 3100 });
    assert(replay.every((result) => !result.ok), 'an ACK-loss replay must never apply progress twice');
    assert.deepStrictEqual(await Promise.all(states.map(state => wholeImage(state.characterId))), beforeReplay,
        'ACK-loss replay preserves whole physical/cache images, including actual paid skills');
    assert.deepStrictEqual((await karmaRows()).map(row => Number(row.karma)), [41, 45, 0], 'replays must not wash karma again');
    const afterReplay = await Database.execute([
        'SELECT characterId, exp, simulationRevision FROM bot_life_state ORDER BY characterId', []
    ]);
    assert.deepStrictEqual(
        afterReplay.map((row) => [Number(row.characterId), Number(row.exp), Number(row.simulationRevision)]),
        rows.map((row) => [Number(row.characterId), Number(row.exp), Number(row.simulationRevision)]),
        'replayed proposals must preserve both data and revisions'
    );

    const partyMembers = [states[0], states[2]].map((base, index) => {
        const persistedState = LifeState.cachedState(base.characterId);
        return {
            ...persistedState,
            partyId: 'batch-party',
            party: { ...(persistedState.party || {}), partyId: 'batch-party' },
            stats: {
                ...(persistedState.stats || {}),
                ...(index === 0
                    ? { equipmentPlan: { strategy: 'craft', status: 'active' } }
                    : { warehouseWorkflow: { kind: 'release' } })
            }
        };
    });
    await Promise.all(partyMembers.map((member) => Database.execute([
        'UPDATE bot_life_state SET partyId = ?, statsJson = ? WHERE characterId = ?',
        ['batch-party', JSON.stringify(member.stats), member.characterId]
    ])));
    const partyClaim = await Owner.claimBatch(partyMembers.map((member, index) => ({
        state: member,
        leaseId: `party-batch-${index}`,
        options: { allowParty: true, allowLifecycle: true }
    })), { timestamp: 4000, leaseMs: 10000 });
    assert.strictEqual(partyClaim.grants.length, 2, 'trusted party lifecycle must claim plan and warehouse members together');
    const partyExpectedExp = partyMembers.map((member, index) => member.exp + 100 + index);
    const partyCommit = await Owner.commitAndReleaseBatch(partyClaim.grants.map((token, index) => ({
        token,
        nextState: { ...partyMembers[index], exp: partyExpectedExp[index], updatedAt: 4100 },
        options: { allowParty: true, allowLifecycle: true }
    })), { timestamp: 4100 });
    assert(partyCommit.every((result) => result.ok), 'party proposals must retain CAS and release semantics');
    const partyRows = await Database.execute([
        `SELECT exp, simulationOwner, simulationLeaseId FROM bot_life_state
         WHERE partyId = 'batch-party' ORDER BY characterId`, []
    ]);
    assert.deepStrictEqual(partyRows.map((row) => Number(row.exp)), partyExpectedExp);
    assert(partyRows.every((row) => row.simulationOwner === Owner.LEGACY_OWNER_ID && row.simulationLeaseId === null));

    const releaseBase = partyMembers.map((member) => LifeState.cachedState(member.characterId));
    const releaseClaim = await Owner.claimBatch(releaseBase.map((member, index) => ({
        state: member,
        leaseId: `party-release-${index}`,
        options: { allowParty: true, allowLifecycle: true }
    })), { timestamp: 4200, leaseMs: 10000 });
    const releaseCommit = await Owner.commitAndReleaseBatch(releaseClaim.grants.map((token, index) => ({
        token,
        nextState: {
            ...releaseBase[index],
            party: { ...(releaseBase[index].party || {}), partyId: null, leaderId: null },
            stats: { ...(releaseBase[index].stats || {}), backgroundPartyId: null, partyRequest: null },
            updatedAt: 4300
        },
        options: { allowParty: true, allowLifecycle: true }
    })), { timestamp: 4300 });
    assert(releaseCommit.every((result) => result.ok), 'party release must commit every member');
    const releasedPartyRows = await Database.execute([
        'SELECT partyId FROM bot_life_state WHERE characterId IN (?, ?) ORDER BY characterId',
        partyMembers.map((member) => member.characterId)
    ]);
    assert(releasedPartyRows.every((row) => row.partyId === null), 'party release must clear the durable party column');

    const atomicBase = [states[0], states[2]].map((base) => LifeState.cachedState(base.characterId));
    const atomicClaim = await Owner.claimBatch(atomicBase.map((member, index) => ({
        state: member,
        leaseId: `atomic-party-${index}`,
        options: { allowParty: true, allowLifecycle: true }
    })), { timestamp: 5000, leaseMs: 10000 });
    assert.strictEqual(atomicClaim.grants.length, 2, 'atomic party probe must claim every member');
    const invalidatedMember = atomicClaim.grants[1];
    const invalidation = await Owner.handoffToMain(LifeState.cachedState(invalidatedMember.characterId));
    assert.strictEqual(invalidation.ok, true, `atomic party invalidation must succeed: ${JSON.stringify(invalidation)}`);
    const atomicGroup = { id: 'atomic-party-route', memberIds: atomicBase.map((member) => member.characterId) };
    const atomicCommit = await Owner.commitAndReleaseBatch(atomicClaim.grants.map((token, index) => ({
        token,
        nextState: { ...atomicBase[index], exp: atomicBase[index].exp + 100 + index, updatedAt: 5100 },
        options: { allowParty: true, allowLifecycle: true },
        atomicGroup
    })), { timestamp: 5100 });
    assert(atomicCommit.every((result) => !result.ok), 'a stale party member must abort the complete party transition');
    assert(atomicCommit.every((result) => result.reason === 'party_group_aborted'),
        'atomic party rejection must be explicit for every member');
    const atomicRows = await Database.execute([
        'SELECT characterId, exp FROM bot_life_state WHERE characterId IN (?, ?) ORDER BY characterId',
        atomicBase.map((member) => member.characterId)
    ]);
    assert.deepStrictEqual(atomicRows.map((row) => Number(row.exp)), partyExpectedExp,
        'an aborted party transition must not persist one member without the other');

    console.log('Cold owner batch partial-stale and ACK-loss checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(async () => {
    await Database.close();
    fs.rmSync(isolated.directory, { recursive: true, force: true });
});
