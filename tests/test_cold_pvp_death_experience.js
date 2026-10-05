const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
require('../src/Global');
// U26 (user, 2026-10-05): can-I-win is a chance with one roll per decision. A fixed
// middle roll (0.49) makes each such decision the author's threshold (willing iff
// chance >= 0.5, i.e. ratio >= threshold); the chance itself is tested in test_visible_strength.
require('../src/GameServer/Bot/AI/TendencyRoll').roll = () => 0.49;
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const Death = invoke('GameServer/Progression/DeathExperience');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const Resolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const Pvp = require('../src/GameServer/Bot/Population/ColdPvpResolver');
const { seeded } = require('../src/GameServer/Bot/Population/ColdCompetitionMonitor');

// A bot killed in a cold PvP fight pays the C4 death penalty through the same
// function as an ordinary cold death, once, with a durable restore record.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l2-cold-pvp-death-exp-'));
options.default.Database.path = path.join(dir, 'test.sqlite');
const at = Date.now();
const LEVEL = 40;
const KILLER = 1, VICTIM = 2;
const personaFor = () => ({ traits: { caution: 0 } });

async function insertBot(id, { hp, pAtk, exp }) {
    const stats = { classId: 0, coldCombat: { version: 1, classId: 0, cp: 0, cpAt: at,
        base: { str: 40, dex: 30, con: 43, int: 21, wit: 11, men: 25 },
        equipment: { weaponKind: 'Weapon.Sword', pAtk, pAtkRnd: 0, mAtk: 100, atkSpd: 379, critical: 0,
            accur: 0, pDef: 200, mDef: 100, evasion: 0 },
        effects: [], skills: [] } };
    await Database.execute(['INSERT INTO accounts(username,password) VALUES (?,?)', [`bot_pvpexp_${id}`, 'test']]);
    await Database.execute([`INSERT INTO characters(id,username,name,classId,race,level,exp,hp,maxHp,mp,maxMp,sex,face,hair,hairColor,locX,locY,locZ)
        VALUES (?,?,?,0,0,?,?,?,1000,500,500,0,0,0,0,50000,15000,-5000)`, [id, `bot_pvpexp_${id}`, `PvpExp${id}`, LEVEL, exp, hp]]);
    await Database.execute([`INSERT INTO bot_life_state(characterId,accountName,characterName,phase,activity,spotId,hp,maxHp,mp,maxMp,level,exp,
        locX,locY,locZ,nextResolveAt,lastResolvedAt,updatedAt,statsJson)
        VALUES (?,?,?,'cold','hunting','test',?,1000,500,500,?,?,50000,15000,-5000,?,?,?,?)`,
    [id, `bot_pvpexp_${id}`, `PvpExp${id}`, hp, LEVEL, exp, at + 30000, at - 30000, at, JSON.stringify(stats)]]);
}

function fight(killer, victim, step = null) {
    return Pvp.resolve({ sides: [{ principal: killer, members: [killer] }, { principal: victim, members: [victim] }],
        roles: new Map(), timestamp: at, rng: seeded('pvp-death-exp'), personaFor, openingSide: 0, step });
}

