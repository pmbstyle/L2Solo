const assert = require('node:assert/strict');
require('../src/Global');

const Request = invoke('GameServer/Actor/Generics/AttackRequest');
const Attack = invoke('GameServer/Actor/Attack');
const Automation = invoke('GameServer/Automation');
const State = invoke('GameServer/Model/State');
const World = invoke('GameServer/World/World');
const Range = invoke('GameServer/Actor/AttackRange');

(async () => {
    const saved = { now: Date.now, timeout: global.setTimeout, clear: global.clearTimeout, npc: World.fetchNpc };
    let now = 10000;
    const packets = [], swings = [];
    const target = { x: 500, state: new State(), fetchId: () => 1000001,
        fetchLocX() { return this.x; }, fetchLocY: () => 0, fetchLocZ: () => 0,
        fetchRadius: () => 8, fetchAttackable: () => true };
    const actor = { x: 0, state: new State(), effects: {}, attack: new Attack(), automation: new Automation(),
        fetchId: () => 2000001, fetchLocX() { return this.x; }, fetchLocY: () => 0, fetchLocZ: () => 0,
        setLocXYZ(c) { this.x = c.locX; }, fetchHead: () => 0, fetchRadius: () => 8,
        fetchCollectiveRunSpd: () => 100, fetchCollectiveAtkSpd: () => 333,
        fetchDestId: () => target.fetchId(), isDead: () => false,
        isBlocked() { return this.state.isBlocked(); }, backpack: { fetchTotalWeaponKind: () => 'Weapon.Knife' } };
    const session = { actor, persistenceMode: 'ephemeral', dataSendToMe(p) { packets.push(p); },
        dataSendToMeAndOthers(p) { packets.push(p); } };
    actor.session = session;
    actor.attack.prepareMeleeHit = () => ({ damage: 10, flags: 0 });
    actor.attack.queueTimer = callback => swings.push(callback);
    try {
        Date.now = () => now;
        global.setTimeout = (callback, ms) => ({ callback, ms, _idleTimeout: ms, _idleStart: now });
        global.clearTimeout = () => {};
        World.fetchNpc = async () => target;
        for (const destination of [800, -800]) {
            actor.automation.abortAll(actor, { notifyClient: false });
            actor.x = 0; target.x = 500; packets.length = 0; swings.length = 0;
            const startedAt = now;
            Request(session, actor, { id: target.fetchId() });
            await new Promise(setImmediate);
            const approach = actor.automation.playerAttackApproach;
            const arrival = actor.automation.timer.action.timer;
            now += 2000;
            actor.x = 200;
            target.x = destination;
            actor.automation.refreshPlayerAttackApproach(session, actor);
            assert.equal(approach.dueAt, startedAt + arrival.ms, 'target escape must not extend the old fallback');

            now = approach.dueAt - 40;
            actor.automation.updateMovePosition();
            approach.rangeTimer.callback();
            assert(Math.abs(actor.x - 200) <= (now - startedAt - 2000) / 10 + 1,
                'retargeted interpolation must never move faster than the run speed');
            assert.equal(swings.length, 0, 'an escaping target must not receive a hit from an accelerated position');

            const beforeFallback = actor.x;
            now = approach.dueAt;
            arrival.callback();
            assert(Math.abs(actor.x - beforeFallback) <= 5,
                'fallback must preserve direction and advance only the final 40 milliseconds');
            assert(Math.abs(actor.x - 200) <= (now - startedAt - 2000) / 10 + 1,
                'fallback arrival must not teleport to the previous target stopping point');
            assert.equal(swings.length, 0, 'fallback must chase again instead of damaging an unreachable target');
            assert(actor.automation.playerAttackApproach, 'an escaped target must retain an active chase');
            assert.notEqual(actor.automation.playerAttackApproach, approach);
            assert(!Range.isWithinRange(actor, target, 40));
            actor.automation.abortAll(actor, { notifyClient: false });
        }
    } finally {
        actor.automation.abortAll(actor, { notifyClient: false });
        Date.now = saved.now; global.setTimeout = saved.timeout; global.clearTimeout = saved.clear;
        World.fetchNpc = saved.npc;
    }
    console.log('Moving target approach speed and fallback position checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
