const assert = require('assert');
require('../src/Global');
const Chat = invoke('GameServer/Bot/AI/BotClanChat');
const GlobalChat = invoke('GameServer/Bot/Population/BotGlobalChat');
const Voice = invoke('GameServer/Bot/AI/BotChatVoice');
const ClanService = invoke('GameServer/Clan/ClanService');
const GoalService = invoke('GameServer/Bot/Goals/GoalService');
const GoalState = invoke('GameServer/Bot/Goals/GoalState');
const Needs = invoke('GameServer/Bot/Goals/NeedsEvaluator');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const World = invoke('GameServer/World/World');
const Response = invoke('GameServer/Network/Response');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Speak = invoke('GameServer/Network/Request/Speak');
const SendPacket = invoke('Packet/Send');
const saved = { user: World.user, find: ClanService.findById, speak: Response.speak,
    items: DataCache.items, now: Date.now, random: Math.random, execute: Database.execute,
    batch: Database.upsertBotGoalStates, evaluate: Needs.evaluate, cached: LifeState.cachedState,
    config: { ...Config }, warn: utils.infoWarn };
let now = 1000000;
let members = [101,102,103];
const delivered = [], leaked = [];
const source = { characterId: 101, name: 'Aria', level: 20, phase: 'cold', stats: { clanId: 999 } };
const goal = (type = 'upgrade_gear', itemId = 1) => ({ type, status: 'active', target: { itemId, itemName: `Item ${itemId}`, level: 21 },
    plan: {}, blockers: [], priority: 70, nextReviewAt: 1 });
