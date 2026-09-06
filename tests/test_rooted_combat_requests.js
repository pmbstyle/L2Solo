const assert = require('assert');
require('../src/Global');
const AttackRequest = invoke('GameServer/Actor/Generics/AttackRequest');
const AttackExec = invoke('GameServer/Actor/Generics/AttackExec');
const SkillRequest = invoke('GameServer/Actor/Generics/SkillRequest');
const SkillExec = invoke('GameServer/Actor/Generics/SkillExec');
const Automation = invoke('GameServer/Automation');
const State = invoke('GameServer/Model/State');
const Store = invoke('GameServer/Effects/EffectStore');
const World = invoke('GameServer/World/World');

async function run() {
    const saved = { npc: World.fetchNpc, user: World.fetchUser, peace: utils.isInPeaceZone };
    const packets = [], hits = [], casts = [];
    const skill = { fetchSelfId: () => 54, fetchTargetKind: () => 'enemy', fetchDistance: () => 600 };
    const target = { x: 40, flag: 1, karma: 0,
        fetchId: () => 2000002, fetchLocX() { return this.x; }, fetchLocY: () => 0, fetchLocZ: () => 0,
        fetchRadius: () => 8, fetchPvpFlag() { return this.flag; }, fetchKarma() { return this.karma; } };
    const actor = { effects: {}, state: new State(), automation: new Automation(),
        fetchName: () => 'RootedFighter',
        fetchId: () => 2000001, fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0,
        fetchHead: () => 0, fetchRadius: () => 8, fetchDestId: () => target.fetchId(),
        isDead: () => false, isBlocked() { return this.state.isBlocked(); }, canUseSkill: () => true,
        backpack: { fetchTotalWeaponKind: () => 'Weapon.DualFist' },
        skillset: { fetchSkill: () => skill },
        attack: { meleeHit() { hits.push(target.x); }, remoteHit() { casts.push(target.x); } } };
    const session = { actor, dataSendToMe(packet) { packets.push(packet); },
        dataSendToMeAndOthers(packet) { packets.push(packet); } };
    actor.session = session;
    const drain = () => new Promise(resolve => setImmediate(resolve));
    try {
        World.fetchNpc = () => Promise.reject(new Error('npc_not_found'));
        World.fetchUser = () => Promise.resolve(target);
        utils.isInPeaceZone = () => false;
        Store.apply(actor, { key: 'root', category: 'root', type: 'debuff', id: 1201, durationMs: 60000 });
        AttackRequest(session, actor, { id: target.fetchId(), ctrl: false });
        await drain();
        assert.deepStrictEqual(hits, [40], 'rooted players must attack a nearby purple bot without a position acknowledgement');
        assert.strictEqual(actor.storedAttack, undefined, 'root must not strand the attack in the movement handshake');
        assert.strictEqual(actor.state.inMotion(), false);

        target.x = 200;
        AttackRequest(session, actor, { id: target.fetchId(), ctrl: true });
        await drain();
        assert.strictEqual(hits.length, 1, 'root must not allow melee damage outside weapon range');
        assert.strictEqual(actor.state.inMotion(), false, 'root must not schedule a chase');

        SkillRequest(session, actor, { selfId: 54, ctrl: false });
        await drain();
        assert.deepStrictEqual(casts, [200], 'rooted players must cast an in-range skill without moving');
        assert.strictEqual(actor.storedSpell, undefined);
        target.x = 601;
        SkillRequest(session, actor, { selfId: 54, ctrl: true });
        await drain();
        assert.strictEqual(casts.length, 1, 'root must not allow approaching an out-of-range skill target');
        assert(!packets.some(p => p[0] === 0x01 || p[0] === 0x60), 'rooted combat must never announce movement');

        // Reproduce skill opener -> purple defender -> ordinary attack with
        // no debuff. Permission is rechecked when the approach completes.
        Store.remove(actor, 'root');
        actor.automation.scheduleAction = (_s, _a, _t, _r, callback) => callback();
        target.x = 40;
        for (const [flag, karma, ctrl, allowed] of [[1, 0, false, true], [0, 1, false, true],
            [0, 0, false, false], [0, 0, true, true]]) {
            target.flag = flag; target.karma = karma;
            const hitCount = hits.length, castCount = casts.length;
            AttackExec(session, actor, { id: target.fetchId(), ctrl });
            SkillExec(session, actor, { id: target.fetchId(), selfId: 54, ctrl });
            await drain();
            assert.strictEqual(hits.length - hitCount, Number(allowed), `attack permission: flag=${flag}, karma=${karma}, ctrl=${ctrl}`);
            assert.strictEqual(casts.length - castCount, Number(allowed), `skill permission: flag=${flag}, karma=${karma}, ctrl=${ctrl}`);
        }
        utils.isInPeaceZone = () => true;
        target.flag = 1;
        const hitCount = hits.length, castCount = casts.length;
        AttackExec(session, actor, { id: target.fetchId(), ctrl: true });
        SkillExec(session, actor, { id: target.fetchId(), selfId: 54, ctrl: true });
        await drain();
        assert.strictEqual(hits.length, hitCount, 'a purple target must remain protected in a peace zone');
        assert.strictEqual(casts.length, castCount, 'hostile skills must respect peace zones');
    } finally {
        World.fetchNpc = saved.npc; World.fetchUser = saved.user; utils.isInPeaceZone = saved.peace;
        actor.automation.abortAll(actor, { notifyClient: false });
    }
    console.log('Rooted combat and PvP request checks passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
