const assert = require('assert');

const nativeFixture = require('./helpers/isolatedSocialDatabase')('f1-spatial-test_pk_profiles');
require('../src/Global');
nativeFixture.assertConfigured(options.default);

const PkProfiles = invoke('GameServer/Bot/AI/PkProfiles');

const pkBots = PkProfiles.materializeBots(() => 0.5);
assert.strictEqual(pkBots.length, 7, 'starter grounds plus three higher hunting grounds should receive PK encounters');
assert(pkBots.every((bot) => bot.plan === 'pk_hunting' && bot.level >= 12), 'PKs must not be level-one starter bots');
assert(pkBots.every((bot) => bot.fullNewbieBlessing === false), 'PK encounter bots must not receive newbie buffs');
assert(pkBots.every((bot) => bot.pkProfile?.anchor && bot.pkProfile.targetMinLevel <= bot.pkProfile.targetMaxLevel), 'every PK requires a bounded local encounter profile');
assert.strictEqual(pkBots.filter((bot) => bot.encounterId === 'oren_fields').length, 2, 'Oren encounter should be a small PK pair');
assert.strictEqual(pkBots.filter((bot) => bot.encounterId === 'starter_wilds').length, 3, 'three random low-level encounters should seed newbie grounds');
assert(PkProfiles.asBotData(PkProfiles.PK_BOTS[0]).pkProfile.anchor, 'a starter profile should receive a concrete anchor when materialized');

console.log('PK profile checks passed');
require('node:fs').rmSync(nativeFixture.directory, { recursive: true, force: true });
