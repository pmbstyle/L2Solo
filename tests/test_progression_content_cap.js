const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const ProgressionCap = invoke('GameServer/Progression/ProgressionCap');
const ExperienceReward = invoke('GameServer/Actor/Generics/ExperienceReward');
const CharacterWriteQueue = invoke('GameServer/Persistence/CharacterWriteQueue');
const ServerResponse = invoke('GameServer/Network/Response');
const NeedsEvaluator = invoke('GameServer/Bot/Goals/NeedsEvaluator');
const BotLifeState = invoke('GameServer/Bot/Population/BotLifeState');
const DeathExperience = invoke('GameServer/Progression/DeathExperience');
const QuestService = invoke('GameServer/Quest/QuestService');
const NpcDied = invoke('GameServer/Actor/Generics/NpcDied');

DataCache.init();

function config(maxLevel, contentCap) {
    const value = { General: { maxLevel } };
    if (contentCap !== undefined) value.Progression = { contentCap };
    return value;
}

function actorAt(level, exp, karma = 0) {
    let currentLevel = level;
    let currentExp = exp;
    let currentSp = 0;
    let currentKarma = karma;
    return {
        effects: {},
        fetchId: () => 101,
        fetchLevel: () => currentLevel,
        fetchExp: () => currentExp,
        fetchSp: () => currentSp,
        fetchKarma: () => currentKarma,
        fetchPvp: () => 0,
        fetchPk: () => 0,
        setExpSp: (nextExp, nextSp) => { currentExp = nextExp; currentSp = nextSp; },
        setLevel: (nextLevel) => { currentLevel = nextLevel; },
        setKarma: (value) => { currentKarma = value; },
        snapshot: () => ({ level: currentLevel, exp: currentExp, sp: currentSp, karma: currentKarma })
    };
}

