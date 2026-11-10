'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
process.env.L2NODE_CONFIG_FILE = 'config/default.ini';
require('../src/Global');
invoke('GameServer/DataCache').init();
const Shots = invoke('GameServer/Inventory/ShotStock');
const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const Table = invoke('GameServer/Bot/AI/SpotValueTable');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Prices = invoke('GameServer/Bot/Economy/StaticMerchantPricing');
const Belief = invoke('GameServer/Bot/Economy/PriceBelief');
const Rest = invoke('GameServer/Bot/AI/RestPotion');
const SpotEconomics = invoke('GameServer/Bot/Economy/SpotEconomics');
const IncomeRoute = invoke('GameServer/Bot/Economy/EquipmentIncomeRoute');
const HuntCycle = invoke('GameServer/Bot/AI/HuntCycle');
const PartyIncome = invoke('GameServer/Bot/Population/PartyIncomeComparison');
const PartyGoals = invoke('GameServer/Bot/Population/PartyGoalPolicy');
const Match = invoke('GameServer/Bot/AI/BotTargetMatchup');
const Rewards = require('../src/GameServer/Bot/Economy/SpotRewardExpectation');
const saved = { value: Table.value, best: Table.best, ranked: Table.rankedIncome, ids: Table.rankedSpotIds,
    cycle: Table.cycle, price: Prices.botBuyPrice, prior: Belief.prior, rest: Rest.stockUse,
    profiles: Match.stateProfiles, matchup: Match.spotMatchup, reward: Rewards.value, hunt: Hunt.huntIncome };
const spot = { id: 'forecast', avgLevel: 40, minLevel: 40, maxLevel: 40, density: 30,
    center: { locX: 0, locY: 0, locZ: 0 }, npcEntries: [], tagsAuthoritative: true, tags: [] };
const deps = { spots: [], timestamp: 1800000000000, board: { first: () => null },
    persona: { traits: {}, understanding: 1 }, npcOffersFor: () => [] };
const row = shots => ({ exp: shots === 2 ? 2000 : shots ? 1600 : 1000,
    shots: shots === 2 ? 60 : shots ? 120 : 0, adena: shots === 2 ? 6000 : shots ? 4000 : 2000,
    loot: 0, kills: shots === 2 ? 20 : shots ? 10 : 5, deaths: 0, potions: 0, production: 1000 });
