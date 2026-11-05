'use strict';

// The files each precomputed bot table is simulated by, and their fingerprint:
// a change in one of these files makes the table stale. Read by the generators
// (scripts/generate-spot-table.js writes the spot table's header.fingerprint,
// scripts/hunt-tables/common.js each hunt table's), by scripts/check-tables.js
// (`npm run check` fails on a stale committed table) and by SpotValueTable
// (one log line at the first read, main thread). Readers only (SpotValueTable,
// SpotEconomics, SpotRewardExpectation, ...) are no input. A path is a file or
// a directory: every file under it but dot files and notes (*.md). A committed
// table with a header (spot-table.json, hunt/*.json) is no input of another:
// its revision moves with every rebuild, so the pair would never agree; the
// kit surface's data/Bots/hunt/gear.json is covered by the gear-ladder code it
// is built from.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../../..');

// Cold solo combat and what it calls.
const COLD_COMBAT = ['src/GameServer/Bot/Population/BackgroundResolver.js', 'src/GameServer/Bot/Population/ColdCombatProfile.js',
    'src/GameServer/Bot/Population/ColdMobAction.js', 'src/GameServer/Bot/Population/ColdRest.js',
    'src/GameServer/Bot/Population/ColdKillRewards.js', 'src/GameServer/Bot/Population/ColdClassPolicy.js',
    'src/GameServer/Bot/Population/ColdSummonProfile.js', 'src/GameServer/Bot/Population/ColdPveEncounter.js',
    'src/GameServer/Bot/Population/SurvivalFloor.js', 'src/GameServer/Bot/Population/ColdTrip.js',
    'src/GameServer/Combat', 'src/GameServer/Formulas.js', 'src/GameServer/Skills', 'src/GameServer/Effects',
    'src/GameServer/Npc/NpcCombatChoice.js', 'src/GameServer/Npc/NpcHate.js', 'src/GameServer/Npc/NpcSkills.js',
    'src/GameServer/Npc/NpcTraits.js', 'src/GameServer/Items', 'src/GameServer/Item/ItemTemplateIndex.js',
    'src/GameServer/Progression', 'src/GameServer/ProgressionRates.js'];
// The reference bot and its supplies.
const REFERENCE_BOT = ['src/GameServer/Bot/AI/BotGear.js', 'src/GameServer/Bot/AI/BotRoles.js',
    'src/GameServer/Bot/AI/BotTargetMatchup.js', 'src/GameServer/Bot/AI/BotEncounterReadiness.js',
    'src/GameServer/Bot/AI/BotClassPolicy.js', 'src/GameServer/Bot/AI/BotCombatUtility.js',
    'src/GameServer/Bot/AI/BotHuntingTargetPolicy.js', 'src/GameServer/Bot/AI/RestPolicy.js', 'src/GameServer/Bot/AI/RestPotion.js',
    'src/GameServer/Bot/AI/HealingPotionStock.js', 'src/GameServer/Bot/AI/SoloSelfHeal.js', 'src/GameServer/Bot/AI/PetHealRule.js',
    'src/GameServer/Bot/AI/PetTankRule.js', 'src/GameServer/Bot/AI/BotPullEstimate.js', 'src/GameServer/Bot/AI/GearGradeRule.js',
    'src/GameServer/Bot/AI/DangerRule.js', 'src/GameServer/Bot/AI/HuntCycle.js', 'src/GameServer/Inventory/ShotStock.js',
    'src/GameServer/Bot/Economy/TownVisitInterval.js', 'src/GameServer/ClassProgression.js'];
// The spot catalogue every row hangs on.
const CATALOGUE = ['src/GameServer/World/Generics/SpawnNpcs.js', 'src/GameServer/Bot/AI/SpotService.js',
    'src/GameServer/Bot/AI/SpotIndex.js', 'src/GameServer/Bot/Population/SpotProfiles.js', 'scripts/geodata-release.json'];
const GAME_DATA = ['data/Npcs', 'data/Items', 'data/Skills', 'data/Templates'];
// Gear ladders, item sources and hennas (hunt gear/sources/henna; the spot table's kit surface reads gear.json).
const GEAR_LADDERS = ['src/GameServer/Bot/AI/GearAcquisitionPlanner.js', 'src/GameServer/Bot/AI/BotEquipmentCompatibility.js',
    'src/GameServer/World/Generics/NpcShopBuyLists.js', 'src/GameServer/Bot/Economy/BotLuxuryExchange.js',
    'src/GameServer/Henna/HennaRules.js', 'data/Recipes', 'data/Henna'];
