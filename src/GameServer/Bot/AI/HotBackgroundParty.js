const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
const World = invoke('GameServer/World/World');
const Threats = invoke('GameServer/Bot/AI/BotPvpThreats');
const Restrictions = invoke('GameServer/Effects/EffectRestrictions');
const Tactics = invoke('GameServer/Bot/AI/BotPvpTactics');
const SummonerTactics = invoke('GameServer/Bot/AI/SummonerTactics');
const RestPolicy = invoke('GameServer/Bot/AI/RestPolicy');
const Support = invoke('GameServer/Bot/AI/BotSupportPlanner');
const HuntingVisibility = invoke('GameServer/Bot/AI/BotHuntingVisibility');
const Spots = invoke('GameServer/Bot/AI/SpotService');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const SpotTravel = invoke('GameServer/Bot/AI/BotSpotTravel');
const TownTransit = invoke('GameServer/Bot/AI/TownTransitPolicy');
const TargetMatchup = invoke('GameServer/Bot/AI/BotTargetMatchup');
const BotPullEstimate = invoke('GameServer/Bot/AI/BotPullEstimate');
const Awareness = invoke('GameServer/Bot/AI/PartyAwareness');
const Diagnostics = invoke('GameServer/Bot/Economy/EconomyDiagnostics');
const NpcObjectIndex = require('../../World/NpcObjectIndex');
// The cold party resolver's target rule: one answer for hot and cold parties.
const PartyTarget = invoke('GameServer/Bot/Population/PartyHuntingTarget');

const RaidCombat = invoke('GameServer/Bot/AI/PartyRaidCombat');
const RAID_PREPARATION_SETTLE_MS = 1500;
const RAID_RECOVERY_BUFF_WAIT_MS = 8000;

function roster(session) {
    const party = session?.hotBackgroundPartyId && Parties.find(session.hotBackgroundPartyId);
    if (party?.status !== 'hot' || session.partyCompanion) return [];
    return party.memberIds.map(id => {
        const registered = World.registeredActorById(id);
        const session = registered?.session;
        return registered?.actor && registered.actor.fetchId() === id && session.hotBackgroundPartyId === party.partyId
            && !session.partyCompanion ? session : null;
    }).filter(Boolean);
}

function leader(session) {
    const party = Parties.find(session?.hotBackgroundPartyId);
    return roster(session).find(s => s.actor.fetchId() === party?.leaderId) || session;
}

const loc = actor => ({ locX: actor.fetchLocX(), locY: actor.fetchLocY(), locZ: actor.fetchLocZ() });
const ratio = (value, max) => Number(value || 0) / Math.max(1, Number(max || 0));

const standForAction = RaidCombat.standForAction;

const combatRaidBuffs = RaidCombat.combatRaidBuffs;

function prepareBuffs(session, owner, members, Generics, now, options = {}) {
    // Finish one native cast/approach before electing another provider. This
    // also prevents two party auras reserving different targets in one group.
    const pending = members.find(s => s.activeSupportCast && s.actor.state.fetchCasts?.()
        || Number(s.pendingSupportCast?.expiresAt || 0) > now);
    const recipients = members.map(s => ({ actor: s.actor, leader: s === owner }));
    const providers = members.filter(s => !s.pendingPathRequest && Restrictions.canCast(s.actor)).map(s => s.actor);
    const action = pending ? null : Support.nextPartyAction(recipients, providers, options);
    if (!pending && !action) return false;
    if (action?.provider === session.actor) {
        const bot = session.actor;
        Tactics.stop(session, bot);
        if (bot.state.fetchSeated()) {
            bot.state.setSeated(false);
            session.dataSendToOthers(invoke('GameServer/Network/Response').sitAndStand(bot), bot);
        }
        session.currentTargetId = action.target.fetchId();
        bot.select({ id: action.target.fetchId() });
        Support.queueSupportCast(session, action);
        Generics.skillExec(session, bot, { id: action.target.fetchId(), selfId: action.skill.fetchSelfId(), ctrl: false });
        session.lastDecision = { action: 'party_buff', skillId: action.skill.fetchSelfId(),
            targetId: action.target.fetchId(), effect: action.effect, at: now };
    } else {
        session.lastDecision = { action: 'party_wait_buffs', providerId: pending?.actor.fetchId() || action.provider.fetchId(), at: now };
    }
    return true;
}

