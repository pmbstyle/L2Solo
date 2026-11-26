const assert = require('assert');
require('../src/Global');

// C4 posture (Lisvus L2PcInstance.sitDown/standUp, SitDownTask/StandUpTask):
// the character cannot act for 2.5 s after it sits or stands; the action
// asked meanwhile runs when the stand-up ends; a stand pressed during a
// sit-down starts at once; a casting character cannot sit. A skill pressed
// during the stand-up is kept and cast at its end: our choice (Lisvus refuses).

const State = invoke('GameServer/Model/State');
const Attack = invoke('GameServer/Actor/Attack');
const Generics = invoke('GameServer/Actor/Generics');
const World = invoke('GameServer/World/World');
const saved = [];
const timers = new Map();
let now = 0;
function patch(object, key, value) {
    const old = object[key];
    saved.push(() => { object[key] = old; });
    object[key] = value;
}
function advance(ms) {
    const end = now + ms;
    for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= end)
            .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, timer] = next;
        now = timer.at;
        timers.delete(id);
        timer.fn();
    }
    now = end;
}

const skill = {
    fetchSelfId: () => 1177,
    fetchName: () => 'Wind Strike',
    fetchTargetKind: () => 'enemy',
    fetchSemantic: () => ({}),
    fetchPassive: () => false
};
function player(id) {
    const actor = {
        state: new State(), attack: new Attack(), effects: {},
        fetchId: () => id, fetchName: () => `player_${id}`,
        fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0,
        fetchDestId: () => 900001,
        fetchHp: () => 50, fetchMaxHp: () => 100, fetchMp: () => 50, fetchMaxMp: () => 100,
        isDead: () => false,
        canUseSkill: () => true,
        unselect() {},
        skillset: { fetchSkill: selfId => (selfId === skill.fetchSelfId() ? skill : null), fetchSkills: () => [skill] },
        backpack: { fetchEquippedWeapon: () => null },
        automation: { fetchDestId: () => undefined, abortAll() {}, replenishVitals() {} },
        isBlocked() { return this.state.isBlocked(); }
    };
    actor.session = {
        actor, accountId: `posture_${id}`, packets: [],
        dataSendToMe(packet) { this.packets.push(packet); },
        dataSendToOthers(packet) { this.packets.push(packet); },
        dataSendToMeAndOthers(packet) { this.packets.push(packet); }
    };
    return actor;
}
function waitTypes(actor) {
    return actor.session.packets.filter(packet => packet[0] === 0x2f).map(packet => packet.readInt32LE(5));
}
const sitOrStand = actor => Generics.basicAction(actor.session, actor, { actionId: 0 });

