const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('../src/Global');

const Database = invoke('Database');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const databasePath = path.join(process.cwd(), 'tmp', 'test-cold-owner-batches.sqlite');

fs.rmSync(databasePath, { force: true });
options.default.Database.path = path.relative(process.cwd(), databasePath);
Database.init();

function lifecycle(character, revision = 0) {
    return {
        characterId: Number(character.id),
        accountName: character.accountName,
        name: character.name,
        level: 20,
        exp: 1000,
        sp: 100,
        adena: 500,
        phase: 'cold',
        activity: 'hunting',
        loc: { locX: 10, locY: 20, locZ: -30 },
        vitals: { hp: 100, maxHp: 100, mp: 50, maxMp: 50 },
        timing: { activityStartedAt: 100, nextResolveAt: 1000, lastResolvedAt: 500, lastHotAt: null },
        party: { partyId: null },
        stats: { probe: character.name },
        inventory: {},
        simulation: { ownerId: Owner.LEGACY_OWNER_ID, revision, leaseId: null, leaseUntil: 0 },
        updatedAt: 1000
    };
}

async function createProbe(index) {
    const accountName = `batch_probe_${index}`;
    const name = `BatchProbe${index}`;
    await Database.createAccount(accountName, 'secret');
    await Database.createCharacter(accountName, {
        name, race: 0, classId: 0, maxHp: 100, maxMp: 50,
        sex: 0, face: 0, hair: 0, hairColor: 0, locX: 10, locY: 20, locZ: -30
    });
    const character = (await Database.fetchCharacters(accountName))[0];
    const state = lifecycle({ ...character, accountName, name });
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
            JSON.stringify(state.stats), '{}', state.updatedAt]
    ]);
    LifeState.acceptSimulationOwnership(state.characterId, state.simulation, state);
    return state;
}

(async () => {
    const states = await Promise.all([1, 2, 3].map(createProbe));
    const claimed = await Owner.claimBatch(states.map((state, index) => ({
        state,
        leaseId: `batch-lease-${index + 1}`
    })), { timestamp: 2000, leaseMs: 10000 });
    assert.strictEqual(claimed.grants.length, 3, 'one transaction must claim every eligible row');
    assert.strictEqual(claimed.rejected.length, 0);

    const fenced = claimed.grants[1];
    const handoffState = LifeState.cachedState(fenced.characterId);
    const handoff = await Owner.handoffToMain(handoffState);
    assert.strictEqual(handoff.ok, true, 'activation handoff should invalidate one grant');

    const nextStates = claimed.grants.map((grant, index) => ({
        ...LifeState.cachedState(grant.characterId),
        level: 21 + index,
        exp: 1100 + index,
        sp: 110 + index,
        adena: 550 + index,
        timing: { ...LifeState.cachedState(grant.characterId).timing, lastResolvedAt: 3000, nextResolveAt: 6000 },
        updatedAt: 3000
    }));
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
                skills: [{ selfId: 1000 + index, name: `Batch Skill ${index}`, passive: index === 0, level: 2 }]
            } : null
        }
    }));
    const results = await Owner.commitAndReleaseBatch(entries, { timestamp: 3000 });
    const byId = new Map(results.map((result) => [Number(result.characterId), result]));
    assert.strictEqual(byId.get(states[0].characterId).ok, true);
    assert.strictEqual(byId.get(states[1].characterId).reason, 'stale_revision', 'one stale row must not roll back valid peers');
    assert.strictEqual(byId.get(states[2].characterId).ok, true);

    const rows = await Database.execute([
        `SELECT characterId, exp, sp, adena, lastResolvedAt, simulationOwner,
                simulationRevision, simulationLeaseId, simulationLeaseUntil
         FROM bot_life_state ORDER BY characterId`, []
    ]);
    const persisted = new Map(rows.map((row) => [Number(row.characterId), row]));
    for (const index of [0, 2]) {
        const row = persisted.get(states[index].characterId);
        assert.strictEqual(Number(row.exp), 1100 + index);
        assert.strictEqual(Number(row.sp), 110 + index);
        assert.strictEqual(Number(row.adena), 550 + index);
        assert.strictEqual(Number(row.lastResolvedAt), 3000);
        assert.strictEqual(row.simulationOwner, Owner.LEGACY_OWNER_ID);
        assert.strictEqual(row.simulationLeaseId, null);
        assert.strictEqual(Number(row.simulationLeaseUntil), 0);
    }
    const physical = await Database.execute([
        `SELECT c.id, c.classId, c.level, c.exp, c.sp,
                (SELECT amount FROM items WHERE characterId = c.id AND selfId = 57 LIMIT 1) AS adenaItem,
                (SELECT level FROM skills WHERE characterId = c.id AND selfId = 1000 LIMIT 1) AS skillLevel
         FROM characters c WHERE c.id IN (?, ?) ORDER BY c.id`,
        [states[0].characterId, states[1].characterId]
    ]);
    assert.deepStrictEqual(
        [Number(physical[0].classId), Number(physical[0].level), Number(physical[0].exp), Number(physical[0].sp)],
        [1, 21, 1100, 110],
        'accepted CAS must atomically persist class and physical progression'
    );
    assert.strictEqual(Number(physical[0].adenaItem), 550, 'accepted CAS must atomically persist materialized inventory');
    assert.strictEqual(Number(physical[0].skillLevel), 2, 'accepted CAS must atomically upsert the worker-planned skill tree');
    assert.deepStrictEqual(
        [Number(physical[1].classId), Number(physical[1].exp), physical[1].adenaItem],
        [0, 0, null],
        'stale CAS must not partially mutate character or inventory rows'
    );

    const replay = await Owner.commitAndReleaseBatch(entries, { timestamp: 3100 });
    assert(replay.every((result) => !result.ok), 'an ACK-loss replay must never apply progress twice');
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
    const partyCommit = await Owner.commitAndReleaseBatch(partyClaim.grants.map((token, index) => ({
        token,
        nextState: { ...partyMembers[index], exp: 1200 + index, updatedAt: 4100 },
        options: { allowParty: true, allowLifecycle: true }
    })), { timestamp: 4100 });
    assert(partyCommit.every((result) => result.ok), 'party proposals must retain CAS and release semantics');
    const partyRows = await Database.execute([
        `SELECT exp, simulationOwner, simulationLeaseId FROM bot_life_state
         WHERE partyId = 'batch-party' ORDER BY characterId`, []
    ]);
    assert.deepStrictEqual(partyRows.map((row) => Number(row.exp)), [1200, 1201]);
    assert(partyRows.every((row) => row.simulationOwner === Owner.LEGACY_OWNER_ID && row.simulationLeaseId === null));

    console.log('Cold owner batch partial-stale and ACK-loss checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => Database.close());