function raidResourcesReady(member) {
    const actor = member.actor;
    return RestPolicy.raidReady(actor, { hp: actor.fetchHp(), maxHp: actor.fetchMaxHp(),
        mp: actor.fetchMp(), maxMp: actor.fetchMaxMp() });
}

function holdForRaidRecovery(session, owner, members, now) {
    if (members.every(raidResourcesReady)) return false;
    owner.backgroundHuntTarget = null;
    owner.raidPreparationReadyAt = 0;
    owner.raidPreparationComplete = false;
    const actor = session.actor;
    Tactics.stop(session, actor);
    session.currentTargetId = undefined;
    actor.unselect?.();
    if (!actor.state.fetchSeated()) {
        actor.state.setSeated(true);
        session.dataSendToOthers(invoke('GameServer/Network/Response').sitAndStand(actor), actor);
    }
    actor.automation.replenishVitals(actor);
    session.lastDecision = { action: 'raid_recovery', partyId: session.hotBackgroundPartyId, at: now };
    return true;
}

function holdForRaidPreparation(session, owner, members, Generics, now, requireRecovery = false) {
    // Preparation is a party-wide barrier. A short gap between two casts must
    // not let one member select the boss and permanently bypass the remaining
    // buffs. Keep the shared target empty until the complete roster has been
    // together and the support planner has remained empty for a stable window.
    owner.backgroundHuntTarget = null;
    if (members.some((member) => Threats.distance(member.actor, owner.actor) > 700)) {
        owner.raidPreparationReadyAt = 0;
        Tactics.stop(session, session.actor);
        session.currentTargetId = undefined;
        session.actor.unselect?.();
        session.lastDecision = { action: 'raid_prepare_regroup', partyId: session.hotBackgroundPartyId, at: now };
        return true;
    }

    if (prepareBuffs(session, owner, members, Generics, now, { partyMusicLast: true })) {
        owner.raidPreparationReadyAt = 0;
        return true;
    }

    const recipients = members.map((member) => ({ actor: member.actor, leader: member === owner }));
    const providers = members.map((member) => member.actor).filter(Boolean);
    if (Support.hasPendingAction(recipients, providers)) {
        owner.raidPreparationReadyAt = 0;
        Tactics.stop(session, session.actor);
        session.currentTargetId = undefined;
        session.actor.unselect?.();
        session.lastDecision = { action: 'raid_wait_buffs', partyId: session.hotBackgroundPartyId, at: now };
        return true;
    }

    if (requireRecovery && holdForRaidRecovery(session, owner, members, now)) return true;

    if (!Number(owner.raidPreparationReadyAt || 0)) {
        owner.raidPreparationReadyAt = now + RAID_PREPARATION_SETTLE_MS;
    }
    if (now < owner.raidPreparationReadyAt) {
        Tactics.stop(session, session.actor);
        session.currentTargetId = undefined;
        session.actor.unselect?.();
        session.lastDecision = { action: 'raid_wait_preparation', readyAt: owner.raidPreparationReadyAt,
            partyId: session.hotBackgroundPartyId, at: now };
        return true;
    }

    owner.raidPreparationComplete = true;
    owner.raidPreparationReadyAt = 0;
    return false;
}

function partySpot(party) {
    return Spots.findById(party.spotId) || SpotProfiles.findById(party.spotId);
}

// A member returning from town or a player party uses the normal spot travel,
// beside the member who leads there when one does (a lone landing among the
// spot's mobs is a fight without the party); a refused travel (retry cooldown)
// idles, it never walks to the leader. A target held from before
// would read as a fight and cancel the travel (BotTownTravel.hasCombatThreat).
function returnToSpot(session, bot, spot, party, now, destination = null) {
    if (session.currentTargetId) {
        Tactics.stop(session, bot);
        session.currentTargetId = undefined;
        bot.unselect?.();
    }
    if (session.spotRelocation) SpotTravel.tick(session, bot);
    else SpotTravel.start(session, bot, spot, destination);
    session.lastDecision = { action: 'party_return_to_spot', partyId: party.partyId, spotId: spot.id, at: now };
}

