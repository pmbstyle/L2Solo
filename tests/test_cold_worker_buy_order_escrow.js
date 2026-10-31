const assert = require('assert');
const { Worker } = require('worker_threads');

require('../src/Global');
const Geodata = require('../src/GameServer/Geodata/GeodataEngine');

const DataCache = invoke('GameServer/DataCache');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const BotGear = invoke('GameServer/Bot/AI/BotGear');
const Selection = invoke('GameServer/Bot/AI/GearPlanSelection');
const nativeGearEconomy = require('./fixtures/native_gear_economy');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const ColdNpcPlanningCatalog = require('../src/GameServer/Bot/Population/ColdNpcPlanningCatalog');
const { npcPlanningCatalogRows } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const { rowOf, escrowOf, BUY, SELL } = require('../src/GameServer/AfkTrade/BoardIndex');

DataCache.init();

// A solo cold bot is planned in the worker, which cannot see AFK shops. Its
// own buy-order escrow must reach the worker (the board table): without it the
// worker plan sees only the wallet once the bid is posted, drops the target
// and the order is withdrawn (T2).
const catalogRows = npcPlanningCatalogRows();
const plannerOptions = ColdNpcPlanningCatalog.createLookup(catalogRows).plannerOptions;
const point = { locX: 145224, locY: 120001, locZ: -4500 };
// The bot holds a usable weapon: an unarmed bot would bridge a weapon first.
// A C4 Warrior's kit weapon is two-handed (slot 14), not a one-hand (slot 7).
const weapon = BotGear.planFor({ classId: 1, level: 30 }).items.find((item) => [7, 14].includes(Number(item.slot)));
const base = (characterId, adena) => ({
    characterId, name: `Buyer${characterId}`, accountName: `bot_${characterId}`, level: 30, exp: Number(DataCache.experience[29]), sp: 0,
    phase: 'cold', activity: 'hunting', loc: { ...point },
    // A full hour of D soulshots: the worker's hunting table reserves a missing
    // shot hour from the wallet, which this escrow fixture does not exercise.
    inventory: { [weapon.selfId]: { selfId: Number(weapon.selfId), amount: 1, equippedCount: 1, equipped: 1 },
        1463: { selfId: 1463, amount: 2000 } }, adena,
    vitals: { hp: 2000, maxHp: 2000, mp: 1000, maxMp: 1000 },
    stats: { hennas: [1, 13, 17], generatedCold: true, classId: 1, role: 'dps', build: { grade: 'd', classId: 1, level: 30 }, equipment: [] }
});
const fundedIds = packet => Array.from({ length: Math.floor((packet.length - 4) / 3) }, (_, i) => packet[6 + i * 3]);

