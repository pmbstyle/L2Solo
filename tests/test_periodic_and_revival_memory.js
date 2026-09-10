const assert = require('assert');
require('../src/Global');
const Ticker = invoke('GameServer/Effects/EffectTicker'), Store = invoke('GameServer/Effects/EffectStore');
const Status = invoke('GameServer/Actor/CharacterStatus'), Memory = invoke('GameServer/Social/InteractionMemoryRuntime');
const Policy = require('../src/GameServer/Social/InteractionMemoryPolicy');
const saved = [], events = [], callbacks = new Map(); let timer = 0;
function patch(o, key, value) { const old = o[key]; saved.push(() => o[key] = old); o[key] = value; }
function actor(id) {
    const a = { hp: 20, effects: {}, fetchId: () => id, fetchClanId: () => 0, fetchHp() { return this.hp; },
        setHp(n) { this.hp = n; }, fetchMaxHp: () => 100, fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0,
        statusUpdateVitals() {}, automation: { replenishVitals() {} },
        state: { dead: false, combat: true, fetchDead() { return this.dead; }, setDead(n) { this.dead = n; }, fetchCombats() { return this.combat; } } };
    a.session = { actor: a, accountId: `bot_periodic_${id}`, dataSendToMeAndOthers() {} };
    return a;
}
try {
    patch(global, 'setInterval', fn => { callbacks.set(++timer, fn); return timer; });
    patch(global, 'clearInterval', id => callbacks.delete(id));
    patch(Memory.events, 'enqueue', e => { events.push(e); return true; });
    patch(invoke('GameServer/Bot/AI/BotEventJournal'), 'record', async () => {});
    const helper = actor(2), target = actor(1);
    const effect = Store.apply(target, { id: 1229, key: 'life', type: 'buff', durationMs: 60000,
        hot: { heal: 2, intervalMs: 1000, count: 8 } });
    Ticker.applyHot(helper.session, helper, target, effect);
    callbacks.get(target.effectTimers.life)(); callbacks.get(target.effectTimers.life)();
    assert.strictEqual(target.hp, 24); assert.strictEqual(events.length, 0, 'small ticks accumulate only actual useful healing');
    const serialized = Status.serializeEffects(target); Ticker.clearAll(target);
    const reloaded = actor(1); reloaded.hp = 24;
    Status.restoreEffects(reloaded.session, reloaded, serialized);
    callbacks.get(reloaded.effectTimers.life)();
    assert.strictEqual(events.length, 1); assert.strictEqual(events[0].sourceId, 1); assert.strictEqual(events[0].targetId, 2);
    assert.strictEqual(events[0].type, 'healed', 'restored effect remembers its real caster, not the recipient');
    const applied = Policy.apply(Policy.empty(1), events[0], Date.now());
    Memory.accept(applied.snapshot);
    for (let i = 0; i < 5; i++) callbacks.get(reloaded.effectTimers.life)?.();
    assert.strictEqual(events.length, 1, 'one spell and subsequent ticks cannot farm gratitude');
    assert.strictEqual(reloaded.effects.life.hot.remaining, 0);
    assert(!reloaded.effectTimers.life, 'restoration does not reset the remaining tick count');
    const exhausted = Status.serializeEffects(reloaded); Ticker.clearAll(reloaded);
    const third = actor(1); Status.restoreEffects(third.session, third, exhausted);
    assert(!third.effectTimers?.life); Ticker.clearAll(third);
    const resting = actor(3); resting.state.combat = false;
    const restEffect = Store.apply(resting, { id: 1229, key: 'rest', durationMs: 60000, hot: { heal: 10, count: 1 } });
    Ticker.applyHot(helper.session, helper, resting, restEffect); callbacks.get(resting.effectTimers.rest)();
    assert.strictEqual(events.length, 1, 'ordinary recovery creates no combat help');
    const corpse = actor(4); corpse.hp = 0; corpse.state.dead = true;
    let complete;
    const originalTimeout = global.setTimeout;
    patch(global, 'setTimeout', (fn, delay, ...args) => delay === 2500 ? (complete = fn, 0) : originalTimeout(fn, delay, ...args));
    const skill = { fetchSemantic: () => ({ skillType: invoke('GameServer/Skills/C4SkillRules').RESURRECT }),
        fetchSpell: () => true, fetchPower: () => 0 };
    invoke('GameServer/Skills/C4SkillEffects').execute(helper.session, helper, corpse, skill);
    assert(complete); assert.strictEqual(events.length, 1, 'cast acceptance is not completed resurrection');
    complete();
    assert.strictEqual(corpse.hp, 1); assert(!corpse.state.dead);
    assert.strictEqual(events.length, 2); assert.strictEqual(events[1].type, 'resurrected');
    complete(); assert.strictEqual(events.length, 2, 'duplicate completion earns no second gratitude');
    console.log('Support memory: real HoT ticks, cumulative usefulness, restored caster and remaining ticks, native resurrection completion passed');
} finally { saved.reverse().forEach(f => f()); }
