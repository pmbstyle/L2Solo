const assert = require('assert');
const fs = require('fs');
const path = require('path');
require('../src/Global');
const DataCache = invoke('GameServer/DataCache');
const NpcSkills = invoke('GameServer/Npc/NpcSkills');
const Npc = invoke('GameServer/Npc/Npc');
const Attack = invoke('GameServer/Actor/Attack');
DataCache.init();

const hostile = new Set([4017, 4018, 4033, 4034, 4153, 4169, 4180, 4196, 4199, 4206, 4208, 4249,
    4724, 4725, 4726, 4727, 4728, 4744, 4745, 4746, 4760, 4761]);
const seen = new Set();
let affected = 0;
for (const template of DataCache.npcs) {
    const skills = NpcSkills.forNpc({ fetchSelfId: () => template.selfId });
    const matches = skills.filter((skill) => hostile.has(skill.fetchSelfId()));
    if (matches.length) affected++;
    for (const skill of matches) {
        seen.add(skill.fetchSelfId());
        assert.strictEqual(skill.fetchTargetKind(), 'enemy', `${template.selfId}/${skill.fetchSelfId()} must not self-cast`);
        assert.notStrictEqual(skill.fetchSemantic().effectType, 'buff');
        if ([4017, 4033].includes(skill.fetchSelfId())) {
            assert.strictEqual(skill.fetchSemantic().sourceTarget, 'aura');
            assert(skill.fetchSemantic().radius > 0);
            assert.strictEqual(skill.fetchSemantic().effect, null, 'pure damage must not inherit a phantom buff');
        }
    }
}
assert.deepStrictEqual([...seen].sort(), [...hostile].sort());
const paliote = new Npc(9900648, utils.crushOb(DataCache.npcs.find((n) => n.selfId === 648)));
const target = { effects: {}, fetchAiType: () => 'fighter', fetchId: () => 2000001 };
const skill = paliote.selectCombatSkill(target, () => 0);
assert.strictEqual(skill.fetchSelfId(), 4034);
assert.strictEqual(skill.fetchSkillType(), 'damageEffect');
assert.strictEqual(skill.fetchSemantic().stats.runSpdMul, 0.7);
assert.strictEqual(skill.fetchSemantic().durationMs, 120000);
assert.strictEqual(skill.fetchSemantic().trait, 'water');
const attack = new Attack();
assert.deepStrictEqual(attack.resolveSkillTargets({ actor: paliote }, paliote, target, skill), [target],
    'the actual attack target resolver must deliver the Paliote spell to its opponent');

// Optional full-source audit also catches new skills outside the regression list.
const sourceDir = path.join(__dirname, '../tmp/vendor/l2j-lisvus/datapack/data/stats/skills');
if (fs.existsSync(sourceDir)) {
    const xml = fs.readdirSync(sourceDir).filter((f) => f.endsWith('.xml')).map((f) => fs.readFileSync(path.join(sourceDir, f), 'utf8')).join('\n');
    const sources = new Map([...xml.matchAll(/<skill id="(\d+)"[\s\S]*?<\/skill>/g)].map((m) => [Number(m[1]), m[0]]));
    for (const npc of DataCache.npcs) for (const s of NpcSkills.forNpc({ fetchSelfId: () => npc.selfId })) {
        const source = sources.get(s.fetchSelfId()) || '';
        if (!s.fetchPassive() && /name="skillType" val="(?:MDAM|PDAM)"/.test(source)
            && /name="target" val="TARGET_(?:ONE|AURA|AREA)"/.test(source)) {
            assert.notStrictEqual(s.fetchTargetKind(), 'self', `${npc.selfId}/${s.fetchSelfId()} contradicts source attack target`);
        }
    }
}
console.log(`NPC offensive targets passed: ${seen.size} skills across ${affected} NPC templates`);
