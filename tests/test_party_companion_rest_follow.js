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
const HotActorLodPolicy = invoke('GameServer/Bot/AI/HotActorLodPolicy');
const BotBuffs = invoke('GameServer/Bot/AI/BotBuffs');
const BotStatus = invoke('GameServer/Bot/AI/BotStatus');
const BotBrainContext = invoke('GameServer/Bot/AI/BotBrainContext');
const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
const PartyPulling = invoke('GameServer/Bot/AI/PartyPulling');
const PartyAwareness = invoke('GameServer/Bot/AI/PartyAwareness');
const BotCombatUtility = invoke('GameServer/Bot/AI/BotCombatUtility');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const BotSupportPlanner = invoke('GameServer/Bot/AI/BotSupportPlanner');
const BotSkillCapabilities = invoke('GameServer/Bot/AI/BotSkillCapabilities');
const PartyClassTactics = invoke('GameServer/Bot/AI/PartyClassTactics');
const BotRaidSafety = invoke('GameServer/Bot/AI/BotRaidSafety');
const BotPartyChat = invoke('GameServer/Bot/AI/BotPartyChat');
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const CompanionControl = invoke('GameServer/World/Generics/NpcBypasses/CompanionControl');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const NpcDied = invoke('GameServer/Actor/Generics/NpcDied');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const SkillModel = invoke('GameServer/Model/Skill');
const SkillExec = invoke('GameServer/Actor/Generics/SkillExec');
const ActorGenerics = invoke(path.actor);

DataCache.init();

function corpseSummonControlProbe() {
    return {
        effects: {},
        state: {
            fetchSeated: () => false,
            fetchTowards: () => false,
            fetchHits: () => false,
            fetchCasts: () => false
        }
    };
}