try {
    patch(global, 'setTimeout', (fn, ms) => {
        const id = { unref() {} };
        timers.set(id, { fn, at: now + ms });
        return id;
    });
    patch(global, 'clearTimeout', id => timers.delete(id));
    patch(Date, 'now', () => now);
    const started = [];
    patch(Generics, 'skillExec', (session, actor, data) => started.push({ at: now, actor: actor.fetchId(), kind: 'skill', id: data.selfId }));
    patch(Generics, 'attackExec', (session, actor, data) => started.push({ at: now, actor: actor.fetchId(), kind: 'attack', id: data.id }));
    patch(Generics, 'stopAutomation', () => {});

    // A skill pressed during the stand-up runs at its end.
    const caster = player(2100001);
    caster.state.setSeated(true);
    sitOrStand(caster);
    assert.deepStrictEqual(waitTypes(caster), [1], 'the stand is broadcast at once');
    advance(500);
    Generics.skillRequest(caster.session, caster, { selfId: skill.fetchSelfId(), ctrl: false, shift: false });
    advance(1999);
    assert.deepStrictEqual(started, [], 'no skill starts while the 2.5 s stand-up plays');
    advance(1);
    assert.deepStrictEqual(started, [{ at: 2500, actor: caster.fetchId(), kind: 'skill', id: skill.fetchSelfId() }],
        'the skill pressed during the stand-up starts once when it ends');
    advance(5000);
    assert.strictEqual(started.length, 1);

    // An attack pressed during the stand-up runs at its end.
    started.length = 0;
    now = 10000;
    const fighter = player(2100002);
    fighter.state.setSeated(true);
    sitOrStand(fighter);
    advance(500);
    Generics.attackRequest(fighter.session, fighter, { id: 900001 });
    advance(1999);
    assert.deepStrictEqual(started, [], 'no swing starts while the 2.5 s stand-up plays');
    advance(1);
    assert.deepStrictEqual(started, [{ at: 12500, actor: fighter.fetchId(), kind: 'attack', id: 900001 }],
        'the attack pressed during the stand-up starts once when it ends');

    // A stand pressed during the sit-down starts at once; the lock ends 2.5 s
    // after the stand, not after the sit.
    started.length = 0;
    now = 20000;
    const sitter = player(2100003);
    sitOrStand(sitter);
    assert.deepStrictEqual(waitTypes(sitter), [0], 'the sit is broadcast');
    advance(1000);
    sitOrStand(sitter);
    assert.deepStrictEqual(waitTypes(sitter), [0, 1], 'a stand during the sit-down is broadcast at once');
    assert.strictEqual(sitter.state.fetchSeated(), false);
    advance(500);
    Generics.skillRequest(sitter.session, sitter, { selfId: skill.fetchSelfId(), ctrl: false, shift: false });
    advance(1000);
    assert.deepStrictEqual(started, [], 'the sit-down timer does not end the stand-up lock');
    advance(999);
    assert.deepStrictEqual(started, [], 'no skill starts before the stand-up ends');
    advance(1);
    assert.deepStrictEqual(started, [{ at: 23500, actor: sitter.fetchId(), kind: 'skill', id: skill.fetchSelfId() }],
        'the skill starts 2.5 s after the stand');

    // A casting character cannot sit (Lisvus sitDown checks the cast): a bot
    // ordered to rest mid-cast stays standing and broadcasts nothing.
    patch(World, 'npc', { spawns: [] });
    const castingBot = player(2100004);
    castingBot.session.accountId = 'bot_posture_casting';
    castingBot.session.plan = 'hunting';
    castingBot.state.setCasts(true);
    invoke('GameServer/Bot/AI/BotAgentTools').execute(castingBot.session, {
        action: 'rest', confidence: 0.95, reply: '', targetPlayerName: '', spotId: '', buffType: '',
        reason: 'test', turnId: 'posture-rest'
    }, [], { conversationTurn: { turnId: 'posture-rest' } });
    assert.strictEqual(castingBot.state.fetchSeated(), false, 'a casting bot ordered to rest stays standing');
    assert.deepStrictEqual(waitTypes(castingBot), [], 'a refused sit broadcasts no ChangeWaitType');

    // Relax pressed during the stand-up is refused, as in C4: no MP spent, no
    // toggle, the body stays standing; pressed once the lock ends it sits.
    const relaxSkill = {
        fetchSelfId: () => 226, fetchSelfLevel: () => 1, fetchLevel: () => 1, fetchName: () => 'Relax',
        fetchSemantic: () => ({ operateType: 'toggle', effect: 'relax', mpInitialConsume: 2, stats: { relaxing: true } })
    };
    const relaxer = player(2100005);
    relaxer.state.setSeated(true);
    relaxer.fetchMp = () => relaxer.mp;
    relaxer.setMp = value => { relaxer.mp = value; };
    relaxer.mp = 50;
    Generics.basicAction(relaxer.session, relaxer, { actionId: 0 });
    invoke('GameServer/Skills/ToggleSkills').handleRequest(relaxer.session, relaxer, relaxSkill);
    assert.strictEqual(relaxer.mp, 50, 'Relax during the stand-up spends no MP');
    assert.strictEqual(relaxer.state.fetchSeated(), false, 'Relax during the stand-up does not sit the body');
    assert.deepStrictEqual(Object.keys(relaxer.effects), [], 'Relax during the stand-up adds no toggle');
} finally {
    saved.reverse().forEach(restore => restore());
}

console.log('Posture lock checks passed');
