const assert = require('assert');

require('../src/Global');

const EffectStore = invoke('GameServer/Effects/EffectStore');
const EffectTicker = invoke('GameServer/Effects/EffectTicker');

const target = {
    hp: 50,
    effectTimers: {},
    fetchHp() { return this.hp; },
    setHp(value) { this.hp = value; },
    statusUpdateVitals() {}
};

const effect = EffectStore.apply(target, {
    key: 'poison',
    id: 129,
    level: 1,
    type: 'debuff',
    dot: {
        damage: 3,
        count: 2,
        intervalMs: 5
    },
    durationMs: 100
});

assert.strictEqual(EffectTicker.applyDot(null, null, target, effect), true, 'Poison DoT should start a ticker');

const manaTarget = {
    mp: 25,
    effectTimers: {},
    fetchMp() { return this.mp; },
    setMp(value) { this.mp = value; },
    statusUpdateVitals() {}
};

const manaEffect = EffectStore.apply(manaTarget, {
    key: 'seal_of_gloom',
    id: 1210,
    level: 4,
    type: 'debuff',
    manaDot: {
        damage: 12,
        count: 2,
        intervalMs: 5
    },
    durationMs: 100
});

assert.strictEqual(EffectTicker.applyManaDot(null, null, manaTarget, manaEffect), true, 'Mana damage-over-time should start a ticker');

const hotTarget = {
    hp: 40,
    maxHp: 45,
    effectTimers: {},
    fetchHp() { return this.hp; },
    fetchMaxHp() { return this.maxHp; },
    setHp(value) { this.hp = value; },
    statusUpdateVitals() {}
};

const hotEffect = EffectStore.apply(hotTarget, {
    key: 'chant_of_life',
    id: 1229,
    level: 1,
    type: 'buff',
    hot: {
        heal: 4,
        count: 2,
        intervalMs: 5
    },
    durationMs: 100
});

assert.strictEqual(EffectTicker.applyHot(null, null, hotTarget, hotEffect), true, 'Heal-over-time should start a ticker');

const expiringTarget = {
    effects: {},
    activeBuffs: {},
    effectTimers: {},
    effectExpiryTimers: {},
    fetchId() { return 9001; }
};
const expiringSession = {
    actor: expiringTarget,
    packets: [],
    dataSendToMe(packet) {
        this.packets.push(packet);
    }
};
expiringTarget.session = expiringSession;
expiringTarget.activeBuffs.shield = Date.now() + 15;
const expiringEffect = EffectStore.apply(expiringTarget, {
    key: 'shield',
    id: 1040,
    level: 1,
    type: 'buff',
    durationMs: 15
});
assert.strictEqual(EffectTicker.scheduleExpiry(expiringSession, expiringTarget, expiringEffect), true, 'Timed buff should schedule an expiry refresh');

