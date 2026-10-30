#!/usr/bin/env node
'use strict';

// Checks of the hunt tables (user 10-29). Read-only; prints a report.
// 1. Strength: class base card + henna + worn items (HuntModel.strength over
//    tables 3, 5, 9) against the owner's profileFor, on 100 bots of a world
//    snapshot (a copy: node:sqlite readOnly).
// 2. Formula + corrections against the real cold hunt on table 8's held-out
//    half: kills per hour and deaths per hour errors.
// 3. Each table's size and build time (headers).
// 4. A few spot-table.json rows against the formula, for the author's kit
//    and for a live-like kit.
//
// Usage: node scripts/hunt-tables/verify.js --snapshot=<world.sqlite> [--bots=100] [--out=report.json]

const fs = require('fs');
const C = require('./common');
const M = require('./HuntModel');
const K = require('./corrections');

const HuntCycle = invoke('GameServer/Bot/AI/HuntCycle');

function args() {
    const out = { snapshot: null, bots: 100, out: null };
    for (const arg of process.argv.slice(2)) {
        const [key, value] = arg.replace(/^--/, '').split('=');
        if (key === 'snapshot') out.snapshot = value;
        else if (key === 'bots') out.bots = Number(value);
        else if (key === 'out') out.out = value;
        else throw new Error(`unknown argument ${arg}`);
    }
    return out;
}

function quantile(list, q) {
    const sorted = [...list].sort((a, b) => a - b);
    return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : NaN;
}

// ------------------------------------------------------------ 1

function strengthCheck(file, count) {
    // A copy only: a long read of the live DB blocks its WAL checkpoint.
    if (require('path').resolve(file).includes('/L2Solo/tmp/')) throw new Error(`refused: ${file} is under the live server's tmp/`);
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(file, { readOnly: true });
    const rows = db.prepare('SELECT characterId, level, statsJson, inventorySummary FROM bot_life_state ORDER BY characterId').all();
    db.close();
    const classes = C.readTable('classes').classes;
    const gear = C.readTable('gear');
    const items = new Map(gear.items.map(row => [row[0], Object.fromEntries(gear.itemFields.map((field, i) => [field, row[i]]))]));
    // Items worn but outside table 5 (a class's unsuitable or sourceless
    // piece): read raw from game data, counted apart.
    const raw = id => { const item = M.Index.find(M.DataCache.items, id); return item ? Object.fromEntries(gear.itemFields.map((field, i) => [field,
        [Number(item.selfId), item.template?.name, item.template?.kind, Number(item.etc?.slot) || 0, String(item.etc?.rank || 'none'),
            Number(item.template?.price) || 0, Object.fromEntries(M.ITEM_STATS.map(s => [s, Number(item.stats?.[s]) || 0]).filter(([, v]) => v))][i]])) : null; };
    const step = Math.max(1, Math.floor(rows.length / count));
    const picked = rows.filter((_, index) => index % step === 0).slice(0, count);
    const out = { bots: 0, maxRel: 0, worst: null, outsideTable: 0, perField: {}, mismatched: 0 };
    for (const row of picked) {
        const stats = JSON.parse(row.statsJson || '{}');
        const inventory = JSON.parse(row.inventorySummary || '{}');
        const classId = invoke('GameServer/Bot/Population/ColdCombatProfile').classIdOf({ stats });
        const state = { characterId: Number(row.characterId), level: Number(row.level), classId, stats, inventory };
        const owner = M.profileOf(state);
        const worn = [];
        for (const item of Object.values(inventory)) {
            if (!item?.equipped) continue;
            const slots = Array.isArray(item.equippedSlots) && item.equippedSlots.length ? item.equippedSlots : [Number(item.slot)];
            for (const slot of slots) {
                const instance = item.instances?.find(entry => entry.equipped && Number(entry.slot) === Number(slot));
                let tableRow = items.get(Number(item.selfId));
                if (!tableRow) { tableRow = raw(Number(item.selfId)); out.outsideTable += 1; }
                if (tableRow) worn.push({ row: tableRow, slot: Number(slot), enchant: Number(instance?.enchant ?? item.enchant) || 0 });
            }
        }
        // The bot's own line's row (C.kitKey of its class and kit future).
        const key = C.kitKey(classId, invoke('GameServer/Bot/AI/BotRoles').kitClassId(state));
        const sum = M.strength(C.rowOfKey(classes, key), Number(row.level), { hennas: stats.hennas || [], items: worn,
            skills: M.Profile.skillsFor(state) });
        let botMax = 0;
        for (const field of M.NUMBERS) {
            const a = Number(owner[field]), b = Number(sum[field]);
            const rel = Math.abs(a - b) / Math.max(1, Math.abs(a));
            out.perField[field] = Math.max(out.perField[field] || 0, rel);
            if (rel > botMax) botMax = rel;
            if (rel > out.maxRel) { out.maxRel = rel; out.worst = { characterId: row.characterId, classId, level: row.level, field, owner: a, sum: b }; }
        }
        if (botMax > 1e-9) out.mismatched += 1;
        out.bots += 1;
    }
    return out;
}

