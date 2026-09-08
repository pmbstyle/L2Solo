const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const spotModule = { exports: {} };
vm.runInNewContext(fs.readFileSync('src/GameServer/Bot/AI/SpotService.js', 'utf8'), {
    module: spotModule, invoke: () => ({}), require
});
const timers = [], teleports = [];
let casts = false, threat = false;
const bot = { x: 10000, fetchLocX() { return this.x; }, fetchLocY: () => 0, fetchLocZ: () => 0,
    fetchId: () => 2, isDead: () => false, state: { fetchCasts: () => casts, setCasts: v => { casts = v; } },
    automation: { abortAll() {} } };
const originalSpot = { id: 'home-farm' };
const session = { currentSpot: originalSpot, initialSpawnCoord: { locX: 1, locY: 2, locZ: 3 } };
const mocks = {
    'GameServer/Network/Response': { skillStarted() {} },
    'GameServer/Bot/AI/SpotService': { findById: () => null, assignSpot: spotModule.exports.assignSpot },
    'GameServer/Bot/AI/BotEventJournal': { record: async () => {} },
    'GameServer/Bot/AI/BotTownTravel': { hasCombatThreat: () => threat },
    'GameServer/Bot/AI/TownGatekeeperCatalog': { targetForTown: () => ({ town: 'Test', npcSelfId: 1 }) },
    'GameServer/Bot/AI/TownNpcApproach': { reset() {}, planOpen: () => ({ ready: true }) },
    'GameServer/Bot/AI/CompanionNavigationRecovery': { clear() {} },
    'GameServer/Bot/AI/TownTransitPolicy': { townAt: () => bot.x === 0 ? 'Test' : null, observeRecovery() {}, interact: () => true },
    'GameServer/Bot/BotAI': { getClosestTown: () => ({ name: 'Test', x: 0, y: 0, z: 0 }) },
    'GameServer/Actor/Generics/TeleportTo': (s, b, loc) => { teleports.push(loc.locX); b.x = loc.locX; }
};
const mod = { exports: {} };
vm.runInNewContext(fs.readFileSync('src/GameServer/Bot/AI/BotSpotTravel.js', 'utf8'), {
    module: mod, invoke: key => { assert(key in mocks, key); return mocks[key]; },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); }, Date, Symbol
});
const travel = mod.exports;
const spot = { id: 'alliance-hunt', center: { locX: 30000, locY: 0, locZ: 0 } };
assert(travel.startViaEscape(session, bot, spot));
assert(casts);
assert.deepStrictEqual(teleports, [], 'SoE must finish before teleporting');
assert.strictEqual(timers[0].ms, 20000);
timers.shift().fn();
assert.deepStrictEqual(teleports, [0], 'SoE actually returns to town first');
assert(session.spotRelocation.arrivalPending);
timers.shift().fn();
assert(travel.startViaEscape(session, bot, spot));
assert.deepStrictEqual(teleports, [0, 30000], 'town gatekeeper completes the second leg');
timers.shift().fn();
const home = { id: 'alliance-leader', center: { locX: 10000, locY: 0, locZ: 0 } };
assert(travel.startViaEscape(session, bot, home));
timers.shift().fn();
timers.shift().fn();
assert(travel.startViaEscape(session, bot, home));
timers.shift().fn();
assert.deepStrictEqual(teleports, [0, 30000, 0, 10000], 'return also uses town before leader');
assert.strictEqual(session.currentSpot, originalSpot, 'quest transport must not overwrite a hunting profile');
assert.deepStrictEqual(session.initialSpawnCoord, { locX: 1, locY: 2, locZ: 3 });
assert.strictEqual(session.spotRelocation, undefined, 'quest arrival settles instead of repeatedly returning to the old gatekeeper');
assert(travel.startViaEscape(session, bot, spot));
threat = true;
timers.shift().fn();
assert.strictEqual(teleports.length, 4, 'combat interrupts SoE without teleport');
assert(!session.spotRelocation);
assert(!travel.startViaEscape(session, bot, spot), 'active combat prevents departure');
threat = false;
assert(travel.startViaEscape(session, bot, spot));
bot.x += 100;
timers.shift().fn();
assert.strictEqual(teleports.length, 4, 'moving during SoE prevents teleport');
console.log('Clan quest SoE: town, gatekeeper, return, combat and movement interruption passed');
