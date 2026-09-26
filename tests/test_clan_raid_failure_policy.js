const assert = require('node:assert/strict');

const Policy = require('../src/GameServer/Clan/ClanRaidFailurePolicy');

const closeFailure = Policy.decision(null, {
    bossTemplateId: 10131,
    hp: 25000,
    maxHp: 100000
});
assert.equal(closeFailure.consecutiveFailures, 1);
assert.equal(closeFailure.retryAllowed, true, 'one close failure may receive one retry');
assert.equal(closeFailure.reasonCode, 'raid_failure_retry');

const secondFailure = Policy.decision(closeFailure, {
    bossTemplateId: 10131,
    hp: 10000,
    maxHp: 100000
});
assert.equal(secondFailure.consecutiveFailures, 2);
assert.equal(secondFailure.retryAllowed, false, 'two consecutive failures must remove the boss goal');
assert.equal(secondFailure.reasonCode, 'raid_failure_limit');

const highHpFailure = Policy.decision(null, {
    bossTemplateId: 10280,
    hp: 30001,
    maxHp: 100000
});
assert.equal(highHpFailure.retryAllowed, false, 'more than 30% remaining HP must block a retry');
assert.equal(highHpFailure.reasonCode, 'raid_failure_high_hp');
assert.deepEqual([...Policy.blockedSpotIds({ raidFailure: highHpFailure })], ['raid:10280']);
assert.deepEqual([...Policy.blockedSpotIds(null)], [], 'a clan without a previous equipment goal has no blocked raid spots');

const differentBoss = Policy.decision(secondFailure, {
    bossTemplateId: 10496,
    hp: 20000,
    maxHp: 100000
});
assert.equal(differentBoss.consecutiveFailures, 1, 'the consecutive counter is per boss');
assert.equal(differentBoss.retryAllowed, true);

const carried = Policy.carriedFailure({ raidFailure: closeFailure }, {
    next: { sourceKind: 'raid', npcId: 10131 }
}, true);
assert.deepEqual(carried, closeFailure, 'an allowed retry must retain its first-failure count');
assert.deepEqual(Policy.carriedFailure({ raidFailure: closeFailure }, {
    next: { sourceKind: 'raid', npcId: 10496 }
}, true), closeFailure, 'the failed boss remains remembered while the same equipment debt uses another route');
assert.equal(Policy.carriedFailure({ raidFailure: closeFailure }, {
    next: { sourceKind: 'raid', npcId: 10131 }
}, false), null, 'rotating to a different equipment debt clears the old raid failure');

console.log('Clan raid failure threshold, retry limit and per-boss reset passed');
