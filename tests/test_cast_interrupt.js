const assert = require('assert');

require('../src/Global');

const Attack = invoke('GameServer/Actor/Attack');
const State = invoke('GameServer/Model/State');
const destCancel = invoke('GameServer/Network/Request/DestCancel');
const skillRequest = invoke('GameServer/Actor/Generics/SkillRequest');
const HotPartyCastTracker = invoke('GameServer/Bot/AI/HotPartyCastTracker');
const npcDie = invoke('GameServer/Npc/Generics/Die');
const ActorGenerics = invoke('GameServer/Actor/Generics');
const SpoilSweep = invoke('GameServer/Npc/SpoilSweep');
const DataCache = invoke('GameServer/DataCache');
const SkillEffects = invoke('GameServer/Skills/C4SkillEffects');

function actor(overrides = {}) {
    const state = new State();
    return {
        state,
        attack: null,
        storedSpell: { selfId: 1 },
        skillReuseUntil: new Map(),
        fetchId: () => overrides.id ?? 2000001,
        fetchMp: () => overrides.mp ?? 50,
        setMp(value) { this.mp = value; },
        fetchHp: () => overrides.hp ?? 100,
        setHp(value) { this.hp = value; },
        fetchCollectiveCastSpd: () => 333,
        fetchCollectiveAtkSpd: () => 333,
        fetchCollectiveMAtk: () => 100,
        fetchCollectivePAtk: () => 100,
        fetchLocX: () => 100,
        fetchLocY: () => 200,
        fetchLocZ: () => -300,
        fetchHead: () => 0,
        fetchMaxHp: () => 100,
        statusUpdateVitals() {},
        automation: { replenishVitals() {} },
        backpack: {
            consumeSpiritshot(session, callback) { callback(false); },
            consumeSoulshot(session, callback) { callback(false); },
            fetchTotalWeaponPAtkRnd: () => 0
        },
        canUseSkill(skill, now = Date.now()) {
            return (this.skillReuseUntil.get(skill.fetchSelfId()) || 0) <= now;
        },
        markSkillReuse(skill, now = Date.now()) {
            this.skillReuseUntil.set(skill.fetchSelfId(), now + skill.fetchReuseTime());
        },
        isDead: () => false
    };
}

function target() {
    return {
        state: new State(),
        fetchId: () => 3000001,
        fetchCollectiveMDef: () => 100,
        fetchCollectivePDef: () => 100,
        fetchShieldRate: () => 0,
        fetchLocX: () => 140,
        fetchLocY: () => 220,
        fetchLocZ: () => -300,
        fetchHead: () => 0,
        isDead: () => false
    };
}

function skill(overrides = {}) {
    return {
        fetchConsumedMp: () => 10,
        fetchConsumedHp: () => 0,
        fetchSpell: () => true,
        fetchHitTime: () => 5000,
        fetchReuseTime: () => 1000,
        fetchCalculatedHitTime() { return this.calculatedHitTime; },
        setCalculatedHitTime(value) { this.calculatedHitTime = value; },
        fetchSelfId: () => overrides.selfId ?? 1011,
        fetchLevel: () => overrides.level ?? 1,
        fetchPower: () => overrides.power ?? 10,
        fetchTargetKind: () => overrides.targetKind ?? 'enemy',
        fetchSemantic: () => ({ skillType: 'damage', trait: 'wind' }),
        fetchSsBoost: () => 1
    };
}

const savedSetTimeout = global.setTimeout;
const savedClearTimeout = global.clearTimeout;
const savedNpcDied = ActorGenerics.npcDied;
const savedFetchNpcRewardsFromSelfId = DataCache.fetchNpcRewardsFromSelfId;
const savedExecuteSkill = SkillEffects.execute;
const timers = [];
global.setTimeout = (callback, delay) => {
    const timer = { callback, delay, canceled: false };
    timers.push(timer);
    return timer;
};
global.clearTimeout = (timer) => {
    timer.canceled = true;
};

