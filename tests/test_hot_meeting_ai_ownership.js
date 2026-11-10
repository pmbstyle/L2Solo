'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');
const AI = invoke('GameServer/Bot/BotAI');
const Travel = invoke('GameServer/Bot/AI/BotTownTravel');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Meetings = require('../src/GameServer/AfkTrade/TradeMeetingService');
const restores = [];
function stub(target, key, value) {
    const previous = target[key]; target[key] = value;
    restores.push(() => { target[key] = previous; });
}
let dead = false, defending = false, x = 0, aborts = 0, wakes = 0;
const moves = [], states = new Map();
const bot = { fetchId: () => 930041, isDead: () => dead,
    fetchLocX: () => x, fetchLocY: () => 0, fetchLocZ: () => 0,
    state: { fetchHits: () => false, fetchCasts: () => false, fetchDead: () => dead },
    automation: { abortAll() { aborts++; } }, moveTo(move) { moves.push(move); } };
const session = { actor: bot, accountId: 'bot_meeting_ai', plan: 'hunting',
    tradeMeetingPresence: { id: 7, actorId: bot.fetchId(), locX: 2000, locY: 0, locZ: 0 } };
const meeting = { id: 7, state: 'accepted', locX: 2000, locY: 0, locZ: 0,
    routeA: JSON.stringify({ method: 'meeting:7', scroll: false }), nextLegA: 1 };
