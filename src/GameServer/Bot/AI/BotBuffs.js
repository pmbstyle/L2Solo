const ServerResponse = invoke('GameServer/Network/Response');

const BUFF_DURATION_MS = 20 * 60 * 1000;
const REFRESH_THRESHOLD_MS = 2 * 60 * 1000;

const NEWBIE_BUFFS = {
    windwalk: { key: 'windWalk', id: 1204, name: 'Wind Walk' },
    shield: { key: 'shield', id: 1040, name: 'Shield' },
    haste: { key: 'haste', id: 1086, name: 'Haste' }
};

function ensureStore(actor) {
    if (!actor.activeBuffs) {
        actor.activeBuffs = {};
    }
    return actor.activeBuffs;
}

function now() {
    return Date.now();
}

function isNewbieEligible(actor) {
    return actor && actor.fetchLevel() <= 25 && actor.fetchKarma() === 0;
}

function remainingMs(actor, key) {
    if (!actor?.activeBuffs?.[key]) return 0;
    return Math.max(0, actor.activeBuffs[key] - now());
}

function missingNewbieBuffs(actor, thresholdMs = 0) {
    return Object.values(NEWBIE_BUFFS)
        .filter((buff) => remainingMs(actor, buff.key) <= thresholdMs)
        .map((buff) => buff.key);
}

function needsNewbieRefresh(actor, thresholdMs = REFRESH_THRESHOLD_MS) {
    return isNewbieEligible(actor) && missingNewbieBuffs(actor, thresholdMs).length > 0;
}

function refreshActorPackets(session, actor, Generics) {
    const actorGenerics = Generics || invoke(path.actor);

    actor.statusUpdateVitals(actor);
    actorGenerics.calculateStats(session, actor);

    session.dataSendToMe(ServerResponse.userInfo(actor));
    session.dataSendToMe(ServerResponse.abnormalStatusUpdate.fromActor(actor));

    if (session.accountId && String(session.accountId).startsWith('bot_')) {
        session.dataSendToOthers(ServerResponse.charInfo(actor), actor);
        session.dataSendToOthers(ServerResponse.relationChanged(actor), actor);
    }
}

function applyNewbieBuff(session, actor, buffType, Generics) {
    const buff = NEWBIE_BUFFS[buffType];
    if (!buff || !actor) return null;

    const store = ensureStore(actor);
    store[buff.key] = now() + BUFF_DURATION_MS;
    refreshActorPackets(session, actor, Generics);

    return {
        key: buff.key,
        name: buff.name,
        expiresAt: store[buff.key]
    };
}

function applyFullNewbieBlessing(session, actor, Generics) {
    if (!actor) return null;

    const store = ensureStore(actor);
    const expiresAt = now() + BUFF_DURATION_MS;
    Object.values(NEWBIE_BUFFS).forEach((buff) => {
        store[buff.key] = expiresAt;
    });

    actor.setHp(actor.fetchMaxHp());
    actor.setMp(actor.fetchMaxMp());
    refreshActorPackets(session, actor, Generics);

    return {
        buffs: Object.values(NEWBIE_BUFFS).map((buff) => buff.key),
        expiresAt
    };
}

function snapshot(actor) {
    const buffs = {};
    Object.values(NEWBIE_BUFFS).forEach((buff) => {
        buffs[buff.key] = Math.round(remainingMs(actor, buff.key) / 1000);
    });

    return {
        eligible: isNewbieEligible(actor),
        needsRefresh: needsNewbieRefresh(actor),
        ...buffs
    };
}

module.exports = {
    BUFF_DURATION_MS,
    REFRESH_THRESHOLD_MS,
    NEWBIE_BUFFS,
    applyNewbieBuff,
    applyFullNewbieBlessing,
    isNewbieEligible,
    missingNewbieBuffs,
    needsNewbieRefresh,
    remainingMs,
    snapshot
};
