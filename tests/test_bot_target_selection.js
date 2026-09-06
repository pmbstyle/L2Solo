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
        console.log('Bot target selection tests passed.');
    } finally {
        saved.reverse().forEach(restore => restore());
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
