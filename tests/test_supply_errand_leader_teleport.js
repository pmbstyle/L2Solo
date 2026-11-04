const assert = require('assert');

require('../src/Global');

// E292 (option 2): a party companion on a hidden supply errand
// (player_resource_purchase) in the phases the errand owns (cold: the escape
// cast, shopping: hot AI in the supply town) is not moved by the leader's
// teleport. The errand keeps its state and its normal return
// (ShoppingState.scheduleResourceReturn) places the bot beside the leader's
// position at return time, so the bot comes back where the leader now is.

const BotSupplyErrand = invoke('GameServer/Bot/AI/BotSupplyErrand');
const BotTownTravel = invoke('GameServer/Bot/AI/BotTownTravel');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const DataCache = invoke('GameServer/DataCache');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
const ServerResponse = invoke('GameServer/Network/Response');
const BotAI = invoke('GameServer/Bot/BotAI');
const TeleportTo = invoke('GameServer/Actor/Generics/TeleportTo');
const BotRaidSafety = invoke('GameServer/Bot/AI/BotRaidSafety');
const ShoppingState = invoke('GameServer/Bot/AI/States/ShoppingState');
const TownChatter = invoke('GameServer/Bot/AI/TownChatter');

function item(id, selfId, amount) {
    let count = amount;
    return {
        fetchId: () => id,
        fetchSelfId: () => selfId,
        fetchAmount: () => count,
        setAmount: (value) => { count = value; }
    };
}

function makeWorld(counters) {
    const leaderLoc = { locX: 0, locY: 0, locZ: 0 };
    const player = {
        accountId: 'player',
        actor: {
            fetchId: () => 100,
            fetchName: () => 'Slava',
            fetchIsOnline: () => true,
            fetchLocX: () => leaderLoc.locX,
            fetchLocY: () => leaderLoc.locY,
            fetchLocZ: () => leaderLoc.locZ
        }
    };
    const adena = item(10, 57, 100000);
    const bot = {
        fetchId: () => 1,
        fetchName: () => 'Caelan',
        fetchIsOnline: () => true,
        fetchKarma: () => 0,
        fetchLevel: () => 20,
        fetchLocX: () => 0,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        isDead: () => false,
        unselect() {},
        setLocXYZ(point) { counters.placed.push(point); },
        moveTo() {},
        backpack: { fetchItemFromSelfId: (selfId) => (Number(selfId) === 57 ? adena : null) },
        automation: { abortAll() {} },
        state: { fetchHits: () => false, fetchCasts: () => false, setCasts() {} }
    };
    const session = {
        accountId: 'bot_1',
        actor: bot,
        partyCompanion: true,
        followPlayerSession: player,
        dataSendToOthers: (packet) => { counters.sent.push(packet); }
    };
    const other = {
        accountId: 'bot_2',
        partyCompanion: true,
        followPlayerSession: player,
        companionShopping: undefined,
        plan: 'following',
        actor: { fetchId: () => 2, isDead: () => false, unselect() {}, fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0 }
    };
    return { player, bot, session, other, leaderLoc };
}

