const assert = require('assert');

require('../src/Global');

const Attack = invoke('GameServer/Actor/Attack');
const State = invoke('GameServer/Model/State');
const destCancel = invoke('GameServer/Network/Request/DestCancel');
const skillRequest = invoke('GameServer/Actor/Generics/SkillRequest');

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
        fetchSelfId: () => 1011,
        fetchLevel: () => 1,
        fetchPower: () => overrides.power ?? 10,
        fetchTargetKind: () => 'enemy',
        fetchSemantic: () => ({ skillType: 'damage', trait: 'wind' }),
        fetchSsBoost: () => 1
    };
}

const savedSetTimeout = global.setTimeout;
const savedClearTimeout = global.clearTimeout;
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
    assert.strictEqual(timers.length, 1, 'remote skill should only schedule the cast landing timer');
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
    landingAttack.remoteHit(landingSession, victim, skill({ power: 0 }));
    timers.find((timer) => !timer.canceled && timer.delay > 0).callback();
    assert(packets.some((packet) => packet[0] === 0x76 && packet.readInt32LE(5) === 1011), 'completed magic cast should broadcast MagicSkillLaunched on landing');

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
} finally {
    global.setTimeout = savedSetTimeout;
    global.clearTimeout = savedClearTimeout;
}

console.log('Cast interrupt checks passed');
