'use strict';
// The economy ledger's numbers from fixture rows: what a maintainer reads off
// a run (faucets and sinks by kind, the money closure, bands, progress).
const assert = require('node:assert/strict');
const Rules = require('../scripts/economy/ledger-rules');

const HOUR = Rules.HOUR_MS;
const T0 = 500000 * HOUR;
const bot = (characterId, level, extra = {}) => ({ characterId, accountName: `bot_${characterId}`, level, exp: 0, activity: 'hunting', locX: 0, locY: 0, locZ: 0, ...extra });
const flow = (operation, store, delta, selfId = 57) => ({ operation, store, selfId, delta, events: 1 });
const trade = (channel, totalPrice, extra = {}) => ({ channel, selfId: 1864, quantity: 1, unitPrice: totalPrice, totalPrice, sellerCharacterId: 1, buyerCharacterId: 1, occurredAt: T0, ...extra });
const stock = (store, ownerId, adena) => ({ store, ownerId, adena });

// Item facts as the reader builds them from the datapack.
const ITEMS = {
    1463: { ref: 10, npcPrice: 5, cls: 'shot', grade: 'd' },
    1835: { ref: 7, npcPrice: 3, cls: 'shot', grade: 'none' },
    1864: { ref: 100, npcPrice: 50, cls: 'material', grade: 'none' },
    1869: { ref: 200, npcPrice: 100, cls: 'material', grade: 'none' },
    1880: { ref: 500, npcPrice: 250, cls: 'material', grade: 'none' },
    2142: { ref: 1000, npcPrice: 500, cls: 'recipe', grade: 'none', productGrade: 'd' }
};

function input(overrides = {}) {
    return {
        window: { t0: T0, t1: T0 + HOUR },
        startBots: [bot(1, 25), bot(2, 25)],
        endBots: [bot(1, 25), bot(2, 25)],
        flowRows: [],
        trades: [],
        stockStart: [stock('inventory', 1, 0), stock('inventory', 2, 0)],
        stockEnd: [stock('inventory', 1, 0), stock('inventory', 2, 0)],
        items: ITEMS,
        shotRows: [],
        buyLines: [],
        recipesStart: [],
        recipesEnd: [],
        recipeGrades: {},
        shopsStart: [],
        shopsEnd: [],
        visits: [],
        ...overrides
    };
}

// Fixed buyers are paid inside the NPC sale summary and fixed sell lines inside
// the NPC purchase: each is reported as its own kind, the rest as NPC trade.
{
    const out = Rules.ledger(input({
        flowRows: [flow('inventory:sync-summary:npc_liquidation', 'inventory', 1000), flow('bot:npc-purchase', 'inventory', -700)],
        trades: [trade('static_wtb', 800), trade('fixed_wts', 300), trade('npc_buy', 400)],
        stockEnd: [stock('inventory', 1, 300)]
    }));
    assert.equal(out.flows.totals.fixedBuyers, 800);
    assert.equal(out.flows.totals.npcSales, 200);
    assert.equal(out.flows.totals.fixedSellers, -300);
    assert.equal(out.flows.totals.npcBuys, -400);
    assert.equal(out.flows.net, 300);
    // Two bots over one hour.
    assert.equal(out.flows.perBotHour.fixedBuyers, 400);
    assert.equal(out.flows.fixedBuyerShareOfFaucets, 0.8);
}

// A transfer between stores (a board settlement collected, clan dues) adds
// nothing to faucets or sinks; an operation with no kind is listed by name.
{
    const out = Rules.ledger(input({
        flowRows: [
            flow('board:settle', 'board_settlement', -500), flow('board:settle', 'inventory', 500),
            flow('clan-hall:dues', 'inventory', -40), flow('clan-hall:dues', 'clan_warehouse', 40),
            flow('bot-life:cold-owner-commit-release-batch/resolve', 'inventory', 90),
            flow('quest:reward', 'inventory', 10)
        ]
    }));
    assert.equal(out.flows.faucets, 100);
    assert.equal(out.flows.sinks, 0);
    assert.equal(out.flows.totals.clanDues, 0);
    assert.equal(out.flows.totals.huntCold, 90);
    assert.deepEqual(out.flows.unclassified, [{ operation: 'quest:reward', adena: 10 }]);
}

