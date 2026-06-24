const ServerResponse = invoke('GameServer/Network/Response');

const DEFAULT_PARTY_DISTRIBUTION = 1;
const DEFAULT_PARTY_SETTINGS = {
    distribution: DEFAULT_PARTY_DISTRIBUTION,
    movementMode: 'follow',
    combatMode: 'assist',
    pullMode: 'auto'
};

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
        if (patch[key] !== undefined && patch[key] !== null) {
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
    settings.distribution = normalizeDistribution(distribution);
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

function membersForLeader(leaderSession) {
    if (!leaderSession) return [];
    return botSessions().filter((session) => isActiveCompanion(session, leaderSession));
}

function sendPartyWindow(leaderSession, distribution = 0) {
    const leader = leaderSession?.actor;
    if (!leader || !leaderSession.dataSendToMe) return;

    const members = membersForLeader(leaderSession)
        .map((session) => session.actor)
        .filter(Boolean);

    leaderSession.dataSendToMe(ServerResponse.partySmallWindowDeleteAll());
    if (members.length > 0) {
        leaderSession.dataSendToMe(ServerResponse.partySmallWindowAll(leader.fetchId(), distribution, members));
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

function detachState(companionSession, plan = 'hunting') {
    companionSession.plan = plan;
    companionSession.followPlayerSession = null;
    companionSession.partyCompanion = false;
    companionSession.botStay = false;
    companionSession.stayLocation = null;
    companionSession.currentTargetId = undefined;
    companionSession.roleDecision = null;
    companionSession.actor?.unselect?.();
}

const PartyCompanionService = {
    membersForLeader,

    activeActorsForLeader(leaderSession) {
        return membersForLeader(leaderSession).map((session) => session.actor).filter(Boolean);
    },

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

    attach(leaderSession, companionSession, options = {}) {
        const leader = leaderSession?.actor;
        const bot = companionSession?.actor;
        if (!leader || !bot) return false;

        const previousLeader = companionSession.followPlayerSession;
        const wasResting = companionSession.plan === 'resting';
        const distribution = hasOwn(options, 'distribution')
            ? setDistribution(leaderSession, options.distribution)
            : distributionForLeader(leaderSession);

        if (options.sendJoin !== false) {
            leaderSession.dataSendToMe(ServerResponse.joinParty(distribution));
        }

        companionSession.plan = wasResting ? 'resting' : 'following';
        companionSession.followPlayerSession = leaderSession;
        companionSession.partyCompanion = true;
        companionSession.botStay = false;
        companionSession.stayLocation = null;
        companionSession.currentTargetId = undefined;
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
        leaderSession.dataSendToMe(ServerResponse.partySmallWindowUpdate(companionSession.actor));
        return true;
    }
};

module.exports = PartyCompanionService;
