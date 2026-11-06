'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-store-release-'));
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.env.L2NODE_CONFIG_FILE = path.join(directory, 'default.ini');
fs.writeFileSync(process.env.L2NODE_CONFIG_FILE, `[Database]\npath=${directory}/world.sqlite\nhistoryPath=${directory}/history.sqlite\n`);
require('../src/Global');
invoke('GameServer/DataCache').init();
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Policy = require('../src/GameServer/Social/InteractionMemoryPolicy');
const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const { MarketBuyerWaiters } = require('../src/GameServer/Bot/Economy/MarketBuyerWaiters');
const { SeenLines } = require('../src/GameServer/Bot/Economy/BoardLook');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const now = 1e12;
const dependencies = { board: new BoardIndex(), spots: invoke('GameServer/Bot/Population/SpotProfiles').ensure(), timestamp: now };
const state = id => ({ characterId: id, updatedAt: 10, level: 20, phase: 'cold', activity: 'hunting', adena: 1000000,
    stats: { classId: 1 }, inventory: { 1: { selfId: 1, amount: 1, equipped: true, slot: 7 } },
    timing: { lastResolvedAt: now - 60000, nextResolveAt: now - 1 }, currentRegion: 'Giran',
    loc: { locX: 80000, locY: 148000, locZ: -3500 }, vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 },
    simulation: { revision: 3 } });
const resolution = () => ({ patch: {}, events: [], materialize: { items: [] }, nextResolveAt: now + 60000 });

async function run() {
    Economy.reset();
    let reachedParty, finishParty;
    const entered = new Promise(resolve => { reachedParty = resolve; });
    const parked = new Promise(resolve => { finishParty = resolve; });
    const published = [];
    const kernel = new ColdSimulationKernel({ now: () => now, maxInFlight: 10,
        resolveSolo: resolution,
        resolveParty: async ({ members }) => {
            reachedParty();
            await parked;
            return { memberResults: members.map(member => ({ state: member, result: resolution() })),
                events: [], partyPatch: {}, nextResolveAt: now + 60000 };
        }, emit: (type, payload) => {
            if (type === 'proposal_batch') published.push(payload);
        } });
    kernel.buyerEvents = new MarketBuyerWaiters({ stateFor: id => kernel.states.get(id)?.state,
        demandsFor: () => [[1864, { ready: true, budget: 1000000 }]], wake: () => true });
    const members = [state(9), state(10)].map(bot => ({ ...bot, party: { partyId: 'release-party' } }));
    const party = { partyId: 'release-party', leaderId: 9, memberIds: [9, 10], stats: {}, nextResolveAt: now - 1 };
    for (let id = 1; id <= 10; id++) {
        const bot = members.find(member => member.characterId === id) || state(id);
        kernel.upsert({ state: bot });
        // The memory table's row (the worker's memory watch).
        kernel.interactionMemory.accept(Policy.empty(id));
        Economy.forState(bot, dependencies);
    }
    kernel.partyPut(party.partyId, party);
    assert.equal(Economy.size().context, 10);
    assert.equal(kernel.interactionMemory.snapshots.size, 10);
    assert.equal(kernel.buyerEvents.owners.size, 8);
    Economy.forGroup({ ...party, adena: 10000 }, members, dependencies);
    assert.equal(Economy.size().groups, 1, 'the active native party context is also owned by its members');
    kernel.tick();
    assert.equal(kernel.inFlight.size, 10, 'the scheduler steps eight solo bots and one two-member party');
    await entered;
    assert.equal(kernel.dirty.size, 8);
    assert.equal(kernel.partyRuns.size, 1, 'party state is retained while its actual resolver waits');
    for (let id = 1; id <= 10; id++) kernel.lookSeen.set(id, new SeenLines().set(id, { deals: 1, at: now }));
    for (let id = 1; id <= 10; id++) {
        if (id % 2) {
            const fenced = kernel.fence(id);
            assert.equal(fenced.characterId, id, 'fencing names the bot before releasing its stores');
        } else kernel.remove(id);
    }
    assert.equal(kernel.inFlight.size, 0, 'release removes the steps in flight in the same call');
    assert.equal(kernel.dirty.size, 0, 'release removes uncommitted proposals in the same call');
    assert.equal(kernel.partyRuns.size, 0, 'release invalidates the retained party resolver');
    for (const [name, count] of Object.entries(kernel.storeSizes())) assert.equal(count, 0, `${name} retains no released owner`);
    // The memory table owns its rows' lifetime: a release keeps them until main removes the row.
    assert.equal(kernel.interactionMemory.snapshots.size, 10);
    assert.deepEqual(kernel.buyerEvents.size(), { owners: 0, items: 0 });
    assert.equal(Economy.size().context, 0); assert.equal(Economy.size().engine, 0);
    assert.equal(Economy.size().groups, 0);
    assert.equal(kernel.versions.size, 10, 'numeric revisions intentionally survive to fence old proposals');
    assert.equal(kernel.heap.size, 0, 'no released owner has a heap node');
    finishParty();
    await kernel.resolveChain;
    assert.equal(published.length, 0, 'a resolver completing after release cannot publish its obsolete party result');
    assert.equal(kernel.inFlight.size, 0);

    // Future due nodes must not survive release or accumulate during repeated requeue.
    const future = { ...state(11), timing: { nextResolveAt: now + 3600000 } };
    kernel.upsert({ state: future });
    for (let n = 0; n < 100; n++) kernel.requeue(11, now + 3600000 + n);
    assert.equal(kernel.heap.size, 1, 'one future node per owner');
    const command = kernel.beginCommand(11);
    assert(command, 'a real lifecycle attempt owns the future bot');
    kernel.remove(11);
    assert.equal(kernel.commandStartedAt.size, 0); assert.equal(kernel.commanding.size, 0);
    assert.equal(kernel.heap.size, 0, 'release removes the actual future heap node');
    console.log('test_cold_store_release: ok');
}
run().then(() => { fs.rmSync(directory, { recursive: true, force: true }); process.exit(0); })
    .catch(error => { console.error(error); process.exit(1); });