// The generators themselves (the spot generator shares the hunt model's helpers; the hunt build runs the spot
// generator's hunt and catalogue).
const SHARED_GENERATOR = ['scripts/generate-spot-table.js', 'scripts/hunt-tables/common.js',
    'scripts/hunt-tables/HuntModel.js', 'scripts/hunt-tables/static-tables.js'];
const HUNT_GENERATOR = ['scripts/hunt-tables/build.js', 'scripts/hunt-tables/rotation.js',
    'scripts/hunt-tables/corrections.js', 'scripts/hunt-tables/ceilings.js',
    // Its mob and spot list (no header: it moves only with the catalogue), its nearest towns.
    'data/Bots/spot-reward-npcs.json', 'src/GameServer/World/TownRespawn.js'];

const INPUTS = Object.freeze({
    spot: [...COLD_COMBAT, ...REFERENCE_BOT, ...CATALOGUE, ...GAME_DATA, ...GEAR_LADDERS, ...SHARED_GENERATOR],
    hunt: [...COLD_COMBAT, ...REFERENCE_BOT, ...CATALOGUE, ...GAME_DATA, ...GEAR_LADDERS, ...SHARED_GENERATOR, ...HUNT_GENERATOR]
});
// header.generator -> its inputs.
const GENERATORS = Object.freeze({ 'scripts/generate-spot-table.js': 'spot', 'scripts/hunt-tables/build.js': 'hunt' });

function walk(root, relative, out) {
    const full = path.join(root, relative);
    if (!fs.statSync(full).isDirectory()) {
        out.push(relative.split(path.sep).join('/'));
        return;
    }
    for (const name of fs.readdirSync(full).sort()) {
        if (!name.startsWith('.') && !name.endsWith('.md')) walk(root, path.join(relative, name), out);
    }
}

// The concrete file list of a table's inputs, and the listed paths that do not exist.
function files(kind, root = ROOT) {
    const listed = INPUTS[kind];
    if (!listed) throw new Error(`no table inputs ${kind}`);
    const out = [], missing = [];
    for (const input of new Set(listed)) {
        if (fs.existsSync(path.join(root, input))) walk(root, input, out);
        else missing.push(input);
    }
    return { files: [...new Set(out)].sort(), missing };
}

// A file's content without CR before LF: a Windows checkout (autocrlf) hashes as the committed file.
function fileHash(root, file) {
    let bytes = fs.readFileSync(path.join(root, file));
    if (bytes.includes(13)) bytes = Buffer.from(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
    return crypto.createHash('sha1').update(bytes).digest('hex').slice(0, 10);
}

function combined(hashes) {
    const sha = crypto.createHash('sha1');
    for (const file of Object.keys(hashes).sort()) sha.update(`${file}\0${hashes[file]}\n`);
    return sha.digest('hex').slice(0, 12);
}

// { hash, files: { path: hash } } of a table's inputs as they are now, plus the listed paths missing.
// One read and sha1 of each file (~20 MB, most of it data/Npcs).
function compute(kind, root = ROOT) {
    const listed = files(kind, root);
    const hashes = {};
    for (const file of listed.files) hashes[file] = fileHash(root, file);
    return { hash: combined(hashes), files: hashes, missing: listed.missing };
}

// What a generator writes as header.fingerprint.
function fingerprint(kind, root = ROOT) {
    const { hash, files: hashes } = compute(kind, root);
    return { hash, files: hashes };
}

// The header's fingerprint against the current files: 'unknown' (a table built
// without one), 'fresh', or 'stale' with the files added, removed or changed since.
function compare(recorded, current) {
    if (!recorded || typeof recorded.hash !== 'string' || !recorded.files) return { state: 'unknown', changed: [] };
    if (recorded.hash === current.hash) return { state: 'fresh', changed: [] };
    const changed = [...new Set([...Object.keys(recorded.files), ...Object.keys(current.files)])]
        .filter(file => recorded.files[file] !== current.files[file]).sort();
    return { state: 'stale', changed };
}

// A table header against the code: its inputs by header.generator.
function check(header, root = ROOT) {
    const kind = GENERATORS[header?.generator];
    if (!kind) return { state: 'unknown', changed: [], kind: null };
    if (!header.fingerprint) return { state: 'unknown', changed: [], kind };
    return { ...compare(header.fingerprint, compute(kind, root)), kind };
}

function list(changed, max = 8) {
    return changed.length > max ? `${changed.slice(0, max).join(', ')} and ${changed.length - max} more` : changed.join(', ');
}

module.exports = { INPUTS, GENERATORS, ROOT, files, compute, fingerprint, compare, check, list };
