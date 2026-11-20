'use strict';
// The model's hour at a spot from its hunt table (hunt-table.js): pure, plain
// data in (the table's cells and statics), the game's rule it needs passed in
// as a function (the exp level-gap factor). Read by the table build's
// combination check; the design's boot reads it for every line and level of
// the table's range once the design takes its hours from the table.

const LIMITS = require('../design/limits');

const ADENA = 57;
// The fields of an hour row's hour without shots (shotless), which the engine
// lays over the row for a bot hunting bare: its potions stay the shots hour's.
const SHOTLESS_FIELDS = Object.freeze(['kills', 'exp', 'adena', 'dropLoot', 'spoilLoot', 'loot']);
// The table's rows carry their bare hour's own deaths, busy share and kill mix as well.
const READ_SHOTLESS = Object.freeze([...SHOTLESS_FIELDS, 'deaths', 'busyShare', 'mix']);

// The items of a yields table (item -> per kill) at the NPC's buy price
// (items: id -> { npcBuy }), adena apart.
function npcBuyValue(table, items) {
    return Object.entries(table || {}).reduce((sum, [id, perKill]) => sum + (Number(id) === ADENA ? 0 : perKill * (items[id]?.npcBuy || 0)), 0);
}

// The species of a spot a bot hunts in a form: measured with a kill and at
// most limit deaths a kill (the design's KILL_DEATH_LIMIT). A species the
// table holds no cell for (outside its level window) is not hunted.
// cells: selfId -> [form cells]; form: its index; fields: the table's cell fields.
function admitted({ cells, form, fields, limit }) {
    const kills = fields.indexOf('kills'), deaths = fields.indexOf('deaths');
    return Object.keys(cells).filter(selfId => cells[selfId][form][kills] > 0 && cells[selfId][form][deaths] <= limit);
}

// The combination of species on time for an admitted set of a spot: species
// drawn by their density share p, the time per kill the share-weighted fight,
// rest, other time and walk. A species' walk was measured at its own density;
// at the set's density it is that walk times sqrt(p), its density over the
// set's under the game's walk rule (BackgroundResolver.soloWalkMs: the walk to
// the nearest mob goes as 1 / sqrt(density)), so one species alone reads back
// its own cell. Kills an hour at most the set's production as the game's
// soloShareMobs caps a cold solo bot (no cap where the spot has no production
// or its production is 0: no respawn data; a species without production adds
// none). cells: selfId -> [form cells]; form: its index; fields: the table's
// cell fields; admitted: selfIds. Null for an empty set, else { kills an hour,
// deaths a kill, busy: the fight, walk and rest a kill (s), mix: selfId -> its
// share of the kills }.
function combine({ spot, cells, form, fields, admitted }) {
    const at = Object.fromEntries(fields.map((field, index) => [field, index]));
    const all = Object.values(spot.species);
    const produced = all.filter(held => held.production !== null), capped = produced.length > 0 && produced.reduce((sum, held) => sum + held.production, 0) > 0;
    let count = 0, production = 0;
    for (const selfId of admitted) {
        count += spot.species[selfId].count;
        if (spot.species[selfId].production !== null) production += spot.species[selfId].production;
    }
    if (!count) return null;
    let perKill = 0, busy = 0, deaths = 0;
    const mix = {};
    for (const selfId of admitted) {
        const share = spot.species[selfId].count / count, cell = cells[selfId][form];
        const walk = cell[at.walk] * Math.sqrt(share);
        mix[selfId] = share;
        perKill += share * (cell[at.fight] + cell[at.rest] + cell[at.other] + walk);
        busy += share * (cell[at.fight] + cell[at.rest] + walk);
        deaths += share * cell[at.deaths];
    }
    const kills = 3600 / perKill;
    return { kills: capped ? Math.min(kills, production) : kills, deaths, busy, mix };
}

// A bot's hour at a spot in a form over the species it hunts there: null with
// the reason 'cannot_hunt' when it hunts none (every species over the limit
// or killed by none), else the combination with, per kill, the shots and
// potions it spends and each species' exp (x1, before the level-gap penalty).
function spotHour({ spot, cells, form, fields, limit = LIMITS.KILL_DEATH_LIMIT.value }) {
    const set = admitted({ cells, form, fields, limit });
    const read = combine({ spot, cells, form, fields, admitted: set });
    if (!read) return { hour: null, reason: 'cannot_hunt' };
    const exp = fields.indexOf('exp'), shots = fields.indexOf('shots'), potions = fields.indexOf('potions');
    const hour = { ...read, exp: {}, shots: 0, potions: 0 };
    for (const selfId of set) {
        const cell = cells[selfId][form];
        hour.exp[selfId] = cell[exp];
        hour.shots += read.mix[selfId] * cell[shots];
        hour.potions += read.mix[selfId] * cell[potions];
    }
    return { hour, reason: null };
}

