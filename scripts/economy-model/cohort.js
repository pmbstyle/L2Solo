'use strict';

// The accounts a model run starts from, as plain records the engine reads:
// { id, station, classId, line, level, exp, money, spot, shots: { selfId: count },
//   held: [selfId], worn: { slot: selfId }, persona: { primaryDrive, traits: { caution, commitment, ambition } } | null (the game's persona shape),
//   warehouse: { selfId: count }, twins: [] | [crafter, shop seller, shop buyer] };
// spot is the spot the bot stood at in the save (null without one).
// seedAccount (the one seeder of every cohort) gives an account whose main is
// a wealth type or highly committed a dwarf crafter twin that knows the recipe
// scrolls the account holds, and two shop twins, a seller and a buyer.
//
// fromSave reads a real run's start save read-only (the economy ledger names
// it in inputs.start.db); savedBots is the model's only reader of a save's
// bots (the snapshot's spot hours read it too). A main's line (its final class, the spot table's role) is its class
// when that class is a line; a first-profession main's line is drawn among
// the lines that pass through its class, by the class weights (seeded by its
// id), because the save does not keep the branch a bot will take.
// synthetic builds a cohort from the class weights alone; fresh builds a new
// world's cohort: every account a new character.
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const { hash, mulberry, boot } = require('../hunt-tables/common');
const Weights = require('./weights');
const BotPersona = require('../../src/GameServer/Bot/AI/BotPersona');
const StarterItemCatalog = require('../../src/GameServer/Knowledge/StarterItemCatalog');

// The craft-station crafters of today's world: they hunt nothing and hold the
// money they started with. Both constants copy the ledger's own
// (scripts/economy/ledger-rules.js owns them; a test fails if they differ).
const STATION_ACCOUNT_PREFIX = 'bot_craft_';
const MERCHANT_ACTIVITY = 'merchant';
const ADENA = 57;
// The base class of the one line whose characters never start as an account's
// beneficiary (the main its plan levels and kits): the dwarf's. Its Scavenger
// and Bounty Hunter are spoilers and its Artisan and Warsmith crafters, all
// support by our rule; every other line's role (dps, tank, dagger, archer,
// mage, healer, buffer) plays a main.
const DWARF_FIGHTER = 53;
const DWARF_LINE_SHARE = 0.1;
// A trait at or above it is high: ours, initial from the game's persona text
// cards (BotPersona.js: commitment >= 0.62).
const HIGH_TRAIT = 0.62;
// The share of qualifying accounts given twins: ours, every one (the maintainer's
// rule); a lower share is drawn per account by its own seed, never the cohort's.
const TWIN_SHARE = 1;

// class -> the lines whose kit passes through it at some level.
function linesByClass(snapshot) {
    const out = new Map();
    for (const [line, byLevel] of Object.entries(snapshot.hours)) {
        for (const hour of Object.values(byLevel)) {
            if (!out.has(hour.classId)) out.set(hour.classId, new Set());
            out.get(hour.classId).add(line);
        }
    }
    return out;
}

function weightedPick(lines, random, classWeights = Weights.CLASS_WEIGHTS) {
    const weights = lines.map(line => classWeights[line] || 0);
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    if (!(total > 0)) return lines[Math.floor(random() * lines.length)];
    let roll = random() * total;
    for (let i = 0; i < lines.length; i++) if ((roll -= weights[i]) < 0) return lines[i];
    return lines[lines.length - 1];
}

// The line of a main of the class: exact when the class is a line, else
// drawn among the lines through it. Null when no line passes through it.
function lineOf(classId, id, snapshot, byClass) {
    if (snapshot.hours[String(classId)]) return { line: String(classId), exact: true };
    const lines = [...(byClass.get(classId) || [])].sort((a, b) => Number(a) - Number(b));
    if (!lines.length) return null;
    return { line: weightedPick(lines, mulberry(hash(`line:${id}`))), exact: false };
}

