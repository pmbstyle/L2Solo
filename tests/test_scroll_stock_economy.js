'use strict';
const assert = require('node:assert/strict');
const Packet = require('../src/GameServer/Bot/Economy/StatsPacket');
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
// Each case is a first build: one bot id, and a far bot's look would read the held one.
const published = input => {
    Economy.forget(input.characterId);
    const context = Economy.forState(input);
    return { context, state: { ...input, stats: { ...input.stats, ...context.statsPacket } } };
};
const units = input => Npc.collect(input, { potions: false, shots: false })
    .flatMap(basket => basket.lines).filter(line => line.selfId === 736).reduce((sum, line) => sum + line.amount, 0);
const price = Scrolls.localNpcPrice('Dion');
// A Scroll of Escape is no survival item: one per outing when the walk it saves, from
// the remembered hunt to the town, is worth more than its price at the bot's hour.
let rich = published(state());
const stock = rich.context.stock('scrolls');
assert.equal(stock.target, 1); assert.equal(stock.survivalTarget, 0); assert.equal(stock.missing, 1);
const town = Routes.landingTown(origin);
const withScroll = Trip.townPlan({ loc: origin, inventory: { 736: { amount: 1 } }, stats: {} }, town);
const withoutScroll = Trip.townPlan({ loc: origin, inventory: {}, stats: {} }, town);
assert.equal(stock.benefitHours, (withoutScroll.durationMs - withScroll.durationMs) / 3600000, 'a scroll is worth the walk it saves');
assert(invoke('GameServer/Bot/AI/PersonalGearProgression').assess(rich.state).required, 'the test bot has a kit gap');
// A scroll waits for the visit's restock and never takes the bot off its kit (T177).
assert(!String(rich.context.network.focus?.[0]).startsWith('stock:'), 'no scroll does not take the focus off the kit');
assert.equal(rich.context.network.queue.some(row => row.key === 'stock:scrolls'), false);
assert.equal(rich.state.stats.money.includes(736), false, 'side scrolls take no row in the money queue');
assert.equal(units(rich.state), 1, 'a scroll worth its walk is bought for the outing at the quoted NPC price');
assert.equal(Scrolls.restockPlan(rich.state, { unitPrice: price, context: rich.context }).amount, 1);
const nine = published(state(9));
assert.equal(nine.context.stock('scrolls').benefitHours, 0);
assert.equal(units(nine.state), 0, 'held scrolls need no more');
assert.equal(units(published(state(1)).state), 0, 'one held: none bought');
const karma = published(state(0, 1000000000, { stats: { classId: 1, karma: 10, marketReturn: { loc: origin } } }));
assert.equal(karma.context.stock('scrolls').benefitHours, 0);
assert.equal(units(karma.state), 0, 'karma cannot benefit from recalling into town');
const unknown = published(state(0, 1000000000, { stats: { classId: 1 } }));
assert.equal(unknown.context.stock('scrolls').benefitHours, 0, 'merchant location is not a future hunting origin');
assert.equal(units(unknown.state), 0, 'no walk to save: the bot walks');
const zeroOrigin = published(state(0, 1000000000, { stats: { classId: 1,
    marketReturn: { loc: { locX: 0, locY: 0, locZ: 0 } } } }));
assert.equal(zeroOrigin.context.stock('scrolls').benefitHours, 0, 'unset coordinates never create scroll utility');
const hour = Packet.hourAdena(rich.state.stats.money);
const protectedState = { ...rich.state, stats: { ...rich.state.stats,
    money: [hour, 1 / hour, 0, 0, 1, rich.state.adena - price + 1, 100] } };
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
assert.equal(Scrolls.restockPlan(rich.state, { unitPrice: price, context: remote }).amount, 1,
    'main-thread remote bot spends the same published optional-scroll funding');
const cheapHour = price / stock.benefitHours / 2;
assert.equal(units({ ...rich.state, stats: { ...rich.state.stats, money: [cheapHour, 1 / cheapHour, 0, 0] } }), 0,
    'a scroll worth less than its price at the bot\'s hour stays on the shelf');
Economy.reset();
console.log('scroll of escape: one per outing worth its walk, side money, quoted NPC basket checks passed');
process.exit(0);
