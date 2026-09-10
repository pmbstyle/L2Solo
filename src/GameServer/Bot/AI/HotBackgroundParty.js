const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
const World = invoke('GameServer/World/World');
const Threats = invoke('GameServer/Bot/AI/BotPvpThreats');
const Restrictions = invoke('GameServer/Effects/EffectRestrictions');
const Tactics = invoke('GameServer/Bot/AI/BotPvpTactics');
const Roles = invoke('GameServer/Bot/AI/BotRoles');
const Support = invoke('GameServer/Bot/AI/BotSupportPlanner');

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

const loc = actor => ({ locX: actor.fetchLocX(), locY: actor.fetchLocY(), locZ: actor.fetchLocZ() });
const ratio = (value, max) => Number(value || 0) / Math.max(1, Number(max || 0));

function prepareBuffs(session, owner, members, Generics, now) {
    // Finish one native cast/approach before electing another provider. This
    // also prevents two party auras reserving different targets in one group.
    const pending = members.find(s => s.activeSupportCast && s.actor.state.fetchCasts?.()
        || Number(s.pendingSupportCast?.expiresAt || 0) > now);
    const recipients = members.map(s => ({ actor: s.actor, leader: s === owner }));
    const providers = members.filter(s => !s.pendingPathRequest && Restrictions.canCast(s.actor)).map(s => s.actor);
    const action = pending ? null : Support.nextPartyAction(recipients, providers);
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
    const spot = Spots.findById(party.spotId);
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
        session.backgroundSearchDestination = to;
        session.lastDecision = { action: 'party_search', partyId: party.partyId, destination: to, at: now };
        // Native bounded pathfinding may go around a wall. A failed route
        // leaves us idle; the next search tries another destination.
        bot.moveTo({ from: origin, to });
        return;
    }
}

function tick(session, bot, Generics, AI, now = Date.now()) {
    const members = roster(session).filter(s => Threats.alive(s.actor));
    if (!members.length) return false;
    const party = Parties.find(session.hotBackgroundPartyId);
    const owner = members.find(s => s.actor.fetchId() === party.leaderId) || members[0];
    if (!Restrictions.canUseBasicAction(bot)) return true;
    // Native cast completion owns the action slot, including support effects.
    if (bot.state.fetchCasts?.()) return true;
    const radius = 1800;
    const near = members.filter(s => Threats.distance(s.actor, owner.actor) <= radius);
    const Awareness = invoke('GameServer/Bot/AI/PartyAwareness');
    const incoming = Awareness.npcThreateningActor(session) || near.map(s => Awareness.npcThreateningActor(s)).find(Boolean);
    const legal = npc => npc?.fetchKind?.() === 'Monster' && Threats.alive(npc)
        && !invoke('GameServer/Bot/AI/BotRaidSafety').isProtectedRaidEntity(npc);
    if (incoming && !legal(incoming)) return false; // existing raid escape path
    if (incoming && session.pendingSupportCast) {
        Support.cancelSupportCast(session, bot);
        Tactics.stop(session, bot);
    }
    const Revival = invoke('GameServer/Bot/AI/PartyRevivalService');
    const anchor = leader(session); // Keep attempts on the same session even if the leader dies.
    const fallen = roster(session).filter(s => s.actor.isDead?.());
    if (!fallen.length) anchor.partyRevivalAttempt = null;
    const waiting = fallen.filter(s => !Revival.shouldTownRespawn(anchor, s, now));
    if (!incoming && waiting.length && !Revival.partyCombatInProgress(anchor)) {
        const result = Revival.tick(session, anchor, Generics);
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
    let target = incoming || owner.backgroundHuntTarget;
    const allowedHunt = npc => legal(npc) && !invoke('GameServer/Bot/AI/HotResourceCompetition').blockedTarget(owner, npc, now);
    if (!incoming && target && !allowedHunt(target)) target = null;
    if (!legal(target) || (!incoming && Threats.distance(owner.actor, target) > 2000)) target = null;
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
        if (!Revival.partyCombatInProgress(anchor)) {
            if (Tactics.support(session, bot, { owner, members: near, threats: [] }, Generics, now)) return true;
            if (prepareBuffs(session, owner, near, Generics, now)) return true;
        }
        if (now >= Number(owner.nextBackgroundTargetScanAt || 0)) {
            owner.nextBackgroundTargetScanAt = now + 2000;
            const npcId = Number(party.stats?.objective?.npcId || party.stats?.acquisitionGoal?.next?.npcId || 0);
            const npcs = World.fetchNpcsInRadius(owner.actor.fetchLocX(), owner.actor.fetchLocY(), radius)
                .filter(allowedHunt).filter(n => Math.abs(n.fetchLocZ() - owner.actor.fetchLocZ()) < 500);
            target = npcs.sort((a, b) => Number(b.fetchSelfId() === npcId) - Number(a.fetchSelfId() === npcId)
                || Threats.distance(owner.actor, a) - Threats.distance(owner.actor, b))[0] || null;
        }
    }
    owner.backgroundHuntTarget = target;
    if (bot.state.fetchSeated()) {
        bot.state.setSeated(false);
        session.dataSendToOthers(invoke('GameServer/Network/Response').sitAndStand(bot), bot);
    }
    if (Tactics.support(session, bot, { owner, members: near, threats: [] }, Generics, now)) return true;
    if (!target) {
        session.currentTargetId = undefined;
        searchGround(session, owner, members, party, allowedHunt, now);
        return true;
    }
    session.backgroundSearchDestination = null;
    if (session.currentTargetId !== target.fetchId()) {
        Tactics.stop(session, bot);
        session.currentTargetId = target.fetchId();
        bot.select({ id: target.fetchId() });
    }
    session.lastDecision = { action: 'party_hunt', targetId: target.fetchId(), partyId: party.partyId, at: now };
    AI.executeCombat(session, bot, target, Generics);
    return true;
}

module.exports = { roster, leader, tick };
