const assert = require('assert');

require('../src/Global');

const BotTargetScorer = invoke('GameServer/Bot/AI/BotTargetScorer');

const appropriate = BotTargetScorer.score({
    attackable: true,
    dead: false,
    botLevel: 20,
    npcLevel: 21,
    distance: 500,
    verticalGap: 20,
    currentSpotId: '20_20',
    npcSpotId: '20_20'
});
const dangerous = BotTargetScorer.score({
    attackable: true,
    dead: false,
    botLevel: 20,
    npcLevel: 27,
    distance: 100,
    verticalGap: 20,
    currentSpotId: '20_20',
    npcSpotId: '20_21'
});
assert(appropriate.score > dangerous.score, 'level-appropriate same-spot mob should outrank a closer dangerous mob');

const unreachableVertical = BotTargetScorer.score({
    attackable: true,
    dead: false,
    botLevel: 20,
    npcLevel: 20,
    distance: 200,
    verticalGap: 1500
});
assert.strictEqual(unreachableVertical.eligible, false, 'large vertical gap should reject a target');
assert.strictEqual(unreachableVertical.reason, 'vertical_gap');

const freeMob = BotTargetScorer.score({
    attackable: true,
    dead: false,
    botLevel: 20,
    npcLevel: 20,
    distance: 350
});
const claimedSocialMob = BotTargetScorer.score({
    attackable: true,
    dead: false,
    botLevel: 20,
    npcLevel: 20,
    distance: 150,
    claimed: true,
    socialAllies: 3
});
assert(freeMob.score > claimedSocialMob.score, 'free isolated mob should outrank a closer claimed social mob');
assert(claimedSocialMob.reasons.includes('claimed'));
assert(claimedSocialMob.reasons.includes('social_allies:3'));

const openPath = BotTargetScorer.score({
    attackable: true,
    dead: false,
    botLevel: 20,
    npcLevel: 20,
    distance: 400,
    directPath: true
});
const blockedPath = BotTargetScorer.score({
    attackable: true,
    dead: false,
    botLevel: 20,
    npcLevel: 20,
    distance: 300,
    directPath: false
});
assert(openPath.score > blockedPath.score, 'clear direct path should outrank a slightly closer blocked target');
assert(blockedPath.reasons.includes('blocked_direct_path'));

const cooled = BotTargetScorer.score({
    attackable: true,
    dead: false,
    retryCooldown: true,
    botLevel: 20,
    npcLevel: 20
});
assert.strictEqual(cooled.eligible, false, 'retry cooldown should exclude a recently abandoned target');

const raidEntity = BotTargetScorer.score({
    attackable: true,
    dead: false,
    raidEntity: true,
    botLevel: 20,
    npcLevel: 20,
    distance: 10
});
assert.strictEqual(raidEntity.eligible, false, 'raid entities must never enter ordinary bot target ranking');
assert.strictEqual(raidEntity.reason, 'raid_entity_protected');

const overmatchedSolo = BotTargetScorer.score({
    attackable: true,
    dead: false,
    solo: true,
    botLevel: 55,
    npcLevel: 55,
    botPAtk: 79,
    botMAtk: 41,
    botPDef: 247,
    botMaxHp: 853,
    npcPAtk: 250,
    npcPDef: 145,
    npcMDef: 120,
    npcMaxHp: 1279
});
assert.strictEqual(overmatchedSolo.eligible, false,
    'a solo bot must reject a same-level target that decisively outmatches its combat stats');
assert.strictEqual(overmatchedSolo.reason, 'overmatched_stats');

const sameMatchupInParty = BotTargetScorer.score({
    attackable: true,
    dead: false,
    solo: false,
    botLevel: 55,
    npcLevel: 55,
    botPAtk: 79,
    botMAtk: 41,
    botPDef: 247,
    botMaxHp: 853,
    npcPAtk: 250,
    npcPDef: 145,
    npcMDef: 120,
    npcMaxHp: 1279
});
assert.strictEqual(sameMatchupInParty.eligible, true,
    'the solo matchup gate must not reject a coordinated party target');

const badCandidate = {
    evaluation: BotTargetScorer.score({
        attackable: true,
        dead: false,
        botLevel: 20,
        npcLevel: 27,
        distance: 2400,
        currentSpotId: '20_20',
        npcSpotId: '20_21',
        claimed: true,
        socialAllies: 4,
        directPath: false
    })
};
assert(badCandidate.evaluation.score < 0, 'fixture should represent a harmful target choice');
assert.deepStrictEqual(BotTargetScorer.rank([badCandidate]), [], 'negative-utility targets should not be selected');

const holyHealer = {
    attackable: true, botLevel: 70, npcLevel: 60, minLevelGap: -15, solo: true, botRole: 'healer',
    botPAtk: 208, botMAtk: 426, botPDef: 448, botMaxHp: 1464,
    npcPAtk: 400, npcPDef: 500, npcMDef: 300, npcMaxHp: 2500,
    targetMatchup: { eligible: true, efficiency: 1, penalty: 0, survivalRatio: 2 }
};
assert(BotTargetScorer.powerRatio(holyHealer) < BotTargetScorer.MIN_SOLO_POWER_RATIO);
assert.equal(BotTargetScorer.score(holyHealer).eligible, true,
    'a complete holy-spell survival estimate must outrank the physical-only shortcut');
assert.equal(BotTargetScorer.score({ ...holyHealer, npcLevel: 52 }).reason, 'level_too_low');
assert.equal(BotTargetScorer.score({ ...holyHealer, npcLevel: 52, allowTrivialTargets: true }).eligible, true,
    'a deferred earning hunt may recover on proven-safe deeper-blue undead');
assert.equal(BotTargetScorer.score({ ...holyHealer, npcLevel: 52, allowTrivialTargets: true,
    targetMatchup: { ...holyHealer.targetMatchup, survivalRatio: null }
}).reason, 'level_too_low', 'recovery cannot relax the level band without a complete survival estimate');
assert.equal(BotTargetScorer.score({ ...holyHealer,
    targetMatchup: { ...holyHealer.targetMatchup, eligible: false, reason: 'insufficient_survival_margin', survivalRatio: 0.5 }
}).eligible, false, 'unsafe fights remain rejected');
assert.equal(BotTargetScorer.score({ ...holyHealer,
    targetMatchup: { ...holyHealer.targetMatchup, survivalRatio: null }
}).reason, 'overmatched_stats', 'partial projections must retain the coarse safety gate');

console.log('Bot target scorer checks passed');
