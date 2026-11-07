'use strict';
process.env.BOT_DEVELOPER_DIAGNOSTICS = 'true'; // This fixture inspects optional developer metrics.
const assert = require('node:assert/strict');
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.env.L2NODE_CONFIG_FILE = 'config/default.ini';
const { createWorld, Database } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Offer = invoke('GameServer/Bot/Economy/ColdBuffOffer');
const Cold = invoke('GameServer/Bot/Economy/ColdBuffService');
const Policy = invoke('GameServer/Bot/Economy/BuffServicePolicy');
const Memory = invoke('GameServer/Social/InteractionMemoryRuntime');
const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const timestamp = 1800000000000;
const ids = [719400, 719401, 719402, 719403];
const state = (id, classId, revision) => ({ characterId: id, name: `Buff${id}`, level: 55,
    phase: 'cold', activity: 'hunting', spotId: 'test-spot', currentRegion: 'Giran', adena: 20000,
    loc: { locX: 83396, locY: 147904, locZ: -3400 }, party: {}, timing: {},
    stats: { classId, money: [6000, 0, 0, 0], classProgressionLevel: 55, classProgressionClassId: classId,
        coldCombat: { skills: Profile.skillRecordsFromTree(classId, 55), effects: [] } },
    inventory: { 57: { selfId: 57, amount: 20000 } }, vitals: { hp: 100, maxHp: 100, mp: 2000, maxMp: 2000 },
    simulation: { revision } });
