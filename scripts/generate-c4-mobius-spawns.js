// Monster spawns from L2J_Mobius C4 (the reference for C4 data, user 2026-10-26, T43).
//
// Vendor (git, sparse): tmp/vendor/l2j-mobius at MOBIUS_REVISION with
//   L2J_Mobius_C4_ScionsOfDestiny/dist/game/data/{spawns,stats/npcs}
// and tmp/vendor/l2j-lisvus at the Lisvus revision of scripts/lib/generate-c4-monster-location.js
// (templates of the Mobius monsters this server has none for: all are in Lisvus).
//
// Writes data/Npcs/Spawns/c4_mobius_monsters.json (every Mobius Monster/FeedableBeast spawn,
// ids mapped to C4 client ids by Mobius's CT0_to_C4_ids.txt), the Lisvus templates, rewards,
// skills and items of the missing monsters, and strips from data/Npcs/Spawns/spawns.json every
// row of a monster Mobius spawns itself, and every ordinary monster row Mobius never spawns
// (siege guards, stray author rows). Raid bosses and every other row stay.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const Lisvus = require('./lib/generate-c4-monster-location');

const root = path.resolve(__dirname, '..');
const vendorRepo = path.join(root, 'tmp', 'vendor', 'l2j-mobius');
const mobiusData = path.join(vendorRepo, 'L2J_Mobius_C4_ScionsOfDestiny', 'dist', 'game', 'data');
const MOBIUS_REVISION = '6bc10d285b1bd7c0dc4f2a17b97af42f635f4712';
const MONSTER_TYPES = new Set(['Monster', 'FeedableBeast']);
const SLUG = 'c4_mobius_monsters';
// Mobius's own features, not C4 world content.
const SKIPPED_FILES = new Set(['Others/FakePlayers']);
// NPC MP Drain - Magic (Lisvus skills 4100-4199.xml), in the shape of the author's 4039 NPC MP Drain.
const SKILL_TEMPLATES = [{
    selfId: 4154,
    template: { name: 'NPC MP Drain - Magic', passive: false, spell: true, distance: 600 },
    time: { hitTime: 4000, reuse: 3000, buff: 0 },
    levels: [[34, 13], [57, 20], [78, 27], [105, 35], [134, 45], [165, 55], [194, 65], [206, 69], [216, 73], [224, 75], [229, 77], [232, 78]]
        .map(([power, mp], index) => ({ level: index + 1, power, mp, hp: 0, itemId: 0, itemCount: 0 }))
}];

function assertMobiusRevision() {
    const revision = execFileSync('git', ['-C', vendorRepo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (revision !== MOBIUS_REVISION) throw new Error(`Expected Mobius ${MOBIUS_REVISION}, found ${revision}`);
}

function xmlFiles(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) return xmlFiles(full);
        return entry.name.endsWith('.xml') ? [full] : [];
    }).sort();
}

