const assert = require('assert');

require('../src/Global');

const World = invoke('GameServer/World/World');
const BotManager = invoke('GameServer/Bot/BotManager');
const PartyRevivalService = invoke('GameServer/Bot/AI/PartyRevivalService');
const C4SkillEffects = invoke('GameServer/Skills/C4SkillEffects');

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

    World.npc.spawns = [{
        fetchAttackable: () => true,
        isDead: () => false,
        fetchDestId: () => leader.fetchId(),
        state: { fetchCombats: () => true }
    }];
    const combatHeldResult = PartyRevivalService.tick(healerSession, leaderSession, { skillExec() {} });
    assert.strictEqual(combatHeldResult.handled, false, 'a monster still fighting a fallen party member must block resurrection');
    World.npc.spawns = [];
    healer.state.fetchCombats = () => true;
    healer.state.fetchHits = () => true;

    const activeActionHeldResult = PartyRevivalService.tick(healerSession, leaderSession, { skillExec() {} });
    assert.strictEqual(activeActionHeldResult.handled, false, 'a living companion still executing a hit must block resurrection even before the NPC target state is visible');
    healer.state.fetchHits = () => false;

    let skillCast = null;
    const skillResult = PartyRevivalService.tick(healerSession, leaderSession, {
        skillExec(...args) { skillCast = args; }
    });
    assert.strictEqual(skillResult.source, 'skill', 'a learned Resurrection skill must take priority over the unlimited scroll');
    assert.strictEqual(skillCast[2].selfId, 1016, 'party resurrection should use the healer\'s learned Resurrection skill');
    assert.strictEqual(skillCast[2].id, leader.fetchId(), 'party resurrection should target the first fallen member');
    healer.state.fetchCombats = () => false;

    leaderSession.partyRevivalAttempt = null;
    healer.skillset.skills = [];
    const scrollResult = PartyRevivalService.tick(healerSession, leaderSession, { skillExec() {} });
    assert.strictEqual(scrollResult.source, 'scroll', 'a living companion must fall back to its unlimited resurrection scroll');
    assert(healer.automation.scheduled, 'scroll resurrection should use the native move-and-cast path');

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
