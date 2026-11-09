const assert = require('assert');
require('../src/Global');
const Automation = invoke('GameServer/Automation');
const State = invoke('GameServer/Model/State');
const World = invoke('GameServer/World/World');
const Generics = invoke(path.actor);
const Purchase = invoke('GameServer/World/Generics/PurchaseItem');
const Database = invoke('Database');
const Data = invoke('GameServer/DataCache');
const Response = invoke('GameServer/Network/Response');

async function main() {
    const saved = [];
    const replace = (obj, key, value) => {
        const old = obj[key]; saved.push(() => obj[key] = old); obj[key] = value;
    };
    let now = 0;
    const timers = new Map();
    const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
    const advance = async ms => {
        const end = now + ms;
        for (;;) {
            const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) break;
            now = next[1].at; timers.delete(next[0]); next[1].callback(); await flush();
        }
        now = end; await flush();
    };
    const awards = [];
    const drops = new Map();
    const item = (id, x) => {
        const ob = { fetchId: () => id, fetchLocX: () => x, fetchLocY: () => 0, fetchLocZ: () => 0 };
        drops.set(id, ob); return ob;
    };
    const actor = { x: 0, state: new State(), automation: new Automation(),
        fetchId: () => 1, fetchHead: () => 0, fetchRadius: () => 10,
        fetchLocX() { return this.x; }, fetchLocY: () => 0, fetchLocZ: () => 0,
        setLocXYZ(loc) { this.x = loc.locX; }, isDead: () => false,
        isBlocked() { return this.state.isBlocked(); }, fetchIsOnline: () => true,
        fetchCollectiveRunSpd: () => 100, fetchCollectiveWalkSpd: () => 50 };
    const packets = [];
    const session = { actor, dataSendToMeAndOthers(packet) { packets.push(packet[0]); }, dataSendToMe(packet) { packets.push(packet[0]); } };
    actor.session = session;
    try {
        replace(Date, 'now', () => now);
        replace(global, 'setTimeout', (callback, delay) => {
            const key = { _idleTimeout: delay }; timers.set(key, { callback, at: now + delay }); return key;
        });
        replace(global, 'clearTimeout', key => timers.delete(key));
        replace(global, 'clearInterval', key => timers.delete(key));
        replace(World, 'fetchItem', id => Promise.resolve(drops.get(id)));
        replace(World, 'pickupItem', (_s, _a, ob) => { awards.push([ob.fetchId(), now]); drops.delete(ob.fetchId()); });
        replace(Response, 'pickupItem', () => Buffer.from([0x0d]));
        item(10, 0); item(11, 45);
        Generics.pickupRequest(session, actor, { id: 10 }); await flush();
        Generics.pickupRequest(session, actor, { id: 11 }); await flush();
        assert.deepStrictEqual(awards, [[10, 0], [11, 0]], 'nearby loot needs no movement, cooldown or ValidatePosition');
        assert.deepStrictEqual(packets.slice(-3), [0x25, 0x47, 0x0d], 'ActionFailed and final StopMove must precede GetItem');
        assert.strictEqual(actor.state.isBlocked(), false);
        assert.strictEqual(timers.size, 0);

        item(12, 300); item(13, -100);
        Generics.pickupRequest(session, actor, { id: 12 }); await flush();
        await advance(200);
        assert.strictEqual(actor.x, 20, 'authoritative position advances during pickup');
        const generation = actor.automation.pickupGeneration;
        Generics.pickupRequest(session, actor, { id: 12 }); await flush();
        assert.strictEqual(actor.automation.pickupGeneration, generation, 'repeated clicks on the same loot preserve the approach');
        Generics.pickupRequest(session, actor, { id: 13 }); await flush();
        await advance(999);
        assert.strictEqual(awards.length, 2, 'new target still requires travel');
        await advance(1);
        assert.deepStrictEqual(awards[2], [13, 1200], 'switching starts from current position and stops 20 units short');
        assert.strictEqual(actor.x, -80);
        assert.deepStrictEqual(packets.slice(-3), [0x25, 0x47, 0x0d], 'approaching loot must release client action at arrival');
        await advance(3000);
        assert.strictEqual(awards.length, 3, 'cancelled approach must never award its old target');

        // Superseding a request before its asynchronous world lookup resolves.
        item(14, -80); item(15, -80);
        Generics.pickupRequest(session, actor, { id: 14 });
        Generics.pickupRequest(session, actor, { id: 15 }); await flush();
        assert.strictEqual(awards.at(-1)[0], 15);
        assert(!awards.some(([id]) => id === 14));

        actor.state.setWalkin(true); item(16, 40);
        Generics.pickupRequest(session, actor, { id: 16 }); await flush();
        await advance(1999); assert.notStrictEqual(awards.at(-1)[0], 16);
        await advance(1); assert.strictEqual(awards.at(-1)[0], 16, 'walking uses walking speed');

        // Burst awards must retain every stack, including an initially absent item.
        replace(Response, 'userInfo', () => Buffer.alloc(0));
        replace(Response, 'itemsList', () => Buffer.alloc(0));
        replace(Data, 'fetchItemFromSelfId', (id, cb) => cb({ selfId: id, template: { name: 'Adena' }, etc: {} }));
        for (const initial of [0, 100]) {
            let count = initial, inserts = 0;
            const writes = [];
            const owner = { fetchId: () => 2, backpack: {
                stackableExists: () => count ? Promise.resolve({ fetchId: () => 99, fetchAmount: () => count }) : Promise.reject(),
                updateAmount(_id, amount) { count = amount; },
                insertItem(_id, _selfId, data) { count = data.amount; }, fetchItems: () => []
            } };
            const recipient = { actor: owner, dataSendToMe() {} };
            replace(Database, 'updateItemAmount', (_id, _item, total) => new Promise(resolve => writes.push(() => { resolve(); })));
            replace(Database, 'setItemInstances', (_id, item) => new Promise(resolve => writes.push(() => {
                inserts++; resolve([{ insertId: 99, amount: item.amount }]);
            })));
            const pending = [Purchase(recipient, 57, 3), Purchase(recipient, 57, 7), Purchase(recipient, 57, 11)];
            for (let i = 0; i < 3; i++) {
                await flush(); assert.strictEqual(writes.length, 1, 'only one inventory write may be in flight');
                writes.shift()();
            }
            await Promise.all(pending);
            assert.strictEqual(count, initial + 21);
            assert.strictEqual(inserts, initial ? 0 : 1);
        }
        console.log('C4 pickup timing, retargeting, walking and burst inventory awards passed');
    } finally {
        actor.automation.abortAll(actor, { notifyClient: false });
        saved.reverse().forEach(restore => restore());
    }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