// The start history's rows at the run's hours are subtracted from the end history's.
{
    const rows = Rules.netFlows(
        [flow('bot:npc-purchase', 'inventory', -900), flow('item:amount', 'inventory', 50)],
        [flow('bot:npc-purchase', 'inventory', -400)]);
    assert.deepEqual(rows.map((row) => [row.operation, row.delta]), [['bot:npc-purchase', -500], ['item:amount', 50]]);
}

// The journal closes against the stock: gap 0 when the stock change equals the
// journal net, and a store the stock misses shows as the gap.
{
    const flows = [flow('inventory:sync-summary:resolve', 'inventory', 600), flow('afk-trade:create', 'inventory', -100), flow('afk-trade:create', 'afk_escrow', 100)];
    const closed = Rules.ledger(input({
        flowRows: flows,
        stockStart: [stock('inventory', 1, 1000)],
        stockEnd: [stock('inventory', 1, 1500), stock('afk_escrow', 1, 100)]
    }));
    assert.equal(closed.money.closureGap, 0);
    assert.equal(closed.money.journalNet, 600);
    const missing = Rules.ledger(input({ flowRows: flows, stockStart: [stock('inventory', 1, 1000)], stockEnd: [stock('inventory', 1, 1500)] }));
    assert.equal(missing.money.closureGap, -100);
    assert.equal(missing.money.closureGapShare, -0.1);
}

// Static merchants are not population; station crafters form their own band.
{
    const out = Rules.ledger(input({
        endBots: [bot(1, 25), bot(2, 45), bot(3, 70, { accountName: 'bot_craft_7', activity: 'crafting' }), bot(4, 30, { activity: 'merchant' })],
        startBots: []
    }));
    assert.equal(out.population.bots, 3);
    assert.equal(out.population.merchants, 1);
    assert.deepEqual(Object.keys(out.population.bands), ['d', 'c', 'station']);
    assert.equal(out.population.botHours, 3);
}

// Gini of adena: one bot of four holding everything is 0.75, equal holdings 0.
{
    assert.equal(Rules.gini([0, 0, 0, 1]), 0.75);
    assert.equal(Rules.gini([5, 5, 5, 5]), 0);
    const out = Rules.ledger(input({
        endBots: [bot(1, 25), bot(2, 25), bot(3, 25), bot(4, 25)],
        stockStart: [stock('inventory', 1, 10), stock('inventory', 2, 10), stock('inventory', 3, 10), stock('inventory', 4, 10)],
        stockEnd: [stock('inventory', 4, 40)]
    }));
    assert.equal(out.money.gini.start, 0);
    assert.equal(out.money.gini.end, 0.75);
}

// Bot-to-bot trade, its velocity over the mean stock and its share of gross adena moved.
{
    const out = Rules.ledger(input({
        flowRows: [flow('inventory:sync-summary:resolve', 'inventory', 300)],
        trades: [trade('bot_wts', 60), trade('wtb', 40), trade('npc_buy', 999)],
        stockStart: [stock('inventory', 1, 850)],
        stockEnd: [stock('inventory', 1, 1150)]
    }));
    assert.equal(out.trade.botToBot.adena, 100);
    assert.equal(out.trade.botToBot.deals, 2);
    assert.equal(out.trade.velocityPerHour, 0.1);
    assert.equal(out.trade.botToBotShareOfGross, 0.25);
}

