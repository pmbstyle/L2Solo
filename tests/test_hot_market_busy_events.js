const assert = require('assert');
require('../src/Global');

const World = invoke('GameServer/World/World');
const Trade = invoke('GameServer/Bot/BotTradeService');
const Teleport = invoke('GameServer/Actor/Generics/TeleportTo');
const Competition = invoke('GameServer/Bot/AI/HotCompetitionParty');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Population = invoke('GameServer/Bot/Population/PopulationService');
const Database = invoke('Database');

function session(id) {
    const value = { accountId: `bot_busy_${id}`, botSession: true,
        fetchAccountId() { return this.accountId; }, dataSendToMeAndOthers() {} };
    const actor = { fetchId: () => id, fetchName: () => `Busy${id}`, fetchLevel: () => 20,
        fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0, fetchIsOnline: () => true,
        isDead: () => false, clearDestId() {}, automation: { abortAll() {} },
        backpack: { fetchItems: () => [] } };
    value.actor = actor;
    World.insertUser(value);
    return value;
}

async function main() {
    const restore = [];
    const replace = (target, key, value) => {
        const previous = target[key];
        restore.push(() => { target[key] = previous; });
        target[key] = value;
    };
    replace(World, 'user', { sessions: [], revision: 0 });
    const signals = [];
    const signalErrors = [];
    const unsubscribe = World.subscribeUserChanges(id => signals.push(id));
    let checkSignal = () => {};
    const unsubscribeOrdering = World.subscribeUserChanges(id => {
        try { checkSignal(id); } catch (error) { signalErrors.push(error); }
    });
    try {
        const bot = session(301);
        signals.length = 0;
        const registered = World.registeredActorById(301);
        const spatial = World.realPlayerSessionsNear({ locX: 0, locY: 0, locZ: 0 }, 10);
        assert.strictEqual(World.notifyUserStateChanged(bot), true);
        assert.deepStrictEqual(signals, [301]);
        assert.strictEqual(World.registeredActorById(301), registered, 'notification preserves registration token');
        assert.deepStrictEqual(World.realPlayerSessionsNear({ locX: 0, locY: 0, locZ: 0 }, 10), spatial);
        const retiredActor = bot.actor;
        World.retireUserActor(bot, retiredActor);
        signals.length = 0;
        assert.strictEqual(World.notifyUserStateChanged(bot, retiredActor), false);
        assert.deepStrictEqual(signals, []);
        World.insertUser(bot);
        const replacement = session(301);
        signals.length = 0;
        assert.strictEqual(World.notifyUserStateChanged(bot), false, 'displaced session cannot wake its replacement');
        assert.strictEqual(World.notifyUserStateChanged(replacement), true);
        assert.deepStrictEqual(signals, [301]);
        console.log('Exact current registration notification and terminal/replacement controls PASS');

        const player = { accountId: 'player_busy', dataSendToMe() {}, actor: {
            fetchId: () => 302, fetchName: () => 'BusyPlayer', fetchLocX: () => 0, fetchLocY: () => 0,
            fetchLocZ: () => 0, fetchIsOnline: () => true, isDead: () => false,
            backpack: { fetchItems: () => [] } } };
        replacement.partyCompanion = true;
        replacement.followPlayerSession = player;
        assert.strictEqual(Trade.startBotTrade(replacement, player).ok, true);
        const trade = replacement.activeTrade;
        replacement.botTradeReservations = new Map([[9001, { tradeId: trade.id, count: 1 }]]);
        signals.length = 0;
        checkSignal = id => {
            if (id !== 301) return;
            assert.strictEqual(replacement.activeTrade, null);
            assert.strictEqual(replacement.botTradeReservations.size, 0, 'reservations release before wake');
        };
        assert.strictEqual(Trade.cleanup(replacement, 'busy_event_test'), true);
        assert.deepStrictEqual(signals, [301], 'actual trade cleanup emits one bot signal');
        signals.length = 0;
        assert.strictEqual(Trade.cleanup(replacement, 'duplicate_cleanup'), false);
        assert.deepStrictEqual(signals, []);
        checkSignal = () => {};
        console.log('Native attached trade cleanup post-reservation ordering PASS');

        const timers = [];
        replace(global, 'setTimeout', callback => { timers.push(callback); return {}; });
        const originalInvoke = global.invoke;
        replace(global, 'invoke', name => name === path.actor ? { updatePosition() {} }
            : name === 'GameServer/Pets/PetTravel' ? { begin: () => [], finish() {} }
                : originalInvoke(name));
        const destination = { locX: 100, locY: 100, locZ: 0 };
        signals.length = 0;
        assert.strictEqual(Teleport(replacement, replacement.actor, destination), true);
        assert(replacement.pendingActorTeleport);
        checkSignal = id => { if (id === 301) assert(!replacement.pendingActorTeleport); };
        timers.shift()();
        assert.deepStrictEqual(signals, [301], 'matching teleport completion wakes after busy guard clears');
        signals.length = 0;
        Teleport(replacement, replacement.actor, destination);
        Teleport(replacement, replacement.actor, destination);
        timers.shift()();
        assert(replacement.pendingActorTeleport, 'old timer cannot clear a newer teleport');
        assert.deepStrictEqual(signals, []);
        timers.shift()();
        assert.deepStrictEqual(signals, [301]);
        signals.length = 0;
        const oldActor = replacement.actor;
        Teleport(replacement, oldActor, destination);
        checkSignal = () => {};
        World.retireUserActor(replacement, oldActor);
        const current = { ...oldActor, fetchId: () => 303 };
        replacement.actor = current;
        World.updateUserLocation(replacement);
        signals.length = 0;
        checkSignal = id => { if (id === 303) assert(!replacement.pendingActorTeleport); };
        timers.shift()();
        assert(!replacement.pendingActorTeleport);
        assert.deepStrictEqual(signals, [303], 'stale teleport clear targets the currently registered actor');
        checkSignal = () => {};
        console.log('Native teleport matching/nested/replaced-actor busy-end controls PASS');

        const left = session(401), right = session(402);
        const states = new Map([401, 402].map(characterId => [characterId, { characterId, phase: 'hot', stats: {} }]));
        replace(Life, 'settleWrites', async () => {});
        replace(Life, 'cachedState', id => states.get(Number(id)));
        replace(Life, 'preparePartyAssignment', state => ({ ...state }));
        replace(Life, 'acceptPartyAssignments', rows => rows);
        replace(Parties, 'prepareCommit', row => ({ row: { ...row, updatedAt: Date.now() }, snapshot: { ...row } }));
        replace(Parties, 'acceptCommit', () => {});
        let released = 0;
        replace(Population, 'reserveCompetitionPartySlot', () => () => { released++; });
        let outcome = { ok: false, reason: 'native_refusal' };
        replace(Database, 'commitBackgroundPartyMembership', async () => {
            if (outcome instanceof Error) throw outcome;
            return outcome;
        });
        const context = { at: Date.now(), spotId: 'busy_field', npcId: 1, mob: {} };
        checkSignal = id => {
            if (![401, 402].includes(id)) return;
            assert(!left.hotCompetitionCommit && !right.hotCompetitionCommit, 'whole group clears before wake');
            assert(released > 0, 'capacity releases before wake');
        };
        signals.length = 0;
        await Competition.form([{ sessions: [left, right] }], context, () => false);
        assert.deepStrictEqual(signals, [401, 402], 'context refusal wakes cleared exact members');
        signals.length = 0;
        await Competition.form([{ sessions: [left, right] }], context, () => true);
        assert.deepStrictEqual(signals, [401, 402], 'native refusal wakes cleared exact members');
        signals.length = 0;
        outcome = new Error('private_native_failure');
        await assert.rejects(Competition.form([{ sessions: [left, right] }], context, () => true), /private_native_failure/);
        assert.deepStrictEqual(signals, [401, 402], 'thrown native failure still publishes busy-end');
        signals.length = 0;
        outcome = { ok: true };
        assert.strictEqual((await Competition.form([{ sessions: [left, right] }], context, () => true)).ok, true);
        assert.deepStrictEqual(signals, [401, 402], 'accepted membership publishes after complete cleanup');
        assert.deepStrictEqual(signalErrors, [], 'listener isolation must not swallow failed ordering assertions');
        console.log('Actual competition finalizer accepted/refused/thrown post-cleanup controls PASS');
    } finally {
        unsubscribe();
        unsubscribeOrdering();
        for (const undo of restore.reverse()) undo();
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
