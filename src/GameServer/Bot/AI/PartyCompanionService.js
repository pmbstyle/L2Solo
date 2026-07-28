const ServerResponse = invoke('GameServer/Network/Response');
const PartyAwareness = invoke('GameServer/Bot/AI/PartyAwareness');
const PartyCombatState = invoke('GameServer/Bot/AI/PartyCombatState');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');

const DEFAULT_PARTY_DISTRIBUTION = 1;
const DEFAULT_PARTY_SETTINGS = {
    distribution: DEFAULT_PARTY_DISTRIBUTION,
    movementMode: 'follow',
    combatMode: 'assist',
    pullMode: 'auto',
    pullerId: null,
    itemLastLootIndex: -1
};
const PARTY_LOOT_RADIUS = 2500;
const GROUND_LOOT_SCAN_INTERVAL_MS = 500;
const RANDOM_LOOT_DISTRIBUTIONS = new Set([1, 2]);
const MAX_PARTY_MEMBERS = 9;
const MAX_COMPANIONS = MAX_PARTY_MEMBERS - 1;
const PARTY_POSITION_UPDATE_DISTANCE = 150;
const PARTY_MEMBER_UPDATE_INTERVAL_MS = 1000;
const FORMATION_OFFSETS = [
    { locX: -90, locY: -70 },
    { locX: -90, locY: 70 },
    { locX: -170, locY: -120 },
    { locX: -170, locY: 120 },
    { locX: -250, locY: 0 },
    { locX: -250, locY: -170 },
    { locX: -250, locY: 170 },
    { locX: -330, locY: 0 }
];
const ROLE_FORMATION_OFFSETS = {
    // Local +X is in front of the leader. Tanks screen the group while the
    // support line remains behind it; pull travel still overrides this slot.
    tank: [
        { locX: 90, locY: 0 },
        { locX: 45, locY: -90 },
        { locX: 45, locY: 90 }
    ],
    dagger: [
        { locX: 15, locY: -125 },
        { locX: 15, locY: 125 }
    ],
    dps: FORMATION_OFFSETS,
    archer: [
        { locX: -160, locY: -135 },
        { locX: -160, locY: 135 }
    ],
    mage: [
        { locX: -205, locY: -95 },
        { locX: -205, locY: 95 }
    ],
    healer: [
        { locX: -285, locY: -70 },
        { locX: -285, locY: 70 }
    ],
    buffer: [
        { locX: -330, locY: 0 },
        { locX: -275, locY: 145 }
    ],
    crafter: [
        { locX: -250, locY: 145 },
        { locX: -250, locY: -145 }
    ]
};

function world() {
    return invoke('GameServer/World/World');
}

function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function normalizeDistribution(distribution) {
    if (distribution === undefined || distribution === null) return DEFAULT_PARTY_DISTRIBUTION;
    const value = Number(distribution);
    return Number.isFinite(value) ? value : DEFAULT_PARTY_DISTRIBUTION;
}

function settingsForLeader(leaderSession) {
    if (!leaderSession) return { ...DEFAULT_PARTY_SETTINGS };
    if (!leaderSession.partyCompanionSettings) {
        leaderSession.partyCompanionSettings = { ...DEFAULT_PARTY_SETTINGS };
    }
    Object.keys(DEFAULT_PARTY_SETTINGS).forEach((key) => {
        if (!hasOwn(leaderSession.partyCompanionSettings, key)) {
            leaderSession.partyCompanionSettings[key] = DEFAULT_PARTY_SETTINGS[key];
        }
    });
    return leaderSession.partyCompanionSettings;
}

function getSettings(leaderSession) {
    return { ...settingsForLeader(leaderSession) };
}

function updateSettings(leaderSession, patch = {}) {
    const settings = settingsForLeader(leaderSession);
    Object.keys(patch).forEach((key) => {
        if (patch[key] !== undefined && (patch[key] !== null || key === 'pullerId')) {
            settings[key] = patch[key];
        }
    });
    return getSettings(leaderSession);
}

