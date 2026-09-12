const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
require('../src/Global');
const DB = invoke('Database'), Life = invoke('GameServer/Bot/Population/BotLifeState');
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const Memory = invoke('GameServer/Social/InteractionMemoryRuntime');
const Runtime = require('../src/GameServer/Bot/Population/PvpEncounterRuntime');
const Lifecycle = require('../src/GameServer/Bot/Population/PvpEncounterLifecycle');
const Conflict = require('../src/GameServer/Bot/Population/ColdPartyConflict');
const Manager = invoke('GameServer/Bot/BotManager'), World = invoke('GameServer/World/World');
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const Flag = invoke('GameServer/Actor/PvpFlag'), Response = invoke('GameServer/Network/Response');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l2-pvp-handoff-'));
options.default.Database.path = path.join(dir, 'test.sqlite');
const saved = [], allSessions = [];
const revengeMode = process.argv.includes('--revenge');
const extensionMode = process.argv.includes('--extension');
const Budget = require('../src/GameServer/Bot/Population/PvpEncounterBudget');
const telemetry = new (require('../src/GameServer/Bot/Population/ColdCompetitionActions').ColdCompetitionActions)({});
const patch = (o, k, v) => { const old = o[k]; saved.push(() => { o[k] = old; }); o[k] = v; };
let clock = Date.now(), failSpawn = 0, spawned = 0, expectedCount = 0;
const state = id => Life.cachedState(id);
const base = { life: Life, owner: Owner, memory: Memory, parties: Parties, now: () => clock,
    personaFor: () => ({ traits: { empathy: 0, caution: 0, assertiveness: 1, commitment: 1, sociability: 1 } }),
    participantAllowed: () => true, contestContextAllowed: () => true, onState() {},
    pvpEnabled: () => true, incrementalPvp: true, onEncounter: Runtime.register, waitMs: 15000, cooldownMs: 600000, rng: () => 0.5 };
