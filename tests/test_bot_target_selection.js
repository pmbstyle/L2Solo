const assert = require('assert');
require('../src/Global');

const Select = invoke('GameServer/Actor/Generics/Select');
const World = invoke('GameServer/World/World');
const Generics = invoke('GameServer/Actor/Generics');
const BotManager = invoke('GameServer/Bot/BotManager');
const BotAI = invoke('GameServer/Bot/BotAI');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const Response = invoke('GameServer/Network/Response');
const Attack = invoke('GameServer/Actor/Attack');

async function main() {
    const saved = [];
    const replace = (object, key, value) => {
        saved.push(() => { object[key] = value; });
        object[key] = value;
    };
    const flush = () => new Promise(resolve => setImmediate(resolve));
    try {
        replace(AfkTrade, 'findProjection', () => null);
        replace(BotAI, 'promoteForPlayerInteraction', () => false);
        replace(Response, 'destSelected', () => Buffer.alloc(0));
        replace(Response, 'relationChanged', () => Buffer.alloc(0));
        const attacks = [];
        replace(Generics, 'attackExec', (_s, _a, data) => attacks.push(data));
        replace(Generics, 'stopAutomation', () => {});
        const target = { fetchId: () => 1100, fetchLevel: () => 28, setLocZ() {} };
        for (const kind of ['npc', 'bot', 'player']) {
            replace(BotManager, 'sessions', kind === 'bot' ? [{ actor: target }] : []);
            replace(World, 'fetchNpc', () => kind === 'npc' ? Promise.resolve(target) : Promise.reject());
            replace(World, 'fetchItem', () => Promise.reject());
            replace(World, 'fetchUser', () => Promise.resolve(target));
            for (const casting of [false, true]) {
                let selected = 0;
                const actor = {
                    fetchId: () => 2200, fetchDestId: () => selected,
                    setDestId: id => { selected = id; }, fetchLevel: () => 28,
                    fetchLocZ: () => 0, statusUpdateVitals() {},
                    isDead: () => false, isBlocked: () => casting,
                    state: { fetchHits: () => false, fetchCasts: () => casting, fetchTowards: () => false },
                    attack: new Attack()
                };
                const session = { actor, accountId: 'bot_selection_test', dataSendToMe() {} };
                const before = attacks.length;
                // Two pending lookups, followed by an ordinary AI target refresh.
                Select(session, actor, { id: 1100 });
                Select(session, actor, { id: 1100 });
                await flush();
                Select(session, actor, { id: 1100 });
                await flush();
                assert.strictEqual(selected, 1100, `${kind}: the AI still selects its target`);
                assert.strictEqual(attacks.length, before, `${kind}: selection cannot start a weapon attack`);
                assert.strictEqual(actor.attack.queue.name, undefined,
                    `${kind}: repeated selection during a spell cannot queue a weapon attack`);

                session.accountId = 'player_selection_test';
                Select(session, actor, { id: 1100 });
                await flush();
                if (casting) assert.strictEqual(actor.attack.queue.name, 'attack', `${kind}: player double-click still queues an attack`);
                else assert.strictEqual(attacks.length, before + 1, `${kind}: player double-click still attacks`);
            }
        }
        const inventoryItem = {
            fetchId: () => 3300, fetchSelfId: () => 17, fetchAmount: () => 10,
            fetchEquipped: () => false, fetchPrice: () => 2,
            fetchClass2: () => 0, isWearable: () => false
        };
        for (const kind of ['merchant', 'bot', 'player', 'afk']) {
            const store = { storeType: 3, title: 'WTB', items: [{ selfId: 17, count: 5, price: 1 }] };
            const buyer = {
                fetchId: () => 1100, fetchName: () => 'Buyer',
                fetchPrivateStoreType: () => 3, fetchPrivateStore: () => store
            };
            replace(BotManager, 'sessions', ['merchant', 'bot'].includes(kind)
                ? [{ actor: buyer, plan: kind === 'merchant' ? 'merchant' : 'fighter' }] : []);
            replace(AfkTrade, 'findProjection', () => kind === 'afk' ? { actor: buyer } : null);
            replace(World, 'fetchNpc', () => Promise.reject());
            replace(World, 'fetchItem', () => Promise.reject());
            replace(World, 'fetchUser', () => Promise.resolve(buyer));
            let selected = 0;
            const customer = {
                fetchId: () => 2200, fetchDestId: () => selected,
                setDestId: id => { selected = id; },
                backpack: { fetchItems: () => [inventoryItem], fetchTotalAdena: () => 100 }
            };
            const packets = [];
            const session = { actor: customer, accountId: 'player_store_test', dataSendToMe: p => packets.push(p) };
            Select(session, customer, { id: 1100 });
            await flush();
            assert(!packets.some(p => p[0] === 0xb8), `${kind}: first click only selects the buyer`);
            Select(session, customer, { id: 1100 });
            await flush();
            assert.deepStrictEqual(packets.slice(-2).map(p => p[0]), [0x25, 0xb8],
                `${kind}: finish the interaction before opening WTB so the C4 client can move`);
            assert.strictEqual(selected, 1100, `${kind}: opening WTB preserves the target`);
            assert.strictEqual(packets.at(-1).readUInt32LE(1), 1100, `${kind}: list identifies the buyer`);
            assert.strictEqual(packets.at(-1).readUInt32LE(9), 1, `${kind}: list retains the wanted item`);
        }
        console.log('Bot target selection tests passed.');
    } finally {
        saved.reverse().forEach(restore => restore());
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