function distributionForLeader(leaderSession) {
    return normalizeDistribution(settingsForLeader(leaderSession).distribution);
}

function setDistribution(leaderSession, distribution) {
    const settings = settingsForLeader(leaderSession);
    const next = normalizeDistribution(distribution);
    if (settings.distribution !== next) {
        settings.distribution = next;
        // Turn order is meaningful only for the currently selected rule.
        settings.itemLastLootIndex = -1;
    }
    return settings.distribution;
}

function botSessions() {
    const BotManager = invoke('GameServer/Bot/BotManager');
    return BotManager.sessions || [];
}

function isActiveCompanion(session, leaderSession) {
    return !!(
        session &&
        session.actor &&
        session.followPlayerSession === leaderSession &&
        session.partyCompanion === true
    );
}

function distance2d(a, b) {
    const dx = a.fetchLocX() - b.fetchLocX();
    const dy = a.fetchLocY() - b.fetchLocY();
    return Math.sqrt((dx * dx) + (dy * dy));
}

function isAliveOnline(session) {
    const actor = session?.actor;
    return actor && actor.fetchIsOnline?.() === true && !actor.isDead?.();
}

function partyLeaderSession(session) {
    if (session?.partyCompanion === true && session.followPlayerSession) {
        return session.followPlayerSession;
    }
    return session;
}

function membersForLeader(leaderSession) {
    if (!leaderSession) return [];
    return botSessions().filter((session) => isActiveCompanion(session, leaderSession));
}

function hasCapacity(leaderSession, companionSession = null) {
    if (isActiveCompanion(companionSession, leaderSession)) return true;
    return membersForLeader(leaderSession).length < MAX_COMPANIONS;
}

function lootMembersForLeader(leaderSession, target) {
    const members = [leaderSession, ...membersForLeader(leaderSession)]
        .filter(isAliveOnline);

    if (!target?.fetchLocX || !target?.fetchLocY) {
        return members;
    }

    return members.filter((memberSession) => (
        memberSession.actor?.fetchLocX &&
        distance2d(memberSession.actor, target) <= PARTY_LOOT_RADIUS
    ));
}

function randomMember(members) {
    if (members.length === 0) return null;
    const index = Math.min(members.length - 1, Math.floor(Math.random() * members.length));
    return members[index];
}

function nextTurnMember(leaderSession, members) {
    if (members.length === 0) return null;

    const settings = settingsForLeader(leaderSession);
    const rawLastIndex = Number(settings.itemLastLootIndex);
    const lastIndex = Number.isFinite(rawLastIndex) ? rawLastIndex : -1;
    const nextIndex = (lastIndex + 1) % members.length;
    settings.itemLastLootIndex = nextIndex;
    return members[nextIndex];
}

function canPickGroundLoot(session, leaderSession, item) {
    const actor = session?.actor;
    if (!isActiveCompanion(session, leaderSession) || !isAliveOnline(session)) return false;
    // A finished fight often leaves the whole party seated.  Ground loot is
    // still available then: the chosen companion stands, picks it up and the
    // normal following/resting logic puts it back into formation afterwards.
    if (['getting_buffed', 'shopping', 'merchant'].includes(session.plan)) return false;
    const pullState = leaderSession?.partyPullState || {};
    if (
        ['approach', 'aggro', 'return'].includes(pullState.phase) &&
        Number(actor?.fetchId?.()) === Number(pullState.pullerId || 0)
    ) return false;
    // Companion pickup uses the server-side queue.  A stale storedPickup is
    // from the player ValidatePosition path and will never complete for a bot;
    // leaving it in place permanently excludes that companion from all later
    // ground drops.
    if (actor?.storedPickup) {
        delete actor.storedPickup;
    }
    return distance2d(actor, item) <= PARTY_LOOT_RADIUS;
}

