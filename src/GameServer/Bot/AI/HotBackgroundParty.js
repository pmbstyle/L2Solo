const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
const World = invoke('GameServer/World/World');
const Threats = invoke('GameServer/Bot/AI/BotPvpThreats');
const Restrictions = invoke('GameServer/Effects/EffectRestrictions');
const Tactics = invoke('GameServer/Bot/AI/BotPvpTactics');
const Roles = invoke('GameServer/Bot/AI/BotRoles');
const Support = invoke('GameServer/Bot/AI/BotSupportPlanner');
const ClassTactics = invoke('GameServer/Bot/AI/PartyClassTactics');
const SkillCapabilities = invoke('GameServer/Bot/AI/BotSkillCapabilities');
const HuntingVisibility = invoke('GameServer/Bot/AI/BotHuntingVisibility');

const RAID_ACTION_RETRY_MS = 8000;
const RAID_AGGRESSION_RETRY_MS = 5000;
const RAID_PREPARATION_SETTLE_MS = 1500;
const RAID_RECOVERY_BUFF_WAIT_MS = 8000;

function roster(session) {
    const party = session?.hotBackgroundPartyId && Parties.find(session.hotBackgroundPartyId);
    if (party?.status !== 'hot' || session.partyCompanion) return [];
    return party.memberIds.map(id => World.user.sessions.find(s => s.actor?.fetchId() === id
        && s.hotBackgroundPartyId === party.partyId && !s.partyCompanion)).filter(Boolean);
}

function leader(session) {
    const party = Parties.find(session?.hotBackgroundPartyId);
    return roster(session).find(s => s.actor.fetchId() === party?.leaderId) || session;
}

function mainRaidTank(members, party) {
    return members.find((member) => (
        Number(member.actor.fetchId?.() || 0) === Number(party?.leaderId || 0)
        && Roles.inferRole(member.actor) === 'tank'
    )) || members.find((member) => Roles.inferRole(member.actor) === 'tank') || null;
}

function bossHeldByRaidTank(members, boss, party) {
    const tank = mainRaidTank(members, party);
    const targetId = Number(boss?.fetchDestId?.() || 0);
    return !!tank && targetId > 0
        && Number(tank.actor.fetchId?.() || 0) === targetId
        && Threats.alive(tank.actor);
}

const loc = actor => ({ locX: actor.fetchLocX(), locY: actor.fetchLocY(), locZ: actor.fetchLocZ() });
const ratio = (value, max) => Number(value || 0) / Math.max(1, Number(max || 0));

function raidActionKey(target, skill) {
    const effect = String(skill?.fetchSemantic?.()?.effect || '').toLowerCase();
    return `${Number(target?.fetchId?.() || 0)}:${effect || Number(skill?.fetchSelfId?.() || 0)}`;
}

function raidClaimMap(owner) {
    return owner.backgroundRaidActionClaims || (owner.backgroundRaidActionClaims = new Map());
}

function canAttemptRaidAction(owner, target, skill, now, retryMs = RAID_ACTION_RETRY_MS) {
    const claims = raidClaimMap(owner);
    for (const [key, until] of claims) if (Number(until) <= now) claims.delete(key);
    return Number(claims.get(raidActionKey(target, skill)) || 0) <= now;
}

function rememberRaidAction(owner, target, skill, now, retryMs = RAID_ACTION_RETRY_MS) {
    raidClaimMap(owner).set(raidActionKey(target, skill), now + retryMs);
}

