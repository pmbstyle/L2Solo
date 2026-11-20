'use strict';
// The economy ledger: what one run did to the world's money, read from the
// run's start and end world snapshots, its economy journal and its trade log,
// per bot-hour and per band. Pure functions of plain rows: the reader
// (scripts/economy/ledger.js) does every sqlite read, tests feed fixtures.
const { gradeForLevel, levelForGrade } = require('../../src/GameServer/Bot/AI/GearGradeRule');

const SCHEMA = 'l2solo.economy-ledger/1';
const HOUR_MS = 60 * 60 * 1000;
const ADENA = 57;
// Static merchants stand in town the whole run: scenery, not population.
const MERCHANT_ACTIVITY = 'merchant';
// The level-70 craft-station crafters hold no adena of their own and craft for
// customers; counted as their own band, apart from the A-grade hunters.
const STATION_ACCOUNT_PREFIX = 'bot_craft_';
const STATION = 'station';
// Stage bands of the progression evidence: the grade bands of GearGradeRule
// (thresholds read from it) with grade D split at this level. The split is our
// choice, not C4's: the two populated halves of grade D.
const GRADE_D_SPLIT_LEVEL = 30;
const STAGE_BANDS = (() => {
    const from = [1, levelForGrade('d'), GRADE_D_SPLIT_LEVEL, levelForGrade('c'), levelForGrade('b'), levelForGrade('a'), levelForGrade('s')];
    return from.map((level, at) => [at === 0 ? `<${from[1]}` : at === from.length - 1 ? `${level}+` : `${level}-${from[at + 1] - 1}`, level]);
})();

// Each journal operation that creates or destroys adena, by what it stands for.
// Fixed buyers' payments land inside the NPC sale summary and fixed sell lines
// inside the NPC purchase: both are split out by the trade log's channel.
const OPERATION_KIND = Object.freeze({
    'inventory:sync-summary:npc_liquidation': 'npcSales',
    'bot:npc-purchase': 'npcBuys',
    // A crafter paying the store for consigned gear it sold: journalled as the
    // fixed_wts purchase it stands for, so split out with the fixed sell lines.
    'bot:consignment-pay': 'npcBuys',
    'bot-life:cold-owner-commit-release-batch/resolve': 'huntCold',
    'inventory:sync-summary:resolve': 'huntCold',
    'inventory:sync-summary:trip_payment': 'fares',
    // A meeting's route reserve spent on the legs: the fares of trade meetings.
    'board:meeting-leg': 'meetingFares',
    'bot:improvement': 'improvement',
    'clan-hall:dues': 'clanDues'
});
// Hot bodies and the player write through generic item operations: loot, NPC
// trade and consumption cannot be told apart there.
const HOT_UNLABELED = /^(item:|buffered-character:)/;
const FLOW_KINDS = ['fixedBuyers', 'huntCold', 'hotUnlabeled', 'npcSales', 'npcBuys', 'fixedSellers',
    'fares', 'meetingFares', 'improvement', 'clanDues', 'other'];
const FIXED_BUYER_CHANNEL = 'static_wtb';
const FIXED_SELLER_CHANNEL = 'fixed_wts';
// Bot-to-bot trade: a bot buys from a bot's store, or fills a bot's buy line.
const BOT_TO_BOT_CHANNELS = ['bot_wts', 'wtb'];

const GROUP_ORDER = ['none', 'd', 'c', 'b', 'a', 's', STATION, ...STAGE_BANDS.map(([band]) => band)];
const byGroupOrder = ([a], [b]) => GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b);

const round = (value, digits = 1) => {
    const scale = 10 ** digits;
    return Math.round(Number(value || 0) * scale) / scale;
};
const ratio = (value, base) => (base ? value / base : 0);
const add = (map, key, value) => map.set(key, (map.get(key) || 0) + value);

function window({ t0, t1, warmupIncluded = false, endBasis }) {
    if (!(t1 > t0)) throw Error(`window: end ${t1} is not after start ${t0}`);
    return { t0, t1, hours: (t1 - t0) / HOUR_MS, fromHour: Math.floor(t0 / HOUR_MS), warmupIncluded, endBasis };
}

// Journal rows of the run: the end history's rows from the run's first hour
// minus what the start history already held at those hours.
function netFlows(endRows, startRows) {
    const rows = new Map();
    const key = (row) => `${row.operation}\u0000${row.store}\u0000${row.selfId}`;
    for (const row of endRows) rows.set(key(row), { operation: row.operation, store: row.store,
        selfId: Number(row.selfId), delta: Number(row.delta), events: Number(row.events) });
    for (const row of startRows) {
        const held = rows.get(key(row)) || { operation: row.operation, store: row.store, selfId: Number(row.selfId), delta: 0, events: 0 };
        rows.set(key(row), { ...held, delta: held.delta - Number(row.delta), events: held.events - Number(row.events) });
    }
    return [...rows.values()];
}

