const assert = require('node:assert/strict');
require('../src/Global');

const Revival = invoke('GameServer/Bot/AI/PartyRevivalService');
const Combat = invoke('GameServer/Bot/AI/PartyCombatState');
const World = invoke('GameServer/World/World');
const State = invoke('GameServer/Model/State');
const Attack = invoke('GameServer/Actor/Attack');
const Geo = invoke('GameServer/Geodata/GeodataEngine');
const { registerSessions } = require('./helpers/worldSessions');

const skill = {
    fetchPassive: () => false, fetchSkillType: () => 'resurrect',
    fetchTargetKind: () => 'corpse_player', fetchConsumedMp: () => 20,
    fetchPower: () => 20, fetchSelfId: () => 1016, fetchDistance: () => 600
};
let now = 1_000_000;
const saved = { now: Date.now, user: World.user, npc: World.npc,
    nearby: World.fetchNpcsInRadius, straight: Geo.canWalkStraight, sight: Geo.hasLineOfSight,
    combat: Combat.combatState };

function member(id, skills = []) {
    const state = new State();
    const actor = {
        state, effects: {}, x: 0, y: 0, z: 0, aborts: 0,
        fetchId: () => id, fetchName: () => `reviver_${id}`, fetchClassId: () => 17,
        fetchIsOnline: () => true, isDead: () => state.fetchDead(),
        isBlocked: () => state.isBlocked(),
        fetchLocX() { return this.x; }, fetchLocY() { return this.y; }, fetchLocZ() { return this.z; },
        fetchMp: () => 100, fetchMaxMp: () => 100, fetchHp: () => 100, fetchMaxHp: () => 100,
        fetchDestId() { return this.dest; },
        select({ id: target }) { this.dest = target; }, unselect() { this.dest = undefined; },
        skillset: { skills }, backpack: { fetchItems: () => [] }
    };
    const session = { actor, accountId: `bot_handoff_${id}`, dataSendToMe() {}, dataSendToMeAndOthers() {} };
    actor.session = session;
    actor.automation = { abortAll() { actor.aborts++; state.setTowards(false); session.pendingPathRequest = null; } };
    actor.attack = { abortCast() { actor.aborts++; }, clearTimers() {}, resetQueuedEvent() {} };
    return session;
}

function party() {
    const leader = member(2001000), first = member(2001001, [skill]);
    const second = member(2001002, [skill]), corpse = member(2001003);
    leader.accountId = 'player_handoff';
    for (const s of [first, second, corpse]) Object.assign(s, { partyCompanion: true, followPlayerSession: leader });
    corpse.actor.x = 600;
    corpse.actor.state.setDead(true);
    corpse.deathTimerStart = now;
    registerSessions([leader, first, second, corpse]);
    const requests = [];
    const Generics = { skillExec(provider, actor, request) { requests.push({ provider, request }); } };
    return { leader, first, second, corpse, requests, tick: s => Revival.tick(s, leader, Generics) };
}