// ------------------------------------------------------------ 2

function formulaCheck() {
    const table = C.readTable('corrections');
    const F = table.sampleFields;
    const rows = table.sample.map(row => Object.fromEntries(F.map((field, i) => [field, row[i]])));
    const held = rows.filter(row => row.half === 1);
    const gate = { both: 0, neither: 0, realOnly: 0, formulaOnly: 0 };
    for (const row of held) {
        const a = row.realKph > 0, b = row.formulaKph > 0;
        gate[a && b ? 'both' : !a && !b ? 'neither' : a ? 'realOnly' : 'formulaOnly'] += 1;
    }
    const groups = {};
    for (const row of held.filter(row => row.realKph > 0 && row.formulaKph > 0)) {
        const key = `${row.rotKind}|${row.danger}`;
        const correction = table.corrections[key] || [1, 1];
        const kph = row.formulaKph * correction[0];
        const deaths = row.formulaDeathsPerHour * correction[1];
        const group = groups[key] || (groups[key] = { n: 0, raw: [], corrected: [], deathErr: [], realDeaths: 0, formulaDeaths: 0 });
        group.n += 1;
        group.raw.push(row.realKph / row.formulaKph);
        group.corrected.push(Math.abs(kph / row.realKph - 1));
        group.deathErr.push(Math.abs(deaths - row.realDeathsPerHour));
        group.realDeaths += row.realDeathsPerHour;
        group.formulaDeaths += deaths;
    }
    return { held: held.length, gate, corrections: table.corrections, groups: Object.fromEntries(Object.entries(groups).map(([key, g]) => [key, {
        n: g.n, kphErrMedian: C.round(quantile(g.corrected, 0.5), 3), kphErrP90: C.round(quantile(g.corrected, 0.9), 3),
        rawRatioP10: C.round(quantile(g.raw, 0.1), 3), rawRatioP50: C.round(quantile(g.raw, 0.5), 3), rawRatioP90: C.round(quantile(g.raw, 0.9), 3),
        deathsPerHourMeanAbsErr: C.round(g.deathErr.reduce((s, v) => s + v, 0) / g.n, 3),
        deathsPerHourReal: C.round(g.realDeaths / g.n, 3), deathsPerHourFormula: C.round(g.formulaDeaths / g.n, 3) }])) };
}

// ------------------------------------------------------------ 3

function sizes() {
    return fs.readdirSync(C.OUT_DIR).filter(name => name.endsWith('.json')).sort().map(name => {
        const text = fs.readFileSync(`${C.OUT_DIR}/${name}`, 'utf8');
        const header = JSON.parse(text).header;
        return { table: header.table, kb: Math.round(text.length / 1024), seconds: header.buildSeconds, counts: header.counts };
    });
}

// ------------------------------------------------------------ 4

