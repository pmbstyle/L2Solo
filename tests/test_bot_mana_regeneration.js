const assert = require('assert');

require('../src/Global');

const RestingState = invoke('GameServer/Bot/AI/States/RestingState');

let seated = true;
let casts = 0;
const manaRegeneration = {
    fetchPassive: () => false,
    fetchSemantic: () => ({ effect: 'mana_regeneration' }),
    fetchTargetKind: () => 'self',
    fetchConsumedMp: () => 12,
    fetchSelfId: () => 1047
};
const bot = {
    effects: {},
    fetchId: () => 17,
    fetchHp: () => 800,
    fetchMaxHp: () => 1000,
    fetchMp: () => 20,
    fetchMaxMp: () => 200,
    fetchLocX: () => 0,
    fetchLocY: () => 0,
    fetchLocZ: () => 0,
    state: {
        fetchSeated: () => seated,
        setSeated: (value) => { seated = value; },
        fetchAnimated: () => false,
        setAnimated: () => {},
        fetchCasts: () => false
    },
    skillset: { fetchSkills: () => [manaRegeneration] }
};
const session = {
    dataSendToOthers: () => {},
    dataSendToMeAndOthers: () => {},
    roleDecision: null
};
const Generics = {
    skillExec: (_session, actor, data) => {
        casts += 1;
        assert.strictEqual(actor, bot);
        assert.deepStrictEqual(data, { id: 17, selfId: 1047, ctrl: false });
    }
};

assert.strictEqual(RestingState.maybeCastManaRegeneration(session, bot, Generics), true, 'a resting bot with Mana Regeneration should cast it for low MP');
assert.strictEqual(casts, 1);
assert.strictEqual(seated, false, 'the bot must stand before the native self-cast');
assert.strictEqual(session.roleDecision.action, 'cast_mana_regeneration');
assert.strictEqual(RestingState.maybeCastManaRegeneration(session, bot, Generics), false, 'the cast retry guard must prevent spam while the skill is pending');

let seatedDuringCast = false;
const castingBot = {
    ...bot,
    state: {
        fetchSeated: () => seatedDuringCast,
        setSeated: (value) => { seatedDuringCast = value; },
        fetchAnimated: () => false,
        setAnimated: () => {},
        fetchCasts: () => true
    }
};
RestingState.tick(
    { dataSendToOthers: () => {}, dataSendToMeAndOthers: () => {} },
    castingBot,
    { skillExec: () => assert.fail('a live cast must not start another Mana Regeneration action') },
    { say: () => assert.fail('a casting bot must not leave recovery') }
);
assert.strictEqual(seatedDuringCast, false, 'a bot must remain standing while Mana Regeneration is casting');

// C4 stand-up (Lisvus L2PcInstance.standUp/StandUpTask): a seated mage casting
// Mana Regeneration stands, is not sat back down by the next rest ticks while
// the 2.5 s stand-up plays, and the cast starts once when the stand-up ends.
{
    const State = invoke('GameServer/Model/State');
    const Attack = invoke('GameServer/Actor/Attack');
    const Generics = invoke('GameServer/Actor/Generics');
    const World = invoke('GameServer/World/World');
    const saved = [];
    const timers = new Map();
    const start = Date.now();
    let now = start;
    const patch = (object, key, value) => {
        const old = object[key];
        saved.push(() => { object[key] = old; });
        object[key] = value;
    };
    const advance = (ms) => {
        const end = now + ms;
        while (true) {
            const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) break;
            now = next[1].at;
            timers.delete(next[0]);
            next[1].fn();
        }
        now = end;
    };
    try {
        patch(global, 'setTimeout', (fn, ms) => {
            const id = { unref() {} };
            timers.set(id, { fn, at: now + ms });
            return id;
        });
        patch(global, 'clearTimeout', id => timers.delete(id));
        patch(Date, 'now', () => now);
        patch(Generics, 'stopAutomation', () => {});
        patch(World, 'user', { sessions: [] });
        patch(World, 'npc', { spawns: [] });
        patch(World, 'fetchNpcsInRadius', () => []);

        const mage = {
            ...bot,
            fetchId: () => 18,
            state: new State(),
            attack: new Attack(),
            automation: { abortAll() {}, replenishVitals() {} },
            canUseSkill: () => true,
            isDead: () => false,
            skillset: { fetchSkills: () => [manaRegeneration], fetchSkill: id => (id === 1047 ? manaRegeneration : null) }
        };
        mage.isBlocked = () => mage.state.isBlocked();
        mage.state.setSeated(true);
        const remoteHits = [];
        mage.attack.remoteHit = (_session, target, skill) => remoteHits.push({ at: now - start, target, id: skill.fetchSelfId() });
        const mageSession = {
            accountId: 'bot_mana_regeneration_stand_up',
            actor: mage,
            plan: 'resting',
            packets: [],
            dataSendToOthers(packet) { this.packets.push(packet); },
            dataSendToMeAndOthers(packet) { this.packets.push(packet); }
        };
        mage.session = mageSession;
        const tick = () => RestingState.tick(mageSession, mage, Generics, { say() {} });

        tick();
        advance(1000);
        tick();
        advance(1000);
        tick();
        const waitTypes = mageSession.packets.filter(packet => packet[0] === 0x2f);
        assert.strictEqual(waitTypes.length, 1, 'the mage broadcasts one stand-up and is not sat back down');
        assert.strictEqual(waitTypes[0].readInt32LE(5), 1, 'the broadcast posture is standing');
        assert.strictEqual(mage.state.fetchSeated(), false, 'the mage stays standing during the stand-up');
        assert.deepStrictEqual(remoteHits, [], 'Mana Regeneration does not start during the 2.5 s stand-up');
        advance(499);
        assert.deepStrictEqual(remoteHits, [], 'Mana Regeneration does not start before the stand-up ends');
        advance(1);
        assert.deepStrictEqual(remoteHits, [{ at: 2500, target: mage, id: 1047 }], 'Mana Regeneration starts once when the stand-up ends');
    } finally {
        saved.reverse().forEach(restore => restore());
    }
}

console.log('Bot Mana Regeneration checks passed');
