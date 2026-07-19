const assert = require('assert');

require('../src/Global');

const World = invoke('GameServer/World/World');
const BotManager = invoke('GameServer/Bot/BotManager');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');

function actor(id, x, level = 10, karma = 0) {
    return {
        fetchId: () => id,
        fetchLocX: () => x,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchLevel: () => level,
        fetchKarma: () => karma,
        fetchIsOnline: () => true
    };
}

function session(accountId, value, options = {}) {
    return {
        accountId,
        actor: value,
        plan: options.plan || 'hunting',
        populationHotAt: options.populationHotAt,
        coldMarketState: options.coldMarketState,
        coldCraftState: options.coldCraftState
    };
}

const originalUsers = World.user;
const originalSessions = BotManager.sessions;
const originalColdNear = LifeState.coldNear;
const originalRequestActivation = PopulationService.requestActivation;
const originalCooldownSession = PopulationService.cooldownSession;
const originalConfig = {
    activationRadius: Config.activationRadius,
    activationLevelRange: Config.activationLevelRange,
    nearPlayerHotTarget: Config.nearPlayerHotTarget,
    maxActivationsPerScan: Config.maxActivationsPerScan,
    cooldownGraceMs: Config.cooldownGraceMs,
    cooldownRadius: Config.cooldownRadius,
    cooldownBatchSize: Config.cooldownBatchSize
};

async function run() {
    const playerSession = session('player_policy', actor(1, 0));
    const nearBotA = session('bot_near_a', actor(2, 1000), { populationHotAt: Date.now() - 300000 });
    const nearBotB = session('bot_near_b', actor(3, 2000), { populationHotAt: Date.now() - 300000 });
    const farBot = session('bot_far', actor(4, 14000), { populationHotAt: Date.now() - 300000 });
    const farCraftBot = session('bot_far_craft', actor(7, 17000), {
        plan: 'merchant',
        coldCraftState: { stats: { craftShop: {} } },
        populationHotAt: Date.now() - 300000
    });
    const farPk = session('bot_far_pk', actor(6, 16000, 10, 720), { plan: 'pk_hunting', populationHotAt: Date.now() - 300000 });
    const youngFarBot = session('bot_young_far', actor(5, 15000), { populationHotAt: Date.now() - 1000 });

    Config.activationRadius = 9000;
    Config.activationLevelRange = 5;
    Config.nearPlayerHotTarget = 3;
    Config.maxActivationsPerScan = 1;
    Config.cooldownGraceMs = 120000;
    Config.cooldownRadius = 11000;
    Config.cooldownBatchSize = 20;
    World.user = { sessions: [playerSession, nearBotA, nearBotB, farBot, youngFarBot] };
    BotManager.sessions = [nearBotA, nearBotB, farBot, farCraftBot, farPk, youngFarBot];

    const coldStates = [
        { characterId: 100, name: 'ColdPk', level: 10, activity: 'pk_hunting' },
        { characterId: 101, name: 'ColdA', level: 10 },
        { characterId: 105, name: 'ServiceCrafter', level: 20, activity: 'crafting', stats: { craftShop: {} } },
        { characterId: 106, name: 'ServiceCrafterTwo', level: 20, activity: 'crafting', stats: { craftShop: {} } },
        { characterId: 107, name: 'ServiceCrafterThree', level: 20, activity: 'crafting', stats: { craftShop: {} } },
        { characterId: 102, name: 'ColdB', level: 10 },
        { characterId: 103, name: 'ColdC', level: 10 },
        { characterId: 104, name: 'Traveler', level: 10, activity: 'traveling' }
    ];
    let coldLimit = null;
    LifeState.coldNear = (_loc, _radius, limit) => {
        coldLimit = limit;
        return Promise.resolve(coldStates);
    };
    const activated = [];
    PopulationService.requestActivation = (state) => {
        activated.push(state.name);
        return Promise.resolve({ ok: true, state });
    };

    await PopulationService.activateNearPlayers();
    assert.strictEqual(coldLimit, 100, 'activation must inspect the complete local service row');
    assert.deepStrictEqual(activated, ['ServiceCrafter', 'ServiceCrafterTwo', 'ServiceCrafterThree'], 'craft services must not be capped by the ambient bot activation budget');

    const cooled = [];
    PopulationService.cooldownSession = (botSession) => {
        cooled.push(botSession.accountId);
        return Promise.resolve({ ok: true });
    };
    await PopulationService.cooldownEligibleHot();
    assert.deepStrictEqual(cooled, ['bot_far_craft', 'bot_far'], 'cooldown should park distant craft services along with normal cold-backed bots');
}

run()
    .then(() => console.log('Bot population policy checks passed'))
    .catch((err) => {
        console.error(err);
        process.exitCode = 1;
    })
    .finally(() => {
        World.user = originalUsers;
        BotManager.sessions = originalSessions;
        LifeState.coldNear = originalColdNear;
        PopulationService.requestActivation = originalRequestActivation;
        PopulationService.cooldownSession = originalCooldownSession;
        Object.assign(Config, originalConfig);
    });
