const assert = require('assert');

require('../src/Global');

const World = invoke('GameServer/World/World');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const ColdMarketTradeChat = invoke('GameServer/Bot/Economy/ColdMarketTradeChat');

const originalUser = World.user;
const originalUpsert = LifeState.upsertState;
const packets = [];

async function run() {
    World.user = { sessions: [{
        accountId: 'player_1',
        socket: { write: () => {} },
        dataSendToMe: (packet) => packets.push(packet)
    }] };
    LifeState.upsertState = (state) => Promise.resolve(state);
    ColdMarketTradeChat.reset();

    const state = {
        characterId: 91,
        name: 'MarketWanderer',
        phase: 'cold',
        activity: 'merchant',
        stats: {
            marketStore: {
                town: 'Giran',
                expiresAt: 100000,
                items: [
                    { selfId: 1864, name: 'Stem', count: 10, price: 75 },
                    { selfId: 1, name: 'Short Sword', count: 1, price: 600 }
                ]
            }
        }
    };

    const announced = await ColdMarketTradeChat.maybeAnnounce(state, 1000);
    assert.strictEqual(announced.announced, true);
    assert(announced.text.includes('Stem') && announced.text.includes('Giran'));
    assert.strictEqual(packets.length, 1, 'trade chat should be delivered to online real players');
    assert.strictEqual(announced.state.stats.marketStore.lastTradeAdAt, 1000);

    const throttled = await ColdMarketTradeChat.maybeAnnounce(announced.state, 1001);
    assert.strictEqual(throttled.announced, false);
    assert.strictEqual(throttled.reason, 'cooldown');
    assert.strictEqual(packets.length, 1, 'per-store cooldown must prevent chat spam');
    console.log('Bot cold market trade chat checks passed');
}

run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
}).finally(() => {
    World.user = originalUser;
    LifeState.upsertState = originalUpsert;
    ColdMarketTradeChat.reset();
});
