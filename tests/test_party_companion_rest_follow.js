const assert = require('assert');

require('../src/Global');

const World = invoke('GameServer/World/World');
const FollowingState = invoke('GameServer/Bot/AI/States/FollowingState');
const HuntingState = invoke('GameServer/Bot/AI/States/HuntingState');
const RestingState = invoke('GameServer/Bot/AI/States/RestingState');
const ShoppingState = invoke('GameServer/Bot/AI/States/ShoppingState');
const BotAgentTools = invoke('GameServer/Bot/AI/BotAgentTools');
const PartyCompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');
const BotManager = invoke('GameServer/Bot/BotManager');
const BotBuffs = invoke('GameServer/Bot/AI/BotBuffs');
const BotStatus = invoke('GameServer/Bot/AI/BotStatus');
const BotBrainContext = invoke('GameServer/Bot/AI/BotBrainContext');
const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
const PartyPulling = invoke('GameServer/Bot/AI/PartyPulling');
const PartyAwareness = invoke('GameServer/Bot/AI/PartyAwareness');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const CompanionControl = invoke('GameServer/World/Generics/NpcBypasses/CompanionControl');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const NpcDied = invoke('GameServer/Actor/Generics/NpcDied');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const SkillModel = invoke('GameServer/Model/Skill');

class FakeState {
    constructor() {
        this.seated = false;
        this.dead = false;
        this.towards = false;
        this.hits = false;
        this.casts = false;
        this.animated = false;
    }

    fetchSeated() { return this.seated; }
    setSeated(value) { this.seated = value; }
    fetchDead() { return this.dead; }
    fetchTowards() { return this.towards; }
    setTowards(value) { this.towards = value; }
    fetchHits() { return this.hits; }
    fetchCasts() { return this.casts; }
    fetchAnimated() { return this.animated; }
    fetchPickinUp() { return false; }
    setCombats() {}
    isBlocked() { return this.hits || this.casts || this.animated || this.seated; }
}

function fakeActor(id, loc = {}) {
    const actor = {
        id,
        name: `actor_${id}`,
        locX: loc.locX || 0,
        locY: loc.locY || 0,
        locZ: loc.locZ || 0,
        hp: loc.hp || 100,
        maxHp: loc.maxHp || 100,
        mp: loc.mp || 100,
        maxMp: loc.maxMp || 100,
        exp: loc.exp || 0,
        sp: loc.sp || 0,
        classId: loc.classId || 0,
        level: loc.level || 26,
        karma: loc.karma || 0,
        pvpFlag: loc.pvpFlag || 0,
        destId: loc.destId,
        state: new FakeState(),
        activeBuffs: {
            windWalk: Date.now() + 600000,
            shield: Date.now() + 600000,
            haste: Date.now() + 600000,
            might: Date.now() + 600000
        },
        moves: [],
        fetchId() { return this.id; },
        fetchName() { return this.name; },
        fetchHead() { return 0; },
        fetchLocX() { return this.locX; },
        fetchLocY() { return this.locY; },
        fetchLocZ() { return this.locZ; },
        fetchHp() { return this.hp; },
        fetchMaxHp() { return this.maxHp; },
        fetchMp() { return this.mp; },
        fetchMaxMp() { return this.maxMp; },
        setHp(value) { this.hp = value; },
        setMp(value) { this.mp = value; },
        fillupVitals() { this.hp = this.maxHp; this.mp = this.maxMp; },
        fetchExp() { return this.exp; },
        fetchSp() { return this.sp; },
        setExp(data) { this.exp = data; },
        setSp(data) { this.sp = data; },
        setExpSp(exp, sp) { this.exp = exp; this.sp = sp; },
        fetchClassId() { return this.classId; },
        fetchRace() { return 0; },
        fetchSex() { return 0; },
        fetchLevel() { return this.level; },
        fetchStr() { return 10; },
        fetchDex() { return 10; },
        fetchCon() { return 10; },
        fetchInt() { return 10; },
        fetchWit() { return 10; },
        fetchMen() { return 10; },
        fetchMaxLoad() { return 1000; },
        fetchCollectivePAtk() { return 10; },
        fetchCollectiveAtkSpd() { return 300; },
        fetchCollectivePDef() { return 10; },
        fetchCollectiveEvasion() { return 10; },
        fetchCollectiveAccur() { return 10; },
        fetchCollectiveCritical() { return 4; },
        fetchCollectiveMAtk() { return 10; },
        fetchCollectiveCastSpd() { return 300; },
        fetchCollectiveMDef() { return 10; },
        fetchCollectiveRunSpd() { return 120; },
        fetchCollectiveWalkSpd() { return 80; },
        fetchSwim() { return 0; },
        fetchAtkSpdMultiplier() { return 1; },
        fetchRadius() { return 8; },
        fetchSize() { return 23; },
        fetchHair() { return 0; },
        fetchHairColor() { return 0; },
        fetchFace() { return 0; },
        fetchIsGM() { return 0; },
        fetchTitle() { return ''; },
        fetchPrivateStoreType() { return 0; },
        fetchIsCrafter() { return 0; },
        fetchPk() { return 0; },
        fetchPvp() { return 0; },
        fetchRecRemain() { return 0; },
        fetchEvalScore() { return 0; },
        fetchMaxCp() { return 0; },
        fetchCp() { return 0; },
        fetchKarma() { return this.karma; },
        fetchPvpFlag() { return this.pvpFlag; },
        fetchDestId() { return this.destId; },
        fetchIsOnline() { return true; },
        isDead() { return this.state.fetchDead(); },
        isBlocked() { return this.state.isBlocked(); },
        moveTo(data) { this.moves.push(data); },
        select(data) { this.destId = data.id; },
        unselect() { this.destId = undefined; },
        statusUpdateVitals() {},
        backpack: {
            fetchTotalLoad: () => 0,
            fetchTotalAdena: () => 0,
            fetchItems: () => [],
            fetchItemFromSelfId: () => null,
            fetchEquippedWeapon: () => null,
            fetchPaperdollId: () => 0,
            fetchPaperdollSelfId: () => 0
        },
        skillset: {
            skills: [],
            fetchSkill(selfId) { return this.skills.find((skill) => skill.fetchSelfId() === selfId) || null; }
        },
        automation: { abortAll() {}, replenishVitals() {} }
    };
    return actor;
}

function fakeSession(accountId, actor) {
    const session = {
        accountId,
        actor,
        sent: 0,
        packets: [],
        dataSendToMe(packet) { this.sent++; if (packet) this.packets.push(packet); },
        dataSendToOthers(packet) { this.sent++; if (packet) this.packets.push(packet); },
        dataSendToMeAndOthers(packet) { this.sent++; if (packet) this.packets.push(packet); }
    };
    actor.session = session;
    return session;
}

function learnSkill(actor, data) {
    const skill = new SkillModel({
        passive: false,
        hp: 0,
        level: 1,
        hitTime: 1000,
        reuse: 1000,
        distance: 600,
        power: 20,
        mp: 10,
        ...data
    });
    actor.skillset.skills.push(skill);
    return skill;
}

const originalUsers = World.user;
const originalFetchUser = World.fetchUser;
const originalFetchNpc = World.fetchNpc;
const originalFetchNpcsInRadius = World.fetchNpcsInRadius;
const originalNpcs = World.npc;
const originalRemoveNpc = World.removeNpc;
const originalUpdateCharacterExperience = Database.updateCharacterExperience;
const originalExperience = DataCache.experience;
const originalRandom = Math.random;
const originalBotSessions = BotManager.sessions;
const originalBotPartySay = BotManager.botPartySay;
const originalApplySupportBuff = BotBuffs.applySupportBuff;
const originalFindOffers = MarketOpportunity.findOffers;

function lastPartyAllPacket(session) {
    return [...session.packets].reverse().find((packet) => packet[0] === 0x4e);
}

function lastPartySpelledPacket(session, actorId) {
    return [...session.packets].reverse().find((packet) => (
        packet[0] === 0xee &&
        (!actorId || packet.readInt32LE(5) === actorId) &&
        packet.readInt32LE(9) > 0
    ));
}

function lastNpcHtml(session) {
    const packet = [...session.packets].reverse().find((candidate) => candidate[0] === 0x0f);
    if (!packet) return '';

    let end = 5;
    while (end + 1 < packet.length) {
        if (packet[end] === 0 && packet[end + 1] === 0) break;
        end += 2;
    }
    return packet.toString('ucs2', 5, end);
}