// Progress by start level: net exp per bot-hour, level-ups, and the bots that
// left a band for the next one during the run.
{
    const out = Rules.ledger(input({
        startBots: [bot(1, 19, { exp: 1000 }), bot(2, 25, { exp: 5000 })],
        endBots: [bot(1, 21, { exp: 4000 }), bot(2, 26, { exp: 6000, activity: 'resting' }), bot(3, 30)],
        stockStart: [stock('inventory', 1, 100), stock('inventory', 2, 0)],
        stockEnd: [stock('inventory', 1, 400), stock('inventory', 2, 0)],
        trades: [trade('npc_buy', 50, { buyerCharacterId: 1 })]
    }));
    const young = out.progress.stageBands['<20'];
    assert.equal(young.bots, 1);
    assert.equal(young.expPerBotHour, 3000);
    assert.equal(young.levelUps, 2);
    assert.equal(young.bandExits, 1);
    assert.equal(young.money.deltaPerBotHour, 300);
    assert.equal(young.trade.npc_buy, 50);
    assert.equal(out.progress.stageBands['20-29'].bandEntries, 1);
    assert.equal(out.progress.bands.none.bandExits, 1);
    assert.equal(out.progress.bands.d.bandEntries, 1);
    assert.equal(out.bots.onlyAtEnd, 1);
    assert.equal(out.bots.onlyAtStart, 0);
    assert.equal(out.progress.bandsBasis, 'startLevel');
    assert.equal(out.money.bandsBasis.split(',')[0], 'endLevel');
    assert.deepEqual(out.progress.activityAtEnd, { hunting: 2, resting: 1 });
}

// A bot seen only at the end does not count its whole purse as earned: money
// deltas cover the bots at both ends; one only at the start is counted apart.
{
    const out = Rules.ledger(input({
        startBots: [bot(1, 25), bot(9, 25)],
        endBots: [bot(1, 25), bot(2, 25)],
        stockStart: [stock('inventory', 1, 100)],
        stockEnd: [stock('inventory', 1, 400), stock('inventory', 2, 5000)]
    }));
    assert.equal(out.money.bands.d.bots, 1);
    assert.equal(out.money.bands.d.deltaPerBotHour, 300);
    assert.equal(out.population.bands.d.bots, 2);
    assert.deepEqual(out.bots, { onlyAtEnd: 1, onlyAtStart: 1 });
}

// Stage bands follow the owner's grade thresholds (D split at 30, ours); a
// craft-station account is 'station' in both band sets, whatever its level.
{
    assert.deepEqual(Rules.STAGE_BANDS.map(([band]) => band), ['<20', '20-29', '30-39', '40-51', '52-60', '61-75', '76+']);
    const levels = [19, 20, 29, 30, 39, 40, 51, 52, 60, 61, 75, 76];
    assert.deepEqual(levels.map((level) => Rules.stageBandOf(bot(1, level))),
        ['<20', '20-29', '20-29', '30-39', '30-39', '40-51', '40-51', '52-60', '52-60', '61-75', '61-75', '76+']);
    const crafter = bot(1, 70, { accountName: 'bot_craft_3' });
    assert.equal(Rules.stageBandOf(crafter), 'station');
    assert.equal(Rules.bandOf(crafter), 'station');
}

// The median of an even count is the mean of the two middles: unit prices 1,2,3,4 on a 100-adena item.
{
    const out = Rules.ledger(input({
        trades: [1, 2, 3, 4].map((price) => trade('bot_wts', price, { selfId: 1864, quantity: 1 }))
    }));
    const row = out.prices.find((p) => p.channel === 'bot_wts');
    assert.equal(row.medianRatio, 0.025);
}

// Shot coverage: a D-grade bot holding 100 D-grade shots is covered for a hunt;
// one holding only no-grade shots is not covered at all.
{
    const out = Rules.ledger(input({
        endBots: [bot(1, 25, { region: 'Gludio' }), bot(2, 25, { region: 'Gludio' })],
        shotRows: [{ characterId: 1, selfId: 1463, amount: 100 }, { characterId: 2, selfId: 1835, amount: 5000 }]
    }));
    assert.deepEqual(out.shots.coverage, [{ grade: 'd', region: 'Gludio', bots: 2, holdingAny: 1, holding100: 1 }]);
    assert.equal(out.shots.coverageThreshold.shots, 100);
}

