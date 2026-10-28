const assert = require('node:assert/strict');
require('../src/Global');

const Automation = invoke('GameServer/Automation');
const State = invoke('GameServer/Model/State');
const Store = invoke('GameServer/Effects/EffectStore');
const Restrictions = invoke('GameServer/Effects/EffectRestrictions');
const AttackRequest = invoke('GameServer/Actor/Generics/AttackRequest');
const SkillRequest = invoke('GameServer/Actor/Generics/SkillRequest');
const Validate = invoke('GameServer/Network/Request/ValidatePosition');
const World = invoke('GameServer/World/World');
const Timer = invoke('GameServer/Timer');

(async () => {
    const saved = { now: Date.now, timeout: global.setTimeout, clear: global.clearTimeout,
        npc: World.fetchNpc, user: World.fetchUser, peace: utils.isInPeaceZone };
    let now = 10000;
    const packets = [], hits = [], casts = [];
    const target = { x: 500, state: new State(), fetchId: () => 2000002,
        fetchLocX() { return this.x; }, fetchLocY: () => 0, fetchLocZ: () => 600,
        fetchRadius: () => 9, fetchPvpFlag: () => 1 };
    const skill = { fetchSelfId: () => 263, fetchTargetKind: () => 'enemy', fetchDistance: () => 600 };
    const actor = { x: 0, y: 0, z: 0, effects: {}, state: new State(), automation: new Automation(),
        fetchId: () => 2000001, fetchLocX() { return this.x; }, fetchLocY() { return this.y; }, fetchLocZ() { return this.z; },
        setLocXYZ(c) { this.x = c.locX; this.y = c.locY; this.z = c.locZ; },
        fetchHead: () => 0, fetchRadius: () => 9, fetchCollectiveRunSpd: () => 150,
        fetchDestId: () => target.fetchId(), isDead: () => false,
        isBlocked() { return this.state.isBlocked(); }, canUseSkill: () => true,
        backpack: { fetchTotalWeaponKind: () => 'Weapon.Knife' },
        skillset: { fetchSkill: () => skill },
        attack: { meleeHit() { hits.push(actor.x); }, remoteHit() { casts.push(actor.x); } } };
    const session = { actor, persistenceMode: 'ephemeral', dataSendToMe(p) { packets.push(p); },
        dataSendToMeAndOthers(p) { packets.push(p); } };
    actor.session = session;
    const request = () => AttackRequest(session, actor, { id: target.fetchId(), ctrl: false });
    const drain = () => new Promise(setImmediate);
    const report = (x = actor.x) => {
        const packet = Buffer.alloc(21);
        [x, actor.y, actor.z, 0, 0].forEach((n, i) => packet.writeInt32LE(n, 1 + i * 4));
        return Validate(session, packet);
    };
    try {
        Date.now = () => now;
        global.setTimeout = (callback, ms) => ({ callback, ms, cleared: false });
        global.clearTimeout = timer => { if (timer) timer.cleared = true; };
        World.fetchNpc = async () => { throw new Error('not_npc'); };
        World.fetchUser = async () => target;
        utils.isInPeaceZone = () => false;

        request(); await drain();
        const arrival = actor.automation.timer.action.timer;
        const duration = arrival.ms;
        now += duration / 2;
        const root = Store.apply(actor, { key: 'root', id: 1201, type: 'debuff', durationMs: 60000 });
        Restrictions.interruptOnApply(session, actor, root);
        assert(actor.x > 200 && actor.x < 260,
            'root must freeze actual approach progress instead of the last client report');
        assert.equal(actor.z, 0, 'intermediate player movement must preserve the client floor');
        const frozen = actor.x;
        now += duration;
        arrival.callback();
        assert.equal(actor.x, frozen, 'the cancelled arrival cannot move a rooted player');
        assert.equal(hits.length, 0, 'root must still prevent an out-of-range attack');

        target.x = frozen + 40;
        request(); await drain();
        assert.equal(hits.length, 1, 'the rooted player can hit a target at the actual stopping position');
        packets.length = 0;
        assert.equal(report(), false);
        assert.equal(report(frozen + 1), false);
        assert.equal(packets.length, 0, 'stationary validation must not interrupt combat with StopMove or ActionFailed');
        assert.equal(report(frozen + 100), false);
        assert.equal(actor.x, frozen, 'rooted reports cannot relocate the player');
        assert.equal(packets.filter(p => p[0] === 0x47).length, 1, 'a drifted report must receive the authoritative stop');
        assert(!packets.some(p => p[0] === 0x25), 'position validation is not a failed combat action');

        Store.remove(actor, 'root');
        actor.x = 0;
        target.x = 500;
        request(); await drain();
        const chase = actor.automation.playerAttackApproach;
        now += actor.automation.timer.action.timer.ms * 0.95;
        const secondRoot = Store.apply(actor, { key: 'root', id: 1201, type: 'debuff', durationMs: 60000 });
        // The target closes the remaining gap while the player is moving.
        target.x = 450;
        Restrictions.interruptOnApply(session, actor, secondRoot);
        assert.equal(hits.length, 2, 'root must preserve an attack intention when the target is now in range');
        chase.rangeTimer.callback();
        assert.equal(hits.length, 2, 'an old approach watcher cannot duplicate the rooted attack');

        Store.remove(actor, 'root');
        actor.x = 0;
        target.x = 40;
        SkillRequest(session, actor, { selfId: skill.fetchSelfId(), ctrl: true });
        await drain();
        assert.equal(casts.length, 1, 'a stationary combat skill must start without waiting for ValidatePosition');
        assert.equal(actor.storedSpell, undefined, 'a late position report must not replay the skill');

        actor.x = 0;
        target.x = 500;
        request(); await drain();
        now += 500;
        actor.setLocXYZ({ locX: 300, locY: 0, locZ: -80 });
        actor.automation.refreshPlayerAttackApproach(session, actor);
        now += 100;
        actor.automation.updateMovePosition();
        assert(actor.x >= 300, 'interpolation must continue from the accepted client position');
        assert.equal(actor.z, -80, 'interpolation must preserve accepted slope height');

        const waitingRoot = Store.apply(actor, { key: 'root', id: 1201, type: 'debuff', durationMs: 60000 });
        Restrictions.interruptOnApply(session, actor, waitingRoot);
        const waiting = actor.automation.playerAttackApproach;
        assert.equal(waiting.stationary, true, 'an interrupted attack must retain its intention while out of range');
        const beforeReturn = hits.length;
        const stoppedX = actor.x;
        now += 100;
        waiting.rangeTimer.callback();
        assert.equal(actor.x, stoppedX, 'waiting for a target must not move a rooted player');
        assert.equal(hits.length, beforeReturn, 'waiting must not deal damage outside attack range');
        target.x = stoppedX + 40;
        waiting.rangeTimer.callback();
        assert.equal(hits.length, beforeReturn + 1, 'a returning target must be attacked without another click');

        target.x = actor.x + 300;
        request(); await drain();
        const expiringWait = actor.automation.playerAttackApproach;
        Store.remove(actor, 'root');
        expiringWait.rangeTimer.callback();
        assert.equal(actor.state.fetchTowards(), 'melee', 'root expiry must resume the pending chase without another click');
        const resumed = actor.automation.playerAttackApproach;
        actor.automation.abortAll(actor, { notifyClient: false });
        const afterCancel = hits.length;
        resumed.rangeTimer.callback();
        expiringWait.rangeTimer.callback();
        assert.equal(hits.length, afterCancel, 'cancelled waits must not resurrect the attack');

        Store.apply(actor, { key: 'root', id: 1201, type: 'debuff', durationMs: 60000 });
        request(); await drain();
        const replacedWait = actor.automation.playerAttackApproach;
        target.x = actor.x + 40;
        SkillRequest(session, actor, { selfId: skill.fetchSelfId(), ctrl: true });
        await drain();
        replacedWait.rangeTimer.callback();
        assert.equal(hits.length, afterCancel, 'a new skill must replace the stationary attack intention');

        target.x = actor.x + 300;
        request(); await drain();
        const deselectedWait = actor.automation.playerAttackApproach;
        actor.fetchDestId = () => undefined;
        deselectedWait.rangeTimer.callback();
        assert.equal(actor.automation.playerAttackApproach, null, 'deselecting the target must cancel the waiting attack');
        actor.fetchDestId = () => target.fetchId();
        Store.remove(actor, 'root');
        request(); await drain();
        target.state.setDead(true);
        actor.automation.playerAttackApproach.rangeTimer.callback();
        assert.equal(actor.automation.moveInterpolation, null, 'a dead target must stop approach interpolation');
        assert.equal(actor.automation.timer.action.timer, undefined, 'a dead target must cancel the fallback arrival');
    } finally {
        actor.automation.abortAll(actor, { notifyClient: false });
        Timer.clear(actor.automation.timer.action);
        Date.now = saved.now; global.setTimeout = saved.timeout; global.clearTimeout = saved.clear;
        World.fetchNpc = saved.npc; World.fetchUser = saved.user; utils.isInPeaceZone = saved.peace;
    }
    console.log('Player root position, attack continuity and stationary skill checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
