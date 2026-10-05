'use strict';

const Types = require('./BotPersonaTypes');

const LEADER_TRIES = 64;

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
// founder gate (leaderScore within the top founderTopShare of its drive,
// thresholds of the regular result of the whole population); null when none
// of the tries passes, and the regular result stays.
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

    const Policy = invoke('GameServer/Clan/ClanSimulationPolicy');
    const population = [...kept.map((row) => ({ primaryDrive: row.primaryDrive, traits: JSON.parse(row.traitsJson) })), ...result.values()];
    const thresholds = Policy.founderThresholds(population);
    const leaders = new Set(connection.prepare('SELECT leaderId FROM clans WHERE leaderId > 0').all().map((row) => Number(row.leaderId)));
    let leaderFallbacks = 0;
    for (const row of todo) {
        const id = Number(row.characterId);
        if (!leaders.has(id)) continue;
        const leader = leaderPersona(row, result.get(id), thresholds, rows.length, Policy);
        if (leader) result.set(id, leader);
        else leaderFallbacks++;
    }

    const textCardFor = invoke('GameServer/Bot/AI/BotPersona').textCardFor;
    const update = connection.prepare(`UPDATE bot_personas SET version = 2, primaryDrive = ?, archetype = ?, traitsJson = ?,
        inclinationsJson = ?, textCard = ?, updatedAt = ? WHERE characterId = ? AND version < 2`);
    for (const next of result.values()) {
        update.run(next.primaryDrive, next.archetype, JSON.stringify(next.traits), JSON.stringify(next.inclinations),
            textCardFor(next), timestamp, next.characterId);
    }
    const reset = connection.prepare(`UPDATE bot_life_state SET statsJson = json_remove(statsJson, '$.marketPricing')
        WHERE json_valid(statsJson) AND json_type(statsJson, '$.marketPricing') IS NOT NULL`).run();
    return { migrated: result.size, leaders: leaders.size, leaderFallbacks, marketPricingReset: Number(reset.changes || 0) };
}

module.exports = { apply, LEADER_TRIES };