function attributes(tag) {
    return Object.fromEntries([...tag.matchAll(/(\w+)="([^"]*)"/g)].map((match) => [match[1], match[2]]));
}

// Mobius C4 keeps Interlude npc ids; its own table maps them to C4 client ids.
function c4Ids() {
    const text = fs.readFileSync(path.join(mobiusData, 'stats', 'npcs', 'CT0_to_C4_ids.txt'), 'utf8');
    return new Map(text.split(/\r?\n/).map((line) => line.split(';').map(Number))
        .filter(([from, to]) => from > 0 && to > 0));
}

// The C4 id of a Mobius npc id; `where` names the row in the error.
function c4Id(idMap, sourceId, where) {
    const id = idMap.get(sourceId);
    if (!id) throw new Error(`Mobius npc ${sourceId} has no C4 id (${where})`);
    return id;
}

function mobiusTypes() {
    const types = new Map();
    xmlFiles(path.join(mobiusData, 'stats', 'npcs')).forEach((file) => {
        for (const match of fs.readFileSync(file, 'utf8').matchAll(/<npc\s[^>]*>/g)) {
            const attrs = attributes(match[0]);
            if (attrs.id && attrs.type) types.set(Number(attrs.id), attrs.type);
        }
    });
    return types;
}

// One Mobius <spawn>: an optional territory (polygon with minZ/maxZ, mobs at random points)
// and npc rows, either `count` mobs in the territory or one mob at a fixed point.
function mobiusSpawns() {
    const directory = path.join(mobiusData, 'spawns');
    return xmlFiles(directory).flatMap((file) => {
        const relative = path.relative(directory, file).replace(/\\/g, '/').replace(/\.xml$/, '');
        if (SKIPPED_FILES.has(relative)) return [];
        const xml = fs.readFileSync(file, 'utf8');
        return [...xml.matchAll(/<spawn\b([^>]*)>([\s\S]*?)<\/spawn>/g)].map((match, index) => {
            const attrs = attributes(match[1]);
            const territory = match[2].match(/<territory\b([^>]*)>([\s\S]*?)<\/territory>/);
            const zAttrs = territory ? attributes(territory[1]) : {};
            const bounds = territory
                ? [...territory[2].matchAll(/<node\b[^>]*>/g)].map((node) => {
                    const point = attributes(node[0]);
                    return { locX: Number(point.x), locY: Number(point.y), minZ: Number(zAttrs.minZ), maxZ: Number(zAttrs.maxZ) };
                })
                : [];
            const npcs = [...match[2].matchAll(/<npc\b[^>]*>/g)].map((npc) => attributes(npc[0]));
            return { id: `mobius:${relative}#${attrs.zone || attrs.name || index}`, bounds, npcs };
        });
    });
}

// Every npc template the world loads, but the ones of the generator's own file (`excluded`).
function ownTemplates(excluded = `${SLUG}.json`) {
    const directory = path.join(root, 'data', 'Npcs');
    const byId = new Map();
    fs.readdirSync(directory).filter((name) => name.endsWith('.json') && name !== excluded).forEach((name) => {
        const rows = require(path.join(directory, name));
        if (!Array.isArray(rows)) return;
        rows.filter((row) => row?.template && row.selfId !== undefined)
            .forEach((row) => byId.set(Number(row.selfId), row));
    });
    // The pet quest NPCs (Maille Lizardmen, Fairy Trees) load from their own file.
    require(path.join(root, 'data', 'Pets', 'c4-quest-npcs.json')).npcs
        .forEach((row) => byId.set(Number(row.selfId), row));
    return byId;
}

function convertSpawns(spawns, idMap, types) {
    const monsterIds = new Set();
    const spawnedIds = new Set();
    const groups = [];
    let slots = 0;
    for (const spawn of spawns) {
        const rows = [];
        const fixed = new Map();
        for (const npc of spawn.npcs) {
            const sourceId = Number(npc.id);
            const id = c4Id(idMap, sourceId, spawn.id);
            spawnedIds.add(id);
            if (!MONSTER_TYPES.has(types.get(sourceId))) continue;
            monsterIds.add(id);
            const respawn = Number(npc.respawnDelay || 0);
            const bias = Number(npc.respawnRandom || 0);
            const period = npc.periodOfDay || null;
            if (npc.x !== undefined) {
                const key = `${id}|${respawn}|${bias}|${period}`;
                if (!fixed.has(key)) {
                    const row = { selfId: id, coords: [], total: 1, respawn, bias };
                    if (period) row.period = period;
                    fixed.set(key, row);
                    rows.push(row);
                }
                fixed.get(key).coords.push({ locX: Number(npc.x), locY: Number(npc.y), locZ: Number(npc.z), head: Number(npc.heading || 0) });
                slots += 1;
            }
            else {
                if (spawn.bounds.length < 3) throw new Error(`Mobius count spawn without a territory: ${spawn.id}`);
                const row = { selfId: id, coords: [], total: Number(npc.count || 1), respawn, bias };
                if (period) row.period = period;
                rows.push(row);
                slots += row.total;
            }
        }
        if (rows.length) groups.push({ selfId: spawn.id, bounds: spawn.bounds, spawns: rows });
    }
    return { groups, monsterIds, spawnedIds, slots };
}

function stripOwnMonsterRows(templates, monsterIds, spawnedIds) {
    const file = path.join(root, 'data', 'Npcs', 'Spawns', 'spawns.json');
    const groups = JSON.parse(fs.readFileSync(file, 'utf8'));
    let removed = 0;
    const kept = groups.map((group) => {
        const spawns = group.spawns.filter((row) => {
            const template = templates.get(Number(row.selfId))?.template;
            const id = Number(row.selfId);
            const replaced = template?.raidBoss !== true
                && (monsterIds.has(id) || (template?.kind === 'Monster' && !spawnedIds.has(id)));
            if (replaced) removed += row.total * Math.max(1, row.coords.length);
            return !replaced;
        });
        return { ...group, spawns };
    }).filter((group) => group.spawns.length > 0);
    fs.writeFileSync(file, `${JSON.stringify(kept, null, 2)}\n`);
    return removed;
}

// Fixed points keep their file Z at spawn (SpawnNpcs), and the server walks only on our
// geodata, which is not built from the C4 client (T49). A Mobius point more than OFF_FLOOR
// above or below every floor of its cell moves onto a floor, when the mob can walk from
// there to the nearest well-placed point of its group: the Z of Lisvus's same mob within
// TWIN_RANGE when that one stands on a floor, else the nearest floor. Other points stay
// as Mobius has them (counted). Rerun after a geodata change.
const OFF_FLOOR = 300;
const TWIN_RANGE = 50;
const NEIGHBOUR_RANGE = 3000;
const PATH_NODES = 6000;
function fitToGeodata(groups) {
    require('../src/Global');
    const Geodata = invoke('GameServer/Geodata/GeodataEngine');
    const regions = new Set(groups.flatMap((group) => group.spawns.flatMap((row) =>
        row.coords.map((point) => Geodata.getRegionKey(point.locX, point.locY)))));
    const missingRegions = [...regions].filter((key) => !Geodata.loadRegion(...key.split('_').map(Number)));
    if (missingRegions.length) throw new Error(`Geodata regions missing (link data/Geodata): ${missingRegions.join(' ')}`);
    const floor = (point, z) => Geodata.getHeight(point.locX, point.locY, z);
    const onFloor = (point, z) => Math.abs(floor(point, z) - z) <= OFF_FLOOR;
    const twins = new Map();
    Lisvus.tuples('sql/spawnlist.sql').forEach((row) => {
        const id = Number(row[3]);
        if (!twins.has(id)) twins.set(id, []);
        twins.get(id).push({ locX: Number(row[4]), locY: Number(row[5]), locZ: Number(row[6]) });
    });
    const counts = { off: 0, lisvus: 0, floor: 0, kept: 0 };
    for (const group of groups) {
        const points = group.spawns.flatMap((row) => row.coords.map((point) => ({ point, id: row.selfId })));
        const placed = points.filter(({ point }) => onFloor(point, point.locZ));
        for (const { point, id } of points.filter(({ point }) => !onFloor(point, point.locZ))) {
            counts.off += 1;
            const twin = (twins.get(id) || []).find((other) => Math.hypot(other.locX - point.locX, other.locY - point.locY) <= TWIN_RANGE
                && onFloor(point, other.locZ));
            const z = twin ? floor(point, twin.locZ) : floor(point, point.locZ);
            const neighbour = placed.map(({ point: other }) => ({ other, distance: Math.hypot(other.locX - point.locX, other.locY - point.locY) }))
                .filter(({ distance }) => distance <= NEIGHBOUR_RANGE).sort((a, b) => a.distance - b.distance)[0]?.other;
            const path = neighbour && Geodata.findPath(point.locX, point.locY, z, neighbour.locX, neighbour.locY,
                floor(neighbour, neighbour.locZ), PATH_NODES);
            if (!path?.length) { counts.kept += 1; continue; }
            point.locZ = z;
            counts[twin ? 'lisvus' : 'floor'] += 1;
        }
    }
    return counts;
}

function generate() {
    assertMobiusRevision();
    const idMap = c4Ids();
    const types = mobiusTypes();
    const { groups, monsterIds, spawnedIds, slots } = convertSpawns(mobiusSpawns(), idMap, types);
    const heights = fitToGeodata(groups);
    const templates = ownTemplates();
    const missing = [...monsterIds].filter((id) => !templates.has(id));
    // A weapon this server has no template for cannot be generated here; its drop row is
    // left out and named (T45 compares drops with Mobius).
    const lisvus = Lisvus.lisvusMonsters(missing, { slug: SLUG, types: ['L2Monster', 'L2Minion', 'L2FeedableBeast'], skipUnknownWeapons: true });
    Lisvus.assertExact(lisvus.unknownSkillIds, SKILL_TEMPLATES.map((skill) => skill.selfId), 'Lisvus skills without a template');
    lisvus.npcs.forEach((npc) => templates.set(Number(npc.selfId), npc));
    groups.forEach((group) => group.spawns.forEach((row) => {
        row.name = templates.get(row.selfId).template.name;
    }));

    Lisvus.writeJson(`data/Npcs/Spawns/${SLUG}.json`, groups.map((group) => ({
        ...group,
        spawns: group.spawns.map(({ selfId, name, coords, total, respawn, bias, period }) =>
            ({ selfId, name, coords, total, respawn, bias, ...(period ? { period } : {}) }))
    })));
    Lisvus.writeJson(`data/Npcs/${SLUG}.json`, lisvus.npcs);
    Lisvus.writeJson(`data/Npcs/Rewards/${SLUG}.json`, lisvus.rewards);
    Lisvus.writeJson(`data/Npcs/Skills/${SLUG}.json`, lisvus.skillRows);
    Lisvus.writeJson(`data/Npcs/Skills/${SLUG}_templates.json`, SKILL_TEMPLATES);
    Lisvus.writeJson(`data/Items/Others/${SLUG}.json`, lisvus.items);
    const removed = stripOwnMonsterRows(templates, monsterIds, spawnedIds);
    return { groups: groups.length, slots, heights, monsters: monsterIds.size, templates: lisvus.npcs.length,
        drops: lisvus.rewards.length, items: lisvus.items.length, droppedWeapons: lisvus.skippedDrops, removed };
}

if (require.main === module) {
    const result = generate();
    console.info(`Mobius C4: ${result.groups} spawn groups, ${result.slots} monster slots, ${result.monsters} monster ids; `
        + `${result.templates} Lisvus templates, ${result.items} items, drop rows of unknown weapons left out: ${result.droppedWeapons.join(' ') || 'none'}; `
        + `${result.removed} own monster slots removed; fixed points off the geodata floor: ${result.heights.off} `
        + `(${result.heights.lisvus} to the Lisvus Z, ${result.heights.floor} to the floor, ${result.heights.kept} kept).`);
}

module.exports = { generate, MOBIUS_REVISION, MONSTER_TYPES, mobiusData, assertMobiusRevision, xmlFiles, attributes, c4Ids, c4Id, ownTemplates };