// A species' money a kill from its yields ({ drop, spoil }: item -> per kill,
// at the preset's rates as the game's drop rule gives them): adena, and the
// drop and spoil items at the NPC's buy price (items: id -> { npcBuy }).
function moneyOf(yields, items) {
    return { adena: yields.drop?.[ADENA] || 0, drop: npcBuyValue(yields.drop, items), spoil: npcBuyValue(yields.spoil, items) };
}

// An hour row (the snapshot's hour-row fields and the kill mix) of a spot's
// hour at the bot's level: exp per species at its level gap (gapFactor: the
// game's MobExperience.gapFactor, applied here once) times the preset's exp
// rate, money per species from speciesYields at the bot's level and Spoil
// level. The zero hour where the bot hunts nothing.
function hourRow({ spot, hour, level, rates, speciesYields, spoilLevel, items, gapFactor }) {
    if (!hour) return { kills: 0, deaths: 0, exp: 0, adena: 0, dropLoot: 0, spoilLoot: 0, loot: 0, shots: 0, potions: 0, busyShare: 0, mix: {} };
    let exp = 0, adena = 0, drop = 0, spoil = 0;
    for (const [selfId, share] of Object.entries(hour.mix)) {
        const speciesLevel = spot.species[selfId].level, key = `${selfId}@${level}@${spoilLevel}`;
        if (!speciesYields[key]) throw new Error(`hunt rows: no yields for species ${key}`);
        const money = moneyOf(speciesYields[key], items);
        exp += share * hour.exp[selfId] * gapFactor(level - speciesLevel);
        adena += share * money.adena;
        drop += share * money.drop;
        spoil += share * money.spoil;
    }
    const kills = hour.kills;
    return { kills, deaths: kills * hour.deaths, exp: kills * exp * rates.exp, adena: kills * adena, dropLoot: kills * drop,
        spoilLoot: kills * spoil, loot: kills * (drop + spoil), shots: kills * hour.shots, potions: kills * hour.potions,
        busyShare: Math.min(1, kills * hour.busy / 3600), mix: hour.mix };
}

// A line's rows at a level in a kit (its stat point) from the table file:
// one per spot it hunts in either form, in the engine's hour-row shape: the
// hour firing its shots with, as shotless, the same spot's hour bare (the
// zero hour where it hunts nothing in that form). key: the table's kit key;
// point: { attack, defence }; limit: the kill-death limit (the design's by
// default); rates: { exp }; gapFactor: the game's rule. Returns
// { rows, cannot: [{ spotId, form, reason }] }: each spot and form the bot
// hunts nothing in, with spotHour's reason. A body the file lacks throws.
function lineRows({ file, key, level, point, limit = LIMITS.KILL_DEATH_LIMIT.value, rates, speciesYields, spoilLevel, items, gapFactor }) {
    const name = `${key}|${level}|${point.attack}/${point.defence}`, body = file.bodies[name], bySpot = file.cells[name];
    if (!body || !bySpot) throw new Error(`hunt rows: the table has no body ${name} (range ${file.range})`);
    const fields = file.fields, shotsForm = file.forms.indexOf('shots'), bareForm = file.forms.indexOf('bare'), rows = [], cannot = [];
    for (const [spotId, cells] of Object.entries(bySpot)) {
        const spot = file.spots[spotId], read = form => {
            const { hour, reason } = spotHour({ spot, cells, form, fields, limit });
            if (!hour) cannot.push({ spotId, form: file.forms[form], reason });
            return hour;
        };
        const shots = read(shotsForm), bare = read(bareForm);
        if (!shots && !bare) continue;
        const row = hour => hourRow({ spot, hour, level, rates, speciesYields, spoilLevel, items, gapFactor });
        const shotless = row(bare);
        rows.push({ spotId, ...row(shots), shotless: Object.fromEntries(READ_SHOTLESS.map(field => [field, shotless[field]])) });
    }
    return { rows, cannot };
}

module.exports = { admitted, combine, spotHour, lineRows, npcBuyValue, SHOTLESS_FIELDS };
