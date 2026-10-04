const assert = require('assert');
require('../src/Global');
const Efficiency = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const Routes = invoke('GameServer/Bot/AI/LevelingRoutes');
const at = Date.now();
let state = { level:40,stats:{classId:9},inventory:{1:{selfId:1,equipped:true}} };
function sample(spotId,exp,combatMs,recoveryMs=0) {
    state={...state,stats:{...state.stats,huntEfficiency:Efficiency.record(state,{spotId,exp,combatMs,recoveryMs,timestamp:at})}};
}
for(let i=0;i<3;i++) {sample('sustainable',100,10000);sample('costly',200,10000,90000);}
const scores=Efficiency.scores(state,at);
assert(scores.get('sustainable')>scores.get('costly'),'useful XP includes recovery cost rather than raw kill rewards');
const spot=id=>({id,avgLevel:40,minLevel:39,maxLevel:41,density:1,tagsAuthoritative:true,tags:[],center:{locX:50000,locY:15000}});
assert(Routes.scoreSpot(spot('sustainable'),state,{timestamp:at}).score>Routes.scoreSpot(spot('costly'),state,{timestamp:at}).score);
assert.strictEqual(Routes.scoreSpot(spot('unknown'),state,{timestamp:at}).efficiencyAdjustment,0,'unknown hunts remain available');
assert.strictEqual(Efficiency.scores({...state,party:{partyId:'new'}},at).size,0,'party change invalidates solo results');
assert.strictEqual(Routes.scoreSpot(spot('sustainable'),state,{timestamp:at,mode:'party'}).efficiencyAdjustment,0,'explicit party planning does not reuse solo cycle samples');
assert.strictEqual(Efficiency.scores({...state,inventory:{2:{selfId:2,equipped:true}}},at).size,0,'new equipment invalidates old cycle costs');
assert.strictEqual(Efficiency.scores({...state,stats:{...state.stats,classId:24}},at).size,0,'profession change invalidates old results');
assert.strictEqual(Efficiency.scores(state,at+Efficiency.MAX_AGE_MS).size,0,'old samples expire');
for(let i=0;i<20;i++)sample(`spot-${i}`,10,1000);
assert.strictEqual(state.stats.huntEfficiency.length,Efficiency.MAX_SPOTS,'persisted memory stays bounded');
assert.deepStrictEqual(Efficiency.scores(JSON.parse(JSON.stringify(state)),at),Efficiency.scores(state,at));

// Hour value (N0b/G8): the bot's own best measured income, else its level band's median.
const Buff = invoke('GameServer/Bot/Economy/BuffServicePolicy');
const NpcSellRules = invoke('GameServer/Items/NpcSellRules');
invoke('GameServer/DataCache').init();
Efficiency.resetLevelBands();
assert.deepStrictEqual(Efficiency.hourValue({ level: 35, stats: {} }, at),
    { perHour: 875 * 36, perKill: 875, source: 'default' }, 'before any sample the planner estimate stands in');
const priceOf = (selfId) => invoke('GameServer/DataCache').items.find((item) => Number(item.selfId) === selfId).template.price;
assert.strictEqual(Efficiency.lootValue([{ selfId: 57, amount: 300 }, { selfId: 1864, amount: 4 }]),
    300 + 4 * NpcSellRules.npcBuyPrice(priceOf(1864)), 'loot: adena at face value, items at the NPC buy price');
function earner(characterId, level, hunts) {
    let bot = { characterId, level, stats: { classId: 9 }, inventory: { 1: { selfId: 1, equipped: true } } };
    for (let i = 0; i < 3; i++) for (const hunt of hunts) {
        bot = { ...bot, stats: { ...bot.stats, huntEfficiency: Efficiency.record(bot, { exp: 100, timestamp: at, ...hunt }) } };
    }
    return bot;
}
// 60 s cycles: 9,000 adena + 1,000 loot in 10 kills = 600,000 per hour, 1,000 per kill.
const rich = earner(1, 35, [{ spotId: 'rich', combatMs: 50000, recoveryMs: 10000, adena: 9000, loot: 1000, kills: 10 },
    { spotId: 'poor', combatMs: 60000, adena: 1000, loot: 0, kills: 10 }]);
const row = rich.stats.huntEfficiency.find((entry) => entry.spotId === 'rich');
assert.deepStrictEqual([row.adena, row.loot, row.kills], [9000, 1000, 10], 'record keeps adena, loot value and kills');
assert.deepStrictEqual(Efficiency.hourValue(rich, at), { perHour: 600000, perKill: 1000, source: 'own' },
    'the best of the bot\'s rows, per hour of the hunt cycle and per kill');
assert.strictEqual(Efficiency.hourValue(rich, at, 'party').source, 'level_band', 'solo samples do not value a party hour');
earner(2, 32, [{ spotId: 'a', combatMs: 60000, adena: 1000, loot: 0, kills: 5 }]);
earner(3, 39, [{ spotId: 'a', combatMs: 60000, adena: 3000, loot: 0, kills: 5 }]);
// Band 30-39 holds 600,000, 60,000 and 180,000 per hour: the median is 180,000 (600 per kill).
assert.deepStrictEqual(Efficiency.hourValue({ level: 30, stats: {} }, at),
    { perHour: 180000, perKill: 600, source: 'level_band' }, 'an unsampled bot takes its level band\'s median');
assert.deepStrictEqual(Efficiency.hourValue({ level: 58, stats: {} }, at),
    { perHour: 180000, perKill: 600, source: 'level_band' }, 'an empty band borrows the nearest measured one');
assert.strictEqual(Efficiency.hourValue({ level: 30, stats: {} }, at + Efficiency.MAX_AGE_MS).source, 'default',
    'old band samples expire');
Efficiency.resetLevelBands();
Efficiency.observe(rich, at);
assert.strictEqual(Efficiency.hourValue({ level: 31, stats: {} }, at).perHour, 600000,
    'a cold commit applied on the main thread feeds its band');
const legacy = { ...rich, stats: { ...rich.stats, huntEfficiency: rich.stats.huntEfficiency
    .map((entry) => ({ ...entry, adena: undefined, loot: undefined, kills: undefined })) } };
assert.strictEqual(Efficiency.hourValue(legacy, at).source, 'level_band', 'rows saved before income was recorded value no hour');
assert(Efficiency.scores(legacy, at).get('rich') !== undefined, 'and still rank spots by exp');
assert.strictEqual(Buff.incomeForTenMinutes(rich), 100000, 'ten minutes of the buff service are a sixth of the hour value');
process.env.L2NODE_PROGRESSION_RATE = 'x50';
assert.strictEqual(Efficiency.hourValue({ level: 31, stats: {} }, at).perHour, 600000,
    'the measured value is not scaled by the rate again');
console.log('Recovery-aware hunt ranking, build/mode invalidation, exploration, bounded persistence and hour value passed');
