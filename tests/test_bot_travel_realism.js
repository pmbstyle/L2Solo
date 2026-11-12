const assert = require('assert');

const fs = require('node:fs');
const nodePath = require('node:path');
const isolated = require('./helpers/isolatedSocialDatabase')('bot_travel_realism', nodePath.resolve(__dirname, '..'));
require('./helpers/databaseIsolation');
require('../src/Global');
isolated.assertConfigured(options.default);

const DataCache = invoke('GameServer/DataCache');
const ShoppingState = invoke('GameServer/Bot/AI/States/ShoppingState');
const GettingBuffedState = invoke('GameServer/Bot/AI/States/GettingBuffedState');
const CompanionNavigationRecovery = invoke('GameServer/Bot/AI/CompanionNavigationRecovery');
const ShotStock = invoke('GameServer/Inventory/ShotStock');
const BotBuffs = invoke('GameServer/Bot/AI/BotBuffs');
const HotTownRebuff = invoke('GameServer/Bot/AI/HotTownRebuff');
const TownNpcApproach = invoke('GameServer/Bot/AI/TownNpcApproach');

DataCache.init();

function bot(loc = {}) {
    return {
        locX: loc.locX ?? 0,
        locY: loc.locY ?? 0,
        locZ: loc.locZ ?? 0,
        moves: [],
        unselected: false,
        fetchLocX() { return this.locX; },
        fetchLocY() { return this.locY; },
        fetchLocZ() { return this.locZ; },
        moveTo(data) { this.moves.push(data); },
        unselect() { this.unselected = true; },
        // The restock reads the wallet after its purchase (a19a9727).
        backpack: { fetchItemFromSelfId: () => null, fetchItems: () => [] },
        state: {
            inMotion: () => false
        },
        fetchId: () => loc.actorId ?? 2000099,
        fetchName: () => 'TravelBot',
        fetchLevel: () => loc.level ?? 21,
        fetchKarma: () => loc.karma ?? 0
    };
}

const World = invoke('GameServer/World/World');
const originalUsers = World.user;
const published = new Set();
const scheduledWork = [];
let fixtureUsers;
// Each scene keeps the original TravelBot object ID 2000099. Remove its
// previous registration before publishing the next unit actor at that ID.
// The original leader facades lack an ID: use the adjacent explicit ID from
// the same test actor constructor's range, without altering their positions.
function publishTravelSession(session, actor) {
    const leader = session.followPlayerSession || session.resumeAfterBuff?.followPlayerSession
        || session.resumeAfterShopping?.followPlayerSession;
    if (leader?.actor && typeof leader.actor.fetchId !== 'function') leader.actor.fetchId = () => 2000098;
    const current = leader?.actor ? [leader, session] : [session];
    if (!fixtureUsers) { fixtureUsers = { sessions: [], revision: 0 }; World.user = fixtureUsers; }
    for (const previous of [...published]) {
        if (current.includes(previous)) continue;
        World.removeUser(previous); published.delete(previous);
    }
    session.actor = actor;
    if (session.partyCompanion && leader) session.followPlayerSession = leader;
    for (const item of current) {
        const ownActor = item.actor;
        item.accountId ??= `${item === leader ? 'travel_player' : 'bot_travel'}_${ownActor.fetchId()}`;
        item.fetchAccountId ??= function () { return this.accountId; };
        item.dataSendToMe ??= () => {};
        ownActor.fetchIsOnline ??= () => true;
        ownActor.session = item;
        if (!published.has(item)) { World.insertUser(item); published.add(item); }
        else World.updateUserLocation(item);
        assert.strictEqual(World.registeredActorById(ownActor.fetchId())?.actor, ownActor,
            'the unit actor must be the exact native World registration');
    }
    BotManager.sessions = [session];
    World.refreshPartyMemberships(current);
}
async function settleScheduledWork() {
    for (let round = 0; scheduledWork.length; round += 1) {
        assert(round < 20, 'unit restock callbacks must settle in a bounded number of turns');
        await Promise.all(scheduledWork.splice(0));
    }
}
const originalSetTimeout = global.setTimeout;
const originalPlanForActor = ShotStock.planForActor;
const originalShotAmount = ShotStock.shotAmount;
const originalPurchaseActorRestock = ShotStock.purchaseActorRestock;
const BotManager = invoke('GameServer/Bot/BotManager');
const originalPartySay = BotManager.botPartySay;
const originalBotSessions = BotManager.sessions;
const originalApplyFullNewbieBlessing = BotBuffs.applyFullNewbieBlessing;
const originalNeedsNewbieRefresh = BotBuffs.needsNewbieRefresh;
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const NpcRestockPlan = invoke('GameServer/Bot/Economy/NpcRestockPlan');
const originalHotRow = LifeState.hotRow;
const originalPurchaseForActor = NpcRestockPlan.purchaseForActor;

