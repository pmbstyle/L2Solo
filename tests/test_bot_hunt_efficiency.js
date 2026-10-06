const assert = require('assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-efficiency-'));
const priorConfig = process.env.L2NODE_CONFIG_FILE;
const priorShared = process.env.L2NODE_SHARED_CONFIG_FILE;
const config = path.join(dir, 'config.ini');
fs.writeFileSync(config, fs.readFileSync(path.join(__dirname, '../config/default.ini'), 'utf8')
    + `\n[Database]\npath=${path.join(dir, 'world.sqlite')}\nhistoryPath=${path.join(dir, 'history.sqlite')}\n`);
process.env.L2NODE_CONFIG_FILE = config;
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.on('exit', () => {
    if (priorConfig === undefined) delete process.env.L2NODE_CONFIG_FILE; else process.env.L2NODE_CONFIG_FILE = priorConfig;
    if (priorShared === undefined) delete process.env.L2NODE_SHARED_CONFIG_FILE; else process.env.L2NODE_SHARED_CONFIG_FILE = priorShared;
    fs.rmSync(dir, { recursive: true, force: true });
});
require('../src/Global');
invoke('GameServer/DataCache').init();
const Efficiency = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const Routes = invoke('GameServer/Bot/AI/LevelingRoutes');
const at = Date.now();
let state = { level:40,stats:{classId:9},inventory:{1:{selfId:1,equipped:true}} };
function sample(spotId,exp,combatMs,recoveryMs=0) {
    state={...state,stats:{...state.stats,huntEfficiency:Efficiency.record(state,{spotId,exp,cycleMs:combatMs+recoveryMs,timestamp:at})}};
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

// Base hunt income uses only this bot's own records or the shared native table.
// The value of an hour belongs to the complete wish network.
const Buff = invoke('GameServer/Bot/Economy/BuffServicePolicy');
const NpcSellRules = invoke('GameServer/Items/NpcSellRules');
Efficiency.resetLevelBands();
const unsampled = { characterId: 55, level: 35, stats: { classId: 9 } };
const tableIncome = Efficiency.huntIncome(unsampled, at);
assert.strictEqual(tableIncome.source, 'table');
assert(tableIncome.perHour > 0 && tableIncome.expPerHour > 0, 'native table supplies actual money and progress routes');
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
// 60 s cycles: 9,000 adena + 1,000 loot in 10 kills = 600,000 per hour, 1,000 per kill, 100 exp = 6,000 exp per hour.
// The poor spot gives more exp (18,000 per hour) but less income.
const rich = earner(1, 35, [{ spotId: 'rich', cycleMs: 60000, adena: 9000, loot: 1000, kills: 10 },
    { spotId: 'poor', cycleMs: 60000, adena: 1000, loot: 0, kills: 10, exp: 300 }]);
const row = rich.stats.huntEfficiency.find((entry) => entry.spotId === 'rich');
assert.deepStrictEqual([row.adena, row.loot, row.kills], [9000, 1000, 10], 'record keeps adena, loot value and kills');
assert.deepStrictEqual(Efficiency.huntIncome(rich, at), { perHour: 600000, perKill: 1000, expPerHour: 6000, source: 'own' },
    'the best of the bot\'s rows, per hour of the hunt cycle and per kill, with the exp per hour of that same row');
assert.strictEqual(Efficiency.huntIncome(rich, at, 'party').source, 'table', 'solo samples do not value a party hunt');
earner(2, 32, [{ spotId: 'a', cycleMs: 60000, adena: 1000, loot: 0, kills: 5 }]);
earner(3, 39, [{ spotId: 'a', cycleMs: 60000, adena: 3000, loot: 0, kills: 5, exp: 400 }]);
Efficiency.observe(rich, at);
assert.deepStrictEqual(Efficiency.huntIncome(unsampled, at), tableIncome, 'other bots never donate private sample facts');
assert.strictEqual(Efficiency.huntIncome(rich, at + Efficiency.MAX_AGE_MS).source, 'table', 'expired own samples return to the native table');
const legacy = { ...rich, stats: { ...rich.stats, huntEfficiency: rich.stats.huntEfficiency
    .map((entry) => ({ ...entry, adena: undefined, loot: undefined, kills: undefined })) } };
assert.strictEqual(Efficiency.huntIncome(legacy, at).source, 'table', 'rows saved before income was recorded value no hour');
assert(Efficiency.scores(legacy, at).get('rich') !== undefined, 'and still rank spots by exp');
const commonHour = invoke('GameServer/Bot/Economy/EconomyContext').forState(rich).hourAdena;
assert.strictEqual(Buff.incomeForTenMinutes(rich), Math.round(commonHour / 6), 'the service uses the same wish hour');
process.env.L2NODE_PROGRESSION_RATE = 'x50';
assert.strictEqual(Efficiency.bestIncome(rich.stats.huntEfficiency).perHour, 600000,
    'stored measured amounts are never multiplied by the new rate');
console.log('Recovery-aware hunt ranking, build/mode invalidation, exploration, bounded persistence and hour value passed');