function bandOf(bot) {
    if (String(bot.accountName || '').startsWith(STATION_ACCOUNT_PREFIX)) return STATION;
    return gradeForLevel(bot.level);
}

// The stage band of a bot: 'station' for craft-station accounts, as bandOf does.
function stageBandOf(bot) {
    if (String(bot.accountName || '').startsWith(STATION_ACCOUNT_PREFIX)) return STATION;
    let name = STAGE_BANDS[0][0];
    for (const [band, from] of STAGE_BANDS) if (Number(bot.level) >= from) name = band;
    return name;
}

function population(endBots) {
    const bots = endBots.filter((bot) => bot.activity !== MERCHANT_ACTIVITY);
    return { bots, merchants: endBots.length - bots.length };
}

function channelTotals(trades) {
    const channels = {};
    for (const trade of trades) {
        const row = channels[trade.channel] ||= { deals: 0, units: 0, adena: 0 };
        row.deals++;
        row.units += Number(trade.quantity);
        row.adena += Number(trade.totalPrice);
    }
    return channels;
}

// Net adena per journal operation, summed over every store: a transfer
// between stores (a settlement, an escrow, clan dues) nets to zero.
function adenaByOperation(flowRows) {
    const byOperation = new Map();
    for (const row of flowRows) if (row.selfId === ADENA) add(byOperation, row.operation, row.delta);
    return byOperation;
}

function classifyFlows(flowRows, trades) {
    const channels = channelTotals(trades);
    const channelAdena = (channel) => channels[channel]?.adena || 0;
    const totals = Object.fromEntries(FLOW_KINDS.map((kind) => [kind, 0]));
    const unclassified = [];
    let faucets = 0, sinks = 0, gross = 0;
    for (const [operation, adena] of adenaByOperation(flowRows)) {
        gross += Math.abs(adena);
        if (adena > 0) faucets += adena; else sinks += adena;
        const kind = OPERATION_KIND[operation] || (HOT_UNLABELED.test(operation) ? 'hotUnlabeled' : 'other');
        totals[kind] += adena;
        if (kind === 'other' && adena !== 0) unclassified.push({ operation, adena });
    }
    totals.fixedBuyers = channelAdena(FIXED_BUYER_CHANNEL);
    totals.npcSales -= totals.fixedBuyers;
    totals.fixedSellers = -channelAdena(FIXED_SELLER_CHANNEL);
    totals.npcBuys -= totals.fixedSellers;
    unclassified.sort((a, b) => Math.abs(b.adena) - Math.abs(a.adena));
    return { totals, faucets, sinks, net: faucets + sinks, gross, unclassified, channels };
}

// Adena held in every store the journal watches: rows { store, ownerId, adena }.
function moneyStock(rows) {
    const byStore = {}, byOwner = new Map();
    let total = 0;
    for (const row of rows) {
        const adena = Number(row.adena || 0);
        total += adena;
        byStore[row.store] = (byStore[row.store] || 0) + adena;
        if (row.ownerId != null) add(byOwner, Number(row.ownerId), adena);
    }
    return { total, byStore, byOwner };
}

// Gini coefficient of holdings: 0 when all hold the same, (n-1)/n when one holds all.
function gini(values) {
    const sorted = values.map(Number).sort((a, b) => a - b);
    const n = sorted.length;
    let sum = 0, weighted = 0;
    sorted.forEach((value, at) => { sum += value; weighted += (at + 1) * value; });
    return n && sum ? (2 * weighted) / (n * sum) - (n + 1) / n : 0;
}

// The bot on our side of a trade: the seller to a fixed buyer, the buyer otherwise.
const botSide = (trade) => Number(trade.channel === FIXED_BUYER_CHANNEL ? trade.sellerCharacterId : trade.buyerCharacterId);

