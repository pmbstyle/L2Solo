'use strict';
// The kit surface (user 10-29): the spot table reads a bot's own kit by its
// numbers against the author's kit (HuntCycle.kitFeatures), on fight and
// damage-taken coefficients fitted from real fights in kits; a band without
// them reads the nearest measured one.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
require('../src/Global');
invoke('GameServer/DataCache').init();
const HuntCycle = invoke('GameServer/Bot/AI/HuntCycle');
const Table = invoke('GameServer/Bot/AI/SpotValueTable');

const ref = { pAtk: 100, atkSpd: 300, accur: 40, critical: 40, mAtk: 50, castSpd: 300, pDef: 200, mDef: 150, evasion: 35, maxHp: 1000 };
const row = { mobAccur: 40, mobEvasion: 30 };
assert.deepEqual(HuntCycle.kitFeatures(ref, ref, row, false), [0, 0, 0, 0], 'the author\'s kit: no change');
const [offence, pDefence, mDefence, hp] = HuntCycle.kitFeatures({ ...ref, pAtk: 200, pDef: 300, mDef: 150, maxHp: 1200 }, ref, row, false);
assert(offence > 0.5 && pDefence > 0 && mDefence === 0 && hp > 0, 'a stronger weapon and armour move their features');
assert(HuntCycle.kitFeatures({ ...ref, mAtk: 100 }, ref, row, true)[0] > 0, 'a caster\'s offence is its M.Atk');
assert.deepEqual(HuntCycle.weighFeatures([1, 2, 3, 4], 0), [1, 2, 0, 4], 'hits only: M.Def meets nothing');
assert.deepEqual(HuntCycle.weighFeatures([1, 2, 3, 4], 1), [1, 0, 3, 4], 'spells only: P.Def meets nothing');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'spot_table.json'), 'utf8'));
fixture.kitSurface = { features: HuntCycle.KIT_FEATURES, fields: ['fight', 'taken'],
    rows: { dps: { 10: [[-0.9, 0, 0, 0], [0, -0.8, -0.1, 0], 12, 0.05, 0.1] },
        mage: { 18: [[-0.4, 0, 0, 0], null, 33, 0.09, null] } } };
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kit-surface-')), 'table.json');
fs.writeFileSync(file, JSON.stringify(fixture));
Table.useFile(file);
try {
    assert.deepEqual(Table.kitSurface('dps', 21), { fight: [-0.9, 0, 0, 0], taken: [0, -0.8, -0.1, 0] }, 'its band');
    assert.deepEqual(Table.kitSurface('dps', 40)?.fight, [-0.9, 0, 0, 0], 'a band without one reads the nearest');
    assert.equal(Table.kitSurface('tank', 21), null, 'a key without a surface: none');
    assert.deepEqual(Table.kitSurface('mage', 37), { fight: [-0.4, 0, 0, 0], taken: null },
        'a caster that took no hit in any kit has no taken coefficients');
} finally {
    Table.useFile();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
}
// On the real table a high caster reads its surface; a band without taken
// coefficients keeps the closed-form damage and gives a finite gain.
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const mage = HuntCycle.referenceState(12, 37);
mage.characterId = 953901;
for (const [key, item] of Object.entries(mage.inventory)) if (Number(item.slot) === 10) delete mage.inventory[key];
// The robe (437) worn against the bare chest, through the model's reader.
const { before, after } = Profile.candidateProfiles(mage, 1791335800000);
const robeGain = HuntCycle.reader(mage, { gearThreatMask: 1 }).gain(before, after({ free: () => false, wear: { selfId: 437, enchant: 0, slot: 10 } }));
assert(Number.isFinite(robeGain), 'a finite robe gain');
Profile.forgetBuild(mage.characterId);
console.log('PASS hunt kit surface');