function event(a, b, key = `handoff:${a}:${b}`) {
    const p = id => { const s = state(id), party = Parties.find(s.party?.partyId); return { id,
        partyId: party?.partyId || null, partyUpdatedAt: party?.updatedAt, size: party?.memberIds.length || 1,
        revision: s.simulation.revision, memoryRevision: Memory.snapshot(id).revision }; };
    return { key, at: clock, pressure: 3, spotId: 'test', npcId: 10, actor: p(a), peer: p(b), action: 'contest', pvpIntent: true };
}
async function party(ids) {
    const p = Parties.prepareCommit({ partyId: `enc-party-${ids[0]}`, leaderId: ids[0], memberIds: ids,
        status: 'active', spotId: 'test', startedAt: clock, nextResolveAt: clock + 1000, stats: { objective: { npcId: 10 } } });
    const members = ids.map(id => Life.preparePartyAssignment(state(id), p.row.partyId, 'dps', ids[0], clock + 1000));
    assert((await DB.commitBackgroundPartyMembership({ party: p.row, members })).ok);
    Life.acceptPartyAssignments(members); Parties.acceptCommit(p);
}
async function main() {
    patch(Date, 'now', () => clock);
    invoke('GameServer/DataCache').init(); DB.init();
    for (let id = 1; id <= 12; id++) {
        const stats = { classId: 0, equipmentPlan: { status: 'active', next: { npcId: 10, spotId: 'test' } },
            coldCombat: { version: 1, classId: 0, cp: 2000, cpAt: clock,
                base: { str: 40, dex: 30, con: 43, int: 21, wit: 11, men: 25 },
                equipment: { weaponKind: 'Weapon.Sword', pAtk: 20, pAtkRnd: 0, mAtk: 10, atkSpd: 379,
                    critical: 0, accur: 50, pDef: extensionMode ? 100000 : 400,
                    mDef: extensionMode ? 100000 : 400, evasion: 0 }, effects: [], skills: [] } };
        await DB.execute(['INSERT INTO accounts(username,password) VALUES (?,?)', [`bot_enc_${id}`, 'test']]);
        await DB.execute([`INSERT INTO characters(id,username,name,classId,race,level,hp,maxHp,mp,maxMp,cp,sex,face,hair,hairColor,locX,locY,locZ)
            VALUES (?,?,?,0,0,40,1000,2000,300,1000,2000,0,0,0,0,0,0,0)`, [id, `bot_enc_${id}`, `Encounter${id}`]]);
        await DB.execute([`INSERT INTO bot_life_state(characterId,accountName,characterName,phase,activity,spotId,hp,maxHp,mp,maxMp,level,lastResolvedAt,updatedAt,statsJson)
            VALUES (?,?,?,'cold','hunting','test',1000,2000,300,1000,40,?,?,?)`, [id, `bot_enc_${id}`, `Encounter${id}`, clock - 30000, clock, JSON.stringify(stats)]]);
    }
    await Life.init(); await Parties.init(); await Memory.ensureMany([1,2,3,4,5,6,7,8,9,10,11,12]);
    patch(World, 'user', { sessions: [] }); patch(Manager, 'sessions', []);
    patch(World, 'insertUser', s => { World.user.sessions.push(s); });
    patch(World, 'removeUser', s => { World.user.sessions = World.user.sessions.filter(x => x !== s); });
    patch(World, 'fetchVisibleRealPlayers', () => []);
    patch(Coordinator, 'fenceBot', async () => ({ ok: true })); patch(Coordinator, 'notifyState', () => {});
    patch(invoke('GameServer/Bot/Population/ActivationPlacement'), 'resolve', s => ({ loc: s.loc, spot: { id: 'test' } }));
    patch(invoke('GameServer/Bot/AI/PartyAwareness'), 'npcThreateningActor', () => null);
    patch(invoke('GameServer/Bot/AI/BotPvpThreats'), 'context', () => ({ threats: [] }));
    patch(invoke('GameServer/Bot/AI/BotPvpTactics'), 'stop', () => {});
    patch(invoke('GameServer/Bot/BotAI'), 'stop', s => { s.aiActive = false; });
    patch(invoke('GameServer/Bot/BotAI'), 'init', s => {
        assert.strictEqual(World.user.sessions.length, expectedCount, 'publish the complete conflict before any AI tick');
        s.aiActive = true;
    });
    patch(Response, 'charInfo', a => ({ kind: 'charInfo', id: a.fetchId(), flag: a.fetchPvpFlag() }));
    patch(Response, 'relationChanged', () => ({})); patch(Response, 'userInfo', () => ({}));
    patch(Life, 'partySessionSnapshot', (s, old, phase) => ({ ...old, phase, loc: { ...old.loc },
        vitals: { ...old.vitals, hp: s.actor.hp, mp: s.actor.mp }, stats: { ...old.stats,
            coldPvp: { ...old.stats.coldPvp, flagUntil: s.pvpFlagUntil || 0 },
            coldCombat: { ...old.stats.coldCombat, cp: s.actor.cp, cpAt: clock, cooldowns: Object.fromEntries(s.actor.skillReuseUntil) } } }));
    patch(Manager, 'loadAndSpawnBot', async (_account, data) => {
        assert(data.prepareOnly && data.spawnReady === false && data.readyOnActivation === false);
        assert.strictEqual(World.user.sessions.length, 0);
        if (++spawned === failSpawn) throw Error('test_spawn_failure');
        const old = data.coldLifeState;
        const a = { hp: old.vitals.hp, mp: old.vitals.mp, cp: old.stats.coldCombat.cp, flag: 0,
            skillReuseUntil: new Map(Object.entries(old.stats.coldCombat.cooldowns || {}).map(([k,v]) => [Number(k),v])),
            fetchId: () => old.characterId, fetchName: () => old.name, fetchKarma: () => 0,
            fetchLocX: () => data.locX, fetchLocY: () => data.locY, fetchLocZ: () => data.locZ,
            fetchPvpFlag() { return this.flag; }, setPvpFlag(v) { this.flag = v; },
            state: { fetchDead: () => false, fetchHits: () => false, fetchCasts: () => false },
            automation: { replenishVitals() {}, stopReplenish() {} }, destructor() { clearTimeout(s.pvpFlagTimer); } };
        const s = { actor: a, accountId: old.accountName, coldLifeState: old, populationStaging: true, plan: 'hunting',
            pvpActionReadyAt: old.stats.coldPvp.readyAt, packets: [], dataSendToMe() {},
            dataSendToOthers(packet) { if (!this.populationStaging) this.packets.push(packet); } };
        a.session = s; allSessions.push(s);
        Flag.restore(s, a, old.stats.coldPvp.flagUntil);
        return s;
    });
    await party([1, 2]); await party([3, 4]); expectedCount = 4;
    if (revengeMode) await Memory.recordBatch(['attacked', 'killed', 'killed'].map((type, i) => ({
        key: `revenge-handoff:${i}`, sourceId: 1, targetId: 3, type, at: clock })));
    const started = await Conflict.apply({ ...base, event: { ...event(1, 3),
        ...(revengeMode ? { action: 'revenge', revengeRoll: 0, npcId: 0, pressure: 0 } : {}) } });
    assert(started.ok && started.encounter && started.pvp, JSON.stringify(started));
    let e = started.encounter;
    assert.strictEqual(state(revengeMode ? 3 : 1).stats.coldPvp.flagUntil, 0, 'receiving an attack does not flag the victim');
    assert(state(revengeMode ? 1 : 3).stats.coldPvp.flagUntil > clock, 'the initiator flags on the first accepted hostile action');
    clock += 1000;
    const secondStep = await Conflict.apply({ ...base, event: event(1, 3, e.key), resume: e });
    assert(secondStep.encounter); e = secondStep.encounter;
    if (extensionMode) {
        const deadline = e.expiresAt;
        while (clock < e.startedAt + 26000) {
            clock += 1000;
            const step = await Conflict.apply({ ...base, event: event(1, 3, e.key), resume: e });
            assert(step.ok && step.encounter, JSON.stringify(step));
            telemetry.recordPvpStep(step);
            e = step.encounter;
        }
        assert.strictEqual(e.expiresAt, deadline + 15000, 'real ongoing attacks extend the persisted encounter');
        assert.strictEqual(e.extensions, 1);
        assert([1,2,3,4].every(id => state(id).stats.pvpEncounter.expiresAt === e.expiresAt));
    }
    const initialMemory = JSON.stringify([1,2,3,4].map(n => Memory.snapshot(n)));
    const flagUntil = state(1).stats.coldPvp.flagUntil;
    const beforeCp = state(1).stats.coldCombat.cp;
    const hot = await Lifecycle.activate(e);
    assert(hot.ok, JSON.stringify(hot));
    assert(Manager.sessions.every(s => s.pvpEncounter.expiresAt === e.expiresAt
        && s.pvpRevenge.expiresAt === e.expiresAt), 'hot combat inherits the current encounter deadline');
    assert(Manager.sessions.every(s => s.pvpRevenge?.target && s.actor.cp === state(s.actor.fetchId()).stats.coldCombat.cp));
    assert(Manager.sessions.every(s => s.packets.find(p => p.kind === 'charInfo')?.flag === 1), 'first published nick is flagged');
    assert.strictEqual(Manager.sessions[0].pvpFlagUntil, flagUntil);
    assert.strictEqual(Manager.sessions[0].actor.cp, beforeCp, 'no full CP refill');
    assert.strictEqual(JSON.stringify([1,2,3,4].map(n => Memory.snapshot(n))), initialMemory, 'activation creates no incidents');
    if (process.argv.includes('--expire-cooldown')) {
        clock = e.expiresAt + 1000;
        const expired = await Lifecycle.cooldown(e, 'expired-test', { ignoreVisibility: true });
        assert(expired.ok && !expired.encounter, JSON.stringify(expired));
        const completions = [];
        await Runtime.tick({ ...base, canRun: () => true, recordPvpStep: r => completions.push(r) });
        assert.strictEqual(completions.length, 1, 'expiry during hot-to-cold handoff is counted');
        assert([1,2,3,4].every(id => !state(id).stats.pvpEncounter && state(id).stats.coldCompetition.outcome === 'pvp_expired'));
        assert.strictEqual(Parties.find('enc-party-1').stats.coldCompetition.outcome, 'pvp_expired');
        await Runtime.tick({ ...base, canRun: () => true, recordPvpStep: r => completions.push(r) });
        assert.strictEqual(completions.length, 1);
        console.log('Expiry during hot-to-cold handoff finalized once');
        return;
    }
    if (revengeMode) {
        assert(Manager.sessions.every(s => s.pvpEncounter.reason === 'revenge'));
        const enqueue = Memory.events.enqueue, captured = [];
        try {
            Memory.events.enqueue = e => { captured.push(e); return false; };
            const avenger = Manager.sessions.find(s => s.actor.fetchId() === 1);
            const target = Manager.sessions.find(s => s.actor.fetchId() === 3);
            avenger.actor.fetchClanId = () => 5; target.actor.fetchClanId = () => 6;
            invoke('GameServer/Social/PvpInteractionMemory').record(target, 1, true, clock, [], avenger.actor);
            invoke('GameServer/Social/PvpInteractionMemory').record(avenger, 3, true, clock, [], target.actor);
            assert.deepStrictEqual(captured.map(e => e.clan.responsibility), ['aggression', 'defense'],
                'hot continuation preserves accountability for an independently initiated revenge fight');
            delete avenger.actor.fetchClanId; delete target.actor.fetchClanId;
        } finally { Memory.events.enqueue = enqueue; }
    }
    const duplicate = invoke('GameServer/Social/PvpInteractionMemory').record(Manager.sessions[0], 3, false, clock);
    assert.strictEqual(duplicate, false, 'same attack episode is not remembered again in hot mode');
    const roster = Manager.sessions.slice();
    roster[0].actor.hp -= 50; roster[0].actor.mp -= 20; roster[0].actor.cp -= 10;
    roster[0].actor.skillReuseUntil.set(99, clock + 10000);
    clock += 500;
    const originalTransition = DB.transitionPvpEncounter;
    DB.transitionPvpEncounter = request => {
        roster[0].actor.hp -= 1;
        return originalTransition.call(DB, request);
    };
    const raced = await Lifecycle.cooldown(e, 'test', { ignoreVisibility: true });
    DB.transitionPvpEncounter = originalTransition;
    assert.strictEqual(raced.reason, 'encounter_live_state_changed');
    assert(roster.every(s => s.aiActive && !s.pvpHandoffPending));
    assert([1,2,3,4].every(n => state(n).phase === 'hot'), 'intervening damage cannot split or stale-save the roster');
    roster[0].actor.hp += 1;
    let landed = false;
    roster[1].actor.attack = { timers: new Set(['inflight']), resetQueuedEvent() {} };
    setTimeout(() => { landed = true; roster[1].actor.attack.timers.clear(); }, 20);
    const cold = await Lifecycle.cooldown(e, 'test', { ignoreVisibility: true });
    assert(cold.ok, JSON.stringify(cold));
    assert(landed, 'handoff waits for an already launched action');
    assert.strictEqual(World.user.sessions.length, 0);
    assert.strictEqual(state(1).vitals.hp, hot.states[0].vitals.hp - 50);
    assert.strictEqual(state(1).stats.coldCombat.cooldowns[99], clock + 9500);
    assert.strictEqual(state(1).stats.coldPvp.flagUntil, flagUntil, 'handoff never extends flag expiry');
    assert.strictEqual(state(1).timing.lastResolvedAt, clock, 'hot time cannot be farmed again');
    assert.strictEqual(state(1).stats.pvpEncounter.key, e.key);
    assert.strictEqual(cold.encounter.expiresAt, e.expiresAt, 'handoff preserves rather than renews the deadline');
    assert.strictEqual(cold.encounter.actions, e.actions, 'handoff preserves the cold action budget');
    if (revengeMode) assert.strictEqual(state(1).stats.pvpEncounter.reason, 'revenge');
    e = cold.encounter; clock += 1000;
    await DB.execute([`UPDATE bot_life_state SET statsJson=json_set(statsJson,'$.supplyErrand',json(?)),
        simulationRevision=simulationRevision+1 WHERE characterId=2`, [JSON.stringify({ reason: 'pending_supplies' })]]);
    Life.acceptLifecycleRow((await DB.execute(['SELECT * FROM bot_life_state WHERE characterId=2', []]))[0]);
    const resumed = await Conflict.apply({ ...base, event: event(1, 3, e.key), resume: e, contestContextAllowed: () => false });
    assert(resumed.ok && resumed.encounter, JSON.stringify(resumed));
    assert(resumed.combat.actions > 0, 'continuation follows nearby opponents even after leaving the original resource spot');
    assert.strictEqual(state(2).stats.supplyErrand.reason, 'pending_supplies', 'pending errands survive but do not veto an active fight');
    assert.strictEqual(JSON.stringify([1,2,3,4].map(n => Memory.snapshot(n))), initialMemory, 'cold continuation does not duplicate memory');
    assert(!(await Conflict.apply({ ...base, event: event(1, 3, e.key), resume: e })).ok, 'stale encounter sequence is rejected');
    e = resumed.encounter;
    if (extensionMode) {
        const originalStart = e.startedAt;
        while (clock < originalStart + Budget.MAX_MS - 2000) {
            clock += 1000;
            const step = await Conflict.apply({ ...base, event: event(1, 3, e.key), resume: e });
            assert(step.ok && step.encounter, JSON.stringify(step));
            telemetry.recordPvpStep(step);
            e = step.encounter;
        }
        assert.strictEqual(e.expiresAt, originalStart + Budget.MAX_MS);
        assert.strictEqual(e.extensions, 2, 'ongoing attacks cannot extend beyond one minute');
        assert.strictEqual(telemetry.snapshot().pvpExtensions, 2, 'count committed extensions, not each continued step');
        assert.strictEqual(telemetry.snapshot().pvpExtendedMs, 30000);
        assert(e.actions <= Budget.MAX_ACTIONS);
        assert.strictEqual(JSON.stringify([1,2,3,4].map(n => Memory.snapshot(n))), initialMemory,
            'extensions remain one incident, not repeated aggression');
    }
    await DB.close(); DB.init();
    const persisted = JSON.parse((await DB.execute(['SELECT statsJson FROM bot_life_state WHERE characterId=1', []]))[0].statsJson);
    assert.strictEqual(persisted.pvpEncounter.key, e.key);
    assert.strictEqual(persisted.pvpEncounter.expiresAt, e.expiresAt, 'deadline survives SQLite reopen');
    assert.strictEqual(persisted.pvpEncounter.actions, e.actions, 'spent actions survive SQLite reopen');
    if (revengeMode) assert.strictEqual(persisted.pvpEncounter.reason, 'revenge');
    clock = e.expiresAt + 1000;
    const ended = await Conflict.apply({ ...base, event: event(1, 3, e.key), resume: e });
    assert(ended.ok && !ended.encounter, JSON.stringify(ended));
    assert.strictEqual(ended.combat.actions, 0, 'an expired encounter cannot produce catch-up damage');
    assert.strictEqual(state(1).stats.pvpEncounter, null);
    assert(!require('../src/GameServer/Bot/Population/ColdCompetitionWait').consume(state(1), 1000, clock + 1000).waiting);
    expectedCount = 2; spawned = 0; failSpawn = 2;
    const solo = await Conflict.apply({ ...base, event: event(5, 6) });
    assert(solo.encounter);
    const failed = await Lifecycle.activate(solo.encounter);
    assert.strictEqual(failed.reason, 'test_spawn_failure');
    assert([5,6].every(n => state(n).phase === 'cold'));
    assert.strictEqual(Manager.sessions.length, 0, 'failed staging publishes nobody');
    assert(!Runtime.pending.size);
    const running = await Conflict.apply({ ...base, event: event(7, 8) });
    assert(running.encounter);
    Runtime.encounters.clear(); Runtime.register(running.encounter);
    clock += 1100;
    const steps = [];
    await Runtime.tick({ ...base, canRun: () => true, recordPvpStep: r => steps.push(r) });
    assert.strictEqual(steps.length, 1, 'normal runtime timer advances an indexed encounter');
    assert(state(7).stats.pvpEncounter.sequence > running.encounter.sequence);
    clock = running.encounter.expiresAt + 2000;
    await Runtime.tick({ ...base, canRun: () => true, recordPvpStep: r => steps.push(r) });
    assert.strictEqual(state(7).stats.pvpEncounter, null);
    assert.strictEqual(state(7).stats.coldCompetition.outcome, 'pvp_expired');
    assert.strictEqual(steps.filter(r => !r.encounter).length, 1, 'expiry counts one completion');
    await Runtime.tick({ ...base, canRun: () => true, recordPvpStep: r => steps.push(r) });
    assert.strictEqual(steps.filter(r => !r.encounter).length, 1, 'cleanup cannot count the same encounter again');
    await party([9, 10]); await party([11, 12]);
    const split = await Conflict.apply({ ...base, event: event(9, 11) });
    assert(split.encounter);
    // An incomplete lifecycle transition must not keep a fight alive forever.
    await DB.execute(['UPDATE bot_life_state SET phase=? WHERE characterId=10', ['warm']]);
    Life.acceptLifecycleRow((await DB.execute(['SELECT * FROM bot_life_state WHERE characterId=10', []]))[0]);
    clock = split.encounter.expiresAt + 2000;
    const { grants } = await Owner.claimBatch([state(9)], { timestamp: clock, allowParty: true, allowLifecycle: true });
    assert.strictEqual(grants.length, 1);
    await Runtime.tick({ ...base, canRun: () => true, recordPvpStep: r => steps.push(r) });
    assert(Runtime.encounters.has(split.encounter.key), 'cleanup waits for an outstanding writer lease');
    assert.strictEqual(steps.filter(r => !r.encounter).length, 1, 'partial cleanup is not a completed encounter');
    await Owner.releaseBatch(grants);
    await Runtime.tick({ ...base, canRun: () => true, recordPvpStep: r => steps.push(r) });
    assert(!Runtime.encounters.has(split.encounter.key));
    assert([9, 10, 11, 12].every(id => !state(id).stats.pvpEncounter));
    assert.strictEqual(Parties.find('enc-party-9').stats.coldCompetition.outcome, 'pvp_expired');
    assert.strictEqual(Parties.find('enc-party-11').stats.coldCompetition.wait, null);
    assert.strictEqual(steps.filter(r => !r.encounter).length, 2, 'mixed-state expiry counts once after all writes settle');
    await DB.close(); DB.init();
    const closed = (await DB.execute(['SELECT statsJson FROM bot_life_state WHERE characterId=9', []]))[0];
    assert.strictEqual(JSON.parse(closed.statsJson).coldCompetition.outcome, 'pvp_expired', 'final outcome survives SQLite reopen');
    console.log('PvP handoff: stepped party combat, atomic cold/hot/cold, first nick flag, resources, reuse, memory dedup, expiry, rollback and SQLite reopen passed');
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
    allSessions.forEach(s => clearTimeout(s.pvpFlagTimer));
    await Memory.events.flush(); await DB.close(); saved.reverse().forEach(fn => fn());
    Runtime.encounters.clear(); fs.rmSync(dir, { recursive: true, force: true });
});
