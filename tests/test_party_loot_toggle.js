const assert = require('assert');
require('../src/Global');

const Party = invoke('GameServer/Bot/AI/PartyCompanionService');
const World = invoke('GameServer/World/World');
const BotManager = invoke('GameServer/Bot/BotManager');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const Journal = invoke('GameServer/Bot/AI/BotEventJournal');
const Response = invoke('GameServer/Network/Response');
const NpcTalkResponse = invoke('GameServer/World/Generics/NpcTalkResponse');

async function main(distribution) {
    const restore = [];
    function replace(object, key, value) {
        const original = object[key];
        restore.push(() => { object[key] = original; });
        object[key] = value;
    }
    const arrivals = [], awarded = [], animations = [];
    function actor(id) {
        return {
            fetchId: () => id, fetchName: () => `Member${id}`, fetchLevel: () => 40,
            fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0,
            fetchHead: () => 0, fetchIsOnline: () => true, isDead: () => false,
            backpack: {},
            state: { fetchSeated: () => false, fetchCasts: () => false, fetchPickinUp: () => false, setPickinUp() {} },
            automation: {
                pickupGeneration: 0, aborts: 0,
                abortAll() { this.pickupGeneration++; this.aborts++; },
                schedulePickup(_session, _actor, _item, callback) { arrivals.push(callback); return true; }
            }
        };
    }
    const leader = { actor: actor(1), nativePartyUiVersion: 2, nativePartyUiOpen: true,
        partyCompanionSettings: { distribution },
        dataSendToMe() {}, dataSendToMeAndOthers() {} };
    const bot = { actor: actor(2), accountId: 'bot_loot_toggle', partyCompanion: true,
        followPlayerSession: leader, plan: 'following', dataSendToMe() {}, dataSendToMeAndOthers() {} };
    function item(id, selfId = 57) {
        return {
            model: { partyLootLeaderId: 1 }, fetchId: () => id,
            fetchSelfId: () => selfId, fetchAmount: () => 10,
            fetchLocX: () => 20, fetchLocY: () => 0, fetchLocZ: () => 0
        };
    }
    function command(value) { NpcTalkResponse(leader, { link: `native-party action loot ${value}` }); }
    const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
    try {
        replace(BotManager, 'sessions', [bot]);
        replace(BotManager, 'getBotStatus', () => ({ intent: 'idle' }));
        replace(BotRoles, 'presentation', () => ({ role: 'dps', className: 'Gladiator' }));
        replace(Journal, 'record', () => Promise.resolve());
        replace(World, 'user', { sessions: [leader, bot] });
        replace(World, 'fetchNpcsInRadius', () => []);
        replace(World, 'items', { spawns: [] });
        replace(World, 'fetchItem', async (id) => World.items.spawns.find((entry) => entry.fetchId() === id));
        replace(World, 'purchaseItem', (session, selfId, amount) => awarded.push({ session, selfId, amount }));
        replace(Response, 'pickupItem', () => { animations.push('pickup'); return Buffer.alloc(0); });

        assert.strictEqual(Party.getSettings(leader).lootPickupEnabled, true);
        const first = item(100);
        World.items.spawns.push(first);
        assert.strictEqual(Party.queueRandomGroundPickup(bot, first), bot);
        await flush();
        assert.strictEqual(arrivals.length, 1, 'enabled pickup starts the real executor');
        const aborts = bot.actor.automation.aborts;
        command('off');
        assert.strictEqual(Party.getSettings(leader).lootPickupEnabled, false);
        assert.strictEqual(Party.distributionForLeader(leader), distribution, 'Off must not change distribution');
        assert.strictEqual(bot.actor.automation.aborts, aborts + 1, 'Off stops pickup movement immediately');
        assert.deepStrictEqual(bot.partyGroundPickupQueue, []);
        assert.strictEqual(bot.partyGroundPickupInProgress, false);
        arrivals[0]();
        assert.strictEqual(animations.length, 0, 'a late arrival cannot broadcast pickup');
        assert.strictEqual(awarded.length, 0, 'a late arrival cannot award loot');
        assert(World.items.spawns.includes(first), 'cancelled loot stays on the ground');
        assert.strictEqual(World.pickupItem(bot, bot.actor, first), false, 'the final award boundary also rejects bot pickup');
        assert.strictEqual(Party.queueRandomGroundPickup(bot, first), null);
        assert.strictEqual(Party.reconcileGroundLoot(bot), 0);

        const newMember = { ...bot, actor: actor(3), partyGroundPickupQueue: [{ id: 100 }], partyGroundPickupInProgress: false };
        BotManager.sessions.push(newMember);
        assert.strictEqual(Party.startQueuedGroundPickup(newMember), false, 'new companions inherit Off');
        assert.deepStrictEqual(newMember.partyGroundPickupQueue, []);
        BotManager.sessions.pop();

        command('on');
        assert.strictEqual(Party.distributionForLeader(leader), distribution, 'On must not change distribution');
        assert.strictEqual(Party.reconcileGroundLoot(bot), 1, 'On recovers loot left on the ground');
        await flush();
        assert.strictEqual(arrivals.length, 2);
        arrivals[0]();
        assert.strictEqual(awarded.length, 0, 'an old callback remains invalid after re-enabling');
        arrivals[1]();
        assert.strictEqual(World.items.spawns.length, 0);
        assert.deepStrictEqual(awarded.map(({ session, amount }) => [session.actor.fetchId(), amount]), [[1, 5], [2, 5]],
            'enabled pickup retains normal C4 Adena distribution');

        // Toggle before the asynchronous item lookup resolves, then invoke it.
        const second = item(101, 1831);
        World.items.spawns.push(second);
        Party.queueRandomGroundPickup(bot, second);
        command('off');
        await flush();
        assert.strictEqual(arrivals.length, 2, 'Off also cancels pickup before scheduling its movement');
        const before = awarded.length;
        assert.strictEqual(World.pickupItem(leader, leader.actor, second), true, 'players can still pick up loot with bot pickup Off');
        assert.strictEqual(awarded.length, before + 1);

        const third = item(102);
        World.items.spawns.push(third);
        bot.actor.state.fetchCasts = () => true;
        bot.partyGroundPickupInProgress = true;
        bot.partyGroundPickupQueue = [{ id: 102 }];
        const supportAborts = bot.actor.automation.aborts;
        command('off');
        assert.strictEqual(bot.actor.automation.aborts, supportAborts, 'Off preserves a support cast that already owns automation');
        assert.deepStrictEqual(bot.partyGroundPickupQueue, []);
    } finally { restore.reverse().forEach((fn) => fn()); }
}
(async () => {
    for (let distribution = 0; distribution <= 4; distribution++) await main(distribution);
    console.log('Party loot toggle: all five distributions, real bypass, cancellation, stale callbacks, new members, re-enable and player pickup passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