(async () => {
    // The original incomplete kit and 60k wallet do not prove a funded gear
    // purchase. Keep that actor's native defer result before reading a target.
    const original = base(7, 60000);
    const originalSelection = Selection.selectAcquisitionPlan(original, null, { spots: [], planningOptions: plannerOptions,
        preparedEconomy: invoke('GameServer/Bot/Economy/EconomyContext').forState(original,
            { spots: [], routeRows: nativeGearEconomy.prepareRoutes(original) }) });
    assert.strictEqual(originalSelection.acquisitionPlan.status, 'deferred',
        `original weapon-only buyer: ${nativeGearEconomy.describe(originalSelection.economy)}`);

    const native = nativeGearEconomy({ characterId: 7 });
    const posting = native.plan;
    const Funding = invoke('GameServer/Bot/Economy/PurchaseFunding');
    const price = Number(posting.market.price);
    const accepted = { ...native.member, stats: { ...native.member.stats, ...native.economy.statsPacket } };
    const available = Funding.spendable(accepted, 0, { itemId: posting.target.selfId });
    assert(available >= price, 'the selected native item is admitted at its actual NPC quote');
    const plentifulAfter = { ...accepted, adena: accepted.adena - price,
        inventory: { ...accepted.inventory, 57: { ...accepted.inventory[57], amount: accepted.adena - price } } };
    assert.strictEqual(Funding.spendable(plentifulAfter, price, { itemId: posting.target.selfId })
        - Funding.spendable(plentifulAfter, 0, { itemId: posting.target.selfId }), price,
    'own escrow adds exactly the physically posted quote to the native available funds');
    // Derive the scarce boundary from the native reserve and higher-priority
    // commitments, rather than choosing an amount until the test passes.
    const mandatory = accepted.adena - available;
    const wallet = Math.ceil(price + mandatory), afterPosting = wallet - price;
    assert(price > 0 && afterPosting >= 0);
    const beforePosting = { ...native.member, adena: wallet,
        inventory: { ...native.member.inventory, 57: { ...native.member.inventory[57], amount: wallet } } };
    const boundary = native.review(beforePosting);
    const chosen = boundary.network.queue.find(wish => wish.key === boundary.network.activity?.rootKey);
    assert(boundary.network.activity?.activity === 'shopping' && !boundary.network.activity.funding
        && chosen?.funded && chosen.object?.itemId === posting.target.selfId,
    `native derived cash boundary (${price}+${mandatory}=${wallet}): ${nativeGearEconomy.describe(boundary)}`);
    const captured = await require('./helpers/workerEconomyDecision')(beforePosting, { nativeRoutes: true });
    const fundingPacket = captured.statsPacket;
    assert(Array.isArray(fundingPacket.money));
    assert(fundedIds(fundingPacket.money).includes(posting.target.selfId),
        `the actual worker funds the selected NPC item: ${JSON.stringify(captured.decision)}`);
    const soloBase = (characterId, adena) => ({ ...native.member, characterId,
        name: `Buyer${characterId}`, accountName: `bot_${characterId}`,
        inventory: { ...structuredClone(native.member.inventory),
            57: { ...native.member.inventory[57], amount: adena } }, adena,
        stats: { ...native.member.stats, ...fundingPacket } });
    assert.strictEqual(soloBase(7, afterPosting).inventory[57].amount + price, wallet,
        'the posted bid moves exactly the native quote from the same physical wallet to escrow');
    const unfunded = native.review(soloBase(7, afterPosting));
    assert.strictEqual(unfunded.network.activity.funding, true,
        `without own escrow the purchase must earn money: ${nativeGearEconomy.describe(unfunded)}; quote=${price}; wallet=${afterPosting}`);
    assert(!fundedIds(unfunded.statsPacket.money).includes(posting.target.selfId), 'unfunded target has no spending ratio');

    // The escrow reaches the worker on the board table's rows: a buy
    // record's row carries the adena it holds, a sell record's none.
    const wtb = (id, ownerId, selfId, quote) => [id, rowOf({ id, kind: 'buy_ad', storeType: BUY, ownerId,
        town: 'Giran', botOwned: true, lines: [{ id: id * 10, selfId, count: 1, price: quote }], escrowAdena: quote })];
    assert.strictEqual(escrowOf(wtb(901, 7, posting.target.selfId, price)[1]), price);
    assert.strictEqual(escrowOf(rowOf({ id: 903, storeType: SELL, ownerId: 7, escrowAdena: price,
        lines: [{ id: 1, selfId: 57, count: 1, price: 1 }] })), 0, 'a sell record holds no escrow');

    const epoch = 'escrow-test';
    const worker = new Worker(require.resolve('../src/GameServer/Bot/Population/ColdSimulationWorker'), {
        workerData: { sharedGeodata: Geodata.sharedDescriptor(), workerEpoch: epoch }
    });
    const received = [];
    let workerError;
    worker.on('error', (error) => { workerError = error; });
    worker.on('message', (message) => received.push(message));
    const send = (type, payload, msgId) => worker.postMessage(Protocol.envelope(type, epoch, payload, msgId));
    const until = async (predicate) => {
        const deadline = Date.now() + 15000;
        while (!received.some(predicate)) {
            if (workerError) throw workerError;
            const failure = received.find(message => message.type === 'fault');
            if (failure) throw Error(JSON.stringify(failure));
            if (Date.now() >= deadline) throw Error(`worker escrow timeout: ${JSON.stringify(received.map((m) => m.type))}`);
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return received.find(predicate);
    };
    try {
        await until((m) => m.type === 'ready' && m.payload.phase === 'loaded');
        for (let start = 0; start < catalogRows.length; start += Protocol.MAX_BATCH) {
            send('catalog_page', { catalog: 'npc_offers', rows: catalogRows.slice(start, start + Protocol.MAX_BATCH),
                done: start + Protocol.MAX_BATCH >= catalogRows.length });
        }
        send('init', { config: { loopIntervalMs: 10 } });
        await until((m) => m.type === 'ready' && m.payload.phase === 'running');
        const now = Date.now();
        const timing = { lastResolvedAt: now - 45000, nextResolveAt: now - 1 };
        // These party members start without a money packet (startup reserve fallback);
        // they must not inherit the unrelated solo buyer's jewelry queue.
        // Party members are reviewed in the worker too: a member in the wrong
        // armour class leaves to buy its bridge only while it can fund it,
        // and its order's escrow is part of that budget.
        const spot = { id: 'escrow-field', name: 'Escrow field', center: point, avgLevel: 30, minLevel: 28, maxLevel: 32,
            density: 3, npcSelfIds: [], mob: { hp: 1, damage: 1 }, rewards: { exp: 100, sp: 10, adenaMin: 1, adenaMax: 1 } };
        // The worker finds the party's spot in its spot catalog.
        send('catalog_page', { catalog: 'spots', rows: [spot], done: true });
        const robe = 391; // Puma Skin Shirt: D-grade light armour, wrong for this build
        const bridgeWallet = 150000;
        const parties = [];
        const partyRows = (partyId, leaderId, wallet) => {
            const party = { partyId, leaderId, memberIds: [leaderId, leaderId + 1], status: 'active', spotId: spot.id,
                nextResolveAt: now - 1, cohesion: 1, stats: { fightsResolved: 10, sessionExpiresAt: now + 3600000 } };
            const member = (characterId, adena, body) => ({ ...base(characterId, adena), activity: 'grouped',
                spotId: spot.id, timing, party: { partyId, leaderId, role: 'dps' },
                inventory: {
                    [weapon.selfId]: { selfId: Number(weapon.selfId), amount: 1, equippedCount: 1, equipped: 1 },
                    [body]: { selfId: body, amount: 1, equippedCount: 1, equipped: 1 }
                } });
            const members = [member(leaderId, wallet, robe), member(leaderId + 1, bridgeWallet, 58)];
            parties.push(party);
            return members.map(state => ({ state }));
        };
        const bridge = GearAcquisitionPlanner.npcEquipmentBridgePlan(partyRows('p', 20, bridgeWallet)[0].state, plannerOptions);
        parties.length = 0;
        assert(bridge?.equipmentBridge, 'the fixture member must need a class armour bridge');
        const bridgePrice = Number(bridge.market.price);
        const unfundedWallet = Number(bridge.market.reserve) + 1000;
        assert(unfundedWallet < bridgePrice + Number(bridge.market.reserve),
            'the fixture bridge must need the escrow once the bid is posted');
        const rows = [
            { state: { ...soloBase(7, afterPosting), timing } },
            { state: { ...soloBase(8, afterPosting), timing } },
            ...partyRows('escrow-party', 20, unfundedWallet),
            ...partyRows('wallet-party', 30, unfundedWallet)
        ];
        // Bot 7's order for its target and member 20's for its bridge hold
        // the escrow; the parties come from main's parties table.
        send('table_page', { tables: [
            { name: 'board', from: null, to: 0, full: true, removed: [], last: true,
                rows: [wtb(901, 7, posting.target.selfId, price), wtb(902, 20, bridge.target.selfId, bridgePrice)] },
            { name: 'parties', from: null, to: 0, full: true, removed: [], last: true,
                rows: parties.map(party => [party.partyId, party]) }] });
        send('snapshot_page', { done: true, rows });
        const proposals = new Map();
        const deadline = Date.now() + 15000;
        while ([7, 8, 20, 30].some((id) => !proposals.has(id))) {
            if (workerError) throw workerError;
            const failure = received.find(message => message.type === 'fault');
            if (failure) throw Error(JSON.stringify(failure));
            if (Date.now() >= deadline) throw Error(`worker escrow proposals: ${JSON.stringify(received.map((m) => m.type))}`);
            for (const message of received.filter((m) => m.type === 'proposal_batch')) {
                for (const proposal of message.payload.proposals) proposals.set(Number(proposal.characterId), proposal);
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        assert(!received.some((m) => m.type === 'fault'), JSON.stringify(received.filter((m) => m.type === 'fault')));
        const compact = require('../src/GameServer/Bot/Population/ColdEconomyDecision').compact;
        const fundedDecision = compact(proposals.get(7).economyDecision), unfundedDecision = compact(proposals.get(8).economyDecision);
        assert(fundedDecision.activity, 'worker supplies its new native wish after the fight');
        assert.strictEqual(proposals.get(7).nextState.stats.wishFocus?.[0], `power:${posting.target.selfId}:${posting.target.slot}`,
            'the worker keeps the target funded by the bot\'s own buy-order escrow as its focused wish');
        assert(fundedIds(proposals.get(7).nextState.stats.money).includes(posting.target.selfId),
            'the target carries a funded spending ratio');
        assert(Funding.spendable(proposals.get(7).nextState, price, { itemId: posting.target.selfId }) >= price,
            'current native funded ratio plus own escrow can pay the actual NPC offer');
        assert(Funding.spendable(proposals.get(8).nextState, 0, { itemId: posting.target.selfId }) < price,
            'without escrow the actual NPC purchase remains unaffordable');
        assert(unfundedDecision.activity, 'unfunded bot still has a worker-decided activity');
        assert.strictEqual(proposals.get(20).nextState?.stats?.partyBreakReason, 'class_armor_bridge',
            'a member whose order holds the bridge money leaves to buy it');
        assert.notStrictEqual(proposals.get(30).nextState?.stats?.partyBreakReason, 'class_armor_bridge',
            'the same wallet without an order cannot fund the bridge');
    } finally {
        await worker.terminate();
    }
    console.log('Cold worker buy-order escrow checks passed');
    process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
