const assert = require('node:assert/strict');
require('../src/Global');

const World = invoke('GameServer/World/World');
const Actor = invoke('GameServer/Actor/Actor');
const Attack = invoke('GameServer/Actor/Attack');
const Automation = invoke('GameServer/Automation');
const State = invoke('GameServer/Model/State');
const Session = invoke('GameServer/Session');
const Formulas = invoke('GameServer/Formulas');
const Generics = invoke('GameServer/Actor/Generics');
const Backpack = invoke('GameServer/Actor/Backpack');
const Item = invoke('GameServer/Item/Item');
const { packetReceiver } = invoke('Server');
const EffectStore = invoke('GameServer/Effects/EffectStore');

// Lisvus fdc7e33a: L2CharacterAI.onIntentionAttack acknowledges an unchanged
// target with ActionFailed (otherwise the client freezes until deselection).
// L2PlayerAI.onIntentionMoveTo replaces the attack intention, deferring only
// the current swing/cast; onEvtReadyToAct executes that latest intention.
const drain = () => new Promise(setImmediate);
function frame(payload) {
    const result = Buffer.alloc(payload.length + 2);
    result.writeUInt16LE(result.length);
    payload.copy(result, 2);
    return result;
}
function click(targetId, opcode = 0x04) {
    const packet = Buffer.alloc(18);
    packet[0] = opcode;
    packet.writeInt32LE(targetId, 1);
    return frame(packet);
}
function ground() {
    const packet = Buffer.alloc(25);
    packet[0] = 0x01;
    [-500, 0, -16, 0, 0, 0].forEach((value, index) => packet.writeInt32LE(value, 1 + index * 4));
    return frame(packet);
}
function fixture(kind = 'Weapon.Sword', targetX = 40, entity = 'npc') {
    const packets = [], swingTimers = [];
    const target = { state: new State(), fetchId: () => entity === 'npc' ? 1000001 : 2000002,
        fetchLevel: () => 10, fetchPvpFlag: () => 1,
        fetchLocX: () => targetX, fetchLocY: () => 0, fetchLocZ: () => 0,
        fetchRadius: () => 8, fetchAttackable: () => entity === 'npc', isDead: () => false };
    if (entity === 'npc') target.fetchKind = () => 'Monster';
    const actor = { x: 0, y: 0, z: 0, selected: target.fetchId(), mp: 100,
        effects: {}, state: new State(), attack: new Attack(), automation: new Automation(),
        fetchId: () => 2000001, fetchLevel: () => 10, fetchHead: () => 0, fetchSize: () => 16,
        fetchLocX() { return this.x; }, fetchLocY() { return this.y; }, fetchLocZ() { return this.z; },
        setLocXYZ(p) { this.x = p.locX; this.y = p.locY; this.z = p.locZ; },
        fetchDestId() { return this.selected; }, setDestId(id) { this.selected = id; },
        fetchRadius: () => 8, fetchCollectiveRunSpd: () => 150, fetchCollectiveAtkSpd: () => 333,
        fetchMp() { return this.mp; }, setMp(value) { this.mp = value; }, statusUpdateVitals() {},
        isDead: Actor.prototype.isDead, isBlocked: Actor.prototype.isBlocked,
        backpack: { fetchTotalWeaponKind: () => kind } };
    if (kind === 'Weapon.Bow') {
        actor.backpack = new Backpack({ items: [], paperdoll: {} });
        actor.backpack.items = [
            new Item(1, { selfId: 14, kind, rank: 'none', mp: 2, equipped: true, slot: 14 }),
            new Item(2, { selfId: 17, kind: 'Other.Arrow', amount: 100, stackable: true })
        ];
    }
    const session = { actor, accountId: 'player_click_control', persistenceMode: 'ephemeral',
        dataReceive: Session.prototype.dataReceive,
        dataSendToMe(packet) { packets.push(packet); },
        dataSendToMeAndOthers(packet) { packets.push(packet); } };
    actor.session = session;
    actor.select = data => Generics.select(session, actor, data);
    actor.moveTo = data => Generics.moveTo(session, actor, data);
    actor.attack.resolveMeleeTargets = () => [target];
    actor.attack.prepareMeleeHit = () => ({ damage: 10, flags: 0 });
    actor.attack.hit = () => {};
    actor.attack.applyDamageAbsorb = () => {};
    actor.attack.queueTimer = (callback, ms) => swingTimers.push({ callback, ms });
    World.fetchNpc = () => entity === 'npc' ? Promise.resolve(target) : Promise.reject();
    World.fetchItem = () => Promise.reject();
    World.fetchUser = () => Promise.resolve(target);
    const receive = packetReceiver(packet => session.dataReceive(packet));
    const sendClick = (opcode) => receive(click(target.fetchId(), opcode));
    const sendGround = () => receive(ground());
    const spamThenGround = (opcode) => receive(Buffer.concat([
        ...Array.from({ length: 20 }, () => click(target.fetchId(), opcode)), ground()
    ]));
    const count = opcode => packets.filter(packet => packet[0] === opcode).length;
    return { actor, target, session, packets, swingTimers, receive, sendClick, sendGround, spamThenGround, count };
}