function partyCombatInProgress(leaderSession) {
    // While the designated puller is travelling, its own movement/aggro must
    // not keep old drops locked. Every other real hostile action still does.
    return PartyCombatState.isActive(leaderSession, { ignoreTravellingPuller: true });
}

function queuedGroundLootIds(leaderSession) {
    return new Set(membersForLeader(leaderSession)
        .flatMap((memberSession) => memberSession.partyGroundPickupQueue || [])
        .map((entry) => Number(entry?.id || 0))
        .filter(Boolean));
}

function availableGroundLoot(leaderSession) {
    const members = [leaderSession, ...membersForLeader(leaderSession)]
        .filter(isAliveOnline);
    const queuedIds = queuedGroundLootIds(leaderSession);
    return (world().items?.spawns || [])
        .filter((item) => item?.fetchId && item?.fetchLocX && item?.fetchLocY)
        .filter((item) => !queuedIds.has(Number(item.fetchId())))
        .filter((item) => members.some((memberSession) => distance2d(memberSession.actor, item) <= PARTY_LOOT_RADIUS))
        .sort((a, b) => Number(a.fetchId()) - Number(b.fetchId()));
}

function hasCampThreat(leaderSession) {
    if (!world().user?.sessions) return false;

    const threat = PartyAwareness.findThreatTargetingParty(leaderSession);
    if (!threat) return false;

    const pullState = leaderSession?.partyPullState || {};
    const travellingPull = ['approach', 'aggro', 'return'].includes(pullState.phase);
    // The single mob a distant puller is deliberately bringing home is not
    // camp combat yet. Any other incoming target must preempt ground pickup.
    return !(
        travellingPull &&
        Number(threat.actor?.fetchId?.()) === Number(pullState.targetId || 0)
    );
}

function reconcileGroundLoot(looterSession) {
    const leaderSession = partyLeaderSession(looterSession);
    if (!leaderSession || partyCombatInProgress(leaderSession) || hasCampThreat(leaderSession)) return 0;

    const now = Date.now();
    if (now - Number(leaderSession.lastGroundLootScanAt || 0) < GROUND_LOOT_SCAN_INTERVAL_MS) return 0;
    const items = availableGroundLoot(leaderSession);
    // This shared timestamp protects the hot party from every companion
    // walking the entire world-item list on every AI tick. Fresh NPC drops do
    // not wait for this scan: NpcRewards queues them directly at spawn.
    leaderSession.lastGroundLootScanAt = now;
    if (items.length === 0) return 0;

    return items
        .reduce((assigned, item) => assigned + Number(!!queueRandomGroundPickup(leaderSession, item)), 0);
}

function nearestGroundLootPicker(looterSession, item) {
    const leaderSession = partyLeaderSession(looterSession);
    if (!leaderSession || !item || !RANDOM_LOOT_DISTRIBUTIONS.has(distributionForLeader(leaderSession))) return null;

    return membersForLeader(leaderSession)
        .filter((memberSession) => canPickGroundLoot(memberSession, leaderSession, item))
        .sort((a, b) => (
            distance2d(a.actor, item) - distance2d(b.actor, item) ||
            Number(a.actor.fetchId()) - Number(b.actor.fetchId())
        ))[0] || null;
}

