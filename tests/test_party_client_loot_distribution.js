const assert = require('assert');
require('../src/Global');

const Party = invoke('GameServer/Bot/AI/PartyCompanionService');
const World = invoke('GameServer/World/World');
const Manager = invoke('GameServer/Bot/BotManager');
const Journal = invoke('GameServer/Bot/AI/BotEventJournal');
const Panel = invoke('GameServer/World/Generics/NpcBypasses/CompanionControl');
const Talk = invoke('GameServer/World/Generics/NpcTalkResponse');
const Invite = invoke('GameServer/Network/Request/AskForTeamUp');

const restores = [];
function replace(object, key, value) {
    const old = object[key]; restores.push(() => { object[key] = old; }); object[key] = value;
}
async function run() {
    const packets = [], botPackets = [], arrivals = [], awarded = [];
    function actor(id) {
        return {
            fetchId: () => id, fetchName: () => `Member${id}`, fetchLevel: () => 40, fetchClassId: () => 0,
            fetchCp: () => 0, fetchMaxCp: () => 0,
            fetchHp: () => 100, fetchMaxHp: () => 100, fetchMp: () => 100, fetchMaxMp: () => 100,
            fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0, fetchHead: () => 0,
            fetchIsOnline: () => true, isDead: () => false, backpack: {},
            state: { fetchSeated: () => false, fetchCasts: () => false, fetchPickinUp: () => false, setPickinUp() {} },
            automation: {
                pickupGeneration: 0,
                abortAll() { this.pickupGeneration++; },
                schedulePickup(_session, _actor, _item, callback) { arrivals.push(callback); return true; }
            }
        };
    }
    const leader = { actor: actor(1), dataSendToMe: (packet) => packets.push(packet), dataSendToMeAndOthers() {} };
    const bot = { actor: actor(2), accountId: 'bot_client_loot', partyCompanion: true,
        followPlayerSession: leader, plan: 'following', dataSendToMe: (packet) => botPackets.push(packet), dataSendToMeAndOthers() {} };
    const sync = (value) => Talk(leader, { link: `native-party distribution ${value}` });
    function item(id, selfId = 1539, amount = 1) {
        return { model: { partyLootLeaderId: 1 }, fetchId: () => id, fetchSelfId: () => selfId,
            fetchAmount: () => amount, fetchLocX: () => 20, fetchLocY: () => 0, fetchLocZ: () => 0 };
    }
    const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
    let panelRefreshes = 0;
    replace(Manager, 'sessions', []);
    replace(Journal, 'record', async () => true);
    replace(Panel, 'render', () => { panelRefreshes++; });
    replace(World, 'user', { sessions: [leader, bot] });
    replace(World, 'fetchNpcsInRadius', () => []);
    replace(World, 'items', { spawns: [] });
    replace(World, 'fetchItem', async (id) => World.items.spawns.find((entry) => entry.fetchId() === id));
    replace(World, 'purchaseItem', (session, selfId, amount) => awarded.push({ session, selfId, amount }));

    assert.strictEqual(Party.distributionForLeader(leader), 1, 'unmodified clients retain the legacy default');
    sync('0');
    assert.strictEqual(Party.distributionForLeader(leader), 0, 'sync works before any UI capability or party exists');
    assert.strictEqual(packets.length, 0);
    for (const value of ['-1', '5', '1.5', '00', '0 extra', 'NaN', '']) {
        sync(value); assert.strictEqual(Party.distributionForLeader(leader), 0);
    }
    assert.strictEqual(Party.syncClientDistribution(null, 0), false);
    for (const value of [null, '0', NaN, 5, -1, 1.5]) assert.strictEqual(Party.syncClientDistribution(leader, value), false);

    Manager.sessions.push(bot);
    for (let mode = 1; mode <= 4; mode++) {
        packets.length = 0; sync(String(mode));
        const window = packets.find((packet) => packet[0] === 0x4e);
        assert(window, 'an existing party HUD receives the authoritative mode');
        assert.strictEqual(window.readInt32LE(5), mode);
        assert.strictEqual(panelRefreshes, 0, 'background sync never opens companion HTML');
        const count = packets.length; sync(String(mode));
        assert.strictEqual(packets.length, count, 'unchanged settings do not rebuild the HUD');
    }
    leader.nativePartyUiVersion = 3; leader.nativePartyUiOpen = true;
    sync('1'); assert.strictEqual(panelRefreshes, 1);
    Talk(leader, { link: 'native-party close' });
    sync('2'); assert.strictEqual(panelRefreshes, 1, 'sync remains active after closing the UI');

    let invitations = 0;
    replace(World, 'askForTeamUp', (session, invitedActor, data) => {
        assert.strictEqual(session, leader); assert.strictEqual(invitedActor, leader.actor);
        assert.strictEqual(data.name, 'Companion');
        assert.strictEqual(Party.distributionForLeader(leader), data.distribution, 'normal invite updates mode before World dispatch');
        invitations++;
    });
    function request(mode) {
        const name = Buffer.from('Companion\0', 'utf16le');
        const packet = Buffer.alloc(1 + name.length + 4); packet[0] = 0x29;
        name.copy(packet, 1); packet.writeInt32LE(mode, 1 + name.length); Invite(leader, packet);
    }
    for (let mode = 0; mode <= 4; mode++) request(mode);
    assert.strictEqual(invitations, 5);
    request(-1); request(5); assert.strictEqual(invitations, 5, 'invalid native modes cannot reach invitation handling');

    sync('1');
    const potion = item(100); World.items.spawns.push(potion);
    assert.strictEqual(Party.queueRandomGroundPickup(bot, potion), bot);
    await flush(); assert.strictEqual(arrivals.length, 1);
    const pickupGeneration = bot.actor.automation.pickupGeneration;
    sync('0');
    assert.deepStrictEqual(bot.partyGroundPickupQueue, [{ id: 100 }]);
    assert.strictEqual(bot.partyGroundPickupInProgress, true, 'distribution changes preserve the physical pickup approach');
    assert.strictEqual(bot.actor.automation.pickupGeneration, pickupGeneration);
    packets.length = 0;
    arrivals[0]();
    assert.strictEqual(awarded[0].session, bot, 'Finder gives an automatically collected potion to the bot picker');
    assert.strictEqual(World.items.spawns.length, 0);
    assert(botPackets.some((packet) => packet[0] === 0x64 && packet.readInt32LE(1) === 30));
    assert(!packets.some((packet) => packet[0] === 0x64), 'bot receipt must not falsely claim the player received the item');

    const finderPotion = item(110); World.items.spawns.push(finderPotion);
    assert.strictEqual(Party.queueRandomGroundPickup(bot, finderPotion), bot, 'Finder also permits new bot pickup assignments');
    await flush(); assert.strictEqual(arrivals.length, 2);
    arrivals[1](); assert.strictEqual(awarded.at(-1).session, bot);

    const playerPotion = item(120); World.items.spawns.push(playerPotion);
    packets.length = 0;
    assert.strictEqual(World.pickupItem(leader, leader.actor, playerPotion), true);
    assert.strictEqual(awarded.at(-1).session, leader, 'Finder gives a manually collected potion to the player picker');
    const receipt = packets.find((packet) => packet[0] === 0x64);
    assert(receipt, 'the player receives the real C4 pickup system message');
    assert.strictEqual(receipt.readInt32LE(1), 30);
    assert.strictEqual(receipt.readInt32LE(13), 1539);

    replace(Math, 'random', () => 0.99);
    for (const mode of [1, 2]) {
        sync(String(mode));
        const drop = item(100 + mode); World.items.spawns.push(drop);
        assert.strictEqual(World.pickupItem(leader, leader.actor, drop), true);
        assert.strictEqual(awarded.at(-1).session, bot, 'Random variants use the client-selected distribution');
    }
    for (const mode of [3, 4]) {
        sync(String(mode));
        const first = item(200 + mode), second = item(300 + mode); World.items.spawns.push(first, second);
        World.pickupItem(leader, leader.actor, first); World.pickupItem(leader, leader.actor, second);
        assert.deepStrictEqual(awarded.slice(-2).map((entry) => entry.session), [leader, bot]);
    }
    sync('0');
    const adena = item(400, 57, 10); World.items.spawns.push(adena);
    World.pickupItem(leader, leader.actor, adena);
    assert.deepStrictEqual(awarded.slice(-2).map((entry) => [entry.session.actor.fetchId(), entry.amount]), [[1, 5], [2, 5]],
        'Finder does not disable the separate C4 Adena split');

    // Simulate an invite waiting for a merchant to withdraw its store.
    const merchant = invoke('GameServer/Bot/Economy/BotMerchantStoreService');
    const availability = invoke('GameServer/Bot/AI/BotAvailability');
    const social = invoke('GameServer/Bot/AI/BotSocialMemory');
    const joining = { actor: actor(3) };
    let finishWithdrawal, attachedMode;
    replace(availability, 'evaluate', () => ({ available: true }));
    replace(social, 'recordEvent', async () => true);
    replace(merchant, 'needsPartyWithdrawal', () => true);
    replace(merchant, 'withdrawForParty', () => new Promise((resolve) => { finishWithdrawal = resolve; }));
    replace(global, 'setTimeout', () => 1);
    replace(Party, 'attach', (session, _target, options) => {
        attachedMode = options.distribution ?? Party.distributionForLeader(session);
        Party.releaseCapacity(session, joining);
        return true;
    });
    sync('1');
    const pending = World.inviteBotCompanion(leader, leader.actor, joining, 1);
    sync('0'); finishWithdrawal({ ok: true });
    assert.strictEqual(await pending, true);
    assert.strictEqual(attachedMode, 0, 'a delayed Random invite cannot overwrite the newer Finder setting');
    const legacy = { actor: actor(4), dataSendToMe() {} };
    const legacyInvite = World.inviteBotCompanion(legacy, legacy.actor, joining, 3);
    finishWithdrawal({ ok: true });
    assert.strictEqual(await legacyInvite, true);
    assert.strictEqual(attachedMode, 3, 'callers without a reported client setting still honor explicit invite modes');
    Party.releaseCapacity(legacy, joining);
}
run().then(() => {
    console.log('Client party loot: native sync/invite, closed UI, HUD, uninterrupted pickup, Finder bot/player awards and all five modes passed');
}).catch((error) => { console.error(error); process.exitCode = 1; })
    .finally(() => { restores.reverse().forEach((restore) => restore()); });
