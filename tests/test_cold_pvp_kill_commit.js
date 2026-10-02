const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('../src/Global');

const Database = invoke('Database');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const Karma = invoke('GameServer/Karma');
const databasePath = path.join(process.cwd(), 'tmp', 'test-cold-pvp-kill-commit.sqlite');

fs.rmSync(databasePath, { force: true });
options.default.Database.path = path.relative(process.cwd(), databasePath);
Database.init();

// An off-screen PvP kill is recorded on the killer in its cold commit:
// pvp +1 for a PvP kill, pk +1 and PK karma otherwise; at most 18 kills.
async function createProbe(index) {
    const accountName = `pvp_probe_${index}`;
    const name = `PvpProbe${index}`;
    await Database.createAccount(accountName, 'secret');
    await Database.createCharacter(accountName, {
        name, race: 0, classId: 0, maxHp: 100, maxMp: 50,
        sex: 0, face: 0, hair: 0, hairColor: 0, locX: 10, locY: 20, locZ: -30
    });
    const character = (await Database.fetchCharacters(accountName))[0];
    await Database.execute(['UPDATE characters SET level = 20 WHERE id = ?', [character.id]]);
    const state = {
        characterId: Number(character.id), accountName, name, level: 20, exp: 1000, sp: 100, adena: 500,
        phase: 'cold', activity: 'hunting', loc: { locX: 10, locY: 20, locZ: -30 },
        vitals: { hp: 100, maxHp: 100, mp: 50, maxMp: 50 },
        timing: { activityStartedAt: 100, nextResolveAt: 1000, lastResolvedAt: 500, lastHotAt: null },
        party: { partyId: null }, stats: {}, inventory: {},
        simulation: { ownerId: Owner.LEGACY_OWNER_ID, revision: 0, leaseId: null, leaseUntil: 0 },
        updatedAt: 1000
    };
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

async function commitKills(state, pvpKills, timestamp) {
    const claimed = await Owner.claimBatch([{ state, leaseId: `pvp-lease-${state.characterId}-${timestamp}` }],
        { timestamp, leaseMs: 10000 });
    assert.strictEqual(claimed.grants.length, 1);
    const current = LifeState.cachedState(state.characterId);
    const [result] = await Owner.commitAndReleaseBatch([{
        token: claimed.grants[0],
        nextState: { ...current, timing: { ...current.timing, lastResolvedAt: timestamp + 500 }, updatedAt: timestamp + 500 },
        proposal: { baseState: current, durable: { pvpKills } }
    }], { timestamp: timestamp + 500 });
    return result;
}

const counters = async (id) => {
    const [row] = await Database.execute(['SELECT pvp, pk, karma FROM characters WHERE id = ?', [id]]);
    return { pvp: Number(row.pvp), pk: Number(row.pk), karma: Number(row.karma) };
};

(async () => {
    const [killer, victim, other] = await Promise.all([1, 2, 3].map(createProbe));
    const before = await counters(killer.characterId);
    const committed = await commitKills(killer, [
        { victimId: victim.characterId, victimLevel: 20, pvp: true },
        { victimId: other.characterId, victimLevel: 20, pvp: false }
    ], 2000);
    assert.strictEqual(committed.ok, true, committed.reason);
    const expectedKarma = before.karma + Karma.pkKillKarma({ fetchPk: () => before.pk, fetchLevel: () => 20 },
        { fetchLevel: () => 20 });
    assert.deepStrictEqual(await counters(killer.characterId),
        { pvp: before.pvp + 1, pk: before.pk + 1, karma: expectedKarma },
        'a PvP kill counts as pvp; a kill of a non-flagged bot counts as pk with PK karma');
    assert(expectedKarma > before.karma, 'a PK kill must add karma');
    const [lifeRow] = await Database.execute(['SELECT statsJson FROM bot_life_state WHERE characterId = ?', [killer.characterId]]);
    assert.strictEqual(JSON.parse(lifeRow.statsJson).karma, expectedKarma, 'cold state sees the same karma');
    assert.deepStrictEqual(await counters(victim.characterId), await counters(other.characterId),
        'the victims\' counters do not change');

    const tooMany = Array.from({ length: 19 }, () => ({ victimId: victim.characterId, victimLevel: 20, pvp: true }));
    await assert.rejects(commitKills(LifeState.cachedState(killer.characterId), tooMany, 4000),
        /too many kills/, 'more than 18 kills in one commit fails the batch');
    assert.deepStrictEqual(await counters(killer.characterId),
        { pvp: before.pvp + 1, pk: before.pk + 1, karma: expectedKarma }, 'a failed batch records nothing');
    console.log('test_cold_pvp_kill_commit passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => Database.close());
