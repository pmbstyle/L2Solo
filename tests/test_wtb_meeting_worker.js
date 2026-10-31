'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
require('../src/Global');
const Geodata = require('../src/GameServer/Geodata/GeodataEngine');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const Codec = require('../src/GameServer/AfkTrade/TradeMeetingCodec');

// Fix only wish usefulness and NPC stock. The bilateral worker, route
// preparation, transport and decision to return consent run their real code.
const source = `
const { workerData, parentPort } = require('node:worker_threads');
require(workerData.workerPath);
// Enlarge one advisory proof after preparation, to exercise the real sender
// with a production-sized epoch and a refusal that exceeds the full wire cap.
const wire = invoke('GameServer/Bot/Population/ColdStateWire'), packPayload = wire.packPayload;
wire.packPayload = (type, payload) => {
    const packed = packPayload(type, payload), row = packed.results?.[0];
    if (type !== 'command_ack' || row?.commandId !== 'oversized-purchase-proof' || !row.priceEvidence) return packed;
    return { ...packed, results: [{ ...row, priceEvidence: { ...row.priceEvidence, padding: 'x'.repeat(500) } }] };
};
const refusals = invoke('GameServer/Bot/Economy/MeetingPriceRefusals'), remember = refusals.remember;
refusals.remember = (state, board, request, purchase, current, options) => {
    remember(state, board, request, purchase, current, options);
    const quote = board.records.get(request.lines[0].adId)?.[0];
    parentPort.postMessage({ priceMemo: quote && refusals.rejects(quote, purchase.units, state), token: request.token });
};
invoke('GameServer/Bot/Economy/EconomyContext').forState = (state, options) => (options.onSourceScope?.('recipe-production:0'),
    [1463, 1867, 2109, 413, 1870].forEach(id => options.onSourceRead?.(id)), {
    network: { quantityPrepared: true, queue: [] }, projection: {}, hourAdena: 1000, worth: () => 34454032, price: () => 34454032,
    trip: invoke('GameServer/Bot/Economy/EconomicTrip').preparedReader(options.routeRows, { hourAdena: 1000 }),
    kitCost: () => 0
});
invoke('GameServer/Bot/Economy/TradeIntent').project = () => [{
    itemId: 413, amount: 2, worth: 34454032, key: 'resale:413', valueHours: 20, valueRate: 100
}];
invoke('GameServer/Bot/Population/ColdOccupationSources').npcOffersFor = id => id === 413
    ? [{ sourceType: 'npc', town: 'Giran', price: 80000 }] : [];
invoke('GameServer/Bot/Economy/PurchaseFunding').spendable = (_state, _escrow, options) => options?.free ? 0 : 1000000;
`;