async function run() {
    const world = await createWorld(ids.map(id => ({ id, level: 55 })), 'cold-buff-offer');
    const mark = invoke('GameServer/Bot/Population/ColdSimulationCoordinator').markDirty;
    const assess = Memory.assess;
    const disposers = [];
    const stub = (target, key, fn) => { const saved = target[key]; target[key] = fn; disposers.push(() => { target[key] = saved; }); };
    try {
        assert.equal(Cold.tick, undefined, 'there is no timer-driven population scan');
        const provider = state(ids[0], 17, 41), first = state(ids[1], 9, 11), buyer = state(ids[2], 9, 17), last = state(ids[3], 9, 25);
        first.stats.pvpEncounter = {};
        const kernel = new ColdSimulationKernel({ resolveSolo: () => null });
        for (const current of [provider, first, buyer, last]) kernel.upsert({ state: current });
        Memory.assess = () => { throw Error('worker must never read main relations'); };
        // A buyer's rebuff reads its spot's buffers on the worker (no main relation):
        // the first that sells it support within its price read; a bot in a fight buys none.
        const Rebuff = invoke('GameServer/Bot/AI/Rebuff');
        assert.equal(Offer.providerFor(buyer, kernel.occupancy.members('test-spot', 'physical'), timestamp), provider.characterId);
        assert.equal(Offer.providerFor(first, kernel.occupancy.members('test-spot', 'physical'), timestamp), null);
        const packet = Offer.offer(provider, buyer, timestamp);
        assert.ok(packet); assert.equal(packet.recipientId, buyer.characterId);
        assert.equal(packet.providerRevision, 41); assert.equal(packet.recipientRevision, 17);
        assert.ok(Buffer.byteLength(JSON.stringify(packet)) <= 512);
        // At most 16 buffers are looked at; the spot's other units cost no look.
        let inspected = 0;
        const busy = { ...provider, characterId: 719499, stats: { ...provider.stats, pvpEncounter: {} } };
        function* far(buffers) { for (let i = 0; i < 20; i++) yield first; for (let i = 0; i < buffers; i++) { inspected++; yield busy; } yield provider; }
        assert.equal(Offer.providerFor(buyer, far(15), timestamp), provider.characterId, 'the 16th buffer sells');
        inspected = 0;
        assert.equal(Offer.providerFor(buyer, far(16), timestamp), null, 'a 17th is never reached');
        assert.equal(inspected, 16);
        const longSpot = 'x'.repeat(600);
        assert.equal(Offer.offer({ ...provider, spotId: longSpot }, { ...buyer, spotId: longSpot }, timestamp), null,
            'an offer which exceeds the hard IPC bound is not emitted');
        // The buyer's step carries the sale its held answer names, once.
        const sent = [];
        let transport;
        transport = new ColdSimulationKernel({ now: () => timestamp,
            resolveSolo: ({ state }) => ({ patch: { activity: 'hunting' }, materialize: { exp: 0, sp: 0, adena: 0, items: [] },
                events: [], nextResolveAt: timestamp + 60000 }),
            projectResolve: async state => {
                const answer = Rebuff.pending(state.stats, 'buffer');
                return { state, ...(answer ? { buffOffer: Offer.offer(transport.states.get(answer.providerId).state, state, timestamp) } : {}) };
            },
            emit: (type, payload, msgId) => { sent.push({ type, payload, msgId }); } });
        const answered = { ...buyer, stats: { ...buyer.stats, rebuff: { via: 'buffer', providerId: provider.characterId, at: timestamp - 1 } } };
        for (const current of [provider, first, answered, last]) transport.upsert({ state: { ...current,
            timing: { lastResolvedAt: timestamp - 45000, nextResolveAt: current === answered ? timestamp - 1 : timestamp + 60000 } } });
        transport.tick();
        assert.deepEqual([...transport.inFlight.keys()], [buyer.characterId], 'the buyer steps from the worker\'s copy');
        await transport.resolveChain;
        transport.flush(null, true);
        const projectedPacket = sent.find(row => row.type === 'proposal_batch')?.payload.proposals[0].buffOffer;
        assert.ok(projectedPacket, 'the buyer resolve carries one actual proposal offer');
        assert.equal(projectedPacket.providerRevision, 41, 'the offer names the revision the step started from');
        assert.equal(projectedPacket.recipientRevision, 17);
        assert.equal(projectedPacket.recipientId, buyer.characterId);
        assert.ok(Buffer.byteLength(JSON.stringify(projectedPacket)) <= 512);
        Memory.assess = assess;
        const native = Cold.coldOffer(provider, buyer, timestamp);
        assert.ok(native);
        assert.deepEqual(Offer.expand(packet.effects, timestamp), native.effects, 'the entire native effect set is identical');
        assert.equal(Policy.priceFor({ provider, recipient: buyer, skills: Offer.select(provider, buyer, timestamp).selected, town: false }),
            Policy.priceFor({ provider, recipient: buyer, mp: packet.mpCost, count: packet.effects.length, town: false }));
        for (const current of [provider, first, buyer, last]) {
            await Database.setItem(current.characterId, { selfId: 57, name: 'Adena', amount: 20000, slot: 0 });
            await Database.execute([`INSERT INTO bot_life_state(characterId,accountName,characterName,level,phase,activity,spotId,
                currentRegion,locX,locY,locZ,hp,maxHp,mp,maxMp,adena,statsJson,inventorySummary,simulationRevision,updatedAt)
                VALUES(?,'quests',?,55,'cold','hunting','test-spot','Giran',83396,147904,-3400,100,100,2000,2000,20000,?,?,?,?)`,
                [current.characterId, current.name, JSON.stringify(current.stats), JSON.stringify(current.inventory), current.simulation.revision, timestamp]]);
        }
        await Life.init();
        await Database.execute(['UPDATE bot_life_state SET simulationRevision=42 WHERE characterId=?', [provider.characterId]]);
        Life.acceptLifecycleRow((await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [provider.characterId]]))[0]);
        invoke('GameServer/Bot/Population/ColdSimulationCoordinator').markDirty = () => true;
        const coordinator = new ColdSimulationCoordinator();
        stub(coordinator, 'reviewCommittedEconomy', async state => state);
        stub(Life, 'enqueueEquipmentGoalAdvanceForState', () => null);
        stub(invoke('GameServer/Bot/Population/BotLifeEvents'), 'recordMany', () => null);
        stub(invoke('GameServer/Bot/Population/BotGlobalChat'), 'maybeAnnounce', () => null);
        let guarded = 0;
        const originalApply = Cold.applyOffer;
        stub(Cold, 'applyOffer', (offer, options) => originalApply(offer, { ...options, timestamp,
            beforeWrite: () => { options.beforeWrite(); guarded++; } }));
        // The provider's review command after its commit, as the worker sends it.
        const answers = [];
        coordinator.worker = { postMessage: message => message.type === 'command_ack' && answers.push(...message.payload.results) };
        coordinator.workerEpoch = 'buff:test';
        const review = async buffOffer => {
            coordinator.handleCommandRequest({ msgId: `buff:${answers.length}`, payload: { requests: [{
                characterId: provider.characterId, kind: 'review', commandId: `review:${provider.characterId}:${answers.length}`,
                commandCheckpoint: Protocol.commandCheckpoint(Life.cachedState(provider.characterId)), buffOffer }] } });
            await coordinator.commandTail;
            return answers.at(-1);
        };
        // Life.init's startup repair already saved (and moved) the fixture rows.
        const buyerBefore = Life.cachedState(buyer.characterId).simulation.revision;
        assert.equal((await review(packet)).ok, true);
        assert.equal(guarded, 1);
        assert.equal(Cold.summary().sold, 1);
        const stored = (await Database.execute(['SELECT statsJson,simulationRevision FROM bot_life_state WHERE characterId=?', [buyer.characterId]]))[0];
        assert.deepEqual(JSON.parse(stored.statsJson).coldCombat.effects, native.effects);
        assert.equal(stored.simulationRevision, buyerBefore + 1, 'the purchase moves the buyer once');
        const stale = { ...packet, providerRevision: Life.cachedState(provider.characterId).simulation.revision,
            recipientRevision: Number(stored.simulationRevision) - 2 };
        assert.equal((await review(stale)).ok, true, 'a stale offer does not refuse the provider review');
        assert.equal(Cold.summary().dropped, 1, 'recipient two revisions ahead drops once');
        assert.equal(Cold.summary().sold, 1);
        coordinator.stopping = true;
        assert.equal((await review({ ...packet, providerRevision: Life.cachedState(provider.characterId).simulation.revision,
            recipientRevision: Number(stored.simulationRevision) })).reason, 'coordinator_stopping');
        assert.equal(guarded, 1, 'a retired source cannot reach the buff writer');
        const sellerNow = Life.cachedState(provider.characterId), buyerNow = Life.cachedState(buyer.characterId);
        const currentPacket = { ...packet, providerRevision: sellerNow.simulation.revision,
            recipientRevision: buyerNow.simulation.revision };
        assert.equal((await originalApply({ ...currentPacket, extra: 'x'.repeat(512) }, { timestamp })).reason, 'invalid_offer');
        stub(Life, 'cachedState', id => id === provider.characterId ? sellerNow : buyerNow);
        stub(Life, 'acceptSimulationOwnership', () => null);
        let rateWrites = 0;
        stub(Database, 'purchaseColdBuffs', async () => { rateWrites++; return { ok: true }; });
        for (let i = 0; i < 5; i++) assert.equal((await originalApply(currentPacket, { timestamp })).ok, true);
        assert.equal((await originalApply(currentPacket, { timestamp })).reason, 'sale_limit');
        assert.equal(rateWrites, 5, 'the existing native sale plus five fills the six-sale minute window');
        assert.equal((await originalApply(currentPacket, { timestamp: timestamp + 60000 })).ok, true);
        assert.equal(rateWrites, 6, 'the next minute admits a purchase again');
        coordinator.unsubscribeWishRemovals();
        console.log(`test_cold_buff_offer: native chooser/effects, ${Buffer.byteLength(JSON.stringify(packet))} byte offer, revisions, guarded main purchase and ack passed`);
    } finally {
        for (const restore of disposers.reverse()) restore();
        invoke('GameServer/Bot/Population/ColdSimulationCoordinator').markDirty = mark;
        Memory.assess = assess;
        await world.close();
    }
}
run().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