// A save's bots, read-only: { characterId, accountName, level, exp, activity,
// spotId, classId, station, partyIds } without the merchants (partyIds: the
// member ids of the active background party the bot is in, else null); with
// items, every item row, every persona row and every warehouse row. spotId: the spot the bot stands at; else its travel's
// spot, where the game lands a traveller on arrival (BackgroundResolver); else
// its stay's spot, which is our reading: the stay is the game's tally of the
// bot's last solo hunt, and a spot-less resting or shopping bot is sent by the
// game's route choice (BotRoute.huntSpot) when it next leaves, an answer the
// save does not hold; we send it back to the spot it last hunted. Else null.
function savedBots(file, { items = false } = {}) {
    if (!fs.existsSync(file)) throw new Error(`missing start save ${file}`);
    const db = new DatabaseSync(file, { readOnly: true });
    try {
        const bots = db.prepare(`SELECT b.characterId, b.accountName, b.level, b.exp, b.activity, b.spotId, c.classId,
            json_extract(b.statsJson, '$.travel.spotId') AS travelSpotId, json_extract(b.statsJson, '$.stay.spotId') AS staySpotId
            FROM bot_life_state b JOIN characters c ON c.id = b.characterId ORDER BY b.characterId`).all()
            .filter(bot => bot.activity !== MERCHANT_ACTIVITY)
            .map(({ travelSpotId, staySpotId, ...bot }) => ({ ...bot, spotId: bot.spotId || travelSpotId || staySpotId || null, station: String(bot.accountName || '').startsWith(STATION_ACCOUNT_PREFIX) }));
        const parties = new Map();
        for (const row of db.prepare(`SELECT memberIdsJson FROM bot_background_parties WHERE status = 'active'`).all()) {
            const ids = JSON.parse(row.memberIdsJson || '[]').map(Number);
            for (const id of ids) parties.set(id, ids);
        }
        for (const bot of bots) bot.partyIds = parties.get(bot.characterId) || null;
        return { bots, items: items ? db.prepare('SELECT characterId, selfId, amount, equipped, slot FROM items').all() : [],
            personas: items ? db.prepare('SELECT characterId, primaryDrive, traitsJson FROM bot_personas').all() : [],
            warehouse: items ? db.prepare('SELECT characterId, selfId, amount FROM warehouse_items WHERE amount > 0').all() : [] };
    } finally {
        db.close();
    }
}

// The party a bot starts in, from the save: the start levels of its members
// the save holds as bots and the bot's own place among them; null alone. The
// model holds it for the whole run (our reading: the game's members leave on
// party_left and party_outleveled).
function partyOf(bot, levelOf) {
    const ids = (bot.partyIds || []).filter(id => levelOf.has(id));
    return ids.length > 1 ? { levels: ids.map(id => levelOf.get(id)), self: ids.indexOf(bot.characterId) } : null;
}

// The twins of an account, seeded from its main's persona and what it holds
// (holdings: { bag: { selfId: count }, warehouse: { selfId: count } }). A
// persona that is a wealth type or has commitment >= HIGH_TRAIT gives a dwarf
// crafter at the main's level (capped at the highest level the snapshot has a
// twin for) that knows the recipe of each scroll the account holds: a scroll
// teaches the first recipe row with its id (the game's C4RecipeItems), learned
// when it is dwarven and its level is within the crafter's Create Item level
// (Backpack: a recipe above the craft level is not learned; a common recipe is
// skipped: the snapshot holds no Common Craft level); a
// shop seller and a shop buyer. Learning consumes one scroll: the main's
// warehouse loses one unit of each learned scroll its bag does not hold. The
// town, the twins' adena and the shop twins' class are the next step's.
// Returns a new record; the main stays the record itself.
function seedAccount(account, persona, holdings, snapshot) {
    const warehouse = { ...holdings.warehouse };
    const qualifies = persona && !account.station && (persona.primaryDrive === 'wealth' || persona.traits.commitment >= HIGH_TRAIT)
        && (TWIN_SHARE >= 1 || mulberry(hash(`twin:${account.id}`))() < TWIN_SHARE);
    const base = { ...account, persona: persona ? { primaryDrive: persona.primaryDrive, traits: { caution: persona.traits.caution, commitment: persona.traits.commitment, ambition: persona.traits.ambition } } : null, warehouse, twins: [] };
    if (!qualifies) return base;
    const level = Math.min(account.level, Math.max(...Object.keys(snapshot.twins).map(Number)));
    const twin = snapshot.twins[level], held = scroll => (holdings.bag[scroll] || 0) + (holdings.warehouse[scroll] || 0) > 0;
    const learned = new Map(), seen = new Set();
    for (const row of snapshot.recipes) {
        if (seen.has(row.recipeItemId)) continue;
        seen.add(row.recipeItemId);
        if (row.type === 'dwarven' && row.level <= twin.createItem && held(row.recipeItemId)) learned.set(Number(row.recipeId), Number(row.recipeItemId));
    }
    for (const scroll of learned.values()) {
        if (holdings.bag[scroll]) continue;
        if (warehouse[scroll] > 1) warehouse[scroll]--;
        else delete warehouse[scroll];
    }
    const crafter = { role: 'crafter', id: `${account.id}:crafter`, classId: twin.classId, level, recipes: [...learned.keys()].sort((a, b) => a - b), money: 0, warehouse: {}, town: null };
    const shop = side => ({ role: 'shop', side, id: `${account.id}:shop-${side}`, money: 0, warehouse: {}, town: null });
    return { ...base, twins: [crafter, shop('sell'), shop('buy')] };
}