async function main() {
    DataCache.init();
    Database.init();
    const levelStart = Number(DataCache.experience[LEVEL - 1]);
    const interval = Number(DataCache.experience[LEVEL]) - levelStart;
    const expectedLoss = Math.round(interval * (6.5 - 0.07 * LEVEL) / 100);
    // Just above the level 40 threshold, so the penalty drops the bot to 39.
    const victimExp = levelStart + 100;
    await insertBot(KILLER, { hp: 1000, pAtk: 5000, exp: levelStart });
    await insertBot(VICTIM, { hp: 20, pAtk: 1, exp: victimExp });
    await Life.init();
    const killer = Life.cachedState(KILLER), victim = Life.cachedState(VICTIM);

    // 1. The fight that kills the victim charges the C4 percentage of level 40.
    const result = fight(killer, victim);
    assert(result.started && result.outcome === 'killed', JSON.stringify(result.fighters));
    const dead = result.updates.get(VICTIM);
    assert.strictEqual(dead.activity, 'dead');
    assert.strictEqual(dead.exp, victimExp - expectedLoss, 'a cold PvP death costs 6.5 - 0.07 * level % of the level');
    assert.strictEqual(dead.level, LEVEL - 1, 'falling below the level threshold drops the level');
    const record = dead.stats.deathExperience;
    assert.deepStrictEqual({ before: record.expBeforeDeath, lost: record.expLost, after: record.expAfterDeath,
        pending: record.pendingRestoration }, { before: victimExp, lost: expectedLoss, after: victimExp - expectedLoss, pending: true });
    assert.strictEqual(record.deathContext.killerPlayable, true, 'the PvP context names a playable killer');
    const survivor = result.updates.get(KILLER);
    assert.strictEqual(survivor.exp, killer.exp, 'the killer loses nothing');
    assert.strictEqual(survivor.stats.deathExperience, undefined);

    // 2. The same function as an ordinary cold death: identical exp, level and record.
    const ordinary = await Life.prepareResolve(victim, { patch: { activity: 'dead', deathCount: 1 },
        materialize: { exp: 0, sp: 0, adena: 0, items: [] }, events: [], debug: { died: true } }, { persist: false, timestamp: at });
    assert.deepStrictEqual({ exp: dead.exp, level: dead.level }, { exp: ordinary.exp, level: ordinary.level });
    const withoutContext = entry => ({ ...entry, deathContext: null });
    assert.deepStrictEqual(withoutContext(record), withoutContext(ordinary.stats.deathExperience));

    // 3. The PvP context goes through the C4 exemptions: arena and PvP zone cost
    // nothing, a clan war a quarter.
    const withContext = extra => Death.applyColdDeath(victim, { ...record.deathContext, ...extra }).result.expLost;
    assert.strictEqual(withContext({ arena: true }), 0);
    assert.strictEqual(withContext({ pvpZone: true }), 0);
    assert.strictEqual(withContext({ clanWar: true }), Math.round(interval * (6.5 - 0.07 * LEVEL) / 4 / 100));

    // 4. Charged once across encounter steps: the step that kills charges, a dead
    // fighter cannot be resumed, and the next ordinary resolve does not charge again.
    const step = { until: at + 1000, expiresAt: at + 30000 };
    const stepped = fight(killer, victim, step);
    assert(stepped.started && stepped.outcome === 'killed' && !stepped.ongoing);
    const steppedDead = stepped.updates.get(VICTIM);
    assert.strictEqual(steppedDead.exp, victimExp - expectedLoss);
    assert.strictEqual(fight(stepped.updates.get(KILLER), steppedDead, { ...step, resuming: true }).started, false,
        'a dead fighter is not resumed into another step');
    assert.strictEqual(Death.applyColdDeath(steppedDead, { timestamp: at + 1 }).state.exp, steppedDead.exp,
        'a pending death record is never charged twice');

    // 5. The cold commit writes exp, level and the durable death record that a
    // resurrection restores, the same row an ordinary cold death writes.
    const claimed = await Owner.claimBatch([killer, victim], { timestamp: at, allowParty: true, allowLifecycle: true });
    assert.strictEqual(claimed.grants.length, 2);
    const commit = await Owner.commitAndReleaseBatch([killer, victim].map(state => ({
        token: claimed.grants.find(g => g.characterId === state.characterId),
        nextState: result.updates.get(state.characterId), options: { allowParty: true, allowLifecycle: true },
        proposal: { baseState: state, durable: { pvpKills: result.fighters.find(f => f.id === state.characterId).kills } }
    })), { timestamp: at + 10, journalReason: 'pvp' });
    assert(commit.every(r => r.ok), JSON.stringify(commit));
    const [character] = await Database.execute(['SELECT level, exp FROM characters WHERE id = ?', [VICTIM]]);
    assert.deepStrictEqual({ level: Number(character.level), exp: Number(character.exp) },
        { level: LEVEL - 1, exp: victimExp - expectedLoss });
    const stored = await Database.fetchCharacterDeathExperience(VICTIM);
    assert.deepStrictEqual({ before: Number(stored.expBeforeDeath), lost: Number(stored.expLost),
        pending: Number(stored.pendingRestoration), at: Number(stored.penaltyAppliedAt) },
    { before: victimExp, lost: expectedLoss, pending: 1, at });

    const committed = Life.cachedState(VICTIM);
    const recovery = Resolver.resolveDeathRecovery(committed, committed.stats.coldPvp.recoverUntil + 1);
    const respawned = await Life.prepareResolve(committed, recovery, { persist: false, timestamp: at + 200000 });
    assert.strictEqual(respawned.exp, victimExp - expectedLoss, 'the respawn does not charge the PvP death again');

    // A full resurrection gives back all lost exp and the level.
    const restored = await Database.restoreCharacterDeathExperience(VICTIM, 100, at + 20);
    assert.deepStrictEqual({ exp: restored.totalExp, level: restored.level }, { exp: victimExp, level: LEVEL });
    console.log(`Cold PvP death experience: level ${LEVEL} loses ${expectedLoss} exp (${(6.5 - 0.07 * LEVEL).toFixed(2)} %), `
        + 'arena/PvP zone exempt, clan war a quarter, level drop, charged once, durable restore record passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await Database.close(); fs.rmSync(dir, { recursive: true, force: true });
});
