const assert = require('assert');

require('../src/Global');

const World = invoke('GameServer/World/World');
const BotManager = invoke('GameServer/Bot/BotManager');
const PartyCombatState = invoke('GameServer/Bot/AI/PartyCombatState');
const PartyRevivalService = invoke('GameServer/Bot/AI/PartyRevivalService');
const FollowingState = invoke('GameServer/Bot/AI/States/FollowingState');
const C4SkillEffects = invoke('GameServer/Skills/C4SkillEffects');
const Revive = invoke('GameServer/Actor/Generics/Revive');

function actor(id, { dead = false, skills = [], items = [] } = {}) {
    const state = {
        dead,
        fetchDead() { return this.dead; },
        setDead(value) { this.dead = value; },
        fetchCombats: () => false,
        fetchHits: () => false,
        fetchCasts: () => false,
        setCasts() {}
    };
    return {
        id,
        state,
        hp: 100,
        mp: 100,
        fetchId() { return this.id; },
        fetchName: () => `actor_${id}`,
        fetchClassId: () => 0,
        fetchLocX: () => 0,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchHead: () => 0,
        fetchIsOnline: () => true,
        isDead() { return this.state.fetchDead(); },
        fetchMp() { return this.mp; },
        fetchMaxMp: () => 100,
        fetchMaxHp: () => 100,
        fetchHp() { return this.hp; },
        fetchDestId() { return this.destId; },
        fillupVitals() { this.hp = 100; this.mp = 100; },
        canUseSkill: () => true,
        select(data) { this.destId = data.id; },
        skillset: { skills },
        backpack: { fetchItems: () => items },
        automation: {
            stopReplenish() {},
            replenishVitals() {},
            scheduleAction(...args) { this.scheduled = args; }
        },
        attack: {
            remoteHit(...args) { this.resurrectionCast = args; }
        }
    };
}

function session(actor, accountId) {
    const value = {
        actor,
        accountId,
        packets: [],
        dataSendToMe() {},
        dataSendToMeAndOthers(packet) { this.packets.push(packet); }
    };
    actor.session = value;
    return value;
}

const originalUsers = World.user;
const originalNpcs = World.npc;
const originalFetchNpcs = World.fetchNpcsInRadius;
const originalSessions = BotManager.sessions;