function raidMinionPickup(owner, members, raidPlan, mainTank, now) {
    const Effects = invoke('GameServer/Effects/EffectStore');
    // Capability, not the inferred party role: music fighters can also have
    // Aggression. A holder remains valid while its skill is on reuse, so two
    // rescuers do not continually pull the same add away from one another.
    const holders = members.filter(member => member === mainTank
        || SkillCapabilities.aggressionSkill(member.actor));
    const holderIds = new Set(holders.map(member => member.actor.fetchId()));
    const providers = holders.filter(member => member !== mainTank
        && !member.actor.state.fetchCasts?.()
        && Restrictions.canUseBasicAction(member.actor)
        && ClassTactics.usable(member.actor, SkillCapabilities.aggressionSkill(member.actor), 0.08));
    const targets = raidPlan.minions.filter(target => {
        if (target === raidPlan.boss || !Threats.alive(target)) return false;
        const victimId = Number(target.fetchDestId?.() || 0);
        if (holderIds.has(victimId) || !members.some(member => member.actor.fetchId() === victimId)) return false;
        const effects = Effects.impairments(target);
        // Leave safely controlled adds alone and do not pull unengaged adds.
        return !effects.disabled && !effects.rooted;
    });
    const priority = target => {
        const victim = members.find(member => member.actor.fetchId() === Number(target.fetchDestId?.()));
        const role = Roles.inferRole(victim.actor);
        return ['healer', 'buffer'].includes(role) && !Roles.isPartyMusicFighter(victim.actor) ? 0
            : ['archer', 'mage'].includes(role) ? 1 : 2;
    };
    targets.sort((a, b) => priority(a) - priority(b)
        || Number(b === raidPlan.focusMinion) - Number(a === raidPlan.focusMinion)
        || a.fetchId() - b.fetchId());
    for (const target of targets) {
        const candidates = providers.filter(member => {
            const skill = SkillCapabilities.aggressionSkill(member.actor);
            const distance = Threats.distance(member.actor, target);
            return distance <= 1800
                && (Restrictions.canMove(member.actor) || distance <= Number(skill.fetchDistance?.() || 0))
                && canAttemptRaidAction(owner, target, skill, now, RAID_AGGRESSION_RETRY_MS);
        });
        candidates.sort((a, b) => Threats.distance(a.actor, target) - Threats.distance(b.actor, target)
            || a.actor.fetchId() - b.actor.fetchId());
        if (candidates.length) return { provider: candidates[0], target,
            skill: SkillCapabilities.aggressionSkill(candidates[0].actor) };
    }
    return null;
}

function castRaidSkill(session, bot, target, skill, Generics) {
    standForAction(session, bot);
    Tactics.stop(session, bot);
    session.currentTargetId = target.fetchId();
    bot.select({ id: target.fetchId() });
    Generics.skillExec(session, bot, { id: target.fetchId(), selfId: skill.fetchSelfId(), ctrl: true });
}

function standForAction(session, bot) {
    if (!bot.state.fetchSeated()) return;
    bot.state.setSeated(false);
    session.dataSendToOthers(invoke('GameServer/Network/Response').sitAndStand(bot), bot);
}

function combatRaidBuffs(session, owner, members, Generics, now) {
    const supportMembers = members.filter(s => !['tank', 'healer'].includes(Roles.inferRole(s.actor)));
    const recoveryOptions = { raidRecovery: true, allowAttackInterrupt: true };
    for (const member of members.filter(s => s.hotRaidNeedsRebuff)) {
        member.hotRaidRebuffUntil ||= now + RAID_RECOVERY_BUFF_WAIT_MS;
        if (now >= member.hotRaidRebuffUntil || !Support.hasPendingAction(
            [{ actor: member.actor }], supportMembers.map(s => s.actor), recoveryOptions)) {
            member.hotRaidNeedsRebuff = false;
            member.hotRaidRebuffUntil = undefined;
        }
    }
    const recovering = members.filter(s => s.hotRaidNeedsRebuff);
    const providers = supportMembers.filter(s => !s.actor.state.fetchCasts?.() && !s.pendingSupportCast
        && Restrictions.canCast(s.actor)).map(s => s.actor);
    const recipients = (recovering.length ? recovering : members).map(s => ({ actor: s.actor, leader: s === owner }));
    const action = Support.nextPartyAction(recipients, providers, recovering.length
        ? recoveryOptions : { musicOnly: true, allowAttackInterrupt: true });
    if (!action || action.provider !== session.actor) return false;
    // Battle rebuffs never drag a provider through the encounter to reach an
    // outlying recipient. Other members keep their native attack cycles.
    if (!invoke('GameServer/Bot/AI/BotSkillIntent').inRange(session.actor, action.target, action.skill)) return false;
    Tactics.stop(session, session.actor);
    standForAction(session, session.actor);
    Support.queueSupportCast(session, action);
    Generics.skillExec(session, session.actor, { id: action.target.fetchId(), selfId: action.skill.fetchSelfId(), ctrl: false });
    session.lastDecision = { action: 'raid_rebuff', skillId: action.skill.fetchSelfId(), targetId: action.target.fetchId(), at: now };
    return true;
}

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