function startQueuedGroundPickup(pickerSession) {
    const picker = pickerSession?.actor;
    const queue = pickerSession?.partyGroundPickupQueue;
    if (!picker || pickerSession.partyGroundPickupInProgress || !queue?.length) return false;
    const leaderSession = partyLeaderSession(pickerSession);
    // A queued drop is lower priority than a resurrection.  This also
    // protects queues that were assigned before a companion died, rather
    // than letting the only living support bot run away from the corpse.
    if ([leaderSession, ...membersForLeader(leaderSession)].some((memberSession) => memberSession?.actor?.isDead?.())) {
        return false;
    }
    // Re-check transient plans at execution time. A queue may have been
    // built while following and become stale after it starts a town/support
    // action. Merely assigning a bot as puller is not combat: when no pull
    // is in progress it may collect ground loot like every other companion.
    const pullState = leaderSession?.partyPullState || {};
    if (
        ['getting_buffed', 'shopping', 'merchant'].includes(pickerSession.plan) ||
        (
            ['approach', 'aggro', 'return'].includes(pullState.phase) &&
            Number(picker.fetchId?.()) === Number(pullState.pullerId || 0)
        )
    ) return false;
    if (partyCombatInProgress(leaderSession) || hasCampThreat(leaderSession)) return false;
    if (picker.state?.fetchPickinUp?.()) return false;

    const pickup = queue[0];
    pickerSession.partyGroundPickupInProgress = true;
    if (picker.state?.fetchSeated?.()) {
        picker.state.setSeated(false);
        pickerSession.dataSendToMeAndOthers?.(ServerResponse.sitAndStand(picker), picker);
    }
    const Generics = invoke(path.actor);
    Generics.stopAutomation(pickerSession, picker);
    Generics.pickupExec(pickerSession, picker, pickup, () => {
        if (queue[0]?.id === pickup.id) {
            queue.shift();
        } else {
            const index = queue.findIndex((entry) => entry.id === pickup.id);
            if (index >= 0) queue.splice(index, 1);
        }
        pickerSession.partyGroundPickupInProgress = false;
        startQueuedGroundPickup(pickerSession);
        // A completed queue entry can make another idle ground drop eligible
        // immediately. Do not wait for a later AI cadence just because the
        // original drop was assigned while the party was still fighting.
        reconcileGroundLoot(pickerSession);
    });
    return true;
}

function queueRandomGroundPickup(looterSession, item) {
    const pickerSession = nearestGroundLootPicker(looterSession, item);
    if (!pickerSession) return null;

    const pickup = { id: item.fetchId() };
    // Player pickup requests wait for the next client ValidatePosition.
    // Hot bots update their location server-side, so leaving this in
    // storedPickup makes the visible drop stay on the ground forever.
    // Keep an independent FIFO because a mob can drop Adena and items in
    // the same reward pass while Automation has only one pickup timer.
    pickerSession.partyGroundPickupQueue ??= [];
    pickerSession.partyGroundPickupQueue.push(pickup);
    startQueuedGroundPickup(pickerSession);
    return pickerSession;
}

function formationSlotFor(companionSession) {
    const leaderSession = companionSession?.followPlayerSession;
    const members = membersForLeader(leaderSession);
    const index = Math.max(0, members.indexOf(companionSession));
    const role = BotRoles.inferRole(companionSession?.actor);
    const sameRoleIndex = members
        .filter((memberSession) => BotRoles.inferRole(memberSession.actor) === role)
        .sort((a, b) => Number(a.actor?.fetchId?.()) - Number(b.actor?.fetchId?.()))
        .indexOf(companionSession);
    const offsets = ROLE_FORMATION_OFFSETS[role] || FORMATION_OFFSETS;
    return {
        index,
        role,
        offset: offsets[Math.max(0, sameRoleIndex) % offsets.length] || FORMATION_OFFSETS[index % FORMATION_OFFSETS.length]
    };
}

function formationTargetFor(companionSession) {
    const leader = companionSession?.followPlayerSession?.actor;
    if (!leader) return null;

    const slot = formationSlotFor(companionSession);
    // C4 heading is a 16-bit turn where zero faces +X. Formation offsets are
    // authored in leader-local space, so the group stays behind/beside the
    // leader as they change direction instead of forming against world north.
    const radians = (Number(leader.fetchHead?.() || 0) / 65536) * Math.PI * 2;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const locX = (slot.offset.locX * cos) - (slot.offset.locY * sin);
    const locY = (slot.offset.locX * sin) + (slot.offset.locY * cos);
    return {
        locX: Math.round(leader.fetchLocX() + locX),
        locY: Math.round(leader.fetchLocY() + locY),
        locZ: leader.fetchLocZ(),
        slot: slot.index
    };
}

