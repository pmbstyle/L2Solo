'use strict';

const assert = require('node:assert/strict');
require('../src/Global');

const Request = invoke('GameServer/Actor/Generics/SkillRequest');
const AttackRequest = invoke('GameServer/Actor/Generics/AttackRequest');
const Attack = invoke('GameServer/Actor/Attack');
const Automation = invoke('GameServer/Automation');
const State = invoke('GameServer/Model/State');
const Store = invoke('GameServer/Effects/EffectStore');
const World = invoke('GameServer/World/World');
const Skill = invoke('GameServer/Model/Skill');
const activeSkills = require('../data/Skills/Active/active.json');

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
        const definition = activeSkills.find(row => row.selfId === 1016);
        for (const [kind, distance, rooted] of [
            ['living self', 0, false], ['living bot', 40, false],
            ['living bot', 1000, false], ['living bot', 1000, true],
            ['dead bot', 40, false], ['revived during approach', 1000, false]
        ]) {
            let mp = 100, reuse = false, casterX = 0, arrive;
            const packets = [], timers = [];
            const resurrection = new Skill({ selfId: 1016, ...definition.template, ...definition.time, ...definition.levels[0] });
            const actor = { effects: {}, state: new State(), automation: new Automation(), attack: new Attack(),
                fetchId: () => 2000001, fetchName: () => 'Oracle', fetchLevel: () => 20,
                fetchLocX: () => casterX, fetchLocY: () => 0, fetchLocZ: () => 0, fetchHead: () => 0,
                setLocXYZ(coords) { casterX = coords.locX; }, fetchCollectiveRunSpd: () => 148,
                fetchRadius: () => 8, fetchMp: () => mp, fetchHp: () => 100, fetchMaxHp: () => 100,
                fetchCollectiveCastSpd: () => 333, setMp(value) { mp = value; }, statusUpdateVitals() {},
                isDead() { return this.state.fetchDead(); }, isBlocked() { return this.state.isBlocked(); },
                canUseSkill: () => !reuse, markSkillReuse() { reuse = true; },
                skillset: { fetchSkill: () => resurrection },
                backpack: { fetchEquippedWeapon: () => null, fetchTotalWeaponKind: () => 'Weapon.Staff' } };
            const target = kind === 'living self' ? actor : { state: new State(),
                fetchId: () => 2000002, fetchLocX: () => distance, fetchLocY: () => 0, fetchLocZ: () => 0,
                fetchRadius: () => 8, isDead() { return this.state.fetchDead(); } };
            target.state.setDead(kind === 'dead bot' || kind === 'revived during approach');
            actor.fetchDestId = () => target.fetchId();
            const session = { actor, persistenceMode: 'ephemeral',
                dataSendToMe(packet) { packets.push(packet); },
                dataSendToMeAndOthers(packet) { packets.push(packet); } };
            actor.session = session;
            sessions.push(session);
            actor.attack.queueTimer = callback => timers.push(callback);
            if (rooted) Store.apply(actor, { key: 'root', id: 1201, type: 'debuff', durationMs: 60000 });
            if (kind === 'revived during approach') {
                actor.automation.scheduleAction = (_session, _actor, _target, _range, callback) => { arrive = callback; };
            }
            World.fetchNpc = async () => { throw new Error('not_npc'); };
            World.fetchUser = async () => target;

            Request(session, actor, { selfId: 1016 });
            await drain();
            if (kind === 'revived during approach') {
                target.state.setDead(false);
                arrive();
            }
            const started = packets.some(packet => packet[0] === 0x48);
            if (kind === 'dead bot') {
                assert.equal(started, true, 'Resurrection must still start on a dead character');
                assert.equal(actor.canUseSkill(resurrection), false, 'a valid Resurrection starts its reuse');
                actor.automation.abortAll(actor, { notifyClient: false });
                continue;
            }

            assert.equal(started, false, `Resurrection must not animate on ${kind}`);
            assert(!packets.some(packet => packet[0] === 0x60 || packet[0] === 0x01),
                'a rejected Resurrection must not move toward a living target');
            const errors = packets.filter(packet => packet[0] === 0x64).map(packet => packet.readUInt32LE(1));
            assert.deepEqual(errors, [109], `Resurrection on ${kind} must immediately report Incorrect target`);
            assert(packets.some(packet => packet[0] === 0x25), 'the rejected cast must release the client action');
            while (timers.length) timers.shift()();
            assert.equal(mp, 100, `Resurrection on ${kind} must not consume MP after the cast time`);
            assert.equal(actor.canUseSkill(resurrection), true, 'a rejected Resurrection must remain available');
            assert.equal(target.state.fetchDead(), false, 'a rejected Resurrection must leave its living target alive');
        }
    } finally {
        sessions.forEach(session => session.actor.automation.abortAll(session.actor, { notifyClient: false }));
        World.fetchNpc = saved.npc; World.fetchUser = saved.user; utils.isInPeaceZone = saved.peace;
    }
    console.log('Async skill request serialization, queued casts and Resurrection target checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
