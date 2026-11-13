'use strict';
// The board's buyers: a bot's held card registers what it wants from player supply
// (its watch rows), a new or cheaper SELL line wakes at most five buyers of its item
// within their budgets, far and near together (offer_posted at a far bot's next solo
// step, on a near body's mind at once, which asks its near decision), a woken want
// waits for the next card and a refused one stays. No clock.
require('../src/Global');
const assert = require('node:assert/strict');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const { MarketBuyerWaiters, MAX_WANTS, lineEvents } = require('../src/GameServer/Bot/Economy/MarketBuyerWaiters');
const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const Situations = require('../src/GameServer/Bot/Situations');

async function main() {
    const now = 100000;
    const kernel = new ColdSimulationKernel({ now: () => now,
        planLifecycle: ({ state }) => ({ plannedState: state }),
        resolveSolo: () => ({ patch: {}, events: [], materialize: { items: [] }, nextResolveAt: now + 60000 }),
        emit: () => true });
    let capped = 0;
    // The worker's wiring: the kernel delivers the offer far or near; a near body's record is
    // replaced through the states' setter as a situation (written: the worker's observer asks
    // its near decision on it).
    const written = [], set = kernel.states.set.bind(kernel.states);
    kernel.states.set = (id, entry, how = null) => { if (how === 'situation') written.push(Number(id)); return set(id, entry, how); };
    const waiters = new MarketBuyerWaiters({ wake: (id, offer) => kernel.situationWake(id, 'offer_posted', offer),
        capped: () => capped++ });
    kernel.buyerEvents = waiters;
    const state = (id, overrides = {}) => ({ characterId: id, phase: 'cold', activity: 'hunting', level: 1,
        adena: 2000, inventory: {}, vitals: { hp: 100 }, stats: {},
        timing: { lastResolvedAt: now - 60000, nextResolveAt: now + 3600000 },
        updatedAt: now, simulation: { revision: 1 }, ...overrides });
    const board = new BoardIndex();
    const record = (id, price = 100, count = 10, lines = null) => ({ id, ownerId: 900, storeType: 1,
        lines: lines || [{ lineId: 7, selfId: 99, count, price }] });
    const publish = row => {
        const previous = board.records.get(row.id) || [];
        board.put(row);
        return waiters.recordChanged(row, previous);
    };
    try {
        for (let id = 1; id <= 12; id++) { kernel.upsert(state(id)); waiters.register(id, [{ itemId: 99, budget: 1500 }]); }
        for (let id = 100; id < 104; id++) { kernel.upsert(state(id)); waiters.register(id, [{ itemId: 1000 + id, budget: 1500 }]); }
        assert.deepEqual(publish(record(1)), [1, 2, 3, 4, 5], 'a new offer wakes five buyers of its item');
        assert.deepEqual(kernel.states.get(1).stepWake, { seq: 1, raises: { offer_posted: { itemId: 99, price: 100 } },
            heard: { offer_posted: 1 } }, 'raised at the next step: the offer');
        assert.equal(kernel.inFlight.size + kernel.commanding.size, 0, 'a wake starts no step: the bot hears it at its next one');
        assert.deepEqual(publish(record(1)), [], 'a metadata refresh is not a new offer');
        assert.deepEqual(publish(record(1, 100, 9)), [], 'a sale wakes no buyer');
        assert.deepEqual(publish(record(1, 90, 9)), [6, 7, 8, 9, 10], 'a cheaper line is a new offer');
        assert.deepEqual(publish(record(2, 10000)), [], 'an offer above every budget wakes none');
        assert.deepEqual(publish(record(3, 100, 10, [{ lineId: 1, selfId: 99, count: 5, price: 100 },
            { lineId: 2, selfId: 1100, count: 5, price: 100 }])), [11, 12, 100], 'one record wakes at most five');
        // A near body holding its build (nothing woken), a stall's refused quote of the item and an item mark.
        kernel.upsert(state(21, { phase: 'hot', activity: 'shopping', stats: { woken: 0, wishSections: {}, earning: {},
            gearMarks: [{ key: 5 }, { key: 99, town: 'Giran', price: 120 }] } }));
        waiters.register(21, [{ itemId: 99, budget: 1500 }]);
        const body = kernel.states.get(21).state;
        assert.deepEqual(publish(record(4, 100, 10, [{ lineId: 3, selfId: 99, count: 5, price: 100 }])), [21],
            'a near body hears the offer its held build wants');
        const near = kernel.states.get(21).state.stats;
        assert.equal(body.stats.woken, 0, 'its state is replaced, never edited in place');
        assert(Situations.woken(near, 'build'), 'raised on its near mind now: its build is woken');
        assert.deepEqual(near.gearMarks, [{ key: 5 }], 'the refused quote is forgotten (the stall may stand again), the item mark stays');
        assert.deepEqual(written, [21], 'written as a situation: its near decision is asked');
        assert(!kernel.states.get(21).stepWake, 'no far wake: a body hears it on its mind');
        assert(!waiters.owners.has(21), 'its want leaves the index until its next card');
        // Near bodies whose build is already woken (a decision pending: the raise is no news)
        // and a bot neither far nor near refuse the offer: they keep their wants and do not use
        // up the other buyers' wakes.
        for (let id = 22; id <= 26; id++) { kernel.upsert(state(id, { phase: 'hot' })); waiters.register(id, [{ itemId: 77, budget: 5000 }]); }
        kernel.upsert(state(27, { phase: 'activating' })); waiters.register(27, [{ itemId: 77, budget: 5000 }]);
        kernel.upsert(state(28)); waiters.register(28, [{ itemId: 77, budget: 1500 }]);
        assert.deepEqual(publish(record(8, 100, 10, [{ lineId: 4, selfId: 77, count: 5, price: 100 }])), [28],
            'bots that cannot take the offer do not use up the far buyers\' wakes');
        assert.deepEqual(written, [21], 'a refused near raise writes nothing and asks no decision');
        for (let id = 22; id <= 27; id++) assert(waiters.owners.has(id), 'a refused wake keeps the want: it wakes once the bot can take it');
        // A near body's wake is one of the record's five.
        kernel.upsert(state(31, { phase: 'hot', stats: { woken: 0, wishSections: {}, earning: {} } }));
        waiters.register(31, [{ itemId: 66, budget: 3000 }]);
        for (let id = 32; id <= 37; id++) { kernel.upsert(state(id)); waiters.register(id, [{ itemId: 66, budget: 1500 }]); }
        assert.deepEqual(publish(record(9, 100, 10, [{ lineId: 5, selfId: 66, count: 5, price: 100 }])), [31, 32, 33, 34, 35],
            'at most five a record, near and far together');
        // A woken want waits for the next build: the same offer again wakes nobody.
        assert.deepEqual(publish(record(5, 80, 10)), [], 'woken wants left the index until the next build');
        waiters.register(1, [{ itemId: 99, budget: 1500 }]);
        assert.deepEqual(publish(record(5, 70, 10)), [1], 'the next build registers its wants again');
        assert.equal(kernel.states.get(1).stepWake.seq, 2, 'a newer wake replaces the pending one');
        // A step that raised it commits: answered; a newer one waits.
        kernel.stepWakeAnswered(kernel.states.get(1), 1);
        assert(kernel.states.get(1).stepWake, 'an older step does not answer a newer wake');
        kernel.stepWakeAnswered(kernel.states.get(1), 2);
        assert.equal(kernel.states.get(1).stepWake, null);
        // Name by name: one heard again while a step ran stays for the next step, with
        // the cheapest offer heard.
        kernel.stepWake(1, 'offer_posted', { itemId: 99, price: 100 });
        kernel.stepWake(1, 'line_undercut');
        const read = kernel.states.get(1).stepWake.seq;
        kernel.stepWake(1, 'offer_posted', { itemId: 99, price: 150 });
        kernel.stepWakeAnswered(kernel.states.get(1), read);
        assert.deepEqual(kernel.states.get(1).stepWake.raises, { offer_posted: { itemId: 99, price: 100 } },
            'the answered name goes, the one heard after the step read stays with the cheapest offer');
        // A party member's wake waits for its solo step.
        kernel.upsert(state(30, { party: { partyId: 'p1' } }));
        assert.equal(kernel.stepWake(30, 'offer_posted', { itemId: 99, price: 100 }), true, 'a party member keeps the wake');
        assert(kernel.states.get(30).stepWake);
        // At most MAX_WANTS a bot, the rest counted.
        waiters.register(200, Array.from({ length: MAX_WANTS + 2 }, (_, at) => ({ itemId: 500 + at, budget: 10 })));
        assert.equal(waiters.owners.get(200).length, MAX_WANTS);
        assert.equal(capped, 1, 'the wants past the cap are counted');
        kernel.remove(103);
        assert.deepEqual(publish(record(6, 100, 10, [{ lineId: 3, selfId: 1103, count: 5, price: 100 }])), [], 'a removed bot waits no more');
        // The owners' own lines: a new SELL line where theirs sell raises line_undercut on
        // the dearer bot owners (five a line from the cheapest up, each past them counted); a
        // reprice raises none (its rivals see it at their next look); a fill of an own line
        // raises goal_done:line on its owner; a dearer line or another town none.
        const raised = [];
        let undercutCapped = 0;
        const lines = new BoardIndex();
        const put = row => {
            const previous = lines.records.get(row.id) || [];
            lines.put(row);
            lineEvents(row, previous, lines, (id, name) => raised.push([id, name]), () => undercutCapped++);
        };
        const stall = (id, ownerId, price, town = 'Giran', fills = 0) => ({ id, ownerId, storeType: 1, town, botOwned: true,
            lines: [{ lineId: id, selfId: 57 + 1000, count: 5, price, fills }] });
        for (let n = 0; n < 7; n++) put(stall(10 + n, 300 + n, 200 + n));
        put(stall(30, 400, 150, 'Dion'));
        raised.length = 0;
        put(stall(40, 500, 250));
        assert.deepEqual(raised, [], 'a dearer line undercuts nobody');
        put(stall(41, 501, 100));
        assert.deepEqual(raised, [300, 301, 302, 303, 304].map(id => [id, 'line_undercut']), 'the five cheapest dearer owners, in its town only');
        assert.equal(undercutCapped, 3, 'each owner past five is counted');
        raised.length = 0;
        put(stall(41, 501, 100));
        assert.deepEqual(raised, [], 'the same line again is no news');
        put(stall(10, 300, 90));
        assert.deepEqual(raised, [], 'a reprice below its rivals raises none: they see it at their next look');
        put(stall(10, 300, 200, 'Giran', 1));
        assert.deepEqual(raised, [[300, 'goal_done:line']], 'its own line filled');
        // A line priced against a rival at 150 (accepted noise 0.2, log): a new line at 140 is a
        // move its own look keeps its price through, so it raises none; one at 100 raises.
        raised.length = 0;
        const asking = (id, ownerId, price, pricing) => ({ id, ownerId, storeType: 1, town: 'Giran', botOwned: ownerId !== 600,
            lines: [{ lineId: id, selfId: 2000, count: 5, price, fills: 0, ...(pricing ? { pricing } : {}) }] });
        put(asking(50, 600, 150));
        put(asking(51, 601, 200, { price: 200, rival: 150, sigma: 0.2 }));
        raised.length = 0;
        put(asking(52, 602, 140));
        assert.deepEqual(raised, [], 'a rival move inside the line\'s accepted noise raises none');
        put(asking(53, 603, 100));
        assert.deepEqual(raised, [[602, 'line_undercut'], [601, 'line_undercut']], 'a move past it raises line_undercut');
        console.log('market buyer waiters: PASS (wants of the build, bounded wakes at the next step, no clock; own-line situations)');
    } finally {
        await kernel.shutdown();
        assert.equal(waiters.items.size, 0);
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
