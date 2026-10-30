const assert = require('assert');

require('../src/Global');

// C4 pays mpInitialConsume at cast start plus mpConsume at launch; a cast here
// pays one number (Skill.fetchConsumedMp), so it must be the C4 sum.
// Source: L2J Lisvus C4 skills xml (scripts/check-skill-mp.js checks every level).
const DataCache = invoke('GameServer/DataCache');
const SkillModel = invoke('GameServer/Model/Skill');
const SkillRankIndex = require('../src/GameServer/Skills/SkillRankIndex');

DataCache.init();

// The skill a character owns, built the way Skillset.populate builds it.
function ownedSkill(selfId, level) {
    let built = null;
    DataCache.fetchSkillFromSelfId(selfId, (skill) => {
        const entry = SkillRankIndex.findOrLastEligible(skill.levels, level);
        assert.strictEqual(Number(entry?.level), level, `skill ${selfId} serves level ${level}`);
        delete skill.levels;
        built = new SkillModel({ ...utils.crushOb(skill), ...entry });
    });
    assert(built, `skill ${selfId} is defined`);
    return built;
}

const totals = [
    [1230, 6, 44, 'Prominence 6: 35 + 9 initial'],
    [1231, 6, 44, 'Aura Flare 6: 35 + 9 initial'],
    [1233, 1, 65, 'Decay 1: 52 + 13 initial'],
    [1172, 8, 30, 'Aura Burn 8: 24 + 6 initial'],
    [15, 1, 37, 'Charm 1: 29 + 8 initial (Mobius C4 has 10; l2hub C4 37)'],
    [1108, 1, 97, 'Seal of Flame 1: 77 + 20 (Lisvus defines the initial table without setting it; l2hub 97)'],
    [1206, 1, 3, 'Wind Shackle 1 (l2hub 3)'],
    [1020, 27, 144, 'Vitalize 27: a level past the old file end paid level 9\'s 111'],
    [1048, 1, 39, 'Bless the Soul 1: the first of two Lisvus #mpConsume tables, 31 + 8 initial (l2hub 39, not 47)'],
    [97, 5, 86, 'Sanctuary 5: l2hub classes/paladin 86 (Lisvus 87)'],
    [1011, 1, 10, 'Heal 1: l2hub classes/dark_mage 10 (Lisvus 11)']
];
for (const [selfId, level, mp, why] of totals) {
    assert.strictEqual(ownedSkill(selfId, level).fetchConsumedMp(), mp, why);
}

assert.strictEqual(ownedSkill(1172, 1).fetchReuseTime(), 2000, 'Aura Burn reuse is the Lisvus C4 2000 ms');

console.log('Skill MP C4 totals tests passed');