// Per group: bots, money held at both ends, what each group's bots paid or
// were paid per channel, and (with a start snapshot) exp and level progress.
function groupStats(members, groupOf, { hours, startStock, endStock, trades, startById, groupAtEnd }) {
    const groups = {};
    const groupByBot = new Map();
    for (const bot of members) {
        const name = groupOf(bot);
        groupByBot.set(bot.characterId, name);
        const group = groups[name] ||= { bots: 0, adenaStart: 0, adenaEnd: 0, exp: 0, levelUps: 0, entries: 0, exits: 0, trade: {}, activityAtEnd: {} };
        group.bots++;
        group.adenaStart += startStock.byOwner.get(bot.characterId) || 0;
        group.adenaEnd += endStock.byOwner.get(bot.characterId) || 0;
        group.activityAtEnd[bot.activity] = (group.activityAtEnd[bot.activity] || 0) + 1;
        const start = startById?.get(bot.characterId);
        if (start) {
            group.exp += Number(bot.exp) - Number(start.exp);
            group.levelUps += Math.max(0, Number(bot.level) - Number(start.level));
        }
    }
    if (groupAtEnd) {
        for (const bot of members) {
            const from = groupOf(bot), to = groupAtEnd(bot);
            if (from === to) continue;
            groups[from].exits++;
            (groups[to] ||= { bots: 0, adenaStart: 0, adenaEnd: 0, exp: 0, levelUps: 0, entries: 0, exits: 0, trade: {}, activityAtEnd: {} }).entries++;
        }
    }
    for (const trade of trades) {
        const name = groupByBot.get(botSide(trade));
        if (name !== undefined) groups[name].trade[trade.channel] = (groups[name].trade[trade.channel] || 0) + Number(trade.totalPrice);
    }
    const out = {};
    for (const [name, group] of Object.entries(groups).sort(byGroupOrder)) {
        const botHours = group.bots * hours;
        out[name] = {
            bots: group.bots,
            botHours: round(botHours, 2),
            meanStart: round(ratio(group.adenaStart, group.bots), 0),
            meanEnd: round(ratio(group.adenaEnd, group.bots), 0),
            deltaPerBotHour: round(ratio(group.adenaEnd - group.adenaStart, botHours), 0),
            trade: Object.fromEntries(Object.entries(group.trade).map(([channel, adena]) => [channel, round(ratio(adena, botHours), 0)])),
            exp: group.exp, levelUps: group.levelUps, entries: group.entries, exits: group.exits, activityAtEnd: group.activityAtEnd
        };
    }
    return out;
}

const perBotHour = (totals, botHours) => Object.fromEntries(Object.entries(totals).map(([kind, adena]) => [kind, round(ratio(adena, botHours))]));

function moneySection({ bots, startStock, endStock, flows, hours, bands }) {
    const meanStock = (startStock.total + endStock.total) / 2;
    const delta = endStock.total - startStock.total;
    const closureGap = delta - flows.net;
    return {
        stockStart: startStock.total,
        stockEnd: endStock.total,
        delta,
        journalNet: flows.net,
        closureGap,
        closureGapShare: round(ratio(closureGap, startStock.total), 6),
        growthPerHour: round(ratio(flows.net / hours, meanStock), 6),
        growthBasis: 'journal net per hour / mean of start and end stock',
        byStore: endStock.byStore,
        bandsBasis: 'endLevel, bots present at both ends',
        bands: Object.fromEntries(Object.entries(bands).map(([name, group]) => [name,
            { bots: group.bots, meanStart: group.meanStart, meanEnd: group.meanEnd, deltaPerBotHour: group.deltaPerBotHour }])),
        gini: {
            start: round(gini(bots.map((bot) => startStock.byOwner.get(bot.characterId) || 0)), 4),
            end: round(gini(bots.map((bot) => endStock.byOwner.get(bot.characterId) || 0)), 4)
        }
    };
}

function tradeSection({ flows, botHours, hours, meanStock, bands }) {
    const channels = Object.fromEntries(Object.entries(flows.channels).map(([name, row]) => [name, { ...row, adena: round(row.adena, 0) }]));
    const botToBot = { deals: 0, units: 0, adena: 0 };
    for (const name of BOT_TO_BOT_CHANNELS) {
        const row = flows.channels[name];
        if (!row) continue;
        botToBot.deals += row.deals;
        botToBot.units += row.units;
        botToBot.adena += row.adena;
    }
    return {
        channels,
        botToBot: { ...botToBot, perBotHour: round(ratio(botToBot.adena, botHours)) },
        velocityPerHour: round(ratio(botToBot.adena / hours, meanStock), 6),
        botToBotShareOfGross: round(ratio(botToBot.adena, botToBot.adena + flows.gross), 6),
        bandsBasis: 'endLevel',
        bands: Object.fromEntries(Object.entries(bands).map(([name, group]) => [name, group.trade]))
    };
}

// Progress by start level: realized exp and money per bot-hour, so realized
// income splits into time spent and income per hour of it.
function progressGroups(groups) {
    return Object.fromEntries(Object.entries(groups).map(([name, group]) => [name, {
        bots: group.bots,
        botHours: group.botHours,
        expPerBotHour: round(ratio(group.exp, group.botHours), 0),
        levelUps: group.levelUps,
        bandEntries: group.entries,
        bandExits: group.exits,
        money: { meanStart: group.meanStart, meanEnd: group.meanEnd, deltaPerBotHour: group.deltaPerBotHour },
        trade: group.trade,
        activityAtEnd: group.activityAtEnd
    }]));
}