async function flush() {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

async function runCase(phaseWanted, failures) {
    const counters = { sent: [], placed: [], markHot: 0, stop: 0, init: 0 };
    let arrival = null;
    BotTownTravel.request = (_session, _bot, _ai, _reason, options) => {
        arrival = options.onArrival;
        return 'escape';
    };
    BotAI.stop = () => { counters.stop += 1; };
    BotAI.init = () => { counters.init += 1; };
    BotAI.wakeup = () => {};
    PopulationService.markHot = async () => { counters.markHot += 1; return { phase: 'hot' }; };

    const { player, bot, session, other, leaderLoc } = makeWorld(counters);
    const requested = BotSupplyErrand.request(session, player, 1463, 1);
    assert.strictEqual(requested.ok, true, `${phaseWanted}: supply errand starts (${requested.reason})`);
    await flush();
    assert.strictEqual(session.supplyErrandPhase, 'cold');
    assert.strictEqual(session.supplyErrandHidden, true);
    if (phaseWanted === 'shopping') {
        arrival();
        assert.strictEqual(session.supplyErrandPhase, 'shopping');
    }
    counters.sent.length = 0;
    const before = {
        companionShopping: session.companionShopping,
        shoppingTarget: session.shoppingTarget,
        resumeAfterShopping: session.resumeAfterShopping,
        plan: session.plan
    };

    // The leader (a real player) teleports; an ordinary companion is synced
    // beside it, the companion on the supply errand stays on its errand.
    leaderLoc.locX = 5000;
    leaderLoc.locY = 5000;
    const teleported = [];
    const Generics = { teleportTo: (target) => { teleported.push(target.accountId); return true; }, revive() {} };
    const moved = TeleportTo.syncPartyCompanions(player, { locX: 5000, locY: 5000, locZ: 0 }, Generics, [session, other]);
    await flush();

    const check = (ok, message) => { if (!ok) failures.push(`${phaseWanted}: ${message}`); };
    check(moved === 1, `syncPartyCompanions moved ${moved} companions (expected 1: only the companion not on the errand)`);
    check(!teleported.includes('bot_1'), 'the companion on the supply errand was teleported with the leader');
    check(teleported.includes('bot_2'), 'the ordinary companion was not teleported with the leader');
    check(other.plan === 'following', 'the ordinary companion is not set to follow');
    check(session.supplyErrandHidden === true,
        `supplyErrandHidden is ${session.supplyErrandHidden} after the leader teleport (expected the errand to stay hidden)`);
    check(session.supplyErrandPhase === phaseWanted,
        `supplyErrandPhase is '${session.supplyErrandPhase}' after the leader teleport (expected '${phaseWanted}')`);
    check(session.companionShopping === before.companionShopping, 'companionShopping was changed by the leader teleport');
    check(session.shoppingTarget === before.shoppingTarget, 'shoppingTarget was changed by the leader teleport');
    check(session.resumeAfterShopping === before.resumeAfterShopping, 'resumeAfterShopping was changed by the leader teleport');
    check(session.plan === before.plan, `plan is '${session.plan}' after the leader teleport (expected '${before.plan}')`);
    check(counters.markHot === 0, `PopulationService.markHot called ${counters.markHot} times by the leader teleport (expected 0)`);
    check(counters.sent.length === 0, 'packets were sent to others for the hidden companion by the leader teleport');
    if (failures.length) return;

    // The errand ends through its normal return: the bot reappears beside the
    // leader's new position, visible and hot again.
    const timers = [];
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (callback, delay) => { timers.push({ callback, delay }); return timers.length; };
    try {
        ShoppingState.scheduleResourceReturn(session, bot, BotAI, { deliveryReady: true });
    } finally {
        global.setTimeout = realSetTimeout;
    }
    assert.strictEqual(timers.length, 1, `${phaseWanted}: one supply return is scheduled`);
    timers[0].callback();
    await new Promise((resolve) => realSetTimeout(resolve, 0));

    check(JSON.stringify(counters.placed) === JSON.stringify([{ locX: 5080, locY: 5000, locZ: 0 }]),
        `the returning companion was placed at ${JSON.stringify(counters.placed)} (expected beside the leader's new position 5080,5000)`);
    check(session.supplyErrandHidden === false, 'the returning companion stays hidden');
    check(session.supplyErrandPhase === undefined, `supplyErrandPhase is '${session.supplyErrandPhase}' after the return`);
    check(counters.markHot === 1, `PopulationService.markHot called ${counters.markHot} times by the return (expected 1)`);
    check(session.plan === 'following', `plan is '${session.plan}' after the return (expected following)`);
    check(session.resumeAfterShopping === undefined && session.companionShopping === undefined,
        'the errand state is not consumed by the return');
}

// The leader's teleport also ends a party raid (BotRaidSafety.endPlayerPartyRaid,
// called by TeleportTo for a player): its companion sweep must leave the
// errand companion alone as well.
async function raidEndCase(failures) {
    const counters = { sent: [], placed: [], markHot: 0, stop: 0, init: 0 };
    BotTownTravel.request = () => 'escape';
    BotAI.stop = () => {};
    BotAI.init = () => {};
    BotAI.wakeup = () => {};
    const cancelled = [];
    BotAI.cancelScheduledTick = (target) => { cancelled.push(target.accountId); };
    PopulationService.markHot = async () => { counters.markHot += 1; return { phase: 'hot' }; };
    const { player, session, other } = makeWorld(counters);
    const requested = BotSupplyErrand.request(session, player, 1463, 1);
    assert.strictEqual(requested.ok, true, `raid: supply errand starts (${requested.reason})`);
    await flush();
    session.supplyErrandPhase = 'shopping';
    session.plan = 'shopping';
    other.plan = 'raid';
    player.partyRaidEngagement = { bossId: 1 };
    const Party = invoke('GameServer/Bot/AI/PartyCompanionService');
    const Tactics = invoke('GameServer/Bot/AI/BotPvpTactics');
    const saved = { members: Party.membersForLeader, stop: Tactics.stop, followSummon: Tactics.followSummon };
    const tactics = [];
    Party.membersForLeader = () => [session, other];
    Tactics.stop = (target) => { tactics.push(target.accountId); };
    Tactics.followSummon = () => {};
    try {
        assert.strictEqual(BotRaidSafety.endPlayerPartyRaid(player), true, 'raid: the raid ends');
    } finally {
        Party.membersForLeader = saved.members;
        Tactics.stop = saved.stop;
        Tactics.followSummon = saved.followSummon;
    }
    const check = (ok, message) => { if (!ok) failures.push(`raid: ${message}`); };
    check(session.plan === 'shopping', `the errand companion's plan is '${session.plan}' after the raid end (expected shopping)`);
    check(!cancelled.includes('bot_1'), 'the errand companion\'s AI tick was cancelled by the raid end');
    check(!tactics.includes('bot_1'), 'the errand companion\'s tactics were stopped by the raid end');
    check(other.plan === 'following', `the ordinary companion's plan is '${other.plan}' after the raid end (expected following)`);
    check(cancelled.includes('bot_2'), 'the ordinary companion\'s AI tick was not cancelled');
}

// The errand's return turns the row hot before the AI runs again. With the population off there is
// no row to own: it resumes at once. While the hot write fails the bot stays parked (its AI not
// started); at shutdown the wait ends and nothing resumes.
async function returnCase(failures) {
    const Config = invoke('GameServer/Bot/Population/PopulationConfig');
    const check = (ok, message) => { if (!ok) failures.push(`return: ${message}`); };
    const parked = () => ({ actor: { fetchId: () => 2000301 }, supplyErrandPhase: 'cold', plan: 'following',
        dataSendToOthers() {} });
    let writes = 0, inits = 0;
    PopulationService.markHot = async () => { writes += 1; return null; };
    BotAI.stop = () => {}; BotAI.init = () => { inits += 1; };
    const enabled = Config.enabled;
    try {
        Config.enabled = false;
        const off = await BotTownTravel.restoreSupplyHot(parked(), null);
        check(off.ok === true && inits === 1 && writes === 0, `population off: ok=${off.ok} inits=${inits} writes=${writes} (expected resumed, no write)`);
    } finally {
        Config.enabled = enabled;
    }
    inits = 0; writes = 0;
    const session = parked();
    const returned = BotTownTravel.restoreSupplyHot(session, null);
    await new Promise(resolve => setImmediate(resolve));
    check(writes === 1 && inits === 0 && session.supplyErrandPhase === 'returning',
        `a failed hot write: writes=${writes} inits=${inits} phase=${session.supplyErrandPhase} (expected parked, AI not started)`);
    BotTownTravel.stopSupplyReturns();
    const stopped = await returned;
    check(stopped.ok === false && inits === 0 && writes === 1, `at shutdown: ok=${stopped.ok} inits=${inits} writes=${writes} (expected no resume, no write)`);
}

async function main() {
    const originals = {
        bestSupplyOffer: MarketOpportunity.bestSupplyOffer,
        request: BotTownTravel.request,
        markCold: LifeState.markCold,
        markHot: PopulationService.markHot,
        stop: BotAI.stop,
        init: BotAI.init,
        wakeup: BotAI.wakeup,
        cancelScheduledTick: BotAI.cancelScheduledTick,
        charInfo: ServerResponse.charInfo,
        relationChanged: ServerResponse.relationChanged,
        items: DataCache.items,
        say: TownChatter.say
    };
    const failures = [];
    try {
        DataCache.items = [{ selfId: 1463, template: { name: 'Soulshot: D-grade' }, etc: { stackable: true } }];
        MarketOpportunity.bestSupplyOffer = () => ({
            sourceType: 'npc', sourceId: 7004, sourceName: 'D-grade grocer', town: 'Talking Island',
            locX: -84000, locY: 244000, locZ: -3700,
            selfId: 1463, price: 17, itemName: 'Soulshot: D-grade', available: true
        });
        LifeState.markCold = async () => ({ phase: 'cold', activity: 'shopping' });
        ServerResponse.charInfo = () => 'charInfo';
        ServerResponse.relationChanged = () => 'relationChanged';
        TownChatter.say = () => {};

        await runCase('cold', failures);
        await runCase('shopping', failures);
        await raidEndCase(failures);
        await returnCase(failures);
    } finally {
        MarketOpportunity.bestSupplyOffer = originals.bestSupplyOffer;
        BotTownTravel.request = originals.request;
        LifeState.markCold = originals.markCold;
        PopulationService.markHot = originals.markHot;
        BotAI.stop = originals.stop;
        BotAI.init = originals.init;
        BotAI.wakeup = originals.wakeup;
        BotAI.cancelScheduledTick = originals.cancelScheduledTick;
        ServerResponse.charInfo = originals.charInfo;
        ServerResponse.relationChanged = originals.relationChanged;
        DataCache.items = originals.items;
        TownChatter.say = originals.say;
    }
    assert.deepStrictEqual(failures, [], `leader teleport and the supply errand:\n  ${failures.join('\n  ')}`);
    console.log('supply errand leader teleport tests passed');
}

main().then(() => process.exit(0)).catch((error) => {
    console.error(error);
    process.exit(1);
});