try {
    const resurrection = {
        fetchPassive: () => false,
        fetchSkillType: () => 'resurrect',
        fetchTargetKind: () => 'corpse_player',
        fetchConsumedMp: () => 20,
        fetchPower: () => 20,
        fetchSelfId: () => 1016
    };
    const leader = actor(2000100, { dead: true });
    const healer = actor(2000101, { skills: [resurrection] });
    const fallen = actor(2000102, { dead: true });
    const leaderSession = session(leader, 'player_party_revival');
    const healerSession = session(healer, 'bot_party_healer');
    const fallenSession = session(fallen, 'bot_party_fallen');
    [healerSession, fallenSession].forEach((member) => {
        member.followPlayerSession = leaderSession;
        member.partyCompanion = true;
        member.plan = 'following';
    });
    World.user = { sessions: [leaderSession, healerSession, fallenSession] };
    World.npc = { spawns: [] };
    World.fetchNpcsInRadius = () => [];
    BotManager.sessions = [healerSession, fallenSession];

    leader.state.setDead(false);
    fallen.state.setDead(false);
    let corpseFallbackScans = 0;
    const livingPartySpawns = [];
    livingPartySpawns.find = () => {
        corpseFallbackScans += 1;
        return undefined;
    };
    World.npc.spawns = livingPartySpawns;
    assert.strictEqual(PartyCombatState.combatState(leaderSession).active, false, 'a safe living party must remain out of combat');
    assert.strictEqual(corpseFallbackScans, 0, 'a living party must not scan every NPC for corpse attackers');
    leader.state.setDead(true);
    fallen.state.setDead(true);
    World.npc.spawns = [];

    const frustrationStart = 1_000_000;
    assert.deepStrictEqual(
        PartyRevivalService.noteCompanionDeath(leaderSession, fallenSession, frustrationStart),
        { count: 1, warning: false },
        'the first recent companion death should not threaten to leave'
    );
    assert.deepStrictEqual(
        PartyRevivalService.noteCompanionDeath(leaderSession, fallenSession, frustrationStart + 60_000),
        { count: 2, warning: true },
        'the second recent death should warn the party before any future departure'
    );
    assert.deepStrictEqual(
        PartyRevivalService.noteCompanionDeath(leaderSession, fallenSession, frustrationStart + 120_000),
        { count: 3, warning: false },
        'repeated deaths may affect dialogue but must not make a companion leave'
    );
    assert.strictEqual(fallenSession.partyCompanion, true, 'death frustration must preserve party membership');
    fallenSession.partyDeathFrustration = undefined;
    fallenSession.deathTimerStart = frustrationStart;
    Revive(fallenSession, fallen, { delayMs: 0 });
    assert.strictEqual(fallenSession.deathTimerStart, undefined, 'native resurrection must release the death lifecycle so a later death is counted');
    fallen.state.setDead(true);
    assert.deepStrictEqual(
        PartyRevivalService.noteCompanionDeath(leaderSession, fallenSession, frustrationStart + PartyRevivalService.PARTY_DEATH_FRUSTRATION_WINDOW_MS + 1),
        { count: 1, warning: false },
        'death frustration should cool off after ten quiet minutes'
    );
    fallenSession.partyDeathFrustration = undefined;

    World.npc.spawns = [{
        fetchAttackable: () => true,
        isDead: () => false,
        fetchLocX: () => 100,
        fetchLocY: () => 0,
        fetchDestId: () => leader.fetchId(),
        fetchStateAttack: () => true,
        state: { fetchCombats: () => true }
    }];
    const combatHeldResult = PartyRevivalService.tick(healerSession, leaderSession, { skillExec() {} });
    assert.strictEqual(combatHeldResult.handled, false, 'a monster still fighting a fallen party member must block resurrection');
    World.npc.spawns = [{
        fetchAttackable: () => true,
        isDead: () => false,
        fetchLocX: () => 5000,
        fetchLocY: () => 0,
        fetchDestId: () => leader.fetchId(),
        fetchStateAttack: () => true,
        state: { fetchCombats: () => true }
    }];
    const staleCorpseCombatResult = PartyRevivalService.tick(healerSession, leaderSession, { skillExec() {} });
    assert.strictEqual(staleCorpseCombatResult.handled, true, 'a stale combat record far from a corpse must not block resurrection');
    leaderSession.partyRevivalAttempt = null;
    World.npc.spawns = [{
        fetchAttackable: () => true,
        isDead: () => false,
        fetchLocX: () => 100,
        fetchLocY: () => 0,
        fetchDestId: () => leader.fetchId(),
        fetchStateAttack: () => false,
        state: { fetchCombats: () => true }
    }];
    const staleCloseCorpseCombatResult = PartyRevivalService.tick(healerSession, leaderSession, { skillExec() {} });
    assert.strictEqual(staleCloseCorpseCombatResult.handled, true, 'a close stale combat flag without an active attack must not block resurrection forever');
    leaderSession.partyRevivalAttempt = null;
    World.npc.spawns = [];
    healer.state.fetchHits = () => true;

    const staleActionResult = PartyRevivalService.tick(healerSession, leaderSession, { skillExec() {} });
    assert.strictEqual(staleActionResult.handled, true, 'a stale hit flag without a living hostile target must not strand a dead companion');
    assert.strictEqual(staleActionResult.source, 'skill', 'a stale hit flag must still allow the preferred resurrection skill');
    leaderSession.partyRevivalAttempt = null;
    healer.destId = 3000100;
    World.npc.spawns = [{
        fetchId: () => 3000100,
        fetchAttackable: () => true,
        isDead: () => false,
        fetchDestId: () => null,
        state: { fetchCombats: () => false }
    }];
    const activeActionHeldResult = PartyRevivalService.tick(healerSession, leaderSession, { skillExec() {} });
    assert.strictEqual(activeActionHeldResult.handled, false, 'a living companion still striking a living hostile target must block resurrection');
    healer.state.fetchHits = () => false;
    healer.destId = undefined;
    World.npc.spawns = [];

    const combatWaitStart = 2_000_000;
    fallenSession.deathTimerStart = combatWaitStart;
    fallenSession.partyReviveCombatPauseStartedAt = undefined;
    fallenSession.partyReviveCombatPausedMs = undefined;
    World.npc.spawns = [{
        fetchId: () => 3000200,
        fetchAttackable: () => true,
        isDead: () => false,
        fetchLocX: () => 100,
        fetchLocY: () => 0,
        fetchDestId: () => fallen.fetchId(),
        fetchStateAttack: () => true,
        state: { fetchCombats: () => true }
    }];
    assert.strictEqual(
        PartyRevivalService.shouldTownRespawn(leaderSession, fallenSession, combatWaitStart + 30_000),
        false,
        'the resurrection timeout must pause when party combat begins'
    );
    assert.strictEqual(
        PartyRevivalService.shouldTownRespawn(leaderSession, fallenSession, combatWaitStart + 120_000),
        false,
        'wall-clock time spent in combat must not expire the resurrection wait'
    );
    World.npc.spawns = [];
    assert.strictEqual(
        PartyRevivalService.shouldTownRespawn(leaderSession, fallenSession, combatWaitStart + 120_000),
        false,
        'ending combat should resume the remaining wait budget instead of forcing an immediate restart'
    );
    assert.strictEqual(
        PartyRevivalService.shouldTownRespawn(leaderSession, fallenSession, combatWaitStart + 151_000),
        true,
        'the companion may restart in town after sixty seconds of actual safe waiting'
    );
    fallenSession.deathTimerStart = undefined;
    fallenSession.partyReviveCombatPauseStartedAt = undefined;
    fallenSession.partyReviveCombatPausedMs = undefined;

    let skillCast = null;
    const skillResult = PartyRevivalService.tick(healerSession, leaderSession, {
        skillExec(...args) { skillCast = args; }
    });
    assert.strictEqual(skillResult.source, 'skill', 'a learned Resurrection skill must take priority over the unlimited scroll');
    assert.strictEqual(skillCast[2].selfId, 1016, 'party resurrection should use the healer\'s learned Resurrection skill');
    assert.strictEqual(skillCast[2].id, leader.fetchId(), 'party resurrection should target the first fallen member');
    healer.state.fetchCombats = () => false;

    leader.state.setDead(false);
    let secondResurrectionCast = null;
    const secondResurrectionResult = PartyRevivalService.tick(healerSession, leaderSession, {
        skillExec(...args) { secondResurrectionCast = args; }
    });
    assert.strictEqual(secondResurrectionResult.source, 'skill', 'a remaining fallen companion should be revived without waiting for the first attempt timeout');
    assert.strictEqual(secondResurrectionCast[2].id, fallen.fetchId(), 'the next resurrection should immediately target the remaining corpse');

    leaderSession.partyRevivalAttempt = null;
    leader.state.setDead(true);
    healer.skillset.skills = [];
    const scrollResult = PartyRevivalService.tick(healerSession, leaderSession, { skillExec() {} });
    assert.strictEqual(scrollResult.source, 'scroll', 'a living companion must fall back to its unlimited resurrection scroll');
    assert(healer.automation.scheduled, 'scroll resurrection should use the native move-and-cast path');

    // Companion following must schedule resurrection itself; the player does
    // not need to send a chat request after dying.
    leaderSession.partyRevivalAttempt = null;
    healer.skillset.skills = [resurrection];
    leaderSession.partyPullState = { targetId: 3000100, phase: 'return' };
    let autonomousResurrection = null;
    FollowingState.tick(healerSession, healer, {
        skillExec(...args) { autonomousResurrection = args; }
    }, { say() {}, executeCombat() {}, executePvPCombat() {} });
    assert.strictEqual(healerSession.roleDecision.action, 'resurrect_party', 'a dead leader must immediately preempt ordinary following with resurrection');
    assert.strictEqual(autonomousResurrection[2].id, leader.fetchId(), 'automatic resurrection must target the party leader first');
    assert.deepStrictEqual(leaderSession.partyPullState, {}, 'a leader death must cancel the stale pull before resurrection begins');

    leader.state.setDead(false);
    healer.state.setDead(true);
    leader.skillset.skills = [];
    leader.backpack.fetchItems = () => [];
    BotManager.sessions = [healerSession];
    assert.strictEqual(
        PartyRevivalService.shouldTownRespawn(leaderSession, healerSession),
        true,
        'a dead companion should return to town when the leader is alone and cannot resurrect it'
    );
    leader.backpack.fetchItems = () => [{ fetchSelfId: () => 737, fetchAmount: () => 1 }];
    assert.strictEqual(
        PartyRevivalService.shouldTownRespawn(leaderSession, healerSession),
        false,
        'a player with a resurrection scroll should retain a dead companion while choosing to revive it'
    );
    leader.backpack.fetchItems = () => [];
    leader.skillset.skills = [resurrection];
    leader.mp = 0;
    assert.strictEqual(
        PartyRevivalService.shouldTownRespawn(leaderSession, healerSession),
        false,
        'a player who knows Resurrection should retain the companion while regenerating MP'
    );
    leader.skillset.skills = [];

    leader.state.setDead(true);
    assert.strictEqual(
        PartyRevivalService.shouldTownRespawn(leaderSession, healerSession),
        true,
        'a full party wipe should release dead companions for town respawn'
    );

    const nativeTarget = actor(2000103, { dead: true });
    const nativeTargetSession = session(nativeTarget, 'bot_native_resurrection_target');
    const nativeResult = C4SkillEffects.execute(healerSession, healer, nativeTarget, {
        fetchSemantic: () => ({ skillType: 'resurrect' }),
        fetchSpell: () => true
    });
    assert.strictEqual(nativeResult.resurrected, true, 'the shared skill-effect path must apply a Resurrection cast to a corpse player');
    assert(nativeTargetSession.packets.some((packet) => packet[0] === 0x07), 'native resurrection should send the standard revive packet');
} finally {
    World.user = originalUsers;
    World.npc = originalNpcs;
    World.fetchNpcsInRadius = originalFetchNpcs;
    BotManager.sessions = originalSessions;
}

console.log('Party revival checks passed');