async function run() {
try {
    global.setTimeout = (fn) => {
        scheduledWork.push(Promise.resolve(fn()));
        return 0;
    };

    ShotStock.planForActor = () => ({ selfId: 1835, price: 1, kind: 'soulshot', rank: 'none', name: 'Soulshot: No Grade' });
    ShotStock.shotAmount = () => 0;
    ShotStock.purchaseActorRestock = () => Promise.resolve({ ok: true, delta: 10, cost: 10 });
    // A hot restock goes on only while the bot's row is hot, and buys at the NPC
    // through one seller basket (a19a9727); the travel scenes have no database.
    LifeState.hotRow = (characterId) => ({ characterId, phase: 'hot' });
    NpcRestockPlan.purchaseForActor = () => Promise.resolve({ ok: true, receipts: [] });

    const shopper = bot({ locX: 1000, locY: 1000, locZ: -100 });
    const shoppingSession = {
        plan: 'shopping',
        preShopLocation: { locX: 2000, locY: 2100, locZ: -120 },
        partyCompanion: false,
        dataSendToOthers() {}
    };
    const noTeleportGenerics = {
        teleportTo() {
            throw new Error('shopping return should move instead of teleporting');
        }
    };

    publishTravelSession(shoppingSession, shopper);

    const Slots = invoke('GameServer/Bot/AI/TownNpcSlots');
    const otherShopper = {};
    Slots.reserve(otherShopper, 'completed-visit', () => [1]);
    Slots.reserve(shoppingSession, 'completed-visit', () => [1]);
    shoppingSession.townNpcApproach = { key: 'completed-visit', phase: 'interaction' };
    ShoppingState.scheduleRestock(shoppingSession, shopper, noTeleportGenerics, { say() {} });

    await settleScheduledWork();
    assert.strictEqual(shopper.moves.length, 0, 'solo shopping must let hunting route through the town gatekeeper');
    assert.strictEqual(shoppingSession.preShopLocation, undefined);
    assert.strictEqual(shoppingSession.pendingFarmDepartureAnnouncement, true,
        'the next hunting-ground decision should announce a clear farming destination');
    assert(!shoppingSession.townNpcQueue && !shoppingSession.townNpcSlot && !shoppingSession.townNpcApproach,
        'finishing the visit must release all shop waiting state before hunting resumes');
    Slots.release(otherShopper);

    const HuntingState = invoke('GameServer/Bot/AI/States/HuntingState');
    const departureBot = bot({ locX: 80456, locY: 147864, locZ: -3504 });
    const departureSession = { actor: departureBot, plan: 'hunting', pendingFarmDepartureAnnouncement: true };
    const savedMove = CompanionNavigationRecovery.move;
    try {
        let departureTarget;
        CompanionNavigationRecovery.move = (_session, _actor, target) => {
            departureTarget = target;
            return { status: 'started' };
        };
        assert(HuntingState.leaveShop(departureSession, departureBot),
            'a completed solo visit must leave the shop even before a suitable farm spot is selected');
        assert(Math.hypot(departureTarget.locX - 83396, departureTarget.locY - 147904) < 200,
            'the departure must walk toward the public square');
        departureBot.locX = departureTarget.locX;
        departureBot.locY = departureTarget.locY;
        assert.strictEqual(HuntingState.leaveShop(departureSession, departureBot), false,
            'arriving on the square must resume normal decisions without a teleport');
        departureBot.locX = 80456;
        departureBot.locY = 147864;
        departureSession.spotRelocation = { method: 'town_gatekeeper' };
        assert.strictEqual(HuntingState.leaveShop(departureSession, departureBot), false,
            'an already chosen farming trip must retain ownership of movement');
        departureSession.spotRelocation = undefined;
        departureSession.incomingThreatId = 123;
        departureSession.incomingThreatAt = Date.now();
        assert.strictEqual(HuntingState.leaveShop(departureSession, departureBot), false,
            'leaving the shop must yield to incoming combat');
        departureSession.incomingThreatId = undefined;
        departureBot.fetchHp = () => 10;
        departureBot.fetchMaxHp = () => 100;
        assert.strictEqual(HuntingState.leaveShop(departureSession, departureBot), false,
            'a wounded bot must recover before walking out of the shop');
    } finally { CompanionNavigationRecovery.move = savedMove; }

    BotBuffs.applyFullNewbieBlessing = () => ({ buffs: [], expiresAt: Date.now() + 60000 });

    const starterTownAi = {
        getClosestNewbieGuide: () => ({
            name: 'Talking Island',
            npcSelfId: 7598,
            locX: -84081,
            locY: 243227,
            locZ: -3723,
            head: 9000
        }),
        say() {}
    };

    const buffBot = bot({ locX: -84081, locY: 243227, locZ: -3723 });
    const buffSession = {
        plan: 'getting_buffed',
        preBuffPlan: 'hunting',
        preBuffLocation: { locX: -83000, locY: 242000, locZ: -3700 }
    };
    publishTravelSession(buffSession, buffBot);
    GettingBuffedState.tick(buffSession, buffBot, noTeleportGenerics, {
        getClosestNewbieGuide: () => ({ locX: -84081, locY: 243227, locZ: -3723 }),
        say() {}
    });

    assert.strictEqual(buffBot.unselected, true, 'buff return should clear the old target');
    assert.strictEqual(buffBot.moves.length, 0, 'a solo buff visit should leave town through the hunting gatekeeper flow');
    assert.strictEqual(buffSession.plan, 'hunting');
    assert.strictEqual(buffSession.pendingFarmDepartureAnnouncement, true);

    const townVisitBot = bot({ locX: -83700, locY: 243227, locZ: -3723, level: 10 });
    const initialTownVisit = HotTownRebuff.currentVisit(townVisitBot, starterTownAi);
    assert(initialTownVisit, 'an eligible hot bot at the starter-town guide should have a town rebuff visit');
    const townVisitSession = {
        plan: 'getting_buffed',
        preBuffPlan: 'hunting',
        resumeAfterBuff: {
            plan: 'hunting',
            townVisitKey: initialTownVisit.key
        }
    };
    publishTravelSession(townVisitSession, townVisitBot);
    GettingBuffedState.tick(townVisitSession, townVisitBot, noTeleportGenerics, starterTownAi);
    assert.strictEqual(townVisitBot.moves.length, 1, 'the guide visit should use one direct open-air approach');
    Object.assign(townVisitBot, townVisitBot.moves[0].to);
    publishTravelSession(townVisitSession, townVisitBot);
    GettingBuffedState.tick(townVisitSession, townVisitBot, noTeleportGenerics, starterTownAi);
    assert.strictEqual(townVisitBot.moves.length, 1, 'the guide visit must not add a shared staging leg');
    assert.strictEqual(
        townVisitSession.hotTownRebuffCompletedVisitKey,
        initialTownVisit.key,
        'a successful Newbie Guide visit should complete this hot-bot town visit'
    );
    assert.strictEqual(
        HotTownRebuff.needsVisit(townVisitSession, HotTownRebuff.currentVisit(townVisitBot, starterTownAi)),
        false,
        'the bot must not loop back to the guide during the same town visit'
    );

    townVisitBot.locX = 0;
    townVisitBot.locY = 0;
    HotTownRebuff.syncVisit(townVisitSession, townVisitBot, starterTownAi);
    assert.strictEqual(
        townVisitSession.hotTownRebuffCompletedVisitKey,
        undefined,
        'leaving town should reset the one-rebuff-per-visit marker'
    );
    townVisitBot.locX = -84081;
    townVisitBot.locY = 243227;
    assert.strictEqual(
        HotTownRebuff.needsVisit(townVisitSession, HotTownRebuff.currentVisit(townVisitBot, starterTownAi)),
        true,
        'entering the starter town again should require a fresh rebuff'
    );

    const companionLeader = {
        fetchIsOnline: () => true,
        fetchLocX: () => -84150,
        fetchLocY: () => 243180,
        fetchLocZ: () => -3723
    };
    const companionBot = bot({ locX: -84081, locY: 243227, locZ: -3723 });
    const companionSession = {
        plan: 'getting_buffed',
        partyCompanion: true,
        resumeAfterBuff: {
            plan: 'following',
            followPlayerSession: { actor: companionLeader },
            partyCompanion: true,
            botStay: false,
            stayLocation: null,
            role: 'dps'
        }
    };
    publishTravelSession(companionSession, companionBot);
    GettingBuffedState.tick(companionSession, companionBot, noTeleportGenerics, {
        getClosestNewbieGuide: () => ({ locX: -84081, locY: 243227, locZ: -3723 }),
        say() {}
    });

    assert.strictEqual(companionSession.plan, 'following', 'companion should resume following after the Newbie Guide buffs it');
    assert.strictEqual(companionBot.moves.length, 1, 'buffed companion should move back to the player');
    assert(Math.abs(companionBot.moves[0].to.locX - companionLeader.fetchLocX()) <= 60, 'companion return should target the player vicinity');
    assert(Math.abs(companionBot.moves[0].to.locY - companionLeader.fetchLocY()) <= 60, 'companion return should target the player vicinity');
    assert.strictEqual(companionBot.moves[0].to.locZ, companionLeader.fetchLocZ());

    const edgeGuideBot = bot({ locX: -83828, locY: 243227, locZ: -3723 });
    const edgeGuideSession = {
        plan: 'getting_buffed',
        preBuffPlan: 'hunting',
        preBuffLocation: { locX: -83000, locY: 242000, locZ: -3700 }
    };
    publishTravelSession(edgeGuideSession, edgeGuideBot);
    GettingBuffedState.tick(edgeGuideSession, edgeGuideBot, noTeleportGenerics, {
        getClosestNewbieGuide: () => ({ locX: -84081, locY: 243227, locZ: -3723 }),
        say() {}
    });
    assert.strictEqual(edgeGuideSession.plan, 'getting_buffed',
        'a bot outside close interaction range should approach the guide before receiving buffs');
    assert.strictEqual(edgeGuideBot.moves.length, 1,
        'the guide approach should stop near the NPC instead of buffing from the old wide radius');
    Object.assign(edgeGuideBot, edgeGuideBot.moves[0].to);
    publishTravelSession(edgeGuideSession, edgeGuideBot);
    GettingBuffedState.tick(edgeGuideSession, edgeGuideBot, noTeleportGenerics, {
        getClosestNewbieGuide: () => ({ locX: -84081, locY: 243227, locZ: -3723 }),
        say() {}
    });
    assert.strictEqual(edgeGuideSession.plan, 'hunting');
    assert.strictEqual(edgeGuideSession.pendingFarmDepartureAnnouncement, true);

    const deathRecoveryBot = bot({ locX: 46976, locY: 51511, locZ: -2976, level: 21 });
    const deathRecoverySession = {
        plan: 'getting_buffed',
        partyCompanion: true,
        followPlayerSession: { actor: companionLeader },
        resumeAfterBuff: {
            plan: 'following',
            followPlayerSession: { actor: companionLeader },
            partyCompanion: true,
            botStay: false,
            stayLocation: null,
            role: 'dps',
            conditionalNewbieBuff: true,
            returnMode: 'teleport'
        }
    };
    const recoveryTeleports = [];
    const recoveryGenerics = {
        teleportTo(_session, _actor, target) { recoveryTeleports.push(target); }
    };
    publishTravelSession(deathRecoverySession, deathRecoveryBot);
    GettingBuffedState.tick(deathRecoverySession, deathRecoveryBot, recoveryGenerics, {
        getClosestNewbieGuide: () => ({ locX: -84081, locY: 243227, locZ: -3723 }),
        say() {}
    });
    assert.strictEqual(recoveryTeleports.length, 1, 'an overleveled companion should skip the Newbie Guide and teleport back');
    assert.strictEqual(deathRecoverySession.plan, 'getting_buffed', 'the recovery state should remain active until the return teleport settles');
    deathRecoverySession.resumeAfterBuff.returnTeleportStartedAt = Date.now() - 2000;
    publishTravelSession(deathRecoverySession, deathRecoveryBot);
    GettingBuffedState.tick(deathRecoverySession, deathRecoveryBot, recoveryGenerics, {
        getClosestNewbieGuide: () => ({ locX: -84081, locY: 243227, locZ: -3723 }),
        say() {}
    });
    assert.strictEqual(recoveryTeleports.length, 1, 'settling the return must not schedule duplicate teleports');
    assert.strictEqual(deathRecoverySession.plan, 'following', 'the companion should resume following after the return teleport settles');
    assert.strictEqual(deathRecoverySession.partyCompanion, true, 'the full town-return flow must keep party membership');

    let recoveryNeedsBuff = true;
    let recoveryBuffsApplied = 0;
    BotBuffs.needsNewbieRefresh = () => recoveryNeedsBuff;
    BotBuffs.applyFullNewbieBlessing = () => {
        recoveryNeedsBuff = false;
        recoveryBuffsApplied += 1;
        return { buffs: ['windwalk', 'shield', 'haste'], expiresAt: Date.now() + 60000 };
    };
    const lowLevelRecoveryBot = bot({ locX: -84081, locY: 243227, locZ: -3723, level: 10 });
    const lowLevelRecoverySession = {
        plan: 'getting_buffed',
        partyCompanion: true,
        followPlayerSession: { actor: companionLeader },
        resumeAfterBuff: {
            plan: 'following',
            followPlayerSession: { actor: companionLeader },
            partyCompanion: true,
            botStay: false,
            stayLocation: null,
            role: 'dps',
            conditionalNewbieBuff: true,
            returnMode: 'teleport'
        }
    };
    const lowLevelRecoveryTeleports = [];
    publishTravelSession(lowLevelRecoverySession, lowLevelRecoveryBot);
    GettingBuffedState.tick(lowLevelRecoverySession, lowLevelRecoveryBot, {
        teleportTo(_session, _actor, target) { lowLevelRecoveryTeleports.push(target); }
    }, {
        getClosestNewbieGuide: () => ({ locX: -84081, locY: 243227, locZ: -3723 }),
        say() {}
    });
    assert.strictEqual(recoveryBuffsApplied, 1, 'an eligible dead companion should refresh cleared Newbie Guide buffs before returning');
    assert.strictEqual(lowLevelRecoveryTeleports.length, 1, 'the rebuffed companion should teleport back instead of walking across the world');

    // A low-level companion respawned in a town without a Newbie Guide (the
    // closest one is across the map) returns to its party without walking there.
    recoveryNeedsBuff = true;
    const guidelessRespawnBot = bot({ locX: 9000, locY: 243227, locZ: -3723, level: 10 });
    const guidelessRespawnSession = {
        plan: 'getting_buffed',
        partyCompanion: true,
        followPlayerSession: { actor: companionLeader },
        resumeAfterBuff: {
            plan: 'following',
            followPlayerSession: { actor: companionLeader },
            partyCompanion: true,
            botStay: false,
            stayLocation: null,
            role: 'dps',
            conditionalNewbieBuff: true,
            returnMode: 'teleport',
            reason: 'party_town_respawn'
        }
    };
    const guidelessRespawnTeleports = [];
    const guidelessRespawnGenerics = {
        teleportTo(_session, _actor, target) { guidelessRespawnTeleports.push(target); }
    };
    const farGuideAi = {
        getClosestNewbieGuide: () => ({ locX: -84081, locY: 243227, locZ: -3723 }),
        say() {}
    };
    publishTravelSession(guidelessRespawnSession, guidelessRespawnBot);
    GettingBuffedState.tick(guidelessRespawnSession, guidelessRespawnBot, guidelessRespawnGenerics, farGuideAi);
    assert.strictEqual(guidelessRespawnBot.moves.length, 0, 'a respawned companion must not walk to a Newbie Guide beyond its town radius');
    assert.strictEqual(guidelessRespawnTeleports.length, 1, 'a respawned companion without a guide in town should teleport back to its party');
    assert.strictEqual(guidelessRespawnSession.plan, 'getting_buffed', 'the return stays active until its teleport settles');
    guidelessRespawnSession.resumeAfterBuff.returnTeleportStartedAt = Date.now() - 2000;
    publishTravelSession(guidelessRespawnSession, guidelessRespawnBot);
    GettingBuffedState.tick(guidelessRespawnSession, guidelessRespawnBot, guidelessRespawnGenerics, farGuideAi);
    assert.strictEqual(guidelessRespawnSession.plan, 'following', 'the companion should resume following after the return teleport settles');
    assert.strictEqual(guidelessRespawnBot.moves.length, 0, 'the return must not walk toward the distant guide');
    assert.strictEqual(recoveryBuffsApplied, 1, 'no Newbie Guide buffs are granted without a guide in town');
    recoveryNeedsBuff = false;

    // A guide trip started inside the town radius whose route then carries the
    // bot beyond it must not end silently: it keeps its guide or sets the retry.
    const driftBot = bot({ locX: -84081 + 7400, locY: 243227, locZ: -3723, level: 10 });
    const driftSession = {
        plan: 'getting_buffed',
        preBuffPlan: 'hunting',
        preBuffLocation: { locX: -84081 + 7400, locY: 243227, locZ: -3723 }
    };
    publishTravelSession(driftSession, driftBot);
    GettingBuffedState.tick(driftSession, driftBot, noTeleportGenerics, farGuideAi);
    assert.strictEqual(driftSession.plan, 'getting_buffed', 'a guide within the town radius starts the trip');
    driftBot.locX = -84081 + 7600;
    publishTravelSession(driftSession, driftBot);
    GettingBuffedState.tick(driftSession, driftBot, noTeleportGenerics, farGuideAi);
    assert(driftSession.plan === 'getting_buffed' || Number(driftSession.newbieGuideRetryAt || 0) > Date.now(),
        'a trip whose route leaves the town radius must keep its guide or wait for the retry time');

    const shoppingLeader = {
        fetchIsOnline: () => true,
        fetchLocX: () => -84020,
        fetchLocY: () => 243150,
        fetchLocZ: () => -3723
    };
    const shoppingBot = bot({ locX: -84081, locY: 243227, locZ: -3723 });
    const shoppingCompanionSession = {
        plan: 'shopping',
        partyCompanion: true,
        followPlayerSession: { actor: shoppingLeader },
        companionShopping: { kind: 'restock_shots' },
        resumeAfterShopping: { plan: 'following', followPlayerSession: { actor: shoppingLeader } },
        dataSendToOthers() {}
    };
    publishTravelSession(shoppingCompanionSession, shoppingBot);
    ShoppingState.scheduleRestock(shoppingCompanionSession, shoppingBot, noTeleportGenerics, { say() {} });
    await settleScheduledWork();

    assert.strictEqual(shoppingCompanionSession.plan, 'following', 'companion should resume following after its town errand');
    assert.strictEqual(shoppingCompanionSession.companionShopping, undefined, 'completed town errand should not leave a shopping state behind');
    assert.strictEqual(shoppingBot.moves.length, 1, 'companion should walk back to the player after its town errand');
    assert.deepStrictEqual(shoppingBot.moves[0].to, {
        locX: shoppingLeader.fetchLocX(), locY: shoppingLeader.fetchLocY(), locZ: shoppingLeader.fetchLocZ()
    });

    const youngShoppingBot = bot({ locX: -84081, locY: 243227, locZ: -3723, level: 10 });
    const youngShoppingSession = {
        plan: 'shopping',
        partyCompanion: true,
        followPlayerSession: { actor: shoppingLeader },
        companionShopping: { kind: 'restock_shots' },
        resumeAfterShopping: { plan: 'following', followPlayerSession: { actor: shoppingLeader } },
        dataSendToOthers() {}
    };
    publishTravelSession(youngShoppingSession, youngShoppingBot);
    ShoppingState.scheduleRestock(youngShoppingSession, youngShoppingBot, noTeleportGenerics, starterTownAi);
    await settleScheduledWork();
    assert.strictEqual(
        youngShoppingSession.plan,
        'getting_buffed',
        'an eligible hot companion should rebuff after shopping before returning to the party'
    );
    assert(youngShoppingSession.resumeAfterBuff?.townVisitKey, 'the post-shopping rebuff should retain its town-visit key');
    assert.strictEqual(youngShoppingBot.moves.length, 0, 'the companion should go to the guide before moving back to the player');

    const unreachableGuideBot = bot({ locX: -83800, locY: 243227, locZ: -3723 });
    const unreachableGuideTarget = { locX: -84081, locY: 243227, locZ: -3723 };
    const seededGuideApproach = {};
    const unreachableGuideDestination = TownNpcApproach.planOpen(
        seededGuideApproach,
        unreachableGuideBot,
        unreachableGuideTarget,
        'newbie_guide'
    ).destination;
    const unreachableGuideSession = {
        actor: unreachableGuideBot,
        plan: 'getting_buffed',
        partyCompanion: true,
        townNpcApproach: seededGuideApproach.townNpcApproach,
        townNpcSlot: seededGuideApproach.townNpcSlot,
        resumeAfterBuff: {
            plan: 'following',
            followPlayerSession: { actor: companionLeader, dataSendToMe() {} },
            partyCompanion: true,
            botStay: false,
            stayLocation: null,
            role: 'dps'
        },
        lastPathfinding: {
            requestedTo: unreachableGuideDestination,
            routeUsable: false,
            at: Date.now()
        }
    };
    unreachableGuideSession.companionNavigationRecovery = {
        key: CompanionNavigationRecovery.targetKey('newbie_guide', unreachableGuideSession.lastPathfinding.requestedTo),
        failures: CompanionNavigationRecovery.MAX_ROUTE_FAILURES - 1,
        lastFailureAt: 0,
        retryAt: 0
    };
    const unreachableGuideMessages = [];
    BotManager.botPartySay = function (session, text) {
        const sent = originalPartySay.call(this, session, text);
        if (sent) unreachableGuideMessages.push(text);
        return sent;
    };
    publishTravelSession(unreachableGuideSession, unreachableGuideBot);
    GettingBuffedState.tick(unreachableGuideSession, unreachableGuideBot, noTeleportGenerics, {
        getClosestNewbieGuide: () => ({ locX: -84081, locY: 243227, locZ: -3723 }),
        say() { throw new Error('companion coordination must use party delivery'); }
    });
    assert.strictEqual(unreachableGuideSession.plan, 'following', 'an exhausted guide route should return the companion to follow instead of hanging');
    assert.strictEqual(unreachableGuideSession.roleDecision.reason, 'newbie_guide_route_unreachable');
    assert(unreachableGuideMessages.some((text) => text.includes('retry later')), 'an exhausted guide route should be visible to the party');

    const unreachableShopTarget = {
        actorId: null,
        name: 'Giran general shop',
        locX: 1000,
        locY: 1000,
        locZ: -100,
        town: 'Giran'
    };
    const unreachableShopSession = {
        plan: 'shopping',
        partyCompanion: true,
        followPlayerSession: { actor: shoppingLeader },
        companionShopping: { kind: 'restock_shots' },
        resumeAfterShopping: { plan: 'following', followPlayerSession: { actor: shoppingLeader } },
        shoppingTarget: unreachableShopTarget,
        lastPathfinding: {
            requestedTo: unreachableShopTarget,
            routeUsable: false,
            at: Date.now()
        }
    };
    unreachableShopSession.companionNavigationRecovery = {
        key: CompanionNavigationRecovery.targetKey('shopping', unreachableShopTarget),
        failures: CompanionNavigationRecovery.MAX_ROUTE_FAILURES - 1,
        lastFailureAt: 0,
        retryAt: 0
    };
    const unreachableShopBot = bot({ locX: 0, locY: 0, locZ: -100 });
    const unreachableShopMessages = [];
    publishTravelSession(unreachableShopSession, unreachableShopBot);
    ShoppingState.tick(unreachableShopSession, unreachableShopBot, noTeleportGenerics, {
        say(_session, text) { unreachableShopMessages.push(text); },
        getClosestTown: () => ({ name: 'Dion', x: 1000, y: 1000, z: -100 })
    });
    assert.strictEqual(unreachableShopSession.plan, 'following',
        'unreachable shot shopping without a static seller must return to following');
    assert.strictEqual(unreachableShopSession.roleDecision.reason, 'shopping_route_unreachable',
        'ordinary NPC shops no longer provide a replacement shot route');

    // A solo hunter whose walk to town found no way does not set off again from the same
    // ground: not after the town pause would have ended, not ten minutes on. A scroll reads
    // at once, and other ground (another declared spot) walks again.
    {
        const BotTownTravel = invoke('GameServer/Bot/AI/BotTownTravel');
        const Response = invoke('GameServer/Network/Response');
        const realNow = Date.now;
        const realSkillStarted = Response.skillStarted;
        const t0 = realNow();
        const ground = { id: '20_13' };
        const target = { actorId: null, name: 'Giran general shop', locX: 1000, locY: 1000, locZ: -100, town: 'Giran' };
        const walker = bot({ locX: 30000, locY: 0, locZ: -100 });
        let casting = false;
        walker.state = { inMotion: () => false, setCasts(on) { casting = on; }, fetchCasts: () => casting };
        walker.isDead = () => false;
        const hunter = {
            plan: 'shopping', partyCompanion: false, currentSpot: ground, shoppingTarget: target,
            lastPathfinding: { requestedTo: target, routeUsable: false, at: t0 },
            companionNavigationRecovery: {
                key: CompanionNavigationRecovery.targetKey('shopping', target),
                failures: CompanionNavigationRecovery.MAX_ROUTE_FAILURES - 1, lastFailureAt: 0, retryAt: 0
            }
        };
        publishTravelSession(hunter, walker);
        // A hot body: its raises wait in its bag for the worker's answer.
        const realLife = { cachedState: LifeState.cachedState, nearPosts: LifeState.nearPosts, notifyNearFacts: LifeState.notifyNearFacts };
        LifeState.cachedState = () => ({ phase: 'hot' });
        LifeState.nearPosts = () => true;
        LifeState.notifyNearFacts = () => {};
        const town = { name: 'Giran', x: 1000, y: 1000, z: -100 };
        const ai = { say() {}, getClosestTown: () => town };
        try { ShoppingState.tick(hunter, walker, noTeleportGenerics, ai); } finally { Object.assign(LifeState, realLife); }
        assert.strictEqual(hunter.plan, 'hunting', 'a walk that found no way ends the visit');
        assert.strictEqual(hunter.nearRaise.names.filter(entry => entry.name === 'goal_failed:visit').length, 1,
            'and the failed visit is raised once');
        const reason = 'Heading to town for my planned improvement.';
        const ask = () => { walker.moves.length = 0; return BotTownTravel.request(hunter, walker, ai, reason); };
        global.setTimeout = () => 0;
        Response.skillStarted = () => Buffer.alloc(0);
        try {
            for (const later of [61000, 600000]) {
                Date.now = () => t0 + later;
                assert.strictEqual(ask(), 'deferred', `no walk to the same town again from the same ground after ${later} ms`);
                assert.strictEqual(walker.moves.length, 0, 'and no step is taken');
                assert.strictEqual(hunter.plan, 'hunting');
            }
            const scroll = { fetchAmount: () => 1, fetchId: () => 1 };
            walker.backpack = { fetchItemFromSelfId: id => id === 736 ? scroll : null, fetchItems: () => [], deleteItem() {} };
            assert.strictEqual(ask(), 'escape', 'a bot with a scroll reads it');
            walker.backpack = bot().backpack;
            hunter.plan = 'hunting';
            hunter.townEscape = undefined;
            casting = false;
            hunter.currentSpot = { id: '15_3' };
            assert.strictEqual(ask(), 'walk', 'from other ground it walks again');
        } finally {
            Date.now = realNow;
            global.setTimeout = originalSetTimeout;
            Response.skillStarted = realSkillStarted;
        }
    }

    // The same failure while the body stands in a town is an approach that failed there:
    // the town pause holds it and no walk hold is set.
    {
        const home = Object.values(invoke('GameServer/World/TownRespawn').towns)[0];
        const target = { actorId: null, name: 'Town shop', locX: home.locX + 800, locY: home.locY, locZ: home.locZ, town: home.name };
        const walker = bot({ locX: home.locX, locY: home.locY, locZ: home.locZ });
        walker.state = { inMotion: () => false, setCasts() {}, fetchCasts: () => false };
        walker.isDead = () => false;
        const inTown = {
            plan: 'shopping', partyCompanion: false, currentSpot: { id: '20_13' }, shoppingTarget: target,
            lastPathfinding: { requestedTo: target, routeUsable: false, at: Date.now() },
            companionNavigationRecovery: {
                key: CompanionNavigationRecovery.targetKey('shopping', target),
                failures: CompanionNavigationRecovery.MAX_ROUTE_FAILURES - 1, lastFailureAt: 0, retryAt: 0
            }
        };
        publishTravelSession(inTown, walker);
        const realLife = { cachedState: LifeState.cachedState, nearPosts: LifeState.nearPosts, notifyNearFacts: LifeState.notifyNearFacts };
        LifeState.cachedState = () => ({ phase: 'hot' });
        LifeState.nearPosts = () => true;
        LifeState.notifyNearFacts = () => {};
        try { ShoppingState.tick(inTown, walker, noTeleportGenerics, { say() {}, getClosestTown: () => ({ name: home.name, x: home.locX, y: home.locY, z: home.locZ }) }); }
        finally { Object.assign(LifeState, realLife); }
        assert.strictEqual(inTown.plan, 'hunting', 'a route that found no way ends the visit');
        assert(inTown.townTravelRetryAt > Date.now(), 'in a town the town pause holds');
        assert.strictEqual(inTown.townWalkFailed, undefined, 'and no walk hold is set');
    }

    const buyerTarget = {
        actorId: 9001,
        name: 'BuyerBot',
        locX: 9000,
        locY: 9000,
        locZ: -100,
        town: 'Giran'
    };
    const buyerFallbackSession = {
        plan: 'shopping',
        partyCompanion: true,
        followPlayerSession: { actor: shoppingLeader },
        companionShopping: { kind: 'sell_resources' },
        resumeAfterShopping: { plan: 'following', followPlayerSession: { actor: shoppingLeader } },
        shoppingTarget: buyerTarget,
        lastPathfinding: {
            requestedTo: buyerTarget,
            routeUsable: false,
            at: Date.now()
        }
    };
    buyerFallbackSession.companionNavigationRecovery = {
        key: CompanionNavigationRecovery.targetKey('shopping', buyerTarget),
        failures: CompanionNavigationRecovery.MAX_ROUTE_FAILURES - 1,
        lastFailureAt: 0,
        retryAt: 0
    };
    const buyerFallbackBot = bot({ locX: 0, locY: 0, locZ: -100 });
    publishTravelSession(buyerFallbackSession, buyerFallbackBot);
    ShoppingState.tick(buyerFallbackSession, buyerFallbackBot, noTeleportGenerics, {
        say() {},
        getClosestTown: () => ({ name: 'Giran', x: 1000, y: 1000, z: -100 })
    });
    assert.strictEqual(buyerFallbackSession.plan, 'shopping', 'an unreachable player buyer should fall back to the town shop');
    assert.strictEqual(buyerFallbackSession.shoppingTarget.actorId, null, 'buyer fallback should clear the unreachable player-store target');
    assert(buyerFallbackSession.shoppingTarget.npcSelfId,
        'buyer fallback should select a real catalogued Giran merchant instead of a synthetic town-center shop');
    assert.strictEqual(buyerFallbackSession.shoppingTarget.town, 'Giran');
    assert.strictEqual(buyerFallbackSession.shoppingTarget.serviceRole, 'generic_merchant');
    assert.notStrictEqual(buyerFallbackSession.shoppingTarget.title, 'Pet Manager');

    console.log('Bot travel realism checks passed');
} finally {
    BotManager.botPartySay = originalPartySay;
    BotManager.sessions = originalBotSessions;
    for (const session of [...published]) { World.removeUser(session); published.delete(session); }
    World.user = originalUsers;
    global.setTimeout = originalSetTimeout;
    ShotStock.planForActor = originalPlanForActor;
    ShotStock.shotAmount = originalShotAmount;
    ShotStock.purchaseActorRestock = originalPurchaseActorRestock;
    LifeState.hotRow = originalHotRow;
    NpcRestockPlan.purchaseForActor = originalPurchaseForActor;
    BotBuffs.applyFullNewbieBlessing = originalApplyFullNewbieBlessing;
    BotBuffs.needsNewbieRefresh = originalNeedsNewbieRefresh;
    fs.rmSync(isolated.directory, { recursive: true, force: true });
}

}
run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
