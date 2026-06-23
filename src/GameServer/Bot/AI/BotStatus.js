const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const BotBuffs = invoke('GameServer/Bot/AI/BotBuffs');
const TownPathfinder = invoke('GameServer/Bot/AI/TownPathfinder');

function ratio(value, max) {
    if (!max) return 0;
    return Math.max(0, Math.min(1, value / max));
}

function distance2d(a, b) {
    if (!a || !b) return null;
    const dx = a.locX - b.locX;
    const dy = a.locY - b.locY;
    return Math.sqrt(dx * dx + dy * dy);
}

function actorLocation(actor) {
    if (!actor) return null;
    return {
        locX: actor.fetchLocX(),
        locY: actor.fetchLocY(),
        locZ: actor.fetchLocZ()
    };
}

function actorSummary(actor, fromActor) {
    if (!actor) return null;
    const loc = actorLocation(actor);
    return {
        id: actor.fetchId(),
        name: actor.fetchName(),
        level: actor.fetchLevel(),
        loc,
        distance: fromActor ? distance2d(loc, actorLocation(fromActor)) : null,
        dead: actor.state ? actor.state.fetchDead() : actor.isDead(),
        karma: typeof actor.fetchKarma === 'function' ? actor.fetchKarma() : 0
    };
}

function findTarget(session, bot) {
    if (!session.currentTargetId) return null;

    const World = invoke('GameServer/World/World');
    const userSession = World.user.sessions.find((ob) => ob.actor && ob.actor.fetchId() === session.currentTargetId);
    if (userSession && userSession.actor) {
        return { type: 'user', ...actorSummary(userSession.actor, bot) };
    }

    const npc = World.npc.spawns.find((ob) => ob.fetchId() === session.currentTargetId);
    if (npc) {
        return {
            type: 'npc',
            ...actorSummary(npc, bot),
            attackable: npc.fetchAttackable()
        };
    }

    return {
        type: 'unknown',
        id: session.currentTargetId
    };
}

function inferIntent(session, bot, vitals, target) {
    if (bot.state.fetchDead()) return 'revive';
    if (session.plan === 'resting') return 'recover';
    if (session.plan === 'shopping') return 'restock';
    if (session.plan === 'getting_buffed') return 'refresh_buffs';
    if (session.plan === 'fleeing' || session.plan === 'pk_fleeing') return 'escape_threat';
    if (session.plan === 'merchant') return 'trade';
    if (session.plan === 'following') {
        if (target) return 'assist_leader';
        if (session.botStay) return 'hold_position';
        return 'follow_leader';
    }
    if (session.plan === 'pk_hunting') {
        return target ? 'hunt_player' : 'find_player';
    }
    if (vitals.hpPct < 0.35 || vitals.mpPct < 0.20) return 'recover';
    return target ? 'fight_target' : 'find_target';
}

function collectBlockers(session, bot, vitals, party) {
    const blockers = [];

    if (bot.state.fetchDead()) blockers.push('dead');
    if (vitals.hpPct < 0.35) blockers.push('low_hp');
    if (vitals.mpPct < 0.20) blockers.push('low_mp');
    if (session.stuckTicks >= 3) blockers.push('stuck');
    if (party && party.leader && party.leader.distance > 1000) blockers.push('too_far_from_leader');
    if (session.plan === 'hunting' && session.noTargetTicks >= 3) blockers.push('no_targets_nearby');

    return blockers;
}

function nearbySnapshot(bot) {
    const World = invoke('GameServer/World/World');
    const loc = actorLocation(bot);
    let realPlayers = 0;
    let friendlyBots = 0;
    let hostilePlayers = 0;
    let attackableNpcs = 0;

    World.user.sessions.forEach((session) => {
        const actor = session.actor;
        if (!actor || actor === bot || !actor.fetchIsOnline()) return;
        if (distance2d(actorLocation(actor), loc) > 1500) return;

        if (session.accountId && session.accountId.startsWith('bot_')) {
            friendlyBots++;
        } else {
            realPlayers++;
        }

        if (typeof actor.fetchKarma === 'function' && actor.fetchKarma() > 0) {
            hostilePlayers++;
        }
    });

    World.fetchNpcsInRadius(bot.fetchLocX(), bot.fetchLocY(), 1500).forEach((npc) => {
        if (npc.fetchAttackable() && !npc.isDead()) {
            attackableNpcs++;
        }
    });

    return { realPlayers, friendlyBots, hostilePlayers, attackableNpcs };
}

