const assert = require('node:assert/strict');
require('../src/Global');

const Attack = invoke('GameServer/Actor/Attack');
const State = invoke('GameServer/Model/State');
const Skill = invoke('GameServer/Model/Skill');
const SkillRequest = invoke('GameServer/Actor/Generics/SkillRequest');
const Generics = invoke('GameServer/Actor/Generics');
const World = invoke('GameServer/World/World');
const Formulas = invoke('GameServer/Formulas');
const SkillEffects = invoke('GameServer/Skills/C4SkillEffects');
const Restrictions = invoke('GameServer/Effects/EffectRestrictions');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const Companion = invoke('GameServer/Bot/AI/PartyCompanionService');
const activeSkills = require('../data/Skills/Active/active.json');

const saved = [];
const timers = new Map();
let now = 10000;
let current;
function patch(object, key, value) {
    const old = object[key];
    saved.push(() => { object[key] = old; });
    object[key] = value;
}
function advance(ms) {
    const end = now + ms;
    while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= end)
            .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, timer] = next;
        now = timer.at;
        timers.delete(id);
        timer.callback();
    }
    now = end;
}
function skill(id) {
    const definition = activeSkills.find(row => row.selfId === id);
    assert(definition, `missing active skill ${id}`);
    return new Skill({ selfId: id, ...definition.template, ...definition.time, ...definition.levels[0] });
}
function fixture(id = 3) {
    const packets = [], hits = [], approaches = [];
    const target = {
        x: 40, hp: 1000, model: {}, state: new State(),
        fetchId: () => 1000001, fetchSelfId: () => 93, fetchKind: () => 'Monster',
        fetchName: () => 'Target', fetchLevel: () => 10,
        fetchLocX() { return this.x; }, fetchLocY: () => 0, fetchLocZ: () => 0,
        fetchRadius: () => 8, fetchAttackable: () => true, enterCombatState() {},
        isDead() { return this.state.fetchDead(); }, fetchHp() { return this.hp; }
    };
    const castSkill = skill(id);
    const actor = {
        hp: 1000, mp: 1000, destId: target.fetchId(), effects: {}, state: new State(), attack: new Attack(),
        fetchId: () => 2000001, fetchName: () => 'Fighter', fetchLevel: () => 20,
        fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0,
        fetchHead: () => 0, fetchRadius: () => 8,
        fetchCollectiveAtkSpd: () => 333, fetchCollectiveCastSpd: () => 333,
        fetchDestId() { return this.destId; }, isDead() { return this.state.fetchDead(); },
        isBlocked() { return this.state.isBlocked(); }, canUseSkill: () => true,
        fetchHp() { return this.hp; }, fetchMp() { return this.mp; },
        setHp(hp) { this.hp = hp; }, setMp(mp) { this.mp = mp; }, statusUpdateVitals() {},
        skillset: { fetchSkill: () => castSkill },
        backpack: { fetchTotalWeaponKind: () => 'Weapon.Sword' },
        automation: {
            replenishVitals() {}, fetchDestId: () => target.fetchId(),
            abortAll() { actor.state.setTowards(false); },
            scheduleAction(session, source, victim, range, callback, options) {
                if (victim.fetchLocX() > range + 16) {
                    if (Restrictions.canMove(source)) approaches.push({ victim, range, callback, options });
                } else callback();
            }
        }
    };
    const session = { actor, persistenceMode: 'ephemeral',
        dataSendToMe(packet) { packets.push(packet); },
        dataSendToMeAndOthers(packet) { packets.push(packet); } };
    actor.session = session;
    // Exercise native request, cast, finalization and repeating weapon timers;
    // isolate the unrelated damage math and gear requirements.
    actor.attack.skillUseConditionFailure = () => null;
    actor.attack.prepareMeleeHit = () => ({ damage: 7, flags: 0 });
    actor.attack.hit = (_session, _actor, victim, damage, options) => {
        hits.push({ victim, damage, skill: !!options?.skill });
        victim.hp -= damage;
        if (victim.hp <= 0) victim.state.setDead(true);
    };
    actor.attack.recordPlayerAggression = () => {};
    actor.attack.applyDamageAbsorb = () => {};
    return { actor, target, session, castSkill, packets, hits, approaches,
        outcome: { damage: 10 }, swings: () => packets.filter(packet => packet[0] === 0x05),
        land() { advance(castSkill.fetchCalculatedHitTime()); },
        finish() { advance(castSkill.fetchCalculatedHitTime()
            + (castSkill.fetchSemantic().nextActionAttack ? castSkill.fetchSemantic().coolTime || 0 : 0)); } };
}
async function scenario(id, run) {
    current = fixture(id);
    try { await run(current); } finally {
        current.actor.attack.destructor();
        timers.clear();
    }
}
const drain = () => new Promise(setImmediate);
async function request(f, options = {}) {
    SkillRequest(f.session, f.actor, { selfId: f.castSkill.fetchSelfId(), ...options });
    await drain();
    assert(f.actor.state.fetchCasts(), 'the opening skill must start casting');
    assert.equal(f.swings().length, 0, 'no weapon swing before the cast completes');
}