// Material value lost to the NPC: units sold to a fixed buyer are not leaking,
// units sold to the NPC leak what bots paid above the NPC price, and a material
// no bot bought in the run is counted without a price, not as zero leak.
{
    const out = Rules.ledger(input({
        flowRows: [
            flow('inventory:sync-summary:npc_liquidation', 'inventory', -30, 1864),
            flow('inventory:sync-summary:npc_liquidation', 'inventory', -4, 1869),
            flow('craft:self', 'inventory', -10, 1864), flow('craft:self', 'inventory', 1, 1880)
        ],
        trades: [
            trade('static_wtb', 2000, { selfId: 1864, quantity: 20, unitPrice: 100 }),
            trade('bot_wts', 80, { selfId: 1864, quantity: 1, unitPrice: 80 }),
            trade('bot_wts', 90, { selfId: 1864, quantity: 1, unitPrice: 90 }),
            trade('bot_wts', 70, { selfId: 1864, quantity: 1, unitPrice: 70 })
        ]
    }));
    assert.equal(out.materials.toNpcUnits, 14);
    assert.equal(out.materials.unitsPriced, 10);
    assert.equal(out.materials.leak, 10 * (80 - 50));
    assert.equal(out.materials.unitsUnpriced, 4);
    const material = out.goods.find((row) => row.class === 'material');
    assert.equal(material.toNpc, 14);
    assert.equal(material.toFixedBuyers, 20);
    assert.equal(material.craftIn, 10);
    assert.equal(material.crafted, 1);
}

// Recipes learned are the character_recipes rows new at the end, by the grade
// of what they craft; recipe books dropped in cold hunts by the same grade.
{
    const out = Rules.ledger(input({
        flowRows: [flow('bot-life:cold-owner-commit-release-batch/resolve', 'inventory', 3, 2142)],
        recipesStart: [{ characterId: 1, recipeId: 7 }],
        recipesEnd: [{ characterId: 1, recipeId: 7 }, { characterId: 1, recipeId: 8 }, { characterId: 2, recipeId: 7 }],
        recipeGrades: { 7: 'none', 8: 'd' }
    }));
    assert.deepEqual(out.recipes.learned, { d: 1, none: 1 });
    assert.equal(out.recipes.learnedTotal, 2);
    assert.deepEqual(out.recipes.dropped, { d: 3 });
}

// Bids: fills of bot buy lines against the units still wanted at the end.
{
    const out = Rules.ledger(input({
        trades: [trade('wtb', 100, { quantity: 25 })],
        buyLines: [{ count: 75, createdAt: T0 + 1 }, { count: 25, createdAt: T0 - 1 }]
    }));
    assert.deepEqual(out.bids, { fills: 1, filledUnits: 25, standingLines: 2, standingUnits: 100, postedVisible: 1, filledShare: 0.2 });
}

// Open stores and board ads per town; closed ones are not counted.
{
    const out = Rules.ledger(input({
        shopsEnd: [
            { town: 'Giran', kind: 'shop', storeType: 1, status: 'active' }, { town: 'Giran', kind: 'shop', storeType: 3, status: 'active' },
            { town: 'Giran', kind: 'sell_ad', storeType: 1, status: 'active' }, { town: 'Giran', kind: 'buy_ad', storeType: 3, status: 'closed' }
        ]
    }));
    assert.deepEqual(out.stores.end, { Giran: { shopSell: 1, shopBuy: 1, sellAd: 1, buyAd: 0 } });
}

// A metric the run does not record is listed as not computed, never as zero.
assert.ok(Rules.ledger(input()).notComputed.some((row) => /shouts/.test(row.metric)));

// The shot grade of each id follows the item's own name (soulshot, spiritshot,
// blessed spiritshot: No Grade, D .. S; beginner shots no-grade).
{
    require('../src/Global');
    const DataCache = invoke('GameServer/DataCache');
    DataCache.init({ validate: false });
    const names = new Map(DataCache.items.map((item) => [Number(item.selfId), item.template?.name]));
    const { shotGrades } = require('../scripts/economy/ledger');
    const grades = shotGrades(invoke('GameServer/Inventory/ShotStock'), invoke('GameServer/Bot/AI/GearGradeRule').GRADES);
    assert.equal(grades.get(1463), 'd');
    assert.equal(names.get(1463), 'Soulshot: D-grade');
    for (const [selfId, grade] of grades) {
        assert.match(names.get(selfId), grade === 'none' ? /No Grade/ : new RegExp(`: ${grade}[- ]grade$`, 'i'), `shot ${selfId}`);
    }
}

console.log('economy ledger ok');
