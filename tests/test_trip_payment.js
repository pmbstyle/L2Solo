const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('../src/Global');
// Load native data before the first economic route or combat profile check.
invoke('GameServer/DataCache').init();

// A bot's town trip is paid as a player pays it (N2, user 2026-10-04): one
// Scroll of Escape from outside the town (without one it walks to the town),
// the gatekeeper fee into another town; a trip to a spot is free. One rule for
// cold bots (ColdTrip, stored inventory) and hot bots (BotTownTravel, backpack).
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const World = invoke('GameServer/World/World');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const ColdTrip = invoke('GameServer/Bot/Population/ColdTrip');
const GoalExecutor = invoke('GameServer/Bot/Goals/GoalExecutor');
const BotTownTravel = invoke('GameServer/Bot/AI/BotTownTravel');
const TownRespawn = invoke('GameServer/World/TownRespawn');
const databasePath = path.join(process.cwd(), 'tmp', 'test-trip-payment.sqlite');

const T = 1_750_000_000_000;
const DION_FIELD = { locX: 22000, locY: 140000, locZ: -3000 };
const DION = TownRespawn.towns.dion_town;
const GIRAN_CENTER = { locX: 83396, locY: 147904, locZ: -3404 };

function clean() {
    const history = databasePath.replace(/\.sqlite$/, '.history.sqlite');
    for (const file of [databasePath, history]) {
        for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
    }
}

function cold({ scrolls = 2, adena = 50000, loc = DION_FIELD } = {}) {
    return {
        characterId: 77, name: 'Payer', phase: 'cold', level: 30, adena, activity: 'hunting',
        currentRegion: 'Dion fields', spotId: 'field', loc: { ...loc }, timing: {},
        inventory: {
            57: { selfId: 57, name: 'Adena', amount: adena },
            ...(scrolls ? { 736: { selfId: 736, name: 'Scroll of Escape', amount: scrolls } } : {})
        },
        stats: {}
    };
}

const toGiran = (state) => ColdTrip.toTown(state, { to: { ...GIRAN_CENTER }, townName: 'Giran', arrivalActivity: 'shopping' }, T);

// With a scroll from a field: the scroll and the Dion-Giran fee, the author's 25 s.
const paid = toGiran(cold());
assert.strictEqual(paid.stats.travel.method, 'soe_gatekeeper');
assert.strictEqual(paid.inventory[736].amount, 1, 'one Scroll of Escape is read');
assert.strictEqual(paid.adena, 50000 - 8100, 'the Dion to Giran gatekeeper fee is paid');
assert.strictEqual(paid.inventory[57].amount, 50000 - 8100, 'the stored Adena row follows');
assert.deepStrictEqual(paid.stats.travel.paid, { scroll: 736, fee: 8100 });
assert.strictEqual(paid.stats.travel.arrivalAt - T, ColdTrip.AUTHOR_TRIP_MS, 'switch off: the author\'s 25 s transit');

// Without a scroll the bot walks to Dion and pays the fee; it pays in time.
const walked = toGiran(cold({ scrolls: 0 }));
assert.strictEqual(walked.stats.travel.method, 'walk_gatekeeper');
assert.strictEqual(walked.adena, 50000 - 8100);
assert.deepStrictEqual(walked.stats.travel.paid, { fee: 8100 });
assert.strictEqual(walked.stats.travel.arrivalAt - T, ColdTrip.authorWalkMs(DION_FIELD, DION),
    'the walk to the town takes the author\'s walking time');
assert.ok(walked.stats.travel.arrivalAt - T > ColdTrip.AUTHOR_TRIP_MS, 'walking costs more time than the scroll');

// In Dion already: no scroll, only the fee.
const local = toGiran(cold({ loc: { locX: DION.locX + 300, locY: DION.locY, locZ: DION.locZ } }));
assert.strictEqual(local.inventory[736].amount, 2, 'a bot in town walks to the gatekeeper: no scroll');
assert.deepStrictEqual(local.stats.travel.paid, { fee: 8100 });

// Into the town the scroll reaches: the scroll only.
const dionShop = ColdTrip.toTown(cold(), { to: { locX: DION.locX, locY: DION.locY, locZ: DION.locZ }, arrivalActivity: 'shopping' }, T);
assert.deepStrictEqual(dionShop.stats.travel.paid, { scroll: 736, fee: 0 });
assert.strictEqual(dionShop.adena, 50000);

// A bot that cannot pay the fee does not leave.
assert.strictEqual(toGiran(cold({ adena: 8000 })), null, 'no trip without the fee');
const buyGoal = { type: 'upgrade_gear', plan: { expectedBenefit: 'market_search_for_weapon', marketTown: 'Giran' } };
assert.strictEqual(GoalExecutor.beginMarketTravel(cold({ adena: 8000 }), buyGoal, T), null, 'a buyer short of the fee stays');
// A seller short of the fee sells in the town its scroll reaches.
const sellGoal = { type: 'sell_inventory', plan: { expectedBenefit: 'market_sale_inventory', cleanupReason: 'inventory_full' } };
const localSale = GoalExecutor.beginMarketTravel(cold({ adena: 100 }), sellGoal, T);
assert.strictEqual(localSale.stats.travel.townName, 'Dion', 'the sale moves to the landing town');
assert.deepStrictEqual(localSale.stats.travel.paid, { scroll: 736, fee: 0 });
// A trip to a spot is free.
const spotTrip = ColdTrip.toSpot(cold(), { to: { locX: 30000, locY: 140000, locZ: -3000 }, arrivalActivity: 'hunting' }, T);
assert.strictEqual(spotTrip.stats.travel.paid, undefined);
assert.strictEqual(spotTrip.adena, 50000);
assert.strictEqual(spotTrip.inventory[736].amount, 2);

