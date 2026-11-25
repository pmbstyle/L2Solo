const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const World = invoke('GameServer/World/World');
const RestingState = invoke('GameServer/Bot/AI/States/RestingState');

DataCache.init();

// E71: a resting hot bot that is attacked takes the same danger moment as a
// hunting one (E70) instead of fleeing while its HP is under 0.95.
function item(selfId, amount, objectId = selfId + 100000) {
    return { fetchSelfId: () => selfId, fetchAmount: () => amount, fetchId: () => objectId };
}

function build({ potions = 0, mobHp = 10, mobPAtk = 1, economy = true } = {}) {
    let seated = true;
    const used = [];
    const bot = {
        effects: {}, moves: [],
        fetchId: () => 2000020, fetchName: () => 'resting', fetchClassId: () => 0, fetchLevel: () => 10,
        fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0,
        fetchHp: () => 50, fetchMaxHp: () => 100, fetchMp: () => 50, fetchMaxMp: () => 50,
        fetchPAtk: () => 100, fetchPDef: () => 100, fetchAtkSpd: () => 300, fetchMAtk: () => 10, fetchCastSpd: () => 333,
        fetchKarma: () => 0, fetchIsOnline: () => true,
        state: {
            fetchDead: () => false, fetchCasts: () => false, fetchHits: () => false, fetchTowards: () => false,
            fetchSeated: () => seated, setSeated: (value) => { seated = value; },
            fetchAnimated: () => false, setAnimated() {}
        },
        canUseSkill: () => true,
        backpack: {
            fetchItems: () => (potions ? [item(1060, potions)] : []),
            buildItemSkill: () => ({ fetchSelfId: () => 2031 }),
            useItem: (_session, objectId) => used.push(objectId)
        },
        select(data) { this.selected = data.id; },
        unselect() { this.selected = undefined; },
        moveTo(coords) { this.moves.push(coords); }
    };
    const mob = {
        fetchId: () => 7001, fetchName: () => 'angry mob', fetchAttackable: () => true, isDead: () => false,
        fetchHp: () => mobHp, fetchMaxHp: () => mobHp,
        fetchLocX: () => 120, fetchLocY: () => 0, fetchLocZ: () => 0,
        matchupTarget: { maxHp: mobHp, pAtk: mobPAtk, pDef: 100, atkSpd: 300, vulnerabilities: {} }
    };
    const session = {
        accountId: 'bot_resting_moment', actor: bot, plan: 'resting', recoveryLocked: true,
        incomingThreatId: mob.fetchId(), incomingThreatAt: Date.now(), dataSendToOthers() {}, dataSendToMeAndOthers() {}
    };
    // The decision the body received (DecisionEvents.receive: decided);
    // without one the price of death is unknown.
    session.heldEconomy = economy ? { decided: true, deathHours: 0.5, riskWeight: 1.5, moneyPrice: 1 / 10000, network: { activity: null } }
        : { deathHours: NaN, network: { activity: null } };
    World.user = { sessions: [session] };
    World.npc = { spawns: [mob] };
    World.fetchNpcsInRadius = () => [];
    const fights = [];
    const BotAI = { say() {}, executeCombat: (_session, _bot, npc) => fights.push(npc.fetchId()) };
    RestingState.tick(session, bot, {}, BotAI);
    return { session, bot, fights, used, seated: () => seated };
}

// A bot that wins the race stands up and fights the attacker.
let run = build();
assert.strictEqual(run.session.plan, 'hunting', 'a resting bot that wins the race fights back');
assert.deepStrictEqual(run.fights, [7001], 'it takes the attacker as its target');
assert.strictEqual(run.seated(), false, 'it stands up to fight');
assert.strictEqual(run.session.currentTargetId, 7001);

// A bot losing the race with a potion in the bag drinks it.
run = build({ potions: 3, mobHp: 100, mobPAtk: 80 });
assert.strictEqual(run.used.length, 1, 'a resting bot losing the race drinks a cheap potion');
assert.notStrictEqual(run.session.plan, 'fleeing', 'it does not run while it drinks');

// Losing without a potion: it flees as before.
run = build({ mobHp: 100, mobPAtk: 80 });
assert.strictEqual(run.session.plan, 'fleeing', 'a resting bot losing the race with no potion flees');
assert.deepStrictEqual(run.fights, []);

// No held economy: the author rule (flee while recovery is locked) stays.
run = build({ economy: false });
assert.strictEqual(run.session.plan, 'fleeing', 'without a price of death the author rule decides');

console.log('Bot resting danger moment tests passed');
