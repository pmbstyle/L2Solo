const assert = require('assert');

require('../src/Global');

const World = invoke('GameServer/World/World');
const BotManager = invoke('GameServer/Bot/BotManager');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');

function actor(id, x, level = 10) {
    return {
        fetchId: () => id,
        fetchLocX: () => x,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchLevel: () => level,
        fetchIsOnline: () => true
    };
}

function session(accountId, value, options = {}) {
    return {
        accountId,
        actor: value,
        plan: options.plan || 'hunting',
        populationHotAt: options.populationHotAt
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
    const youngFarBot = session('bot_young_far', actor(5, 15000), { populationHotAt: Date.now() - 1000 });

    Config.activationRadius = 9000;
    Config.activationLevelRange = 5;
    Config.nearPlayerHotTarget = 3;
    Config.maxActivationsPerScan = 6;
    Config.cooldownGraceMs = 120000;
    Config.cooldownRadius = 11000;
    Config.cooldownBatchSize = 20;
    World.user = { sessions: [playerSession, nearBotA, nearBotB, farBot, youngFarBot] };
    BotManager.sessions = [nearBotA, nearBotB, farBot, youngFarBot];

    const coldStates = [
        { characterId: 101, name: 'ColdA', level: 10 },
        { characterId: 102, name: 'ColdB', level: 10 },
        { characterId: 103, name: 'ColdC', level: 10 }
    ];
    let coldLimit = null;
    LifeState.coldNear = (_loc, _radius, limit) => {
        coldLimit = limit;
        return Promise.resolve(coldStates.slice(0, limit));
    };
    const activated = [];
    PopulationService.requestActivation = (state) => {
        activated.push(state.name);
        return Promise.resolve({ ok: true, state });
    };

    await PopulationService.activateNearPlayers();
    assert.strictEqual(coldLimit, 1, 'activation should request only the local density deficit');
    assert.deepStrictEqual(activated, ['ColdA'], 'activation should stop once the near-player hot target is filled');

    const cooled = [];
    PopulationService.cooldownSession = (botSession) => {
        cooled.push(botSession.accountId);
        return Promise.resolve({ ok: true });
    };
    await PopulationService.cooldownEligibleHot();
    assert.deepStrictEqual(cooled, ['bot_far'], 'cooldown should keep near-player and newly activated hot bots resident');
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