function player(clanId, sink, accountId = 'player') {
    return { accountId, socket: { write() {} }, actor: { fetchClanId: () => clanId, fetchIsOnline: () => true }, dataSendToMe: packet => sink.push(packet) };
}
function reset() {
    Chat.reset(); GoalState.reset(); Voice.reset(); delivered.length = 0; leaked.length = 0;
    members = [101,102,103]; now += 1000000;
    Config.clanChatEnabled = true; Config.globalChatEnabled = false;
    World.user = { sessions: [player(11, delivered), player(12, leaked), player(0, leaked), player(11, leaked, 'bot_test')] };
}
async function main() {
    try {
        Date.now = () => now; Math.random = () => 0;
        utils.infoWarn = () => {};
        Response.speak = (actor, data) => ({ id: actor.fetchId(), name: actor.fetchName(), ...data });
        ClanService.findById = id => id === 11 ? { id: 11, members: members.map(id => ({ id })) } : { id, members: [] };
        DataCache.items = [{ selfId: 1, template: { name: 'Sword of Revolution' } }, { selfId: 2, template: { name: 'Iron Ore' } }];
        Database.execute = async () => [];
        Database.upsertBotGoalStates = async entries => entries.length;
        Needs.evaluate = () => [goal()];
        LifeState.cachedState = () => null;
        reset();
        await GoalService.review(source, { now });
        assert.strictEqual(delivered.length, 1, 'a committed new goal is announced');
        assert(delivered[0].text.includes('Sword of Revolution') && !delivered[0].text.includes('Item 1'));
        assert.strictEqual(delivered[0].kind, 4);
        assert.strictEqual(leaked.length, 0, 'only real players in the same clan receive the packet, irrespective of distance');
        now += 20000;
        await GoalService.review(source, { now });
        assert.strictEqual(delivered.length, 1, 'reviewing the same target does not announce it again');
        Needs.evaluate = () => [goal('upgrade_gear', 2)];
        await GoalService.review(source, { now });
        assert.strictEqual(delivered.length, 2, 'another target of the same goal type is a new goal');
        assert(delivered[1].text.includes('Iron Ore'));

        reset(); Needs.evaluate = () => [goal()];
        const batch = await GoalService.reviewBatch([source, { ...source, characterId: 102, name: 'Belen' }], { now });
        assert.strictEqual(batch.length, 2);
        assert.strictEqual(delivered.length, 1, 'batch updates respect the shared clan budget');
        assert.strictEqual(Chat.snapshot().pending, 1);
        now += 15000; Chat.flush(now);
        assert.strictEqual(delivered.length, 2, 'the second notification is delivered on an ordinary tick');
        assert.strictEqual(leaked.length, 0);

        reset(); Database.execute = async () => { throw new Error('write failed'); };
        assert.strictEqual(await GoalService.review(source, { now }), null);
        assert.strictEqual(delivered.length, 0, 'failed persistence must not produce a goal claim');
        Database.execute = async () => [];
        Database.upsertBotGoalStates = async () => { throw new Error('batch failed'); };
        await GoalService.reviewBatch([source], { now });
        assert.strictEqual(delivered.length, 0, 'failed batch persistence must stay silent');
        Database.upsertBotGoalStates = saved.batch;

        reset();
        const receipt = { ok: true, received: { id: 123, selfId: 1, enchant: 3 } };
        assert(!Chat.onWarehouse(source, { ok: false, received: receipt.received }, 11, now));
        assert(Chat.onWarehouse(source, receipt, 11, now));
        assert(delivered[0].text.includes('+3 Sword of Revolution'));
        assert(!/equipped/.test(delivered[0].text));
        assert(!Chat.onWarehouse(source, receipt, 11, now + 1), 'repeated completion must not repeat a receipt');
        const withdrawal = { ok: true, code: 'warehouse_withdraw_applied', selfId: 2, amount: 20, ledgerId: 1, clanId: 11 };
        assert(!Chat.onWithdrawal(source, { ...withdrawal, code: 'warehouse_withdraw_already_applied' }, now));
        assert(Chat.onWithdrawal(source, withdrawal, now));
        now += 15000; Chat.flush(now);
        assert(delivered[1].text.includes('20 Iron Ore'), 'material receipts use the committed quantity');
        assert(!Chat.onWarehouse(source, { ...receipt, received: { ...receipt.received, id: 124 } }, 12, now), 'wrong clan hint cannot expose warehouse details');

        reset();
        assert(!Chat.onDeath(source, 'first', now));
        assert(!Chat.onDeath(source, 'second', now + 1000));
        assert(!Chat.onDeath(source, 'second', now + 2000), 'repeated death polling counts once');
        assert(Chat.onDeath(source, 'third', now + 3000));
        assert(/party|leveling/.test(delivered[0].text));
        assert(!Chat.onDeath(source, 'fourth', now + 4000), 'repeated trouble requests have a cooldown');
        assert(!Chat.onDeath(source, 'later', now + Chat.DEATH_WINDOW_MS + 5000), 'old deaths expire');
        reset();
        const grouped = { ...source, party: { partyId: 'p1' } };
        for (let n = 0; n < 3; n++) Chat.onDeath(grouped, `death${n}`, now + n * 1000);
        assert(!/room in|take me along/.test(delivered[0].text), 'an existing group asks for help, not another invitation');

        reset();
        for (let n = 1; n <= 3; n++) {
            const state = { ...source, stats: { deaths: n } };
            GlobalChat.maybeAnnounce(state, [{ type: 'death' }], now + n * 1000);
        }
        assert.strictEqual(delivered.length, 1, 'clan death warnings work with global chat disabled');
        reset();
        let count = 0;
        LifeState.cachedState = id => id === 102 ? { ...source, characterId: 102, name: 'Belen', stats: { deaths: count } } : null;
        for (count = 1; count <= 3; count++) GlobalChat.maybeAnnounce(source, [{ type: 'death', characterId: 102 }], now + count * 1000);
        assert.strictEqual(delivered[0].id, 102, 'party deaths belong to the actual dead member, not the leader');
        LifeState.cachedState = () => null;

        reset();
        Chat.onWarehouse(source, receipt, 11, now);
        const queuedGoal = goal();
        GoalState.prime(102, JSON.stringify(queuedGoal), now);
        assert(Chat.onGoal({ ...source, characterId: 102 }, queuedGoal, null, now));
        GoalState.prime(102, JSON.stringify({ ...queuedGoal, status: 'completed' }), now);
        now += 15000; Chat.flush(now);
        assert.strictEqual(delivered.length, 1, 'a completed or replaced queued goal must not speak later');
        assert(Chat.onWarehouse({ ...source, characterId: 102 }, receipt, 11, now));
        Chat.onWarehouse({ ...source, characterId: 103 }, receipt, 11, now);
        members = [101,102]; now += 15000; Chat.flush(now);
        assert.strictEqual(delivered.length, 2, 'a bot that left the clan loses its queued message');
        const hot = { actor: { fetchId: () => 101, fetchName: () => 'Aria', fetchClanId: () => 0 } };
        assert(!Chat.onWarehouse(hot, receipt, 11, now), 'live membership overrides an old cached member list');

        reset();
        for (let n = 0; n < 100; n++) Chat.onWarehouse(source, { ...receipt, received: { ...receipt.received, id: n + 200 } }, 11, now);
        assert(Chat.snapshot().pending <= Chat.MAX_PENDING);
        now += Chat.QUEUE_TTL_MS; Chat.flush(now);
        assert.strictEqual(Chat.snapshot().pending, 0, 'stale bursts are discarded');
        Config.clanChatEnabled = false;
        assert(!Chat.onWarehouse(source, receipt, 11, now));
        Config.clanChatEnabled = true; World.user.sessions = [];
        assert(!Chat.onWarehouse(source, receipt, 11, now), 'no backlog for offline clan members');
        assert.strictEqual(leaked.length, 0);

        reset();
        Config.devLogPlayerChat = false;
        // Exercise the native packet ingress, not just the bot broadcaster.
        const sender = player(11, delivered);
        sender.actor.fetchId = () => 901;
        sender.actor.fetchName = () => 'Player';
        sender.dataSendToMeAndOthers = () => { throw new Error('Clan text reached local broadcast'); };
        const nearbyOutsider = player(12, leaked);
        const distantMember = player(11, delivered);
        World.user.sessions = [sender, nearbyOutsider, distantMember];
        Speak(sender, new SendPacket(0x38).writeS('Anyone need Iron Ore?').writeD(4).fetchBuffer());
        assert.strictEqual(delivered.length, 2, 'clan members receive player speech regardless of proximity');
        assert.strictEqual(leaked.length, 0);
        sender.actor.fetchClanId = () => 0;
        Speak(sender, new SendPacket(0x38).writeS('No clan').writeD(4).fetchBuffer());
        assert.strictEqual(delivered.length, 2, 'clanless speakers cannot broadcast to other clanless players');
        console.log('Bot clan chat checks passed: committed goals, death windows, warehouse receipts, clan isolation and bounded queues.');
    } finally {
        Object.assign(Config, saved.config); World.user = saved.user; ClanService.findById = saved.find;
        Response.speak = saved.speak; DataCache.items = saved.items; Date.now = saved.now; Math.random = saved.random;
        Database.execute = saved.execute; Database.upsertBotGoalStates = saved.batch; Needs.evaluate = saved.evaluate;
        LifeState.cachedState = saved.cached; utils.infoWarn = saved.warn; GoalState.reset(); Chat.reset(); Voice.reset();
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
