'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
process.env.L2NODE_CONFIG_FILE = 'config/default.ini';
process.env.L2NODE_PROGRESSION_RATE = 'x50';
delete process.env.L2NODE_SHARED_CONFIG_FILE;
require('../src/Global');
invoke('GameServer/DataCache').init();
const native = require('./helpers/workerEconomyDecision');
const Intent = require('../src/GameServer/Bot/Economy/TradeIntent');
const Meeting = require('../src/GameServer/AfkTrade/TradeMeetingCodec');
const Funding = require('../src/GameServer/Bot/Economy/PurchaseFunding');
const fixture = require('./fixtures/luxury_purchase_states.json');

// Two native buyer snapshots that kept requesting the same crystal quote:
// one lost the exchange behind its craft alternative; the other lost a
// second funded root behind the public board's one-row-per-item projection.
(async () => {
    const timestamp = Date.now(), offset = timestamp - fixture.timestamp;
    const shift = value => typeof value === 'number' && value > 1700000000000 && value < 2000000000000
        ? value + offset : Array.isArray(value) ? value.map(shift)
            : value && typeof value === 'object'
                ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, shift(child)])) : value;
    const tables = [{ name: 'board', rows: fixture.boardRows }, { name: 'personas', rows: fixture.personaRows }]
        .map(table => ({ ...table, from: null, to: 0, full: true, removed: [], last: true }));
    for (const saved of fixture.states) {
        const state = shift(saved);
        // T43 table: C spiritshots now pay for 2006424; it holds its shot stock, so the crystal roots decide.
        if (state.characterId === 2006424) state.inventory[2511] = { ...state.inventory[2511], amount: 300 };
        const before = JSON.stringify(state);
        const secondRoot = state.characterId === 2007229, count = secondRoot ? 260 : 370;
        const seller = 2007106, side = state.characterId < seller ? 0 : 1;
        const request = { token: `luxury-crystal-${state.characterId}`,
            actorA: Math.min(state.characterId, seller), actorB: Math.max(state.characterId, seller),
            seqA: 1, seqB: 1, town: 'Giran', point: state.loc,
            parties: [0, 1].map(() => ({ phase: 'cold', hotAt: 0, revision: state.simulation.revision,
                needRevision: state.simulation.revision, sequence: 1,
                route: { fee: 0, scroll: false, method: 'walk', durationMs: 0 } })),
            lines: [{ payer: side, itemId: 90000001, selfId: 1458, count, price: 318,
                enchant: 0, adId: 1758043, adRevision: 3, certificate: null }] };
        const input = { timestamp, tables, meetingRequest: request };
        const prepared = await native(state, input);
        const certificate = Intent.decode(prepared.request.lines[0].certificate);
        assert.equal(certificate.key, secondRoot ? 'power:915:3' : 'power:854:2');
        assert.equal(certificate.itemId, 1458); assert.equal(certificate.amount, count);
        assert.equal(certificate.price, 318);
        const publicCrystal = prepared.trace.intents.find(row => row.itemId === 1458);
        assert(publicCrystal, 'the chosen exchange remains visible beside a craft alternative');
        assert.equal(publicCrystal.amount, secondRoot ? 117 : 370);
        assert.equal(publicCrystal.quote.price, 318, 'native plan compaction retains the real quote');
        if (secondRoot) {
            assert.equal(prepared.trace.activity.amount, 117);
            assert.notEqual(publicCrystal.key, certificate.key,
                'the second funded root receives its own certificate without enlarging the first root');
        }
        assert.deepEqual(Meeting.fromPages(prepared.frames).lines[0].certificate,
            prepared.request.lines[0].certificate, 'the certificate survives the real bounded transport');
        assert(Funding.spendable(state, 0, { r: certificate.valueRate }) >= count * 318,
            'the certificate spends only the actual native wallet at this root priority');
        const excess = structuredClone(request); excess.lines[0].count = 371;
        await assert.rejects(native(state, { ...input, meetingRequest: excess }), /trade_meeting_need_changed/,
            'neither root nor the craft alternative authorizes excess crystals');
        assert.equal(JSON.stringify(state), before, 'preparation changes no physical inventory or saved plan');
        assert.deepEqual(prepared.forbiddenLoaded, [], 'the native worker opens no database or main world');
    }
    console.log('PASS native luxury crystal consent, alternative craft visibility, independent funded roots and finite refusal');
})().catch(error => { console.error(error.stack, error.meetingTrace); process.exitCode = 1; });