try {
    ActorGenerics.npcDied = () => {};
    DataCache.fetchNpcRewardsFromSelfId = (_selfId, callback) => callback({
        spoils: [{ items: [{ selfId: 57, chance: 100, min: 1, max: 1 }] }]
    });
    const attack = new Attack();
    const caster = actor();
    caster.attack = attack;
    const victim = target();
    const packets = [];
    const session = {
        actor: caster,
        dataSendToMe(packet) { packets.push(packet); },
        dataSendToMeAndOthers(packet) { packets.push(packet); }
    };

    attack.remoteHit(session, victim, skill());
    assert.strictEqual(caster.state.fetchCasts(), true, 'remote skill should mark actor as casting before hit time');
    assert.strictEqual(timers.length, 2, 'remote skill schedules launch and impact from the same start');
    assert.strictEqual(timers[0].delay, 4600, 'launch happens 400 ms before the 5000 ms cast ends');
    assert.strictEqual(caster.canUseSkill(skill()), false, 'starting a cast should start that skill reuse timer');

    destCancel(session, Buffer.from([0x37, 0x00, 0x00]));
    assert.strictEqual(caster.state.fetchCasts(), false, 'ESC target cancel should clear casting state');
    assert.strictEqual(caster.storedSpell, undefined, 'ESC target cancel should clear stored spell');
    assert(timers.every((timer) => timer.canceled), 'ESC target cancel should clear pending skill timers');
    assert(packets.some((packet) => packet[0] === 0x49), 'ESC target cancel should broadcast MagicSkillCanceld');
    assert(packets.some((packet) => packet[0] === 0x25), 'ESC target cancel should send ActionFailed');

    timers.filter((timer) => !timer.canceled).forEach((timer) => timer.callback());
    assert.strictEqual(caster.mp, undefined, 'aborted cast should not consume MP');

    timers.length = 0;
    packets.length = 0;
    const landingAttack = new Attack();
    const landingCaster = actor({ id: 2000002 });
    landingCaster.attack = landingAttack;
    const landingSession = {
        actor: landingCaster,
        dataSendToMe(packet) { packets.push(packet); },
        dataSendToMeAndOthers(packet) { packets.push(packet); }
    };
    landingAttack.remoteHit(landingSession, victim, skill({ power: 0, level: 8 }));
    const startPacket = packets.find(packet => packet[0] === 0x48);
    assert.strictEqual(startPacket.readInt32LE(13), 8, 'cast start must identify the learned skill level, not level one');
    assert.strictEqual(startPacket.readInt32LE(17), 5000, 'skill level must not shift the cast-time wire field');
    timers.find((timer) => !timer.canceled && timer.delay > 0).callback();
    assert(packets.some((packet) => packet[0] === 0x76 && packet.readInt32LE(5) === 1011), 'magic launch precedes impact');
    const launchPacket = packets.find(packet => packet[0] === 0x76);
    assert.strictEqual(launchPacket.readInt32LE(9), startPacket.readInt32LE(13), 'start and launch must refer to the same skill level');
    assert(startPacket.__packetTrace.includes('level=8:hitTime=5000'));
    assert(launchPacket.__packetTrace.includes('level=8:targets=3000001'));
    assert.strictEqual(landingCaster.mp, undefined, 'launch must not spend MP');
    assert.strictEqual(landingCaster.state.fetchCasts(), true, 'actor remains busy during the launch-to-impact interval');
    assert.strictEqual(timers.at(-1).delay, 5000);
    assert.strictEqual(timers.at(-1).delay - timers[0].delay, 400);
    timers.at(-1).callback();
    assert.strictEqual(landingCaster.mp, 40, 'MP is spent at the original cast deadline');
    assert.strictEqual(landingCaster.state.fetchCasts(), false);
    assert.strictEqual(packets.filter(packet => packet[0] === 0x76).length, 1, 'impact must not replay the projectile animation');

    landingAttack.broadcastShotCharge(landingSession, landingCaster, 2061);
    const shotPacket = packets.at(-1);
    assert.strictEqual(shotPacket.readInt32LE(9), 2061);
    assert.strictEqual(shotPacket.readInt32LE(13), 1, 'shot pseudo-skills without fetchLevel must retain level one');
    assert.strictEqual(shotPacket.readInt32LE(17), 0, 'shot activation remains instantaneous');

    // Exercise the actual native cast timer chain, with damage calculation
    // isolated from timing. The hit itself must not run in the launch phase.
    SkillEffects.execute = () => ({ damage: 17 });
    for (const scenario of ['complete', 'cancel_after_launch', 'target_dies', 'short', 'physical', 'spiritshot', 'fastest']) {
        timers.length = 0; packets.length = 0;
        const a = actor(), v = target(), runtime = new Attack();
        a.attack = runtime;
        a.spiritshotLoaded = scenario === 'spiritshot';
        if (scenario === 'fastest') a.fetchCollectiveCastSpd = () => 10000;
        const k = skill();
        if (scenario === 'short') {
            k.fetchHitTime = () => 200;
            k.fetchSemantic = () => ({ staticHitTime: true });
        }
        if (scenario === 'physical') k.fetchSpell = () => false;
        const s = { actor: a, dataSendToMe(packet) { packets.push(packet); },
            dataSendToMeAndOthers(packet) { packets.push(packet); } };
        let damage = 0;
        runtime.hit = (_s, _a, _v, amount) => { damage += amount; };
        runtime.remoteHit(s, v, k);
        const total = k.fetchCalculatedHitTime();
        const split = !['short', 'physical'].includes(scenario);
        assert.strictEqual(timers[0].delay, total - (split ? 400 : 0), scenario);
        assert.strictEqual(damage, 0);
        timers[0].callback();
        if (split) {
            assert.strictEqual(damage, 0, `${scenario}: launch is visual only`);
            assert.strictEqual(a.mp, undefined);
            assert.strictEqual(timers.at(-1).delay, total);
            assert.strictEqual(timers.at(-1).delay - timers[0].delay, 400);
            if (scenario === 'cancel_after_launch') {
                destCancel(s, Buffer.from([0x37, 0, 0]));
                assert(timers.at(-1).canceled, 'ESC cancels the pending impact');
                assert.strictEqual(a.mp, undefined);
                assert.strictEqual(damage, 0);
                continue;
            }
            if (scenario === 'target_dies') v.state.setDead(true);
            timers.at(-1).callback();
        }
        if (scenario === 'target_dies') {
            assert.strictEqual(damage, 0, 'a target that died in flight is not hit');
            assert.strictEqual(a.mp, undefined);
        } else {
            assert.strictEqual(damage, 17, `${scenario}: one hit at impact`);
            assert.strictEqual(a.mp, 40);
        }
        assert.strictEqual(a.state.fetchCasts(), false);
        assert.strictEqual(packets.filter(p => p[0] === 0x76).length, scenario === 'physical' ? 0 : 1);
        runtime.clearTimers();
    }
    SkillEffects.execute = savedExecuteSkill;

    const cooldownPackets = [];
    const cooldownActor = actor();
    cooldownActor.skillReuseUntil.set(1011, Date.now() + 1000);
    cooldownActor.skillset = { fetchSkill: () => skill() };
    cooldownActor.fetchDestId = () => victim.fetchId();
    cooldownActor.isBlocked = () => {
        throw new Error('a skill on reuse must not be queued');
    };
    skillRequest({
        actor: cooldownActor,
        dataSendToMe(packet) { cooldownPackets.push(packet); }
    }, cooldownActor, { selfId: 1011 });
    assert(cooldownPackets.some((packet) => packet[0] === 0x25), 'a skill on reuse should be rejected before it can be cast or queued');

    timers.length = 0;
    packets.length = 0;
    landingAttack.remoteHit(landingSession, victim, skill());
    assert.strictEqual(timers.length, 0, 'a direct cast path must not schedule a skill that is still on reuse');
    assert(packets.some((packet) => packet[0] === 0x25), 'a direct cast path should reject a skill that is still on reuse');

    timers.length = 0;
    packets.length = 0;
    const partyAttack = new Attack();
    const partyCaster = actor({ id: 2000003 });
    partyCaster.attack = partyAttack;
    const partySession = {
        accountId: 'bot_party_caster',
        actor: partyCaster,
        partyCompanion: true,
        followPlayerSession: { accountId: 'party_leader' },
        dataSendToMe(packet) { packets.push(packet); },
        dataSendToMeAndOthers(packet) { packets.push(packet); }
    };
    const dyingVictim = {
        ...target(),
        model: {},
        fetchId: () => 3000002,
        fetchAttackable: () => true,
        fetchIsRaidBoss: () => false,
        destructor() {}
    };

    partyAttack.remoteHit(partySession, dyingVictim, skill());
    assert.strictEqual(HotPartyCastTracker.trackedCount(dyingVictim), 1,
        'a hot party cast should register once against its concrete NPC target');
    assert.strictEqual(timers.filter((timer) => !timer.canceled).length, 2,
        'event-driven death cancellation only needs the launch and impact timers, not HP polling');

    // A courier may cast while a native weapon swing is still in flight.
    // Cancelling the cast clears both timers, so both busy flags must end.
    partyCaster.state.setHits(true);
    partyAttack.queueTimer(() => partyCaster.state.setHits(false), 1000);
    npcDie({ dataSendToMeAndOthers() {} }, {}, dyingVictim);
    assert.strictEqual(dyingVictim.state.fetchDead(), true, 'the NPC death boundary must become authoritative first');
    assert.strictEqual(partyCaster.state.fetchCasts(), false,
        'an in-flight hot party cast must be cancelled when its NPC target dies');
    assert.strictEqual(partyCaster.state.isBlocked(), false,
        'target death must not leave the cancelled swing blocking movement to the next quest target');
    assert.strictEqual(HotPartyCastTracker.trackedCount(dyingVictim), 0,
        'death cancellation must release the target watcher immediately');
    assert(timers.every((timer) => timer.canceled),
        'NPC death must cancel the pending cast landing timer');
    assert.strictEqual(partyCaster.mp, undefined,
        'a cast cancelled by NPC death must not consume MP');
    assert.strictEqual(partySession.lastCombatDecision.reason, 'target_died',
        'the cheap cancellation should remain visible in hot-party combat telemetry');
    assert(packets.some((packet) => packet[0] === 0x49),
        'party cast cancellation must broadcast the native cancelled-cast packet');

    timers.length = 0;
    packets.length = 0;
    const spoilerAttack = new Attack();
    const spoiler = actor({ id: 2000004, mp: 50 });
    spoiler.attack = spoilerAttack;
    spoiler.fetchName = () => 'Party Spoiler';
    const spoilerSession = {
        accountId: 'bot_party_spoiler',
        actor: spoiler,
        partyCompanion: true,
        followPlayerSession: { accountId: 'party_leader' },
        dataSendToMe(packet) { packets.push(packet); },
        dataSendToMeAndOthers(packet) { packets.push(packet); }
    };
    const spoilVictim = {
        ...target(),
        model: {},
        fetchId: () => 3000003,
        fetchSelfId: () => 90001,
        fetchLevel: () => 10,
        fetchAttackable: () => true,
        fetchIsRaidBoss: () => false,
        enterCombatState() {},
        destructor() {}
    };
    const spoilSkill = skill({ selfId: 254, power: 0 });

    SpoilSweep.castSpoil(spoilerSession, spoiler, spoilVictim, spoilSkill);
    assert.strictEqual(HotPartyCastTracker.trackedCount(spoilVictim), 1,
        'a hot party Spoil cast should use the same event-driven target tracker');
    assert.strictEqual(timers.filter((timer) => !timer.canceled).length, 1,
        'Spoil tracking must reuse its cast landing timer instead of polling HP');

    npcDie({ dataSendToMeAndOthers() {} }, {}, spoilVictim);
    assert.strictEqual(spoiler.state.fetchCasts(), false,
        'NPC death must cancel an in-flight hot party Spoil cast');
    assert.strictEqual(HotPartyCastTracker.trackedCount(spoilVictim), 0,
        'cancelled Spoil must release its target watcher');
    assert(timers.every((timer) => timer.canceled),
        'NPC death must cancel the pending Spoil landing timer');
    assert.strictEqual(spoiler.mp, undefined,
        'a Spoil cast cancelled by NPC death must not consume MP');
} finally {
    SkillEffects.execute = savedExecuteSkill;
    DataCache.fetchNpcRewardsFromSelfId = savedFetchNpcRewardsFromSelfId;
    ActorGenerics.npcDied = savedNpcDied;
    global.setTimeout = savedSetTimeout;
    global.clearTimeout = savedClearTimeout;
}

console.log('Cast interrupt checks passed');