async function run() {
    assert.strictEqual(ProgressionCap.maxLevel(), 78);
    assert.strictEqual(ProgressionCap.contentCap(), 78);
    assert.deepStrictEqual(ProgressionCap.validate(config(78)), { maxLevel: 78, contentCap: 78 });
    assert.strictEqual(ProgressionCap.levelForExperience(Number(DataCache.experience[78]) - 1), 78,
        'the upstream default must allow progression through level 78');
    assert.throws(() => ProgressionCap.validate(config(78, 79)), /cannot exceed/);
    assert.throws(() => ProgressionCap.validate(config(78, 0)), /greater than zero/);
    assert.throws(() => ProgressionCap.validate(config(79, 40)), /Chronicle 4/);

    for (const cap of [40, 60, 70, 78]) {
        const limits = config(78, cap);
        const maximum = Number(DataCache.experience[cap]) - 1;
        const award = ProgressionCap.applyAward(maximum - 5, 20, limits);
        assert.deepStrictEqual(award, { requested: 20, accepted: 5, discarded: 15, totalExp: maximum });
        assert.strictEqual(ProgressionCap.levelForExperience(maximum, 1, limits), cap);
    }
    assert.throws(() => ProgressionCap.validate(config(78, 79)), /cannot exceed/,
        'the absolute level 78 limit must prevent level 79');

    options.default.Progression = { contentCap: 40 };
    assert.strictEqual(ProgressionCap.contentCap(), 40, 'an explicit staged content cap must remain supported');
    const level40Maximum = ProgressionCap.maximumAllowedExperience();
    const originalResponse = { userInfo: ServerResponse.userInfo, consoleText: ServerResponse.consoleText };
    const originalExperienceWrite = CharacterWriteQueue.experience;
    let persisted = null;
    ServerResponse.userInfo = () => Buffer.alloc(0);
    ServerResponse.consoleText = () => Buffer.alloc(0);
    CharacterWriteQueue.experience = (id, level, exp, sp) => { persisted = { id, level, exp, sp }; };
    try {
        const actor = actorAt(40, level40Maximum, 1000);
        const session = { dataSendToMe() {}, dataSendToOthers() {} };
        const result = ExperienceReward(session, actor, 1000, 10);
        assert.deepStrictEqual(result, {
            requestedExp: 1000,
            grantedExp: 0,
            discardedExp: 1000,
            totalExp: level40Maximum,
            grantedSp: 10,
            totalSp: 10
        });
        assert.deepStrictEqual(actor.snapshot(), { level: 40, exp: level40Maximum, sp: 10, karma: 1000 });
        assert.deepStrictEqual(persisted, { id: 101, level: 40, exp: level40Maximum, sp: 10 });

        const questActor = actorAt(40, level40Maximum);
        QuestService.rewardExpSp({ ...session, actor: questActor }, 1000, 10);
        assert.strictEqual(questActor.snapshot().exp, level40Maximum, 'quest EXP must not bank above the content cap');

        const partyActor = actorAt(40, level40Maximum);
        const [partyShare] = NpcDied.partyRewardShares([{ actor: partyActor }], 1000, 10);
        ExperienceReward(session, partyActor, partyShare.exp, partyShare.sp);
        assert.strictEqual(partyActor.snapshot().exp, level40Maximum, 'party EXP must not bank above the content cap');
    } finally {
        ServerResponse.userInfo = originalResponse.userInfo;
        ServerResponse.consoleText = originalResponse.consoleText;
        CharacterWriteQueue.experience = originalExperienceWrite;
    }

    const cappedGoals = NeedsEvaluator.evaluate({
        level: 40,
        exp: level40Maximum,
        adena: 100000,
        activity: 'hunting',
        vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
        stats: { equipment: [] },
        inventory: {}
    }, { now: 1, spot: { id: 'test', risk: 0 } });
    assert(!cappedGoals.some((goal) => goal.type === 'progress_level'),
        'a capped bot must not request level 41');

    const coldState = {
        characterId: 102,
        name: 'ColdCap',
        level: 40,
        exp: level40Maximum,
        sp: 0,
        adena: 0,
        phase: 'cold',
        activity: 'hunting',
        spotId: 'test',
        loc: { locX: 0, locY: 0, locZ: 0 },
        vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
        timing: {},
        party: {},
        inventory: {},
        stats: { classId: 0, classProgressionLevel: 40, classProgressionClassId: 0, karma: 1000 }
    };
    const cold = await BotLifeState.prepareResolve(coldState, {
        materialize: { exp: 1000, sp: 10, adena: 0, items: [] },
        patch: {},
        debug: {},
        nextResolveAt: 60001
    }, { timestamp: 1, persist: false, projectClassProgression: true });
    assert.strictEqual(cold.exp, level40Maximum);
    assert.strictEqual(cold.level, 40);
    assert.strictEqual(cold.sp, 10);
    assert.strictEqual(cold.stats.karma, 1000, 'discarded cold EXP must not reduce karma');
    assert.strictEqual(cold.stats.expEarned, 0);

    const belowCap = ProgressionCap.applyAward(Number(DataCache.experience[39]),
        level40Maximum, config(78, 40));
    assert.strictEqual(belowCap.totalExp, level40Maximum);
    assert.strictEqual(ProgressionCap.levelForExperience(belowCap.totalExp), 40);

    const level40Threshold = Number(DataCache.experience[39]);
    const deathAtCap = actorAt(40, level40Threshold);
    const death = DeathExperience.applyDeathPenalty(null, deathAtCap, { timestamp: 1 });
    assert.strictEqual(deathAtCap.snapshot().level, 39, 'death must be able to cross below the content-cap level');
    const recovered = ProgressionCap.applyAward(deathAtCap.snapshot().exp, death.expLost);
    assert.strictEqual(ProgressionCap.levelForExperience(recovered.totalExp), 40,
        'normal progression must recover back to the cap after death');

    console.log('progression content cap ok');
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
