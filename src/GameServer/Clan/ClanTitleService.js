const Database = invoke('Database');
const Config = invoke('GameServer/Clan/ClanSimulationConfig');
const ClanService = invoke('GameServer/Clan/ClanService');
const ClanTitleBrain = invoke('GameServer/Clan/ClanTitleBrain');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');

const MAX_HISTORY_EVENTS = 5;
const TITLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 '&+.,:!?-]{1,31}$/;

const metrics = {
    snapshots: 0,
    skipped: 0,
    appliedClans: 0,
    appliedTitles: 0,
    invalid: 0,
    failed: 0
};

function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function cleanTitle(value) {
    return String(value || '').trim().replace(/\s+/g, ' ');
}

function compactGoal(goal) {
    if (!goal) return null;
    return {
        type: String(goal.type || ''),
        status: String(goal.status || ''),
        route: String(goal.plan?.kind || ''),
        target: String(goal.target?.itemName || goal.target?.npcName || goal.target?.name || '')
    };
}

function compactHistory(events = []) {
    return events.slice(0, MAX_HISTORY_EVENTS).map((event) => ({
        event: String(event.eventType || ''),
        goal: String(event.goalType || ''),
        route: String(event.plan || ''),
        reason: String(event.reasonCode || '')
    }));
}

async function snapshotFor(clan) {
    const members = (clan?.members || [])
        .map((member) => ({
            characterId: number(member.characterId || member.id),
            name: String(member.name || ''),
            title: cleanTitle(member.title),
            leader: number(member.characterId || member.id) === number(clan.leaderId),
            level: number(member.level),
            ...BotRoles.presentation(member.classId)
        }))
        .filter((member) => member.characterId > 0)
        .sort((left, right) => Number(right.leader) - Number(left.leader) || left.characterId - right.characterId);
    const missingMemberIds = members.filter((member) => !member.title).map((member) => member.characterId);
    const events = missingMemberIds.length
        ? await Database.fetchClanGoalEvents(clan.id, MAX_HISTORY_EVENTS)
        : [];
    metrics.snapshots += 1;
    return {
        key: `clan:${number(clan.id)}:titles:v1:${missingMemberIds.join(',')}`,
        missingMemberIds,
        context: {
            clan: {
                name: String(clan.name || ''),
                level: number(clan.level),
                memberCount: members.length,
                currentGoal: compactGoal(clan.state?.goal || null)
            },
            members,
            recentHistory: compactHistory(events),
            assignOnlyMemberIds: missingMemberIds
        }
    };
}

function validateAssignments(snapshot, assignments) {
    const expected = snapshot.missingMemberIds;
    if (!Array.isArray(assignments) || assignments.length !== expected.length) {
        return { ok: false, code: 'invalid_clan_titles' };
    }
    const expectedIds = new Set(expected);
    const seenIds = new Set();
    const seenTitles = new Set((snapshot.context?.members || [])
        .map((member) => cleanTitle(member.title).toLowerCase())
        .filter(Boolean));
    const normalized = [];
    for (const assignment of assignments) {
        const characterId = number(assignment?.characterId);
        const title = cleanTitle(assignment?.title);
        const titleKey = title.toLowerCase();
        if (!expectedIds.has(characterId) || seenIds.has(characterId) || !TITLE_PATTERN.test(title) || seenTitles.has(titleKey)) {
            return { ok: false, code: 'invalid_clan_titles' };
        }
        seenIds.add(characterId);
        seenTitles.add(titleKey);
        normalized.push({ characterId, title });
    }
    if (seenIds.size !== expectedIds.size) return { ok: false, code: 'invalid_clan_titles' };
    return { ok: true, assignments: normalized };
}

async function resolveClan(clan, options = {}) {
    if (Config.llmTitleManagementEnabled === false) {
        metrics.skipped += 1;
        return { ok: true, skipped: true, code: 'llm_titles_disabled' };
    }
    if (!clan || number(clan.level) < 3) {
        metrics.skipped += 1;
        return { ok: true, skipped: true, code: 'clan_titles_unavailable' };
    }
    const snapshot = await (options.snapshotFor || snapshotFor)(clan);
    if (!snapshot.missingMemberIds.length) {
        metrics.skipped += 1;
        return { ok: true, skipped: true, code: 'clan_titles_complete' };
    }
    const decision = ClanTitleBrain.choose(clan, snapshot, options);
    if (decision.pending) {
        return { ok: true, pending: true, code: decision.code, decisionKey: decision.key };
    }
    if (!decision.ok) {
        metrics.failed += 1;
        return decision;
    }
    const validated = validateAssignments(snapshot, decision.assignments);
    if (!validated.ok) {
        metrics.invalid += 1;
        ClanTitleBrain.forget(snapshot.key);
        return { ...validated, retryable: true };
    }
    const applied = await ClanService.applyAutonomousMemberTitles(clan.id, validated.assignments);
    if (!applied.ok) {
        metrics.failed += 1;
        return applied;
    }
    metrics.appliedClans += applied.updated?.length ? 1 : 0;
    metrics.appliedTitles += applied.updated?.length || 0;
    if (applied.updated?.length) {
        await Database.recordClanGoalEvent({
            clanId: clan.id,
            eventType: 'llm_titles_assigned',
            reasonCode: 'clan_identity',
            payload: { assignments: applied.updated.map(({ characterId, title }) => ({ characterId, title })) }
        });
    }
    return {
        ok: true,
        changed: (applied.updated?.length || 0) > 0,
        updated: applied.updated || [],
        source: 'llm',
        usage: decision.usage || null
    };
}

module.exports = {
    MAX_HISTORY_EVENTS,
    TITLE_PATTERN,
    cleanTitle,
    compactHistory,
    snapshotFor,
    validateAssignments,
    available() {
        return Config.llmTitleManagementEnabled !== false && !!ClanTitleBrain.configured();
    },
    resolveClan,
    metrics() {
        return { ...metrics, llm: ClanTitleBrain.metrics() };
    },
    resetMetrics() {
        Object.keys(metrics).forEach((key) => { metrics[key] = 0; });
        ClanTitleBrain.reset();
    }
};