try {
    Date.now = () => now;
    World.npc = { spawns: [] };
    World.fetchNpcsInRadius = () => [];
    Geo.canWalkStraight = Geo.hasLineOfSight = () => true;

    // A low-id provider behind geometry must yield to a peer ready to cast.
    {
        const p = party();
        p.second.actor.x = 100;
        Geo.canWalkStraight = x => x !== 0;
        assert.equal(p.tick(p.first).handled, false);
        assert.equal(p.tick(p.second).handled, true);
        assert.equal(p.requests[0].provider, p.second);
        Geo.canWalkStraight = () => true;
    }

    // No movement for five seconds releases the lease and excludes that
    // provider/corpse pair, rather than electing the same id again.
    {
        const p = party();
        p.tick(p.first);
        now += 4999;
        p.tick(p.second);
        assert.equal(p.requests.length, 1);
        now++;
        assert.equal(p.tick(p.second).handled, true);
        assert.equal(p.requests.length, 2);
        assert.equal(p.requests[1].provider, p.second);
        assert.equal(p.first.currentTargetId, undefined);
        assert(p.first.actor.aborts > 0, 'the old approach and queued action must be cancelled');
        p.tick(p.first);
        assert.equal(p.requests.length, 2, 'the failed provider must not reclaim the attempt');

        // A regroup/new position removes the exclusion immediately.
        p.leader.partyRevivalAttempt = null;
        p.first.actor.x = 64;
        p.tick(p.first);
        assert.equal(p.requests.at(-1).provider, p.first);
        assert.equal(p.requests.length, 3);
    }

    // A finished path refusal need not wait for the stall timer.
    {
        const p = party();
        p.tick(p.first);
        p.first.lastPathfinding = { at: now, routeUsable: false };
        now += 100;
        p.tick(p.second);
        assert.equal(p.requests.length, 2);
        assert.equal(p.requests.at(-1).provider, p.second);
    }

    // Failure of all providers has a finite retry delay and cannot keep
    // renewing a corpse's safe-wait deadline forever.
    {
        const p = party();
        p.tick(p.first);
        p.first.lastPathfinding = { at: now, routeUsable: false };
        p.tick(p.second);
        p.second.lastPathfinding = { at: now, routeUsable: false };
        p.tick(p.first);
        assert.equal(p.leader.partyRevivalAttempt, null);
        p.tick(p.first); p.tick(p.second);
        assert.equal(p.requests.length, 2);
        assert.equal(Revival.shouldTownRespawn(p.leader, p.corpse, now + 61000), true);
        now += 15001;
        p.tick(p.first);
        assert.equal(p.requests.length, 3, 'an unchanged location may be retried after the cooldown');
    }

    // Progress around an obstacle counts even when it temporarily moves
    // sideways or away from the corpse. A movement flag alone does not.
    {
        const p = party();
        p.corpse.actor.x = 1000;
        p.tick(p.first);
        p.first.actor.state.setTowards('move');
        for (let i = 0; i < 8; i++) {
            now += 4000;
            p.first.actor.y += 64;
            p.tick(p.second);
            assert.equal(p.requests.length, 1, 'a progressing detour must retain its provider');
            assert.equal(p.first.actor.aborts, 0, 'a long but progressing detour must not be cancelled');
        }
        now += 5000;
        p.tick(p.second);
        assert.equal(p.requests.length, 2, 'a stale moving flag cannot reserve the corpse forever');
    }

    // Automation routes around geometry, then the provider must retry the
    // skill from the reached position instead of idling until the timeout.
    {
        const p = party();
        p.corpse.actor.x = 1000;
        p.tick(p.first);
        p.first.lastPathfinding = { at: now, routeUsable: true };
        p.first.actor.x = 850;
        now += 1100;
        p.tick(p.first);
        assert.equal(p.requests.length, 2);
        p.tick(p.first);
        assert.equal(p.requests.length, 2, 'an async native request must not be repeated in the same tick');
    }

    // Real casts are identified by Attack.activeCast, not by skill reuse or
    // a stale state flag. Even a long cast survives timeout/combat changes.
    {
        const p = party();
        p.tick(p.first);
        const cast = { target: p.corpse.actor, skill, landsAt: now + 40000 };
        p.first.actor.attack.activeCast = cast;
        p.first.actor.state.setCasts(true);
        p.first.lastPathfinding = { at: now, routeUsable: false };
        p.corpse.deathTimerStart = now - 61000;
        Combat.combatState = () => ({ active: true, reason: 'threat_targeting_party' });
        now += 31000;
        p.tick(p.second);
        assert.equal(p.tick(p.first).handled, true);
        assert.equal(p.requests.length, 1, 'a native cast must never be duplicated by a backup');
        assert.equal(p.first.actor.attack.activeCast, cast);
        assert.equal(p.first.actor.aborts, 0, 'handoff must not cancel the active native cast');
        assert.equal(Revival.shouldTownRespawn(p.leader, p.corpse), false, 'the corpse must wait for the accepted long cast');

        Combat.combatState = saved.combat;
        now = cast.landsAt;
        p.first.actor.attack.activeCast = null;
        p.first.actor.state.setCasts(false);
        p.tick(p.second);
        now += 2500;
        p.tick(p.second);
        assert.equal(p.requests.length, 1, 'stand-up animation must not cause a second resurrection');
        assert.equal(p.first.actor.aborts, 0);
        p.corpse.actor.state.setDead(false);
        p.tick(p.second);
        assert.equal(p.requests.length, 1);
        assert.equal(p.leader.partyRevivalAttempt, null, 'a completed revival releases the reservation immediately');
    }

    // A fast cast may land between AI ticks while the native corpse still
    // spends 2.5 seconds standing up. The accepted-cast event protects it.
    {
        const p = party();
        p.tick(p.first);
        Revival.noteCastStarted(p.first, p.first.actor, p.corpse.actor);
        p.first.lastPathfinding = { at: now, routeUsable: true };
        now += 1100;
        p.tick(p.first);
        p.tick(p.second);
        assert.equal(p.requests.length, 1, 'a cast completed between ticks must not be repeated after the detour');
        assert.equal(p.first.actor.aborts, 0);
        p.corpse.actor.state.setDead(false);
        p.tick(p.second);
        assert.equal(p.requests.length, 1);
        assert.equal(p.leader.partyRevivalAttempt, null);
    }

    // An unrelated cast also survives releasing a stale resurrection job.
    {
        const p = party();
        p.tick(p.first);
        p.first.actor.attack = new Attack();
        const cast = { target: p.leader.actor, skill: { fetchTargetKind: () => 'friendly' } };
        p.first.actor.attack.activeCast = cast;
        const queuedResurrection = { selfId: skill.fetchSelfId(), id: p.corpse.actor.fetchId() };
        p.first.actor.attack.queueEvent('skill', queuedResurrection);
        p.first.actor.storedSpell = { ...queuedResurrection };
        p.first.actor.state.setCasts(true);
        now += 5000;
        p.tick(p.second);
        assert.equal(p.requests.length, 2);
        assert.equal(p.first.actor.attack.activeCast, cast);
        assert.equal(p.first.actor.aborts, 0);
        assert.equal(p.first.actor.attack.queue.name, undefined,
            'handoff must remove the old queued resurrection without aborting the unrelated native cast');
        assert.equal(p.first.actor.storedSpell, undefined, 'a stored resurrection must not restart after handoff');
    }

    // Removing a stale resurrection may not erase the caster's next heal.
    {
        const p = party();
        p.tick(p.first);
        p.first.actor.attack = new Attack();
        const cast = { target: p.leader.actor, skill: { fetchTargetKind: () => 'friendly' } };
        p.first.actor.attack.activeCast = cast;
        const queuedHeal = { selfId: 1011, id: p.leader.actor.fetchId() };
        p.first.actor.attack.queueEvent('skill', queuedHeal);
        p.first.actor.storedSpell = queuedHeal;
        p.first.actor.state.setCasts(true);
        now += 5000;
        p.tick(p.second);
        assert.equal(p.requests.length, 2);
        assert.equal(p.first.actor.attack.activeCast, cast);
        assert.equal(p.first.actor.attack.queue.data, queuedHeal);
        assert.equal(p.first.actor.storedSpell, queuedHeal);
    }

    console.log('Party resurrection handoff: readiness, failed/stalled routes, movement progress, retries and native cast protection passed');
} finally {
    Date.now = saved.now;
    World.user = saved.user;
    World.npc = saved.npc;
    World.fetchNpcsInRadius = saved.nearby;
    Geo.canWalkStraight = saved.straight;
    Geo.hasLineOfSight = saved.sight;
    Combat.combatState = saved.combat;
}
