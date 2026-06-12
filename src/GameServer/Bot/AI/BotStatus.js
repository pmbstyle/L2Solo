const ROLE_CLASSES = {
    healer: [15, 16, 17, 29, 30, 42, 43],
    tank: [4, 5, 6, 19, 20, 32, 33],
    archer: [8, 9, 22, 23, 35, 36, 37],
    mage: [10, 11, 12, 13, 14, 15, 16, 17, 25, 26, 27, 28, 29, 30, 38, 39, 40, 41, 42, 43, 49, 50, 51, 52]
};

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

function inferRole(bot) {
    const classId = bot.fetchClassId();
    if (ROLE_CLASSES.healer.includes(classId)) return 'healer';
    if (ROLE_CLASSES.tank.includes(classId)) return 'tank';
    if (ROLE_CLASSES.archer.includes(classId)) return 'archer';
    if (ROLE_CLASSES.mage.includes(classId)) return 'mage';
    return 'dps';
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
    return {
        store: store ? {
            type: store.storeType === 3 ? 'buy' : 'sell',
            title: store.title || '',
            town: store.town || null,
            items: store.items ? store.items.length : 0
        } : null,
        shoppingTarget: session.shoppingTarget || null,
        last: session.lastTradeSummary || null
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

        const target = findTarget(session, bot);
        const party = session.followPlayerSession && session.partyCompanion === true ? {
            leader: actorSummary(session.followPlayerSession.actor, bot),
            role: inferRole(bot),
            stance: session.botStay ? 'stay' : 'follow',
            autoTaunt: session.autoTaunt !== false
        } : null;

        const status = {
            available: true,
            id: bot.fetchId(),
            name: bot.fetchName(),
            level: bot.fetchLevel(),
            classId: bot.fetchClassId(),
            mode: session.plan || 'hunting',
            intent: undefined,
            role: inferRole(bot),
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
                stuckTicks: session.stuckTicks || 0
            },
            timers: {
                deathStartedAt: session.deathTimerStart || null,
                fleeStartedAt: session.fleeStart || null,
                shopStartedAt: session.shopTimer || null
            },
            nearby: nearbySnapshot(bot),
            trade: tradeSnapshot(session, bot),
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
        const blockers = status.blockers.length > 0 ? ` blockers=${status.blockers.join(',')}` : '';

        return `${status.name}: mode=${status.mode} intent=${status.intent} role=${status.role}${home} hp=${hp}% mp=${mp}%${target}${spot}${blockers}`;
    }
};

BotStatus.ROLE_CLASSES = ROLE_CLASSES;

module.exports = BotStatus;
