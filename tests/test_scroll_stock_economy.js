'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Scrolls = invoke('GameServer/Bot/Travel/ScrollStock');
const Npc = invoke('GameServer/Bot/Economy/NpcRestockPlan');
const Trip = invoke('GameServer/Bot/Population/ColdTrip');
const Routes = invoke('GameServer/Bot/Travel/TravelRoutes');
const Funding = invoke('GameServer/Bot/Economy/PurchaseFunding');
// The town location is deliberately different from the remembered hunt.
const origin = { locX: 12000, locY: 90000, locZ: -3000 };
const state = (amount = 0, adena = 1000000000, extra = {}) => ({ characterId: 9500170, level: 30,
    phase: 'cold', activity: 'shopping', currentRegion: 'Dion', adena,
    loc: Routes.landingTown(origin), inventory: { 736: { selfId: 736, amount } },
    stats: { classId: 1, marketReturn: { loc: origin } }, ...extra });
Economy.configure({ spots: [], knowledgeEnabled: false });
const published = input => {
    const context = Economy.forState(input);
    return { context, state: { ...input, stats: { ...input.stats, ...context.statsPacket } } };
};
const units = input => Npc.collect(input, { potions: false, shots: false })
    .flatMap(basket => basket.lines).filter(line => line.selfId === 736).reduce((sum, line) => sum + line.amount, 0);
const price = Scrolls.localNpcPrice('Dion');
let rich = published(state());
const stock = rich.context.stock('scrolls');
assert.equal(stock.target, 10); assert.equal(stock.survivalTarget, 1); assert.equal(stock.missing, 9);
const town = Routes.landingTown(origin);
const withScroll = Trip.townPlan({ loc: origin, inventory: { 736: { amount: 1 } }, stats: {} }, town);
const withoutScroll = Trip.townPlan({ loc: origin, inventory: {}, stats: {} }, town);
assert.equal(stock.benefitHours, 9 * (withoutScroll.durationMs - withScroll.durationMs) / 3600000);
assert.equal(rich.context.network.queue.find(row => row.key === 'stock:scrolls').object.amount, 9);
assert(rich.state.stats.money.includes(736), 'extra scrolls enter the existing money queue');
assert.equal(units(rich.state), 10, 'a useful funded stock buys all ten at the quoted NPC price');
assert.equal(Scrolls.restockPlan(rich.state, { unitPrice: price, context: rich.context }).amount, 10);
assert.equal(units(published(state(0, price)).state), 1, 'poor bot retains exactly one mandatory escape');
const nine = published(state(9));
assert.equal(nine.context.stock('scrolls').benefitHours, stock.benefitHours / 9);
assert.equal(units(nine.state), 1, 'nine held useful scrolls need one more');
assert.equal(units(published(state(10)).state), 0);
const karma = published(state(0, 1000000000, { stats: { classId: 1, karma: 10, marketReturn: { loc: origin } } }));
assert.equal(karma.context.stock('scrolls').benefitHours, 0);
assert.equal(units(karma.state), 0, 'karma cannot benefit from recalling into town');
const unknown = published(state(0, 1000000000, { stats: { classId: 1 } }));
assert.equal(unknown.context.stock('scrolls').benefitHours, 0, 'merchant location is not a future hunting origin');
assert.equal(units(unknown.state), 1);
const zeroOrigin = published(state(0, 1000000000, { stats: { classId: 1,
    marketReturn: { loc: { locX: 0, locY: 0, locZ: 0 } } } }));
assert.equal(zeroOrigin.context.stock('scrolls').benefitHours, 0, 'unset coordinates never create scroll utility');
const protectedState = { ...nine.state, stats: { ...nine.state.stats,
    money: [100000, 0.00001, 0, 0, 1, nine.state.adena - price + 1, 100, 0.000284, nine.state.adena, 736] } };
assert.equal(units(protectedState), 0, 'stronger funded wish keeps its cash');
assert(Funding.spendable(protectedState, 0, { itemId: 736 }) < price);
const hot = published({ ...state(), phase: 'hot' });
assert.equal(Scrolls.restockPlan(hot.state, { unitPrice: price, context: hot.context }).amount,
    Scrolls.restockPlan(rich.state, { unitPrice: price, context: rich.context }).amount, 'same native funding for hot and cold');
const Decisions = invoke('GameServer/Bot/Population/ColdEconomyDecision');
const captured = Decisions.capture(rich.context, rich.state);
const remote = Decisions.view(rich.state, captured, { knowledgeEnabled: false });
assert(Math.abs(remote.itemUsefulness(736) - rich.context.itemUsefulness(736)) < 1e-6,
    'existing worker packet preserves scroll usefulness without a new protocol kind');
assert.equal(Scrolls.restockPlan(rich.state, { unitPrice: price, context: remote }).amount, 10,
    'main-thread remote bot spends the same published optional-scroll funding');
Economy.reset();
console.log('scroll stock → optional wish → one money queue → quoted NPC basket checks passed');
process.exit(0);