// A stat effect expiring sends what C4 sends for its target: a character its
// UserInfo once, to its own client, and its CharInfo to the others; an NPC
// debuffed by a player its NpcInfo to the players who see it and no UserInfo
// (that packet describes the receiver's own character); a character released
// (logged out, a bot cooled) nothing: its effects stopped with it.
const FailureLog = require('../src/FailureLog');
const Actor = invoke('GameServer/Actor/Actor');
const DataCache = invoke('GameServer/DataCache');
const Response = invoke('GameServer/Network/Response');
const calculateStats = invoke('GameServer/Actor/Generics/CalculateStats');
DataCache.init();
const character = (id) => {
    const session = { packets: [], observers: [],
        dataSendToMe(packet) { this.packets.push(packet); },
        dataSendToOthers(packet) { this.observers.push(packet); },
        dataSendToMeAndOthers(packet) { this.packets.push(packet); this.observers.push(packet); } };
    session.actor = new Actor(session, {
        ...utils.crushOb(DataCache.classTemplates.find(row => row.classId === 1)),
        id, name: `Expiry${id}`, username: `expiry_${id}`, classId: 1, level: 20, exp: DataCache.experience[19], sp: 0, hp: 80, mp: 30,
        sex: 0, locX: 0, locY: 0, locZ: 0, head: 0, face: 0, hair: 0, hairColor: 0, title: '', karma: 0, pk: 0, pvp: 0, isGM: 0,
        items: [], paperdoll: Array.from({ length: 16 }, () => ({}))
    });
    calculateStats(session, session.actor);
    return session;
};
const slowed = (actor, key) => EffectStore.apply(actor, { key, id: 1160, level: 1, type: 'debuff', stats: { runSpdMul: 0.7 }, durationMs: 10 });
const ofKind = (packets, kind) => packets.filter(packet => packet[0] === kind).length;
const failuresBefore = { ...FailureLog.snapshot() };
const caster = character(2000101), buffed = character(2000102), released = character(2000103);
const npc = { effects: {}, vitals: 0, fetchKind: () => 'Monster', fetchId: () => 1014813, statusUpdateVitals() { this.vitals += 1; } };
const nativeNpcInfo = Response.npcInfo;
Response.npcInfo = () => Buffer.from([0x16]);
assert(EffectTicker.scheduleExpiry(caster, npc, slowed(npc, 'npc_slow')), 'the NPC debuff schedules its expiry');
assert(EffectTicker.scheduleExpiry(buffed, buffed.actor, slowed(buffed.actor, 'own_slow')), 'the character debuff schedules its expiry');
assert(EffectTicker.scheduleExpiry(released, released.actor, slowed(released.actor, 'released_slow')), 'the released bot\'s debuff schedules its expiry');
// The bot cools before its debuff ends (Cooldown: destructor, then no actor).
released.actor.destructor();
const releasedActor = released.actor;
released.actor = null;
released.packets.length = released.observers.length = 0;

setTimeout(() => {
    Response.npcInfo = nativeNpcInfo;
    assert.deepEqual(FailureLog.snapshot()?.['combat.user_info'] ?? 0, failuresBefore['combat.user_info'] ?? 0, 'no expiry fails to send UserInfo');
    assert.strictEqual(EffectStore.list(npc).length, 0, 'the NPC debuff expired');
    assert.strictEqual(ofKind(caster.packets, 0x04), 0, 'the caster gets no UserInfo for the NPC');
    assert.strictEqual(ofKind(caster.observers, 0x16), 1, 'the players who see the NPC get its NpcInfo');
    assert(npc.vitals > 0, 'and its vitals');
    assert.strictEqual(EffectStore.list(buffed.actor).length, 0, 'the character debuff expired');
    assert.strictEqual(ofKind(buffed.packets, 0x04), 1, 'the character gets its UserInfo once');
    assert.strictEqual(ofKind(buffed.observers, 0x03), 1, 'the others its CharInfo once');
    assert.deepEqual(Object.keys(releasedActor.effectExpiryTimers || {}), [], 'a released character keeps no effect timer');
    assert.strictEqual(released.packets.length + released.observers.length, 0, 'and sends nothing when its debuff would end');
    assert.strictEqual(target.fetchHp(), 44, 'Poison DoT should apply datapack damage on each tick');
    assert.strictEqual(target.effectTimers.poison, undefined, 'DoT ticker should clear itself after its count');
    assert.strictEqual(manaTarget.fetchMp(), 1, 'Mana damage-over-time should reduce MP on each tick and clamp above zero');
    assert.strictEqual(manaTarget.effectTimers.seal_of_gloom, undefined, 'Mana damage-over-time ticker should clear itself after its count');
    assert.strictEqual(hotTarget.fetchHp(), 45, 'Heal-over-time should heal each tick and clamp at max HP');
    assert.strictEqual(hotTarget.effectTimers.chant_of_life, undefined, 'Heal-over-time ticker should clear itself after its count');
    assert.strictEqual(EffectStore.list(expiringTarget).length, 0, 'Expired buff should be pruned from EffectStore');
    assert.strictEqual(expiringTarget.activeBuffs.shield, undefined, 'Expired buff should be removed from legacy activeBuffs');
    const expiryPacket = expiringSession.packets.find((packet) => packet[0] === 0x7f);
    assert(expiryPacket, 'Expired buff should send an abnormal status refresh');
    assert.strictEqual(expiryPacket.readInt16LE(1), 0, 'Expired buff refresh should remove the icon from the client');
    console.log('Effect ticker checks passed');
}, 70);
