'use strict';
const assert = require('node:assert/strict');
const { useRate } = require('./helpers/progressionRate');
require('./helpers/databaseIsolation');
process.env.L2NODE_CONFIG_FILE = 'config/default.ini';
useRate('x50');
delete process.env.L2NODE_SHARED_CONFIG_FILE;
require('../src/Global');
invoke('GameServer/DataCache').init();
const native = require('./helpers/workerEconomyDecision');
const Decision = require('../src/GameServer/Bot/Population/ColdEconomyDecision');
const Intent = require('../src/GameServer/Bot/Economy/TradeIntent');
const Funding = require('../src/GameServer/Bot/Economy/PurchaseFunding');
const fixture = require('./fixtures/gear_purchase_state.json');

async function run() {
    const timestamp = Date.now(), offset = timestamp - fixture.timestamp;
    const shift = value => typeof value === 'number' && value > 1700000000000 && value < 2000000000000
        ? value + offset : Array.isArray(value) ? value.map(shift)
            : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, shift(child)])) : value;
    const state = shift(fixture.state), boardRows = structuredClone(fixture.boardRows);
    // T43 table: shots now pay for this level-53 archer; it holds its shot stock, so the gear source decides.
    state.inventory[1463] = { selfId: 1463, name: 'Soulshot: D-grade', amount: 1000, stackable: true };
    const crystalSupply = await native(state, { timestamp, boardRows, nativeRoutes: true });
    const crystalLeaf = Decision.compact(crystalSupply.decision).activity;
    assert.equal(crystalLeaf.sourceType, 'npc', 'a small crystal lot must not replace the reliable full equipment supply');
    const input = invoke('GameServer/Item/ItemTemplateIndex').find(invoke('GameServer/DataCache').items, crystalLeaf.itemId);
    assert.equal(invoke('GameServer/Bot/Economy/BotCrystallization').reward(input)?.crystalId, 1458);

    // A complete equipment quote still exercises the selected finite purchase
    // above general willingness, without depending on the old crystal source.
    const itemId = 233, amount = 1, price = 3000000;
    const [lineId] = boardRows[0][1][6][0];
    boardRows[0][1][6][0] = [lineId, itemId, 0, amount, price, null, 0];
    const capture = await native(state, { timestamp, boardRows, nativeRoutes: true });
    const leaf = Decision.compact(capture.decision).activity;
    assert.equal(leaf.sourceType, 'afk'); assert.equal(leaf.itemId, itemId);
    assert.equal(leaf.amount, amount); assert.equal(leaf.unitPrice, price);
    const standing = capture.tradeIntents.find(row => row.itemId === leaf.itemId);
    assert(standing.worth < leaf.unitPrice, 'native mandatory equipment graph chooses the quote above general willingness');
    const point = invoke('GameServer/World/TownRespawn').towns.dion_town;
    const authority = require('../src/GameServer/Bot/Economy/EconomyCommit').authority(state);
    const request = { token: 'selected-equipment-purchase', actorA: state.characterId, actorB: 2004570,
        seqA: 1, seqB: 1, town: 'Dion', point: { locX: point.locX, locY: point.locY, locZ: point.locZ },
        parties: [0, 1].map(() => ({ ...authority, sequence: 1, needRevision: authority.revision,
            route: { fee: 0, scroll: false, method: 'walk', durationMs: 0 } })),
        lines: [{ payer: 0, itemId: 900001, selfId: itemId, count: amount, price, enchant: 0,
            adId: 8001, adRevision: 1, certificate: null }] };
    const prepared = await native(state, { timestamp, boardRows, meetingRequest: request });
    const certificate = Intent.decode(prepared.request.lines[0].certificate);
    assert.equal(certificate.itemId, itemId); assert.equal(certificate.amount, amount); assert.equal(certificate.price, price);
    const spendable = Funding.spendable({ ...state, stats: { ...state.stats, money: capture.statsPacket.money } }, 0,
        { r: certificate.valueRate, survivalCost: prepared.request.parties[0].survivalCost });
    assert(spendable >= amount * price + prepared.request.parties[0].route.fee,
        'actual native certificate reaches the physical wallet gate at the same funded priority');
    assert.equal(state.inventory[1458].amount, 862, 'preparation leaves physical inventory unchanged');
    assert.equal(state.inventory[itemId], undefined, 'preparation does not grant the selected equipment');
    const excess = structuredClone(request); excess.token = 'excess-equipment-purchase'; excess.lines[0].count = amount + 1;
    await assert.rejects(native(state, { timestamp, boardRows, meetingRequest: excess }), /trade_meeting_need_changed/,
        'the selected finite supply does not authorize excess quantity');
    console.log('PASS actual worker crystal supply, selected equipment purchase, native funding and finite quantity refusal');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
