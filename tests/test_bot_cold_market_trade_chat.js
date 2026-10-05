const assert = require('assert');

require('../src/Global');

const World = invoke('GameServer/World/World');
const ColdMarketTradeChat = invoke('GameServer/Bot/Economy/ColdMarketTradeChat');

// A cold bot that found no offer for its goal shouts WTB in the trade chat
// once per interval (the bots' stall ads went with the stalls, step 3.3).
const originalUser = World.user;
const packets = [];

try {
    World.user = { sessions: [{
        accountId: 'player_1',
        socket: { write: () => {} },
        dataSendToMe: (packet) => packets.push(packet)
    }] };
    ColdMarketTradeChat.reset();
    const state = { characterId: 91, name: 'MarketWanderer', phase: 'cold', activity: 'shopping', currentRegion: 'Giran', stats: {} };
    const goal = { target: { itemId: 1864, itemName: 'Stem' } };

    const announced = ColdMarketTradeChat.maybeAnnounceWanted(state, goal, 10000000);
    assert.strictEqual(announced.announced, true);
    assert(announced.text.includes('Stem') && announced.text.includes('Giran'));
    assert.strictEqual(packets.length, 1, 'trade chat should be delivered to online real players');
    assert.strictEqual(announced.state.stats.marketWanted.lastTradeAdAt, 10000000);

    const throttled = ColdMarketTradeChat.maybeAnnounceWanted(announced.state, goal, 10000001);
    assert.strictEqual(throttled.announced, false);
    assert.strictEqual(throttled.reason, 'cooldown');
    assert.strictEqual(packets.length, 1, 'the per-bot cooldown prevents chat spam');
    assert.strictEqual(ColdMarketTradeChat.maybeAnnounceWanted({ ...state, activity: 'hunting' }, goal, 20000000).announced, false,
        'only a shopping bot shouts');
    console.log('Bot cold market trade chat checks passed');
} finally {
    World.user = originalUser;
    ColdMarketTradeChat.reset();
}