(async () => {
    const epoch = 'cold-worker:41311:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', received = [];
    const worker = new Worker(source, { eval: true, workerData: { sharedGeodata: Geodata.sharedDescriptor(), workerEpoch: epoch,
        workerPath: path.resolve(__dirname, '../src/GameServer/Bot/Population/ColdSimulationWorker.js') } });
    let failure;
    worker.on('error', error => { failure = error; });
    worker.on('message', message => received.push(message));
    const send = (type, payload) => worker.postMessage(Protocol.envelope(type, epoch, payload));
    // Loading the worker (datapack, catalogues) alone can pass ten seconds
    // on a loaded machine; the meeting steps after it keep the short bound.
    const until = async (predicate, limitMs = 10000) => {
        const deadline = Date.now() + limitMs;
        while (!received.some(predicate)) {
            if (failure) throw failure;
            const fault = received.find(message => message.type === 'fault');
            if (fault) throw Error(JSON.stringify(fault.payload));
            if (Date.now() > deadline) throw Error(`meeting timeout: ${received.map(x => x.type).join(',')}`);
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        return received.find(predicate);
    };
    try {
        await until(message => message.type === 'ready' && message.payload.phase === 'loaded', 120000);
        send('catalog_page', { catalog: 'spots', rows: [], done: true });
        send('catalog_page', { catalog: 'npc_offers', rows: [], done: true });
        const { rowOf } = require('../src/GameServer/AfkTrade/BoardIndex');
        const bid = rowOf({ shopId: 100, ownerId: 42, revision: 1, kind: 'buy_ad', storeType: 3,
            custodyPolicy: 1, town: 'Giran', botOwned: true,
            items: [{ afkTradeLineId: 1000, selfId: 413, count: 2, price: 188565, enchant: 0 }] });
        const ask = rowOf({ shopId: 101, ownerId: 43, revision: 1, kind: 'sell_ad', storeType: 1,
            custodyPolicy: 1, town: 'Giran', botOwned: true,
            items: [{ afkTradeLineId: 1001, selfId: 413, count: 2, price: 188565, enchant: 0 }] });
        send('table_page', { tables: [{ name: 'board', from: null, to: 0, full: true, rows: [[100, bid], [101, ask]], removed: [] },
            { name: 'market', from: null, to: 0, full: true, rows: [], removed: [] }] });
        send('init', { config: { loopIntervalMs: 10, flushTargetMs: 10, flushHardMs: 50 } });
        await until(message => message.type === 'ready' && message.payload.phase === 'running');
        const now = Date.now(), point = { locX: 83396, locY: 147904, locZ: -3400 };
        const state = { characterId: 42, name: 'Buyer', accountName: 'bot_meeting_limit', level: 30,
            phase: 'cold', activity: 'shopping', currentRegion: 'Giran', loc: point, inventory: {}, adena: 1000000,
            vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 }, stats: { classId: 0 },
            timing: { lastResolvedAt: now, nextResolveAt: now + 600000 },
            simulation: { revision: 0 } };
        send('snapshot_page', { rows: [{ state }], done: true, ack: true });
        await until(message => message.type === 'ready' && message.payload.phase === 'state_loaded');
        const request = (token, price) => ({ token, actorA: 42, actorB: 43, seqA: 1, seqB: 1, town: 'Giran', point,
            parties: [0, 1].map(() => ({ phase: 'cold', hotAt: 0,
                revision: 0, sequence: 1, needRevision: 0, route: { fee: 0, scroll: false, method: 'walk', durationMs: 0 } })),
            lines: [1, 2].map(itemId => ({ payer: 0, selfId: 413, enchant: 0, itemId, count: 1, price,
                adId: 100, adRevision: 1 })) });
        const prepare = input => {
            for (const frame of Codec.pages(input)) send('command_request', { requests: [{
                kind: 'meeting', characterId: 42, commandId: input.token, frame }] });
        };
        prepare(request('expensive-purchase', 188565));
        const refused = await until(message => message.type === 'command_ack'
            && message.payload.results?.some(row => row.commandId === 'expensive-purchase'));
        assert.equal(refused.payload.results[0].ok, false);
        assert.equal(refused.payload.results[0].reason, 'trade_meeting_purchase_price_changed');
        assert.equal(refused.payload.results[0].priceEvidence?.purchase.units, 2,
            'the refusal carries bounded current evidence to the main-thread execution guard');
        assert.deepEqual(refused.payload.results[0].priceEvidence.offers, [],
            'an NPC-only proof does not depend on unrelated board offers');
        assert.deepEqual(refused.payload.results[0].priceEvidence.scopes, [],
            'a funded NPC alternative needs no unrelated market-category dependency');
        assert.equal(refused.payload.results[0].priceEvidence.fundingDominance, true,
            'a cheaper alternative is proven even when free money is fully committed');
        const memo = await until(message => message.priceMemo !== undefined);
        assert.equal(memo.priceMemo, true, 'the real buyer worker records the rejected physical quantity');
        assert.equal(received.some(message => message.type === 'command_request'), false,
            'an expensive purchase produces no consent for native reservation');
        const expensiveSell = request('expensive-seller-ad', 188565);
        expensiveSell.lines.forEach(line => { line.adId = 101; });
        prepare(expensiveSell);
        const refusedSell = await until(message => message.type === 'command_ack'
            && message.payload.results?.some(row => row.commandId === 'expensive-seller-ad'));
        assert.equal(refusedSell.payload.results[0].reason, 'trade_meeting_purchase_price_changed');
        assert.equal(refusedSell.payload.results[0].priceEvidence?.purchase.units, 2);
        const sellMemo = await until(message => message.token === 'expensive-seller-ad' && message.priceMemo !== undefined);
        assert.equal(sellMemo.priceMemo, true, 'the real buyer worker records the same proof for a seller ad');
        prepare(request('oversized-purchase-proof', 188565));
        const oversized = await until(message => message.type === 'command_ack'
            && message.payload.results?.some(row => row.commandId === 'oversized-purchase-proof'));
        assert.equal(oversized.payload.results[0].reason, 'trade_meeting_purchase_price_changed');
        assert.equal(oversized.payload.results[0].priceEvidence, undefined,
            'the refusal is delivered when its advisory evidence does not fit');
        assert(Buffer.byteLength(JSON.stringify(oversized)) <= 768, 'the complete meeting envelope fits');
        prepare(request('affordable-purchase', 80000));
        await until(message => message.type === 'command_request'
            && message.payload.requests?.some(row => row.commandId === 'affordable-purchase'));
        const frames = received.filter(message => message.type === 'command_request')
            .flatMap(message => message.payload.requests).map(row => row.frame);
        const consent = Codec.fromPages(frames);
        assert.equal(consent.lines.length, 2);
        assert(consent.lines.every(line => line.certificate?.[2] === 80000));
        console.log('Real meeting worker: refuses overpayment before consent, permits full-quantity NPC-equivalent purchase');
    } finally { await worker.terminate(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