(async () => {
    try {
        patch(global, 'setTimeout', (callback, ms) => {
            const id = { unref() {} };
            timers.set(id, { callback, at: now + ms });
            return id;
        });
        patch(global, 'clearTimeout', id => timers.delete(id));
        patch(Date, 'now', () => now);
        patch(World, 'fetchNpc', async () => {
            if (!current.target.fetchKind) throw new Error('not_npc');
            return current.target;
        });
        patch(World, 'fetchUser', async () => current.target);
        patch(utils, 'isInPeaceZone', () => false);
        patch(Formulas, 'calcHitChance', () => true);
        patch(SkillEffects, 'execute', () => current.outcome);
        patch(invoke('GameServer/Automation'), 'needsGeodataApproach', () => false);
        patch(Companion, 'startQueuedGroundPickup', () => false);

        await scenario(3, async f => {
            await request(f);
            f.land();
            assert.equal(f.hits.filter(hit => hit.skill).length, 1, 'skill damage lands before recovery');
            assert.equal(f.swings().length, 0, 'Power Strike must wait its sourced 720 ms recovery');
            assert(f.actor.state.fetchCasts(), 'the cast action slot stays occupied during recovery');
            advance(719);
            assert.equal(f.swings().length, 0, 'auto-attack cannot start before recovery ends');
            advance(1);
            assert.equal(f.swings().length, 1, 'auto-attack starts at the recovery deadline');
        });
        await scenario(3, async f => {
            f.actor.fetchCollectiveAtkSpd = () => 1332;
            await request(f);
            f.land();
            f.actor.fetchCollectiveAtkSpd = () => 333;
            advance(179);
            assert.equal(f.swings().length, 0, 'recovery uses attack speed at acceptance');
            advance(1);
            assert.equal(f.swings().length, 1, '720 ms recovery scales to 180 ms without a 500 ms minimum');
        });
        for (const action of ['move', 'skill', 'attack']) {
            await scenario(3, async f => {
                await request(f);
                f.land();
                let executed;
                const key = { move: 'moveTo', skill: 'skillRequest', attack: 'attackRequest' }[action];
                const original = Generics[key];
                Generics[key] = (_session, _actor, data) => { executed = data; };
                try {
                    const data = { id: 1000002, selfId: 1230 };
                    Generics.queueRequest(f.session, f.actor, action, data);
                    advance(720);
                    assert.equal(executed, data, `${action} requested during recovery must take priority`);
                    assert.equal(f.swings().length, 0, 'recovery must not launch a swing ahead of a queued command');
                } finally { Generics[key] = original; }
            });
        }
        for (const change of ['target', 'death', 'abort']) {
            await scenario(3, async f => {
                await request(f);
                f.land();
                if (change === 'target') f.actor.destId = 1000002;
                if (change === 'death') f.target.state.setDead(true);
                if (change === 'abort') f.actor.attack.abortCast(f.session, f.actor);
                advance(720);
                assert.equal(f.swings().length, 0, `${change} during recovery must cancel automatic attack`);
            });
        }

        for (const id of [3, 16, 92, 263, 279]) {
            await scenario(id, async f => {
                await request(f);
                f.finish();
                assert.equal(f.swings().length, 1, `${f.castSkill.fetchName()} must start auto-attack`);
                assert(!f.actor.state.fetchCasts(), 'cast state must release before the weapon swing');
                advance(Formulas.calcMeleeAtkTime(333));
                assert.equal(f.hits.filter(hit => !hit.skill).length, 1, 'the automatic swing must deal weapon damage');
                assert.equal(f.swings().length, 2, 'auto-attack must continue without another click');
            });
        }

        for (const id of [56, 101, 1230]) {
            await scenario(id, async f => {
                await request(f);
                f.finish();
                assert.equal(f.swings().length, 0, `${f.castSkill.fetchName()} has no sourced automatic attack`);
            });
        }
        for (const flag of [0, 1]) {
            await scenario(3, async f => {
                delete f.target.fetchKind;
                delete f.target.fetchAttackable;
                f.target.fetchPvpFlag = () => flag;
                await request(f, { ctrl: flag === 0 });
                f.finish();
                assert.equal(f.swings().length, 1, 'an authorized PvP opener must continue on the same player');
            });
        }
        await scenario(3, async f => {
            f.session.accountId = 'bot_auto_attack';
            f.session.botSession = true;
            await request(f);
            f.finish();
            assert.equal(f.swings().length, 1, 'bot players use the same native post-cast weapon loop');
        });
        for (const outcome of [{ damage: 0, missed: true }, { damage: 0, resisted: true }]) {
            await scenario(3, async f => {
                f.outcome = outcome;
                await request(f);
                f.finish();
                assert.equal(f.swings().length, 1, 'a completed miss/resist must still start the sourced next action');
            });
        }
        for (const change of ['target', 'unselect', 'kill', 'abort', 'disabled', 'seated', 'npc']) {
            await scenario(3, async f => {
                await request(f);
                if (change === 'target') f.actor.destId = 1000002;
                if (change === 'unselect') f.actor.destId = undefined;
                if (change === 'kill') f.target.hp = 1;
                if (change === 'abort') f.actor.attack.abortCast(f.session, f.actor);
                if (change === 'disabled') EffectStore.apply(f.actor,
                    { key: 'physical_mute', id: 353, type: 'debuff', stats: { physicalMute: true }, durationMs: 60000 });
                if (change === 'seated') f.actor.state.setSeated(true);
                if (change === 'npc') f.actor.fetchKind = () => 'Monster';
                f.finish();
                assert.equal(f.swings().length, 0, `${change} must suppress automatic attack`);
            });
        }
        await scenario(3, async f => {
            EffectStore.apply(f.actor, { key: 'root', id: 1201, type: 'debuff', durationMs: 60000 });
            await request(f);
            f.finish();
            assert.equal(f.swings().length, 1, 'root must still allow an automatic melee hit in range');
        });
        await scenario(3, async f => {
            await request(f);
            f.target.x = 1000;
            f.finish();
            assert.equal(f.swings().length, 0, 'an escaped target must not receive a remote melee swing');
            assert.equal(f.approaches.length, 1, 'auto-attack must approach the escaped target');
            assert.equal(f.approaches[0].range, 40, 'chase uses the equipped weapon range');
            f.target.x = 40;
            f.approaches[0].callback();
            assert.equal(f.swings().length, 1, 'the weapon loop starts after approaching');
        });

        for (const action of ['move', 'skill', 'attack']) {
            await scenario(3, async f => {
                let executed;
                const key = { move: 'moveTo', skill: 'skillRequest', attack: 'attackRequest' }[action];
                const original = Generics[key];
                Generics[key] = (_session, _actor, data) => { executed = data; };
                try {
                    await request(f);
                    const data = { id: 1000002, selfId: 1230 };
                    f.actor.attack.queueEvent(action, data);
                    f.finish();
                    assert.equal(executed, data, `queued ${action} must run after the cast`);
                    assert.equal(f.swings().length, 0, `queued ${action} must take priority over auto-attack`);
                } finally { Generics[key] = original; }
            });
        }

        // Spoil takes the separate utility cast path and must preserve a loaded
        // soulshot for the following weapon swing, even when the spoil fails.
        const DataCache = invoke('GameServer/DataCache');
        patch(DataCache, 'fetchNpcRewardsFromSelfId', (_id, callback) => callback({
            spoils: [{ items: [{ item: { selfId: 1867 } }] }]
        }));
        patch(Formulas, 'calcSpoilSuccess', () => false);
        patch(World, 'fetchNpcsInRadius', () => [current.target]);
        patch(invoke('GameServer/Quest/QuestService'), 'onSkillSee', async () => {});
        for (const id of [254, 302]) {
            await scenario(id, async f => {
                f.actor.soulshotLoaded = true;
                f.actor.attack.prepareMeleeHit = (_actor, _target, _landed, shot) => {
                    assert(shot, 'the weapon swing after Spoil must keep the loaded soulshot');
                    return { damage: 7, flags: 0 };
                };
                await request(f);
                f.finish();
                assert.equal(f.swings().length, 1, 'completed Spoil must start auto-attack even on a failed roll');
                assert(f.actor.state.fetchCombats(), 'Spoil must enter the caster combat stance');
            });
        }
        console.log('Skill auto-attack: openers, repeats, source exceptions, queue priority, target changes, restrictions, chase and Spoil passed');
    } finally { saved.reverse().forEach(restore => restore()); }
})().catch(error => { console.error(error); process.exitCode = 1; });
