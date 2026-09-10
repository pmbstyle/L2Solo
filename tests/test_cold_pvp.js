const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
require('../src/Global');
const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Memory = invoke('GameServer/Social/InteractionMemoryRuntime');
const Repository = invoke('GameServer/Social/InteractionMemoryRepository');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Pvp = require('../src/GameServer/Bot/Population/ColdPvpResolver');
const { seeded } = require('../src/GameServer/Bot/Population/ColdCompetitionMonitor');
const { ColdCompetitionActions } = require('../src/GameServer/Bot/Population/ColdCompetitionActions');
const Conflict = require('../src/GameServer/Bot/Population/ColdPartyConflict');
const Wait = require('../src/GameServer/Bot/Population/ColdCompetitionWait');
const Resolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const PartyResolver = invoke('GameServer/Bot/Population/BackgroundPartyResolver');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l2-cold-pvp-'));
options.default.Database.path = path.join(dir, 'test.sqlite');
const at = Date.now();
const ids = Array.from({ length: 38 }, (_, i) => i + 1);
const traits = { empathy: 0, assertiveness: 1, commitment: 1, sociability: 1, caution: 0 };
const personaFor = () => ({ traits });
const state = id => Life.cachedState(id);
const base = { life: Life, owner: Owner, parties: Parties, memory: Memory, now: () => at,
    participantAllowed: () => true, contestContextAllowed: () => true, onState() {},
    pvpEnabled: () => true, conflictsEnabled: () => true, personaFor,
    waitMs: 15000, cooldownMs: 600000, rng: () => 0.2 };
