const assert = require('node:assert/strict');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const { MarketBuyerWaiters } = require('../src/GameServer/Bot/Economy/MarketBuyerWaiters');
const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const Funding = require('../src/GameServer/Bot/Economy/PurchaseFunding');
const reserve = Funding.operatingReserve;
Funding.operatingReserve = () => 500; // This index fixture supplies a fixed, already decided reserve.

async function main() {
    let now = 100000, reads = 0;
    const requests = [];
    const kernel = new ColdSimulationKernel({ now: () => now,
        planLifecycle: ({ state }) => ({ plannedState: state }),
        resolveSolo: () => ({ patch: {}, events: [], materialize: { items: [] }, nextResolveAt: now + 60000 }),
        emit: (type, payload) => { if (type === 'command_request') requests.push(...payload.requests); } });
    const waiters = new MarketBuyerWaiters({
        stateFor: id => { reads++; return kernel.states.get(id)?.state; },
        demandsFor: state => [[state.stats.wanted, { ready: true, budget: state.adena }]],
        wake: (id, timestamp) => kernel.wakeBuyer(id, timestamp)
    });
    kernel.buyerEvents = waiters;
    const state = (id, item = 99, overrides = {}) => ({ characterId: id, phase: 'cold', activity: 'hunting', level: 1,
        adena: 2000, inventory: {}, vitals: { hp: 100 }, stats: { wanted: item },
        timing: { lastResolvedAt: now - 60000, nextResolveAt: now + 3600000 },
        updatedAt: now, simulation: { ownerId: 'legacy_main', revision: 1, leaseId: null, leaseUntil: 0 }, ...overrides });
    const board = new BoardIndex();
    const record = (id, price = 100, count = 10, lines = null) => ({ id, ownerId: 900, storeType: 1,
        lines: lines || [{ lineId: 7, selfId: 99, count, price }] });
    const publish = row => {
        const previous = board.records.get(row.id) || [];
        board.put(row);
        return waiters.recordChanged(row, previous, now);
    };
    try {
        for (let id = 1; id <= 12; id++) kernel.upsert(state(id));
        for (let id = 100; id < 164; id++) kernel.upsert(state(id, 1000 + id));
        kernel.upsert(state(20, 99, { activity: 'resting' }));
        kernel.upsert(state(21, 99, { phase: 'hot' }));
        kernel.upsert(state(22, 99, { partyId: 'party' }));
        kernel.upsert(state(23, 99, { adena: 510 }));
        reads = 0;
        assert.deepEqual(publish(record(1)), [1, 2, 3, 4, 5]);
        assert.equal(reads, 5, 'new stock reads five addressed owners, independent of unrelated population');
        assert.equal(waiters.stats.inspected, 5);
        kernel.tick();
        await kernel.resolveChain;
        assert.equal(requests.length, 5);
        assert(requests.every(request => request.marketWakeup === true && request.kind === 'lifecycle'));
        assert.equal(Protocol.validateEnvelope(Protocol.envelope('command_request', 'buyer-events', { requests }), 'worker',
            { workerEpoch: 'buyer-events' }).ok, true, 'wakeups follow the actual command wire contract');
        assert(requests.every(request => request.state.timing.nextResolveAt === now + 3600000),
            'the event wakes native commands without falsifying persisted deadlines');
        assert.equal(kernel.claiming.size, 0, 'the wakeup plans a purchase rather than an extra combat claim');
        assert.deepEqual(publish(record(1)), [], 'metadata refresh is not new stock');
        assert.deepEqual(publish(record(1, 100, 9)), [], 'a sale cannot wake buyers again');
        assert.deepEqual(publish(record(1, 90, 9)), [6, 7, 8, 9, 10], 'a cheaper quote is new useful evidence');
        assert.deepEqual(publish(record(2, 10000)), [], 'unaffordable head stops without scanning all waiters');
        assert.deepEqual(publish(record(3, 100, 10, [
            { lineId: 1, selfId: 99, count: 5, price: 100 },
            { lineId: 2, selfId: 1100, count: 5, price: 100 }
        ])), [11, 12, 100], 'a multi-item record deduplicates buyers and shares its five-owner budget');
        kernel.remove(101);
        assert.deepEqual(publish(record(4, 100, 10, [{ lineId: 3, selfId: 1101, count: 5, price: 100 }])), []);
        const busy = kernel.beginCommand(102);
        assert(busy);
        assert.deepEqual(publish(record(5, 100, 10, [{ lineId: 4, selfId: 1102, count: 5, price: 100 }])), [102]);
        assert(kernel.buyerWakeups.has(102), 'an event during a native command stays pending');
        kernel.cancelCommand(102, busy);
        kernel.upsert(state(102, 1102));
        assert.equal(kernel.scheduleTokens.get(102).dueAt, now, 'accepted state rearms the pending event');
        kernel.upsert(state(103, 1103, { phase: 'hot' }));
        assert.deepEqual(publish(record(6, 100, 10, [{ lineId: 5, selfId: 1103, count: 5, price: 100 }])), []);
        console.log('market buyer waiters: PASS (bounded new-stock delivery, native command, affordability, busy and retirement)');
    } finally {
        Funding.operatingReserve = reserve;
        await kernel.shutdown();
        assert.equal(waiters.items.size, 0);
        assert.equal(kernel.buyerWakeups.size, 0);
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
