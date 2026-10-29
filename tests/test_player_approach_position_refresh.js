const assert = require('node:assert/strict');
require('../src/Global');
const Automation = invoke('GameServer/Automation');
const State = invoke('GameServer/Model/State');
const Timer = invoke('GameServer/Timer');
const World = invoke('GameServer/World/World');
const Request = invoke('GameServer/Actor/Generics/AttackRequest');
const Update = invoke('GameServer/Actor/Generics/UpdatePosition');
const Generics = invoke(path.actor);
const Party = invoke('GameServer/Bot/AI/PartyCompanionService');

(async () => {
    const saved = { now: Date.now, start: Timer.start, clear: Timer.clear, npc: World.fetchNpc,
        timeout: global.setTimeout, clearTimeout: global.clearTimeout,
        environment: Generics.updateEnvironment, underwater: Generics.underwaterCheck, party: Party.updatePosition };
    let now = 10000;
    try {
        Date.now = () => now;
        global.setTimeout = (callback, ms) => ({ callback, ms, cleared: false });
        global.clearTimeout = timer => { if (timer) timer.cleared = true; };
        Timer.start = (handler, callback, ms) => { handler.timer = { callback, due: now + ms }; };
        Timer.clear = handler => { delete handler.timer; };
        Generics.updateEnvironment = Generics.underwaterCheck = Party.updatePosition = () => {};
        const packets = [], hits = [];
        const target = { fetchId: () => 1006959, fetchLocX: () => 110080.53699096091,
            fetchLocY: () => -174091.3420422372, fetchLocZ: () => -559,
            fetchRadius: () => 9.5, fetchAttackable: () => true };
        const actor = { x: 109916, y: -173891, z: -559, state: new State(), automation: new Automation(),
            fetchId: () => 2001804, fetchLocX() { return this.x; }, fetchLocY() { return this.y; }, fetchLocZ() { return this.z; },
            setLocXYZ(c) { this.x = c.locX; this.y = c.locY; this.z = c.locZ; },
            setLocXYZH(c) { this.setLocXYZ(c); }, fetchHead: () => 0, fetchRadius: () => 9,
            fetchDestId: () => target.fetchId(), fetchCollectiveRunSpd: () => 125.32994306319671,
            isDead: () => false, isBlocked: () => false, effects: {},
            backpack: { fetchTotalWeaponKind: () => 'Weapon.Blunt' }, attack: { meleeHit: () => hits.push(now) } };
        const session = { actor, persistenceMode: 'ephemeral', dataSendToMe: p => packets.push(p),
            dataSendToMeAndOthers: p => packets.push(p) };
        actor.session = session;
        World.fetchNpc = async () => target;
        const drain = () => new Promise(setImmediate);
        const request = () => Request(session, actor, { id: target.fetchId(), locX: 109968, locY: -173927, locZ: -559 });
        request(); await drain();
        const original = actor.automation.timer.action.timer;
        assert(original.due - now > 1780 && original.due - now < 1783);
        now += 16;
        Update(session, actor, { locX: 109970, locY: -173929, locZ: -559 });
        const refreshed = actor.automation.timer.action.timer;
        assert(refreshed.due < original.due - 450, 'fresh position must remove the stale-position approach delay');
        assert.equal(packets.filter(p => p[0] === 0x60).length, 1, 'position refresh must not restart client movement');
        request(); await drain();
        assert.equal(actor.automation.timer.action.timer, refreshed, 'repeated click must not delay arrival');
        assert.equal(packets.filter(p => p[0] === 0x25).length, 1, 'the duplicate click must release the pending client action');
        // Repeated/stale reports must not move the deadline back again.
        now += 100;
        Update(session, actor, { locX: 109970, locY: -173929, locZ: -559 });
        assert.equal(actor.automation.timer.action.timer, refreshed);
        original.callback();
        assert.equal(hits.length, 0, 'superseded timer cannot attack or overwrite position');
        now = refreshed.due;
        refreshed.callback();
        assert.equal(hits.length, 1, 'corrected fallback still attacks without a final position packet');
        refreshed.callback();
        assert.equal(hits.length, 1, 'arrival is consumed once');

        actor.setLocXYZ({ locX: 109916, locY: -173891, locZ: -559 });
        request(); await drain();
        const cancelled = actor.automation.timer.action.timer;
        actor.automation.abortAll(actor, { notifyClient: false });
        Update(session, actor, { locX: 110053, locY: -174051, locZ: -559 });
        cancelled.callback();
        assert.equal(hits.length, 1, 'position after cancellation cannot revive an attack');

        // Packet timing varies between encounters. A delayed report may help,
        // do nothing, or arrive after the old estimate; it must never postpone it.
        for (const lag of [0, 16, 100, 500, 700]) {
            actor.setLocXYZ({ locX: 109916, locY: -173891, locZ: -559 });
            request(); await drain();
            const pending = actor.automation.timer.action.timer;
            now += lag;
            Update(session, actor, { locX: 109970, locY: -173929, locZ: -559 });
            assert(actor.automation.timer.action.timer.due <= pending.due);
            actor.automation.abortAll(actor, { notifyClient: false });
        }

        actor.setLocXYZ({ locX: 109916, locY: -173891, locZ: -559 });
        request(); await drain();
        const beforeArrival = hits.length;
        const fallback = actor.automation.timer.action.timer;
        now += 1200;
        Update(session, actor, { locX: 110053, locY: -174051, locZ: -559 });
        assert.equal(hits.length, beforeArrival + 1, 'accepted position in range starts the attack immediately');
        assert.equal(actor.x, 110053, 'early arrival preserves the accepted position');
        fallback.callback();
        assert.equal(hits.length, beforeArrival + 1);

        // Live Kranrot encounter: the target reaches the player's latest
        // accepted position before the original approach deadline. No new
        // ValidatePosition arrives; the old destination is now behind it.
        target.x = 175961;
        target.y = 62886;
        target.fetchLocX = () => target.x;
        target.fetchLocY = () => target.y;
        target.fetchLocZ = () => -4370;
        actor.setLocXYZ({ locX: 176311, locY: 62692, locZ: -4370 });
        request(); await drain();
        const movingArrival = actor.automation.timer.action.timer;
        const approach = actor.automation.playerAttackApproach;
        const firstPoll = approach.rangeTimer;
        firstPoll.callback();
        assert.notEqual(approach.rangeTimer, firstPoll, 'out-of-range polling must continue');
        const rangePoll = approach.rangeTimer;
        actor.setLocXYZ({ locX: 176176, locY: 62766, locZ: -4370 });
        target.x = 176141;
        target.y = 62786;
        const beforeMeeting = hits.length;
        rangePoll.callback();
        assert.equal(hits.length, beforeMeeting + 1, 'a target in range must trigger attack without a position packet');
        assert.equal(actor.x, 176176, 'meeting must preserve the accepted player position');
        assert.equal(rangePoll.cleared, true, 'arrival must clear the range watcher');
        movingArrival.callback();
        assert.equal(hits.length, beforeMeeting + 1, 'old arrival cannot repeat the attack');

        actor.setLocXYZ({ locX: 176311, locY: 62692, locZ: -4370 });
        request(); await drain();
        const delayedPoll = actor.automation.playerAttackApproach.rangeTimer;
        const deadline = actor.automation.timer.action.timer;
        actor.setLocXYZ({ locX: 176176, locY: 62766, locZ: -4370 });
        deadline.callback();
        assert.equal(actor.x, 176176, 'deadline must also preserve an already reachable position');
        assert.equal(delayedPoll.cleared, true);

        actor.setLocXYZ({ locX: 176311, locY: 62692, locZ: -4370 });
        request(); await drain();
        const cancelledPoll = actor.automation.playerAttackApproach.rangeTimer;
        actor.automation.abortAll(actor, { notifyClient: false });
        const afterCancel = hits.length;
        actor.setLocXYZ({ locX: 176176, locY: 62766, locZ: -4370 });
        cancelledPoll.callback();
        assert.equal(cancelledPoll.cleared, true, 'cancellation must clear the watcher');
        assert.equal(hits.length, afterCancel, 'cancelled watcher cannot revive an attack');
    } finally {
        global.setTimeout = saved.timeout; global.clearTimeout = saved.clearTimeout;
        Date.now = saved.now; Timer.start = saved.start; Timer.clear = saved.clear; World.fetchNpc = saved.npc;
        Generics.updateEnvironment = saved.environment; Generics.underwaterCheck = saved.underwater; Party.updatePosition = saved.party;
    }
    console.log('Player approach position refresh and cancellation checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
