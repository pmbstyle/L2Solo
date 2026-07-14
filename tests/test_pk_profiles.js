const assert = require('assert');

require('../src/Global');

const PkProfiles = invoke('GameServer/Bot/AI/PkProfiles');
const BotPopulation = invoke('GameServer/Bot/BotPopulation');
const BotManager = invoke('GameServer/Bot/BotManager');
const World = invoke('GameServer/World/World');

const pkBots = BotPopulation.pkEncounters(() => 0.5);
assert.strictEqual(pkBots.length, 7, 'starter grounds plus three higher hunting grounds should receive PK encounters');
assert(pkBots.every((bot) => bot.plan === 'pk_hunting' && bot.level >= 12), 'PKs must not be level-one starter bots');
assert(pkBots.every((bot) => bot.fullNewbieBlessing === false), 'PK encounter bots must not receive newbie buffs');
assert(pkBots.every((bot) => bot.pkProfile?.anchor && bot.pkProfile.targetMinLevel <= bot.pkProfile.targetMaxLevel), 'every PK requires a bounded local encounter profile');
assert.strictEqual(pkBots.filter((bot) => bot.encounterId === 'oren_fields').length, 2, 'Oren encounter should be a small PK pair');
assert.strictEqual(pkBots.filter((bot) => bot.encounterId === 'starter_wilds').length, 3, 'three random low-level encounters should seed newbie grounds');
assert(PkProfiles.asBotData(PkProfiles.PK_BOTS[0]).pkProfile.anchor, 'a starter profile should receive a concrete anchor when materialized');

const originalUsers = World.user;
const dion = pkBots.find((bot) => bot.encounterId === 'dion_wasteland');
World.user = {
    sessions: [
        {
            accountId: 'right_level',
            actor: {
                fetchIsOnline: () => true,
                fetchLevel: () => 30,
                fetchLocX: () => dion.pkProfile.anchor.locX,
                fetchLocY: () => dion.pkProfile.anchor.locY,
                state: { fetchDead: () => false }
            }
        },
        {
            accountId: 'wrong_level',
            actor: {
                fetchIsOnline: () => true,
                fetchLevel: () => 10,
                fetchLocX: () => dion.pkProfile.anchor.locX,
                fetchLocY: () => dion.pkProfile.anchor.locY,
                state: { fetchDead: () => false }
            }
        }
    ]
};
assert.strictEqual(BotManager.activePopulationForPk(dion.pkProfile).length, 2, 'a nearby player outside the hunt bracket must still keep the PK encounter active as a threat');
World.user.sessions[1].accountId = 'bot_local';
assert.strictEqual(BotManager.activePopulationForPk(dion.pkProfile).length, 2, 'an ordinary local bot should activate the encounter even if its level drifted from the player bracket');

const starter = pkBots.find((bot) => bot.dynamicStarter);
const persistedStarter = { locX: 12345, locY: 23456, locZ: -3456 };
BotManager.bindPkAnchorToCharacter(starter, persistedStarter);
assert.deepStrictEqual(starter.pkProfile.anchor, persistedStarter, 'a persisted starter PK must retain its previous encounter anchor across restarts');
World.user = originalUsers;

console.log('PK profile checks passed');
