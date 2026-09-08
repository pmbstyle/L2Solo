const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
require('../src/Global');

const shortcutInit = invoke('GameServer/Network/Response/ShortcutInit');
const source = fs.readFileSync(require.resolve('../src/GameServer/Network/Request/EnterWorld'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

async function checkLogin(skillsFirst) {
    let finishSkills;
    let finishShortcuts;
    let loaded = false;
    const packets = [];
    const skillsReady = new Promise(resolve => { finishSkills = () => { loaded = true; resolve(); }; });
    const rowsReady = new Promise(resolve => { finishShortcuts = () => resolve([{ kind: 2, slot: 13, id: 92, unknown: 1 }]); });
    const actor = {
        fetchId: () => 42,
        backpack: { fetchItems: () => [] },
        skillset: { fetchSkill: () => loaded ? { fetchLevel: () => 40 } : undefined },
        enterWorld: () => skillsReady
    };
    const response = new Proxy({
        shortcutInit,
        macroList: () => [],
        abnormalStatusUpdate: { fromActor: () => null },
        shortBuffStatusUpdate: { fromActor: () => null }
    }, { get: (target, key) => target[key] || (() => null) });
    const dependencies = {
        'GameServer/Network/Response': response,
        Database: { fetchMacros: async () => [], fetchShortcuts: () => rowsReady },
        'GameServer/Inventory/ShotStock': { ensureActorStock: async () => {} },
        'GameServer/Clan/ClanService': { clanForActor: () => null },
        'GameServer/World/GameTime': { isNight: () => false },
        'GameServer/AfkTrade/AfkTradeService': { deliverNotifications: async () => {} }
    };
    const context = { module: { exports: {} }, invoke: key => {
        assert.ok(dependencies[key], key);
        return dependencies[key];
    }, utils: { infoWarn: (...args) => { throw new Error(args.join(' ')); } } };
    vm.runInNewContext(source, context);
    context.module.exports({ actor, dataSendToMe: packet => { if (packet) packets.push(packet); }, dataSendToOthers: () => {} });
    await tick();
    (skillsFirst ? finishSkills : finishShortcuts)();
    await tick();
    assert.equal(packets.length, 0, 'login must await both shortcuts and the skillbook');
    (skillsFirst ? finishShortcuts : finishSkills)();
    await tick();
    assert.equal(packets.length, 1);
    assert.equal(packets[0][0], 0x45);
    assert.equal(packets[0].readInt32LE(17), 40, 'saved shortcut must use loaded level without re-registering');
}

(async () => {
    await checkLogin(false);
    await checkLogin(true);
    console.log('Shortcut login ordering tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