function fromSave(file, snapshot) {
    const { bots, items, personas, warehouse } = savedBots(file, { items: true });
    const byOwner = new Map(), personaOf = new Map(), vaultOf = new Map();
    for (const row of items) {
        if (!byOwner.has(row.characterId)) byOwner.set(row.characterId, []);
        byOwner.get(row.characterId).push(row);
    }
    for (const row of personas) { const traits = JSON.parse(row.traitsJson || '{}'); personaOf.set(row.characterId, { primaryDrive: row.primaryDrive, traits: { caution: traits.caution === undefined ? undefined : Number(traits.caution), commitment: Number(traits.commitment), ambition: traits.ambition === undefined ? undefined : Number(traits.ambition) } }); }
    for (const row of warehouse) {
        if (!vaultOf.has(row.characterId)) vaultOf.set(row.characterId, {});
        vaultOf.get(row.characterId)[row.selfId] = (vaultOf.get(row.characterId)[row.selfId] || 0) + Number(row.amount);
    }
    const byClass = linesByClass(snapshot), shotIds = new Set(Object.entries(snapshot.items)
        .filter(([, item]) => item.kind === 'Other.Shot').map(([id]) => Number(id)));
    const accounts = [], counts = { exact: 0, drawn: 0, noLine: 0, stations: 0 };
    const levelOf = new Map(bots.map(bot => [bot.characterId, Number(bot.level)]));
    for (const bot of bots) {
        const station = bot.station;
        const picked = station ? null : lineOf(Number(bot.classId), bot.characterId, snapshot, byClass);
        if (station) counts.stations++;
        else if (!picked) counts.noLine++;
        else counts[picked.exact ? 'exact' : 'drawn']++;
        const own = byOwner.get(bot.characterId) || [], shots = {}, worn = {};
        let money = 0;
        const bag = {};
        for (const row of own) {
            const selfId = Number(row.selfId), amount = Number(row.amount) || 0;
            bag[selfId] = (bag[selfId] || 0) + amount;
            if (selfId === ADENA) money += amount;
            else if (shotIds.has(selfId)) shots[selfId] = (shots[selfId] || 0) + amount;
            if (Number(row.equipped) === 1 && row.slot !== null) worn[Number(row.slot)] = selfId;
        }
        const account = { id: bot.characterId, station: station || !picked, classId: Number(bot.classId), line: picked?.line ?? null,
            level: Number(bot.level), exp: Number(bot.exp), money, spot: bot.spotId ? String(bot.spotId) : null, party: partyOf(bot, levelOf), shots, held: [...new Set(own.map(row => Number(row.selfId)))], worn };
        accounts.push(seedAccount(account, personaOf.get(bot.characterId) || null, { bag, warehouse: vaultOf.get(bot.characterId) || {} }, snapshot));
    }
    return { accounts, source: file, lines: counts };
}

// The lines the class weights give a main (a weight above 0).
function weightedLines(snapshot) {
    return Object.keys(snapshot.hours).filter(line => Weights.CLASS_WEIGHTS[line] > 0);
}

// The lines of the fresh world: the weighted lines without the dwarf fighter's
// (no dwarf is created). classAtOne(line): the line's level-1 class.
function freshLines(lines, classAtOne) {
    return lines.filter(line => Weights.CLASS_WEIGHTS[line] > 0 && classAtOne(line) !== DWARF_FIGHTER);
}

// The one account builder of the cohorts built from the class weights alone:
// count accounts, each line drawn among lines by the class weights from
// random, then its level by levelOf(index, random) (called after the line's
// draw), at the line's class of that level, holding moneyOf(level), the shots
// shotsOf(classId) gives ({ selfId: count }; none by default) and the kit kitOf(line, level, classId) gives ([{ selfId, slot, amount,
// equipped }]): the equipped pieces worn in their slots, every piece in the bag.
function accountsOf({ count, random, lines, levelOf, moneyOf, kitOf, shotsOf = () => ({}), weights = Weights.CLASS_WEIGHTS }, snapshot) {
    const accounts = [], types = {};
    for (let i = 0; i < count; i++) {
        const line = weightedPick(lines, random, weights), level = levelOf(i, random), classId = snapshot.hours[line][level]?.classId ?? Number(line);
        const kit = kitOf(line, level, classId);
        const account = { id: i + 1, station: false, classId, line, level,
            exp: snapshot.exp[level - 1], money: moneyOf(level), spot: null, shots: shotsOf(classId), held: kit.map(piece => piece.selfId),
            worn: Object.fromEntries(kit.filter(piece => piece.equipped).map(piece => [piece.slot, piece.selfId])) };
        // The game's own persona generator, its type shares counted over the cohort so far.
        const persona = BotPersona.generate({ characterId: account.id, classId: account.classId, stats: { generatedIndex: i } }, { counts: types, total: count });
        types[persona.archetype] = (types[persona.archetype] || 0) + 1;
        const bag = {};
        for (const piece of kit) bag[piece.selfId] = (bag[piece.selfId] || 0) + piece.amount;
        accounts.push(seedAccount(account, persona, { bag, warehouse: {} }, snapshot));
    }
    return accounts;
}

