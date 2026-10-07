const assert = require('assert');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('fx-market-case');
const fs = require('node:fs');
require('../src/Global');
fixture.assertConfigured(options.default);
process.on('exit', () => fs.rmSync(fixture.directory, { recursive: true, force: true }));
const NativeChoice = require('./helpers/nativeMarketChoice');

(async () => {
const NeedsEvaluator = invoke('GameServer/Bot/Goals/NeedsEvaluator');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Market = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const Funding = invoke('GameServer/Bot/Economy/PurchaseFunding');
const { character, amount } = require('./helpers/nativeMarketFixture');
DataCache.init();
const originalProjection = AfkTrade.ownerRecords;
const spot = { id: 'starter', risk: 1, route: { id: 'starter_route' } };
const timestamp = 100000;
const item = (DataCache.items || []).find((entry) => (
    String(entry.etc?.rank || '').toLowerCase() === 'd'
    && String(entry.template?.kind || '').startsWith('Armor.')
    && entry.template?.kind !== 'Armor.Jewel'
    && Number(entry.etc?.slot) === 10
    && Number(entry.template?.price || 0) > 0
));
assert(item, 'the datapack must expose a D-grade chest fixture');

const price = Number(item.template.price);
const reserve = 5000;
const escrow = Math.floor(price * 0.85);

function gearState(adena) {
    return {
        characterId: 7,
        phase: 'cold',
        level: 20,
        adena,
        vitals: { hp: 900, maxHp: 1000, mp: 400, maxMp: 500 },
        party: {},
        stats: {
            classId: 0,
            build: { grade: 'd', classId: 0, level: 20 },
            equipment: [{ selfId: 1, slot: 7, rank: 'none', name: 'Short Sword' }],
            equipmentPlan: {
                status: 'active',
                strategy: 'market',
                target: { selfId: item.selfId, slot: 10 },
                market: { town: 'Gludio', price, reserve, sourceType: 'npc' }
            }
        }
    };
}

try {
    const walletAfterPosting = price + reserve - escrow;
    // ARCH-NOTE: FX-C1 does not read an old NPC chest plan as its chosen
    // wish. Retain the three original wallet/plan/record scenarios, with
    // genuine worker captures and the current one-leaf/E3 funding rules.
    for (const [kind, storeType, expectedEscrow] of [
        ['buy_ad', AfkTrade.BUY, escrow], ['shop', AfkTrade.SELL, 0], [null, 0, 0]
    ]) {
        AfkTrade.ownerRecords = () => kind ? [{ kind, storeType, escrowAdena: escrow, lines: [] }] : [];
        assert.strictEqual(Market.buyOrderEscrow(7), expectedEscrow, 'only a buy record owns spendable Adena');
        assert.strictEqual(Funding.budget(gearState(walletAfterPosting), Market.buyOrderEscrow(7)),
            walletAfterPosting + expectedEscrow, 'the physical wallet and genuine record type decide the budget');
        // Pure quote arithmetic keeps the original price/reserve inputs;
        // it is not an operative E1 floor or an approval to debit this item.
        assert.strictEqual(Funding.shortfall(gearState(walletAfterPosting), price, reserve, expectedEscrow),
            escrow - expectedEscrow, 'original quote shortfall: buy escrow counts, a sell shop does not');
        const native = await NativeChoice.capture(gearState(walletAfterPosting), { spot, now: timestamp }, 'escrow_original_' + kind);
        assert.strictEqual(native.read.activity.activity, 'hunting', 'the original chest plan cannot force a shopping leaf');
        assert.strictEqual(native.goals.length, 1);
        assert.strictEqual(native.goals[0].priority, 50);
        assert.strictEqual(native.goals.find(row => row.type === 'upgrade_gear'), undefined);
        assert.strictEqual(Funding.spendable(native.state, expectedEscrow, { itemId: item.selfId }), 0,
            'escrow enlarges the wallet but cannot fund an unselected old chest');
        const packet = native.state.stats.money;
        assert.strictEqual(Funding.spendable(native.state, expectedEscrow, { upperBound: true }),
            Math.max(0, walletAfterPosting + expectedEscrow - packet[2]), 'E1 reserve is the actual worker packet field');
    }
    AfkTrade.ownerRecords = originalProjection;
    // Independent physical publication/withdrawal seam with the exact
    // original7/chest/85%/initial wallet. No fake funded choice is supplied.
    Database.init();
    await character(Database, 7, 'EscrowBuyer', 'bot_7');
    await Database.setItem(7, { selfId: 57, name: 'Adena', amount: price + reserve });
    await Life.init(); await AfkTrade.init();
    await Life.upsertState({ ...gearState(price + reserve), accountName: 'bot_7', name: 'EscrowBuyer',
        inventory: Life.inventorySummaryFromItems(await Database.fetchItems(7)), timing: {} }, 'fixture_wtb_quote');
    const posted = await AfkTrade.publishBot(7, { kind: 'buy_ad', storeType: AfkTrade.BUY,
        title: 'WTB chest', town: 'Gludio', locX: 0, locY: 0, locZ: 0,
        lines: [{ selfId: item.selfId, name: item.template.name, count: 1, price: escrow, enchant: 0 }] });
    assert.strictEqual(Number(posted.escrowAdena), escrow);
    assert.strictEqual(amount(await Database.fetchItems(7), 57), walletAfterPosting);
    assert.strictEqual(Market.buyOrderEscrow(7), escrow);
    assert.strictEqual(Funding.budget(Life.snapshot(7), Market.buyOrderEscrow(7)), price + reserve);
    assert.strictEqual(Number((await AfkTrade.closeBotRecord(7, posted.id, { expectedRevision: posted.revision })).closed), 1);
    assert.strictEqual(amount(await Database.fetchItems(7), 57), price + reserve, 'every held Adena comes back once');
    assert.strictEqual(amount(await Database.fetchItems(7), item.selfId), 0, 'a withdrawn order never acquires its chest');
    assert.strictEqual(Market.buyOrderEscrow(7), 0);
    console.log(JSON.stringify({ chest: item.selfId, price, declaredReserve: reserve, escrow,
        physicalWalletAfterPosting: walletAfterPosting, physicalWalletAfterRefund: price + reserve, chestAcquired: 0 }));
    console.log('Bot goal WTB escrow checks passed');
} finally {
    AfkTrade.ownerRecords = originalProjection;
    await AfkTrade._resetForTests(); Market._resetForTests();
    await Database.close();
}
})().catch(error => { console.error(error); process.exitCode = 1; });