function event(a, b, key = `cold-pvp:${a}:${b}`) {
    const participant = id => {
        const p = Parties.find(state(id).party?.partyId);
        return { id, revision: state(id).simulation.revision, memoryRevision: Memory.snapshot(id).revision,
            partyId: p?.partyId, partyUpdatedAt: p?.updatedAt, size: p?.memberIds.length || 1 };
    };
    return { key, at, pressure: 3, spotId: 'test', npcId: 10, action: 'contest', pvpIntent: true,
        actor: participant(a), peer: participant(b) };
}
async function party(members) {
    const prepared = Parties.prepareCommit({ partyId: `pvp-party-${members[0]}`, leaderId: members[0], memberIds: members,
        spotId: 'test', status: 'active', startedAt: at, nextResolveAt: at + 45000, stats: { objective: { npcId: 10 } } });
    const assigned = members.map(id => Life.preparePartyAssignment(state(id), prepared.row.partyId, 'dps', members[0], at + 45000));
    assert((await Database.commitBackgroundPartyMembership({ party: prepared.row, members: assigned })).ok);
    Life.acceptPartyAssignments(assigned);
    return Parties.acceptCommit(prepared);
}
async function main() {
    invoke('GameServer/DataCache').init();
    Database.init();
    for (const id of ids) {
        const stats = { classId: 0, equipmentPlan: { status: 'active', next: { npcId: 10, spotId: 'test' } },
            coldCombat: { version: 1, classId: 0, cp: id % 3 === 1 ? 0 : 500, cpAt: at,
                base: { str: 40, dex: 30, con: 43, int: 21, wit: 11, men: 25 },
                equipment: { weaponKind: 'Weapon.Sword', pAtk: id % 3 === 0 ? 5000 : 300, pAtkRnd: 0,
                    mAtk: 100, atkSpd: 379, critical: 0, accur: 0, pDef: 200, mDef: 100, evasion: 0 },
                effects: [{ key: 'test_buff', id: 1040, level: 1, type: 'buff', expiresAt: at + 60000, stats: {} }],
                skills: [{ selfId: 1, level: 1, passive: true }] } };
        const hp = id % 3 === 1 ? 20 : 1000;
        await Database.execute(['INSERT INTO accounts(username,password) VALUES (?,?)', [`bot_pvp_${id}`, 'test']]);
        await Database.execute([`INSERT INTO characters(id,username,name,classId,race,level,hp,maxHp,mp,maxMp,sex,face,hair,hairColor,locX,locY,locZ)
            VALUES (?,?,?,0,0,40,?,1000,500,500,0,0,0,0,50000,15000,-5000)`, [id, `bot_pvp_${id}`, `Pvp${id}`, hp]]);
        await Database.execute([`INSERT INTO bot_life_state(characterId,accountName,characterName,phase,activity,spotId,hp,maxHp,mp,maxMp,level,
            locX,locY,locZ,nextResolveAt,lastResolvedAt,updatedAt,statsJson)
            VALUES (?,?,?,'cold','hunting','test',?,1000,500,500,40,50000,15000,-5000,?,?,?,?)`,
        [id, `bot_pvp_${id}`, `Pvp${id}`, hp, at + 30000, at - 30000, at, JSON.stringify(stats)]]);
    }
    await Life.init(); await Parties.init(); await Memory.ensureMany(ids);
    // Live profiles, fixed randomness, same result after serialization, no input mutation.
    const left = state(2), right = { ...state(5), stats: { ...state(5).stats, coldCombat: {
        ...state(5).stats.coldCombat, skills: [{ selfId: 1177, level: 5, spell: true, passive: false, power: 50, mp: 20, hitTime: 1000, reuse: 1000 }] } } };
    const sides = [{ principal: left, members: [left] }, { principal: right, members: [right] }];
    const original = JSON.stringify(sides);
    const run = input => Pvp.resolve({ sides: input, roles: new Map(), timestamp: at, rng: seeded('duel'), personaFor });
    const duel = run(sides);
    assert(duel.started);
    assert.deepStrictEqual(run(JSON.parse(original)), duel);
    assert.strictEqual(JSON.stringify(sides), original);
    assert(duel.actions <= Pvp.MAX_ACTIONS && duel.durationMs <= Pvp.MAX_DURATION_MS);
    assert(duel.fighters.some(f => f.cp < Profile.profileFor(f.id === left.characterId ? left : right, at).cp));
    assert(duel.fighters.find(f => f.id === right.characterId).mp < right.vitals.mp, 'magic spends real MP');
    const protectedSides = sides.map(side => ({ ...side, members: side.members.map(s => ({ ...s, stats: { ...s.stats, clanId: 9 } })) }));
    assert.strictEqual(run(protectedSides).reason, 'pvp_protected_context');
    const peace = sides.map(side => ({ ...side, members: side.members.map(s => ({ ...s, loc: { locX: 83400, locY: 148600, locZ: -3400 } })) }));
    assert.strictEqual(run(peace).reason, 'pvp_protected_context');
    const fullSides = [0, 1].map(side => {
        const members = Array.from({ length: 9 }, (_, index) => ({ ...left, characterId: 100 + side * 9 + index,
            stats: { ...left.stats, coldCombat: { ...left.stats.coldCombat,
                equipment: { ...left.stats.coldCombat.equipment, pAtk: 1, pDef: 100000, mDef: 100000 } } } }));
        return { principal: members[0], members };
    });
    const fullRoles = new Map(fullSides.flatMap(s => s.members.map(m => [m.characterId, 'support'])));
    const measuredAt = performance.now();
    const fullFight = Pvp.resolve({ sides: fullSides, roles: fullRoles, timestamp: at, rng: seeded('9v9'), personaFor });
    const computeMs = performance.now() - measuredAt;
    assert(fullFight.started && fullFight.fighters.length === 18);
    assert(fullFight.actions <= Pvp.MAX_ACTIONS && fullFight.durationMs <= Pvp.MAX_DURATION_MS);
    assert(fullFight.incidents.length <= 18, 'actual attribution stays linear in roster size');
    const healer = { ...right, stats: { ...right.stats, coldCombat: { ...right.stats.coldCombat,
        skills: [{ selfId: 1011, level: 1, spell: true, passive: false, power: 100, mp: 12, hitTime: 1500, reuse: 1000 }] } } };
    const injured = { ...right, characterId: 90, vitals: { ...right.vitals, hp: 350 } };
    const healedFight = Pvp.resolve({ sides: [sides[0], { principal: healer, members: [healer, injured] }],
        roles: new Map([[90, 'support']]), timestamp: at, rng: seeded('heal'), personaFor });
    assert(healedFight.started && healedFight.fighters.some(f => f.heals > 0), 'learned healing participates in the skirmish');
    assert(healedFight.fighters.find(f => f.id === healer.characterId).mp < healer.vitals.mp);
    const recentVictim = { ...injured, stats: { ...injured.stats, coldPvp: { lastVictimId: left.characterId, lastVictimAt: at } } };
    const waitingVictim = { ...left, stats: { ...left.stats, coldPvp: { readyAt: at + 1000 } } };
    const aidSides = [{ principal: waitingVictim, members: [waitingVictim] }, { principal: healer, members: [healer, recentVictim] }];
    const healOnly = input => Pvp.resolve({ sides: input, roles: new Map([[90, 'support']]), timestamp: at, rng: seeded('aid'), personaFor,
        step: { resuming: true, until: at + 1, expiresAt: at + 30000, maxActions: 1 } });
    const aid = healOnly(aidSides);
    assert.deepStrictEqual(aid.opponentAid, [{ sourceId: left.characterId, targetId: healer.characterId, type: 'aided_opponent' }]);
    assert.deepStrictEqual(healOnly(JSON.parse(JSON.stringify(aidSides))).opponentAid, aid.opponentAid);
    recentVictim.stats.coldPvp.lastVictimAt = at - 15000;
    assert.deepStrictEqual(healOnly(aidSides).opponentAid, [], 'stale damage cannot blame a cold healer');
    const noIntent = await Conflict.apply({ ...base, event: { ...event(25, 27), pvpIntent: false } });
    assert(noIntent.ok && !noIntent.pvp, 'resource disputes do not all become fights');

    // A real accepted solo-vs-party episode commits health, death, PK and memory together.
    await party([1, 2]);
    const firstEvent = event(1, 3);
    const first = await new ColdCompetitionActions(base).apply(firstEvent);
    assert(first.ok && first.pvp, JSON.stringify(first));
    assert.strictEqual(first.outcome, 'pvp_killed');
    assert.strictEqual(state(1).activity, 'dead');
    assert.strictEqual(state(1).vitals.hp, 0);
    assert.deepStrictEqual(state(1).stats.coldCombat.effects, []);
    assert.strictEqual(state(1).stats.deaths, 1);
    assert(state(1).stats.pvpEnemies.some(e => e.id === 3 && e.kills === 1));
    const killer = (await Database.execute(['SELECT pvp,pk,karma,exp FROM characters WHERE id=3', []]))[0];
    assert.deepStrictEqual({ ...killer }, { pvp: 0, pk: 1, karma: 240, exp: 0 }, 'white target killed before replying is PK');
    assert.strictEqual(state(3).stats.karma, 240, 'worker snapshot receives authoritative karma');
    const relation = Memory.inspect(1).relations.find(r => r.targetId === 3);
    assert(relation.reasons.some(r => r.type === 'attacked') && relation.reasons.some(r => r.type === 'killed'));
    assert.strictEqual((await new ColdCompetitionActions(base).apply(firstEvent)).ok, false, 'replay cannot kill or award karma twice');
    assert.strictEqual((await Database.execute(['SELECT pk FROM characters WHERE id=3', []]))[0].pk, 1);
    const wait = state(1).stats.coldCompetition.wait;
    assert(Wait.consume(state(1), 30000, at + 100).waiting);
    assert(Wait.consumeParty(Parties.find(state(1).party.partyId), [state(1), state(2)], 30000, at + 100).waiting,
        'resting party members cannot bypass the combat interval');
    const recovery = PartyResolver.resolve({ party: Parties.find(state(1).party.partyId), members: [state(1), state(2)],
        spot: { id: 'test' }, timestamp: wait.until + 1 });
    assert.strictEqual(recovery.debug.fights, 0);
    assert(recovery.memberResults.every(r => r.result.materialize.exp === 0));
    assert.strictEqual(recovery.memberResults[0].result.patch.vitals, undefined, 'dead member remains dead until recovery');
    const revived = Resolver.resolveDeathRecovery(state(1), state(1).stats.coldPvp.recoverUntil);
    assert(revived.patch.vitals.hp > 0 && revived.patch.stats.coldPvp.recoverUntil === 0);

    // A flagged target awards PvP, not karma, through the same SQL transaction.
    const flagged = { ...state(4), stats: { ...state(4).stats, coldPvp: { flagUntil: at + 10000 } } };
    await Life.upsertState(flagged, 'test_flag');
    const mutual = await Conflict.apply({ ...base, event: event(4, 6) });
    assert(mutual.ok && mutual.pvp, JSON.stringify(mutual));
    const pvpKiller = (await Database.execute(['SELECT pvp,pk,karma FROM characters WHERE id=6', []]))[0];
    assert.deepStrictEqual({ ...pvpKiller }, { pvp: 1, pk: 0, karma: 0 });

    await party([7, 8]);
    const rejected = await Conflict.apply({ ...base, event: event(7, 9), owner: { ...Owner,
        commitAndReleaseBatch: async (entries, options) => {
            await Database.execute(['UPDATE bot_background_parties SET updatedAt=updatedAt+1 WHERE partyId=?', ['pvp-party-7']]);
            return Owner.commitAndReleaseBatch(entries, options);
        } } });
    assert.strictEqual(rejected.ok, false);
    assert.strictEqual((await Database.execute(['SELECT hp FROM characters WHERE id=7', []]))[0].hp, 20);
    assert.strictEqual((await Database.execute(['SELECT pk FROM characters WHERE id=9', []]))[0].pk, 0);
    assert.strictEqual((await Repository.load(7)).relations.length, 0);
    assert.strictEqual((await Conflict.apply({ ...base, event: event(10, 12), participantAllowed: id => id !== 12 })).ok, false);
    const partial = await Conflict.apply({ ...base, event: event(10, 12), owner: { ...Owner,
        claimBatch: (states, options) => Owner.claimBatch(states.slice(0, 1), options) } });
    assert.strictEqual(partial.ok, false);
    assert(!state(10).simulation.leaseId, 'partial ownership is released');
    await assert.rejects(Conflict.apply({ ...base, event: event(13, 15), owner: { ...Owner,
        commitAndReleaseBatch: (entries, options) => {
            entries.find(e => e.proposal.result.memoryEvents.length).proposal.result.memoryEvents[0].key = '';
            return Owner.commitAndReleaseBatch(entries, options);
        } } }), /memory/i);
    assert.strictEqual((await Database.execute(['SELECT hp FROM characters WHERE id=13', []]))[0].hp, 20);
    assert.strictEqual((await Database.execute(['SELECT pk FROM characters WHERE id=15', []]))[0].pk, 0);
    const contextRace = await Conflict.apply({ ...base, event: event(16, 18), owner: { ...Owner,
        commitAndReleaseBatch: async (entries, options) => {
            await Database.execute(['UPDATE characters SET karma=7 WHERE id=18', []]);
            return Owner.commitAndReleaseBatch(entries, options);
        } } });
    assert.strictEqual(contextRace.ok, false, 'political/karma context is checked against character rows at commit');
    assert.strictEqual((await Database.execute(['SELECT hp FROM characters WHERE id=16', []]))[0].hp, 20);
    assert.strictEqual((await Repository.load(16)).relations.length, 0);

    // Independent revenge uses current social memory and a real physical fight,
    // even when neither principal is pursuing the same monster.
    async function grievance(a, b) {
        return Memory.recordBatch(['attacked', 'killed', 'killed'].map((type, i) => ({
            key: `grievance:${a}:${b}:${i}`, sourceId: a, targetId: b, type, at })));
    }
    const revengeEvent = (a, b) => ({ ...event(a, b, `revenge-test:${a}:${b}`),
        action: 'revenge', revengeRoll: 0, pressure: 0, npcId: 0 });
    await grievance(21, 22);
    await party([20, 21]); await party([22, 23]);
    const revenge = await new ColdCompetitionActions(base).apply(revengeEvent(21, 22));
    assert(revenge.ok && revenge.pvp, JSON.stringify(revenge));
    assert.strictEqual(state(22).activity, 'dead', 'the avenger opens the fight, not its unsuspecting target');
    assert.strictEqual(state(21).stats.coldCompetition.action, 'revenge');
    assert.strictEqual(state(21).stats.revengeUntil, at + 600000);
    assert(!(await Repository.load(22)).relations.some(r => r.reasons.some(reason => reason.type === 'mob_contested')),
        'a revenge fight must not fabricate stolen monsters');
    assert.strictEqual((await Database.execute(['SELECT pk FROM characters WHERE id=21', []]))[0].pk, 1,
        'revenge against a white character still incurs normal PK consequences');
    assert.strictEqual((await new ColdCompetitionActions(base).apply(revengeEvent(21, 22))).ok, false);

    await grievance(29, 32);
    const refused = await new ColdCompetitionActions({ ...base, pvpEnabled: () => false }).apply(revengeEvent(29, 32));
    assert.strictEqual(refused.reason, 'forecast_only');
    const beforeClaim = await Repository.load(32);
    const staleRelation = await Conflict.apply({ ...base, event: revengeEvent(29, 32), owner: { ...Owner,
        claimBatch: async (...args) => {
            const claimed = await Owner.claimBatch(...args);
            await Memory.recordBatch([{ key: 'reconciled-during-claim', sourceId: 29, targetId: 32, type: 'resurrected', at }]);
            return claimed;
        } } });
    assert.strictEqual(staleRelation.reason, 'contest_changed_during_claim');
    assert.deepStrictEqual(await Repository.load(32), beforeClaim, 'rejected intent must not create attacks');
    assert(!state(29).simulation.leaseId);
    const initial = await Conflict.apply({ ...base, event: revengeEvent(29, 32), incrementalPvp: true });
    assert(initial.ok && initial.encounter?.reason === 'revenge', JSON.stringify(initial));
    assert(state(29).stats.coldPvp.flagUntil > at, 'the initiating avenger carries a flag into hot activation');
    const continued = await Conflict.apply({ ...base, now: () => at + 1000,
        event: { ...revengeEvent(29, 32), at: at + 1000 }, resume: JSON.parse(JSON.stringify(initial.encounter)), incrementalPvp: true });
    assert(continued.ok, JSON.stringify(continued));
    assert(continued.encounter?.reason === 'revenge' || !continued.encounter);

    // A real accepted cold heal commits the grievance with its HP/MP outcome.
    await party([35, 36]);
    for (const id of [35, 36]) {
        const s = state(id);
        await Life.upsertState({ ...s, vitals: { ...s.vitals, hp: id === 36 ? 350 : 1000 },
            stats: { ...s.stats, coldPvp: { lastVictimId: id === 36 ? 38 : 0, lastVictimAt: at },
                coldCombat: { ...s.stats.coldCombat, equipment: { ...s.stats.coldCombat.equipment, pAtk: 300 },
                    ...(id === 35 ? { skills: healer.stats.coldCombat.skills } : {}) } } }, 'test_aid');
    }
    const beforeAid = await Repository.load(38), beforeHelper = state(35).vitals.mp;
    await assert.rejects(Conflict.apply({ ...base, event: event(38, 35), owner: { ...Owner,
        commitAndReleaseBatch: (entries, options) => {
            const aid = entries.flatMap(e => e.proposal.result.memoryEvents).find(e => e.type === 'aided_opponent');
            assert(aid, 'the rejected proposal contained a real aid event');
            aid.key = '';
            return Owner.commitAndReleaseBatch(entries, options);
        } } }), /memory/i);
    assert.deepStrictEqual(await Repository.load(38), beforeAid, 'a rejected fight cannot leave an aid grievance');
    assert.strictEqual(state(35).vitals.mp, beforeHelper);
    const aidedFight = await Conflict.apply({ ...base, event: event(38, 35) });
    assert(aidedFight.ok && aidedFight.pvp, JSON.stringify(aidedFight));
    const aidMemory = await Repository.load(38);
    assert(aidMemory.recent.some(e => e.type === 'aided_opponent' && e.targetId === 35), JSON.stringify(aidMemory));
    assert(state(35).vitals.mp < 500, 'the cold helper really spent MP');
    const savedMemory = await Repository.load(1);
    await Database.close(); Database.init();
    assert.deepStrictEqual(await Repository.load(1), savedMemory);
    assert.deepStrictEqual(await Repository.load(38), aidMemory, 'cold aid consequences survive SQLite reopen');
    assert.strictEqual((await Database.execute(['SELECT hp FROM characters WHERE id=1', []]))[0].hp, 0);
    assert.strictEqual((await Database.execute(['SELECT pk,karma FROM characters WHERE id=3', []]))[0].karma, 240);
    assert.strictEqual(JSON.parse((await Database.execute(['SELECT statsJson FROM bot_life_state WHERE characterId=21', []]))[0].statsJson).revengeUntil,
        at + 600000, 'revenge cooldown survives SQLite reopen');
    console.log('Cold PvP: deterministic bounded combat, CP/MP, PK/PvP, death/recovery, atomic rollback, replay and SQLite reopen passed');
    console.log(`Cold PvP 9v9: ${fullFight.actions} actions, ${computeMs.toFixed(2)} ms calculation`);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await Database.close(); fs.rmSync(dir, { recursive: true, force: true });
});