function searchGround(session, owner, members, party, legal, now, present) {
    const bot = session.actor;
    if (session !== owner) {
        session.lastDecision = { action: 'party_wait', partyId: party.partyId, at: now };
        return;
    }
    // Do not start another pull while the group is still catching up. A member
    // away from the spot (restarted in town) is not waited for.
    if (members.some(s => present(s) && Threats.distance(s.actor, bot) > 1000)) {
        if (session.backgroundSearchDestination) Tactics.stop(session, bot);
        session.backgroundSearchDestination = null;
        session.lastDecision = { action: 'party_wait_roster', partyId: party.partyId, at: now };
        return;
    }
    if (bot.state.fetchHits?.() || bot.state.fetchCasts?.() || !Restrictions.canMove(bot)) return;
    if (session.pendingPathRequest || bot.state.fetchTowards?.()) return;
    session.backgroundSearchDestination = null;
    session.lastDecision = { action: 'party_search_wait', partyId: party.partyId, at: now };
    if (now < Number(session.nextBackgroundSearchAt || 0)) return;
    session.nextBackgroundSearchAt = now + 5000;

    const Geo = invoke('GameServer/Geodata/GeodataEngine');
    const spot = partySpot(party);
    if (!spot) return;
    const origin = loc(bot);
    const npcId = PartyTarget.npcId(party, owner.coldLifeState);
    const distance = point => Math.hypot(point.locX - origin.locX, point.locY - origin.locY);
    const usable = point => point && ['locX', 'locY', 'locZ'].every(k => Number.isFinite(point[k]))
        && distance(point) > 600 && distance(point) <= 4500
        && Spots.findCurrentSpot(point)?.id === spot.id;
    // One wider query per idle leader, not per member or combat tick. Empty
    // spawn locations also let the party explore while monsters are respawning.
    const profiles = TargetMatchup.actorProfiles(members.filter(s => present(s)
        && Threats.distance(s.actor, bot) <= 1800).map(s => s.actor));
    const candidates = World.fetchNpcsInRadius(origin.locX, origin.locY, 4500).filter(legal);
    const unsafe = new Set(candidates.filter(npc => !Parties.raidBossKey(party) && !TargetMatchup.soloSurvival(profiles,
        BotPullEstimate.pullView(TargetMatchup.targetView(npc), Spots.pullSizeFor(npc))).eligible));
    const monsters = candidates.filter(npc => !unsafe.has(npc))
        .map(n => ({ ...loc(n), npcId: n.fetchSelfId() })).filter(usable)
        .sort((a, b) => Number(b.npcId === npcId) - Number(a.npcId === npcId) || distance(a) - distance(b));
    const points = [...monsters, ...(spot.arrivalPoints || []).filter(usable)
        .filter(point => ![...unsafe].some(npc => Math.hypot(point.locX - npc.fetchLocX(), point.locY - npc.fetchLocY()) < 700
            && Math.abs(point.locZ - npc.fetchLocZ()) < 500)).sort((a, b) => distance(a) - distance(b))];
    const recent = session.backgroundSearchHistory || (session.backgroundSearchHistory = new Map());
    for (const [key, at] of recent) if (now - at >= 30000) recent.delete(key);
    let checks = 0;
    for (const point of points) {
        const key = `${Math.round(point.locX / 128)}:${Math.round(point.locY / 128)}`;
        if (recent.has(key)) continue;
        if (++checks > 8) break;
        recent.set(key, now);
        while (recent.size > 8) recent.delete(recent.keys().next().value);
        const cell = Geo.getCellData(point.locX, point.locY, point.locZ);
        // Spawn Z can differ from the terrain. Walk on the actual surface;
        // the native route must still reach this floor without teleporting.
        if (!cell.nswe || !Number.isFinite(cell.z) || Math.abs(cell.z - origin.locZ) >= 500) continue;
        const to = { locX: point.locX, locY: point.locY, locZ: cell.z };
        // Exploration must not reintroduce an unseen monster as a movement
        // goal after the combat scan rejected it through a wall.
        if (!Geo.hasLineOfSight(origin.locX, origin.locY, origin.locZ, to.locX, to.locY, to.locZ)) continue;
        session.backgroundSearchDestination = to;
        session.lastDecision = { action: 'party_search', partyId: party.partyId, destination: to, at: now };
        // Native bounded pathfinding still owns movement to the visible
        // point. A failed route leaves the next search to try another one.
        bot.moveTo({ from: origin, to });
        return;
    }
}