function partyActorsForLeader(leaderSession) {
    return [leaderSession?.actor, ...membersForLeader(leaderSession).map((memberSession) => memberSession.actor)]
        .filter((actor) => actor?.fetchIsOnline?.() !== false);
}

function positionChanged(session, actor) {
    const previous = session?.lastPartyPosition;
    const next = { locX: actor.fetchLocX(), locY: actor.fetchLocY(), locZ: actor.fetchLocZ() };
    session.lastPartyPosition = next;
    if (!previous) return true;

    const dx = next.locX - previous.locX;
    const dy = next.locY - previous.locY;
    const dz = next.locZ - previous.locZ;
    return (dx * dx) + (dy * dy) + (dz * dz) >= PARTY_POSITION_UPDATE_DISTANCE * PARTY_POSITION_UPDATE_DISTANCE;
}

function sendPartyPositions(leaderSession, sourceSession = null, force = false) {
    const leader = leaderSession?.actor;
    if (!leader || !leaderSession?.dataSendToMe || membersForLeader(leaderSession).length === 0) return false;
    if (!force && sourceSession?.actor && !positionChanged(sourceSession, sourceSession.actor)) return false;

    leaderSession.dataSendToMe(ServerResponse.partyMemberPosition(partyActorsForLeader(leaderSession)));
    return true;
}

function sendPartyWindow(leaderSession, distribution = 0) {
    const leader = leaderSession?.actor;
    if (!leader || !leaderSession.dataSendToMe) return;

    const memberSessions = membersForLeader(leaderSession);
    const members = memberSessions
        .map((session) => session.actor)
        .filter(Boolean);

    leaderSession.dataSendToMe(ServerResponse.partySmallWindowDeleteAll());
    if (members.length > 0) {
        leaderSession.dataSendToMe(ServerResponse.partySmallWindowAll(leader.fetchId(), distribution, members));
        sendPartyPositions(leaderSession, null, true);
        leaderSession.dataSendToMe(ServerResponse.partySpelled.fromActor(leader));
        memberSessions.forEach((memberSession) => {
            if (memberSession.actor) {
                leaderSession.dataSendToMe(ServerResponse.partySpelled.fromActor(memberSession.actor));
            }
        });
    }
}

function restoreJoiningCompanion(session, bot) {
    bot.automation?.stopReplenish?.();
    // Joining the player party is a recovery convenience, not a revive or
    // level-up: restore exactly the requested HP and MP, leaving CP intact.
    if (typeof bot.setHp === 'function' && typeof bot.fetchMaxHp === 'function') {
        bot.setHp(bot.fetchMaxHp());
    }
    if (typeof bot.setMp === 'function' && typeof bot.fetchMaxMp === 'function') {
        bot.setMp(bot.fetchMaxMp());
    }

    if (bot.state?.fetchSeated?.() === true) {
        bot.state.setSeated(false);
        session?.dataSendToMeAndOthers?.(ServerResponse.sitAndStand(bot), bot);
    }
}

function renderPanel(leaderSession) {
    if (!leaderSession?.actor) return;
    try {
        const CompanionControl = invoke('GameServer/World/Generics/NpcBypasses/CompanionControl');
        if (CompanionControl?.render) {
            CompanionControl.render(leaderSession);
        }
    } catch (err) {
        utils.infoWarn('BotParty', 'companion panel refresh failed: %s', err.message);
    }
}

function refreshLeaderView(leaderSession, options = {}) {
    if (options.rebuildWindow !== false) {
        sendPartyWindow(leaderSession, distributionForLeader(leaderSession));
    }
    if (options.refreshPanel !== false) {
        renderPanel(leaderSession);
    }
}

