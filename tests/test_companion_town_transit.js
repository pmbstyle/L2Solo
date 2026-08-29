const assert = require('assert');

require('../src/Global');

const CompanionTownTransit = invoke('GameServer/Bot/AI/CompanionTownTransit');
const DataCache = invoke('GameServer/DataCache');
const TownNpcApproach = invoke('GameServer/Bot/AI/TownNpcApproach');

DataCache.init();

function actorAt(loc) {
    return {
        loc: { ...loc },
        moves: [],
        state: {
            fetchTowards: () => false,
            inMotion: () => false
        },
        fetchLocX() { return this.loc.locX; },
        fetchLocY() { return this.loc.locY; },
        fetchLocZ() { return this.loc.locZ; },
        fetchId() { return 91001; },
        isDead() { return false; },
        moveTo(command) { this.moves.push(command); }
    };
}

const bot = actorAt({ locX: -83000, locY: 244000, locZ: -3729 });
const leader = actorAt({ locX: 83396, locY: 147904, locZ: -3404 });
const session = {};
const teleports = [];
const options = {
    worldSpawns: [],
    teleportTo(_session, actor, destination) {
        teleports.push({ ...destination });
        actor.loc = { ...destination };
    }
};

let result = CompanionTownTransit.tick(session, bot, leader, options);
assert.strictEqual(result.handled, true, 'different-town following must be owned by gatekeeper transit');
assert.strictEqual(session.companionTownTransit?.sourceTown, 'Talking Island');
assert.strictEqual(session.companionTownTransit?.targetTown, 'Giran');
assert.strictEqual(teleports.length, 0, 'a remote companion must not teleport before reaching its gatekeeper');
assert.strictEqual(bot.moves.length, 1, 'gatekeeper transit must begin with ordinary town movement');

const approach = TownNpcApproach.pointsFor(session.companionTownTransit.gatekeeper);
bot.loc = { ...approach.staging };
result = CompanionTownTransit.tick(session, bot, leader, options);
assert.strictEqual(result.handled, true);
assert.strictEqual(teleports.length, 0, 'the street-side staging point is not the teleport trigger');

bot.loc = { ...approach.interaction };
result = CompanionTownTransit.tick(session, bot, leader, options);
assert.strictEqual(result.status, 'teleported');
assert.deepStrictEqual(teleports[0], { locX: 83396, locY: 147904, locZ: -3400 },
    'the source gatekeeper must deliver the bot to the target town center');
assert.strictEqual(session.companionTownTransit, undefined, 'completed transit must release normal following');
assert.strictEqual(CompanionTownTransit.sameTown(bot, leader, options), true,
    'companions in the same destination town must continue on foot');

console.log('Companion inter-town gatekeeper transit checks passed');
