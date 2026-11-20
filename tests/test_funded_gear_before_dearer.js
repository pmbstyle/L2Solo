'use strict';
// Within one progression priority a weapon the wallet pays now comes before a
// dearer, stronger one the bot would have to wait for: a C archer with 3.5M
// sees an Akat Long Bow at 4.3M and an Elemental Bow at 3.2M and buys the
// Elemental Bow. When the wallet covers both, the stronger bow wins.
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('funded-gear-before-dearer');
require('../src/Global');
fixture.assertConfigured(options.default);
const Data = invoke('GameServer/DataCache'); Data.init();
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Market = invoke('GameServer/Bot/Economy/MarketOpportunity');
const PopulationConfig = invoke('GameServer/Bot/Population/PopulationConfig'), storeWasOff = PopulationConfig.staticShotsDisabled;
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const timestamp = 1791801314861;
const AKAT = 283, ELEMENTAL = 282, D_BOW = 279;
let actorSequence = 0;
function archer(adena) {
    const inventory = {};
    // A level 45 archer in a worn D kit with a D long bow: the C weapon is next.
    for (const [selfId, slot] of [[848, 1], [847, 2], [910, 3], [879, 4], [879, 5],
        [45, 6], [606, 9], [391, 10], [415, 11], [1123, 12], [D_BOW, 14]]) {
        const row = inventory[selfId] || { selfId, amount: 0, equippedCount: 0, equippedSlots: [] };
        inventory[selfId] = { ...row, amount: row.amount + 1, equipped: true,
            equippedCount: row.equippedCount + 1, equippedSlots: [...row.equippedSlots, slot], slot };
    }
    for (const selfId of [1835, 1463, 1464, 1341, 1342, 1343, 1061, 736])
        inventory[selfId] = { selfId, amount: 1000 };
    return { characterId: 991987 + ++actorSequence, name: `FundedGear${actorSequence}`,
        accountName: `bot_funded_gear_${actorSequence}`, level: 45, adena, phase: 'cold', activity: 'hunting',
        currentRegion: 'Giran', loc: { locX: 83396, locY: 147904, locZ: -3404 }, timing: {},
        vitals: { hp: 1200, maxHp: 1200, mp: 1000, maxMp: 1000 }, inventory,
        stats: { classId: 9, role: 'archer', exp: Data.experience[44] + 1, generatedCold: true, decisionSeq: 1,
            persona: { primaryDrive: 'progression', understanding: 1,
                traits: { caution: .5, commitment: 0, ambition: 0, resilience: .5,
                    assertiveness: .5, empathy: .5, sociability: .5 } } } };
}
const board = new BoardIndex();
const trip = town => town === 'Giran' ? 0 : Infinity;
trip.details = town => ({ known: town === 'Giran', hours: 0, fees: 0 });
const deps = { board, spots: [], timestamp, knowledgeEnabled: false, tripCost: trip,
    npcOffersFor: id => Market.npcOffers(id, 'Giran') };
try {
    PopulationConfig.staticShotsDisabled = true;
    // Every C bow is listed, so the bot's price beliefs read the board and the
    // two bows of the case are the weapon finalists; the Eminence Bow is out of reach.
    board.put({ id: 881, ownerId: 991881, storeType: 1, kind: 'shop', town: 'Giran',
        lines: [{ lineId: 881, selfId: AKAT, count: 1, price: 4300000, enchant: 0 },
            { lineId: 882, selfId: ELEMENTAL, count: 1, price: 3200000, enchant: 0 },
            { lineId: 883, selfId: 286, count: 1, price: 9000000, enchant: 0 },
            { lineId: 884, selfId: 285, count: 1, price: 2900000, enchant: 0 },
            { lineId: 885, selfId: 281, count: 1, price: 2500000, enchant: 0 }] });
    const chosen = context => {
        const wish = context.network.queue.find(row => row.key === context.network.activity?.rootKey);
        assert.equal(wish?.object?.slot, 14, 'the chosen step serves the C weapon priority');
        assert.equal(wish.progressionPriority ?? 3, 3);
        return context.network.activity;
    };
    const short = chosen(Economy.forState(archer(3500000), deps));
    assert.equal(short.activity, 'shopping');
    assert.equal(short.itemId, ELEMENTAL, 'with 3.5M the bot buys the 3.2M bow now instead of waiting for the 4.3M one');
    const rich = chosen(Economy.forState(archer(5000000), deps));
    assert.equal(rich.activity, 'shopping');
    assert.equal(rich.itemId, AKAT, 'when the wallet covers both the stronger bow wins');
    console.log('PASS a funded weapon precedes a dearer one in one priority; the stronger wins when both are funded');
} finally {
    PopulationConfig.staticShotsDisabled = storeWasOff;
    Economy.reset();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
}
