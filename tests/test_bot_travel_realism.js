const assert = require('assert');

require('../src/Global');

const ShoppingState = invoke('GameServer/Bot/AI/States/ShoppingState');
const GettingBuffedState = invoke('GameServer/Bot/AI/States/GettingBuffedState');
const CompanionNavigationRecovery = invoke('GameServer/Bot/AI/CompanionNavigationRecovery');
const ShotStock = invoke('GameServer/Inventory/ShotStock');
const BotBuffs = invoke('GameServer/Bot/AI/BotBuffs');
const HotTownRebuff = invoke('GameServer/Bot/AI/HotTownRebuff');
const TownNpcApproach = invoke('GameServer/Bot/AI/TownNpcApproach');

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
        state: {
            inMotion: () => false
        },
        fetchId: () => loc.actorId ?? 2000099,
        fetchName: () => 'TravelBot',
        fetchLevel: () => loc.level ?? 21,
        fetchKarma: () => loc.karma ?? 0
    };
}

const originalSetTimeout = global.setTimeout;
const originalPlanForActor = ShotStock.planForActor;
const originalShotAmount = ShotStock.shotAmount;
const originalPurchaseActorRestock = ShotStock.purchaseActorRestock;
const originalApplyFullNewbieBlessing = BotBuffs.applyFullNewbieBlessing;
const originalNeedsNewbieRefresh = BotBuffs.needsNewbieRefresh;

try {
    global.setTimeout = (fn) => {
        fn();
        return 0;
    };

    ShotStock.planForActor = () => ({ selfId: 1835, price: 1, kind: 'soulshot', rank: 'none', name: 'Soulshot: No Grade' });
    ShotStock.shotAmount = () => 0;
    ShotStock.purchaseActorRestock = () => Promise.resolve({ ok: true, delta: 10, cost: 10 });

    const shopper = bot({ locX: 1000, locY: 1000, locZ: -100 });
    const shoppingSession = {
        preShopLocation: { locX: 2000, locY: 2100, locZ: -120 },
        partyCompanion: false,
        dataSendToOthers() {}
    };
    const noTeleportGenerics = {
        teleportTo() {
            throw new Error('shopping return should move instead of teleporting');
        }
    };

    ShoppingState.scheduleRestock(shoppingSession, shopper, noTeleportGenerics, { say() {} });
    assert.strictEqual(shopper.moves.length, 0, 'solo shopping must let hunting route through the town gatekeeper');
    assert.strictEqual(shoppingSession.preShopLocation, undefined);
    assert.strictEqual(shoppingSession.pendingFarmDepartureAnnouncement, true,
        'the next hunting-ground decision should announce a clear farming destination');

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
    GettingBuffedState.tick(townVisitSession, townVisitBot, noTeleportGenerics, starterTownAi);
    assert.strictEqual(townVisitBot.moves.length, 1, 'the guide visit should use one direct open-air approach');
    Object.assign(townVisitBot, townVisitBot.moves[0].to);
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
    GettingBuffedState.tick(edgeGuideSession, edgeGuideBot, noTeleportGenerics, {
        getClosestNewbieGuide: () => ({ locX: -84081, locY: 243227, locZ: -3723 }),
        say() {}
    });
    assert.strictEqual(edgeGuideSession.plan, 'getting_buffed',
        'a bot outside close interaction range should approach the guide before receiving buffs');
    assert.strictEqual(edgeGuideBot.moves.length, 1,
        'the guide approach should stop near the NPC instead of buffing from the old wide radius');
    Object.assign(edgeGuideBot, edgeGuideBot.moves[0].to);
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
    GettingBuffedState.tick(deathRecoverySession, deathRecoveryBot, recoveryGenerics, {
        getClosestNewbieGuide: () => ({ locX: -84081, locY: 243227, locZ: -3723 }),
        say() {}
    });
    assert.strictEqual(recoveryTeleports.length, 1, 'an overleveled companion should skip the Newbie Guide and teleport back');
    assert.strictEqual(deathRecoverySession.plan, 'getting_buffed', 'the recovery state should remain active until the return teleport settles');
    deathRecoverySession.resumeAfterBuff.returnTeleportStartedAt = Date.now() - 2000;
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
    GettingBuffedState.tick(lowLevelRecoverySession, lowLevelRecoveryBot, {
        teleportTo(_session, _actor, target) { lowLevelRecoveryTeleports.push(target); }
    }, {
        getClosestNewbieGuide: () => ({ locX: -84081, locY: 243227, locZ: -3723 }),
        say() {}
    });
    assert.strictEqual(recoveryBuffsApplied, 1, 'an eligible dead companion should refresh cleared Newbie Guide buffs before returning');
    assert.strictEqual(lowLevelRecoveryTeleports.length, 1, 'the rebuffed companion should teleport back instead of walking across the world');

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
    ShoppingState.scheduleRestock(shoppingCompanionSession, shoppingBot, noTeleportGenerics, { say() {} });

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
    ShoppingState.scheduleRestock(youngShoppingSession, youngShoppingBot, noTeleportGenerics, starterTownAi);
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
        plan: 'getting_buffed',
        partyCompanion: true,
        townNpcApproach: seededGuideApproach.townNpcApproach,
        resumeAfterBuff: {
            plan: 'following',
            followPlayerSession: { actor: companionLeader },
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
    GettingBuffedState.tick(unreachableGuideSession, unreachableGuideBot, noTeleportGenerics, {
        getClosestNewbieGuide: () => ({ locX: -84081, locY: 243227, locZ: -3723 }),
        say(_session, text) { unreachableGuideMessages.push(text); }
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
    ShoppingState.tick(unreachableShopSession, unreachableShopBot, noTeleportGenerics, {
        say(_session, text) { unreachableShopMessages.push(text); },
        getClosestTown: () => ({ name: 'Dion', x: 1000, y: 1000, z: -100 })
    });
    assert.strictEqual(unreachableShopSession.plan, 'following', 'an exhausted shop route should return the companion to follow');
    assert.strictEqual(unreachableShopSession.companionShopping, undefined, 'an exhausted shop route should not leave a stale shopping plan');
    assert.strictEqual(unreachableShopSession.roleDecision.reason, 'shopping_route_unreachable');
    assert(unreachableShopMessages.some((text) => text.includes('retry later')), 'an exhausted shop route should be visible to the party');

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
    ShoppingState.tick(buyerFallbackSession, buyerFallbackBot, noTeleportGenerics, {
        say() {},
        getClosestTown: () => ({ name: 'Giran', x: 1000, y: 1000, z: -100 })
    });
    assert.strictEqual(buyerFallbackSession.plan, 'shopping', 'an unreachable player buyer should fall back to the town shop');
    assert.strictEqual(buyerFallbackSession.shoppingTarget.actorId, null, 'buyer fallback should clear the unreachable player-store target');
    assert.strictEqual(buyerFallbackSession.shoppingTarget.name, 'Giran general shop');

    console.log('Bot travel realism checks passed');
} finally {
    global.setTimeout = originalSetTimeout;
    ShotStock.planForActor = originalPlanForActor;
    ShotStock.shotAmount = originalShotAmount;
    ShotStock.purchaseActorRestock = originalPurchaseActorRestock;
    BotBuffs.applyFullNewbieBlessing = originalApplyFullNewbieBlessing;
    BotBuffs.needsNewbieRefresh = originalNeedsNewbieRefresh;
}