// A spot's hour by formula, its mobs drawn as the real solo pick draws them
// (ColdCombatProfile.npcForSpot): a spawn group by its count x squared matchup
// efficiency x the share of its spawns whose pull the kit survives
// (BotTargetMatchup.speciesPulls), each allowed pull size in its share
// (BotPullEstimate.pullsOf of the group's mean). Kills count mobs, per hour
// capped by cap.
function spotHour(bot, spotRow, tables, corrections, cap) {
    const Matchup = invoke('GameServer/Bot/AI/BotTargetMatchup');
    const { profiles } = M.matchupOf(bot);
    let weight = 0, cycle = 0, kills = 0, exp = 0, deaths = 0;
    for (const [npcId, count, pull] of spotRow[5]) {
        const verdict = Matchup.speciesPulls(profiles, { selfId: npcId, pull }, { soloSafety: true });
        if (!verdict?.canHunt) continue;
        const entry = count * Math.min(1, verdict.efficiency) ** 2;
        for (const [size, part] of verdict.allowed) {
            const mob = K.mobInput(tables, npcId, size);
            const row = corrections[`${K.rotKind(bot.rot)}|${size > 1 ? 'crowd' : 'solo'}`];
            const hour = M.mobHour(bot, mob, row ? { kph: row[0], deaths: row[1] } : null);
            if (!hour) continue;
            const w = entry * part;
            weight += w;
            cycle += w * 3600 / hour.fightsPerHour;
            kills += w * size * (1 - hour.deathChance);
            exp += w * size * (1 - hour.deathChance) * mob.exp;
            deaths += w * hour.deathChance;
        }
    }
    if (!(weight > 0) || !(cycle > 0)) return null;
    const kph = Math.min(cap, 3600 * kills / cycle);
    return { kph: C.round(kph), expPerKill: C.round(exp / kills), deathsPerHour: C.round(3600 * deaths / cycle * (kph / (3600 * kills / cycle))) };
}

function spotTableCheck() {
    const spotTable = JSON.parse(fs.readFileSync(`${C.root}/data/Bots/spot-table.json`, 'utf8'));
    const tables = { mobs: C.readTable('mobs'), spots: C.readTable('spots'), gear: C.readTable('gear'), rotation: C.readTable('rotation') };
    const corrections = C.readTable('corrections').corrections;
    const items = K.itemRows(tables.gear);
    const spotsById = new Map(tables.spots.spots.map(row => [row[0], row]));
    const dpsKey = spotTable.header.inputs.roleLines?.dps || 'dps';
    const roleIndex = spotTable.roles.indexOf(dpsKey), shotIndex = spotTable.shots.indexOf(1);
    const kph = spotTable.rowFields.indexOf('kph'), expField = spotTable.rowFields.indexOf('exp'), deathsField = spotTable.rowFields.indexOf('deaths'),
        refGap = spotTable.rowFields.indexOf('refGap'), capField = spotTable.rowFields.indexOf('cap');
    const out = [];
    // Spots of bands 25, 35, 45, 55 with the dps role huntable, a fixed pick.
    for (const want of [24, 34, 44, 54]) {
        const index = spotTable.spots.findIndex((spot, i) => spot[1] === want && spotTable.rows[i][roleIndex * 2 + shotIndex]
            && spotsById.has(spot[0]));
        if (index < 0) continue;
        const spot = spotTable.spots[index];
        const row = spotTable.rows[index][roleIndex * 2 + shotIndex];
        const level = spot[1] + row[refGap];
        const classId = spotTable.header.inputs.roleClasses[dpsKey][level < 20 ? 0 : level < 40 ? 1 : 2];
        const rot = M.rotationOf(tables.rotation, classId, level);
        const kit = { classId, level, rot, shots: true, profile: M.profileOf(HuntCycle.referenceState(classId, level)) };
        const gearClass = C.rowOfKey(tables.gear.classes, classId);
        const live = K.gearOptions(gearClass, level).filter(([name]) => name !== 'kit');
        // A per-mob table carries each row's cap; an older one the spot's fights.
        const cap = capField >= 0 ? row[capField] : spot[3];
        const result = { spot: spot[0], spotLevel: spot[1], botLevel: level, classId,
            spotTable: { kph: row[kph], expPerKill: row[expField], deathsPerKill: row[deathsField] },
            formulaKit: spotHour(kit, spotsById.get(spot[0]), tables, corrections, cap) };
        for (const [name, ids] of live) {
            const profile = M.profileOf(M.kitState(classId, level, K.wearList(ids, items)));
            result[`formula ${name}`] = spotHour({ ...kit, profile }, spotsById.get(spot[0]), tables, corrections, cap);
        }
        out.push(result);
    }
    return out;
}

function main() {
    const options = args();
    C.boot();
    const report = {};
    if (options.snapshot) report.strength = strengthCheck(options.snapshot, options.bots);
    report.formula = formulaCheck();
    report.sizes = sizes();
    report.spotTable = spotTableCheck();
    const text = `${JSON.stringify(report, null, 1)}\n`;
    if (options.out) fs.writeFileSync(options.out, text);
    else process.stdout.write(text);
    process.exit(0);
}

if (require.main === module) main();