(async () => {
    const saved = { npc: World.fetchNpc, item: World.fetchItem, user: World.fetchUser,
        chance: Formulas.calcHitChance, peace: utils.isInPeaceZone,
        timeout: global.setTimeout, clear: global.clearTimeout, interval: global.clearInterval };
    const fixtures = [];
    const make = (...args) => { const f = fixture(...args); fixtures.push(f); return f; };
    let checks = 0;
    try {
        global.setTimeout = (callback, ms) => ({ callback, ms, _idleTimeout: ms, unref() {} });
        global.clearTimeout = timer => { if (timer) timer.cancelled = true; };
        global.clearInterval = global.clearTimeout;
        Formulas.calcHitChance = () => true;
        utils.isInPeaceZone = () => false;

        for (const kind of ['Weapon.Sword', 'Weapon.Pole', 'Weapon.Bow']) {
            for (const entity of ['npc', 'player']) {
                for (const opcode of [0x04, 0x0a]) {
                    const f = make(kind, 40, entity);
                    f.sendClick(opcode); await drain();
                    assert.equal(f.count(0x05), 1, 'the first click must start exactly one swing');
                    f.spamThenGround(opcode); await drain();
                    f.swingTimers[1].callback(); await drain();
                    assert.equal(f.count(0x01), 1, `${kind}/${entity}/${opcode}: the final ground click must run after the swing`);
                    assert.equal(f.count(0x05), 1, 'older clicks must not restart the attack');
                    assert.equal(f.actor.fetchDestId(), f.target.fetchId(), 'moving must preserve the selected target');
                    checks++;
                }
            }
        }

        for (const opcode of [0x04, 0x0a]) {
            const idle = make('Weapon.Sword', 1000);
            idle.actor.selected = undefined;
            idle.spamThenGround(opcode); await drain();
            assert.equal(idle.count(0x01), 1, 'idle movement must be accepted');
            assert.equal(idle.count(0x60), 0, 'older target lookups must not replace movement with a chase');
            assert.equal(idle.actor.fetchDestId(), idle.target.fetchId(), 'an earlier first click may still select the target');
            checks++;
        }

        for (const kind of ['Weapon.Sword', 'Weapon.Pole', 'Weapon.Bow']) {
            for (const deathBeforeImpact of [false, true]) {
                const dyingTarget = make(kind);
                dyingTarget.sendClick(); await drain();
                dyingTarget.spamThenGround(); await drain();
                if (deathBeforeImpact) dyingTarget.target.state.setDead(true);
                dyingTarget.swingTimers[0].callback();
                dyingTarget.target.state.setDead(true);
                const generation = dyingTarget.session.moveRouteGeneration;
                dyingTarget.swingTimers[1].callback(); await drain();
                assert.equal(dyingTarget.count(0x01), 1, `${kind}: target death must preserve the queued ground click`);
                assert.equal(dyingTarget.count(0x05), 1, 'target death must not restart the attack');
                if (kind === 'Weapon.Bow') assert.equal(dyingTarget.session.moveRouteGeneration, generation,
                    'bow reuse must not abort the movement accepted at arrow release');
                checks++;
            }
        }

        for (const entity of ['npc', 'player']) {
            const pending = make('Weapon.Sword', 1000, entity);
            // Exercise the second async boundary, after selection has finished.
            Generics.attackRequest(pending.session, pending.actor, { id: pending.target.fetchId(), ctrl: true });
            pending.sendGround(); await drain();
            assert.equal(pending.count(0x60), 0, 'an obsolete AttackExec lookup cannot restore the chase');
            assert.equal(pending.count(0x01), 1);
            checks++;
        }

        for (const kind of ['Weapon.Sword', 'Weapon.Pole', 'Weapon.Bow']) {
            const dyingActor = make(kind);
            dyingActor.sendClick(); await drain();
            dyingActor.spamThenGround(); await drain();
            dyingActor.actor.state.setDead(true);
            dyingActor.target.state.setDead(true);
            dyingActor.swingTimers[0].callback();
            dyingActor.swingTimers[1].callback(); await drain();
            assert.equal(dyingActor.count(0x01), 0, 'actor death must still discard queued movement');
            assert.equal(dyingActor.actor.state.fetchHits(), false, 'actor death must release the attack slot');
            checks++;
        }

        for (const opcode of [0x04, 0x0a]) {
            const chasing = make('Weapon.Sword', 1000);
            chasing.sendClick(opcode); await drain();
            const arrival = chasing.actor.automation.timer.action.timer;
            chasing.packets.length = 0;
            for (let i = 0; i < 20; i++) { chasing.sendClick(opcode); await drain(); }
            assert.equal(chasing.count(0x25), 20, 'every duplicate chase request must release the C4 pending action');
            assert.equal(chasing.count(0x60), 0, 'duplicate clicks must not restart the approach');
            assert.equal(chasing.actor.automation.timer.action.timer, arrival, 'duplicate clicks must not postpone arrival');
            chasing.sendGround(); await drain();
            assert.equal(chasing.count(0x01), 1, 'a subsequent ground click must still move');
            assert.equal(chasing.actor.automation.playerAttackApproach, null);
            checks++;
        }

        for (const attackAfterMove of [false, true]) {
            const bow = make('Weapon.Bow');
            bow.sendClick(); await drain();
            bow.swingTimers[0].callback();
            assert.equal(bow.actor.state.fetchHits(), false, 'movement is legal once the arrow is released');
            bow.sendClick(); await drain();
            bow.sendGround(); await drain();
            assert.equal(bow.count(0x01), 1);
            if (attackAfterMove) { bow.sendClick(); await drain(); }
            bow.swingTimers[1].callback(); await drain();
            assert.equal(bow.count(0x05), attackAfterMove ? 2 : 1,
                'bow reload must honor the latest command, including an explicit attack after movement');
            assert.equal(bow.actor.fetchMp(), attackAfterMove ? 96 : 98,
                'cancelled repeats must not spend MP');
            assert.equal(bow.actor.backpack.fetchItemFromSelfId(17).fetchAmount(), attackAfterMove ? 98 : 99,
                'cancelled repeats must not consume arrows');
            checks++;
        }

        const newerAttack = make();
        newerAttack.sendClick(); await drain();
        newerAttack.receive(Buffer.concat([ground(), click(newerAttack.target.fetchId())]));
        await drain();
        newerAttack.swingTimers[1].callback(); await drain();
        assert.equal(newerAttack.count(0x05), 2, 'a genuinely newer attack must replace queued movement');
        assert.equal(newerAttack.count(0x01), 0);
        checks++;

        const casting = make();
        casting.actor.state.setCasts(true);
        casting.spamThenGround(); await drain();
        casting.actor.state.setCasts(false);
        casting.actor.attack.dequeueEvent(casting.session); await drain();
        assert.equal(casting.count(0x01), 1, 'a ground click during casting must survive older target lookups');
        assert.equal(casting.count(0x05), 0);
        checks++;

        const lookupDuringSwing = make();
        Generics.attackRequest(lookupDuringSwing.session, lookupDuringSwing.actor, { id: lookupDuringSwing.target.fetchId() });
        lookupDuringSwing.actor.state.setHits(true);
        lookupDuringSwing.sendGround(); await drain();
        lookupDuringSwing.actor.state.setHits(false);
        lookupDuringSwing.actor.attack.dequeueEvent(lookupDuringSwing.session); await drain();
        assert.equal(lookupDuringSwing.count(0x01), 1, 'an obsolete AttackExec cannot replace a queued ground click');
        assert.equal(lookupDuringSwing.count(0x05), 0);
        checks++;

        const rooted = make();
        EffectStore.apply(rooted.actor, { key: 'root', id: 1201, type: 'debuff', durationMs: 60000 });
        Generics.attackRequest(rooted.session, rooted.actor, { id: rooted.target.fetchId() });
        rooted.sendGround(); await drain();
        assert.equal(rooted.count(0x01), 0, 'root must reject movement');
        assert.equal(rooted.count(0x05), 1, 'rejected movement must preserve an allowed pending attack');
        EffectStore.remove(rooted.actor, 'root');
        checks++;

        const replaced = make('Weapon.Sword', 1000);
        Generics.attackRequest(replaced.session, replaced.actor, { id: replaced.target.fetchId() });
        replaced.session.actor = {};
        await drain();
        assert.equal(replaced.count(0x60), 0, 'a retired actor cannot resume an async attack');
        checks++;

        console.log(`Player click control: ${checks} command ordering, chase acknowledgement and bow reload checks passed`);
    } finally {
        fixtures.forEach(f => f.actor.automation.abortAll(f.actor, { notifyClient: false }));
        World.fetchNpc = saved.npc; World.fetchItem = saved.item; World.fetchUser = saved.user;
        Formulas.calcHitChance = saved.chance; utils.isInPeaceZone = saved.peace;
        global.setTimeout = saved.timeout; global.clearTimeout = saved.clear; global.clearInterval = saved.interval;
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
