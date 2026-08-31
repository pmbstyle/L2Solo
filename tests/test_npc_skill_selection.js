const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const Npc = invoke('GameServer/Npc/Npc');

DataCache.init();

function npc(selfId, objectId = 9900000 + selfId) {
    const template = DataCache.npcs.find((entry) => Number(entry.selfId) === Number(selfId));
    assert(template, `NPC template ${selfId} must be loaded`);
    return new Npc(objectId, utils.crushOb(template));
}

function target(ai = 'fighter') {
    return {
        effects: {},
        fetchAiType: () => ai
    };
}

const bifrons = npc(10146);
const bifronsTarget = target();
assert.strictEqual(bifrons.fetchAiType(), 'fighter', 'a sourced close-range raid boss should use the fighter profile');
assert.strictEqual(
    bifrons.selectCombatSkill(bifronsTarget, () => 0)?.fetchSelfId(),
    4743,
    'Bifrons should still cast its sourced strike when the C4 skill roll succeeds'
);
assert.strictEqual(
    bifrons.selectCombatSkill(bifronsTarget, () => 0.99),
    null,
    'Bifrons must fall back to a normal attack when its low-probability skill roll fails'
);

let successfulBifronsCasts = 0;
for (let index = 0; index < 100; index++) {
    const selected = bifrons.selectCombatSkill(bifronsTarget, () => (index % 10 === 0 ? 0 : 0.99));
    if (selected) successfulBifronsCasts++;
}
assert(successfulBifronsCasts > 0 && successfulBifronsCasts < 100,
    'a zero-reuse raid skill must be probabilistic instead of firing on every combat action');

const pan = npc(10019);
const panTarget = target();
assert.strictEqual(
    pan.selectCombatSkill(panTarget, () => 0)?.fetchSelfId(),
    4175,
    'Pan Dryad should open with its missing self buff'
);
EffectStore.apply(pan, {
    key: 'boss_haste',
    id: 4175,
    type: 'buff',
    durationMs: 60000
});
assert.strictEqual(
    pan.selectCombatSkill(panTarget, () => 0)?.fetchSelfId(),
    4172,
    'Pan Dryad should consider its sourced stun before ordinary damage when the roll succeeds'
);

let rolls = [0.99, 0];
assert.strictEqual(
    pan.selectCombatSkill(panTarget, () => rolls.shift())?.fetchSelfId(),
    4732,
    'a failed control roll should leave the NPC free to roll its ordinary damage skill'
);

EffectStore.apply(panTarget, {
    key: 'stun',
    id: 4172,
    category: 'stun',
    type: 'debuff',
    durationMs: 9000
});
assert.strictEqual(
    pan.selectCombatSkill(panTarget, () => 0)?.fetchSelfId(),
    4732,
    'an NPC must not chain another stun while the target is already disabled'
);

const boneWarlord = npc(422);
const unprotectedTarget = target();
assert.strictEqual(
    boneWarlord.selectCombatSkill(unprotectedTarget, () => 0)?.fetchSelfId(),
    4075,
    'Akaste Bone Warlord should retain its sourced Shock skill'
);
EffectStore.apply(unprotectedTarget, {
    key: 'stun',
    id: 4075,
    category: 'stun',
    type: 'debuff',
    durationMs: 9000
});
assert.strictEqual(
    boneWarlord.selectCombatSkill(unprotectedTarget, () => 0),
    null,
    'the Mithril Mines skeleton must not recast Shock into an already stunned target'
);

const lesserSuccubusTilfo = npc(57);
const tilfoTarget = target();
const tilfoHold = lesserSuccubusTilfo.fetchCombatSkills().find((skill) => skill.fetchSelfId() === 4047);
assert(tilfoHold, 'Lesser Succubus Tilfo should retain Hold level 2');
assert.deepStrictEqual(
    {
        level: tilfoHold.fetchLevel(),
        target: tilfoHold.fetchTargetKind(),
        effect: tilfoHold.fetchSemantic().effect,
        effectType: tilfoHold.fetchSemantic().effectType
    },
    { level: 2, target: 'enemy', effect: 'root', effectType: 'debuff' },
    'Lesser Succubus Tilfo Hold should load as the sourced enemy root instead of a self buff'
);
assert.strictEqual(
    lesserSuccubusTilfo.selectCombatSkill(tilfoTarget, () => 0)?.fetchSelfId(),
    4047,
    'Lesser Succubus Tilfo should select Hold when the root roll succeeds'
);
EffectStore.apply(tilfoTarget, {
    key: 'root',
    id: 4047,
    category: 'root',
    type: 'debuff',
    durationMs: 30000
});
assert.strictEqual(
    lesserSuccubusTilfo.selectCombatSkill(tilfoTarget, () => 0),
    null,
    'Lesser Succubus Tilfo must not recast Hold into an already rooted target'
);

const marshZombie = npc(15);
assert.strictEqual(
    marshZombie.fetchAiType(),
    'balanced',
    'source BALANCED AI must survive NPC template loading'
);
const marshZombieSpell = marshZombie.fetchCombatSkills().find((skill) => skill.fetchSelfId() === 4248);
assert(marshZombieSpell, 'Marsh Zombie must retain its sourced magic skill');
assert.strictEqual(
    marshZombie.fetchCombatSkillChance(marshZombieSpell, 'damage', marshZombie.fetchAiType(), 'fighter'),
    5,
    'BALANCED NPCs must use the low ranged damage-skill chance instead of mage spam'
);

console.log('NPC C4 skill selection checks passed');
