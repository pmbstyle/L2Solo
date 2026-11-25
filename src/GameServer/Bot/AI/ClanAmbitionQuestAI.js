const Rules = require('../../Clan/ClanAmbitionRules');
const posture = invoke('GameServer/Actor/Generics/Posture');
const ClanRules = require('../../Clan/ClanRules');
const NpcIndex = require('../../World/NpcObjectIndex');
const Service = invoke('GameServer/Clan/ClanAmbitionService');
const { ITEM, MOB, NPC } = Rules;
const MANAGER = 7191; // High Priest Hollint's Oren dialog offers clan services.
const NPC_STEPS = { 1: 'meet_martien', 3: 'second', 4: 'meet_smith', 6: 'third', 7: 'meet_rodemai',
    8: 'riddle', 9: 'cemetery', 11: 'return_scepter', 12: 'finish' };
const world = () => invoke('GameServer/World/World');
const moves = () => invoke('GameServer/Bot/AI/ClanAllianceQuestAI');
const activationRetry = new Map();
const pendingActivations = new Map();
const transientActivationRefusals = new Set([
    'in_transit', 'activation_pending', 'player_invite_pending', 'cold_pvp_settling',
    'party_transition_pending', 'party_not_ready', 'no_safe_activation_placement',
    'activation_prepare_failed', 'craft_recipe_sync_failed',
    'encounter_transition_pending', 'encounter_not_ready', 'encounter_fence_failed', 'encounter_changed',
    'encounter_no_safe_placement', 'encounter_spawn_failed', 'encounter_expired_during_spawn'
]);
const COST = ClanRules.LEVEL_REQUIREMENTS[4].sp;

function nearest(bot, npcs) {
    let target = null;
    let distance = Infinity;
    for (const npc of npcs) {
        if (npc.isDead?.() || npc.fetchHp?.() <= 0) continue;
        const proximity = Service.distance(bot, npc);
        if (proximity >= distance) continue;
        target = npc;
        distance = proximity;
    }
    return target;
}

function talk(bot, event, target = nearest(bot, NpcIndex.ofTemplate(world(), Rules.TALK[event].npc))) {
    return { event, target };
}

function hunt(bot, ids) {
    const candidates = ids.flatMap(id => [...NpcIndex.ofTemplate(world(), id)]).filter(npc => !npc.questSpawn);
    return { target: nearest(bot, candidates) };
}

function nextAction(session, bot, state, items) {
    const owned = kind => nearest(bot, Service.encounters(session, state.attempt, kind));
    if (Rules.count(items, ITEM.seal)) return bot.fetchSp() >= COST
        ? { event: 'raise', target: nearest(bot, NpcIndex.ofTemplate(world(), MANAGER)) } : null;
    const cond = state.cond || 0;
    if (cond === 13) return talk(bot, 'restore_seal');
    if (NPC_STEPS[cond]) return talk(bot, NPC_STEPS[cond]);
    if (cond === 0) return talk(bot, 'start');
    if (cond === 2) {
        const missing = Rules.EGGS.filter(([id, amount]) => Rules.count(items, id) < amount);
        if (!missing.length) return talk(bot, 'eggs');
        const farming = missing.flatMap(([id]) => id === ITEM.thunder ? [MOB.thunder] : id === ITEM.drake ? [MOB.drake] : []);
        if (farming.length) return hunt(bot, farming);
        for (const [event, corpse] of Object.entries(Rules.CORPSES)) {
            if (state[event]?.kills >= (corpse.ambush || 0)) continue;
            const blitz = owned(event);
            return blitz ? { target: blitz } : talk(bot, event);
        }
        return null;
    }
    if (cond === 5) return Rules.has(items, Rules.GOLEM) ? talk(bot, 'research') : hunt(bot, [MOB.soldier, MOB.scout]);
    if (cond === 10) {
        if (Rules.count(items, ITEM.key) < Rules.KEYS) {
            const keymaster = owned('keymaster');
            return keymaster ? { target: keymaster } : hunt(bot, [MOB.guard]);
        }
        const coffer = owned('coffer');
        return coffer ? talk(bot, 'coffer', coffer) : hunt(bot, [MOB.keeper]);
    }
    return null;
}

