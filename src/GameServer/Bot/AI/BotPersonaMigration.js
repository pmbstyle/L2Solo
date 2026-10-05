'use strict';

const Types = require('./BotPersonaTypes');

const LEADER_TRIES = 64;
const LEADER_PASSES = 5;

function persona(row, archetype, salt = '') {
    return {
        characterId: Number(row.characterId),
        seed: String(row.seed),
        primaryDrive: Types.TYPES[archetype].drive,
        archetype,
        traits: Types.rollTraits(archetype, row.seed, salt),
        inclinations: Types.rollInclinations(archetype, row.seed, salt)
    };
}

// A clan leader keeps the clan's drive (a dwarf's is wealth) and takes the
// first type and roll, from the regular one on, that passes the author's
// founder gate (leaderScore within the top founderTopShare of its drive) at
// the given cut-offs; null when none of the tries passes, and the regular
// result stays.
function leaderPersona(row, regular, thresholds, total, Policy) {
    const drive = Types.isDwarf(row.classId) ? 'wealth' : row.primaryDrive;
    if (!(thresholds[drive] >= 0)) return null;
    for (let attempt = 0; attempt < LEADER_TRIES; attempt++) {
        const archetype = attempt === 0 && regular.primaryDrive === drive
            ? regular.archetype
            : Types.chooseType(row.classId, row.seed, {}, total, { drive, salt: `type:${attempt}` });
        const candidate = persona(row, archetype, attempt ? `:${attempt}` : '');
        if (Policy.leaderScore(candidate) >= thresholds[drive]) return candidate;
    }
    return null;
}

// Migration 52 (step 3.1, N6a), run by Database.applySchemaMigrations inside
// its transaction on the world database: every version 1 persona gets a type
// that fits the bot's current class by the deficit against the type shares
// (dwarves first, so they fill wealth), its traits and inclinations rolled by
// its seed, a new text card and version 2; clan leaders as leaderPersona;
// every bot's remembered listing prices (statsJson.marketPricing) are reset.
function apply(connection, timestamp = Date.now()) {
    const columns = connection.prepare('PRAGMA table_info(bot_personas)').all().map((column) => column.name);
    if (!columns.includes('inclinationsJson')) {
        connection.exec("ALTER TABLE bot_personas ADD COLUMN inclinationsJson TEXT NOT NULL DEFAULT '{}'");
    }
    const rows = connection.prepare(`SELECT p.characterId, p.version, p.seed, p.primaryDrive, p.archetype, p.traitsJson, c.classId
        FROM bot_personas p JOIN characters c ON c.id = p.characterId ORDER BY p.characterId`).all();
    const kept = rows.filter((row) => Number(row.version) >= 2);
    const todo = rows.filter((row) => Number(row.version) < 2);
    if (!todo.length) return { migrated: 0 };

    const counts = {};
    for (const row of kept) counts[row.archetype] = (counts[row.archetype] || 0) + 1;
    const ordered = [...todo].sort((a, b) => Number(Types.isDwarf(b.classId)) - Number(Types.isDwarf(a.classId)));
    const result = new Map();
    for (const row of ordered) {
        const archetype = Types.chooseType(row.classId, row.seed, counts, rows.length);
        counts[archetype] = (counts[archetype] || 0) + 1;
        result.set(Number(row.characterId), persona(row, archetype));
    }

    // Leaders against the cut-offs of the final population (what the
    // author's founderThresholds computes at run time): re-roll the leaders
    // below them, recompute, until no leader changes (at most LEADER_PASSES).
    const Policy = invoke('GameServer/Clan/ClanSimulationPolicy');
    const keptPersonas = kept.map((row) => ({ primaryDrive: row.primaryDrive, traits: JSON.parse(row.traitsJson) }));
    const leaders = new Set(connection.prepare('SELECT leaderId FROM clans WHERE leaderId > 0').all().map((row) => Number(row.leaderId)));
    const leaderRows = todo.filter((row) => leaders.has(Number(row.characterId)));
    const regular = new Map(leaderRows.map((row) => [Number(row.characterId), result.get(Number(row.characterId))]));
    const below = (leader, thresholds) => !(Policy.leaderScore(leader) >= thresholds[leader.primaryDrive]);
    let thresholds = Policy.founderThresholds([...keptPersonas, ...result.values()]);
    let leaderPasses = 0;
    for (let pass = 0; pass < LEADER_PASSES; pass++) {
        let changed = 0;
        for (const row of leaderRows) {
            const id = Number(row.characterId);
            if (!below(result.get(id), thresholds)) continue;
            const next = leaderPersona(row, regular.get(id), thresholds, rows.length, Policy) || regular.get(id);
            if (JSON.stringify(next) === JSON.stringify(result.get(id))) continue;
            result.set(id, next);
            changed++;
        }
        leaderPasses = pass + 1;
        thresholds = Policy.founderThresholds([...keptPersonas, ...result.values()]);
        if (!changed) break;
    }
    const leaderFallbacks = leaderRows.filter((row) => below(result.get(Number(row.characterId)), thresholds)).length;

    const textCardFor = invoke('GameServer/Bot/AI/BotPersona').textCardFor;
    const update = connection.prepare(`UPDATE bot_personas SET version = 2, primaryDrive = ?, archetype = ?, traitsJson = ?,
        inclinationsJson = ?, textCard = ?, updatedAt = ? WHERE characterId = ? AND version < 2`);
    for (const next of result.values()) {
        update.run(next.primaryDrive, next.archetype, JSON.stringify(next.traits), JSON.stringify(next.inclinations),
            textCardFor(next), timestamp, next.characterId);
    }
    const reset = connection.prepare(`UPDATE bot_life_state SET statsJson = json_remove(statsJson, '$.marketPricing')
        WHERE json_valid(statsJson) AND json_type(statsJson, '$.marketPricing') IS NOT NULL`).run();
    return { migrated: result.size, leaders: leaderRows.length, leaderFallbacks, leaderPasses, thresholds,
        marketPricingReset: Number(reset.changes || 0) };
}

module.exports = { apply, LEADER_TRIES, LEADER_PASSES };