try {
    Math.random = () => 1;
    Database.updateCharacterExperience = () => {};
    DataCache.experience = Array.from({ length: 82 }, (_, index) => index * 1000000);

    const leader = fakeActor(2000001, { locX: 0, locY: 0 });
    const leaderSession = fakeSession('player_test', leader);
    const bot = fakeActor(2000002, { locX: 1200, locY: 0 });
    const botSession = fakeSession('bot_test', bot);
    botSession.followPlayerSession = leaderSession;
    botSession.partyCompanion = true;
    botSession.plan = 'following';
    World.user = { sessions: [leaderSession, botSession] };
    World.fetchNpcsInRadius = () => [];

    FollowingState.tick(botSession, bot, {}, { say() {}, executeCombat() {}, executePvPCombat() {} });

    assert.strictEqual(bot.moves.length, 1, 'companion should run after the leader at 1200 range');
    assert.strictEqual(bot.fetchLocX(), 1200, 'companion should not teleport at 1200 range');

    const selectedTargetRefreshBot = fakeActor(2000042, { locX: 0, locY: 0, level: 1 });
    selectedTargetRefreshBot.activeBuffs = {};
    const selectedTargetRefreshSession = fakeSession('bot_selected_target_refresh', selectedTargetRefreshBot);
    selectedTargetRefreshSession.followPlayerSession = leaderSession;
    selectedTargetRefreshSession.partyCompanion = true;
    selectedTargetRefreshSession.plan = 'following';
    // These can survive an inspection or an earlier completed cast. They are
    // not proof that the party is in combat.
    leader.destId = 1099;
    selectedTargetRefreshSession.currentTargetId = 1099;
    World.user = { sessions: [leaderSession, selectedTargetRefreshSession] };
    World.npc = { spawns: [] };
    World.fetchNpcsInRadius = () => [];

    FollowingState.tick(selectedTargetRefreshSession, selectedTargetRefreshBot, {}, {
        getClosestNewbieGuide: () => ({ locX: 0, locY: 0 }),
        say() {}, executeCombat() {}, executePvPCombat() {}
    });

    assert.strictEqual(selectedTargetRefreshSession.plan, 'getting_buffed', 'an idle companion should refresh newbie buffs even when it or the leader has a stale selected target');
    assert.strictEqual(selectedTargetRefreshSession.roleDecision.reason, 'newbie_blessing', 'stale target ids must not produce wait_for_safe_moment outside combat');
    leader.destId = undefined;

    const inviteBot = fakeActor(2000033, { locX: 50, locY: 0 });
    const inviteBotSession = fakeSession('bot_invite_resting', inviteBot);
    inviteBotSession.plan = 'resting';
    const originalSetTimeout = global.setTimeout;
    const originalBotTell = BotManager.botTell;
    const originalInviteBotSessions = BotManager.sessions;
    const originalSocialSnapshot = BotSocialMemory.getSnapshot;
    const originalSocialRecordEvent = BotSocialMemory.recordEvent;
    let inviteTell = null;
    try {
        global.setTimeout = (callback) => {
            callback();
            return 0;
        };
        BotSocialMemory.getSnapshot = () => ({ trust: 0, familiarity: 0, recentlyAbandonedAt: null });
        BotSocialMemory.recordEvent = () => Promise.resolve(null);
        BotManager.botTell = (sourceSession, targetSession, text) => {
            assert.strictEqual(sourceSession, inviteBotSession, 'invite acknowledgement should come from invited bot');
            assert.strictEqual(targetSession, leaderSession, 'invite acknowledgement should target party leader');
            inviteTell = text;
        };
        BotManager.sessions = [inviteBotSession];

        assert.strictEqual(World.inviteBotCompanion(leaderSession, leader, inviteBotSession, 1, 'test_invite'), true, 'available resting bot should join the party');
    } finally {
        global.setTimeout = originalSetTimeout;
        BotManager.botTell = originalBotTell;
        BotManager.sessions = originalInviteBotSessions;
        BotSocialMemory.getSnapshot = originalSocialSnapshot;
        BotSocialMemory.recordEvent = originalSocialRecordEvent;
    }
    assert.strictEqual(inviteTell, `I'm with you. Lead the way.`, 'a recovered invite acknowledgement should not promise another rest');
    assert.strictEqual(inviteBotSession.plan, 'following', 'attaching a resting bot should resume party follow after instant recovery');
    inviteBot.level = 17;
    inviteBot.hp = 40;
    inviteBot.mp = 20;
    inviteBot.state.setSeated(true);
    World.user = { sessions: [leaderSession, inviteBotSession] };
    World.npc = { spawns: [] };
    World.fetchNpcsInRadius = () => [];
    RestingState.tick(inviteBotSession, inviteBot, {}, {
        getClosestNewbieGuide: () => ({ locX: 0, locY: 0, locZ: 0 }),
        say() {}
    });
    assert.strictEqual(inviteBotSession.plan, 'getting_buffed', 'a low-level companion accepted while resting in town should recover at the Newbie Guide');
    assert.strictEqual(inviteBot.state.fetchSeated(), false, 'Newbie Guide recovery should stand the invited companion up');
    assert.strictEqual(inviteBotSession.roleDecision.reason, 'newbie_guide_recovery', 'the city recovery transition should be visible in companion status');

    const movingBot = fakeActor(2000007, { locX: 500, locY: 0 });
    movingBot.state.setTowards('move');
    const movingSession = fakeSession('bot_moving_follow', movingBot);
    movingSession.followPlayerSession = leaderSession;
    movingSession.partyCompanion = true;
    movingSession.plan = 'following';
    movingSession.lastFollowMoveTarget = { locX: 40, locY: 0, locZ: 0 };
    World.user = { sessions: [leaderSession, movingSession] };
    World.fetchNpcsInRadius = () => [];

    FollowingState.tick(movingSession, movingBot, {}, { say() {}, executeCombat() {}, executePvPCombat() {} });

    assert.strictEqual(movingBot.moves.length, 0, 'companion should not restart follow movement while the existing waypoint is still useful');

    const arrivedBot = fakeActor(2000009, { locX: 0, locY: 0 });
    const arrivedSession = fakeSession('bot_arrived_follow', arrivedBot);
    arrivedSession.followPlayerSession = leaderSession;
    arrivedSession.partyCompanion = true;
    arrivedSession.plan = 'following';
    arrivedSession.lastTickLoc = { x: 0, y: 0 };
    arrivedSession.lastStuckSampleAt = Date.now();
    arrivedSession.stuckTicks = 2;
    World.user = { sessions: [leaderSession, arrivedSession] };
    FollowingState.tick(arrivedSession, arrivedBot, {}, { say() {}, executeCombat() {}, executePvPCombat() {} });
    assert.strictEqual(arrivedSession.stuckTicks, 0, 'arriving must clear stale stuck state before the next movement command');
    assert(movingSession.lastFollowMoveHeldAt, 'companion should record that a follow retarget was held');

    leader.state.setSeated(true);
    const campBot = fakeActor(2000014, { locX: 80, locY: 0 });
    const campSession = fakeSession('bot_camp_follow', campBot);
    campSession.followPlayerSession = leaderSession;
    campSession.partyCompanion = true;
    campSession.plan = 'following';
    World.user = { sessions: [leaderSession, campSession] };
    World.fetchNpcsInRadius = () => [];

    FollowingState.tick(campSession, campBot, {}, { say() {}, executeCombat() {}, executePvPCombat() {} });

    assert.strictEqual(campBot.state.fetchSeated(), true, 'companion should sit down when party leader sits nearby');
    assert.strictEqual(campSession.currentTargetId, undefined, 'sitting with leader should clear stale target');

    const farCampBot = fakeActor(2000015, { locX: 900, locY: 0 });
    const farCampSession = fakeSession('bot_far_camp_follow', farCampBot);
    farCampSession.followPlayerSession = leaderSession;
    farCampSession.partyCompanion = true;
    farCampSession.plan = 'following';
    World.user = { sessions: [leaderSession, farCampSession] };
    World.fetchNpcsInRadius = () => [];

    FollowingState.tick(farCampSession, farCampBot, {}, { say() {}, executeCombat() {}, executePvPCombat() {} });

    assert.strictEqual(farCampBot.moves.length, 1, 'far companion should move closer before sitting with leader');
    assert.strictEqual(farCampBot.state.fetchSeated(), false, 'far companion should not sit before reaching leader');

    leader.state.setSeated(false);
    campBot.state.setSeated(true);

    FollowingState.tick(campSession, campBot, {}, { say() {}, executeCombat() {}, executePvPCombat() {} });

    assert.strictEqual(campBot.state.fetchSeated(), false, 'fully recovered companion should stand when leader stands');

    const recoveringCampBot = fakeActor(2000016, { locX: 80, locY: 0, hp: 70, maxHp: 100 });
    recoveringCampBot.state.setSeated(true);
    const recoveringCampSession = fakeSession('bot_recovering_camp_follow', recoveringCampBot);
    recoveringCampSession.followPlayerSession = leaderSession;
    recoveringCampSession.partyCompanion = true;
    recoveringCampSession.plan = 'following';
    World.user = { sessions: [leaderSession, recoveringCampSession] };
    World.fetchNpcsInRadius = () => [];

    FollowingState.tick(recoveringCampSession, recoveringCampBot, {}, { say() {}, executeCombat() {}, executePvPCombat() {} });

    assert.strictEqual(recoveringCampBot.state.fetchSeated(), true, 'recovering companion should stay seated when leader stands without combat');

    const distantRecoveringBot = fakeActor(2000018, { locX: 1200, locY: 0, hp: 20, maxHp: 100, mp: 10, maxMp: 100 });
    distantRecoveringBot.state.setSeated(true);
    const distantRecoveringSession = fakeSession('bot_distant_recovering_companion', distantRecoveringBot);
    distantRecoveringSession.followPlayerSession = leaderSession;
    distantRecoveringSession.partyCompanion = true;
    distantRecoveringSession.plan = 'resting';
    leader.destId = undefined;
    World.user = { sessions: [leaderSession, distantRecoveringSession] };
    World.npc = { spawns: [] };
    World.fetchNpcsInRadius = () => [];

    RestingState.tick(distantRecoveringSession, distantRecoveringBot, {}, { say() {} });

    assert.strictEqual(distantRecoveringSession.plan, 'resting', 'recovering companion should not stand merely because its leader is far away');
    assert.strictEqual(distantRecoveringBot.state.fetchSeated(), true, 'recovering companion should remain seated until it can actually follow');

    const unknownMoveBot = fakeActor(2000008, { locX: 500, locY: 0 });
    unknownMoveBot.state.setTowards('move');
    const unknownMoveSession = fakeSession('bot_unknown_move_follow', unknownMoveBot);
    unknownMoveSession.followPlayerSession = leaderSession;
    unknownMoveSession.partyCompanion = true;
    unknownMoveSession.plan = 'following';
    World.user = { sessions: [leaderSession, unknownMoveSession] };
    World.fetchNpcsInRadius = () => [];

    FollowingState.tick(unknownMoveSession, unknownMoveBot, {}, { say() {}, executeCombat() {}, executePvPCombat() {} });

    assert.strictEqual(unknownMoveBot.moves.length, 1, 'companion should retarget when existing movement is not known to be a follow move');
    assert(unknownMoveSession.lastFollowMoveTarget, 'companion should record the new follow target after retargeting');

    const restingBot = fakeActor(2000003, { locX: 0, locY: 0 });
    restingBot.state.setSeated(true);
    const restingSession = fakeSession('bot_resting', restingBot);
    restingSession.followPlayerSession = leaderSession;
    restingSession.partyCompanion = true;
    restingSession.plan = 'resting';
    World.user = { sessions: [leaderSession, restingSession] };
    World.fetchNpcsInRadius = () => [{
        fetchId: () => 1001,
        fetchAttackable: () => true,
        isDead: () => false,
        fetchDestId: () => leader.fetchId(),
        fetchLocX: () => 50,
        fetchLocY: () => 0
    }];

    assert.strictEqual(PartyAwareness.partySessions(leaderSession).length, 2, 'party awareness should include the leader and resting companion');
    assert.strictEqual(
        PartyAwareness.findThreatTargetingParty(leaderSession)?.actor?.fetchId?.(),
        1001,
        'party awareness should expose an NPC that targets the party leader'
    );

    RestingState.tick(restingSession, restingBot, {}, { say() {} });

    assert.strictEqual(restingSession.plan, 'following', 'resting companion should wake when party is attacked');
    assert.strictEqual(restingBot.state.fetchSeated(), false, 'resting companion should stand before assisting');
    assert.strictEqual(restingSession.currentTargetId, 1001, 'resting companion should remember the threat target');

    leader.destId = 1005;
    const targetWakeBot = fakeActor(2000017, { locX: 0, locY: 0, hp: 60, maxHp: 100 });
    targetWakeBot.state.setSeated(true);
    const targetWakeSession = fakeSession('bot_target_wake', targetWakeBot);
    targetWakeSession.followPlayerSession = leaderSession;
    targetWakeSession.partyCompanion = true;
    targetWakeSession.plan = 'resting';
    const wakeTargetNpc = {
        fetchId: () => 1005,
        fetchAttackable: () => true,
        isDead: () => false,
        fetchLocX: () => 120,
        fetchLocY: () => 0
    };
    World.user = { sessions: [leaderSession, targetWakeSession] };
    World.npc = { spawns: [wakeTargetNpc] };
    World.fetchNpcsInRadius = () => [];

    RestingState.tick(targetWakeSession, targetWakeBot, {}, { say() {} });

    assert.strictEqual(targetWakeSession.plan, 'following', 'resting companion should wake when leader attacks a target');
    assert.strictEqual(targetWakeBot.state.fetchSeated(), false, 'resting companion should stand when leader attacks');
    assert.strictEqual(targetWakeSession.currentTargetId, 1005, 'resting companion should remember leader target');

    const restingPullBot = fakeActor(2000013, { locX: 80, locY: 0, hp: 20, maxHp: 100, mp: 10, maxMp: 100 });
    restingPullBot.state.setSeated(true);
    const restingPullSession = fakeSession('bot_resting_pull_pause', restingPullBot);
    restingPullSession.followPlayerSession = leaderSession;
    restingPullSession.partyCompanion = true;
    restingPullSession.plan = 'resting';
    const distantLeaderPull = {
        fetchId: () => 1013,
        fetchAttackable: () => true,
        isDead: () => false,
        fetchLocX: () => 1200,
        fetchLocY: () => 0,
        fetchLocZ: () => 0
    };
    PartyCompanionService.updateSettings(leaderSession, { pullMode: 'leader' });
    leader.destId = distantLeaderPull.fetchId();
    World.user = { sessions: [leaderSession, restingPullSession] };
    World.npc = { spawns: [distantLeaderPull] };
    World.fetchNpcsInRadius = () => [];

    RestingState.tick(restingPullSession, restingPullBot, {}, { say() {} });

    assert.strictEqual(restingPullSession.plan, 'resting', 'recovering companion should not wake for a leader pull that has not reached the party');
    assert.strictEqual(restingPullBot.state.fetchSeated(), true, 'pulling should stay paused while a companion is regenerating');
    PartyCompanionService.updateSettings(leaderSession, { pullMode: 'auto' });

    leader.destId = 1003;
    const assistingBot = fakeActor(2000006, { locX: 500, locY: 0 });
    const assistingSession = fakeSession('bot_assisting', assistingBot);
    assistingSession.followPlayerSession = leaderSession;
    assistingSession.partyCompanion = true;
    assistingSession.plan = 'following';
    const leaderTargetNpc = {
        fetchId: () => 1003,
        fetchAttackable: () => true,
        isDead: () => false,
        fetchLocX: () => 800,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchName: () => 'next mob'
    };
    World.user = { sessions: [leaderSession, assistingSession] };
    World.npc = { spawns: [leaderTargetNpc] };
    World.fetchNpcsInRadius = () => [];
    World.fetchUser = () => ({
        then: () => ({
            catch: (handler) => {
                handler();
            }
        })
    });
    World.fetchNpc = () => ({
        then: (handler) => {
            handler(leaderTargetNpc);
            return { catch() {} };
        }
    });

    FollowingState.tick(assistingSession, assistingBot, {}, {
        say() {},
        executeCombat() {},
        executePvPCombat() {}
    });

    assert.strictEqual(assistingBot.moves.length, 0, 'companion should not run back to leader while leader has a next target');
    assert.strictEqual(assistingSession.currentTargetId, 1003, 'companion should switch directly to the leader target');

    leader.destId = 1009;
    const staleTargetBot = fakeActor(2000023, { locX: 900, locY: 0 });
    const staleTargetSession = fakeSession('bot_stale_target_follow', staleTargetBot);
    staleTargetSession.followPlayerSession = leaderSession;
    staleTargetSession.partyCompanion = true;
    staleTargetSession.plan = 'following';
    staleTargetSession.currentTargetId = 1009;
    World.user = { sessions: [leaderSession, staleTargetSession] };
    World.npc = { spawns: [{
        fetchId: () => 1009,
        fetchAttackable: () => true,
        isDead: () => true,
        fetchLocX: () => 800,
        fetchLocY: () => 0
    }] };
    World.fetchNpcsInRadius = () => [];

    FollowingState.tick(staleTargetSession, staleTargetBot, {}, {
        say() {},
        executeCombat() {},
        executePvPCombat() {}
    });

    assert.strictEqual(staleTargetSession.currentTargetId, undefined, 'dead leader target should not keep companion in assist mode');
    assert.strictEqual(staleTargetBot.moves.length, 1, 'companion should resume following after stale combat target dies');

    leader.destId = undefined;
    const threatAssistBot = fakeActor(2000018, { locX: 120, locY: 0 });
    const threatAssistSession = fakeSession('bot_threat_assist', threatAssistBot);
    threatAssistSession.followPlayerSession = leaderSession;
    threatAssistSession.partyCompanion = true;
    threatAssistSession.plan = 'following';
    let assistedNpcId = null;
    const threatChat = [];
    leader.destId = undefined;
    World.user = { sessions: [leaderSession, threatAssistSession] };
    World.fetchNpcsInRadius = () => [{
        fetchId: () => 1006,
        fetchAttackable: () => true,
        isDead: () => false,
        fetchDestId: () => leader.fetchId(),
        fetchLocX: () => 80,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchName: () => 'angry mob'
    }];
    BotManager.botPartySay = (_session, text) => {
        threatChat.push(text);
        return true;
    };

    FollowingState.tick(threatAssistSession, threatAssistBot, {}, {
        say() {},
        executeCombat(session, bot, npc) { assistedNpcId = npc.fetchId(); },
        executePvPCombat() {}
    });

    assert.strictEqual(threatAssistSession.currentTargetId, 1006, 'companion with no target should acquire mob attacking leader');
    assert.strictEqual(assistedNpcId, 1006, 'companion should assist against mob attacking leader');
    assert.strictEqual(threatChat.length, 1, 'an unexpected mob on the leader should produce one party warning');
    assert.match(threatChat[0], /angry mob/, 'the party warning should identify the actual unexpected mob');

    FollowingState.tick(threatAssistSession, threatAssistBot, {}, {
        say() {},
        executeCombat() {},
        executePvPCombat() {}
    });
    assert.strictEqual(threatChat.length, 1, 'the same active add must not be repeated every AI tick');
    BotManager.botPartySay = originalBotPartySay;

    const hiddenAggroNpc = {
        fetchId: () => 1007,
        fetchAttackable: () => true,
        isDead: () => false,
        fetchDestId: () => undefined,
        fetchLocX: () => 80,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchName: () => 'hidden aggro mob'
    };
    const hiddenAggroBot = fakeActor(2000021, { locX: 120, locY: 0 });
    const hiddenAggroSession = fakeSession('bot_hidden_aggro_assist', hiddenAggroBot);
    hiddenAggroSession.followPlayerSession = leaderSession;
    hiddenAggroSession.partyCompanion = true;
    hiddenAggroSession.plan = 'following';
    let hiddenAggroAssistId = null;
    leaderSession.incomingThreatId = hiddenAggroNpc.fetchId();
    leaderSession.incomingThreatAt = Date.now();
    World.user = { sessions: [leaderSession, hiddenAggroSession] };
    World.npc = { spawns: [hiddenAggroNpc] };
    World.fetchNpcsInRadius = () => [hiddenAggroNpc];

    FollowingState.tick(hiddenAggroSession, hiddenAggroBot, {}, {
        say() {},
        executeCombat(session, bot, npc) { hiddenAggroAssistId = npc.fetchId(); },
        executePvPCombat() {}
    });

    assert.strictEqual(hiddenAggroSession.currentTargetId, hiddenAggroNpc.fetchId(), 'companion should acquire recent incoming mob even without npc dest target');
    assert.strictEqual(hiddenAggroAssistId, hiddenAggroNpc.fetchId(), 'companion should assist against recent incoming mob');
    leaderSession.incomingThreatId = undefined;
    leaderSession.incomingThreatAt = undefined;

    const selfDefenseNpc = {
        fetchId: () => 1008,
        fetchAttackable: () => true,
        isDead: () => false,
        fetchDestId: () => undefined,
        fetchLocX: () => 120,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchName: () => 'bot attacker'
    };
    const selfDefenseBot = fakeActor(2000022, { locX: 120, locY: 0 });
    const selfDefenseSession = fakeSession('bot_self_defense_assist', selfDefenseBot);
    selfDefenseSession.followPlayerSession = leaderSession;
    selfDefenseSession.partyCompanion = true;
    selfDefenseSession.plan = 'following';
    selfDefenseSession.incomingThreatId = selfDefenseNpc.fetchId();
    selfDefenseSession.incomingThreatAt = Date.now();
    let selfDefenseAssistId = null;
    World.user = { sessions: [leaderSession, selfDefenseSession] };
    World.npc = { spawns: [selfDefenseNpc] };
    World.fetchNpcsInRadius = () => [selfDefenseNpc];

    FollowingState.tick(selfDefenseSession, selfDefenseBot, {}, {
        say() {},
        executeCombat(session, bot, npc) { selfDefenseAssistId = npc.fetchId(); },
        executePvPCombat() {}
    });

    assert.strictEqual(selfDefenseSession.currentTargetId, selfDefenseNpc.fetchId(), 'companion should defend itself against recent incoming mob');
    assert.strictEqual(selfDefenseAssistId, selfDefenseNpc.fetchId(), 'companion should fight back when mob hits the bot');

    const hostileBot = fakeActor(2000019, { locX: 140, locY: 0, pvpFlag: 1, destId: leader.fetchId() });
    const hostileBotSession = fakeSession('bot_hostile_attacker', hostileBot);
    const pvpAssistBot = fakeActor(2000020, { locX: 120, locY: 0 });
    const pvpAssistSession = fakeSession('bot_pvp_threat_assist', pvpAssistBot);
    pvpAssistSession.followPlayerSession = leaderSession;
    pvpAssistSession.partyCompanion = true;
    pvpAssistSession.plan = 'following';
    let assistedPlayerId = null;
    World.user = { sessions: [leaderSession, pvpAssistSession, hostileBotSession] };
    World.fetchNpcsInRadius = () => [];

    FollowingState.tick(pvpAssistSession, pvpAssistBot, {}, {
        say() {},
        executeCombat() {},
        executePvPCombat(session, bot, target) { assistedPlayerId = target.fetchId(); }
    });

    assert.strictEqual(pvpAssistSession.currentTargetId, hostileBot.fetchId(), 'companion with no target should acquire bot attacking leader');
    assert.strictEqual(assistedPlayerId, hostileBot.fetchId(), 'companion should assist against bot attacking leader');

    const healerLeader = fakeActor(2000024, { locX: 0, locY: 0 });
    const healerLeaderSession = fakeSession('player_healer_party', healerLeader);
    const healerBot = fakeActor(2000025, { locX: 80, locY: 0, classId: 15 });
    learnSkill(healerBot, { selfId: 1011, name: 'Heal', spell: true, mp: 15 });
    learnSkill(healerBot, { selfId: 1040, name: 'Shield', spell: true, mp: 10 });
    const healerSession = fakeSession('bot_healer_party', healerBot);
    healerSession.followPlayerSession = healerLeaderSession;
    healerSession.partyCompanion = true;
    healerSession.plan = 'following';
    const woundedCompanion = fakeActor(2000026, { locX: 120, locY: 0, hp: 25, maxHp: 100 });
    const woundedCompanionSession = fakeSession('bot_wounded_party', woundedCompanion);
    woundedCompanionSession.followPlayerSession = healerLeaderSession;
    woundedCompanionSession.partyCompanion = true;
    woundedCompanionSession.plan = 'following';
    World.user = { sessions: [healerLeaderSession, healerSession, woundedCompanionSession] };
    World.fetchNpcsInRadius = () => [];
    const healerCasts = [];

    FollowingState.tick(healerSession, healerBot, {
        skillExec(session, bot, data) { healerCasts.push(data); }
    }, { say() {}, executeCombat() {}, executePvPCombat() {} });

    assert.deepStrictEqual(healerCasts, [{ id: woundedCompanion.fetchId(), selfId: 1011, ctrl: false }], 'an emergency heal must preempt a normal party buff instead of issuing two casts in one tick');
    assert.strictEqual(healerSession.roleDecision.action, 'heal_party', 'healer role decision should be party-wide');

    healerBot.mp = 20;
    healerBot.skillset.skills.find((skill) => skill.fetchSelfId() === 1011).model.mp = 30;
    const lowManaHealChat = [];
    BotManager.botPartySay = (_session, text) => {
        lowManaHealChat.push(text);
        return true;
    };
    FollowingState.tick(healerSession, healerBot, {
        skillExec() { throw new Error('a healer without enough MP must not cast'); }
    }, { say() {}, executeCombat() {}, executePvPCombat() {} });
    assert.strictEqual(healerSession.roleDecision.reason, 'low_mp_emergency', 'the healer should expose an emergency MP shortage in its role decision');
    assert.strictEqual(lowManaHealChat.length, 1, 'an emergency heal blocked by MP should be reported once to the party');
    assert.match(lowManaHealChat[0], /No MP|need MP/, 'the party should receive a concrete MP limitation instead of a fake heal confirmation');
    BotManager.botPartySay = originalBotPartySay;

    const healerAssistBot = fakeActor(2000027, { locX: 700, locY: 0, classId: 15 });
    const healerAssistSession = fakeSession('bot_healer_basic_assist', healerAssistBot);
    healerAssistSession.followPlayerSession = healerLeaderSession;
    healerAssistSession.partyCompanion = true;
    healerAssistSession.plan = 'following';
    const healerAssistThreat = {
        fetchId: () => 1012,
        fetchAttackable: () => true,
        isDead: () => false,
        fetchDestId: () => healerLeader.fetchId(),
        fetchLocX: () => 100,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchName: () => 'healer assist threat'
    };
    let healerAssistOptions = null;
    healerAssistBot.backpack.fetchEquippedWeapon = () => ({
        fetchKind: () => 'Weapon.Blunt',
        fetchName: () => 'Willow Staff'
    });
    World.user = { sessions: [healerLeaderSession, healerAssistSession] };
    World.npc = { spawns: [healerAssistThreat] };
    World.fetchNpcsInRadius = () => [healerAssistThreat];
    FollowingState.tick(healerAssistSession, healerAssistBot, {}, {
        say() {},
        executeCombat(_session, _bot, _npc, _generics, options) { healerAssistOptions = options; },
        executePvPCombat() {}
    });
    assert.strictEqual(healerAssistOptions, null, 'a healer with a staff should stay in support formation instead of attacking');
    assert.strictEqual(healerAssistBot.moves.length, 1, 'a healer with a staff should continue following the leader during combat');
    healerAssistBot.backpack.fetchEquippedWeapon = () => ({
        fetchKind: () => 'Weapon.Sword',
        fetchName: () => 'Orcish Sword'
    });
    FollowingState.tick(healerAssistSession, healerAssistBot, {}, {
        say() {},
        executeCombat(_session, _bot, _npc, _generics, options) { healerAssistOptions = options; },
        executePvPCombat() {}
    });
    assert.strictEqual(healerAssistOptions?.basicAttackOnly, true, 'a healer with a melee weapon may assist using only a basic attack');
    World.npc = { spawns: [] };
    World.fetchNpcsInRadius = () => [];

    const unskilledHealer = fakeActor(2000033, { locX: 90, locY: 0, classId: 15 });
    const unskilledHealerSession = fakeSession('bot_unskilled_healer', unskilledHealer);
    unskilledHealerSession.followPlayerSession = healerLeaderSession;
    unskilledHealerSession.partyCompanion = true;
    unskilledHealerSession.plan = 'following';
    World.user = { sessions: [healerLeaderSession, unskilledHealerSession, woundedCompanionSession] };
    let inventedHeal = false;
    FollowingState.tick(unskilledHealerSession, unskilledHealer, {
        skillExec() { inventedHeal = true; }
    }, { say() {}, executeCombat() {}, executePvPCombat() {} });
    assert.strictEqual(inventedHeal, false, 'healer should not cast a heal it has not learned');
    assert.strictEqual(unskilledHealer.skillset.skills.length, 0, 'party AI should not inject missing skills into the actor');
    assert.strictEqual(unskilledHealerSession.roleDecision.reason, 'no_learned_heal', 'missing heal capability should be observable');

    const unskilledTank = fakeActor(2000036, { locX: 90, locY: 0, classId: 4 });
    const unskilledTankSession = fakeSession('bot_unskilled_tank', unskilledTank);
    unskilledTankSession.followPlayerSession = healerLeaderSession;
    unskilledTankSession.partyCompanion = true;
    unskilledTankSession.plan = 'following';
    const tankThreat = {
        fetchId: () => 1009,
        fetchAttackable: () => true,
        isDead: () => false,
        fetchDestId: () => healerLeader.fetchId(),
        fetchLocX: () => 100,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchName: () => 'tank threat'
    };
    World.user = { sessions: [healerLeaderSession, unskilledTankSession] };
    World.npc = { spawns: [tankThreat] };
    World.fetchNpcsInRadius = () => [tankThreat];
    let inventedAggression = false;
    let tankFallbackTarget = null;
    FollowingState.tick(unskilledTankSession, unskilledTank, {
        skillExec() { inventedAggression = true; }
    }, {
        say() {},
        executeCombat(_session, _bot, npc) { tankFallbackTarget = npc.fetchId(); },
        executePvPCombat() {}
    });
    assert.strictEqual(inventedAggression, false, 'tank should not cast Aggression it has not learned');
    assert.strictEqual(unskilledTank.skillset.skills.length, 0, 'tank AI should not inject Aggression into the actor');
    assert.strictEqual(tankFallbackTarget, tankThreat.fetchId(), 'tank without Aggression should still defend with normal combat');

    const bufferLeader = fakeActor(2000027, { locX: 0, locY: 0 });
    const bufferLeaderSession = fakeSession('player_buffer_party', bufferLeader);
    const bufferBot = fakeActor(2000028, { locX: 80, locY: 0, classId: 17 });
    learnSkill(bufferBot, { selfId: 1040, name: 'Shield', spell: true, mp: 8 });
    const bufferSession = fakeSession('bot_buffer_party', bufferBot);
    bufferSession.followPlayerSession = bufferLeaderSession;
    bufferSession.partyCompanion = true;
    bufferSession.plan = 'following';
    EffectStore.apply(bufferLeader, {
        key: 'shield', id: 1040, level: 1, type: 'buff', stats: { pDefMul: 1.08 }, durationMs: 10 * 60 * 1000
    });
    EffectStore.apply(bufferBot, {
        key: 'shield', id: 1040, level: 1, type: 'buff', stats: { pDefMul: 1.08 }, durationMs: 10 * 60 * 1000
    });
    const unbuffedCompanion = fakeActor(2000029, { locX: 120, locY: 0 });
    const unbuffedCompanionSession = fakeSession('bot_unbuffed_party', unbuffedCompanion);
    unbuffedCompanionSession.followPlayerSession = bufferLeaderSession;
    unbuffedCompanionSession.partyCompanion = true;
    unbuffedCompanionSession.plan = 'following';
    World.user = { sessions: [bufferLeaderSession, bufferSession, unbuffedCompanionSession] };
    let buffedTargetId = null;
    let appliedBuffSkillId = null;

    FollowingState.tick(bufferSession, bufferBot, {
        skillExec(_session, _bot, data) {
            buffedTargetId = data.id;
            appliedBuffSkillId = data.selfId;
        }
    }, { say() {}, executeCombat() {}, executePvPCombat() {} });

    assert.strictEqual(buffedTargetId, unbuffedCompanion.fetchId(), 'buffer should refresh buffs on party companions');
    assert.strictEqual(appliedBuffSkillId, 1040, 'buffer should cast its learned Shield skill');

    const fieldRefreshLeader = fakeActor(2000033, { locX: 0, locY: 0, level: 10 });
    const fieldRefreshLeaderSession = fakeSession('player_field_refresh_party', fieldRefreshLeader);
    const fieldRefreshBot = fakeActor(2000036, { locX: 80, locY: 0, level: 10 });
    Object.keys(fieldRefreshBot.activeBuffs).forEach((key) => { fieldRefreshBot.activeBuffs[key] = 0; });
    const fieldRefreshSession = fakeSession('bot_field_refresh_party', fieldRefreshBot);
    fieldRefreshSession.followPlayerSession = fieldRefreshLeaderSession;
    fieldRefreshSession.partyCompanion = true;
    fieldRefreshSession.plan = 'following';
    World.user = { sessions: [fieldRefreshLeaderSession, fieldRefreshSession] };
    FollowingState.tick(fieldRefreshSession, fieldRefreshBot, {}, {
        getClosestNewbieGuide: () => ({ locX: -84081, locY: 243227, locZ: -3723 }),
        say() {}, executeCombat() {}, executePvPCombat() {}
    });
    assert.notStrictEqual(fieldRefreshSession.plan, 'getting_buffed', 'companion should keep following until the player reaches a Newbie Guide town');
    assert.strictEqual(fieldRefreshSession.roleDecision.reason, 'wait_for_newbie_guide_town', 'field companion should explain why it did not leave for a distant Newbie Guide');

    const overleveledRefreshBot = fakeActor(2000046, { locX: 80, locY: 0, level: 21 });
    Object.keys(overleveledRefreshBot.activeBuffs).forEach((key) => { overleveledRefreshBot.activeBuffs[key] = 0; });
    const overleveledRefreshSession = fakeSession('bot_overleveled_refresh_party', overleveledRefreshBot);
    overleveledRefreshSession.followPlayerSession = fieldRefreshLeaderSession;
    overleveledRefreshSession.partyCompanion = true;
    overleveledRefreshSession.plan = 'following';
    World.user = { sessions: [fieldRefreshLeaderSession, overleveledRefreshSession] };
    FollowingState.tick(overleveledRefreshSession, overleveledRefreshBot, {}, {
        getClosestNewbieGuide: () => ({ locX: -84081, locY: 243227, locZ: -3723 }),
        say() {}, executeCombat() {}, executePvPCombat() {}
    });
    assert.notStrictEqual(overleveledRefreshSession.roleDecision?.reason, 'wait_for_newbie_guide_town', 'companions above level 20 must not wait for Newbie Guide buffs');
    assert.notStrictEqual(overleveledRefreshSession.plan, 'getting_buffed', 'companions above level 20 must not start a Newbie Guide trip');

    const refreshLeader = fakeActor(2000034, { locX: -84081, locY: 243227, locZ: -3723, level: 10 });
    const refreshLeaderSession = fakeSession('player_refresh_party', refreshLeader);
    const refreshBot = fakeActor(2000035, { locX: -84001, locY: 243227, locZ: -3723, level: 10 });
    Object.keys(refreshBot.activeBuffs).forEach((key) => { refreshBot.activeBuffs[key] = 0; });
    const refreshSession = fakeSession('bot_refresh_party', refreshBot);
    refreshSession.followPlayerSession = refreshLeaderSession;
    refreshSession.partyCompanion = true;
    refreshSession.plan = 'following';
    World.user = { sessions: [refreshLeaderSession, refreshSession] };
    FollowingState.tick(refreshSession, refreshBot, {}, {
        getClosestNewbieGuide: () => ({ locX: -84081, locY: 243227, locZ: -3723 }),
        say() {}, executeCombat() {}, executePvPCombat() {}
    });
    assert.strictEqual(refreshSession.plan, 'getting_buffed', 'safe companion should leave briefly for a Newbie Guide when the player is in its town');
    assert.strictEqual(refreshSession.resumeAfterBuff?.plan, 'following', 'buff refresh should preserve the companion return plan');

    const recoveryLeader = fakeActor(2000043, { locX: -84081, locY: 243227, locZ: -3723, level: 10 });
    const recoveryLeaderSession = fakeSession('player_newbie_recovery_party', recoveryLeader);
    const recoveryBot = fakeActor(2000044, { locX: -84001, locY: 243227, locZ: -3723, level: 20, hp: 20, maxHp: 100, mp: 100, maxMp: 100 });
    const recoverySession = fakeSession('bot_newbie_recovery_party', recoveryBot);
    recoverySession.followPlayerSession = recoveryLeaderSession;
    recoverySession.partyCompanion = true;
    recoverySession.plan = 'following';
    World.user = { sessions: [recoveryLeaderSession, recoverySession] };
    FollowingState.tick(recoverySession, recoveryBot, {}, {
        getClosestNewbieGuide: () => ({ locX: -84081, locY: 243227, locZ: -3723 }),
        say() {}, executeCombat() {}, executePvPCombat() {}
    });
    assert.strictEqual(recoverySession.plan, 'getting_buffed', 'a low-level companion already in a Newbie Guide town should recover there instead of sitting');
    assert.strictEqual(recoverySession.roleDecision.reason, 'newbie_guide_recovery', 'Newbie Guide recovery should be visible in bot status');

    const fieldRecoveryBot = fakeActor(2000045, { locX: 0, locY: 0, level: 20, hp: 20, maxHp: 100, mp: 100, maxMp: 100 });
    const fieldRecoverySession = fakeSession('bot_field_recovery_party', fieldRecoveryBot);
    fieldRecoverySession.followPlayerSession = fieldRefreshLeaderSession;
    fieldRecoverySession.partyCompanion = true;
    fieldRecoverySession.plan = 'following';
    World.user = { sessions: [fieldRefreshLeaderSession, fieldRecoverySession] };
    FollowingState.tick(fieldRecoverySession, fieldRecoveryBot, {}, {
        getClosestNewbieGuide: () => ({ locX: -84081, locY: 243227, locZ: -3723 }),
        say() {}, executeCombat() {}, executePvPCombat() {}
    });
    assert.strictEqual(fieldRecoverySession.plan, 'resting', 'a low-level companion must not travel from a farming field to recover at a Newbie Guide');

    const errandLeader = fakeActor(2000037, { locX: 83396, locY: 147904, locZ: -3404 });
    const errandLeaderSession = fakeSession('player_town_errand_party', errandLeader);
    const errandBot = fakeActor(2000038, { locX: 83436, locY: 147904, locZ: -3404 });
    const errandSession = fakeSession('bot_town_errand_party', errandBot);
    errandSession.followPlayerSession = errandLeaderSession;
    errandSession.partyCompanion = true;
    errandSession.plan = 'following';
    const errandLines = [];
    BotManager.sessions = [];
    BotManager.botPartySay = (_session, text) => {
        errandLines.push(text);
        return true;
    };
    World.user = { sessions: [errandLeaderSession, errandSession] };
    FollowingState.tick(errandSession, errandBot, {}, {
        getClosestNewbieGuide: () => ({ locX: -84081, locY: 243227, locZ: -3723 }),
        getClosestTown: () => ({ name: 'Giran', x: 83396, y: 147904, z: -3404 }),
        say(_session, text) { errandLines.push(text); }, executeCombat() {}, executePvPCombat() {}
    });
    BotManager.botPartySay = originalBotPartySay;
    assert.strictEqual(errandSession.plan, 'shopping', 'companion with no shots should make a brief errand only after the party reaches town');
    assert.strictEqual(errandSession.companionShopping?.kind, 'restock_shots', 'town errand should describe the actual missing supply');
    assert.strictEqual(errandSession.shoppingTarget?.town, 'Giran', 'companion errand should stay in the player town');
    assert(errandLines.some((line) => line.includes('returning') || line.includes('back to camp')), 'companion should announce its return before shopping');
    assert.strictEqual(errandBot.fetchPrivateStore?.(), undefined, 'companion errand must never create a private sale store');

    const marketSeller = fakeActor(2000039, { locX: 83500, locY: 147904, locZ: -3404 });
    const marketBot = fakeActor(2000040, { locX: 83456, locY: 147904, locZ: -3404 });
    const marketSession = fakeSession('bot_market_errand_party', marketBot);
    marketSession.followPlayerSession = errandLeaderSession;
    marketSession.partyCompanion = true;
    marketSession.plan = 'following';
    marketSession.coldLifeState = { stats: { equipmentPlan: { strategy: 'market', target: { selfId: 1 } } } };
    MarketOpportunity.findOffers = () => ([{
        sourceType: 'private_store', sourceId: marketSeller.fetchId(), itemName: 'Sword of Reflection', price: 0,
        town: 'Giran', session: { accountId: 'bot_market_seller', actor: marketSeller }
    }]);
    World.user = { sessions: [errandLeaderSession, marketSession, { accountId: 'seller', actor: marketSeller }] };
    FollowingState.tick(marketSession, marketBot, {}, {
        getClosestNewbieGuide: () => ({ locX: -84081, locY: 243227, locZ: -3723 }),
        getClosestTown: () => ({ name: 'Giran', x: 83396, y: 147904, z: -3404 }),
        say() {}, executeCombat() {}, executePvPCombat() {}
    });
    assert.strictEqual(marketSession.companionShopping?.kind, 'market_purchase', 'companion should prefer an available planned market upgrade in town');
    assert.strictEqual(marketSession.shoppingTarget?.actorId, marketSeller.fetchId(), 'companion market errand should walk to the live seller');
    MarketOpportunity.findOffers = originalFindOffers;

    const starterTownLeader = fakeActor(2000046, { locX: 45475, locY: 48359, locZ: -3060 });
    const starterTownLeaderSession = fakeSession('player_elven_town_errand_party', starterTownLeader);
    const starterTownSeller = fakeActor(2000047, { locX: 45520, locY: 48359, locZ: -3060 });
    const starterTownBot = fakeActor(2000048, { locX: 45500, locY: 48359, locZ: -3060 });
    const starterTownSession = fakeSession('bot_elven_town_market_errand', starterTownBot);
    starterTownSession.followPlayerSession = starterTownLeaderSession;
    starterTownSession.partyCompanion = true;
    starterTownSession.plan = 'following';
    starterTownSession.coldLifeState = { stats: { equipmentPlan: { strategy: 'market', target: { selfId: 1 } } } };
    MarketOpportunity.findOffers = () => ([{
        sourceType: 'private_store', sourceId: starterTownSeller.fetchId(), itemName: 'Sword of Reflection', price: 0,
        town: 'Elven Village', session: { accountId: 'bot_elven_market_seller', actor: starterTownSeller }
    }]);
    World.user = { sessions: [starterTownLeaderSession, starterTownSession, { accountId: 'seller', actor: starterTownSeller }] };
    World.fetchNpcsInRadius = () => [];
    FollowingState.tick(starterTownSession, starterTownBot, {}, {
        getClosestNewbieGuide: () => ({ locX: 45475, locY: 48359, locZ: -3060 }),
        getClosestTown: () => ({ name: 'Elven Village', x: 46926, y: 51511, z: -2976 }),
        say() {}, executeCombat() {}, executePvPCombat() {}
    });
    assert.strictEqual(starterTownSession.companionShopping?.kind, 'market_purchase', 'a starter village outside the movement atlas must still allow normal in-town errands');
    MarketOpportunity.findOffers = originalFindOffers;

    const fieldNearStarterLeader = fakeActor(2000051, { locX: 49475, locY: 48359, locZ: -3060 });
    const fieldNearStarterLeaderSession = fakeSession('player_near_elven_field_party', fieldNearStarterLeader);
    const fieldNearStarterBot = fakeActor(2000052, { locX: 49500, locY: 48359, locZ: -3060 });
    const fieldNearStarterSession = fakeSession('bot_near_elven_field_market', fieldNearStarterBot);
    fieldNearStarterSession.followPlayerSession = fieldNearStarterLeaderSession;
    fieldNearStarterSession.partyCompanion = true;
    fieldNearStarterSession.plan = 'following';
    fieldNearStarterSession.coldLifeState = { stats: { equipmentPlan: { strategy: 'market', target: { selfId: 1 } } } };
    MarketOpportunity.findOffers = () => ([{
        sourceType: 'private_store', sourceId: starterTownSeller.fetchId(), itemName: 'Sword of Reflection', price: 0,
        town: 'Elven Village', session: { accountId: 'bot_elven_market_seller', actor: starterTownSeller }
    }]);
    World.user = { sessions: [fieldNearStarterLeaderSession, fieldNearStarterSession, { accountId: 'seller', actor: starterTownSeller }] };
    FollowingState.tick(fieldNearStarterSession, fieldNearStarterBot, {}, {
        getClosestNewbieGuide: () => ({ locX: 45475, locY: 48359, locZ: -3060 }),
        getClosestTown: () => ({ name: 'Elven Village', x: 46926, y: 51511, z: -2976 }),
        say() {}, executeCombat() {}, executePvPCombat() {}
    });
    assert.notStrictEqual(fieldNearStarterSession.companionShopping?.kind, 'market_purchase', 'a nearby farming field must not be treated as a starter village market');
    MarketOpportunity.findOffers = originalFindOffers;

    World.user = { sessions: [bufferLeaderSession, bufferSession, unbuffedCompanionSession] };

    const compactPartyStatus = BotBrainContext.compactStatus(
        bufferSession,
        BotStatus.getStatus(bufferSession),
        'how is the party?'
    );
    assert.strictEqual(compactPartyStatus.party.members.length, 3, 'BotBrain context should include all party members');
    assert(compactPartyStatus.party.members.some((member) => member.name === unbuffedCompanion.fetchName() && member.hpPct === 100), 'compact party context should expose companion vitals');
    assert(compactPartyStatus.party.members.some((member) => member.name === bufferBot.fetchName() && member.self === true), 'compact party context should mark the bot itself');
    assert(compactPartyStatus.party.members.some((member) => member.name === bufferLeader.fetchName() && member.leader === true), 'compact party context should mark the leader');

    const rewardLeader = fakeActor(2000010, { locX: 0, locY: 0 });
    const rewardLeaderSession = fakeSession('player_reward', rewardLeader);
    const rewardBot = fakeActor(2000011, { locX: 80, locY: 0 });
    const rewardBotSession = fakeSession('bot_reward', rewardBot);
    rewardBotSession.followPlayerSession = rewardLeaderSession;
    rewardBotSession.partyCompanion = true;
    rewardBotSession.plan = 'hunting';
    World.user = { sessions: [rewardLeaderSession, rewardBotSession] };
    World.removeNpc = () => {};

    NpcDied(rewardBotSession, rewardBot, {
        fetchId: () => 1004,
        fetchLocX: () => 60,
        fetchLocY: () => 0,
        fetchAcquiredExp: () => 100,
        fetchRewardSp: () => 20
    });

    assert.strictEqual(rewardLeader.fetchExp(), 65, 'two eligible party members should receive the C4 1.30 party EXP bonus');
    assert.strictEqual(rewardLeader.fetchSp(), 13, 'two eligible party members should receive the C4 1.30 party SP bonus');
    assert.strictEqual(rewardBot.fetchExp(), 65, 'companion should receive its squared-level share of the party EXP bonus');
    assert.strictEqual(rewardBot.fetchSp(), 13, 'companion should receive its squared-level share of the party SP bonus');

    const partyHudLeader = fakeActor(2000030, { locX: 0, locY: 0 });
    const partyHudLeaderSession = fakeSession('player_party_hud', partyHudLeader);
    const partyHudBotA = fakeActor(2000031, { locX: 40, locY: 0, classId: 4 });
    const partyHudBotASession = fakeSession('bot_party_hud_a', partyHudBotA);
    const partyHudBotB = fakeActor(2000032, { locX: 80, locY: 0 });
    const partyHudBotBSession = fakeSession('bot_party_hud_b', partyHudBotB);
    BotManager.sessions = [partyHudBotASession, partyHudBotBSession];

    assert.strictEqual(PartyCompanionService.attach(partyHudLeaderSession, partyHudBotASession, { distribution: 0 }), true, 'first companion should attach');
    assert.strictEqual(PartyCompanionService.attach(partyHudLeaderSession, partyHudBotBSession), true, 'second companion should attach');

    const twoMemberPacket = lastPartyAllPacket(partyHudLeaderSession);
    assert(twoMemberPacket, 'attaching companions should send a party window packet');
    assert.strictEqual(twoMemberPacket.readInt32LE(5), 0, 'party window should preserve the native loot distribution from invite');
    assert.strictEqual(twoMemberPacket.readInt32LE(9), 2, 'party window should include both active companions');
    assert.deepStrictEqual(
        PartyCompanionService.membersForLeader(partyHudLeaderSession).map((memberSession) => memberSession.actor.fetchName()),
        [partyHudBotA.fetchName(), partyHudBotB.fetchName()],
        'service should preserve both server-side companions'
    );

    World.user = { sessions: [partyHudLeaderSession, partyHudBotASession, partyHudBotBSession] };
    World.fetchNpcsInRadius = () => [];
    assert.deepStrictEqual(
        PartyPulling.supportProviders(partyHudLeaderSession),
        [partyHudBotA, partyHudBotB],
        'the human leader must be a buff recipient, not an autonomous support provider'
    );
    const supportPullTarget = fakeActor(2000049, { locX: 0, locY: 0 });
    const supportPuller = fakeActor(2000050, { locX: 0, locY: 0, classId: 15 });
    assert.strictEqual(
        PartyPulling.canDeliverPull(supportPuller, supportPullTarget),
        true,
        'a healer in weapon range must release a player-led pull when it is the only companion able to engage'
    );
    partyHudBotASession.lastTargetEvaluation = {
        targetId: 9001,
        targetName: 'Keltir',
        score: 112,
        reasons: ['same_spot', 'direct_path'],
        at: Date.now()
    };
    partyHudBotASession.lastCombatDecision = {
        action: 'cast_skill',
        skillId: 1234,
        skillName: 'Power Strike',
        score: 48,
        reasons: ['fighter_skill', 'in_range'],
        at: Date.now()
    };
    partyHudBotASession.lastPvpDecision = {
        action: 'fight',
        threatId: 9002,
        threatName: 'RedPlayer',
        score: 1.4,
        reasons: ['self_defense', 'allies:1'],
        at: Date.now()
    };
    const tacticalStatus = BotStatus.getStatus(partyHudBotASession);
    assert.strictEqual(tacticalStatus.decisions.target.score, 112, 'bot status should expose target scoring');
    assert.strictEqual(tacticalStatus.decisions.combat.skillId, 1234, 'bot status should expose combat skill selection');
    assert.strictEqual(tacticalStatus.decisions.pvp.action, 'fight', 'bot status should expose PvP risk decisions');
    assert(BotStatus.decisionSummary(tacticalStatus.decisions.target, 'target').includes('Keltir score 112'), 'target decision should have a compact UI summary');
    assert(BotStatus.decisionSummary(tacticalStatus.decisions.combat, 'combat').includes('Power Strike score 48'), 'combat decision should have a compact UI summary');
    assert(BotStatus.decisionSummary(tacticalStatus.decisions.pvp, 'pvp').includes('fight vs RedPlayer score 1.4'), 'PvP decision should have a compact UI summary');
    const tacticalLog = BotStatus.summarize(tacticalStatus);
    assert(tacticalLog.includes('targetScore=112'), 'runtime summary should include target score');
    assert(tacticalLog.includes('combat=1234/48'), 'runtime summary should include combat choice');
    assert(tacticalLog.includes('pvp=fight/1.4'), 'runtime summary should include PvP choice');
    partyHudBotA.locX = 520;
    partyHudBotB.locX = 540;
    partyHudBotA.moves = [];
    partyHudBotB.moves = [];
    FollowingState.tick(partyHudBotASession, partyHudBotA, {}, { say() {}, executeCombat() {}, executePvPCombat() {} });
    FollowingState.tick(partyHudBotBSession, partyHudBotB, {}, { say() {}, executeCombat() {}, executePvPCombat() {} });
    assert(partyHudBotASession.lastFollowMoveTarget, 'first companion should get a formation follow target');
    assert(partyHudBotBSession.lastFollowMoveTarget, 'second companion should get a formation follow target');
    assert.notDeepStrictEqual(
        partyHudBotASession.lastFollowMoveTarget,
        partyHudBotBSession.lastFollowMoveTarget,
        'companions should occupy different formation slots'
    );
    assert.deepStrictEqual(
        PartyCompanionService.formationTargetFor(partyHudBotASession),
        { locX: partyHudLeader.fetchLocX() + 90, locY: partyHudLeader.fetchLocY(), locZ: partyHudLeader.fetchLocZ(), slot: 0 },
        'a tank should use the forward screen formation slot'
    );

    const casterBot = fakeActor(2000033, { locX: 20, locY: 0, classId: 17 });
    const casterSession = fakeSession('bot_party_caster', casterBot);
    casterSession.followPlayerSession = partyHudLeaderSession;
    casterSession.partyCompanion = true;
    casterSession.plan = 'following';
    originalApplySupportBuff(partyHudBotASession, partyHudBotA, 'shield', { calculateStats() {} }, {
        casterSession,
        caster: casterBot
    });
    assert(EffectStore.packetEffects(partyHudBotA).some((effect) => effect.id === 1040), 'support buff should be stored as a structured effect');
    assert.deepStrictEqual(
        EffectStore.list(partyHudBotA).find((effect) => effect.key === 'shield').stats,
        { pDefMul: 1.12 },
        'newbie and support Shield must retain C4 stats so the planner recognises it as active'
    );
    const partyShieldPacket = lastPartySpelledPacket(partyHudLeaderSession, partyHudBotA.fetchId());
    assert(partyShieldPacket, 'support buff should refresh native party effect icons');
    assert.strictEqual(partyShieldPacket.readInt32LE(13), 1040, 'party effect packet should include shield skill id');
    assert(casterSession.packets.some((packet) => packet[0] === 0x48 && packet.readInt32LE(5) === partyHudBotA.fetchId()), 'support buff should broadcast a visible skill cast from the caster');

    EffectStore.apply(partyHudBotB, {
        key: 'stun',
        id: 101,
        level: 1,
        name: 'Stun',
        type: 'debuff',
        category: 'stun',
        durationMs: 30000
    });
    partyHudBotB.moves = [];
    partyHudBotB.locX = 900;
    FollowingState.tick(partyHudBotBSession, partyHudBotB, {}, { say() {}, executeCombat() {}, executePvPCombat() {} });
    assert.strictEqual(partyHudBotB.moves.length, 0, 'stunned companion should not follow or fight');
    assert.strictEqual(partyHudBotBSession.roleDecision.action, 'disabled', 'stunned companion should expose disabled behavior state');
    assert(BotStatus.getStatus(partyHudBotBSession).debuffs.some((effect) => effect.key === 'stun'), 'bot status should expose active debuffs');
    EffectStore.remove(partyHudBotB, 'stun');
    partyHudBotB.locX = 80;

    PartyCompanionService.rebuildWindow(partyHudLeaderSession, 2);
    const changedDistributionPacket = lastPartyAllPacket(partyHudLeaderSession);
    assert(changedDistributionPacket, 'explicit party distribution update should rebuild the party window');
    assert.strictEqual(changedDistributionPacket.readInt32LE(5), 2, 'explicit party distribution update should be stored');
    assert.strictEqual(changedDistributionPacket.readInt32LE(9), 2, 'distribution update should keep both party members');

    const lootTarget = {
        fetchLocX: () => 0,
        fetchLocY: () => 0
    };
    PartyCompanionService.updateSettings(partyHudLeaderSession, { distribution: 3, itemLastLootIndex: -1 });
    assert.strictEqual(
        PartyCompanionService.resolveLootSession(partyHudBotASession, 1864, lootTarget),
        partyHudLeaderSession,
        'by-turn loot should first route party drops to the leader'
    );
    assert.strictEqual(
        PartyCompanionService.resolveLootSession(partyHudBotASession, 1864, lootTarget),
        partyHudBotASession,
        'by-turn loot should rotate to the next companion'
    );
    assert.strictEqual(
        PartyCompanionService.resolveLootSession(partyHudBotASession, 1864, lootTarget),
        partyHudBotBSession,
        'by-turn loot should include every nearby party member'
    );
    PartyCompanionService.updateSettings(partyHudLeaderSession, { distribution: 0 });
    assert.strictEqual(
        PartyCompanionService.resolveLootSession(partyHudBotBSession, 1864, lootTarget),
        partyHudBotBSession,
        'finders keepers loot should stay with the looter'
    );
    const adenaAllocations = PartyCompanionService.adenaAllocations(partyHudBotASession, 10, lootTarget);
    assert.strictEqual(adenaAllocations.reduce((sum, entry) => sum + entry.amount, 0), 10, 'party adena split should preserve the full amount');
    assert.deepStrictEqual(
        adenaAllocations.map((entry) => entry.session),
        [partyHudLeaderSession, partyHudBotASession, partyHudBotBSession],
        'party adena split should include every nearby party member'
    );
    PartyCompanionService.rebuildWindow(partyHudLeaderSession, 2);

    partyHudBotASession.currentTargetId = 3001;
    partyHudBotBSession.currentTargetId = 3002;
    CompanionControl(partyHudLeaderSession, ['companion-control', 'combat', 'protect']);
    assert.strictEqual(PartyCompanionService.getSettings(partyHudLeaderSession).combatMode, 'protect', 'party control should store combat mode');
    assert.strictEqual(partyHudBotASession.currentTargetId, undefined, 'combat mode change should clear stale companion targets');
    assert.strictEqual(partyHudBotBSession.currentTargetId, undefined, 'combat mode change should clear stale party targets');

    CompanionControl(partyHudLeaderSession, ['companion-control', 'movement', 'hold']);
    assert.strictEqual(PartyCompanionService.getSettings(partyHudLeaderSession).movementMode, 'hold', 'party control should store movement mode');
    assert.strictEqual(partyHudBotASession.botStay, true, 'hold mode should park the first companion');
    assert.strictEqual(partyHudBotBSession.botStay, true, 'hold mode should park the second companion');
    assert(partyHudBotASession.stayLocation, 'hold mode should record a stay location');

    CompanionControl(partyHudLeaderSession, ['companion-control', 'movement', 'follow']);
    assert.strictEqual(partyHudBotASession.botStay, false, 'follow mode should release held companions');
    assert.strictEqual(partyHudBotBSession.botStay, false, 'follow mode should release the full group');

    const pulledMob = {
        id: 3011,
        locX: 1200,
        locY: 0,
        fetchId() { return this.id; },
        fetchAttackable: () => true,
        isDead: () => false,
        fetchLevel: () => 26,
        destId: undefined,
        fetchDestId() { return this.destId; },
        fetchLocX() { return this.locX; },
        fetchLocY() { return this.locY; },
        fetchLocZ: () => 0,
        fetchName: () => 'pull target'
    };
    World.npc = { spawns: [pulledMob] };
    World.fetchNpcsInRadius = () => [pulledMob];
    partyHudBotA.locX = 40;
    partyHudBotB.locX = 80;
    partyHudBotA.moves = [];
    partyHudBotB.moves = [];
    let pulledTargetId = null;
    let openingPullCombatOptions = null;
    const pullChat = [];
    BotManager.botPartySay = (_session, text) => {
        pullChat.push(text);
        return true;
    };

    CompanionControl(partyHudLeaderSession, ['companion-control', 'member-pull', 'on', partyHudBotA.fetchName()]);
    assert.strictEqual(PartyCompanionService.getSettings(partyHudLeaderSession).pullMode, 'bot', 'assigning a bot to pull should enable the dedicated bot pull mode');
    assert.strictEqual(PartyCompanionService.getSettings(partyHudLeaderSession).pullerId, partyHudBotA.fetchId(), 'party should use the bot explicitly selected by the player as puller');
    assert.strictEqual(BotStatus.getStatus(partyHudBotASession).party.stance, 'pulling', 'selected companion should expose pulling as its party stance');
    FollowingState.tick(partyHudBotASession, partyHudBotA, {}, {
        say(_session, text) { pullChat.push(text); },
        executeCombat(_session, _bot, npc) { pulledTargetId = npc.fetchId(); },
        executePvPCombat() {}
    });
    assert.strictEqual(partyHudBotASession.roleDecision.action, 'party_pull', 'tank should become the assigned party puller before generic DPS');
    assert.strictEqual(partyHudBotASession.roleDecision.reason, 'approach', 'assigned puller should run to the nearest target first');
    assert.strictEqual(partyHudBotA.moves.length, 1, 'puller should walk to the selected mob before aggroing it');
    assert.strictEqual(partyHudLeaderSession.partyPullState.targetId, pulledMob.fetchId(), 'party should keep one shared pull target');

    partyHudBotA.state.setTowards('move');
    FollowingState.tick(partyHudBotASession, partyHudBotA, {}, {
        say() {}, executeCombat() {}, executePvPCombat() {}
    });
    assert.strictEqual(partyHudBotA.moves.length, 1, 'an active pull approach must keep its current route instead of restarting pathfinding every AI tick');

    partyHudBotASession.stuckTicks = 3;
    FollowingState.tick(partyHudBotASession, partyHudBotA, {}, {
        say() {}, executeCombat() {}, executePvPCombat() {}
    });
    assert.strictEqual(partyHudBotA.moves.length, 1, 'a stale generic stuck sample must not restart a healthy pull route');
    assert.strictEqual(partyHudBotASession.stuckTicks, 0, 'active pull movement should clear stale generic stuck state');

    FollowingState.tick(partyHudBotBSession, partyHudBotB, {}, {
        say() {}, executeCombat() { throw new Error('non-puller must wait for the incoming mob'); }, executePvPCombat() {}
    });
    assert.strictEqual(partyHudBotBSession.roleDecision.action, 'follow_leader', 'non-puller should keep following while the mob is outside its attack range');
    assert.strictEqual(partyHudBotBSession.roleDecision.reason, 'hold_for_pull', 'following companion must not chase the marked pull target');

    partyHudLeader.locX = 600;
    partyHudBotB.moves = [];
    FollowingState.tick(partyHudBotBSession, partyHudBotB, {}, {
        say() {}, executeCombat() { throw new Error('non-puller must follow the leader, not chase the distant pull target'); }, executePvPCombat() {}
    });
    assert.strictEqual(partyHudBotB.moves.length, 1, 'a held pull must not stop the companion from following a moving leader');
    assert(
        partyHudBotB.moves[0].to.locX > partyHudBotB.locX && partyHudBotB.moves[0].to.locX < pulledMob.locX,
        'held-pull movement should head to the leader formation target, not the distant mob'
    );
    partyHudLeader.locX = 0;

    learnSkill(partyHudBotA, { selfId: 28, name: 'Aggression', mp: 5, distance: 400 });
    partyHudBotA.locX = pulledMob.locX;
    FollowingState.tick(partyHudBotASession, partyHudBotA, {}, {
        say(_session, text) { pullChat.push(text); },
        executeCombat(_session, _bot, npc, _generics, options) {
            pulledTargetId = npc.fetchId();
            openingPullCombatOptions = options;
        },
        executePvPCombat() {}
    });
    assert.strictEqual(pulledTargetId, pulledMob.fetchId(), 'tank should aggro the pull target');
    assert.strictEqual(
        openingPullCombatOptions?.basicAttackOnly,
        true,
        'opening pull aggro must use a basic attack even when the tank knows Aggression'
    );
    assert(pullChat.some((text) => text.includes('pull target')), 'puller should announce the specific mob in party chat');

    partyHudLeaderSession.partyPullState.aggroRequestedAt = Date.now() - 3000;
    partyHudBotA.state.casts = true;
    FollowingState.tick(partyHudBotASession, partyHudBotA, {}, {
        say() {}, executeCombat() { throw new Error('puller must wait for its in-flight aggro cast instead of returning early'); }, executePvPCombat() {}
    });
    assert.strictEqual(partyHudBotASession.roleDecision.reason, 'wait_for_aggro', 'puller should wait for a cast longer than the old fixed aggro timeout');
    partyHudBotA.state.casts = false;

    pulledMob.destId = partyHudBotA.fetchId();
    FollowingState.tick(partyHudBotBSession, partyHudBotB, {}, {
        say() {}, executeCombat() { throw new Error('non-puller must not chase a mob that has only just aggroed the distant puller'); }, executePvPCombat() {}
    });
    assert.strictEqual(partyHudBotBSession.roleDecision.action, 'follow_leader', 'party should keep following until each companion can reach the marked mob');

    // The pull target may cross a companion's personal attack range on its
    // way back. Formation still stays with the leader until the puller has
    // returned and the mob reaches the camp.
    pulledMob.locX = partyHudBotB.locX + 160;
    let earlyMeetAssistId = null;
    FollowingState.tick(partyHudBotBSession, partyHudBotB, {}, {
        say() {}, executeCombat(_session, _bot, npc) { earlyMeetAssistId = npc.fetchId(); }, executePvPCombat() {}
    });
    assert.strictEqual(earlyMeetAssistId, null, 'a companion must not engage an incoming pull before it reaches camp');
    assert.strictEqual(partyHudBotBSession.roleDecision.reason, 'hold_for_pull', 'an incoming pull should keep every non-puller in leader formation');
    pulledMob.locX = 1200;

    FollowingState.tick(partyHudBotASession, partyHudBotA, {}, {
        say() {}, executeCombat() { throw new Error('confirmed aggro should make the puller return before the party engages'); }, executePvPCombat() {}
    });
    assert.strictEqual(partyHudBotASession.roleDecision.reason, 'return', 'puller should return to the leader after aggro is confirmed');
    const returnMoves = partyHudBotA.moves.length;
    partyHudBotA.state.setTowards('move');
    partyHudLeader.locX = 500;
    FollowingState.tick(partyHudBotASession, partyHudBotA, {}, {
        say() {}, executeCombat() {}, executePvPCombat() {}
    });
    assert.strictEqual(partyHudBotA.moves.length, returnMoves, 'an active pull return must finish its route even when the leader moves, instead of snapping back to a replanned path');
    partyHudBotA.state.setTowards(false);
    partyHudLeader.locX = 0;

    pulledMob.locX = 700;
    FollowingState.tick(partyHudBotBSession, partyHudBotB, {}, {
        say() {}, executeCombat() { throw new Error('melee companion must not chase an incoming pull outside its attack range'); }, executePvPCombat() {}
    });
    assert.strictEqual(partyHudBotBSession.roleDecision.action, 'follow_leader', 'melee companions should keep following until the mob reaches their actual attack range');

    partyHudBotA.locX = partyHudLeader.locX;
    pulledMob.locX = partyHudBotB.locX + 160;
    partyHudBotA.skillset.skills = [];
    learnSkill(partyHudBotA, { selfId: 3, name: 'Power Strike', distance: 50, mp: 5 });
    assert.strictEqual(
        PartyPulling.attackRange(partyHudBotA, pulledMob),
        250,
        'a short-range melee skill must not prevent a delivered pull from entering normal combat'
    );
    partyHudBotA.state.setTowards('move');
    FollowingState.tick(partyHudBotASession, partyHudBotA, {}, {
        say() {}, executeCombat() {}, executePvPCombat() {}
    });
    partyHudBotA.state.setTowards(false);
    pulledTargetId = null;
    FollowingState.tick(partyHudBotASession, partyHudBotA, {}, {
        say() {},
        executeCombat(_session, _bot, npc) { pulledTargetId = npc.fetchId(); },
        executePvPCombat() {}
    });
    assert.strictEqual(pulledTargetId, pulledMob.fetchId(), 'puller should keep attacking after the delivered pull enters engage phase');
    partyHudLeaderSession.partyPullState.startedAt = Date.now() - 61000;
    assert.strictEqual(PartyPulling.current(partyHudLeaderSession, PartyCompanionService.getSettings(partyHudLeaderSession)).target, pulledMob, 'a living pulled mob must stay the party target after one minute');
    let assistedPulledMobId = null;
    FollowingState.tick(partyHudBotBSession, partyHudBotB, {}, {
        say() {},
        executeCombat(_session, _bot, npc) { assistedPulledMobId = npc.fetchId(); },
        executePvPCombat() {}
    });
    assert.strictEqual(assistedPulledMobId, pulledMob.fetchId(), 'party should engage the marked mob once it reaches attack range');

    CompanionControl(partyHudLeaderSession, ['companion-control', 'member-pull', 'on', partyHudBotA.fetchName()]);
    partyHudBotB.state.setSeated(true);
    partyHudBotA.locX = 40;
    partyHudBotA.moves = [];
    pulledMob.locX = 1200;
    pulledMob.destId = undefined;
    let abortedAggro = 0;
    let clearedAggroTimers = 0;
    partyHudBotA.attack = {
        abortCast() { abortedAggro++; },
        clearTimers() { clearedAggroTimers++; }
    };
    partyHudLeaderSession.partyPullState = {
        targetId: pulledMob.fetchId(),
        pullerId: partyHudBotA.fetchId(),
        source: 'bot',
        phase: 'aggro',
        startedAt: Date.now(),
        aggroRequestedAt: Date.now()
    };
    FollowingState.tick(partyHudBotASession, partyHudBotA, {}, { say() {}, executeCombat() {}, executePvPCombat() {} });
    assert.strictEqual(partyHudBotASession.roleDecision.reason, 'wait_for_aggro', 'one seated companion below the forty-percent threshold must not pause pulling');
    assert.strictEqual(partyHudBotA.moves.length, 0, 'an aggro request already in flight should not schedule another approach');
    assert.strictEqual(abortedAggro, 0, 'a single resting companion must not cancel an aggro cast');
    assert.strictEqual(clearedAggroTimers, 0, 'a single resting companion must not cancel the scheduled aggro hit');
    assert.strictEqual(partyHudLeaderSession.partyPullState.phase, 'aggro', 'the active aggro request should remain intact below the recovery threshold');
    partyHudBotB.state.setSeated(false);

    partyHudLeader.destId = pulledMob.fetchId();
    CompanionControl(partyHudLeaderSession, ['companion-control', 'pull', 'leader']);
    FollowingState.tick(partyHudBotBSession, partyHudBotB, {}, {
        say() {}, executeCombat() { throw new Error('party must wait for a leader pull outside range'); }, executePvPCombat() {}
    });
    assert.strictEqual(partyHudBotBSession.roleDecision.action, 'follow_leader', 'leader pull should keep companions in follow formation outside their range');
    pulledMob.locX = partyHudBotB.locX;
    assistedPulledMobId = null;
    FollowingState.tick(partyHudBotBSession, partyHudBotB, {}, {
        say() {},
        executeCombat(_session, _bot, npc) { assistedPulledMobId = npc.fetchId(); },
        executePvPCombat() {}
    });
    assert.strictEqual(assistedPulledMobId, pulledMob.fetchId(), 'party should assist the leader-selected mob after it reaches the group');
    assert.strictEqual(BotStatus.getStatus(partyHudBotASession).party.pull.mode, 'leader', 'bot status should expose the active pull mode and state');
    partyHudLeader.destId = undefined;

    CompanionControl(partyHudLeaderSession, ['companion-control', 'pull', 'off']);
    assert.strictEqual(PartyCompanionService.getSettings(partyHudLeaderSession).pullMode, 'off', 'party control should store pull mode');
    assert.strictEqual(PartyCompanionService.getSettings(partyHudLeaderSession).pullerId, null, 'leaving bot pull mode should clear the selected puller id');
    assert.strictEqual(partyHudBotASession.autoTaunt, false, 'pull off should disable companion taunt');
    assert.strictEqual(partyHudBotBSession.autoTaunt, false, 'pull off should apply to every companion');
    assert.strictEqual(partyHudBotASession.partyPuller, false, 'leaving party pull mode should clear the companion pulling stance');
    const companionHtml = lastNpcHtml(partyHudLeaderSession);
    assert(companionHtml.includes('2 active'), 'party control panel should show active companion count');
    assert(!companionHtml.includes('Loot:'), 'party control panel should leave loot distribution to the native client setting');
    assert(!companionHtml.includes('companion-control loot'), 'party control panel should not offer a separate loot-distribution bypass');
    assert(companionHtml.includes('<a action='), 'party control panel should use compact links for controls');
    assert(!companionHtml.includes('<button'), 'party control panel should avoid legacy buttons because they break this client layout');
    assert(!companionHtml.includes('['), 'active party control items should use color only, not bracket labels');
    assert(
        /companion-control pull auto[\s\S]*companion-control pull leader[\s\S]*companion-control pull off/.test(companionHtml),
        'party pull controls should expose Auto, Player, and Off modes'
    );
    assert(companionHtml.includes('member-pull on'), 'eligible companion cards should expose a per-bot Pull order');
    assert(companionHtml.includes('Call'), 'companion cards should expose summon as a compact call action');
    assert(companionHtml.includes('bot-status '), 'companion cards should keep a compact status action through the bot name');
    assert(!companionHtml.includes('Dismiss'), 'companion cards should leave party removal to the normal chat command');
    assert(!companionHtml.includes('HP '), 'party control panel should not duplicate native party HP display');
    assert(!companionHtml.includes('MP '), 'party control panel should not duplicate native party MP display');
    assert(!companionHtml.includes('native #'), 'party control panel should not expose raw native loot debug text');
    assert(!companionHtml.includes('bgcolor=222222'), 'party control panel should avoid the flat grey panel background');
    assert(!companionHtml.includes('bgcolor=333333'), 'companion cards should avoid the flat grey card background');

    const activeAdd = {
        fetchId: () => 3012,
        fetchAttackable: () => true,
        isDead: () => false,
        fetchLevel: () => 26,
        fetchDestId: () => partyHudLeader.fetchId(),
        fetchLocX: () => 300,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchName: () => 'active add'
    };
    const freePullTarget = {
        ...pulledMob,
        id: 3013,
        destId: undefined,
        fetchId() { return this.id; },
        fetchDestId() { return this.destId; },
        fetchName: () => 'next pull target'
    };
    World.npc = { spawns: [activeAdd, freePullTarget] };
    World.fetchNpcsInRadius = () => [activeAdd, freePullTarget];
    partyHudBotA.moves = [];
    partyHudLeaderSession.partyPullState = {};
    CompanionControl(partyHudLeaderSession, ['companion-control', 'member-pull', 'on', partyHudBotA.fetchName()]);
    FollowingState.tick(partyHudBotASession, partyHudBotA, {}, {
        say() {}, executeCombat() { throw new Error('puller must not start a new pull while the party is fighting an add'); }, executePvPCombat() {}
    });
    assert.strictEqual(partyHudBotASession.roleDecision.reason, 'party_under_attack', 'an unrelated incoming threat must pause bot pulling');
    assert.strictEqual(partyHudLeaderSession.partyPullState.targetId, undefined, 'a live party threat must not be replaced with a new pull target');
    assert.strictEqual(partyHudBotA.moves.length, 0, 'a paused puller must stay with the party during an active fight');
    World.npc = { spawns: [pulledMob] };
    World.fetchNpcsInRadius = () => [pulledMob];

    CompanionControl(partyHudLeaderSession, ['companion-control', 'member-pull', 'on', partyHudBotA.fetchName()]);
    assert.strictEqual(PartyCompanionService.getSettings(partyHudLeaderSession).pullMode, 'bot', 'selected companion should remain the explicit puller until its status changes');
    let cancelledPullCast = 0;
    let clearedPullTimers = 0;
    partyHudBotA.attack = {
        abortCast() { cancelledPullCast++; },
        clearTimers() { clearedPullTimers++; }
    };
    CompanionControl(partyHudLeaderSession, ['companion-control', 'pull', 'off']);
    assert.strictEqual(cancelledPullCast, 1, 'turning pull off should cancel an in-flight pull cast');
    assert.strictEqual(clearedPullTimers, 1, 'turning pull off should cancel scheduled pull attacks');
    CompanionControl(partyHudLeaderSession, ['companion-control', 'member-pull', 'on', partyHudBotA.fetchName()]);
    assert.strictEqual(PartyCompanionService.detach(partyHudLeaderSession, partyHudBotASession), true, 'dismiss should detach a companion');
    assert.strictEqual(clearedPullTimers, 2, 'dismissing the selected puller should also cancel its scheduled pull action');
    assert.strictEqual(PartyCompanionService.getSettings(partyHudLeaderSession).pullMode, 'auto', 'dismissing the selected puller should clear party pull instead of silently assigning another bot');
    const oneMemberPacket = lastPartyAllPacket(partyHudLeaderSession);
    assert(oneMemberPacket, 'dismissing one companion should rebuild the party window');
    assert.strictEqual(oneMemberPacket.readInt32LE(5), 2, 'party window should keep the stored loot distribution after detach');
    assert.strictEqual(oneMemberPacket.readInt32LE(9), 1, 'party window should keep the remaining companion');
    assert.strictEqual(partyHudBotASession.partyCompanion, false, 'dismissed companion should clear party flag');
    assert.strictEqual(partyHudBotASession.followPlayerSession, null, 'dismissed companion should clear leader link');
    assert.strictEqual(partyHudBotBSession.partyCompanion, true, 'remaining companion should stay in party');

    const packetsBeforeDisconnectCleanup = partyHudLeaderSession.packets.length;
    assert.strictEqual(
        PartyCompanionService.detachAll(partyHudLeaderSession, { rebuildWindow: false, refreshPanel: false }),
        1,
        'disconnect cleanup should detach the remaining companion'
    );
    assert.strictEqual(
        partyHudLeaderSession.packets.length,
        packetsBeforeDisconnectCleanup,
        'disconnect cleanup should not write party packets to a closing leader session'
    );
    assert.strictEqual(partyHudBotBSession.partyCompanion, false, 'disconnect cleanup should clear remaining companion flag');
    assert.strictEqual(partyHudBotBSession.followPlayerSession, null, 'disconnect cleanup should clear remaining leader link');

    const toolBot = fakeActor(2000012, { locX: 0, locY: 0 });
    const toolSession = fakeSession('bot_tool_companion', toolBot);
    toolSession.followPlayerSession = leaderSession;
    toolSession.partyCompanion = true;
    toolSession.plan = 'following';
    World.user = { sessions: [leaderSession, toolSession] };

    const huntResult = BotAgentTools.execute(toolSession, {
        action: 'hunt',
        confidence: 0.9,
        reply: '',
        targetPlayerName: '',
        spotId: '',
        buffType: '',
        reason: 'player_order'
    }, []);

    assert.strictEqual(huntResult.reason, 'party_hunt', 'hunt tool should keep companion in party hunt mode');
    assert.strictEqual(toolSession.partyCompanion, true, 'hunt tool should not clear party companion flag');
    assert.strictEqual(toolSession.followPlayerSession, leaderSession, 'hunt tool should not detach the party leader');
    assert.strictEqual(toolSession.plan, 'hunting', 'hunt tool should let companion hunt locally with party');

    const moveResult = BotAgentTools.execute(toolSession, {
        action: 'move_to_spot',
        confidence: 0.9,
        reply: '',
        targetPlayerName: '',
        spotId: 'somewhere_else',
        buffType: '',
        reason: 'no_mobs'
    }, []);

    assert.strictEqual(moveResult.reason, 'party_companion_stays_with_party', 'companion should reject autonomous spot moves');
    assert.strictEqual(toolBot.moves.length, 0, 'move_to_spot should not move a companion away from the party');
    assert.strictEqual(toolSession.followPlayerSession, leaderSession, 'move_to_spot should keep party leader attached');

    toolBot.state.setSeated(true);
    toolSession.plan = 'resting';
    const restResult = BotAgentTools.execute(toolSession, {
        action: 'rest',
        confidence: 0.9,
        reply: '',
        targetPlayerName: '',
        spotId: '',
        buffType: '',
        reason: 'player_order'
    }, []);

    assert.strictEqual(restResult.reason, 'already_recovered', 'rest tool should not keep a fully recovered bot seated');
    assert.strictEqual(toolBot.state.fetchSeated(), false, 'fully recovered companion should stand');
    assert.strictEqual(toolSession.plan, 'following', 'fully recovered companion should return to following');

    Math.random = () => 0;
    const huntingCompanion = fakeActor(2000004, { locX: 0, locY: 0 });
    const huntingSession = fakeSession('bot_hunting_companion', huntingCompanion);
    huntingSession.followPlayerSession = leaderSession;
    huntingSession.partyCompanion = true;
    huntingSession.plan = 'hunting';
    huntingSession.currentSpot = { id: 'test-spot' };
    World.user = { sessions: [leaderSession, huntingSession] };
    World.fetchNpcsInRadius = () => [{
        fetchId: () => 1002,
        fetchAttackable: () => true,
        isDead: () => false,
        fetchDestId: () => undefined,
        fetchLocX: () => 80,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchName: () => 'training mob'
    }];

    HuntingState.tick(huntingSession, huntingCompanion, {}, {
        say() {},
        getRandomPhrase: () => 'target found',
        executeCombat() {}
    });

    assert.notStrictEqual(huntingSession.plan, 'shopping', 'party companion should not start random loot shopping');

    const emptyHuntBot = fakeActor(2000013, { locX: 0, locY: 0 });
    const emptyHuntSession = fakeSession('bot_empty_party_hunt', emptyHuntBot);
    emptyHuntSession.followPlayerSession = leaderSession;
    emptyHuntSession.partyCompanion = true;
    emptyHuntSession.plan = 'hunting';
    emptyHuntSession.currentSpot = { id: 'test-spot', name: 'Test Spot' };
    World.user = { sessions: [leaderSession, emptyHuntSession] };
    World.fetchNpcsInRadius = () => [];

    HuntingState.tick(emptyHuntSession, emptyHuntBot, {}, {
        say() {},
        getRandomPhrase: () => 'target found',
        executeCombat() {}
    });

    assert.strictEqual(emptyHuntSession.plan, 'following', 'party hunter with no nearby mobs should return to leader');
    assert.strictEqual(emptyHuntSession.lastDecision.reason, 'party_hunt_no_targets', 'party hunter should not request a new spot');
    assert.strictEqual(emptyHuntBot.moves.length, 0, 'party hunter should not walk to another spot when mobs are scarce');

    const shoppingCompanion = fakeActor(2000005, { locX: 0, locY: 0 });
    const shoppingSession = fakeSession('bot_shopping_companion', shoppingCompanion);
    shoppingSession.followPlayerSession = leaderSession;
    shoppingSession.partyCompanion = true;
    shoppingSession.plan = 'shopping';
    shoppingSession.shoppingTarget = { name: 'shop', locX: 1000, locY: 0, locZ: 0 };

    ShoppingState.tick(shoppingSession, shoppingCompanion, {}, { say() {} });

    assert.strictEqual(shoppingSession.plan, 'following', 'shopping companion should return to follow state');
    assert.strictEqual(shoppingSession.shoppingTarget, undefined, 'shopping target should be cleared for companions');
} finally {
    Math.random = originalRandom;
    World.user = originalUsers;
    World.fetchUser = originalFetchUser;
    World.fetchNpc = originalFetchNpc;
    World.fetchNpcsInRadius = originalFetchNpcsInRadius;
    World.npc = originalNpcs;
    World.removeNpc = originalRemoveNpc;
    Database.updateCharacterExperience = originalUpdateCharacterExperience;
    DataCache.experience = originalExperience;
    BotManager.sessions = originalBotSessions;
    BotManager.botPartySay = originalBotPartySay;
    BotBuffs.applySupportBuff = originalApplySupportBuff;
    MarketOpportunity.findOffers = originalFindOffers;
}

console.log('Party companion rest/follow regression checks passed');
