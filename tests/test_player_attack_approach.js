const assert = require('assert');
require('../src/Global');
const World = invoke('GameServer/World/World');
const Automation = invoke('GameServer/Automation');
const State = invoke('GameServer/Model/State');
const Timer = invoke('GameServer/Timer');
const Attack = invoke('GameServer/Actor/Attack');
const Request = invoke('GameServer/Actor/Generics/AttackRequest');
const Range = invoke('GameServer/Actor/AttackRange');
const Formulas = invoke('GameServer/Formulas');

(async () => {
    const saved = { npc: World.fetchNpc, user: World.fetchUser, start: Timer.start, clear: Timer.clear,
        chance: Formulas.calcHitChance, peace: utils.isInPeaceZone };
    let starts = 0;
    try {
        Timer.start = (handler, callback) => { handler.timer = { callback }; starts++; };
        Timer.clear = handler => { delete handler.timer; };
        Formulas.calcHitChance = () => true;
        utils.isInPeaceZone = () => false;
        for (const npc of [true, false]) {
            for (const kind of ['Weapon.DualFist', 'Weapon.Bow', 'Weapon.Pole']) {
                const packets = [], hits = [], damage = [];
                const liveArcher = npc && kind === 'Weapon.DualFist';
                const actor = { x: liveArcher ? -96531 : 0, y: liveArcher ? 106263 : 0, z: liveArcher ? -3368 : 0,
                    effects: {}, state: new State(), automation: new Automation(), attack: new Attack(),
                    fetchId: () => 2000001, fetchLocX() { return this.x; }, fetchLocY() { return this.y; }, fetchLocZ() { return this.z; },
                    setLocXYZ(coords) { this.x = coords.locX; this.y = coords.locY; this.z = coords.locZ; },
                    fetchHead: () => 0, fetchRadius: () => 11, fetchDestId: () => target.fetchId(),
                    fetchCollectiveRunSpd: () => 148, fetchCollectiveAtkSpd: () => 333,
                    isDead: () => false, isBlocked() { return this.state.isBlocked(); },
                    backpack: { fetchTotalWeaponKind: () => kind } };
                const target = { x: liveArcher ? -96020.55687530595 : 1000, state: new State(), effects: {},
                    fetchId: () => npc ? 1000001 : 2000002, fetchLocX() { return this.x; },
                    fetchLocY: () => liveArcher ? 105651.7626375404 : 0, fetchLocZ: () => liveArcher ? -3371 : 0,
                    fetchRadius: () => liveArcher ? 14 : 10, fetchAttackable: () => npc, fetchPvpFlag: () => 1, isDead: () => false };
                if (npc) target.fetchKind = () => 'Monster';
                const session = { actor, dataSendToMeAndOthers: packet => packets.push(packet) };
                actor.session = session;
                actor.attack.resolveMeleeTargets = () => [target];
                actor.attack.prepareMeleeHit = () => ({ damage: 10, flags: 0 });
                actor.attack.queueTimer = callback => hits.push(callback);
                actor.attack.hit = () => damage.push(10);
                actor.attack.applyDamageAbsorb = () => {};
                World.fetchNpc = () => npc ? Promise.resolve(target) : Promise.reject(new Error('not_npc'));
                World.fetchUser = () => Promise.resolve(target);
                const drain = () => new Promise(setImmediate);
                Request(session, actor, { id: target.fetchId(), ctrl: true });
                await drain();
                assert.strictEqual(actor.state.fetchTowards(), 'melee', 'weapon approach must be distinguished from spell approach');
                const pending = actor.automation.timer.action.timer;
                const count = starts;
                for (let i = 0; i < 10; i++) {
                    Request(session, actor, { id: target.fetchId(), ctrl: true });
                    await drain();
                }
                assert.strictEqual(starts, count, 'repeated attack clicks must not postpone arrival');
                assert.strictEqual(actor.automation.timer.action.timer, pending);
                const approach = packets.find(p => p[0] === 0x60);
                const offset = approach.readInt32LE(9);
                const allowed = Range.effectiveRange(actor, target, Range.fetchNormalAttackRange(actor));
                assert(offset < allowed, 'approach should stop inside attack range, leaving room for coordinate rounding');
                // Replay the live failure: the last client acknowledgement
                // arrives about 50 units before the final stopping point.
                // No additional ValidatePosition follows when the client stops.
                if (liveArcher) actor.setLocXYZ({ locX: -96095, locY: 105739, locZ: -3357 });
                else actor.x = target.x - offset - 50;
                assert(!Range.isWithinRange(actor, target, Range.fetchNormalAttackRange(actor)));
                pending.callback();
                assert(actor.state.fetchHits(), 'arrival at a stationary target must begin the real attack');
                hits.shift()();
                assert.deepStrictEqual(damage, [10]);
                actor.state.setHits(false); hits.length = 0;
                const beforeNear = starts;
                Request(session, actor, { id: target.fetchId(), ctrl: true });
                await drain();
                assert.strictEqual(starts, beforeNear, 'an already reachable target needs no movement timer');
                assert(actor.state.fetchHits());

                actor.state.setHits(false); hits.length = 0;
                target.x += 1000;
                Request(session, actor, { id: target.fetchId(), ctrl: true });
                await drain();
                const oldArrival = actor.automation.timer.action.timer;
                target.x += 1000;
                oldArrival.callback();
                assert(!actor.state.fetchHits(), 'arrival at the old position must not hit an escaping target');
                assert.strictEqual(hits.length, 0, 'an escaped target must not schedule remote damage');
                assert.notStrictEqual(actor.automation.timer.action.timer, oldArrival, 'the escape starts another approach');
                actor.automation.abortAll(actor, { notifyClient: false });
                assert.strictEqual(actor.automation.timer.action.timer, undefined, 'cancellation removes the pending position completion');
            }
        }
    } finally {
        World.fetchNpc = saved.npc; World.fetchUser = saved.user; Timer.start = saved.start; Timer.clear = saved.clear;
        Formulas.calcHitChance = saved.chance; utils.isInPeaceZone = saved.peace;
    }
    console.log('Player attack approach and repeated-click checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
