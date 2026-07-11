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

console.log('Bot target scorer checks passed');