// count accounts, lines by the class weights, levels uniform in [low, high],
// each fully kitted for its level, no money and no shots.
function synthetic({ count, low, high, seed = 1 }, snapshot) {
    const kitOf = (line, level) => (snapshot.kits[line]?.[level] || []).map(piece => ({ selfId: piece.selfId, slot: piece.slot, amount: 1, equipped: true }));
    const accounts = accountsOf({ count, random: mulberry(hash(`cohort:${seed}`)), lines: weightedLines(snapshot),
        levelOf: (_, random) => low + Math.floor(random() * (high - low + 1)), moneyOf: () => 0, kitOf }, snapshot);
    return { accounts, source: `synthetic ${count} accounts, levels ${low}-${high}, class weights`, lines: { exact: 0, drawn: count, noLine: 0, stations: 0 } };
}

// A fresh world: count new characters, one per account, each its account's
// beneficiary. Its line is drawn by the model's class weights (weights.js)
// among every line but the dwarf's; it starts at level 1 with 0 exp in its
// line's base class (its line's class below 20: the race's fighter or
// mystic), with 0 adena (C4: Lisvus Other.properties StartingAdena = 0), the
// game's starter shots of its class (ShotStock.starterPlanFor: the C4 tutorial
// reward, 600 Soulshots or 300 Spiritshots for Beginners by the class's kind,
// which every generated bot gets at creation) and the game's
// character-creation kit of that class, worn as a new character wears it
// (StarterItemCatalog.starterRows, the game's one rule for players and bots). Needs the game's data (the hunt tables' boot). A line
// without its level-1 class in the snapshot throws: no class to start in.
function fresh({ count, seed = 1, dwarves = false }, snapshot) {
    boot();
    const Data = invoke('GameServer/DataCache');
    const weighted = weightedLines(snapshot);
    for (const line of weighted) if (!snapshot.hours[line][1]) throw new Error(`fresh world: line ${line} has no level-1 class in the snapshot (hours[${line}][1])`);
    const plain = freshLines(weighted, line => snapshot.hours[line][1].classId);
    // dwarves (the gnome trade, decision 469): the dwarf lines are mains too, each DWARF_LINE_SHARE of the mains (the
    // game's 11-11 save: 340 dwarves of 1700, 174 spoilers and 166 crafters), the other lines by their class weights.
    const dwarfLines = dwarves ? Object.keys(snapshot.hours).filter(line => snapshot.hours[line][1]?.classId === DWARF_FIGHTER && !plain.includes(line)) : [];
    const plainWeight = plain.reduce((sum, line) => sum + (Weights.CLASS_WEIGHTS[line] || 0), 0);
    const dwarfWeight = plainWeight * DWARF_LINE_SHARE / (1 - DWARF_LINE_SHARE * dwarfLines.length);
    const weights = { ...Weights.CLASS_WEIGHTS, ...Object.fromEntries(dwarfLines.map(line => [line, dwarfWeight])) }, lines = [...plain, ...dwarfLines];
    const kitOf = (line, level, classId) => StarterItemCatalog.starterRows(Data.newbieItems, classId, Data.items)
        .map(row => ({ selfId: Number(row.selfId), slot: row.slot, amount: Number(row.amount) || 1, equipped: row.equipped }));
    const ShotStock = invoke('GameServer/Inventory/ShotStock');
    const shotsOf = classId => { const plan = ShotStock.starterPlanFor(classId); return { [plan.selfId]: plan.amount }; };
    const accounts = accountsOf({ count, random: mulberry(hash(`fresh:${seed}`)), lines, levelOf: () => 1, moneyOf: () => 0, kitOf, shotsOf, weights }, snapshot);
    return { accounts, source: `fresh ${count} accounts at level 1, beneficiary lines by class weights, creation kits`, lines: { exact: 0, drawn: count, noLine: 0, stations: 0 } };
}

module.exports = { fromSave, savedBots, synthetic, fresh, freshLines, lineOf, linesByClass, STATION_ACCOUNT_PREFIX, MERCHANT_ACTIVITY };