// What each journal operation does to goods (item units, not adena): units a
// run brought into the world, destroyed, or moved to or from an NPC.
const GOODS_KIND = Object.freeze({
    'bot-life:cold-owner-commit-release-batch/resolve': ['drop', 'used'],
    'inventory:sync-summary:resolve': ['drop', 'used'],
    'inventory:sync-summary:npc_liquidation': [null, 'toNpc'],
    'bot:npc-purchase': ['fromNpc', null],
    'craft:self': ['crafted', 'craftIn'],
    'craft:customer': ['crafted', 'craftIn'],
    'crystalize': ['crystalOut', 'crystalIn'],
    'item:cold-safe-enchant': [null, 'enchantUsed'],
    'recipe:cold-learn': [null, 'learned'],
    'bot:improvement': ['improveIn', 'improveOut'],
    'inventory:sync-summary:trip_payment': [null, 'tripUsed']
});
const GOODS_FIELDS = ['drop', 'used', 'crafted', 'craftIn', 'crystalOut', 'crystalIn', 'enchantUsed', 'learned',
    'toNpc', 'toFixedBuyers', 'fromNpc', 'fromFixedSellers', 'improveIn', 'improveOut', 'tripUsed', 'hotIn', 'hotOut'];
const GEAR_CLASSES = ['weapon', 'armor', 'jewel'];
const CLASS_BY_KIND = { 'Armor.Jewel': 'jewel', 'Other.Material': 'material', 'Other.Recipe': 'recipe', 'Other.Shot': 'shot',
    'Other.Potion': 'potion', 'Other.Scroll': 'scroll', 'Other.Spellbook': 'spellbook' };
const UNKNOWN_ITEM = Object.freeze({ ref: 0, npcPrice: 0, cls: 'other', grade: 'none' });
// Our choice, not C4's: a holder of this many shots of its own grade counts as covered for a hunt; any shot at all is the weaker line.
const SHOTS_FOR_A_HUNT = 100;

// The item class the ledger groups goods by, from the item template's kind and name.
function itemClass({ kind, name } = {}) {
    const text = String(kind || '');
    if (text.startsWith('Weapon.')) return 'weapon';
    if (CLASS_BY_KIND[text]) return CLASS_BY_KIND[text];
    if (text.startsWith('Armor.')) return 'armor';
    if (/^Crystal: /.test(String(name || ''))) return 'crystal';
    return 'other';
}

