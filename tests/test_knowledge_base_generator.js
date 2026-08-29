const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const databaseDir = path.join(root, 'data', 'KnowledgeBase');
const check = spawnSync(process.execPath, ['scripts/generate-knowledge-base.js', '--check', '--quiet'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' }
});
assert.strictEqual(check.status, 0, check.stderr || check.stdout || 'knowledge base check failed');

const manifest = require('../data/KnowledgeBase/manifest.json');
const items = require('../data/KnowledgeBase/items.json');
const mobs = require('../data/KnowledgeBase/mobs.json');
const skills = require('../data/KnowledgeBase/skills.json');
const spawns = require('../data/KnowledgeBase/spawns.json');

assert.strictEqual(manifest.schemaVersion, 1);
assert.strictEqual(manifest.deterministic, true);
assert.strictEqual(manifest.counts.items, items.length);
assert.strictEqual(manifest.counts.mobs, mobs.length);
assert.strictEqual(manifest.counts.skills, skills.length);
assert.strictEqual(manifest.counts.spawnDefinitions, spawns.length);

Object.entries(manifest.sha256).forEach(([name, expected]) => {
    const contents = fs.readFileSync(path.join(databaseDir, name));
    assert.strictEqual(crypto.createHash('sha256').update(contents).digest('hex'), expected, `${name} hash must match manifest`);
});

function uniqueIndex(rows, key, label) {
    const index = new Map();
    rows.forEach((row) => {
        assert(!index.has(row[key]), `${label} ${row[key]} must be unique`);
        index.set(row[key], row);
    });
    return index;
}

const itemById = uniqueIndex(items, 'id', 'item');
const mobById = uniqueIndex(mobs, 'id', 'mob');
const skillById = uniqueIndex(skills, 'key', 'skill');
const spawnById = uniqueIndex(spawns, 'id', 'spawn');

mobs.forEach((mob) => {
    mob.skillIds.forEach((skillId) => assert(skillById.has(skillId), `mob ${mob.id} skill ${skillId} must exist`));
    mob.spawnIds.forEach((spawnId) => {
        assert(spawnById.has(spawnId), `mob ${mob.id} spawn ${spawnId} must exist`);
        assert.strictEqual(spawnById.get(spawnId).mobId, mob.id, `spawn ${spawnId} must point back to mob ${mob.id}`);
    });
    [...mob.drops, ...mob.spoils].forEach((group) => group.items.forEach((item) => {
        assert(itemById.has(item.itemId), `mob ${mob.id} reward item ${item.itemId} must exist`);
    }));
});

items.forEach((item) => {
    [...item.sources.drops, ...item.sources.spoils].forEach((source) => {
        assert(mobById.has(source.mobId), `item ${item.id} source mob ${source.mobId} must exist`);
    });
});

const alligator = mobById.get(135);
assert.strictEqual(alligator.name, 'Alligator');
assert.strictEqual(alligator.progression.baseExp, 2373);
assert(alligator.spawnIds.length > 0, 'Alligator must retain its map locations');

const bichHwa = itemById.get(261);
const alligatorSource = bichHwa.sources.drops.find((source) => source.mobId === 135);
assert(alligatorSource, "Bich'Hwa must link back to Alligator");
assert(Math.abs(alligatorSource.rateProfiles.x50.chancePercent - 0.131480721661) < 1e-12,
    "Bich'Hwa must retain the runtime x50 category chance");

const halingka = mobById.get(646);
assert.strictEqual(halingka.template.vitals.maxHp, 2643);
assert.strictEqual(halingka.defaultEffectiveStats.maxHp, 5286, 'Strong Type must affect generated effective HP');
assert(halingka.skillIds.includes('4303:1'), 'Strong Type must remain inspectable through the skill catalog');

const raidMinion = mobById.get(10002);
assert.deepStrictEqual(raidMinion.availability, {
    directSpawn: false,
    knownReachable: true,
    raidMinion: true
});
assert(raidMinion.minionOf.some((relation) => relation.bossId === 10001));

assert.deepStrictEqual(
    manifest.anomalies.duplicateItemDefinitions.map((entry) => entry.id),
    [5550, 5551, 5552, 5553, 5554],
    'known item duplicates must stay explicit instead of being silently discarded'
);

console.log('knowledge base generator ok');