function cancelCompanionAction(companionSession) {
    const actor = companionSession?.actor;
    if (!actor) return;
    actor.attack?.abortCast?.(companionSession, actor);
    actor.attack?.clearTimers?.();
    actor.state?.setHits?.(false);
    actor.state?.setCasts?.(false);
    actor.automation?.abortAll?.(actor);
    invoke('GameServer/Bot/AI/BotSupportPlanner').cancelSupportCast(companionSession, actor);
}

function detachState(companionSession, plan = 'hunting') {
    cancelCompanionAction(companionSession);
    companionSession.plan = plan;
    companionSession.followPlayerSession = null;
    companionSession.partyCompanion = false;
    companionSession.botStay = false;
    companionSession.stayLocation = null;
    companionSession.currentTargetId = undefined;
    companionSession.partyPuller = false;
    companionSession.roleDecision = null;
    companionSession.actor?.unselect?.();
}

function clearPullerIfDetached(leaderSession, companionSession) {
    const settings = settingsForLeader(leaderSession);
    if (settings.pullMode !== 'bot' || Number(settings.pullerId || 0) !== Number(companionSession?.actor?.fetchId?.())) {
        return false;
    }
    settings.pullMode = 'auto';
    settings.pullerId = null;
    leaderSession.partyPullState = {};
    return true;
}

