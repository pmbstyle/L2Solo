const assert = require('assert');

require('../src/Global');

const SkillModel = invoke('GameServer/Model/Skill');
const activeSkills = require('../data/Skills/Active/active.json');

// Lisvus C4 datapack snapshot: active TARGET_AREA / TARGET_AURA / TARGET_FRONT_AREA skills
// that are present in data/Skills/Active/active.json.
const sourcedAreaSkills = [
    { id: 7, name: 'Sonic Storm', sourceTarget: 'area', radius: 205 },
    { id: 9, name: 'Sonic Buster', sourceTarget: 'front_area', radius: 200 },
    { id: 17, name: 'Force Buster', sourceTarget: 'front_area', radius: 200 },
    { id: 18, name: 'Hate Aura', sourceTarget: 'aura', radius: 200 },
    { id: 24, name: 'Burst Shot', sourceTarget: 'area', radius: 150 },
    { id: 35, name: 'Force Storm', sourceTarget: 'area', radius: 150 },
    { id: 36, name: 'Whirlwind', sourceTarget: 'aura', radius: 150 },
    { id: 48, name: 'Thunder Storm', sourceTarget: 'aura', radius: 150 },
    { id: 84, name: 'Poison Blade Dance', sourceTarget: 'aura', radius: 150 },
    { id: 98, name: 'Sword Symphony', sourceTarget: 'aura', radius: 150 },
    { id: 116, name: 'Howl', sourceTarget: 'aura', radius: 200 },
    { id: 245, name: 'Wild Sweep', sourceTarget: 'area', radius: 150 },
    { id: 1072, name: 'Sleeping Cloud', sourceTarget: 'area', radius: 200 },
    { id: 1096, name: 'Seal of Chaos', sourceTarget: 'aura', radius: 200 },
    { id: 1099, name: 'Seal of Slow', sourceTarget: 'aura', radius: 200 },
    { id: 1101, name: 'Blaze Quake', sourceTarget: 'aura', radius: 200 },
    { id: 1104, name: 'Seal of Winter', sourceTarget: 'aura', radius: 200 },
    { id: 1108, name: 'Seal of Flame', sourceTarget: 'aura', radius: 200 },
    { id: 1167, name: 'Poisonous Cloud', sourceTarget: 'area', radius: 200 },
    { id: 1171, name: 'Blazing Circle', sourceTarget: 'aura', radius: 200 },
    { id: 1174, name: 'Frost Wall', sourceTarget: 'front_area', radius: 200 },
    { id: 1176, name: 'Tempest', sourceTarget: 'area', radius: 200 },
    { id: 1181, name: 'Flame Strike', sourceTarget: 'area', radius: 200 },
    { id: 1208, name: 'Seal of Binding', sourceTarget: 'aura', radius: 200 },
    { id: 1209, name: 'Seal of Poison', sourceTarget: 'aura', radius: 200 },
    { id: 1210, name: 'Seal of Gloom', sourceTarget: 'aura', radius: 200 },
    { id: 1213, name: 'Seal of Mirage', sourceTarget: 'aura', radius: 200 },
    { id: 1246, name: 'Seal of Silence', sourceTarget: 'aura', radius: 200 },
    { id: 1247, name: 'Seal of Scourge', sourceTarget: 'aura', radius: 200 },
    { id: 1248, name: 'Seal of Suspension', sourceTarget: 'aura', radius: 200 },
    { id: 1366, name: 'Seal of Despair', sourceTarget: 'aura', radius: 200 },
    { id: 1367, name: 'Seal of Disease', sourceTarget: 'area', radius: 200 },
    { id: 4064, name: 'Paralysis', sourceTarget: 'area', radius: 200 },
    { id: 4072, name: 'Shock', sourceTarget: 'aura', radius: 150 },
    { id: 4078, name: 'NPC Flamestrike', sourceTarget: 'area', radius: 200 },
    { id: 4101, name: 'NPC Spinning Slasher', sourceTarget: 'aura', radius: 150 },
    { id: 4106, name: 'Shock', sourceTarget: 'aura', radius: 1100 },
    { id: 4107, name: 'Shock', sourceTarget: 'aura', radius: 1100 },
    { id: 4108, name: 'Terror', sourceTarget: 'area', radius: 400 },
    { id: 4109, name: 'Curse of Antharas', sourceTarget: 'aura', radius: 850 },
    { id: 4111, name: 'Fossilization', sourceTarget: 'area', radius: 700 },
    { id: 4112, name: 'Ordinary Attack', sourceTarget: 'area', radius: 100 },
    { id: 4113, name: 'Animal doing ordinary attack', sourceTarget: 'area', radius: 100 },
    { id: 4114, name: 'Aden Flame', sourceTarget: 'area', radius: 200 },
    { id: 4118, name: 'Paralysis', sourceTarget: 'area', radius: 200 }
];

function skill(entry) {
    const data = activeSkills.find((active) => active.selfId === entry.id);
    assert(data, `${entry.name} (${entry.id}) should be present in active skill data`);

    const levelIndex = Math.max(0, data.levels.length - 1);
    const level = data.levels[levelIndex];

    return new SkillModel({
        selfId: entry.id,
        name: data.template.name,
        passive: false,
        spell: data.template.isMagic === true,
        distance: data.template.distance,
        hitTime: data.time.hitTime,
        reuse: data.time.reuse,
        buff: data.time.buff,
        level: levelIndex + 1,
        power: level.power,
        mp: level.mp,
        hp: level.hp,
        itemId: level.itemId,
        itemCount: level.itemCount
    });
}

sourcedAreaSkills.forEach((entry) => {
    const semantic = skill(entry).fetchSemantic();
    assert.strictEqual(semantic.sourceTarget, entry.sourceTarget, `${entry.name} (${entry.id}) should preserve sourced AoE target shape`);
    assert.strictEqual(semantic.radius, entry.radius, `${entry.name} (${entry.id}) should preserve sourced AoE radius`);
});

console.log('Skill area semantic audit passed');
