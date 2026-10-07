'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wish-store-release-'));
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.env.L2NODE_CONFIG_FILE = path.join(directory, 'default.ini');
fs.writeFileSync(process.env.L2NODE_CONFIG_FILE, `[Database]\npath=${directory}/world.sqlite\nhistoryPath=${directory}/history.sqlite\n`);
require('../src/Global');
invoke('GameServer/DataCache').init();
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const Cache = require('../src/GameServer/Bot/Population/LifeStateCache');
const publicationCache = new Cache();
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const originalSubscribe = Life.subscribePublications;
Life.subscribePublications = (...args) => publicationCache.subscribePublications(...args);
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const coordinator = new ColdSimulationCoordinator();
Life.subscribePublications = originalSubscribe;
const deps = { board: new BoardIndex(), spots: invoke('GameServer/Bot/Population/SpotProfiles').ensure(), timestamp: 1e12 };
const state = id => ({ characterId: id, updatedAt: 10, level: 20 + id, phase: 'cold', activity: 'hunting', adena: 100,
    stats: { classId: 1 }, inventory: { 1: { selfId: 1, amount: 1, equipped: true, slot: 7 } },
    currentRegion: 'Giran', timing: {}, loc: { locX: 80000, locY: 148000, locZ: -3500 },
    vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 } });
async function run() {
    const kernel = new ColdSimulationKernel({ resolveSolo: () => null });
    Economy.reset();
    for (const id of [1, 2, 3]) { const bot = state(id); kernel.upsert({ state: bot }); Economy.forState(bot, deps); }
    assert.equal(Economy.size().context, 3); assert.equal(Economy.size().engine, 3);
    const before = Profile.size().ownerBuilds;
    kernel.remove(1);
    assert.equal(Economy.size().context, 2); assert.equal(Economy.size().engine, 2);
    assert.equal(Profile.size().ownerBuilds, before - 1);
    kernel.fence(2);
    assert.equal(Economy.size().context, 1); assert.equal(Economy.size().engine, 1);
    assert.equal(Profile.size().ownerBuilds, before - 2);
    for (const id of [4, 5]) {
        const bot = state(id); publicationCache.set(id, bot); Economy.forState(bot, deps);
        coordinator.economyDecisions.accept(id, { updatedAt: 10, activity: null });
    }
    assert.equal(coordinator.economyDecisions.size(), 2);
    await coordinator.fenceBot(4);
    assert.equal(coordinator.economyDecisions.size(), 1);
    assert.equal(Economy.size().context, 2);
    publicationCache.delete(5);
    assert.equal(coordinator.economyDecisions.size(), 0);
    assert.equal(Economy.size().context, 1);
    assert.equal(Profile.size().ownerBuilds, before - 2);
    coordinator.unsubscribeWishRemovals();
    kernel.remove(3);
    console.log('test_wish_store_release: ok');
}
run().then(() => { fs.rmSync(directory, { recursive: true, force: true }); process.exit(0); })
    .catch(error => { console.error(error); process.exit(1); });