const PartyCompanionService = {
    MAX_PARTY_MEMBERS,
    MAX_COMPANIONS,

    membersForLeader,

    hasCapacity,

    activeActorsForLeader(leaderSession) {
        return membersForLeader(leaderSession).map((session) => session.actor).filter(Boolean);
    },

    formationSlotFor,

    formationTargetFor,

    sendPartyPositions,

    updatePosition(session, actor) {
        const leaderSession = partyLeaderSession(session);
        if (!leaderSession || !actor) return false;
        if (session !== leaderSession && !isActiveCompanion(session, leaderSession)) return false;
        return sendPartyPositions(leaderSession, session, false);
    },

    lootMembersForLeader,

    distributionForLeader,

    getSettings,

    updateSettings,

    rebuildWindow(leaderSession, distribution) {
        const effectiveDistribution = arguments.length > 1
            ? setDistribution(leaderSession, distribution)
            : distributionForLeader(leaderSession);
        sendPartyWindow(leaderSession, effectiveDistribution);
    },

    refreshPanel(leaderSession) {
        renderPanel(leaderSession);
    },

    updateActorEffects(session) {
        const actor = session?.actor;
        if (!actor) return false;

        if (session.partyCompanion === true && session.followPlayerSession?.dataSendToMe) {
            session.followPlayerSession.dataSendToMe(ServerResponse.partySpelled.fromActor(actor));
            return true;
        }

        if (membersForLeader(session).length > 0 && session.dataSendToMe) {
            session.dataSendToMe(ServerResponse.partySpelled.fromActor(actor));
            return true;
        }

        return false;
    },

    resolveLootSession(looterSession, selfId, target) {
        const leaderSession = partyLeaderSession(looterSession);
        const members = lootMembersForLeader(leaderSession, target);
        if (!leaderSession || members.length <= 1) return looterSession;

        const distribution = distributionForLeader(leaderSession);
        if (distribution === 1 || distribution === 2) {
            return randomMember(members) || looterSession;
        }
        if (distribution === 3 || distribution === 4) {
            return nextTurnMember(leaderSession, members) || looterSession;
        }
        return members.includes(looterSession) ? looterSession : (leaderSession || looterSession);
    },

    adenaAllocations(looterSession, amount, target) {
        const total = Math.max(0, Math.floor(Number(amount) || 0));
        if (total <= 0) return [];

        const leaderSession = partyLeaderSession(looterSession);
        const members = lootMembersForLeader(leaderSession, target);
        if (!leaderSession || members.length <= 1) {
            return [{ session: looterSession, amount: total }];
        }

        const share = Math.floor(total / members.length);
        let remainder = total - (share * members.length);
        return members
            .map((memberSession) => {
                const extra = remainder > 0 ? 1 : 0;
                remainder -= extra;
                return { session: memberSession, amount: share + extra };
            })
            .filter((entry) => entry.amount > 0);
    },

    queueRandomGroundPickup,

    startQueuedGroundPickup,

    reconcileGroundLoot,

    attach(leaderSession, companionSession, options = {}) {
        const leader = leaderSession?.actor;
        const bot = companionSession?.actor;
        if (!leader || !bot) return false;
        if (!hasCapacity(leaderSession, companionSession)) return false;

        const previousLeader = companionSession.followPlayerSession;
        const distribution = hasOwn(options, 'distribution')
            ? setDistribution(leaderSession, options.distribution)
            : distributionForLeader(leaderSession);

        if (options.sendJoin !== false) {
            leaderSession.dataSendToMe(ServerResponse.joinParty(distribution));
        }

        restoreJoiningCompanion(companionSession, bot);
        companionSession.plan = 'following';
        companionSession.followPlayerSession = leaderSession;
        companionSession.partyCompanion = true;
        companionSession.botStay = false;
        companionSession.stayLocation = null;
        companionSession.currentTargetId = undefined;
        companionSession.partyPuller = false;
        companionSession.actor?.unselect?.();
        companionSession.autoTaunt = settingsForLeader(leaderSession).pullMode !== 'off';

        if (previousLeader && previousLeader !== leaderSession) {
            refreshLeaderView(previousLeader);
        }

        refreshLeaderView(leaderSession);
        return true;
    },

    detach(leaderSession, companionSession, options = {}) {
        if (!isActiveCompanion(companionSession, leaderSession)) return false;

        const BotManager = invoke('GameServer/Bot/BotManager');
        const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
        const event = options.event || null;
        const source = options.source || 'party';

        if (event) {
            BotSocialMemory.recordEvent(leaderSession, companionSession, event, source);
        }

        clearPullerIfDetached(leaderSession, companionSession);
        detachState(companionSession, options.plan || 'hunting');

        if (options.message) {
            BotManager.botSay(companionSession, options.message);
        }

        refreshLeaderView(leaderSession, options);
        return true;
    },

    detachAll(leaderSession, options = {}) {
        const members = membersForLeader(leaderSession);
        members.forEach((memberSession) => {
            this.detach(leaderSession, memberSession, {
                ...options,
                rebuildWindow: false,
                refreshPanel: false
            });
        });
        refreshLeaderView(leaderSession, options);
        return members.length;
    },

    clearCompanion(companionSession, options = {}) {
        const leaderSession = companionSession?.followPlayerSession || null;
        if (!companionSession?.partyCompanion) return false;
        if (leaderSession) clearPullerIfDetached(leaderSession, companionSession);
        detachState(companionSession, options.plan || 'hunting');
        if (leaderSession) {
            refreshLeaderView(leaderSession, options);
        }
        return true;
    },

    updateMember(companionSession) {
        if (!companionSession?.followPlayerSession || companionSession.partyCompanion !== true || !companionSession.actor) {
            return false;
        }

        const leaderSession = companionSession.followPlayerSession;
        if (!leaderSession.actor?.fetchIsOnline?.()) return false;
        const now = Date.now();
        if (now - Number(companionSession.lastPartyMemberUpdateAt || 0) >= PARTY_MEMBER_UPDATE_INTERVAL_MS) {
            leaderSession.dataSendToMe(ServerResponse.partySmallWindowUpdate(companionSession.actor));
            companionSession.lastPartyMemberUpdateAt = now;
        }
        // PartySpelled is sent by updateActorEffects when an effect actually
        // changes. Re-emitting it every bot AI tick flooded the C4 client.
        sendPartyPositions(leaderSession, companionSession, false);
        return true;
    }
};

module.exports = PartyCompanionService;