const itemOf = (items, selfId) => items[selfId] || UNKNOWN_ITEM;
const median = (values) => {
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// Units per (kind of goods flow, item), signed so each kind counts up: a drop
// adds units, a sale to an NPC removes them and counts as a positive toNpc.
// Items moved between stores inside one operation net to nothing.
function goodsMoves(flowRows, trades) {
    const net = new Map();
    for (const row of flowRows) if (row.selfId !== ADENA) add(net, `${row.operation}\u0000${row.selfId}`, row.delta);
    const moves = [];
    for (const [key, delta] of net) {
        if (!delta) continue;
        const [operation, id] = key.split('\u0000');
        const kinds = GOODS_KIND[operation] || (HOT_UNLABELED.test(operation) ? ['hotIn', 'hotOut'] : null);
        if (!kinds) continue;
        const [up, down] = kinds;
        const [kind, units] = delta > 0 ? (up ? [up, delta] : [down, -delta]) : (down ? [down, -delta] : [up, delta]);
        moves.push({ kind, selfId: Number(id), units });
    }
    // Fixed buyers and fixed sell lines trade inside the NPC operations: split by channel.
    for (const trade of trades) {
        const units = Number(trade.quantity);
        if (trade.channel === FIXED_BUYER_CHANNEL) moves.push({ kind: 'toFixedBuyers', selfId: Number(trade.selfId), units }, { kind: 'toNpc', selfId: Number(trade.selfId), units: -units });
        if (trade.channel === FIXED_SELLER_CHANNEL) moves.push({ kind: 'fromFixedSellers', selfId: Number(trade.selfId), units }, { kind: 'fromNpc', selfId: Number(trade.selfId), units: -units });
    }
    return moves;
}

function goodsTable(moves, items) {
    const rows = new Map();
    for (const move of moves) {
        const item = itemOf(items, move.selfId);
        const key = `${item.cls}/${item.grade}`;
        const row = rows.get(key) || rows.set(key, { class: item.cls, grade: item.grade, units: {}, refValue: {} }).get(key);
        row.units[move.kind] = (row.units[move.kind] || 0) + move.units;
        row.refValue[move.kind] = (row.refValue[move.kind] || 0) + move.units * item.ref;
    }
    return [...rows.values()].sort((a, b) => a.class.localeCompare(b.class) || GROUP_ORDER.indexOf(a.grade) - GROUP_ORDER.indexOf(b.grade))
        .map((row) => ({ class: row.class, grade: row.grade,
            ...Object.fromEntries(GOODS_FIELDS.filter((field) => row.units[field]).map((field) => [field, row.units[field]])),
            refValue: Object.fromEntries(GOODS_FIELDS.filter((field) => row.units[field]).map((field) => [field, round(row.refValue[field], 0)])) }));
}

const unitsOf = (moves, items, kind, test) => moves.filter((move) => move.kind === kind && test(itemOf(items, move.selfId))).reduce((sum, move) => sum + move.units, 0);
const isBotToBot = (trade) => BOT_TO_BOT_CHANNELS.includes(trade.channel);

function gearSection(moves, trades, items) {
    const gear = (item) => GEAR_CLASSES.includes(item.cls);
    const secondHand = trades.filter((trade) => isBotToBot(trade) && gear(itemOf(items, trade.selfId)));
    return {
        toNpcUnits: unitsOf(moves, items, 'toNpc', gear),
        toNpcRef: round(moves.filter((move) => move.kind === 'toNpc' && gear(itemOf(items, move.selfId))).reduce((sum, move) => sum + move.units * itemOf(items, move.selfId).ref, 0), 0),
        boughtNpcUnits: unitsOf(moves, items, 'fromNpc', gear),
        secondHandDeals: secondHand.length,
        secondHandUnits: secondHand.reduce((sum, trade) => sum + Number(trade.quantity), 0)
    };
}

// Material value lost to the NPC: units sold to an NPC (not to a fixed buyer)
// times what a bot paid above the NPC price in this run's deals. A material no
// bot bought in the run has no bot price: counted apart, never as zero leak.
function materialsSection(moves, trades, items) {
    const botPrices = new Map();
    for (const trade of trades) if (isBotToBot(trade)) (botPrices.get(Number(trade.selfId)) || botPrices.set(Number(trade.selfId), []).get(Number(trade.selfId))).push(Number(trade.unitPrice));
    const toNpc = new Map();
    for (const move of moves) if (move.kind === 'toNpc' && itemOf(items, move.selfId).cls === 'material') add(toNpc, move.selfId, move.units);
    const out = { toNpcUnits: 0, toNpcValue: 0, leak: 0, unitsPriced: 0, unitsUnpriced: 0 };
    for (const [selfId, units] of toNpc) {
        if (units <= 0) continue;
        const npcPrice = itemOf(items, selfId).npcPrice;
        out.toNpcUnits += units;
        out.toNpcValue += units * npcPrice;
        const prices = botPrices.get(selfId);
        if (!prices) {
            out.unitsUnpriced += units;
            continue;
        }
        out.unitsPriced += units;
        out.leak += units * Math.max(0, median(prices) - npcPrice);
    }
    return { ...out, toNpcValue: round(out.toNpcValue, 0), leak: round(out.leak, 0), botPriceBasis: 'median unit price of this run\'s bot-to-bot deals' };
}

// Bots holding shots of their own grade (soulshots, spiritshots and blessed
// spiritshots together), per grade band and the region their location respawns in.
function shotCoverage(items, bots, shotRows, bandOfBot) {
    const own = new Map();
    for (const row of shotRows) {
        const band = bandOfBot.get(Number(row.characterId));
        if (band && itemOf(items, row.selfId).grade === band) add(own, Number(row.characterId), Number(row.amount));
    }
    const cells = new Map();
    for (const bot of bots) {
        const grade = bandOfBot.get(bot.characterId);
        if (grade === STATION) continue;
        const key = `${grade}\u0000${bot.region}`;
        const cell = cells.get(key) || cells.set(key, { grade, region: bot.region, bots: 0, holdingAny: 0, holding100: 0 }).get(key);
        const held = own.get(bot.characterId) || 0;
        cell.bots++;
        if (held > 0) cell.holdingAny++;
        if (held >= SHOTS_FOR_A_HUNT) cell.holding100++;
    }
    return [...cells.values()].sort((a, b) => GROUP_ORDER.indexOf(a.grade) - GROUP_ORDER.indexOf(b.grade) || b.bots - a.bots);
}

function shotsSection(moves, items, bots, shotRows, bandOfBot) {
    const shot = (item) => item.cls === 'shot';
    return {
        coverageThreshold: { shots: SHOTS_FOR_A_HUNT, note: 'ours, not C4: holding100 counts bots holding at least this many shots of their own grade' },
        coverage: shotCoverage(items, bots, shotRows, bandOfBot),
        used: unitsOf(moves, items, 'used', shot),
        boughtNpc: unitsOf(moves, items, 'fromNpc', shot),
        boughtFixed: unitsOf(moves, items, 'fromFixedSellers', shot),
        crafted: unitsOf(moves, items, 'crafted', shot),
        soldNpc: unitsOf(moves, items, 'toNpc', shot)
    };
}

// Price against the item's datapack price, per channel, class and grade:
// the value index (all paid / all ref value) and the median unit ratio.
function priceIndex(trades, items) {
    const cells = new Map();
    for (const trade of trades) {
        const item = itemOf(items, trade.selfId);
        if (!item.ref) continue;
        const key = `${trade.channel}\u0000${item.cls}\u0000${item.grade}`;
        const cell = cells.get(key) || cells.set(key, { channel: trade.channel, class: item.cls, grade: item.grade, deals: 0, units: 0, paid: 0, refValue: 0, ratios: [] }).get(key);
        cell.deals++;
        cell.units += Number(trade.quantity);
        cell.paid += Number(trade.totalPrice);
        cell.refValue += item.ref * Number(trade.quantity);
        cell.ratios.push(Number(trade.unitPrice) / item.ref);
    }
    return [...cells.values()].sort((a, b) => a.channel.localeCompare(b.channel) || b.deals - a.deals)
        .map((cell) => ({ channel: cell.channel, class: cell.class, grade: cell.grade, deals: cell.deals, units: cell.units,
            valueIndex: round(cell.paid / cell.refValue, 3), medianRatio: round(median(cell.ratios), 3) }));
}

// Bot buy lines: filled in the run against those still standing at the end.
// Lines opened and closed inside the run leave no row, so this is a lower bound of bids posted.
function bidsSection(trades, buyLines, t0) {
    const fills = trades.filter((trade) => trade.channel === 'wtb');
    const filledUnits = fills.reduce((sum, trade) => sum + Number(trade.quantity), 0);
    const standingUnits = buyLines.reduce((sum, line) => sum + Number(line.count), 0);
    return {
        fills: fills.length,
        filledUnits,
        standingLines: buyLines.length,
        standingUnits,
        postedVisible: buyLines.filter((line) => Number(line.createdAt) >= t0).length,
        filledShare: round(ratio(filledUnits, filledUnits + standingUnits), 4)
    };
}

// Cold drops of recipe books by the grade of what they craft, and recipes learned
// (character_recipes rows new at the end) by the same grade.
function recipesSection(moves, items, recipesStart, recipesEnd, recipeGrades) {
    const dropped = {}, learned = {};
    let droppedTotal = 0, learnedTotal = 0;
    for (const move of moves) {
        const item = itemOf(items, move.selfId);
        if (move.kind !== 'drop' || item.cls !== 'recipe') continue;
        const grade = item.productGrade || 'none';
        dropped[grade] = (dropped[grade] || 0) + move.units;
        droppedTotal += move.units;
    }
    const known = new Set(recipesStart.map((row) => `${row.characterId}:${row.recipeId}`));
    for (const row of recipesEnd) {
        if (known.has(`${row.characterId}:${row.recipeId}`)) continue;
        const grade = recipeGrades[row.recipeId] || 'none';
        learned[grade] = (learned[grade] || 0) + 1;
        learnedTotal++;
    }
    return { dropped, learned, droppedTotal, learnedTotal, droppedHotUnlabeled: unitsOf(moves, items, 'hotIn', (item) => item.cls === 'recipe') };
}

// Open stores and board ads per town: rows { town, kind, storeType, status }.
function storesByTown(shops) {
    const towns = {};
    for (const shop of shops) {
        if (shop.status !== 'active') continue;
        const field = shop.kind === 'shop' ? (Number(shop.storeType) === 3 ? 'shopBuy' : 'shopSell') : shop.kind === 'buy_ad' ? 'buyAd' : shop.kind === 'sell_ad' ? 'sellAd' : null;
        if (!field) continue;
        const town = towns[shop.town || '?'] ||= { shopSell: 0, shopBuy: 0, sellAd: 0, buyAd: 0 };
        town[field]++;
    }
    return Object.fromEntries(Object.entries(towns).sort((a, b) => (b[1].shopSell + b[1].shopBuy) - (a[1].shopSell + a[1].shopBuy)));
}

// Arrivals in town per hour, from the bot life feed (rows { town, characterId }).
function visitsSection(visits, hours) {
    const towns = new Map();
    for (const visit of visits) {
        const town = towns.get(visit.town) || towns.set(visit.town, { town: visit.town, arrivals: 0, bots: new Set() }).get(visit.town);
        town.arrivals++;
        town.bots.add(visit.characterId);
    }
    return {
        source: 'bot_life_events arrived_town: a lower bound, the feed keeps 20 rows per bot',
        perHour: round(visits.length / hours, 0),
        towns: [...towns.values()].sort((a, b) => b.arrivals - a.arrivals).map((town) => ({ town: town.town, perHour: round(town.arrivals / hours, 0), bots: town.bots.size }))
    };
}

// What a run does not record: printed as not computed, never as zero.
const NOT_COMPUTED = Object.freeze([
    { metric: 'faucets and sinks per band for hunt adena, NPC sales, fares and drops', reason: 'the economy journal has no actor; per band only the trade log channels', handle: 'src/EconomyJournal.js record(): rows keyed by operation, store, item' },
    { metric: 'town visits per hour (exact)', reason: 'the life feed keeps 20 rows per bot and the trace\'s arrived_town has no town; visits is a lower bound', handle: 'src/HistoryStore.js pruneLifeEventsByRecency' },
    { metric: 'cause of hot flows (hot loot, hot NPC trade, hot consumption)', reason: 'hot bodies and the player write through generic item operations', handle: 'src/Database.js item:amount, item:insert, item:delete, item:award-instances, buffered-character:flush' },
    { metric: 'bids posted in the window', reason: 'a buy line opened and closed inside the run leaves no row; bids.filledShare is over fills and lines standing at the end', handle: 'afk_trade_lines deleted on close; database/sql/market-store-outbox.sql covers hot merchants only' },
    { metric: 'trade-chat shouts per hub', reason: 'shouts are kept in memory only', handle: 'src/GameServer/Bot/Economy/BotTradeChat.js history map' },
    { metric: 'cold drops apart from cold consumption of the same item', reason: 'both net inside one resolve journal row: goods.drop and goods.used are net for consumables', handle: 'src/Database.js bot-life:cold-owner-commit-release-batch/resolve' }
]);

function stageCounts(bots) {
    const counts = {};
    for (const [band] of [...STAGE_BANDS, [STATION]]) {
        const count = bots.filter((bot) => stageBandOf(bot) === band).length;
        if (count) counts[band] = count;
    }
    return counts;
}

function activityCounts(bots) {
    const activity = {};
    for (const bot of bots) activity[bot.activity] = (activity[bot.activity] || 0) + 1;
    return activity;
}

// One world without a run (a save): who is there, what they hold, where stores stand.
function snapshot(input) {
    const { bots, merchants } = population(input.endBots);
    const stockNow = moneyStock(input.stockEnd);
    const bandOfBot = new Map(bots.map((bot) => [bot.characterId, bandOf(bot)]));
    const bands = {};
    for (const bot of bots) {
        const band = bands[bandOfBot.get(bot.characterId)] ||= { bots: 0, adena: 0 };
        band.bots++;
        band.adena += stockNow.byOwner.get(bot.characterId) || 0;
    }
    const ordered = Object.entries(bands).sort(byGroupOrder);
    return {
        schema: SCHEMA,
        mode: 'snapshot',
        inputs: input.inputs || {},
        population: { bots: bots.length, merchants, bands: Object.fromEntries(ordered.map(([name, band]) => [name, { bots: band.bots }])), stageBands: stageCounts(bots) },
        money: {
            stock: stockNow.total,
            byStore: stockNow.byStore,
            bands: Object.fromEntries(ordered.map(([name, band]) => [name, { bots: band.bots, mean: round(ratio(band.adena, band.bots), 0) }])),
            gini: round(gini(bots.map((bot) => stockNow.byOwner.get(bot.characterId) || 0)), 4)
        },
        shots: { coverage: shotCoverage(input.items, bots, input.shotRows, bandOfBot) },
        stores: storesByTown(input.shopsEnd),
        activity: activityCounts(bots),
        notComputed: [{ metric: 'flows, trade, prices, goods, progress, visits', reason: 'a snapshot has no run: they need a start and an end', handle: '--run or --start/--end' }]
    };
}

// Old against new for every numeric leaf a release's expectation is written
// against; rows of a list are named by their identity fields.
const COMPARED = ['flows.perBotHour', 'money', 'trade', 'bids', 'shots.coverage', 'gear', 'materials', 'recipes', 'progress'];
const IDENTITY = ['channel', 'class', 'grade', 'region', 'town', 'operation'];

function numericLeaves(value, at, leaves) {
    if (typeof value === 'number') leaves.set(at, value);
    else if (Array.isArray(value)) {
        for (const row of value) numericLeaves(row, `${at}[${IDENTITY.filter((field) => typeof row?.[field] === 'string').map((field) => row[field]).join('/')}]`, leaves);
    } else if (value && typeof value === 'object') {
        for (const [name, child] of Object.entries(value)) numericLeaves(child, `${at}.${name}`, leaves);
    }
    return leaves;
}

function compare(before, after) {
    const rows = [];
    const pick = (json, section) => section.split('.').reduce((value, name) => value?.[name], json);
    for (const section of COMPARED) {
        const old = numericLeaves(pick(before, section), section, new Map());
        const now = numericLeaves(pick(after, section), section, new Map());
        for (const at of new Set([...now.keys(), ...old.keys()])) {
            const was = old.get(at), is = now.get(at);
            if (!was && !is) continue;
            rows.push({ path: at, before: was ?? null, after: is ?? null, change: was && is !== undefined ? round((is - was) / Math.abs(was), 4) : null });
        }
    }
    return rows;
}

function ledger(input) {
    const span = window(input.window);
    const { bots, merchants } = population(input.endBots);
    const botHours = bots.length * span.hours;
    const flowsRaw = classifyFlows(input.flowRows, input.trades);
    const startStock = moneyStock(input.stockStart);
    const endStock = moneyStock(input.stockEnd);
    const meanStock = (startStock.total + endStock.total) / 2;
    const common = { hours: span.hours, startStock, endStock, trades: input.trades };
    const bands = groupStats(bots, bandOf, common);
    const startById = new Map(input.startBots.map((bot) => [bot.characterId, bot]));
    const known = bots.filter((bot) => startById.has(bot.characterId));
    const startBand = (bot) => bandOf(startById.get(bot.characterId));
    const startStage = (bot) => stageBandOf(startById.get(bot.characterId));
    const endIds = new Set(input.endBots.map((bot) => bot.characterId));
    const onlyAtStart = input.startBots.filter((bot) => bot.activity !== MERCHANT_ACTIVITY && !endIds.has(bot.characterId)).length;
    // Money deltas count only bots present at both ends: a bot seen at the end alone would count its whole purse as earned.
    const moneyBands = groupStats(known, bandOf, common);
    const activityAtEnd = activityCounts(bots);
    const items = input.items;
    const moves = goodsMoves(input.flowRows, input.trades);
    const bandOfBot = new Map(bots.map((bot) => [bot.characterId, bandOf(bot)]));
    return {
        schema: SCHEMA,
        inputs: input.inputs || {},
        window: span,
        population: {
            bots: bots.length, merchants, botHours: round(botHours, 2),
            bands: Object.fromEntries(Object.entries(bands).map(([name, group]) => [name, { bots: group.bots, botHours: group.botHours }])),
            stageBands: stageCounts(bots)
        },
        bots: { onlyAtEnd: bots.length - known.length, onlyAtStart },
        flows: {
            perBotHour: perBotHour(flowsRaw.totals, botHours),
            totals: Object.fromEntries(Object.entries(flowsRaw.totals).map(([kind, adena]) => [kind, round(adena, 0)])),
            faucets: round(flowsRaw.faucets, 0),
            sinks: round(flowsRaw.sinks, 0),
            net: round(flowsRaw.net, 0),
            fixedBuyerShareOfFaucets: round(ratio(flowsRaw.totals.fixedBuyers, flowsRaw.faucets), 4),
            unclassified: flowsRaw.unclassified.map((row) => ({ operation: row.operation, adena: round(row.adena, 0) }))
        },
        money: moneySection({ bots, startStock, endStock, flows: flowsRaw, hours: span.hours, bands: moneyBands }),
        trade: tradeSection({ flows: flowsRaw, botHours, hours: span.hours, meanStock, bands }),
        progress: {
            basis: 'bots present at both ends; exp is the net change of bot_life_state.exp',
            bandsBasis: 'startLevel',
            bands: progressGroups(groupStats(known, startBand, { ...common, startById, groupAtEnd: bandOf })),
            stageBands: progressGroups(groupStats(known, startStage, { ...common, startById, groupAtEnd: stageBandOf })),
            activityAtEnd
        },
        prices: priceIndex(input.trades, items),
        bids: bidsSection(input.trades, input.buyLines, span.t0),
        shots: shotsSection(moves, items, bots, input.shotRows, bandOfBot),
        goods: goodsTable(moves, items),
        gear: gearSection(moves, input.trades, items),
        materials: materialsSection(moves, input.trades, items),
        recipes: recipesSection(moves, items, input.recipesStart, input.recipesEnd, input.recipeGrades),
        stores: { start: storesByTown(input.shopsStart), end: storesByTown(input.shopsEnd) },
        visits: visitsSection(input.visits, span.hours),
        notComputed: NOT_COMPUTED
    };
}

module.exports = {
    SCHEMA, HOUR_MS, ADENA, STAGE_BANDS, OPERATION_KIND, FLOW_KINDS,
    window, netFlows, bandOf, stageBandOf, population, classifyFlows, moneyStock, gini, itemClass, ledger, snapshot, compare
};