function holdForRaidPreparation(session, owner, members, Generics, now) {
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

function searchGround(session, owner, members, party, legal, now) {
    const bot = session.actor;
    if (session !== owner) {
        session.lastDecision = { action: 'party_wait', partyId: party.partyId, at: now };
        return;
    }
    // Do not start another pull while the group is still catching up.
    if (members.some(s => Threats.distance(s.actor, bot) > 1000)) {
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

    const Spots = invoke('GameServer/Bot/AI/SpotService');
    const Geo = invoke('GameServer/Geodata/GeodataEngine');
    const spot = Spots.findById(party.spotId)
        || invoke('GameServer/Bot/Population/SpotProfiles').findById(party.spotId);
    if (!spot) return;
    const origin = loc(bot);
    const npcId = Number(party.stats?.objective?.npcId || party.stats?.acquisitionGoal?.next?.npcId || 0);
    const distance = point => Math.hypot(point.locX - origin.locX, point.locY - origin.locY);
    const usable = point => point && ['locX', 'locY', 'locZ'].every(k => Number.isFinite(point[k]))
        && distance(point) > 600 && distance(point) <= 4500
        && Spots.findCurrentSpot(point)?.id === spot.id;
    // One wider query per idle leader, not per member or combat tick. Empty
    // spawn locations also let the party explore while monsters are respawning.
    const monsters = World.fetchNpcsInRadius(origin.locX, origin.locY, 4500)
        .filter(legal).map(n => ({ ...loc(n), npcId: n.fetchSelfId() })).filter(usable)
        .sort((a, b) => Number(b.npcId === npcId) - Number(a.npcId === npcId) || distance(a) - distance(b));
    const points = [...monsters, ...(spot.arrivalPoints || []).filter(usable).sort((a, b) => distance(a) - distance(b))];
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
    const owner = members.find(s => s.actor.fetchId() === party.leaderId) || members[0];
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
    const radius = 1800;
    const near = members.filter(s => Threats.distance(s.actor, owner.actor) <= radius);
    const Awareness = invoke('GameServer/Bot/AI/PartyAwareness');
    const incoming = Awareness.npcThreateningActor(session) || near.map(s => Awareness.npcThreateningActor(s)).find(Boolean);
    const RaidSafety = invoke('GameServer/Bot/AI/BotRaidSafety');
    const raidObjective = party.stats?.objective?.sourceKind === 'raid'
        || party.stats?.objective?.raidBoss === true;
    const legal = (npc) => {
        if (!Threats.alive(npc)) return false;
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
    if (!incoming && Number(session.pendingSupportCast?.expiresAt || 0) > now) {
        session.lastDecision = { action: 'party_buff_approach', targetId: session.pendingSupportCast.targetId, at: now };
        return true;
    }
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
        const low = members.some(s => ratio(s.actor.fetchHp(), s.actor.fetchMaxHp()) < 0.55
            || (Roles.shouldRestForMana(s.actor) && ratio(s.actor.fetchMp(), s.actor.fetchMaxMp()) < 0.35));
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
                partyMusicLast: raidObjective
            })) return true;
        }
        if (now >= Number(owner.nextBackgroundTargetScanAt || 0)) {
            owner.nextBackgroundTargetScanAt = now + 2000;
            const npcId = Number(party.stats?.objective?.npcId || party.stats?.acquisitionGoal?.next?.npcId || 0);
            const npcs = World.fetchNpcsInRadius(owner.actor.fetchLocX(), owner.actor.fetchLocY(), radius)
                .filter(allowedHunt).filter(n => Math.abs(n.fetchLocZ() - owner.actor.fetchLocZ()) < 500);
            npcs.sort((a, b) => Number(b.fetchSelfId() === npcId) - Number(a.fetchSelfId() === npcId)
                || Threats.distance(owner.actor, a) - Threats.distance(owner.actor, b));
            const scan = HuntingVisibility.select(owner, 'party', owner.actor, npcs);
            target = scan.candidate;
            owner.backgroundTargetScanPending = scan.pending;
        }
    }
    owner.backgroundHuntTarget = target;
    if (!raidObjective) standForAction(session, bot);
    if (Tactics.support(session, bot, { owner, members: near, threats: [], raid: raidObjective }, Generics, now)) return true;
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
        if (owner.backgroundTargetScanPending) {
            session.lastDecision = { action: 'party_search_visibility', partyId: party.partyId, at: now };
            return true;
        }
        searchGround(session, owner, members, party, allowedHunt, now);
        return true;
    }
    session.backgroundSearchDestination = null;
    const autonomousRaid = RaidSafety.canEngageBotClanRaid(session, target);
    const raidPlan = autonomousRaid ? RaidSafety.botClanRaidCombatPlan(owner, target) : null;
    const role = Roles.inferRole(bot);
    let combatTarget = target;
    if (raidPlan) {
        const raidTank = mainRaidTank(members, party);
        const isRaidTank = session === raidTank;
        const bossHeldByTank = bossHeldByRaidTank(members, raidPlan.boss, party);
        if (bossHeldByTank) owner.raidOpenedBossId = raidPlan.boss.fetchId();
        const attackers = [raidPlan.boss, ...raidPlan.minions]
            .filter(npc => Threats.alive(npc) && Number(npc.fetchDestId?.()) === Number(bot.fetchId()));
        const defense = attackers.length ? ClassTactics.selfAction(bot, {
            role, activeMobs: attackers.length, raidBoss: true, target: attackers[0]
        }) : null;
        if (defense) {
            castRaidSkill(session, bot, bot, defense.skill, Generics);
            session.lastDecision = { action: 'raid_defense', skillId: defense.skill.fetchSelfId(),
                targetId: bot.fetchId(), partyId: party.partyId, at: now };
            return true;
        }
        if (!isRaidTank) {
            const pickup = raidMinionPickup(owner, members, raidPlan, raidTank, now);
            if (pickup?.provider === session) {
                rememberRaidAction(owner, pickup.target, pickup.skill, now, RAID_AGGRESSION_RETRY_MS);
                castRaidSkill(session, bot, pickup.target, pickup.skill, Generics);
                session.lastDecision = { action: 'raid_taunt_add', targetId: pickup.target.fetchId(),
                    skillId: pickup.skill.fetchSelfId(), partyId: party.partyId, at: now };
                return true;
            }
        }
        if (!isRaidTank && !bossHeldByTank && (owner.raidOpenedBossId !== raidPlan.boss.fetchId()
            || Number(raidPlan.boss.fetchDestId?.()) === Number(bot.fetchId()))) {
            Tactics.stop(session, bot);
            session.currentTargetId = undefined;
            bot.unselect?.();
            session.lastDecision = { action: 'raid_wait_tank', targetId: raidPlan.boss.fetchId(),
                partyId: party.partyId, at: now };
            return true;
        }

        if (!isRaidTank && combatRaidBuffs(session, owner, near, Generics, now)) return true;
        if (!isRaidTank && session.hotRaidNeedsRebuff) {
            Tactics.stop(session, bot);
            session.currentTargetId = undefined;
            bot.unselect?.();
            session.lastDecision = { action: 'raid_wait_minimal_rebuff', until: session.hotRaidRebuffUntil,
                partyId: party.partyId, at: now };
            return true;
        }
        combatTarget = isRaidTank
            ? raidPlan.boss
            : (raidPlan.focusMinion || raidPlan.boss);

        if (isRaidTank && Number(raidPlan.boss.fetchDestId?.() || 0) !== Number(bot.fetchId())) {
            const aggression = SkillCapabilities.aggressionSkill(bot);
            if (aggression && ClassTactics.usable(bot, aggression, 0.08)
                && canAttemptRaidAction(owner, raidPlan.boss, aggression, now, RAID_AGGRESSION_RETRY_MS)) {
                rememberRaidAction(owner, raidPlan.boss, aggression, now, RAID_AGGRESSION_RETRY_MS);
                castRaidSkill(session, bot, raidPlan.boss, aggression, Generics);
                session.lastDecision = { action: 'raid_taunt_boss', targetId: raidPlan.boss.fetchId(),
                    skillId: aggression.fetchSelfId(), partyId: party.partyId, at: now };
                return true;
            }
        }

        const canAttempt = (raidTarget, skill) => canAttemptRaidAction(owner, raidTarget, skill, now);
        // Silence/magic mute must not strand melee support classes in a loop
        // of rejected control and debuff casts. Sword Singers and Bladedancers
        // are physical fighters after their party music is applied, so when
        // casting is unavailable they must fall through to executeCombat and
        // use their weapon normally.
        if (!isRaidTank && Restrictions.canCast(bot)) {
            const control = ClassTactics.supportCrowdControl(bot, raidPlan.minions, {
                raid: true,
                primaryTargetId: raidPlan.focusMinion?.fetchId?.() || null,
                canAttempt
            });
            if (control) {
                rememberRaidAction(owner, control.target, control.skill, now);
                castRaidSkill(session, bot, control.target, control.skill, Generics);
                session.lastDecision = { action: 'raid_control_add', targetId: control.target.fetchId(),
                    skillId: control.skill.fetchSelfId(), partyId: party.partyId, at: now };
                return true;
            }
            const debuff = ClassTactics.raidDebuffAction(bot,
                [raidPlan.boss, raidPlan.focusMinion].filter(Boolean), {
                    primaryTargetId: raidPlan.boss.fetchId(),
                    canAttempt
                });
            if (debuff) {
                rememberRaidAction(owner, debuff.target, debuff.skill, now);
                castRaidSkill(session, bot, debuff.target, debuff.skill, Generics);
                session.lastDecision = { action: 'raid_debuff', targetId: debuff.target.fetchId(),
                    skillId: debuff.skill.fetchSelfId(), partyId: party.partyId, at: now };
                return true;
            }
        }
        // The healer is not a damage slot. Regenerate seated between support
        // actions, but never sit with an attacker on us or outside heal range.
        // Hysteresis avoids a stand/sit packet loop near full MP.
        if (role === 'healer' && !attackers.length && !Awareness.underDirectNpcAttack(session)
            && !bot.state.fetchTowards?.() && near.every(s => Threats.distance(bot, s.actor) <= 900)
            && ratio(bot.fetchMp(), bot.fetchMaxMp()) < (bot.state.fetchSeated() ? 0.98 : 0.9)) {
            if (!bot.state.fetchSeated()) {
                Tactics.stop(session, bot);
                bot.state.setSeated(true);
                session.dataSendToOthers(invoke('GameServer/Network/Response').sitAndStand(bot), bot);
            }
            bot.automation.replenishVitals(bot);
            session.lastDecision = { action: 'raid_healer_recovery', partyId: party.partyId, at: now };
            return true;
        }
    }
    standForAction(session, bot);
    if (session.currentTargetId !== combatTarget.fetchId()) {
        Tactics.stop(session, bot);
        session.currentTargetId = combatTarget.fetchId();
        bot.select({ id: combatTarget.fetchId() });
    }
    const assignedRaidTank = raidPlan ? mainRaidTank(members, party) : null;
    session.lastDecision = { action: raidPlan && session === assignedRaidTank ? 'raid_hold_boss'
        : raidPlan ? 'raid_focus_add' : 'party_hunt',
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
        autonomousClanRaid: RaidSafety.canEngageBotClanRaid(session, combatTarget)
    });
    return true;
}

module.exports = { roster, leader, tick };
