const assert = require('node:assert/strict');
require('../src/Global');

const Request = invoke('GameServer/Actor/Generics/SkillRequest');
const AttackRequest = invoke('GameServer/Actor/Generics/AttackRequest');
const Attack = invoke('GameServer/Actor/Attack');
const Automation = invoke('GameServer/Automation');
const State = invoke('GameServer/Model/State');
const Store = invoke('GameServer/Effects/EffectStore');
const World = invoke('GameServer/World/World');

(async () => {
    const saved = { npc: World.fetchNpc, user: World.fetchUser, peace: utils.isInPeaceZone };
    const drain = () => new Promise(setImmediate);
    const sessions = [];
    try {
        utils.isInPeaceZone = () => false;
        for (const npc of [true, false]) {
            for (const rooted of [false, true]) {
                const casts = [], timers = [], overlaps = [];
                const target = { state: new State(), fetchId: () => npc ? 1000001 : 2000002,
                    fetchLocX: () => 40, fetchLocY: () => 0, fetchLocZ: () => 0,
                    fetchRadius: () => 8, fetchAttackable: () => npc, fetchPvpFlag: () => 1 };
                const skills = new Map([1, 2, 3].map(id => [id, {
                    fetchSelfId: () => id, fetchTargetKind: () => 'enemy',
                    fetchDistance: () => 600, fetchCalculatedHitTime: () => 1000
                }]));
                const actor = { effects: {}, state: new State(), automation: new Automation(), attack: new Attack(),
                    fetchId: () => 2000001, fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0,
                    fetchHead: () => 0, fetchDestId: () => target.fetchId(), fetchMp: () => 100, fetchRadius: () => 8,
                    isDead: () => false, isBlocked() { return this.state.isBlocked(); }, canUseSkill: () => true,
                    skillset: { fetchSkill: id => skills.get(id) },
                    backpack: { fetchEquippedWeapon: () => null, fetchTotalWeaponKind: () => 'Weapon.Knife' } };
                const session = { actor, persistenceMode: 'ephemeral', dataSendToMe() {}, dataSendToMeAndOthers() {} };
                actor.session = session;
                sessions.push(session);
                actor.attack.skillMpCost = () => 0;
                actor.attack.skillUseConditionFailure = () => null;
                actor.attack.beginRemoteCast = (_session, source, _target, skill) => {
                    if (source.state.fetchCasts()) overlaps.push(skill.fetchSelfId());
                    casts.push(skill.fetchSelfId());
                    source.state.setCasts(true);
                    return false;
                };
                actor.attack.queueTimer = (callback, ms) => timers.push({ callback, ms });
                World.fetchNpc = async () => { if (npc) return target; throw new Error('not_npc'); };
                World.fetchUser = async () => target;
                if (rooted) Store.apply(actor, { key: 'root', id: 1201, type: 'debuff', durationMs: 60000 });

                Request(session, actor, { selfId: 1 });
                Request(session, actor, { selfId: 2 });
                Request(session, actor, { selfId: 3 });
                await drain();
                assert.deepEqual(overlaps, [], 'casts must never overlap after an async lookup');
                assert.deepEqual(casts, [1], 'only one of several immediate requests may begin casting');
                assert.equal(timers.length, 1, 'only the accepted cast may schedule its landing');
                assert.equal(actor.attack.queue.data.selfId, 3, 'the latest pending skill must remain queued');

                actor.state.setCasts(false);
                actor.attack.dequeueEvent(session);
                await drain();
                assert.deepEqual(casts, [1, 3], 'the pending skill must begin after the first cast releases its slot');

                actor.state.setCasts(false);
                actor.attack.resetQueuedEvent();
                Request(session, actor, { selfId: 2 });
                actor.state.setHits(true);
                await drain();
                assert.deepEqual(casts, [1, 3], 'an attack started before target lookup completes must retain its slot');
                assert.equal(actor.attack.queue.data.selfId, 2);
                actor.state.setHits(false);
                actor.attack.dequeueEvent(session);
                await drain();
                assert.deepEqual(casts, [1, 3, 2]);

                actor.state.setCasts(false);
                const schedule = actor.automation.scheduleAction;
                let approachCallback;
                actor.automation.scheduleAction = (_session, _actor, _target, _range, callback) => { approachCallback = callback; };
                Request(session, actor, { selfId: 1 });
                await drain();
                actor.state.setCasts(true);
                approachCallback();
                assert.deepEqual(casts, [1, 3, 2], 'arrival must recheck a cast that started during the approach');
                assert.equal(actor.attack.queue.data.selfId, 1);
                actor.automation.scheduleAction = schedule;
                actor.state.setCasts(false);
                actor.attack.dequeueEvent(session);
                await drain();
                assert.deepEqual(casts, [1, 3, 2, 1]);

                actor.state.setCasts(false);
                skills.set(4, { ...skills.get(1), fetchSelfId: () => 4, fetchTargetKind: () => 'self' });
                Request(session, actor, { selfId: 2 });
                Request(session, actor, { selfId: 4 });
                await drain();
                assert.deepEqual(casts, [1, 3, 2, 1, 4], 'an immediate self cast must retain its action slot');
                assert.equal(actor.attack.queue.data.selfId, 2);
                actor.state.setCasts(false);
                actor.attack.dequeueEvent(session);
                await drain();
                assert.deepEqual(casts, [1, 3, 2, 1, 4, 2]);

                actor.state.setCasts(false);
                let attacks = 0;
                actor.attack.meleeHit = () => { attacks++; };
                Request(session, actor, { selfId: 1 });
                AttackRequest(session, actor, { id: target.fetchId(), ctrl: true });
                await drain();
                assert.equal(attacks, 0, 'an attack lookup must not start a swing over an accepted cast');
                assert.equal(actor.attack.queue.name, 'attack');
                actor.state.setCasts(false);
                actor.attack.dequeueEvent(session);
                await drain();
                assert.equal(attacks, 1, 'the pending attack must start after the cast releases its slot');
                assert.deepEqual(overlaps, []);
            }
        }
    } finally {
        sessions.forEach(session => session.actor.automation.abortAll(session.actor, { notifyClient: false }));
        World.fetchNpc = saved.npc; World.fetchUser = saved.user; utils.isInPeaceZone = saved.peace;
    }
    console.log('Async skill request serialization and queued cast checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