function tradeSnapshot(session, bot) {
    const store = bot.fetchPrivateStore && bot.fetchPrivateStore();
    const loot = session.lastLootRequest || null;

    return {
        store: store ? {
            type: store.storeType === 3 ? 'buy' : 'sell',
            title: store.title || '',
            town: store.town || null,
            items: store.items ? store.items.length : 0
        } : null,
        shoppingTarget: session.shoppingTarget || null,
        last: session.lastTradeSummary || null,
        lootRequest: loot ? {
            playerName: loot.playerName,
            itemName: loot.itemName,
            amount: loot.amount,
            reason: loot.reason || null,
            demandScore: loot.demandScore || null,
            expiresAt: loot.expiresAt
        } : null
    };
}

const BotStatus = {
    getStatus(session) {
        const bot = session.actor;
        if (!bot) {
            return {
                available: false,
                reason: 'missing_actor'
            };
        }

        const vitals = {
            hp: bot.fetchHp(),
            maxHp: bot.fetchMaxHp(),
            hpPct: ratio(bot.fetchHp(), bot.fetchMaxHp()),
            mp: bot.fetchMp(),
            maxMp: bot.fetchMaxMp(),
            mpPct: ratio(bot.fetchMp(), bot.fetchMaxMp())
        };

        const role = BotRoles.inferRole(bot);
        const target = findTarget(session, bot);
        const party = session.followPlayerSession && session.partyCompanion === true ? {
            leader: actorSummary(session.followPlayerSession.actor, bot),
            role,
            stance: session.botStay ? 'stay' : 'follow',
            roleStance: BotRoles.partyRoleStance(role),
            autoTaunt: session.autoTaunt !== false,
            decision: session.roleDecision || null
        } : null;

        const status = {
            available: true,
            id: bot.fetchId(),
            name: bot.fetchName(),
            level: bot.fetchLevel(),
            classId: bot.fetchClassId(),
            mode: session.plan || 'hunting',
            intent: undefined,
            role,
            roleDecision: session.roleDecision || null,
            home: {
                region: session.homeRegion || null,
                visitor: !!session.visitor
            },
            loc: actorLocation(bot),
            vitals,
            target,
            party,
            spot: session.currentSpot || null,
            movement: {
                moving: !!session.moveTimer || !!bot.state.fetchTowards(),
                towards: bot.state.fetchTowards() || false,
                stuckTicks: session.stuckTicks || 0,
                followTarget: session.lastFollowMoveTarget || null,
                followHeldAt: session.lastFollowMoveHeldAt || null,
                townRoute: session.townRoutePlan || null,
                pathfinding: session.lastPathfinding || null,
                pathSummary: TownPathfinder.describeDiagnostics(session.lastPathfinding?.townRoute)
            },
            buffs: BotBuffs.snapshot(bot),
            timers: {
                deathStartedAt: session.deathTimerStart || null,
                fleeStartedAt: session.fleeStart || null,
                shopStartedAt: session.shopTimer || null
            },
            nearby: nearbySnapshot(bot),
            trade: tradeSnapshot(session, bot),
            social: session.socialSummary || null,
            lastSocialEvent: session.lastSocialEvent || null,
            blockers: []
        };

        status.intent = inferIntent(session, bot, vitals, target);
        status.blockers = collectBlockers(session, bot, vitals, party);
        return status;
    },

    summarize(status) {
        if (!status || !status.available) return 'Bot status unavailable.';

        const hp = Math.round(status.vitals.hpPct * 100);
        const mp = Math.round(status.vitals.mpPct * 100);
        const target = status.target && status.target.name ? ` target=${status.target.name}` : '';
        const spot = status.spot && status.spot.name ? ` spot=${status.spot.name}` : '';
        const home = status.home && status.home.region ? ` home=${status.home.region}${status.home.visitor ? ':visitor' : ''}` : '';
        const social = status.social ? ` social=${status.social.playerName}:${status.social.relationship}/${status.social.trust}` : '';
        const roleDecision = status.roleDecision ? ` decision=${status.roleDecision.action}/${status.roleDecision.reason}` : '';
        const path = status.movement?.pathfinding?.townRoute?.changedTarget ? ' path=town' : '';
        const buffs = status.buffs?.needsRefresh ? ' buffs=refresh' : '';
        const blockers = status.blockers.length > 0 ? ` blockers=${status.blockers.join(',')}` : '';

        return `${status.name}: mode=${status.mode} intent=${status.intent} role=${status.role}${home} hp=${hp}% mp=${mp}%${target}${spot}${social}${roleDecision}${path}${buffs}${blockers}`;
    }
};

BotStatus.ROLE_CLASSES = BotRoles.ROLE_CLASSES;

module.exports = BotStatus;
