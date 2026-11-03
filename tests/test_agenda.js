// T189: a review's agenda, through the build and the step's own question. Leaves are
// built by the real wish network on a real board; no plan is written by hand.
'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');
const Generation = require('../src/GameServer/Bot/Population/RecomputeGeneration');

async function run() {
    const Data = invoke('GameServer/DataCache'); Data.init();
    const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
    const Reaction = invoke('GameServer/Bot/Economy/Reaction');
    const Config = invoke('GameServer/Bot/Population/PopulationConfig');
    invoke('GameServer/Bot/Economy/PersonalWarehouseIndex').useRowSource(() => null, () => true);
    Generation.configure({ code: '1'.repeat(40), config: '2'.repeat(64) });
    const Board = invoke('GameServer/AfkTrade/BoardIndex').BoardIndex;
    const board = new Board();
    const spots = invoke('GameServer/Bot/Population/SpotProfiles').ensure();
    Economy.configure({ board: () => board, spots: () => spots });
    Config.knowledgeErrorsEnabled = false;
    Reaction.configure(true);
    const T = Date.now();
    const Trip = invoke('GameServer/Bot/Economy/EconomicTrip');
    const deps = () => ({ timestamp: T, memoryIdentity: 'fixture-memory', sourceReady: true, caller: 'step', routeRows: Trip.prepared(base), routeKey: Trip.key(base) });
    const base = { characterId: 901, phase: 'cold', activity: 'shopping', level: 35, adena: 5000000,
        inventory: { 5285: { selfId: 5285, amount: 1, equipped: true, equippedCount: 1, slot: 14 } },
        loc: { locX: 83396, locY: 147904, locZ: -3400 }, currentRegion: 'Giran',
        stats: { classId: 1, exp: Data.experience[34], persona: { traits: { commitment: .5, caution: .5,
            resilience: .5, ambition: .5, empathy: .5, sociability: .5, assertiveness: .5 }, understanding: .8 } },
        timing: {}, vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 } };
    let line = 1;
    const sell = (selfId, count, price, town = 'Giran') => {
        const id = 1000 + line;
        board.put({ id, ownerId: 5000 + line, storeType: 1, kind: 'shop', town, revision: 1, lines: [{ lineId: 2000 + line++, selfId, count, price }] });
        return id;
    };
    const SHOTS = 1463, POTIONS = 1061;
    sell(SHOTS, 5000, 12); sell(POTIONS, 50, 120);
    // One bot's review on a visit and the state its plan was published on.
    let nextId = 9000;
    const review = (over = {}) => {
        const characterId = nextId++;
        const state = { ...base, characterId, ...over, stats: { ...base.stats, ...over.stats } };
        const plan = Economy.forState(state, deps());
        return { plan, state: { ...state, stats: { ...state.stats, ...plan.statsPacket } } };
    };
    const clear = id => { for (const row of board.list(id, 1)) board.remove(row.recordId); };
    // The review keeps the step the bot was on: shots come first, potions after them.
    const Network = invoke('GameServer/Bot/Economy/WishNetwork');
    const shotsFirst = (over = {}) => {
        const first = review(over), { plan } = first, later = plan.network.agenda.find(step => step.itemId === SHOTS);
        if (plan.network.activity?.itemId === SHOTS) return first;
        return review({ ...over, stats: { ...over.stats, decisionSeq: 5, activityLeaf: Network.leafId(later), wishFocus: plan.statsPacket.wishFocus } });
    };
    const bought = (state, leaf, units = leaf.amount) => ({ ...state, adena: state.adena - units * leaf.unitPrice, inventory: { ...state.inventory,
        [leaf.itemId]: { selfId: leaf.itemId, amount: Number(state.inventory[leaf.itemId]?.amount || 0) + units } } });

    { // A filled step takes the next one with no build, its focus and queue moving with it.
        const { plan, state } = review();
        const first = plan.network.activity;
        assert.equal(first.kind, 'buy', 'fixture: the review chose a purchase');
        assert(plan.network.agenda.length > 0, 'fixture: the review decided a second step');
        const second = plan.network.agenda[0];
        assert.notEqual(second.itemId, first.itemId, 'each item stands once');
        const next = Economy.forState(bought(state, first), deps());
        assert.equal(next.network.activity.itemId, second.itemId, 'the bot works down its agenda');
        assert.equal(next.statsPacket.decisionSeq, plan.statsPacket.decisionSeq + 1, 'one more step of one decision');
        assert.equal(next.statsPacket.wishSections, plan.statsPacket.wishSections, 'its baseline stands: one review');
        assert.equal(next.network.queue.some(wish => wish.key === first.rootKey), false, 'what was bought left the money queue');
    }
    { // A step's count is taken at the build: what arrived on the way is its progress.
        const kept = { selfId: SHOTS, amount: 2 };
        let found = null;
        for (let tries = 0; tries < 40 && !found; tries++) {
            const row = review({ inventory: { ...base.inventory, [SHOTS]: kept } });
            if (row.plan.network.agenda?.[0]?.itemId === SHOTS) found = row;
        }
        assert(found, 'fixture: shots are the later step of some review');
        const { plan, state } = found, shots = plan.network.agenda[0];
        assert.equal(shots.heldAtDecision, 2, 'the step keeps the bag it was counted on');
        const first = bought(state, plan.network.activity);
        const part = Math.floor(shots.amount / 2);
        const next = Economy.forState({ ...first, inventory: { ...first.inventory, [SHOTS]: { selfId: SHOTS, amount: 2 + part } } }, deps());
        assert.equal(next.network.activity.itemId, SHOTS);
        const Decision = invoke('GameServer/Bot/Population/ColdEconomyDecision');
        assert.equal(Decision.remainingToOrder(next.network.activity, { ...first, inventory: { ...first.inventory, [SHOTS]: { selfId: SHOTS, amount: 2 + part } } }), shots.amount - part,
            'what reached the bag since the review is not bought again');
        const whole = Economy.forState({ ...first, inventory: { ...first.inventory, [SHOTS]: { selfId: SHOTS, amount: 2 + shots.amount } } }, deps());
        assert.notEqual(whole.network.activity?.itemId, SHOTS, 'a step that arrived drops');
    }
    { // A seller that fell short: the next seller of the town, up to the value per unit.
        const bid = { status: 'deferred', reason: 'wish_focus', target: { selfId: 1 } };
        clear(SHOTS);
        let thin = sell(SHOTS, 1, 9);
        const fairLine = sell(SHOTS, 5000, 12);
        const dear = shotsFirst({ stats: { equipmentPlan: bid } }), leaf = dear.plan.network.activity;
        assert.equal(leaf.amount, 1, 'fixture: the cheapest seller holds one');
        assert(leaf.wanted > 1, 'fixture: the bot wanted more of it');
        board.remove(thin); board.remove(fairLine); sell(SHOTS, 5000, 100000);
        const stopped = Economy.forState(bought(dear.state, leaf), deps());
        assert.notEqual(stopped.network.activity?.itemId, SHOTS, 'a dearer seller stops at the value per unit');
        const before = dear.plan.watchList.find(row => row.itemId === SHOTS)?.amount;
        assert.equal(stopped.watchList.find(row => row.itemId === SHOTS)?.amount, before - 1, 'filled goods left the bids a re-projection read');
        clear(SHOTS); thin = sell(SHOTS, 1, 9); sell(SHOTS, 5000, 10);
        const fair = shotsFirst(), one = fair.plan.network.activity;
        board.remove(thin);
        const moved = Economy.forState(bought(fair.state, one), deps()), next = moved.network.activity;
        assert.deepEqual([next.itemId, next.amount, next.unitPrice], [SHOTS, one.wanted - 1, 10], 'the next seller takes the rest');
        const bids = view => view.watchList.find(row => row.itemId === SHOTS)?.amount ?? 0;
        assert.equal(bids(moved), Math.max(0, fair.plan.watchList.find(row => row.itemId === SHOTS).amount - 1), 'one step left the bids once');
        const second = Economy.forState(bought(bought(fair.state, one), next), deps());
        assert.equal(bids(second), Math.max(0, fair.plan.watchList.find(row => row.itemId === SHOTS).amount - 1 - next.amount), 'two steps, each once');
        assert.equal(invoke('GameServer/Bot/Economy/Agenda').bidsAfter([{ itemId: SHOTS, amount: 5, retainedProject: true }], [[SHOTS, 2]])[0].amount, 5,
            'a retained project reads today\'s bag, the goods are counted there');
        assert.equal(invoke('GameServer/Bot/Population/ColdEconomyDecision').remainingToOrder(next, bought(fair.state, one)), one.wanted - 1,
            'nothing it bought is ordered again');
        clear(SHOTS); sell(SHOTS, 5000, 12);
    }
    { // A bot that held some at its decision: the next seller counts from the bag it holds now.
        clear(SHOTS); const thin = sell(SHOTS, 1, 9); sell(SHOTS, 5000, 10);
        const fair = shotsFirst({ inventory: { ...base.inventory, [SHOTS]: { selfId: SHOTS, amount: 3 } } }), one = fair.plan.network.activity;
        assert.deepEqual([one.itemId, one.amount], [SHOTS, 1], 'fixture: the cheapest seller holds one');
        assert(one.wanted > 4, 'fixture: the bot wants more than it held');
        board.remove(thin);
        const after = bought(fair.state, one), next = Economy.forState(after, deps()).network.activity;
        assert.equal(next?.itemId, SHOTS, 'the next seller takes the rest');
        assert.equal(invoke('GameServer/Bot/Population/ColdEconomyDecision').remainingToOrder(next, after), one.wanted - 1,
            'what the bot held before is no progress of the next seller');
        clear(SHOTS); sell(SHOTS, 5000, 12);
    }
    { // A seller lost after a part: the part leaves the bids once, the next seller takes the rest.
        clear(SHOTS); const part = 15, short = sell(SHOTS, 40, 9); sell(SHOTS, 5000, 10);
        const fair = shotsFirst(), one = fair.plan.network.activity;
        assert.deepEqual([one.itemId, one.amount], [SHOTS, 40], 'fixture: the cheapest seller holds 40');
        assert(one.wanted > 40, 'fixture: the bot wants more than that seller has');
        board.remove(short);
        const next = Economy.forState(bought(fair.state, one, part), deps());
        assert.deepEqual([next.network.activity?.itemId, next.network.activity?.amount], [SHOTS, one.wanted - part], 'the next seller takes the rest');
        const bids = view => view.watchList.find(row => row.itemId === SHOTS)?.amount ?? 0;
        assert.equal(bids(next), Math.max(0, bids(fair.plan) - part), 'what the bot bought is bid for no more');
        clear(SHOTS); sell(SHOTS, 5000, 12);
    }
    { // A step pays its trip: one unit elsewhere is not worth the road.
        const { plan, state } = shotsFirst();
        assert.equal(plan.network.activity.itemId, SHOTS, 'fixture: shots are the step');
        clear(SHOTS);
        const lone = sell(SHOTS, 1, 10, 'Dion');
        const next = Economy.forState(state, deps()).network.activity;
        assert(next?.itemId !== SHOTS || next.town !== 'Dion', 'the road costs more than the unit brings');
        board.remove(lone); sell(SHOTS, 5000, 12);
    }
    { // A seller lost: the next one elsewhere, after what this town still has.
        const { plan, state } = shotsFirst();
        assert.equal(plan.network.activity.itemId, SHOTS, 'fixture: shots are the step');
        clear(SHOTS);
        const away = sell(SHOTS, 5000, 10, 'Dion');
        const next = Economy.forState(state, deps()).network;
        assert.equal(next.activity.itemId, plan.network.agenda[0].itemId, 'this town goes first');
        const seller = next.agenda.find(step => step.itemId === SHOTS);
        assert.equal(seller?.town, 'Dion', 'the lost item waits at its next seller');
        assert.equal(next.agenda.findIndex(step => step.town !== 'Giran'), next.agenda.indexOf(seller), 'the trip comes after this town');
        board.remove(away); sell(SHOTS, 5000, 12);
    }
    { // A tight purse is read by the step's place in the money queue.
        const Funding = invoke('GameServer/Bot/Economy/PurchaseFunding');
        const { plan } = review();
        const steps = [plan.network.activity, ...plan.network.agenda];
        const cost = steps.reduce((sum, step) => sum + step.price, 0);
        const reserve = plan.statsPacket.money[2];
        const tight = review({ adena: reserve + cost + 1 });
        const first = tight.plan.network.activity;
        assert(tight.plan.network.agenda.length > 0, 'fixture: the steps are funded');
        const noRow = tight.state.stats.money.map((value, at) => at >= 6 && (at - 6) % 3 === 0 ? 0 : value);
        const material = Economy.forState({ ...tight.state, stats: { ...tight.state.stats, money: noRow } }, deps());
        assert.equal(material.plan, tight.plan.plan, 'a step with no packet row of its own reads its root\'s place');
        const spent = bought(tight.state, first);
        spent.stats = { ...spent.stats, money: Funding.packetAfterPurchase(spent.stats.money, first.amount * first.unitPrice, { itemId: first.itemId }) };
        assert.equal(Economy.forState(spent, deps()).network.activity?.itemId, tight.plan.network.agenda[0].itemId,
            'what the plan left for the step pays for it');
    }
    { // A failed step drops: the agenda goes on, its root keeps its place for the review.
        const { plan, state } = shotsFirst();
        const first = plan.network.activity;
        clear(first.itemId);
        const next = Economy.forState(state, deps());
        assert.equal(next.network.activity?.itemId, plan.network.agenda[0].itemId, 'a gone offer moves on');
        assert.equal(next.network.queue.some(wish => wish.key === first.rootKey), true, 'its root stands');
        sell(SHOTS, 5000, 12);
    }
    { // A native plan that failed or moved is heard at once: a real review.
        const { plan, state } = review();
        const built = Economy.forState(bought(state, plan.network.activity), { ...deps(), fullReview: true });
        assert.equal(built.statsPacket.wishSections === plan.statsPacket.wishSections, false, 'the agenda waits');
    }
    { // A later tier waits for the one before it, in one review: gear follows the stock.
        const { plan, state } = review();
        const steps = plan.network.agenda, gear = steps.findIndex(step => step.rootKey.startsWith('power:'));
        assert(gear > 0, 'fixture: the review decided gear after the stock');
        assert.equal(plan.network.queue.some(wish => wish.key === steps[gear].rootKey), false, 'its tier waits in the decision');
        let current = state, step = plan;
        for (let at = 0; at <= gear; at++) {
            const after = bought(current, step.network.activity);
            step = Economy.forState(after, deps());
            current = { ...after, stats: { ...after.stats, ...step.statsPacket } };
        }
        assert.equal(step.network.activity.itemId, steps[gear].itemId, 'the bot works down to it');
        assert.equal(step.network.queue.some(wish => wish.key === steps[gear].rootKey), true, 'its wish joined the queue');
        assert.equal(step.statsPacket.wishSections, plan.statsPacket.wishSections, 'one review');
        while (step.network.agenda?.length) {
            const after = bought(current, step.network.activity);
            step = Economy.forState(after, deps());
            current = { ...after, stats: { ...after.stats, ...step.statsPacket } };
        }
        const end = Economy.forState(bought(current, step.network.activity), deps());
        assert.notEqual(end.statsPacket.wishSections, plan.statsPacket.wishSections, 'the end of the agenda is a review');
    }
    { // What the first tier could not pay holds the money: nothing later spends it.
        const poor = review({ adena: 2000 });
        assert.deepEqual(poor.plan.network.later || [], [], 'a gap holds what is left for it');
    }
    { // Another's deal is a look: whatever else moved, the plan answers while its goods stand.
        const { plan, state } = shotsFirst();
        const Sections = invoke('GameServer/Bot/Economy/DecisionSections');
        const door = { ...deps(), caller: 'meeting_prepare', deal: new Set([SHOTS]) };
        const moved = { ...state, stats: { ...state.stats, wishDirty: Sections.sectionMask(['money']) } };
        assert.equal(Economy.forState(moved, door).plan, plan.plan, 'a raised section is no build for a deal');
        const counted = { ...moved, inventory: { ...moved.inventory, [SHOTS]: { selfId: SHOTS, amount: 7 } } };
        const fresh = Economy.forState(counted, door);
        assert.notEqual(fresh.plan, plan.plan, 'its goods moved: a fresh count');
        assert.equal(Economy.forState(moved, door).plan, plan.plan, 'a deal\'s answer never becomes the plan');
    }
    { // How long a plan may wait is the plan's: main reads it from the packet.
        const Decision = invoke('GameServer/Bot/Population/ColdEconomyDecision');
        const { state } = review();
        const read = { ...deps(), board, decisions: { decided: () => null } };
        const urgent = { ...state, stats: { ...state.stats, stockTargets: [...state.stats.stockTargets.slice(0, 6), 7.5] } };
        const wants = Decision.economyFor(urgent, { ...read, decisions: { decided: () => ({ urgency: 1 }) } });
        assert.equal(wants.gapHorizonHours, 7.5, 'how long it may wait is the plan\'s');
    }
    { // The gate off: no agenda.
        Reaction.configure(false);
        const { plan } = review();
        assert.equal(plan.network.agenda, undefined);
        Reaction.configure(true);
    }
    console.log('PASS agenda');
}
run().then(() => { Reaction_off(); process.exit(0); }, error => { console.error(error); process.exit(1); });
function Reaction_off() { invoke('GameServer/Bot/Economy/Reaction').configure(false); }