function request(session, work) {
    session.clanAmbitionPending = true;
    Promise.resolve().then(work).then(result => {
        if (result?.ok === false) session.clanAmbitionRetryAt = Date.now() + 5000;
    }).catch(error => {
        session.clanAmbitionRetryAt = Date.now() + 5000;
        utils.infoWarn('ClanQuest', 'ambition step failed: %s', error.message);
    }).finally(() => { session.clanAmbitionPending = false; });
}

function release(session) {
    if (!session.clanAmbitionActive) return;
    session.clanAmbitionActive = false;
    session.clanAmbitionRecovering = false;
    session.currentTargetId = null;
    if (String(session.spotRelocation?.spotId).startsWith('ambition-'))
        invoke('GameServer/Bot/AI/BotSpotTravel').cancel(session, session.actor, 'clan_ambition_ended');
}

function tick(session, bot, Generics, ai) {
    if (!Service.eligible(session) || bot.fetchLevel() < Rules.BOT_MIN_LEVEL || session.partyCompanion
        || session.followPlayerSession || session.clanCommandParty?.active || session.supplyErrandPhase || session.clanHallVisit
        || session.activeTrade || session.activeNegotiation || session.plan === 'merchant') {
        release(session);
        return false;
    }
    if (session.clanAmbitionPending || session.clanAmbitionRetryAt > Date.now()) return !!session.clanAmbitionActive;
    if (!session.questStatesLoaded) {
        request(session, () => invoke('GameServer/Quest/QuestService').ensureLoaded(session));
        return false;
    }
    const state = Service.state(session);
    const step = nextAction(session, bot, state, Service.inventoryCounts(session));
    if (!step) {
        release(session);
        return false;
    }
    session.clanAmbitionActive = true;
    const threat = invoke('GameServer/Bot/AI/PartyAwareness').npcThreateningActor(session, 1200);
    const target = threat || step.target;
    if (!target) return true;
    const fighting = !!threat || !step.event;
    const hp = bot.fetchHp() / bot.fetchMaxHp();
    const mp = bot.fetchMp() / bot.fetchMaxMp();
    const mana = fighting && invoke('GameServer/Bot/AI/BotRoles').shouldRestForMana(bot);

    if (!threat && (hp < 0.35 || mana && mp < 0.2
        || session.clanAmbitionRecovering && (hp < 0.85 || mana && mp < 0.8))) {
        session.clanAmbitionRecovering = true;
        session.currentTargetId = null;
        posture(session, bot, true);
        bot.automation.replenishVitals(bot);
        return true;
    }
    session.clanAmbitionRecovering = false;
    posture(session, bot, false);
    if (!threat && (session.spotRelocation || !fighting || Service.distance(bot, target) > 1200)) {
        if (!moves().move(session, target, String(target.fetchSelfId()), 'ambition')) return true;
    }
    if (fighting) {
        session.currentTargetId = target.fetchId();
        ai.executeCombat(session, bot, target, Generics);
    } else {
        session.currentTargetId = null;
        request(session, () => step.event === 'raise' ? Service.raise(session) : Service.event(session, step.event, target));
    }
    return true;
}

async function requestLeader(clan) {
    const id = Number(clan.leaderId);
    const leader = clan.members.find(member => Number(member.characterId) === id);
    if (!leader || leader.level < Rules.BOT_MIN_LEVEL || !String(leader.accountName).startsWith('bot_')) return;
    const life = invoke('GameServer/Bot/Population/BotLifeState').cachedState(id);
    if (life?.phase !== 'cold') {
        activationRetry.delete(id);
        return;
    }
    const sealHeld = Object.values(leader.inventory || {}).some(item => Number(item.selfId) === ITEM.seal);
    if (sealHeld && life.sp < COST) return;
    const dueAt = activationRetry.get(id);
    if (dueAt > Date.now()) return dueAt;
    activationRetry.delete(id);
    const retryLater = () => {
        const next = Date.now() + invoke('GameServer/Clan/ClanSimulationConfig').actionRetryMs;
        activationRetry.set(id, next);
        return next;
    };
    if (life.stats?.playerPartyTakeover || life.stats?.tradeMeeting) return retryLater();
    if (pendingActivations.has(id)) return pendingActivations.get(id);
    const pending = invoke('GameServer/Bot/Population/PopulationService').requestActivation(life, 'clan_ambition')
        .then(result => result?.ok === false && transientActivationRefusals.has(result.reason) ? retryLater() : undefined)
        .finally(() => pendingActivations.delete(id));
    pendingActivations.set(id, pending);
    return pending;
}

module.exports = { tick, requestLeader };