states.set(bot.fetchId(), { characterId: bot.fetchId(), phase: 'hot', stats: { tradeMeeting: [7, 1] } });
function ordinaryTick() { session.plan = 'hunting'; AI.tick(session); }
(async () => {
    try {
        stub(Life, 'cachedState', id => states.get(id));
        stub(Meetings, 'wake', () => { wakes++; });
        const noops = {
            'GameServer/Bot/AI/BotClanChat': ['flush', 'onDeath'],
            'GameServer/Bot/Economy/BotTradeChat': ['flush'],
            'GameServer/Bot/AI/PendingSweep': ['prune'],
            'GameServer/Bot/Population/PopulationService': ['recordHotTick'],
            'GameServer/Bot/Population/BotGlobalChat': ['offerReply'],
            'GameServer/Bot/AI/HotBotPolicyOverlay': ['get', 'clearForDeath'],
            'GameServer/Bot/AI/BotPvpDefense': ['clear'],
            'GameServer/Bot/AI/TownNpcApproach': ['reset'],
            'GameServer/Bot/AI/TownTraffic': ['remove'],
            'GameServer/Bot/AI/BotAmbientDirector': ['cleanup'],
            'GameServer/Bot/BotTradeService': ['cleanup', 'activeTradeSummary'],
            'GameServer/Bot/AI/ClanAllianceSupportAI': ['tick'],
            'GameServer/Bot/Economy/BuffServiceChat': ['onDuty'],
            'GameServer/Bot/AI/ChatArrivalState': ['tick'],
            'GameServer/Bot/Economy/BuffService': ['buyOnAnswer'],
            'GameServer/Bot/AI/BotEquipmentUpgrade': ['applyBestUpgrades'],
            'GameServer/Bot/AI/PartyCompanionService': ['reconcileGroundLoot', 'startQueuedGroundPickup'],
            'GameServer/Bot/AI/BotChatReactions': ['offerLocal'],
            'GameServer/ClanHall/BotVisit': ['tick'],
            'GameServer/Bot/AI/HotResourceCompetition': ['tick'],
            'GameServer/Bot/Population/SurvivalFloor': ['forActor'],
            'GameServer/Bot/AI/DecisionEvents': ['observe'],
            'GameServer/Bot/AI/HotTownRebuff': ['syncVisit', 'needsVisit'],
            'GameServer/Bot/AI/TownChatter': ['say']
        };
        for (const [name, keys] of Object.entries(noops)) for (const key of keys) stub(invoke(name), key, () => undefined);
        stub(invoke('GameServer/Bot/AI/BotPvpDefense'), 'tick', () => defending);
        const lod = invoke('GameServer/Bot/AI/HotActorLodPolicy');
        const evaluate = lod.evaluate;
        stub(lod, 'evaluate', () => ({ tier: 'full', playerVisible: true }));
        stub(lod, 'shouldRefreshStatus', () => false);
        stub(lod, 'budgetExceeded', () => false);
        stub(invoke('GameServer/World/World'), 'actorPresenceCount', () => 1);
        stub(invoke('GameServer/Bot/AI/BotBuffs'), 'needsNewbieRefresh', () => true);
        // The meeting spot is far from every start village: place a guide in its town.
        stub(AI, 'getClosestNewbieGuide', () => ({ locX: 2000, locY: 0, locZ: 0 }));
        await Travel.requestMeeting(session, bot, meeting, 0);
        assert.equal(moves.at(-1).to.locX, 2000, 'actual meeting adapter starts its final walk');
        AI.tick(session); AI.tick(session);
        assert.equal(session.plan, 'hunting', 'the actual dispatcher must not let town rebuffing steal an accepted meeting');
        assert.equal(aborts, 0);
        assert.equal(wakes, 1, 'holding AI ticks must not poll native meeting transactions');
        x = 2000; AI.tick(session);
        assert.equal(aborts, 0, 'arrival still waits for the native settlement');
        defending = true; AI.tick(session);
        assert.equal(session.meetingAiHold, undefined, 'combat owns the tick before the meeting hold');
        defending = false; AI.tick(session);
        assert.equal(wakes, 2, 'combat recovery wakes the original event-driven route once');
        dead = true; session.deathTimerStart = Date.now(); AI.tick(session);
        assert.equal(session.meetingAiHold, undefined, 'death cannot be blocked by an accepted meeting');
        dead = false; AI.tick(session);
        assert.equal(wakes, 3);
        for (const outcome of ['completed', 'cancelled']) {
            states.get(bot.fetchId()).stats = {};
            session.tradeMeetingPresence = undefined;
            // Its rebuff answered the guide (Bot/AI/Rebuff): the hunt carries it out once the meeting ends.
            session.coldLifeState = { characterId: bot.fetchId(), stats: { tradeMeeting: [7, 1], rebuff: { via: 'guide', at: 1 } } };
            ordinaryTick();
            assert.equal(session.plan, 'getting_buffed', `${outcome} releases the real hunting rebuff path despite an old session snapshot`);
            states.get(bot.fetchId()).stats = { tradeMeeting: [7, 1] };
            ordinaryTick();
            assert.equal(session.plan, 'hunting');
        }
        const replaced = { ...bot };
        session.actor = replaced;
        AI.tick(session);
        assert.equal(session.meetingAiHold.actor, replaced, 'a retained connection holds only its current actor');
        let shoppingTicks = 0;
        stub(invoke('GameServer/Bot/AI/States/ShoppingState'), 'tick', () => { shoppingTicks++; });
        session.plan = 'shopping'; AI.tick(session);
        assert.equal(session.plan, 'shopping', 'the existing shopping result continuation keeps its plan');
        assert.equal(shoppingTicks, 0);
        states.get(bot.fetchId()).stats = {}; session.coldLifeState = undefined;
        session.tradeMeetingPresence = { id: 7, actorId: bot.fetchId() + 1 };
        AI.tick(session);
        assert.equal(shoppingTicks, 1, 'another character marker cannot hold the current actor');
        // A hot body out of the player's view but inside the radius bodies stay hot in hunts on out of
        // combat (the cold simulation does not step it); past that radius it only waits to cool.
        let huntTicks = 0;
        stub(invoke('GameServer/Bot/AI/States/HuntingState'), 'tick', () => { huntTicks++; });
        session.tradeMeetingPresence = undefined;
        lod.evaluate = evaluate;
        let playerDistance = 7000;
        stub(invoke('GameServer/World/World'), 'nearestRealPlayer', () => ({ session: null, distance: playerDistance, count: 1 }));
        session.plan = 'hunting'; AI.tick(session);
        assert.equal(huntTicks, 1, 'an unseen body 7000 from the player hunts out of combat');
        playerDistance = 12000;
        session.plan = 'hunting'; AI.tick(session);
        assert.equal(huntTicks, 1, 'a body beyond the keep radius does not hunt');
        console.log('PASS hot meeting AI ownership: walk, arrival wait, completion/cancellation, combat/death priority, actor binding and shopping continuation');
    } finally { for (const restore of restores.reverse()) restore(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