function tick(session, bot, Generics, AI, now = Date.now()) {
    const party = Parties.find(session.hotBackgroundPartyId);
    if (!party) return false;
    if (session.pendingSupportCast && Number(session.pendingSupportCast.expiresAt || 0) <= now
        && !bot.state.fetchCasts?.()) Support.cancelSupportCast(session, bot);
    if (session.hotHuntReview && !Awareness.npcThreateningActor(session)) return true;
    if (session.raidFailurePendingAt) {
        Tactics.stop(session, bot);
        session.currentTargetId = undefined;
        bot.unselect?.();
        session.lastDecision = { action: 'raid_failure_pending', partyId: party.partyId, at: now };
        return true;
    }
    if (party.stats?.raidEncounter?.status === 'failed') {
        const RaidSafety = invoke('GameServer/Bot/AI/BotRaidSafety');
        const objective = party.stats?.objective;
        const boss = invoke('GameServer/World/RaidEntityIndex').bossByTemplateId(
            World,
            Number(objective?.raidBossTemplateId || objective?.npcId || 0)
        );
        if (!session.hotRaidFailureAt) {
            session.hotRaidFailureAt = Number(party.stats.raidEncounter.failedAt || now);
            if (boss) RaidSafety.retreat(session, bot, boss, { distance: 2200 });
        }
        // Let the ordinary fleeing state finish the visible movement. Once it
        // has completed, hold the survivor idle until the atomic party
        // cooldown dissolves the failed raid.
        if (session.plan === 'fleeing') return false;
        Tactics.stop(session, bot);
        session.currentTargetId = undefined;
        bot.unselect?.();
        session.lastDecision = { action: 'raid_failed_wait', partyId: party.partyId, at: now };
        return true;
    }
    if (session.hotRaidCasualtyAt) {
        Tactics.stop(session, bot);
        session.currentTargetId = undefined;
        bot.unselect?.();
        session.lastDecision = { action: 'raid_casualty_out', partyId: party.partyId, at: now };
        return true;
    }
    const members = roster(session).filter(s => Threats.alive(s.actor) && !s.hotRaidCasualtyAt);
    if (!members.length) return true;
    if (party.stats?.warOperation && require('../../Clan/ClanWarConfig').enabled
        && !session.pvpDefense && !session.pvpRevenge && !session.pvpEncounter && !Awareness.npcThreateningActor(session)) {
        const owner = leader(session) || members[0];
        if (prepareBuffs(session, owner, members, Generics, now)) return true;
        if (Tactics.support(session, bot, { owner, members, threats: [] }, Generics, now)) return true;
        return invoke('GameServer/Bot/AI/BotClanWarOperation').tick(session, bot, party, now);
    }
    // The party is anchored on its spot (raid parties keep the clan raid's own roster rules): the
    // leader leads while at the spot, otherwise the first member at it; a member restarted in town
    // is neither waited for nor followed.
    const raidObjective = party.stats?.objective?.sourceKind === 'raid'
        || party.stats?.objective?.raidBoss === true;
    const spot = party.spotId && !raidObjective ? partySpot(party) : null;
    const present = s => !spot || Spots.containsLocation(spot, loc(s.actor));
    for (const member of members) {
        const destination = member.backgroundPartyReturn;
        if (destination && (destination.partyId !== party.partyId || destination.spotId !== spot?.id || present(member))) {
            delete member.backgroundPartyReturn;
        }
    }
    const returning = s => !!s.backgroundPartyReturn;
    const returnPending = members.some(returning);
    const radius = 1800;
    // Partial arrivals split the roster across the map. Defend the members
    // beside this actor before following an owner already at the farm spot.
    const returnGroup = returnPending ? members.filter(s => Threats.distance(s.actor, bot) <= radius) : null;
    const returnIncoming = returnGroup?.map(s => Awareness.npcThreateningActor(s)).find(Boolean);
    // Returning player companions are away even in the field. An ordinary
    // leader stepping over the cell edge in a fight keeps its target and scan.
    // The bot's own town test is read once per tick (the town return below needs it again).
    let ownTown;
    const inTown = s => s === session ? (ownTown ??= !!TownTransit.townAt(s.actor)) : !!TownTransit.townAt(s.actor);
    const away = s => !!spot && !present(s) && (returning(s) || !!s.spotRelocation || inTown(s));
    const leading = members.find(s => s.actor.fetchId() === party.leaderId);
    // The leader stays the owner unless away; then the first member at the spot, else the first not away.
    const owner = returnIncoming ? returnGroup.find(s => s === leading) || returnGroup[0]
        : leading && !away(leading) ? leading
        : members.find(present) || members.find(s => !away(s)) || leading || members[0];
    const Roster = require('../../Clan/ClanRaidRoster');
    if (Roster.markerFor(party) && !Roster.held(party)) {
        const registered = roster(session);
        const marker = Roster.markerFor(party);
        const Lifecycle = invoke('GameServer/Bot/Population/HotPartyLifecycle');
        if (Roster.admitted(party) && Roster.nativeHotStarted(party)) {
            Lifecycle.confirmMarkedRaidStart(party, registered, now).catch(() => {});
            return true;
        }
        if (!Roster.exact(registered.map(member => Number(member.actor.fetchId())), marker.memberIds)
            || members.length !== 9 || members.some(member => Threats.distance(member.actor, owner.actor) > 700)) {
            Tactics.stop(session, bot); bot.unselect?.(); session.currentTargetId = undefined;
            session.lastDecision = { action: 'raid_roster_wait', partyId: party.partyId, at: now };
            return true;
        }
        if (!Roster.admitted(party)) {
            if (holdForRaidPreparation(session, owner, members, Generics, now, true)) return true;
            Lifecycle.openMarkedRaid(party, registered, now).catch(error =>
                utils.infoWarn('BotParty', 'marked admission %s: %s', party.partyId, error.message));
            Tactics.stop(session, bot); bot.unselect?.(); session.currentTargetId = undefined;
            session.lastDecision = { action: 'raid_roster_admission', partyId: party.partyId, at: now };
            return true;
        }
        if (holdForRaidRecovery(session, owner, members, now)) return true;
        // The native offensive impact owns the final current-input fence.
        // Tick dispatch must not recapture nine inventories for every actor.
    }
    const RaidSafety = invoke('GameServer/Bot/AI/BotRaidSafety');
    const heldRaidPlan = owner.backgroundHuntTarget && RaidSafety.isProtectedRaidEntity(owner.backgroundHuntTarget)
        ? RaidSafety.botClanRaidCombatPlan(owner, owner.backgroundHuntTarget) : null;
    if (heldRaidPlan) RaidCombat.preserveControlledAdds(session, bot, heldRaidPlan);
    if (session.spotRelocation && !session.spotRelocation.arrivalPending && SpotTravel.partyReturnInCombat(session)) {
        Tactics.stop(session, bot);
        SpotTravel.cancel(session, bot, 'combat_interrupt');
    }
    if (!Restrictions.canUseBasicAction(bot)) return true;
    // Native cast completion owns the action slot, including support effects.
    // A silence that lands during party music must not leave a melee support
    // bot parked behind a stale cast flag for the whole debuff duration.
    // Effect application normally aborts it immediately; this recovery also
    // covers restored/legacy effects that did not pass through that hook.
    if (bot.state.fetchCasts?.() && !Restrictions.canCast(bot)) {
        bot.attack?.abortCast?.(session, bot);
    }
    if (bot.state.fetchCasts?.()) return true;
    const near = members.filter(s => Threats.distance(s.actor, owner.actor) <= radius);
    // A member restarted in town goes back on its own threat only: the party's
    // fight at the spot is no target for a bot in town.
    const own = Awareness.npcThreateningActor(session);
    if (!own && away(session) && inTown(session) && !returning(session)) {
        Diagnostics.count('hot_party_town_return', 'start', 'all');
        returnToSpot(session, bot, spot, party, now, owner !== session && !away(owner) ? loc(owner.actor) : null);
        return true;
    }
    const incoming = own || (returnPending ? returnIncoming : near.map(s => Awareness.npcThreateningActor(s)).find(Boolean));
    const legal = (npc) => {
        if (!Threats.alive(npc)) return false;
        // A despawned minion can remain alive in a held reference after its
        // leader's replacement. Native attacks resolve by object ID, so that
        // detached object would leave the whole party attacking nothing.
        if (NpcObjectIndex.isIndexed(World) && NpcObjectIndex.find(World, npc.fetchId()) !== npc) return false;
        // During an autonomous raid, do not let a nearby field monster replace
        // the clan objective.  Raid bosses use kind `Boss`, while their
        // minions use `Monster`, so ownership is the authoritative filter for
        // both kinds.
        if (raidObjective) return RaidSafety.canEngageBotClanRaid(session, npc);
        return npc?.fetchKind?.() === 'Monster' && !RaidSafety.isProtectedRaidEntity(npc);
    };
    // A field mob that has already attacked the raid is a local nuisance, not
    // a new hunting target.  Clear it through the party controller so control
    // never falls through to HuntingState (which may resume an old farm spot
    // or start a shopping trip).  Foreign raid entities still use the generic
    // protected-raid escape path.
    const defensiveRaidThreat = raidObjective && incoming?.fetchKind?.() === 'Monster'
        && Threats.alive(incoming) && !RaidSafety.isProtectedRaidEntity(incoming);
    const combatLegal = npc => legal(npc) || (defensiveRaidThreat && npc === incoming);
    if (incoming && !combatLegal(incoming)) return false; // existing raid escape path
    if (incoming && session.pendingSupportCast) {
        Support.cancelSupportCast(session, bot);
        Tactics.stop(session, bot);
    }
    const Revival = invoke('GameServer/Bot/AI/PartyRevivalService');
    const anchor = leader(session); // Keep attempts on the same session even if the leader dies.
    const revivalAnchor = anchor?.hotRaidCasualtyAt ? owner : anchor;
    const fallen = roster(session).filter(s => s.actor.isDead?.());
    if (!fallen.length) revivalAnchor.partyRevivalAttempt = null;
    const waiting = fallen.filter(s => !Revival.shouldTownRespawn(revivalAnchor, s, now));
    if (!incoming && waiting.length && !Revival.partyCombatInProgress(revivalAnchor)) {
        const result = Revival.tick(session, revivalAnchor, Generics);
        if (!result.handled && !bot.state.fetchCasts?.()) {
            Support.cancelSupportCast(session, bot);
            Tactics.stop(session, bot);
            session.currentTargetId = undefined;
            bot.unselect?.();
            bot.automation.replenishVitals(bot);
        }
        owner.backgroundHuntTarget = null;
        session.lastDecision = { action: result.handled ? 'party_resurrect' : 'party_wait_resurrection',
            targetId: result.target?.fetchId?.() || result.targetId || waiting[0].actor.fetchId(),
            partyId: party.partyId, at: now };
        return true;
    }
    if (!incoming && returnPending) {
        if (returning(session) && !Revival.partyCombatInProgress(revivalAnchor)) {
            Support.cancelSupportCast(session, bot);
            returnToSpot(session, bot, spot, party, now, owner !== session && present(owner) ? loc(owner.actor) : null);
        } else {
            // Let the whole restored roster arrive before the next pull.
            Tactics.stop(session, bot);
            session.currentTargetId = undefined;
            bot.unselect?.();
            session.lastDecision = { action: 'party_wait_roster', partyId: party.partyId, at: now };
        }
        return true;
    }
    if (!incoming && Number(session.pendingSupportCast?.expiresAt || 0) > now) {
        session.lastDecision = { action: 'party_buff_approach', targetId: session.pendingSupportCast.targetId, at: now };
        return true;
    }
    if (!incoming && invoke('GameServer/Bot/AI/PendingSweep').tick(session, bot, Generics, AI, now)) return true;
    const distance = Threats.distance(bot, owner.actor);
    if (!incoming && session !== owner && distance > 700) {
        if (!session.pendingPathRequest && !bot.state.fetchTowards?.() && Restrictions.canMove(bot)) {
            Tactics.stop(session, bot);
            bot.moveTo({ from: loc(bot), to: loc(owner.actor) });
        }
        session.lastDecision = { action: 'party_regroup', partyId: party.partyId, at: now };
        return true;
    }
    if (raidObjective && !incoming && !owner.raidPreparationComplete
        && holdForRaidPreparation(session, owner, members, Generics, now)) {
        return true;
    }
    let target = incoming || owner.backgroundHuntTarget;
    const allowedHunt = npc => legal(npc) && (RaidSafety.canEngageBotClanRaid(session, npc)
        || !invoke('GameServer/Bot/AI/HotResourceCompetition').blockedTarget(owner, npc, now));
    if (!incoming && target && !allowedHunt(target)) target = null;
    if (!combatLegal(target) || (!incoming && Threats.distance(owner.actor, target) > 2000)) target = null;
    if (!incoming && target && !HuntingVisibility.canSee(owner.actor, target)) target = null;
    if (!target && !incoming) {
        const low = members.some(s => RestPolicy.needsRest(s.actor, ratio(s.actor.fetchHp(), s.actor.fetchMaxHp()),
            ratio(s.actor.fetchMp(), s.actor.fetchMaxMp()), { party: true, pet: SummonerTactics.petRestView(s.actor) }));
        if (low) {
            Tactics.stop(session, bot);
            session.currentTargetId = undefined;
            if (!bot.state.fetchSeated()) {
                bot.state.setSeated(true);
                session.dataSendToOthers(invoke('GameServer/Network/Response').sitAndStand(bot), bot);
            }
            bot.automation.replenishVitals(bot);
            session.lastDecision = { action: 'party_recovery', partyId: party.partyId, at: now };
            return true;
        }
        // Let the collector finish before another member starts a fresh pull.
        // Incoming mobs and an existing fight still take priority above.
        const collector = members.find(s => s.partyGroundPickupInProgress
            && Number(s.partyGroundPickupDeadlineAt || 0) > now);
        if (collector) {
            Tactics.stop(session, bot);
            session.currentTargetId = undefined;
            bot.unselect?.();
            bot.automation.replenishVitals(bot);
            session.lastDecision = { action: 'party_wait_loot', targetId: collector.actor.fetchId(),
                partyId: party.partyId, at: now };
            return true;
        }
        if (!Revival.partyCombatInProgress(revivalAnchor)) {
            if (Tactics.support(session, bot, { owner, members: near, threats: [] }, Generics, now)) return true;
            if (prepareBuffs(session, owner, near, Generics, now, {
                partyMusicLast: true
            })) return true;
        }
        if (now >= Number(owner.nextBackgroundTargetScanAt || 0)) {
            owner.nextBackgroundTargetScanAt = now + 2000;
            const npcId = PartyTarget.npcId(party, owner.coldLifeState);
            // The near members take only a pull they survive (E72): the target
            // with its helpers, aggressive neighbours and minions; smaller first.
            const profiles = TargetMatchup.actorProfiles(near.map(s => s.actor));
            const candidates = World.fetchNpcsInRadius(owner.actor.fetchLocX(), owner.actor.fetchLocY(), radius)
                .filter(allowedHunt).filter(n => Math.abs(n.fetchLocZ() - owner.actor.fetchLocZ()) < 500);
            const pulls = candidates
                .map(npc => ({ npc, size: Spots.pullSizeFor(npc) }))
                // Raid admission already accounts for tanking, healing,
                // regeneration and supplies. The ordinary no-healing pull
                // estimate would reject its boss after accepting the adds.
                // allowedHunt still enforces ownership of this raid only.
                .filter(({ npc, size }) => raidObjective || TargetMatchup.soloSurvival(profiles,
                    BotPullEstimate.pullView(TargetMatchup.targetView(npc), size)).eligible);
            const Material = require('../Population/CraftMaterialParty');
            owner.backgroundUnsafeHunt = candidates.length > 0 && pulls.length === 0
                && Material.isObjective(party.stats?.objective)
                && !Material.canHunt(members.map(s => s.coldLifeState), partySpot(party),
                    TargetMatchup.actorProfiles(members.map(s => s.actor)),
                    [party.stats.objective.npcId, ...(party.stats.agreement?.materialNeeds || []).map(need => need.npcId)]);
            pulls.sort((a, b) => Number(b.npc.fetchSelfId() === npcId) - Number(a.npc.fetchSelfId() === npcId)
                || Math.round(a.size) - Math.round(b.size)
                || Threats.distance(owner.actor, a.npc) - Threats.distance(owner.actor, b.npc));
            const scan = HuntingVisibility.select(owner, 'party', owner.actor, pulls.map(pull => pull.npc));
            target = scan.candidate;
            owner.backgroundTargetScanPending = scan.pending;
        }
    }
    owner.backgroundHuntTarget = target;
    if (!raidObjective) standForAction(session, bot);
    if (Tactics.support(session, bot, { owner, members: near, threats: [], raid: raidObjective }, Generics, now)) return true;
    // A summoner keeps its pet alive between fights, as alone (PetHealRule).
    if (!target && !bot.state?.fetchCasts?.() && SummonerTactics.healPetBetweenFights(session, bot, Generics)) return true;
    if (raidObjective && session.hotRaidResurrectionRecovery) {
        if (ratio(bot.fetchHp(), bot.fetchMaxHp()) < 0.65) {
            Tactics.stop(session, bot);
            bot.unselect?.();
            session.currentTargetId = undefined;
            bot.automation.replenishVitals(bot);
            session.lastDecision = { action: 'raid_resurrection_recovery', partyId: party.partyId, at: now };
            return true;
        }
        session.hotRaidResurrectionRecovery = false;
        session.hotRaidNeedsRebuff = true;
        session.hotRaidRebuffUntil = now + RAID_RECOVERY_BUFF_WAIT_MS;
    }
    if (raidObjective && waiting.length && Revival.combatResurrectionAllowed(revivalAnchor)) {
        const result = Revival.tick(session, revivalAnchor, Generics);
        if (result.handled) {
            session.lastDecision = { action: 'raid_resurrect', targetId: result.target?.fetchId?.() || result.targetId,
                partyId: party.partyId, at: now };
            return true;
        }
    }
    if (!target) {
        standForAction(session, bot);
        if (session.currentTargetId) {
            Tactics.stop(session, bot);
            bot.unselect?.();
        }
        session.currentTargetId = undefined;
        if (owner.backgroundUnsafeHunt) {
            // Do not let exploration chase the same packs the combat scan
            // just rejected. Gather the complete roster before releasing an
            // incapable material contract through the native membership owner.
            if (session === owner) {
                Tactics.stop(session, bot);
                session.backgroundSearchDestination = null;
                if (members.length === party.memberIds.length
                    && members.every(s => Threats.distance(s.actor, bot) <= 700)
                    && require('../Population/CraftMaterialParty').isObjective(party.stats?.objective)
                    && now >= Number(session.nextUnsafeHuntReviewAt || 0)) {
                    session.nextUnsafeHuntReviewAt = now + 5000;
                    invoke('GameServer/Bot/Population/HotPartyLifecycle').releaseUnsafeHunt(party.partyId);
                }
            }
            session.lastDecision = { action: 'party_unsafe_ground', reason: 'unsafe_pull', partyId: party.partyId, at: now };
            return true;
        }
        if (owner.backgroundTargetScanPending) {
            session.lastDecision = { action: 'party_search_visibility', partyId: party.partyId, at: now };
            return true;
        }
        searchGround(session, owner, members, party, allowedHunt, now, present);
        return true;
    }
    session.backgroundSearchDestination = null;
    const autonomousRaid = RaidSafety.canEngageBotClanRaid(session, target);
    const raidPlan = autonomousRaid ? RaidSafety.botClanRaidCombatPlan(owner, target) : null;
    if (raidPlan) return RaidCombat.tick(session, bot, Generics, AI, {
        owner, members, near, raidPlan, raidTank: RaidCombat.mainRaidTank(members, party),
        partyId: party.partyId, combatBuffs: combatRaidBuffs
    }, now);
    const combatTarget = target;
    standForAction(session, bot);
    if (session.currentTargetId !== combatTarget.fetchId()) {
        Tactics.stop(session, bot);
        session.currentTargetId = combatTarget.fetchId();
        bot.select({ id: combatTarget.fetchId() });
    }
    session.lastDecision = { action: 'party_hunt',
        targetId: combatTarget.fetchId(), partyId: party.partyId, at: now };
    // Attack.meleeHit owns the whole native weapon cycle and repeats it when
    // the cycle completes. Re-dispatching attackExec from every bot AI tick
    // stacks parallel hit timers and floods nearby clients with shot-charge
    // and attack packets. Movement and casts likewise already own their
    // completion callbacks; wait for that action slot before choosing another
    // ordinary combat action.
    if (bot.state.fetchTowards?.() || bot.state.fetchHits?.() || bot.state.fetchCasts?.()) {
        return true;
    }
    AI.executeCombat(session, bot, combatTarget, Generics, {
        party: true,
        autonomousClanRaid: false
    });
    return true;
}

module.exports = { roster, leader, tick };
