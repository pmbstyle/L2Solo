const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const MarketTownPolicy = invoke('GameServer/Bot/Economy/MarketTownPolicy');

DataCache.init();

const SHORT_GLOVES = { selfId: 48 }; // no-grade
const itemOfRank = (rank) => DataCache.items.find((item) => String(item.etc?.rank || '').toLowerCase() === rank
    && /^(Weapon|Armor)\./.test(item.template?.kind || ''));
const dItem = { selfId: itemOfRank('d').selfId };
const cItem = { selfId: itemOfRank('c').selfId };
const nearDarkElven = { locX: 14000, locY: 18000, locZ: -3000 };
const nearElven = { locX: 45000, locY: 48000, locZ: -3000 };
const nearTalkingIsland = { locX: -83000, locY: 243000, locZ: -3000 };

const originalSpots = SpotService.spots;
SpotService.spots = [
    { id: 'test_elven_spot', center: { ...nearElven } },
    { id: 'test_dark_elven_spot', center: { ...nearDarkElven } }
];
const bot = (loc, spotId = null, stats = {}) => ({ characterId: 1001, loc, spotId, stats: { generatedCold: true, ...stats } });
const town = (state, items = [SHORT_GLOVES]) => MarketTownPolicy.targetTownForItems(state, items);

try {
    // No-grade stock goes to the village nearest the centre of the bot's
    // hunting spot, not its current position: a hunting bot wanders across
    // village areas, and following it moved a listed shop on every review.
    assert.strictEqual(town(bot(nearDarkElven, 'test_elven_spot')), 'Elven Village');
    for (const loc of [nearElven, nearTalkingIsland]) {
        assert.strictEqual(town(bot(loc, 'test_elven_spot')), 'Elven Village',
            'moving without changing the hunting spot keeps the same village');
    }
    assert.strictEqual(town(bot(nearElven, 'test_dark_elven_spot')), 'Dark Elven Village',
        'changing the hunting spot moves the shop');

    // A bot listed at the market keeps the spot it left, like its location.
    const listed = bot(nearTalkingIsland, null, { marketReturn: { loc: nearDarkElven, spotId: 'test_elven_spot' } });
    assert.strictEqual(town(listed), 'Elven Village');

    // Without a known spot the author's origin applies: the saved departure
    // point of a listed bot, otherwise its location.
    assert.strictEqual(town(bot(nearDarkElven)), 'Dark Elven Village');
    assert.strictEqual(town(bot(nearDarkElven, 'unknown_spot')), 'Dark Elven Village');
    assert.strictEqual(town(bot(nearTalkingIsland, null, { marketReturn: { loc: nearDarkElven } })), 'Dark Elven Village');

    // The spot lookup follows a replaced spot list.
    assert.strictEqual(SpotService.findById('test_elven_spot')?.center.locX, nearElven.locX);
    SpotService.spots = [{ id: 'test_elven_spot', center: { ...nearTalkingIsland } }];
    assert.strictEqual(town(bot(nearElven, 'test_elven_spot')), 'Talking Island');
    assert.strictEqual(SpotService.findById('test_dark_elven_spot'), null);
    SpotService.spots = [
        { id: 'test_elven_spot', center: { ...nearElven } },
        { id: 'test_dark_elven_spot', center: { ...nearDarkElven } }
    ];

    // Graded stock is unchanged: D follows the stable Gludio/Dion split, C+ Giran.
    const graded = bot(nearDarkElven, 'test_elven_spot');
    assert.strictEqual(town(graded, [dItem]), MarketTownPolicy.dGradeMarketFor(graded));
    assert.strictEqual(town(graded, [cItem]), 'Giran');
} finally {
    SpotService.spots = originalSpots;
}

console.log('Bot market hunting spot town checks passed');