const price = id => Number(id) === 3948 ? 7 : 3;
let rankedMode, cycleMode, restMode;
try {
    Table.value = (id, role, level, shots) => row(shots);
    Table.best = (role, level, shots) => ({ ...row(shots), spotId: spot.id });
    Table.rankedIncome = (role, level, costs, gap, shots) => [{ ...row(shots), spotId: spot.id, useShots: shots }];
    Table.rankedSpotIds = (role, level, costs, gap, shots) => { rankedMode = shots; return [spot.id]; };
    Table.cycle = (id, role, level, shots) => { cycleMode = shots; return null; };
    Prices.botBuyPrice = price;
    Belief.prior = id => ({ mu: Math.log(price(id)), K: 1 });
    Rest.stockUse = () => { restMode = cycleMode; return { use: 0, hours: 0 }; };
    const make = (itemId, classId = 12) => ({ characterId: 910950 + itemId, accountName: 'bot_forecast',
        level: 40, phase: 'cold', activity: 'hunting', spotId: spot.id, adena: 100000,
        loc: { ...spot.center }, stats: { classId }, timing: {}, inventory: {
            178: { selfId: 178, amount: 1, equipped: true, slot: 14 },
            [itemId]: { selfId: itemId, amount: 30 }
        } });
    for (const [id, classId, mode, units, net] of [[3948, 12, 2, 60, 5580], [2510, 12, true, 120, 3640],
        [1463, 0, true, 120, 3640]]) {
        const state = make(id, classId);
        const base = Economy.basics(state, deps), stock = base.stock('shots');
        assert.equal(base.bestTable.shots, units, 'stock reads the row of the selected shot variant');
        assert.equal(stock.itemId, id);
        assert.equal(stock.usePerHour, units);
        assert.equal(stock.target, units * 2, 'purchase target uses the same consumption forecast');
        assert.equal(base.hourAdena, net, 'the money forecast subtracts this variant at its own price');
        assert.equal(restMode, mode, 'rest potions use the same charged cycle');
        const hunt = Hunt.huntIncome(state, deps.timestamp);
        assert.equal(hunt.perHour, net);
        assert.equal(hunt.useShots, mode, 'the hunt retains the blessed table key');
        assert.equal(Hunt.huntHour({ perHour: 0 }, state), net, 'the fallback hour uses the same variant');
        assert.equal(Hunt.huntIncome({ ...state, spotId: null }, deps.timestamp).perHour, net,
            'ranked fallback uses the same variant without a current spot');
        assert.equal(Shots.usePolicy(state, { unitPrice: price(id), timestamp: deps.timestamp }).purchaseUsePerHour, units);
        const evaluate = SpotEconomics.create(state, { hunt, deathHours: 0, persona: deps.persona, spotHunters: () => 1 });
        assert.equal(evaluate(spot).shotUnits, units, 'the spot model uses this variant by default');
        assert.equal(evaluate(spot, true).shotUnits, units, 'an enabled route retains the actual shot variant');
        assert.equal(evaluate(spot).costs, units * price(id));
        assert.equal(evaluate(spot, false).shotUnits, 0, 'explicitly uncharged routes remain uncharged');
        IncomeRoute.spotList(state).ids(true);
        assert.equal(rankedMode, mode, 'route shortlists rank the selected shot variant');
        cycleMode = undefined;
        HuntCycle.reader(state, { hunt });
        assert.equal(cycleMode, mode, 'gear valuation reads the selected charged cycle');
    }
    const blessed = make(3948), fighter = { ...make(1463, 0), characterId: 910999 };
    const dryHunt = { perHour: 0, expPerHour: 1000, spotId: spot.id, useShots: false };
    const dryValue = SpotEconomics.create(blessed, { hunt: dryHunt, deathHours: 0,
        persona: deps.persona, spotHunters: () => 1 });
    assert.equal(dryValue.moneyHour, 2000, 'an uncharged fallback hour cannot use blessed income');
    assert.equal(dryValue(spot).shotUnits, 0);
    const currentValue = Table.value;
    Table.value = () => null;
    assert.equal(Economy.basics(blessed, deps).bestTable.shots, 60,
        'a missing current spot row falls back to the blessed best row');
    Table.value = currentValue;
    Match.stateProfiles = () => [];
    Match.spotMatchup = () => ({ eligible: true });
    Rewards.value = () => null;
    const prepared = PartyIncome.prepare([blessed, fighter], { spots: [spot], timestamp: deps.timestamp });
    assert.equal(prepared.rows.get(blessed.characterId)?.income, 3627,
        'party throughput and personal shot costs both come from the blessed row');
    const ordinary = { ...blessed, inventory: { 178: blessed.inventory[178], 2510: { selfId: 2510, amount: 30 } } };
    const ordinaryForecast = PartyIncome.prepare([ordinary, fighter], { spots: [spot], timestamp: deps.timestamp });
    assert.notEqual(ordinaryForecast.rows.get(ordinary.characterId)?.income, 3627,
        'changing the shot variant changes the party forecast');
    const party = { spotId: spot.id, stats: {} }, key = PartyGoals.incomeReviewKey(party, [blessed, fighter]);
    assert.notEqual(PartyGoals.incomeReviewKey(party, [ordinary, fighter]), key,
        'a changed shot variant invalidates the held party income review');
    const spent = { ...blessed, inventory: { ...blessed.inventory, 3948: { selfId: 3948, amount: 28 } } };
    assert.equal(PartyGoals.incomeReviewKey(party, [spent, fighter]), key,
        'ordinary consumption within the same variant does not force another review');
    Hunt.huntIncome = () => ({ perHour: 2000, expPerHour: 1000, spotId: spot.id, source: 'route', useShots: false });
    const uncharged = Economy.basics(blessed, deps);
    assert.equal(uncharged.bestTable.shots, 0);
    assert.equal(uncharged.stock('shots').usePerHour, 0, 'a no-shot hunt cannot demand a blessed refill');
    assert.equal(restMode, false);
    assert.equal(invoke('Database').isReady(), false);
    console.log('PASS blessed forecast: stock, paid use, hunt income, routes, party costs and uncharged mode');
} finally {
    Table.value = saved.value; Table.best = saved.best; Table.rankedIncome = saved.ranked;
    Table.rankedSpotIds = saved.ids; Table.cycle = saved.cycle; Prices.botBuyPrice = saved.price;
    Belief.prior = saved.prior; Rest.stockUse = saved.rest; Match.stateProfiles = saved.profiles;
    Match.spotMatchup = saved.matchup; Rewards.value = saved.reward; Hunt.huntIncome = saved.hunt;
}