assert.strictEqual(
    FollowingState.canAttemptPartyCorpseSummon(corpseSummonControlProbe(), null, null),
    true,
    'a free party corpse-summon tick must be allowed without control effects'
);
for (const [effect, label] of [
    [{ key: 'stun', id: 101, type: 'debuff', category: 'stun', durationMs: 60000 }, 'stun'],
    [{ key: 'silence', id: 1064, type: 'debuff', category: 'silence', durationMs: 60000 }, 'silence'],
    [{ key: 'magic_mute', id: 99991, type: 'debuff', stats: { magicMute: true }, durationMs: 60000 }, 'magic mute']
]) {
    const actor = corpseSummonControlProbe();
    EffectStore.apply(actor, effect);
    assert.strictEqual(
        FollowingState.canAttemptPartyCorpseSummon(actor, null, null),
        false,
        `party corpse summoning must be blocked while the Necromancer has ${label}`
    );
    EffectStore.remove(actor, effect.key);
}

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
    setHits(value) { this.hits = value; }
    fetchCasts() { return this.casts; }
    setCasts(value) { this.casts = value; }
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
        moveTo(data) {
            if (data.previewOnly) {
                if (this.session) this.session.lastPathfinding = { pathLength: 2, lowLodWarp: false };
                return;
            }
            this.moves.push(data);
        },
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
const originalHotOffers = MarketOpportunity.hotOffers;
const originalSkillExec = ActorGenerics.skillExec;

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

    const raidBoss = {
        model: { raidBoss: true, raidAttackers: new Set() },
        destId: undefined,
        fetchId: () => 9100001,
        fetchSelfId: () => 25325,
        fetchName: () => 'party raid target',
        fetchLocX: () => 400,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchLevel: () => 40,
        fetchAttackable: () => true,
        fetchIsRaidBoss: () => true,
        fetchDestId() { return this.destId; },
        isDead: () => false,
        state: { fetchDead: () => false }
    };
    const staleRaidBoss = {
        model: { raidBoss: true, raidAttackers: new Set() },
        fetchId: () => 9100000,
        fetchSelfId: () => 25324,
        fetchName: () => 'stale party raid target',
        fetchLocX: () => 500,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchLevel: () => 40,
        fetchAttackable: () => true,
        fetchIsRaidBoss: () => true,
        fetchDestId: () => undefined,
        isDead: () => false,
        state: { fetchDead: () => false }
    };
    const raidTank = fakeActor(2000200, { locX: 50, classId: 5, hp: 400, maxHp: 1000 });
    raidTank.state.setSeated(true);
    raidTank.backpack.fetchEquippedArmors = () => [{ fetchKind: () => 'Armor.Chain' }];
    const raidTankSession = fakeSession('bot_raid_tank', raidTank);
    raidTankSession.followPlayerSession = leaderSession;
    raidTankSession.partyCompanion = true;
    raidTankSession.plan = 'following';
    const raidDps = fakeActor(2000201, { locX: 60, classId: 1, hp: 1000, maxHp: 1000 });
    raidDps.backpack.fetchEquippedArmors = () => [{ fetchKind: () => 'Armor.Chain' }];
    const raidDpsSession = fakeSession('bot_raid_dps', raidDps);
    raidDpsSession.followPlayerSession = leaderSession;
    raidDpsSession.partyCompanion = true;
    raidDpsSession.plan = 'following';
    const raidHealer = fakeActor(2000202, { locX: 70, classId: 15, hp: 800, maxHp: 800, mp: 500, maxMp: 500 });
    learnSkill(raidHealer, { selfId: 1011, name: 'Heal', distance: 600, mp: 10, power: 100 });
    const raidHealerSession = fakeSession('bot_raid_healer', raidHealer);
    raidHealerSession.followPlayerSession = leaderSession;
    raidHealerSession.partyCompanion = true;
    raidHealerSession.plan = 'following';
    leader.destId = raidBoss.fetchId();
    raidHealerSession.incomingThreatId = raidBoss.fetchId();
    raidHealerSession.incomingThreatAt = Date.now();
    leaderSession.partyRaidEngagement = {
        bossId: staleRaidBoss.fetchId(),
        bossTemplateId: staleRaidBoss.fetchSelfId(),
        openerId: raidTank.fetchId(),
        phase: 'opening',
        selectedAt: Date.now() - 1000,
        lastActiveAt: Date.now() - 1000
    };
    World.user = { sessions: [leaderSession, raidDpsSession, raidTankSession, raidHealerSession] };
    World.npc = { spawns: [staleRaidBoss, raidBoss] };
    World.fetchNpcsInRadius = () => [staleRaidBoss, raidBoss];
    const raidOpeners = [];
    const raidHeals = [];
    const raidBotAI = {
        say() {},
        executePvPCombat() {},
        executeCombat(session, actor, target, _generics, options) {
            raidOpeners.push({ session, actor, target, options });
        }
    };
    FollowingState.tick(raidHealerSession, raidHealer, {
        skillExec(_session, actor, data) { raidHeals.push({ actor, data }); }
    }, raidBotAI);
    assert.strictEqual(raidHealerSession.plan, 'following',
        'a selected boss recorded as a recent opening threat must not make a companion flee');
    assert.strictEqual(leaderSession.partyRaidEngagement?.bossId, raidBoss.fetchId(),
        'opening must atomically reconcile a stale engagement to the live selected boss');
    assert.strictEqual(EffectStore.hasDebuff(raidHealer, 'fear'), false,
        'raid-safety reconciliation must not apply a Fear effect');
    delete raidHealerSession.incomingThreatId;
    delete raidHealerSession.incomingThreatAt;
    FollowingState.tick(raidDpsSession, raidDps, {}, raidBotAI);
    FollowingState.tick(raidTankSession, raidTank, {}, raidBotAI);
    assert.strictEqual(raidHeals.length, 1, 'a healer must recover the selected opener before the raid starts');
    assert.strictEqual(raidHeals[0].data.id, raidTank.fetchId(), 'pre-pull healing must target the selected tank');
    assert.strictEqual(raidOpeners.length, 0, 'a low-HP opener must not attack before reaching the safety threshold');
    raidTank.hp = 900;
    FollowingState.tick(raidTankSession, raidTank, {}, raidBotAI);
    assert.strictEqual(raidTank.state.fetchSeated(), false, 'the recovered opener must stand before attacking');
    assert.strictEqual(raidOpeners.length, 0, 'standing up must consume the opener tick instead of attacking while seated');
    FollowingState.tick(raidTankSession, raidTank, {}, raidBotAI);
    assert.strictEqual(raidOpeners.length, 1, 'only one companion may open a merely selected raid boss');
    assert.strictEqual(raidOpeners[0].actor, raidTank, 'the tank must open even when a heavy-armored DPS ticks first');
    assert.strictEqual(raidOpeners[0].target, raidBoss, 'the opener must attack the player-selected boss directly');
    assert.strictEqual(raidOpeners[0].options.playerPartyRaidLeaderSession, leaderSession,
        'the raid combat exception must remain scoped to this real-player party');
    assert.deepStrictEqual(leaderSession.partyPullState || {}, {}, 'player raid designation must not create a bot pull');

    const raidMinion = {
        minionBossObjectId: raidBoss.fetchId(),
        destId: raidDps.fetchId(),
        fetchId: () => 9100002,
        fetchSelfId: () => 25326,
        fetchName: () => 'party raid minion',
        fetchLocX: () => 420,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchLevel: () => 40,
        fetchAttackable: () => true,
        fetchIsRaidBoss: () => false,
        fetchDestId() { return this.destId; },
        isDead: () => false,
        state: { fetchDead: () => false }
    };
    leader.state.fetchCombats = () => true;
    raidBoss.destId = leader.fetchId();
    World.npc = { spawns: [raidBoss, raidMinion] };
    World.fetchNpcsInRadius = () => [raidBoss, raidMinion];
    raidOpeners.length = 0;
    FollowingState.tick(raidDpsSession, raidDps, {}, raidBotAI);
    assert.strictEqual(BotRaidSafety.syncPlayerPartyRaid(leaderSession)?.phase, 'combat',
        'live combat with the matching boss must keep the player party raid in combat');
    assert.strictEqual(raidDpsSession.plan, 'following',
        'a matching engaged raid boss must not make the companion flee');
    assert.strictEqual(raidOpeners[0]?.target, raidBoss,
        'a matching engaged raid boss must flow through normal party assist');

    raidBoss.destId = undefined;
    raidOpeners.length = 0;
    FollowingState.tick(raidDpsSession, raidDps, {}, raidBotAI);
    assert.strictEqual(raidDpsSession.plan, 'following',
        'a matching engaged raid minion must not make the companion flee');
    assert.strictEqual(raidOpeners[0]?.target, raidMinion,
        'a matching engaged raid minion must flow through normal party assist');
    assert.strictEqual(EffectStore.hasDebuff(raidDps, 'fear'), false,
        'normal raid assist must not apply a Fear effect');

    delete leaderSession.partyRaidEngagement;
    leader.destId = raidMinion.fetchId();
    raidBoss.destId = undefined;
    raidMinion.destId = leader.fetchId();
    raidDpsSession.plan = 'following';
    raidOpeners.length = 0;
    FollowingState.tick(raidDpsSession, raidDps, {}, raidBotAI);
    assert.strictEqual(BotRaidSafety.syncPlayerPartyRaid(leaderSession)?.phase, 'combat',
        'a fresh player aggro on a raid minion must immediately authorize party combat');
    assert.strictEqual(leaderSession.partyRaidEngagement?.targetId, raidMinion.fetchId(),
        'a fresh player aggro must preserve the selected minion as the party target');
    assert.strictEqual(raidDpsSession.plan, 'following',
        'a companion must not flee when the player opens the raid through a minion');
    assert.strictEqual(raidOpeners[0]?.target, raidMinion,
        'a fresh player-led minion aggro must send the companion into that minion');

    const unrelatedRaidBoss = {
        ...staleRaidBoss,
        destId: raidDps.fetchId(),
        fetchId: () => 9100003,
        fetchSelfId: () => 25327,
        fetchName: () => 'unrelated raid boss',
        fetchDestId() { return this.destId; }
    };
    raidMinion.destId = undefined;
    World.npc = { spawns: [raidBoss, raidMinion, unrelatedRaidBoss] };
    World.fetchNpcsInRadius = () => [raidBoss, raidMinion, unrelatedRaidBoss];
    FollowingState.tick(raidDpsSession, raidDps, {}, raidBotAI);
    assert.strictEqual(raidDpsSession.plan, 'fleeing',
        'an unrelated unengaged raid entity targeting the party must retain raid retreat');
    assert.strictEqual(EffectStore.hasDebuff(raidDps, 'fear'), false,
        'raid retreat is an AI plan and must not fabricate a Fear effect');

    delete leaderSession.partyRaidEngagement;
    leader.destId = undefined;
    delete leader.state.fetchCombats;
    raidBoss.destId = undefined;
    World.npc = { spawns: [] };
    World.fetchNpcsInRadius = () => [];

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
    const originalBringToLeader = PartyCompanionService.bringToLeader;
    let inviteTell = null;
    const broughtCompanions = [];
    try {
        global.setTimeout = (callback) => {
            callback();
            return 0;
        };
        BotSocialMemory.getSnapshot = () => ({ trust: 0, familiarity: 0, recentlyAbandonedAt: null });
        BotSocialMemory.recordEvent = () => Promise.resolve(null);
        PartyCompanionService.bringToLeader = (targetLeaderSession, companionSession) => {
            assert.strictEqual(targetLeaderSession, leaderSession);
            broughtCompanions.push(companionSession);
            return true;
        };
        BotManager.botTell = (sourceSession, targetSession, text) => {
            assert.strictEqual(targetSession, leaderSession, 'invite acknowledgement should target party leader');
            if (sourceSession === inviteBotSession) inviteTell = text;
        };
        const nativeAnswerBot = fakeActor(2000045, { locX: 60, locY: 0 });
        const nativeAnswerSession = fakeSession('bot_native_party_answer', nativeAnswerBot);
        const nativeDeclineBot = fakeActor(2000046, { locX: 70, locY: 0 });
        const nativeDeclineSession = fakeSession('bot_native_party_decline', nativeDeclineBot);
        // This test exercises the accepted invite lifecycle. Make the
        // persona choice explicit now that ordinary invites are persona-aware.
        const socialPersona = {
            primaryDrive: 'social',
            archetype: 'party_regular',
            traits: { sociability: 0.82, empathy: 0.66, commitment: 0.66 }
        };
        inviteBotSession.persona = socialPersona;
        nativeAnswerSession.persona = socialPersona;
        BotManager.sessions = [inviteBotSession, nativeAnswerSession, nativeDeclineSession];

        assert.strictEqual(World.inviteBotCompanion(leaderSession, leader, inviteBotSession, 1, 'test_invite'), true, 'available resting bot should join the party');
        const acceptedPacket = [...leaderSession.packets].reverse().find((packet) => packet[0] === 0x3a);
        assert.strictEqual(acceptedPacket.readInt32LE(1), 1, 'party success must send native JoinParty(1), not the loot distribution id');

        nativeAnswerSession.pendingPartyInvite = {
            requestorSession: leaderSession,
            requestorActor: leader,
            distribution: 3,
            source: 'test_native_answer'
        };
        assert.strictEqual(World.answerForTeamUp(nativeAnswerSession, nativeAnswerBot, { id: 1 }), true, 'a bot should be able to accept through the native answer lifecycle');
        assert.strictEqual(nativeAnswerSession.pendingPartyInvite, null, 'the accepted native invitation must be consumed once');
        assert.strictEqual(nativeAnswerSession.followPlayerSession, leaderSession, 'native acceptance should attach the bot to the requesting leader');
        assert.deepStrictEqual(broughtCompanions, [inviteBotSession, nativeAnswerSession], 'every accepted invite path should bring the bot to the leader immediately');
        const nativeAcceptedPacket = [...leaderSession.packets].reverse().find((packet) => packet[0] === 0x3a);
        assert.strictEqual(nativeAcceptedPacket.readInt32LE(1), 1, 'native bot acceptance must return JoinParty success');

        nativeDeclineSession.pendingPartyInvite = {
            requestorSession: leaderSession,
            requestorActor: leader,
            distribution: 3,
            source: 'test_native_decline'
        };
        assert.strictEqual(World.answerForTeamUp(nativeDeclineSession, nativeDeclineBot, { id: 0 }), false, 'a bot invitation may be declined');
        assert.strictEqual(nativeDeclineSession.partyCompanion, undefined, 'declining a native invitation must not attach the bot');
        const declinedPacket = [...leaderSession.packets].reverse().find((packet) => packet[0] === 0x3a);
        assert.strictEqual(declinedPacket.readInt32LE(1), 0, 'native refusal must return JoinParty failure rather than ActionFailed');
    } finally {
        global.setTimeout = originalSetTimeout;
        BotManager.botTell = originalBotTell;
        BotManager.sessions = originalInviteBotSessions;
        BotSocialMemory.getSnapshot = originalSocialSnapshot;
        BotSocialMemory.recordEvent = originalSocialRecordEvent;
        PartyCompanionService.bringToLeader = originalBringToLeader;
    }
    assert.strictEqual(inviteTell, 'Gladly. A steady party is better than going alone.', 'an accepted persona-aware invite should acknowledge the party without promising another rest');
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

    const supportCampBot = fakeActor(2000056, { locX: -330, locY: 0, classId: 17 });
    const supportCampSession = fakeSession('bot_support_camp_follow', supportCampBot);
    supportCampSession.followPlayerSession = leaderSession;
    supportCampSession.partyCompanion = true;
    supportCampSession.plan = 'following';
    World.user = { sessions: [leaderSession, supportCampSession] };

    FollowingState.tick(supportCampSession, supportCampBot, {}, { say() {}, executeCombat() {}, executePvPCombat() {} });

    assert.strictEqual(supportCampBot.state.fetchSeated(), true, 'support should sit after reaching its formation slot even when that slot is farther than the generic leader leash');
    assert.strictEqual(supportCampBot.moves.length, 0, 'a support already at its rest formation slot must not loop on another approach');

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

    const physicalRestBot = fakeActor(2999001, {
        locX: 0, locY: 0, hp: 100, maxHp: 100, mp: 10, maxMp: 100, classId: 5
    });
    physicalRestBot.state.setSeated(true);
    const physicalRestSession = fakeSession('bot_physical_rest_complete', physicalRestBot);
    physicalRestSession.plan = 'resting';
    World.user = { sessions: [physicalRestSession] };
    World.npc = { spawns: [] };
    World.fetchNpcsInRadius = () => [];
    RestingState.tick(physicalRestSession, physicalRestBot, {}, { say() {} });
    assert.strictEqual(physicalRestSession.plan, 'hunting',
        'a physical bot must finish resting once HP is recovered even when MP is below the caster threshold');
    assert.strictEqual(physicalRestBot.state.fetchSeated(), false,
        'a recovered physical bot must stand instead of waiting for unneeded MP');

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

    const regroupingRestBot = fakeActor(2000055, { locX: 900, locY: 0, hp: 100, maxHp: 100, mp: 10, maxMp: 100 });
    regroupingRestBot.state.setSeated(true);
    const regroupingRestSession = fakeSession('bot_regrouping_rest', regroupingRestBot);
    regroupingRestSession.followPlayerSession = leaderSession;
    regroupingRestSession.partyCompanion = true;
    regroupingRestSession.plan = 'resting';
    leader.state.setSeated(true);
    leader.destId = undefined;
    World.user = { sessions: [leaderSession, regroupingRestSession] };
    World.npc = { spawns: [] };
    World.fetchNpcsInRadius = () => [];

    RestingState.tick(regroupingRestSession, regroupingRestBot, {}, { say() {} });

    assert.strictEqual(regroupingRestSession.plan, 'following', 'a distant recovering companion should regroup when the leader sits');
    assert.strictEqual(regroupingRestBot.state.fetchSeated(), false, 'the recovering companion should stand before moving to the resting party');
    assert.strictEqual(regroupingRestSession.roleDecision.reason, 'leader_moved', 'rest regrouping should expose why the bot woke before recovery completed');
    FollowingState.tick(regroupingRestSession, regroupingRestBot, {}, { say() {}, executeCombat() {}, executePvPCombat() {} });
    assert.strictEqual(regroupingRestSession.roleDecision.reason, 'move_near_sitting_leader', 'the regrouping companion should move into the seated leader formation before sitting again');
    assert.strictEqual(regroupingRestBot.moves.length, 1, 'party rest regrouping should issue one formation move');

    const orderedRestBot = fakeActor(2000057, { locX: 900, locY: 0, hp: 100, maxHp: 100, mp: 10, maxMp: 100, classId: 17 });
    orderedRestBot.state.setSeated(true);
    const orderedRestSession = fakeSession('bot_ordered_rest', orderedRestBot);
    orderedRestSession.followPlayerSession = leaderSession;
    orderedRestSession.partyCompanion = true;
    orderedRestSession.plan = 'resting';
    orderedRestSession.explicitRestOrder = true;
    World.user = { sessions: [leaderSession, orderedRestSession] };

    RestingState.tick(orderedRestSession, orderedRestBot, {}, { say() {} });

    assert.strictEqual(orderedRestSession.plan, 'resting', 'a direct sit order should override automatic rest regrouping until recovery finishes');
    assert.strictEqual(orderedRestBot.state.fetchSeated(), true, 'a directly seated companion must not stand again just because its formation slot is distant');
    leader.state.setSeated(false);

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

    // An NPC keeps its native combat state while the target is just under
    // 1500 units away.  This is the important social-pull case: after the
    // first mob dies, a ranged add must be acquired without the player
    // manually selecting it.
    const distantArcher = {
        fetchId: () => 1010,
        fetchAttackable: () => true,
        isDead: () => false,
        fetchDestId: () => leader.fetchId(),
        fetchLocX: () => 1490,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchName: () => 'Turek Orc Archer'
    };
    const distantThreatBot = fakeActor(2000053, { locX: 120, locY: 0 });
    const distantThreatSession = fakeSession('bot_distant_threat_assist', distantThreatBot);
    distantThreatSession.followPlayerSession = leaderSession;
    distantThreatSession.partyCompanion = true;
    distantThreatSession.plan = 'following';
    let distantThreatAssistId = null;
    PartyCompanionService.updateSettings(leaderSession, { pullMode: 'auto' });
    World.user = { sessions: [leaderSession, distantThreatSession] };
    World.npc = { spawns: [distantArcher] };
    World.fetchNpcsInRadius = (_x, _y, radius) => radius >= 1490 ? [distantArcher] : [];

    FollowingState.tick(distantThreatSession, distantThreatBot, {}, {
        say() {},
        executeCombat(_session, _bot, npc) { distantThreatAssistId = npc.fetchId(); },
        executePvPCombat() {}
    });

    assert.strictEqual(distantThreatSession.currentTargetId, distantArcher.fetchId(), 'party should acquire a distant archer that is still attacking a member');
    assert.strictEqual(distantThreatAssistId, distantArcher.fetchId(), 'party should attack a social ranged add without a manual leader target');

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

    const criticalBot = fakeActor(2000044, { locX: 120, locY: 0, hp: 20, maxHp: 100 });
    const criticalSession = fakeSession('bot_critical_self_preservation', criticalBot);
    criticalSession.followPlayerSession = leaderSession;
    criticalSession.partyCompanion = true;
    criticalSession.plan = 'following';
    criticalSession.incomingThreatId = selfDefenseNpc.fetchId();
    criticalSession.incomingThreatAt = Date.now();
    let criticalCombatStarted = false;
    World.user = { sessions: [leaderSession, criticalSession] };
    FollowingState.tick(criticalSession, criticalBot, {}, {
        say() {},
        executeCombat() { criticalCombatStarted = true; },
        executePvPCombat() { criticalCombatStarted = true; }
    });
    assert.strictEqual(criticalCombatStarted, false, 'a critically wounded non-tank should not start another attack');
    assert.strictEqual(criticalSession.currentTargetId, undefined, 'critical self-preservation should clear the combat target');
    assert.strictEqual(criticalSession.roleDecision.action, 'retreat', 'critical self-preservation should be observable');
    assert.strictEqual(criticalSession.plan, 'following', 'retreat should keep the bot attached to the party');
    assert.strictEqual(criticalBot.moves.length, 1, 'a critically wounded companion should create distance from its attacker');
    assert(criticalBot.moves[0].to.locX < criticalBot.fetchLocX(), 'the retreat destination should lead away from the attacker and toward party safety');
    let retreatAborts = 0;
    criticalBot.automation.abortAll = () => {
        retreatAborts += 1;
        criticalBot.state.setTowards(false);
    };
    criticalBot.state.setTowards('move');
    FollowingState.tick(criticalSession, criticalBot, {}, {
        say() {},
        executeCombat() { criticalCombatStarted = true; },
        executePvPCombat() { criticalCombatStarted = true; }
    });
    assert.strictEqual(retreatAborts, 0, 'a repeated critical-HP tick must preserve the active retreat route');
    assert.strictEqual(criticalBot.moves.length, 1, 'an active retreat should not be cancelled and immediately reissued');

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

    healerCasts.length = 0;
    healerBot.moves = [];
    healerBot.locX = 0;
    woundedCompanion.locX = 800;
    FollowingState.tick(healerSession, healerBot, {
        skillExec(session, bot, data) { healerCasts.push(data); }
    }, { say() {}, executeCombat() {}, executePvPCombat() {} });
    assert.strictEqual(healerCasts.length, 0, 'an out-of-range emergency heal must not use direct action movement through geodata');
    assert.strictEqual(healerBot.moves.length, 1, 'an out-of-range healer should start a normal pathfinding approach');
    assert.strictEqual(healerSession.pendingSupportApproach.targetId, woundedCompanion.fetchId(), 'the healer should retain the pending emergency target while approaching');
    healerBot.locX = 250;
    FollowingState.tick(healerSession, healerBot, {
        skillExec(session, bot, data) { healerCasts.push(data); }
    }, { say() {}, executeCombat() {}, executePvPCombat() {} });
    assert.strictEqual(healerCasts.length, 1, 'the pending emergency heal should cast as soon as pathfinding brings the healer into native range');
    assert.strictEqual(healerSession.pendingSupportApproach, undefined, 'a completed support approach must release its pending movement state');
    healerBot.locX = 80;
    woundedCompanion.locX = 120;

    healerCasts.length = 0;
    healerBot.locX = 0;
    woundedCompanion.locX = 800;
    woundedCompanion.hp = 60;
    FollowingState.tick(healerSession, healerBot, {
        skillExec(session, bot, data) { healerCasts.push(data); }
    }, { say() {}, executeCombat() {}, executePvPCombat() {} });
    assert.strictEqual(healerSession.pendingSupportApproach.kind, 'top_off', 'a distant non-critical target should queue a normal top-off approach');
    const criticalCompanion = fakeActor(2000037, { locX: 120, locY: 0, hp: 20, maxHp: 100 });
    const criticalCompanionSession = fakeSession('bot_critical_party', criticalCompanion);
    criticalCompanionSession.followPlayerSession = healerLeaderSession;
    criticalCompanionSession.partyCompanion = true;
    criticalCompanionSession.plan = 'following';
    World.user.sessions.push(criticalCompanionSession);
    FollowingState.tick(healerSession, healerBot, {
        skillExec(session, bot, data) { healerCasts.push(data); }
    }, { say() {}, executeCombat() {}, executePvPCombat() {} });
    assert.deepStrictEqual(healerCasts, [{ id: criticalCompanion.fetchId(), selfId: 1011, ctrl: false }], 'a critical party member must preempt a pending top-off approach');
    assert.strictEqual(healerSession.pendingSupportApproach, undefined, 'preempting a stale support approach must release its pending state after the emergency cast');
    World.user.sessions.pop();

    healerCasts.length = 0;
    healerBot.hp = 100;
    FollowingState.tick(healerSession, healerBot, {
        skillExec(session, bot, data) { healerCasts.push(data); }
    }, { say() {}, executeCombat() {}, executePvPCombat() {} });
    assert.strictEqual(healerSession.pendingSupportApproach.kind, 'top_off', 'the normal distant top-off should be queued again once the emergency is gone');
    healerBot.hp = 40;
    FollowingState.tick(healerSession, healerBot, {
        skillExec(session, bot, data) { healerCasts.push(data); }
    }, { say() {}, executeCombat() {}, executePvPCombat() {} });
    assert.deepStrictEqual(healerCasts, [{ id: healerBot.fetchId(), selfId: 1011, ctrl: false }], 'a badly wounded healer must preempt a pending top-off and preserve itself');
    healerBot.hp = 100;
    healerBot.locX = 80;
    woundedCompanion.locX = 120;
    woundedCompanion.hp = 25;

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

    const healChoiceBot = fakeActor(2000101, { classId: 15, mp: 500, maxMp: 500 });
    learnSkill(healChoiceBot, { selfId: 1011, name: 'Heal', spell: true, mp: 30 });
    learnSkill(healChoiceBot, { selfId: 1015, name: 'Battle Heal', spell: true, mp: 45 });
    learnSkill(healChoiceBot, { selfId: 1027, name: 'Group Heal', spell: true, mp: 80, distance: -1 });
    assert.strictEqual(BotSkillCapabilities.selectHealSkill(healChoiceBot).fetchSelfId(), 1011, 'routine healing should prefer the efficient single-target Heal');
    assert.strictEqual(BotSkillCapabilities.selectHealSkill(healChoiceBot, { emergency: true }).fetchSelfId(), 1015, 'emergency healing should prefer Battle Heal');
    assert.strictEqual(BotSkillCapabilities.selectHealSkill(healChoiceBot, { group: true }).fetchSelfId(), 1027, 'multiple wounded members should unlock Group Heal');

    const manaLeader = fakeActor(2000102, { locX: 0, locY: 0, classId: 0, mp: 5, maxMp: 100 });
    const manaLeaderSession = fakeSession('player_mana_policy_party', manaLeader);
    const rechargeHealer = fakeActor(2000103, { locX: 80, locY: 0, classId: 15 });
    learnSkill(rechargeHealer, { selfId: 1013, name: 'Recharge', spell: true, mp: 20 });
    const rechargeHealerSession = fakeSession('bot_party_recharger', rechargeHealer);
    rechargeHealerSession.followPlayerSession = manaLeaderSession;
    rechargeHealerSession.partyCompanion = true;
    rechargeHealerSession.plan = 'following';
    const lowManaArcher = fakeActor(2000104, { locX: 120, locY: 0, classId: 9, mp: 10, maxMp: 100 });
    const lowManaArcherSession = fakeSession('bot_low_mana_archer', lowManaArcher);
    lowManaArcherSession.followPlayerSession = manaLeaderSession;
    lowManaArcherSession.partyCompanion = true;
    lowManaArcherSession.plan = 'following';
    const lowManaSinger = fakeActor(2000108, { locX: 100, locY: 0, classId: 21, mp: 1, maxMp: 100 });
    const lowManaSingerSession = fakeSession('bot_low_mana_singer', lowManaSinger);
    lowManaSingerSession.followPlayerSession = manaLeaderSession;
    lowManaSingerSession.partyCompanion = true;
    lowManaSingerSession.plan = 'following';
    const lowManaDancer = fakeActor(2000109, { locX: 110, locY: 0, classId: 34, mp: 1, maxMp: 100 });
    const lowManaDancerSession = fakeSession('bot_low_mana_dancer', lowManaDancer);
    lowManaDancerSession.followPlayerSession = manaLeaderSession;
    lowManaDancerSession.partyCompanion = true;
    lowManaDancerSession.plan = 'following';
    World.user = { sessions: [manaLeaderSession, rechargeHealerSession, lowManaArcherSession, lowManaSingerSession, lowManaDancerSession] };
    World.npc = { spawns: [] };
    World.fetchNpcsInRadius = () => [];
    const rechargeCasts = [];
    FollowingState.tick(rechargeHealerSession, rechargeHealer, {
        skillExec(_session, _bot, data) { rechargeCasts.push(data); }
    }, { say() {}, executeCombat() {}, executePvPCombat() {} });
    assert.deepStrictEqual(rechargeCasts, [{ id: lowManaArcher.fetchId(), selfId: 1013, ctrl: false }], 'Recharge should skip a lower-MP melee fighter and restore a ranged party member instead');
    assert.strictEqual(BotRoles.needsPartyManaRecovery(lowManaSinger), false, 'Sword Singer is a melee buffer and must not recover MP as a caster');
    assert.strictEqual(BotRoles.needsPartyManaRecovery(lowManaDancer), false, 'Bladedancer is a melee buffer and must not recover MP as a caster');
    assert.strictEqual(BotRoles.needsPartyManaRecovery(fakeActor(2000111, { classId: 17 })), true, 'Prophet remains a caster buffer and should recover MP');
    const lowManaPaladin = fakeActor(2000112, { classId: 5 });
    assert.strictEqual(BotRoles.shouldRestForMana(lowManaPaladin), false, 'a Paladin must stay standing with the melee line when MP is low');
    assert.strictEqual(BotRoles.needsPartyManaRecovery(lowManaPaladin), true, 'a Paladin must remain eligible for Recharge so taunt control does not collapse');

    World.user = { sessions: [manaLeaderSession, lowManaSingerSession] };
    FollowingState.tick(lowManaSingerSession, lowManaSinger, {}, { say() {}, executeCombat() {}, executePvPCombat() {} });
    assert.strictEqual(lowManaSingerSession.plan, 'following', 'low MP alone must not seat a Sword Singer');
    assert.strictEqual(lowManaSinger.state.fetchSeated(), false, 'Sword Singer should stay on its feet at low MP');

    World.user = { sessions: [manaLeaderSession, lowManaDancerSession] };
    FollowingState.tick(lowManaDancerSession, lowManaDancer, {}, { say() {}, executeCombat() {}, executePvPCombat() {} });
    assert.strictEqual(lowManaDancerSession.plan, 'following', 'low MP alone must not seat a Bladedancer');
    assert.strictEqual(lowManaDancer.state.fetchSeated(), false, 'Bladedancer should stay on its feet at low MP');

    rechargeCasts.length = 0;
    rechargeHealerSession.currentTargetId = undefined;
    rechargeHealer.unselect();
    World.user = { sessions: [manaLeaderSession, rechargeHealerSession] };
    FollowingState.tick(rechargeHealerSession, rechargeHealer, {
        skillExec(_session, _bot, data) { rechargeCasts.push(data); }
    }, { say() {}, executeCombat() {}, executePvPCombat() {} });
    assert.strictEqual(rechargeCasts.length, 0, 'a melee party member must not receive Recharge even when it is the only low-MP target');

    const rechargePaladin = fakeActor(2000112, { locX: 100, locY: 0, classId: 5, mp: 10, maxMp: 100 });
    const rechargePaladinSession = fakeSession('bot_low_mana_paladin', rechargePaladin);
    rechargePaladinSession.followPlayerSession = manaLeaderSession;
    rechargePaladinSession.partyCompanion = true;
    rechargePaladinSession.plan = 'following';
    rechargeCasts.length = 0;
    manaLeaderSession.partyRecoveryCast = undefined;
    World.user = { sessions: [manaLeaderSession, rechargeHealerSession, rechargePaladinSession] };
    FollowingState.tick(rechargeHealerSession, rechargeHealer, {
        skillExec(_session, _bot, data) { rechargeCasts.push(data); }
    }, { say() {}, executeCombat() {}, executePvPCombat() {} });
    assert.deepStrictEqual(rechargeCasts, [{ id: rechargePaladin.fetchId(), selfId: 1013, ctrl: false }], 'Recharge should restore a standing tank below its taunt reserve');

    const lowManaMelee = fakeActor(2000105, { locX: 80, locY: 0, classId: 0, hp: 100, maxHp: 100, mp: 1, maxMp: 100 });
    const lowManaMeleeSession = fakeSession('bot_low_mana_melee', lowManaMelee);
    lowManaMeleeSession.followPlayerSession = manaLeaderSession;
    lowManaMeleeSession.partyCompanion = true;
    lowManaMeleeSession.plan = 'following';
    World.user = { sessions: [manaLeaderSession, lowManaMeleeSession] };
    FollowingState.tick(lowManaMeleeSession, lowManaMelee, {}, { say() {}, executeCombat() {}, executePvPCombat() {} });
    assert.strictEqual(lowManaMeleeSession.plan, 'following', 'a melee companion must keep following at critically low MP');
    assert.strictEqual(lowManaMelee.state.fetchSeated(), false, 'low MP alone must never seat a melee companion');

    lowManaMelee.state.setSeated(true);
    lowManaMeleeSession.plan = 'resting';
    RestingState.tick(lowManaMeleeSession, lowManaMelee, {}, { say() {} });
    assert.strictEqual(lowManaMeleeSession.plan, 'following', 'a melee companion already resting only for MP should immediately return to the party');
    assert.strictEqual(lowManaMelee.state.fetchSeated(), false, 'the stale MP-rest state must stand the melee companion up');

    const lowManaArcherRest = fakeActor(2000106, { locX: 80, locY: 0, classId: 9, hp: 100, maxHp: 100, mp: 1, maxMp: 100 });
    const lowManaArcherRestSession = fakeSession('bot_low_mana_archer_rest', lowManaArcherRest);
    lowManaArcherRestSession.followPlayerSession = manaLeaderSession;
    lowManaArcherRestSession.partyCompanion = true;
    lowManaArcherRestSession.plan = 'following';
    World.user = { sessions: [manaLeaderSession, lowManaArcherRestSession] };
    FollowingState.tick(lowManaArcherRestSession, lowManaArcherRest, {}, { say() {}, executeCombat() {}, executePvPCombat() {} });
    assert.strictEqual(lowManaArcherRestSession.plan, 'resting', 'a low-MP archer should still enter party recovery');
    assert.strictEqual(lowManaArcherRest.state.fetchSeated(), true, 'ranged MP users should continue sitting to recover mana');

    const lowHpMelee = fakeActor(2000107, { locX: 80, locY: 0, classId: 0, hp: 20, maxHp: 100, mp: 1, maxMp: 100 });
    const lowHpMeleeSession = fakeSession('bot_low_hp_melee_rest', lowHpMelee);
    lowHpMeleeSession.followPlayerSession = manaLeaderSession;
    lowHpMeleeSession.partyCompanion = true;
    lowHpMeleeSession.plan = 'following';
    World.user = { sessions: [manaLeaderSession, lowHpMeleeSession] };
    FollowingState.tick(lowHpMeleeSession, lowHpMelee, {}, { say() {}, executeCombat() {}, executePvPCombat() {} });
    assert.strictEqual(lowHpMeleeSession.plan, 'resting', 'low HP must still seat a melee companion regardless of its MP policy');

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

    learnSkill(healerAssistBot, { selfId: 1011, name: 'Heal', spell: true, mp: 15 });
    healerLeader.hp = 30;
    healerAssistBot.locX = 80;
    healerAssistBot.state.setHits(true);
    let interruptedAttackTimers = 0;
    healerAssistBot.attack = {
        clearTimers() { interruptedAttackTimers++; }
    };
    healerAssistOptions = null;
    const preemptiveHealCasts = [];
    FollowingState.tick(healerAssistSession, healerAssistBot, {
        skillExec(_session, _bot, data) { preemptiveHealCasts.push(data); }
    }, {
        say() {},
        executeCombat() { throw new Error('priority healing must interrupt an existing basic-attack loop'); },
        executePvPCombat() {}
    });
    assert.deepStrictEqual(preemptiveHealCasts, [{ id: healerLeader.fetchId(), selfId: 1011, ctrl: false }], 'a wounded party member must preempt an active healer melee loop');
    assert.strictEqual(interruptedAttackTimers, 1, 'preempting for a heal should cancel the scheduled follow-up melee hit');
    assert.strictEqual(healerAssistBot.state.fetchHits(), false, 'the healer must leave the native hitting state before casting');
    healerLeader.hp = 100;

    const buffLeader = fakeActor(2000100, { locX: 700, locY: 0 });
    const buffLeaderSession = fakeSession('player_buff_approach', buffLeader);
    const approachBufferBot = fakeActor(2000101, { locX: 0, locY: 0, classId: 17 });
    learnSkill(approachBufferBot, { selfId: 1204, name: 'Wind Walk', spell: true, distance: 400, mp: 20 });
    EffectStore.apply(approachBufferBot, { key: 'windWalk', id: 1204, level: 1, type: 'buff', stats: {}, durationMs: 600000 });
    const approachBufferSession = fakeSession('bot_buff_approach', approachBufferBot);
    approachBufferSession.followPlayerSession = buffLeaderSession;
    approachBufferSession.partyCompanion = true;
    approachBufferSession.plan = 'following';
    World.user = { sessions: [buffLeaderSession, approachBufferSession] };
    World.npc = { spawns: [] };
    World.fetchNpcsInRadius = () => [];
    const approachBuffCasts = [];
    FollowingState.tick(approachBufferSession, approachBufferBot, {
        skillExec(_session, _bot, data) { approachBuffCasts.push(data); }
    }, { say() {}, executeCombat() {}, executePvPCombat() {} });
    assert.strictEqual(approachBuffCasts.length, 0, 'an out-of-range buff should approach through party pathfinding before casting');
    assert.strictEqual(approachBufferSession.pendingSupportApproach?.kind, 'buff:windWalk', 'the missing buff must remain the authoritative pending support action');
    assert.strictEqual(approachBufferSession.roleDecision.action, 'move_for_support', 'the bot must report an approach, not a completed buff');
    approachBufferBot.locX = 350;
    FollowingState.tick(approachBufferSession, approachBufferBot, {
        skillExec(_session, _bot, data) { approachBuffCasts.push(data); }
    }, { say() {}, executeCombat() {}, executePvPCombat() {} });
    assert.deepStrictEqual(approachBuffCasts, [{ id: buffLeader.fetchId(), selfId: 1204, ctrl: false }], 'a pending buff should cast as soon as the provider reaches native range');
    assert.strictEqual(approachBufferSession.pendingSupportApproach, undefined, 'a completed buff approach must release its movement state');

    const partyAura = learnSkill(approachBufferBot, { selfId: 1007, name: 'Chant of Battle', spell: true, distance: -1, mp: 60 });
    assert.strictEqual(partyAura.fetchSemantic().radius, 1000, 'Chant of Battle should preserve its native 1000-unit aura radius');
    assert.strictEqual(
        C4SkillRules.resolve({ selfId: 1328, name: 'Mass Summon Storm Cubic', distance: -1 }).radius,
        80,
        'party skills without a wider datapack radius should retain the native C4 default instead of inheriting buff range'
    );
    let partyAuraTarget = null;
    const previousFetchUserForAura = World.fetchUser;
    World.fetchUser = () => ({
        catch() { return this; },
        then(resolve) {
            resolve(buffLeader);
            return { catch() { return this; } };
        }
    });
    approachBufferBot.attack = {
        remoteHit(_session, target, skill) {
            partyAuraTarget = { target, skill };
        }
    };
    SkillExec(approachBufferSession, approachBufferBot, { id: buffLeader.fetchId(), selfId: partyAura.fetchSelfId(), ctrl: false });
    World.fetchUser = previousFetchUserForAura;
    assert.strictEqual(partyAuraTarget?.target, approachBufferBot, 'a negative-range party aura must originate from its caster');
    assert.strictEqual(partyAuraTarget?.skill, partyAura, 'the native party aura cast must preserve the learned skill');

    BotSupportPlanner.queueSupportCast(approachBufferSession, {
        provider: approachBufferBot,
        target: buffLeader,
        skill: partyAura
    });
    assert.strictEqual(
        BotSupportPlanner.beginSupportCast(approachBufferSession, approachBufferBot, approachBufferBot, partyAura),
        true,
        'a caster-centered party aura must still claim the logical party member selected by the support planner'
    );
    assert.strictEqual(approachBufferSession.pendingSupportCast, undefined, 'an accepted party aura must consume its queued support marker');
    assert.strictEqual(approachBufferSession.activeSupportCast?.targetId, buffLeader.fetchId(), 'the active party aura should retain its logical support target');
    BotSupportPlanner.cancelSupportCast(approachBufferSession, approachBufferBot);

    const hateAura = learnSkill(approachBufferBot, { selfId: 18, name: 'Hate Aura', spell: false, distance: -1, mp: 40 });
    partyAuraTarget = null;
    approachBufferBot.attack = {
        remoteHit(_session, target, skill) {
            partyAuraTarget = { target, skill };
        }
    };
    SkillExec(approachBufferSession, approachBufferBot, { id: 999999, selfId: hateAura.fetchSelfId(), ctrl: true });
    assert.strictEqual(partyAuraTarget?.target, approachBufferBot, 'an enemy TARGET_AURA such as Hate Aura must originate from its caster');
    assert.strictEqual(partyAuraTarget?.skill, hateAura, 'Hate Aura must reach native area target resolution unchanged');

    const missingTarget = fakeActor(2000110, { locX: 100, locY: 0 });
    const missingTargetBuff = learnSkill(approachBufferBot, { selfId: 1068, name: 'Might', spell: true, distance: 400, mp: 20 });
    BotSupportPlanner.queueSupportCast(approachBufferSession, {
        provider: approachBufferBot,
        target: missingTarget,
        skill: missingTargetBuff
    });
    BotPartyChat.expectSkillResult(approachBufferSession, {
        target: missingTarget,
        skill: missingTargetBuff,
        kind: 'support'
    });
    const failedLookup = (message) => ({
        then() { return this; },
        catch(reject) { reject(new Error(message)); return this; }
    });
    World.fetchNpc = () => failedLookup('missing npc');
    World.fetchUser = () => failedLookup('missing user');
    SkillExec(approachBufferSession, approachBufferBot, { id: missingTarget.fetchId(), selfId: missingTargetBuff.fetchSelfId(), ctrl: false });
    assert.strictEqual(approachBufferSession.pendingSupportCast, undefined, 'a disappeared support target must release the queued party-support pause immediately');
    assert.strictEqual(approachBufferSession.pendingPartyChatResult, undefined, 'a disappeared support target must cancel its pending success announcement');
    World.fetchNpc = originalFetchNpc;
    World.fetchUser = originalFetchUser;
    World.user = { sessions: [healerLeaderSession, healerAssistSession] };
    World.npc = { spawns: [healerAssistThreat] };
    World.fetchNpcsInRadius = () => [healerAssistThreat];

    const busyAssistBot = fakeActor(2000098, { locX: 650, locY: 0, classId: 0 });
    const busyAssistSession = fakeSession('bot_busy_party_assist', busyAssistBot);
    busyAssistSession.followPlayerSession = healerLeaderSession;
    busyAssistSession.partyCompanion = true;
    busyAssistSession.plan = 'following';
    busyAssistBot.state.setTowards('move');
    let abortedOldFollow = 0;
    busyAssistBot.automation.abortAll = () => {
        abortedOldFollow++;
        busyAssistBot.state.setTowards(false);
    };
    let busyAssistTarget = null;
    World.user = { sessions: [healerLeaderSession, busyAssistSession] };
    FollowingState.tick(busyAssistSession, busyAssistBot, {}, {
        say() {},
        executeCombat(_session, _bot, npc) { busyAssistTarget = npc.fetchId(); },
        executePvPCombat() {}
    });
    assert.strictEqual(abortedOldFollow, 1, 'acquiring a party threat should cancel an obsolete follow movement');
    assert.strictEqual(busyAssistTarget, healerAssistThreat.fetchId(), 'the bot should attack instead of falling through to ready after cancelling follow');
    assert.strictEqual(busyAssistSession.currentTargetId, healerAssistThreat.fetchId(), 'a busy combat tick must retain the shared threat target');
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

    const aggressionRotationSkill = {
        fetchPassive: () => false,
        fetchSkillType: () => C4SkillRules.AGGRO_DAMAGE,
        fetchTargetKind: () => 'enemy',
        fetchSemantic: () => ({}),
        fetchDistance: () => 400,
        fetchConsumedMp: () => 10,
        fetchPower: () => 0
    };
    assert.strictEqual(
        BotCombatUtility.evaluate(unskilledTank, tankThreat, aggressionRotationSkill, 'tank'),
        null,
        'Aggression must not be selected as an ordinary tank damage skill'
    );

    const transferTank = fakeActor(2000054, { locX: 90, locY: 0, classId: 4 });
    const transferTankSession = fakeSession('bot_aggression_transfer_tank', transferTank);
    transferTankSession.followPlayerSession = healerLeaderSession;
    transferTankSession.partyCompanion = true;
    transferTankSession.plan = 'following';
    learnSkill(transferTank, { selfId: 28, name: 'Aggression', mp: 10 });
    World.user = { sessions: [healerLeaderSession, transferTankSession] };
    World.npc = { spawns: [tankThreat] };
    World.fetchNpcsInRadius = () => [tankThreat];
    let aggressionCasts = 0;
    let transferTankBasicAttacks = 0;
    FollowingState.tick(transferTankSession, transferTank, {
        skillExec() { aggressionCasts++; }
    }, {
        say() {}, executeCombat() { transferTankBasicAttacks++; }, executePvPCombat() {}
    });
    FollowingState.tick(transferTankSession, transferTank, {
        skillExec() { aggressionCasts++; }
    }, {
        say() {}, executeCombat() { transferTankBasicAttacks++; }, executePvPCombat() {}
    });
    assert.strictEqual(aggressionCasts, 1, 'a failed threat transfer must not cast Aggression again on the next AI tick');
    assert.strictEqual(transferTankBasicAttacks, 1, 'after one transfer attempt the tank must continue with normal combat');

    const tacticalPaladin = fakeActor(2000058, { locX: 0, locY: 0, classId: 5, hp: 40, maxHp: 100, mp: 100, maxMp: 100 });
    const legacyUltimateDefense = learnSkill(tacticalPaladin, { selfId: 110, name: 'Ultimate Defense', mp: 20 });
    legacyUltimateDefense.fetchSemantic = undefined;
    const survivalTactic = PartyClassTactics.selfAction(tacticalPaladin, { role: 'tank', activeMobs: 2 });
    assert.strictEqual(survivalTactic?.skill.fetchSelfId(), 110, 'a pressured low-HP Paladin should use Ultimate Defense as a class tactic');

    const tacticalTitan = fakeActor(2000061, { locX: 0, locY: 0, classId: 113, hp: 25, maxHp: 100, mp: 100, maxMp: 100 });
    learnSkill(tacticalTitan, { selfId: 139, name: 'Guts', mp: 20 });
    assert.strictEqual(
        PartyClassTactics.selfAction(tacticalTitan, { role: 'dps', activeMobs: 2 })?.skill.fetchSelfId(),
        139,
        'Titan must retain inherited Destroyer survival tactics after third-class transfer'
    );

    const hateTacticPaladin = fakeActor(2000059, { locX: 0, locY: 0, classId: 5, mp: 100, maxMp: 100 });
    learnSkill(hateTacticPaladin, { selfId: 18, name: 'Hate Aura', distance: -1, mp: 20 });
    const hateTargets = [1, 2].map((offset) => ({
        fetchId: () => 1100 + offset,
        fetchDestId: () => healerLeader.fetchId(),
        fetchLocX: () => offset * 50,
        fetchLocY: () => 0
    }));
    assert.strictEqual(
        PartyClassTactics.tankMassAggroAction(hateTacticPaladin, hateTargets)?.skill.fetchSelfId(),
        18,
        'a Paladin should use Hate Aura when multiple loose mobs are inside its native radius'
    );
    const legacyHatePaladin = fakeActor(2999002, { locX: 0, locY: 0, classId: 5, mp: 100, maxMp: 100 });
    const legacyHateAura = learnSkill(legacyHatePaladin, { selfId: 18, name: 'Legacy Hate Aura', distance: -1, mp: 20 });
    legacyHateAura.fetchSemantic = undefined;
    assert.strictEqual(PartyClassTactics.tankMassAggroAction(legacyHatePaladin, hateTargets), null,
        'legacy skills without semantic metadata must be ignored safely instead of throwing');

    const shieldStunPaladin = fakeActor(2000062, { locX: 0, locY: 0, classId: 5, mp: 100, maxMp: 100 });
    learnSkill(shieldStunPaladin, { selfId: 92, name: 'Shield Stun', distance: 40, mp: 20 });
    assert.strictEqual(
        PartyClassTactics.tankStunAction(shieldStunPaladin, hateTargets, { protectedRole: 'leader' }),
        null,
        'a shieldless tank must not reserve every combat tick for an unusable Shield Stun'
    );
    shieldStunPaladin.backpack.fetchEquippedArmors = () => [{ fetchKind: () => 'Armor.Shield' }];
    assert.strictEqual(
        PartyClassTactics.tankStunAction(shieldStunPaladin, hateTargets, { protectedRole: 'leader' })?.skill.fetchSelfId(),
        92,
        'an equipped shield should enable Shield Stun party protection'
    );

    const controlOracle = fakeActor(2000060, { locX: 0, locY: 0, classId: 29, mp: 100, maxMp: 100 });
    learnSkill(controlOracle, { selfId: 1201, name: 'Dryad Root', mp: 15 });
    const controlledAdd = PartyClassTactics.supportCrowdControl(controlOracle, hateTargets, { primaryTargetId: hateTargets[0].fetchId() });
    assert.strictEqual(controlledAdd?.target.fetchId(), hateTargets[1].fetchId(), 'support crowd control should skip the focused target and control an add');
    assert.strictEqual(controlledAdd?.skill.fetchSelfId(), 1201, 'an Oracle should use learned Dryad Root for add control');

    const autoPullTank = fakeActor(2000097, { locX: 90, locY: 0, mp: 20, maxMp: 100, classId: 4 });
    const autoPullTankSession = fakeSession('bot_auto_pull_tank', autoPullTank);
    autoPullTankSession.followPlayerSession = healerLeaderSession;
    autoPullTankSession.partyCompanion = true;
    autoPullTankSession.plan = 'following';
    learnSkill(autoPullTank, { selfId: 28, name: 'Aggression', mp: 30 });
    let autoPullTargetId = undefined;
    const autoPullTarget = {
        fetchId: () => 1010,
        fetchAttackable: () => true,
        isDead: () => false,
        fetchDestId: () => autoPullTargetId,
        fetchLocX: () => 150,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchName: () => 'free pull target'
    };
    World.user = { sessions: [healerLeaderSession, autoPullTankSession] };
    World.npc = { spawns: [autoPullTarget] };
    World.fetchNpcsInRadius = () => [autoPullTarget];
    let autoPullSkillCast = false;
    let autoPullOptions = null;
    FollowingState.tick(autoPullTankSession, autoPullTank, {
        skillExec() { autoPullSkillCast = true; }
    }, {
        say() {},
        executeCombat(_session, _bot, npc, _generics, options) {
            assert.strictEqual(npc, autoPullTarget, 'auto pull should attack the nearest safe target');
            autoPullOptions = options;
        },
        executePvPCombat() {}
    });
    assert.strictEqual(autoPullSkillCast, false, 'auto pull must not cast Aggression even when it is learned');
    assert.strictEqual(autoPullOptions?.basicAttackOnly, true, 'auto pull should start with a basic attack');
    assert.strictEqual(autoPullTankSession.roleDecision.reason, 'safe_pull', 'low MP should not disable a basic-attack pull');

    const scoredPuller = fakeActor(2000099, { locX: 0, locY: 0, level: 40, classId: 5 });
    const scoredLeader = fakeActor(2000100, { locX: 0, locY: 0, level: 40, classId: 0 });
    const scoredLeaderSession = fakeSession('player_scored_pull', scoredLeader);
    const scoredPullerSession = fakeSession('bot_scored_pull', scoredPuller);
    scoredPullerSession.followPlayerSession = scoredLeaderSession;
    scoredPullerSession.partyCompanion = true;
    const crowdedTarget = { ...autoPullTarget, fetchId: () => 1011, fetchLevel: () => 40, fetchLocX: () => 300, fetchClanName: () => 'ant', fetchClanHelpRadius: () => 400 };
    const socialAdd = { ...autoPullTarget, fetchId: () => 1012, fetchLevel: () => 40, fetchLocX: () => 320, fetchClanName: () => 'ant', fetchClanHelpRadius: () => 400 };
    const safeTarget = { ...autoPullTarget, fetchId: () => 1013, fetchLevel: () => 40, fetchLocX: () => 800 };
    World.user = { sessions: [scoredLeaderSession, scoredPullerSession] };
    World.fetchNpcsInRadius = (x) => x < 500 ? [crowdedTarget, socialAdd] : [safeTarget];
    const crowdedScore = PartyPulling.scorePullTarget(scoredPuller, scoredLeaderSession, crowdedTarget);
    const safeScore = PartyPulling.scorePullTarget(scoredPuller, scoredLeaderSession, safeTarget);
    assert.ok(safeScore.score > crowdedScore.score, 'pull scoring should prefer a slightly farther isolated mob over a crowded social-risk target');
    assert.ok(crowdedScore.reasons.includes('social:1'), 'pull scoring should expose its social-risk reason');
    World.user = { sessions: [healerLeaderSession, autoPullTankSession] };
    World.npc = { spawns: [autoPullTarget] };
    World.fetchNpcsInRadius = () => [autoPullTarget];

    // The shared party setting is authoritative. A stale per-session mirror
    // must never revive the legacy tank fallback after Pull Off.
    PartyCompanionService.updateSettings(healerLeaderSession, { pullMode: 'off', pullerId: null });
    autoPullTankSession.autoTaunt = true;
    autoPullTankSession.currentTargetId = undefined;
    autoPullTank.unselect();
    let disabledPullCombat = false;
    FollowingState.tick(autoPullTankSession, autoPullTank, {
        skillExec() { disabledPullCombat = true; }
    }, {
        say() {},
        executeCombat() { disabledPullCombat = true; },
        executePvPCombat() {}
    });
    assert.strictEqual(disabledPullCombat, false, 'Pull Off must block tank safe-pull even when session.autoTaunt is stale');
    assert.notStrictEqual(autoPullTankSession.roleDecision.action, 'avoid_overpull', 'Pull Off should remain a quiet order instead of looking like a failed overpull check');
    PartyCompanionService.updateSettings(healerLeaderSession, { pullMode: 'auto', pullerId: null });

    autoPullTank.mp = 100;
    autoPullTargetId = autoPullTank.fetchId();
    PartyAwareness.invalidateThreatProjection(healerLeaderSession);
    let engagedPulledTarget = null;
    FollowingState.tick(autoPullTankSession, autoPullTank, {
        skillExec() { autoPullSkillCast = true; }
    }, {
        say() {},
        executeCombat(_session, _bot, npc) { engagedPulledTarget = npc; },
        executePvPCombat() {}
    });
    assert.strictEqual(autoPullSkillCast, false, 'a mob already attacking its tank must not be taunted again');
    assert.strictEqual(engagedPulledTarget, autoPullTarget, 'the tank should fight the mob it already pulled');
    const fallenAutoPullMember = fakeActor(2000098, { locX: 60, locY: 0 });
    fallenAutoPullMember.state.dead = true;
    const fallenAutoPullSession = fakeSession('bot_auto_pull_fallen_member', fallenAutoPullMember);
    fallenAutoPullSession.followPlayerSession = healerLeaderSession;
    fallenAutoPullSession.partyCompanion = true;
    fallenAutoPullSession.plan = 'following';
    autoPullTargetId = undefined;
    PartyAwareness.invalidateThreatProjection(healerLeaderSession);
    autoPullTankSession.currentTargetId = undefined;
    autoPullTank.unselect();
    World.user = { sessions: [healerLeaderSession, autoPullTankSession, fallenAutoPullSession] };
    let blockedAutoPullCombat = false;
    FollowingState.tick(autoPullTankSession, autoPullTank, {
        skillExec() { blockedAutoPullCombat = true; }
    }, {
        say() {},
        executeCombat() { blockedAutoPullCombat = true; },
        executePvPCombat() {}
    });
    assert.strictEqual(blockedAutoPullCombat, false, 'auto pull must wait for a fallen party member to be resurrected');
    assert.strictEqual(autoPullTankSession.roleDecision.reason, 'party_revival', 'auto pull pause should report the pending party revival');

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
    MarketOpportunity.hotOffers = () => ([{
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
    MarketOpportunity.hotOffers = originalHotOffers;

    const starterTownLeader = fakeActor(2000046, { locX: 45475, locY: 48359, locZ: -3060 });
    const starterTownLeaderSession = fakeSession('player_elven_town_errand_party', starterTownLeader);
    const starterTownSeller = fakeActor(2000047, { locX: 45520, locY: 48359, locZ: -3060 });
    const starterTownBot = fakeActor(2000048, { locX: 45500, locY: 48359, locZ: -3060 });
    const starterTownSession = fakeSession('bot_elven_town_market_errand', starterTownBot);
    starterTownSession.followPlayerSession = starterTownLeaderSession;
    starterTownSession.partyCompanion = true;
    starterTownSession.plan = 'following';
    starterTownSession.coldLifeState = { stats: { equipmentPlan: { strategy: 'market', target: { selfId: 1 } } } };
    MarketOpportunity.hotOffers = () => ([{
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
    MarketOpportunity.hotOffers = originalHotOffers;

    const fieldNearStarterLeader = fakeActor(2000051, { locX: 49475, locY: 48359, locZ: -3060 });
    const fieldNearStarterLeaderSession = fakeSession('player_near_elven_field_party', fieldNearStarterLeader);
    const fieldNearStarterBot = fakeActor(2000052, { locX: 49500, locY: 48359, locZ: -3060 });
    const fieldNearStarterSession = fakeSession('bot_near_elven_field_market', fieldNearStarterBot);
    fieldNearStarterSession.followPlayerSession = fieldNearStarterLeaderSession;
    fieldNearStarterSession.partyCompanion = true;
    fieldNearStarterSession.plan = 'following';
    fieldNearStarterSession.coldLifeState = { stats: { equipmentPlan: { strategy: 'market', target: { selfId: 1 } } } };
    MarketOpportunity.hotOffers = () => ([{
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
    MarketOpportunity.hotOffers = originalHotOffers;

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

    const rangedPullAdd = {
        ...pulledMob,
        id: 3012,
        locX: 1250,
        destId: partyHudBotA.fetchId(),
        fetchId() { return this.id; },
        fetchDestId() { return this.destId; },
        fetchName: () => 'ranged pull add'
    };
    partyHudBotA.locX = 1100;
    partyHudLeaderSession.partyPullState.phase = 'return';
    World.npc = { spawns: [pulledMob, rangedPullAdd] };
    World.fetchNpcsInRadius = () => [rangedPullAdd];
    let rangedAddAssistId = null;
    FollowingState.tick(partyHudBotBSession, partyHudBotB, {}, {
        say() {},
        executeCombat(_session, _bot, npc) { rangedAddAssistId = npc.fetchId(); },
        executePvPCombat() {}
    });
    assert.strictEqual(rangedAddAssistId, null, 'the camp must not run toward a ranged add that targets only a travelling puller');
    assert.strictEqual(partyHudBotBSession.roleDecision.reason, 'hold_for_pull', 'a ranged add on the distant puller should preserve camp formation');
    partyHudBotA.locX = partyHudLeader.locX;
    FollowingState.tick(partyHudBotBSession, partyHudBotB, {}, {
        say() {},
        executeCombat(_session, _bot, npc) { rangedAddAssistId = npc.fetchId(); },
        executePvPCombat() {}
    });
    assert.strictEqual(rangedAddAssistId, rangedPullAdd.fetchId(), 'once the puller returns, the party must chase a ranged add that keeps firing from outside camp');
    World.npc = { spawns: [pulledMob] };
    World.fetchNpcsInRadius = () => [pulledMob];
    partyHudBotA.locX = 40;
    partyHudLeaderSession.partyPullState.phase = 'approach';
    pulledMob.destId = undefined;
    partyHudBotBSession.currentTargetId = undefined;
    partyHudBotB.unselect();

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
    const pullAdd = {
        fetchId: () => 3013,
        fetchAttackable: () => true,
        isDead: () => false,
        fetchDestId: () => partyHudBotB.fetchId(),
        fetchLocX: () => partyHudBotB.fetchLocX() + 100,
        fetchLocY: () => partyHudBotB.fetchLocY(),
        fetchLocZ: () => partyHudBotB.fetchLocZ(),
        state: { fetchCombats: () => true },
        fetchStateAttack: () => true
    };
    World.npc = { spawns: [pulledMob, pullAdd] };
    World.fetchNpcsInRadius = () => [pulledMob, pullAdd];
    let stoppedOpeningAttack = 0;
    partyHudBotA.attack = {
        clearTimers() { stoppedOpeningAttack++; },
        abortCast() {}
    };
    FollowingState.tick(partyHudBotASession, partyHudBotA, {}, {
        say() {}, executeCombat() { throw new Error('confirmed aggro must return even while the camp handles an add'); }, executePvPCombat() {}
    });
    assert.strictEqual(partyHudBotASession.roleDecision.reason, 'return', 'confirmed aggro must outrank an unrelated party-under-attack pause');
    assert.strictEqual(stoppedOpeningAttack, 1, 'confirmed pull aggro must stop the repeating opening basic attack');
    World.npc = { spawns: [pulledMob] };
    World.fetchNpcsInRadius = () => [pulledMob];
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
    let campArrivalAssistId = null;
    FollowingState.tick(partyHudBotBSession, partyHudBotB, {}, {
        say() {},
        executeCombat(_session, _bot, npc) { campArrivalAssistId = npc.fetchId(); },
        executePvPCombat() {}
    });
    assert.strictEqual(campArrivalAssistId, pulledMob.fetchId(), 'party should attack as soon as an aggroed pull reaches camp, before the puller finishes its return tick');

    // The camp-radius check is intentionally stricter than a puller's own
    // melee range. The tank must nevertheless keep hitting a held target it
    // can already reach, including at low HP; it may not sit and turn the
    // whole party into "party_recovering" while the target is alive.
    partyHudLeaderSession.partyPullState = {
        targetId: pulledMob.fetchId(),
        pullerId: partyHudBotA.fetchId(),
        source: 'bot',
        phase: 'engage',
        startedAt: Date.now()
    };
    partyHudBotA.locX = 180;
    partyHudBotA.hp = 20;
    partyHudBotA.state.setSeated(false);
    pulledMob.locX = 400;
    pulledMob.destId = partyHudBotA.fetchId();
    let heldPullerAssistId = null;
    FollowingState.tick(partyHudBotASession, partyHudBotA, {}, {
        say() {},
        executeCombat(_session, _bot, npc) { heldPullerAssistId = npc.fetchId(); },
        executePvPCombat() {}
    });
    assert.strictEqual(heldPullerAssistId, pulledMob.fetchId(), 'puller should attack a held target in its own range before full camp delivery');
    assert.strictEqual(partyHudBotA.state.fetchSeated(), false, 'low-HP puller must not sit while its living pull target is active');
    partyHudBotA.hp = partyHudBotA.maxHp;
    partyHudBotA.locX = partyHudLeader.locX;
    pulledMob.locX = partyHudBotB.locX + 160;
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
    pulledMob.locX = 900;
    let rangedPullChaseId = null;
    FollowingState.tick(partyHudBotBSession, partyHudBotB, {}, {
        say() {},
        executeCombat(_session, _bot, npc) { rangedPullChaseId = npc.fetchId(); },
        executePvPCombat() {}
    });
    assert.strictEqual(rangedPullChaseId, pulledMob.fetchId(), 'after the puller returns, melee companions should chase a ranged pull that refuses to enter camp');
    pulledMob.locX = partyHudBotB.locX + 160;
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
    CompanionControl(partyHudLeaderSession, ['companion-control', 'member-pull', 'off', partyHudBotA.fetchName()]);
    assert.strictEqual(PartyCompanionService.getSettings(partyHudLeaderSession).pullMode, 'off', 'Stop Pull must disable automatic fallback pulls');
    assert.strictEqual(PartyPulling.enabled(PartyCompanionService.getSettings(partyHudLeaderSession)), false, 'Stop Pull must disable the tank auto-pull behaviour');
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
        dead: false,
        fetchId: () => 3012,
        fetchAttackable: () => true,
        isDead() { return this.dead; },
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
    let pullingBotAssistId = null;
    FollowingState.tick(partyHudBotASession, partyHudBotA, {}, {
        say() {},
        executeCombat(_session, _bot, npc) { pullingBotAssistId = npc.fetchId(); },
        executePvPCombat() {}
    });
    assert.strictEqual(partyHudBotASession.roleDecision.reason, 'party_under_attack', 'an unrelated incoming threat must pause bot pulling');
    assert.strictEqual(partyHudLeaderSession.partyPullState.targetId, undefined, 'a live party threat must not be replaced with a new pull target');
    assert.strictEqual(partyHudBotA.moves.length, 0, 'a paused puller must stay with the party during an active fight');
    assert.strictEqual(pullingBotAssistId, activeAdd.fetchId(), 'a paused puller must join ordinary party combat against the active add');

    activeAdd.dead = true;
    partyHudLeader.destId = undefined;
    FollowingState.tick(partyHudBotASession, partyHudBotA, {}, {
        say() {}, executeCombat() {}, executePvPCombat() {}
    });
    assert.strictEqual(partyHudLeaderSession.partyPullState.targetId, freePullTarget.fetchId(), 'pulling must resume with a new target after the party clears every active mob');
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
    partyHudBotASession.incomingThreatId = activeAdd.fetchId();
    partyHudBotASession.incomingThreatAt = Date.now();
    assert.strictEqual(PartyCompanionService.detach(partyHudLeaderSession, partyHudBotASession), true, 'dismiss should detach a companion');
    assert.strictEqual(clearedPullTimers, 2, 'dismissing the selected puller should also cancel its scheduled pull action');
    assert.strictEqual(PartyCompanionService.getSettings(partyHudLeaderSession).pullMode, 'auto', 'dismissing the selected puller should clear party pull instead of silently assigning another bot');
    const oneMemberPacket = lastPartyAllPacket(partyHudLeaderSession);
    assert(oneMemberPacket, 'dismissing one companion should rebuild the party window');
    assert.strictEqual(oneMemberPacket.readInt32LE(5), 2, 'party window should keep the stored loot distribution after detach');
    assert.strictEqual(oneMemberPacket.readInt32LE(9), 1, 'party window should keep the remaining companion');
    assert.strictEqual(partyHudBotASession.partyCompanion, false, 'dismissed companion should clear party flag');
    assert.strictEqual(partyHudBotASession.followPlayerSession, null, 'dismissed companion should clear leader link');
    assert.strictEqual(partyHudBotASession.incomingThreatId, undefined, 'dismissed companion should discard the old party threat target');
    assert.strictEqual(partyHudBotASession.incomingThreatAt, undefined, 'dismissed companion should discard the old party threat timestamp');
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

    toolBot.classId = 15;
    learnSkill(toolBot, { selfId: 1204, name: 'Wind Walk', spell: true, distance: 400, mp: 20 });
    let learnedHealerBuffCast = null;
    ActorGenerics.skillExec = (_session, _bot, data) => { learnedHealerBuffCast = data; };
    const learnedHealerBuff = BotAgentTools.execute(toolSession, {
        action: 'buff_target',
        confidence: 0.9,
        reply: '',
        targetPlayerName: leader.fetchName(),
        spotId: '',
        buffType: 'windWalk',
        reason: 'player_order'
    }, [{ id: leader.fetchId(), name: leader.fetchName() }]);
    assert.strictEqual(learnedHealerBuff.applied, true, 'a healer that actually learned the requested friendly buff should be allowed to use it');
    assert.deepStrictEqual(learnedHealerBuffCast, { id: leader.fetchId(), selfId: 1204, ctrl: false }, 'the direct buff tool should execute the learned skill instead of rejecting the healer role');
    assert.strictEqual(toolSession.pendingSupportCast?.skillId, 1204, 'a direct buff request must protect its native approach from normal follow movement');

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

    toolBot.setMp(50);
    const orderedRestResult = BotAgentTools.execute(toolSession, {
        action: 'rest',
        confidence: 0.9,
        reply: '',
        targetPlayerName: '',
        spotId: '',
        buffType: '',
        reason: 'player_order'
    }, []);
    assert.strictEqual(orderedRestResult.reason, 'rest', 'a direct rest order should seat a companion that still needs recovery');
    assert.strictEqual(toolSession.explicitRestOrder, true, 'the rest tool should preserve direct player authority across later AI ticks');
    assert.strictEqual(toolBot.state.fetchSeated(), true, 'a companion with missing recovery resources should obey the direct sit order');

    toolBot.setMp(1);
    const rejectedDuringRest = BotAgentTools.execute(toolSession, {
        action: 'buff_target',
        confidence: 0.9,
        reply: '',
        targetPlayerName: leader.fetchName(),
        spotId: '',
        buffType: 'windWalk',
        reason: 'player_order'
    }, [{ id: leader.fetchId(), name: leader.fetchName() }]);
    assert.strictEqual(rejectedDuringRest.reason, 'low_mp_for_buff', 'the invalidating command should reach its native MP rejection');
    assert.strictEqual(toolSession.explicitRestOrder, true, 'a rejected mutation must not cancel an active direct rest order');

    toolBot.setMp(50);
    const successfulMutation = BotAgentTools.execute(toolSession, {
        action: 'hunt',
        confidence: 0.9,
        reply: '',
        targetPlayerName: '',
        spotId: '',
        buffType: '',
        reason: 'player_order'
    }, []);
    assert.strictEqual(successfulMutation.applied, true, 'the replacement party-hunt order should be accepted');
    assert.strictEqual(toolSession.explicitRestOrder, undefined, 'a successfully applied mutation should supersede the direct rest order');

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

    const followingStages = HotActorLodPolicy.snapshot([]).subsystems;
    [
        'following.revival',
        'following.raidContext',
        'following.pullContext',
        'following.partyVitals',
        'following.townErrand',
        'following.supportPlan',
        'following.rebuffPlan',
        'following.partyAggro'
    ].forEach((stage) => {
        assert(followingStages[stage]?.count > 0, `${stage} telemetry must sample its live decision phase`);
    });
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
    MarketOpportunity.hotOffers = originalHotOffers;
    ActorGenerics.skillExec = originalSkillExec;
}

console.log('Party companion rest/follow regression checks passed');