// Hot bots: BotTownTravel spends a backpack scroll; without one the bot walks;
// a supply errand into another town pays the fee or is refused.
function hotBot({ scrolls, adena, loc = DION_FIELD }) {
    const items = new Map([[57, { id: 1, amount: adena }], [736, { id: 2, amount: scrolls }]]);
    const bot = {
        moved: null,
        fetchId: () => 900, fetchName: () => 'HotPayer', fetchKarma: () => 0,
        fetchLocX: () => loc.locX, fetchLocY: () => loc.locY, fetchLocZ: () => loc.locZ,
        isDead: () => false,
        state: { setCasts() {}, fetchCasts: () => false, fetchHits: () => false },
        moveTo(move) { bot.moved = move; },
        backpack: {
            fetchItemFromSelfId(selfId) {
                const item = items.get(Number(selfId));
                return item && item.amount > 0 ? { fetchId: () => item.id, fetchAmount: () => item.amount } : null;
            },
            deleteItem(_session, id, amount) {
                for (const item of items.values()) if (item.id === id) item.amount -= amount;
            }
        }
    };
    return { bot, items, session: { dataSendToMeAndOthers() {}, dataSendToMe() {} } };
}
const BotAIStub = {
    getClosestTown(x, y, z) {
        const town = TownRespawn.getClosestTown(x, y, z);
        return { name: town.name, x: town.locX, y: town.locY, z: town.locZ };
    }
};
const realTimeout = global.setTimeout;
global.setTimeout = () => 0; // the 20 s recall cast is not run here
try {
    const scrolled = hotBot({ scrolls: 2, adena: 100 });
    assert.strictEqual(BotTownTravel.request(scrolled.session, scrolled.bot, BotAIStub, 'test', { announce: false }), 'escape');
    assert.strictEqual(scrolled.items.get(736).amount, 1, 'a hot bot reads one of its scrolls');
    assert.strictEqual(scrolled.items.get(57).amount, 100, 'the nearest town costs no fee');

    const walker = hotBot({ scrolls: 0, adena: 100 });
    assert.strictEqual(BotTownTravel.request(walker.session, walker.bot, BotAIStub, 'test', { announce: false }), 'walk',
        'without a scroll a hot bot walks to town');
    assert.ok(walker.bot.moved, 'the walk is issued');

    const giran = { name: 'Giran', x: GIRAN_CENTER.locX, y: GIRAN_CENTER.locY, z: GIRAN_CENTER.locZ };
    const poor = hotBot({ scrolls: 2, adena: 100 });
    assert.strictEqual(BotTownTravel.request(poor.session, poor.bot, BotAIStub, null,
        { announce: false, destinationTown: giran, forceScrollOfEscape: true }), 'unpaid', 'a supply run short of the fee is refused');
    assert.strictEqual(poor.items.get(736).amount, 2, 'nothing is taken from a refused trip');
    assert.strictEqual(poor.session.plan, undefined, 'a refused trip leaves the session as it was');

    const rich = hotBot({ scrolls: 2, adena: 10000 });
    assert.strictEqual(BotTownTravel.request(rich.session, rich.bot, BotAIStub, null,
        { announce: false, destinationTown: giran, forceScrollOfEscape: true }), 'escape');
    assert.strictEqual(rich.items.get(736).amount, 1);
    assert.strictEqual(rich.items.get(57).amount, 10000 - 8100, 'the supply run pays the Dion to Giran fee');
} finally {
    global.setTimeout = realTimeout;
}

// The stored items follow the stored summary when the paid trip is written.
async function physical(characterId, selfId) {
    return (await Database.fetchItems(characterId)).filter((row) => Number(row.selfId) === selfId)
        .reduce((sum, row) => sum + Number(row.amount), 0);
}

(async () => {
    clean();
    options.default.Database.path = path.relative(process.cwd(), databasePath);
    Database.init();
    DataCache.init();
    World.user = { sessions: [], revision: 0 };
    await LifeState.init();
    await Database.createAccount('bot_payer', 'pw');
    const id = Number((await Database.createCharacter('bot_payer', {
        name: 'TripPayer', race: 0, classId: 0, maxHp: 100, maxMp: 100, sex: 0, face: 0, hair: 0, hairColor: 0, ...DION_FIELD
    })).insertId);
    await Database.setItem(id, { selfId: 736, name: 'Scroll of Escape', amount: 3, enchant: 0, equipped: false, slot: 0 });
    await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 50000, enchant: 0, equipped: false, slot: 0 });
    const seeded = await LifeState.upsertState({
        ...cold(), characterId: id, accountName: 'bot_payer', name: 'TripPayer', adena: 50000,
        inventory: LifeState.inventorySummaryFromItems(await Database.fetchItems(id)),
        vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }
    }, 'test_seed');
    const trip = toGiran(seeded);
    await LifeState.upsertState(trip, 'test_trip');
    assert.strictEqual(await physical(id, 736), 2, 'the scroll leaves the items table with the trip');
    assert.strictEqual(await physical(id, 57), 50000 - 8100, 'the fee leaves the items table with the trip');
    // Writing the same trip again pays nothing twice.
    await LifeState.upsertState({ ...LifeState.cachedState(id), timing: { ...trip.timing } }, 'test_trip_again');
    assert.strictEqual(await physical(id, 736), 2);
    assert.strictEqual(await physical(id, 57), 50000 - 8100);
    await Database.close();
    clean();
    console.log('trip payment checks passed');
    process.exit(0);
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
