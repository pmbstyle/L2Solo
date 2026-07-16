const SUPPORT_ROLES = ['tank', 'healer', 'buffer'];
const DEFAULT_LEVEL_RANGE = 4;
const PartyAffinity = invoke('GameServer/Bot/Population/BackgroundPartyAffinity');

function levelOf(state) {
    return Math.max(1, Number(state?.level || 1));
}

function roleForState(state) {
    return state?.party?.role || state?.stats?.role || 'dps';
}

function roleCoverage(states) {
    return states.reduce((coverage, state) => {
        const role = roleForState(state);
        coverage[role] = (coverage[role] || 0) + 1;
        return coverage;
    }, {});
}

function compareCandidate(anchor, coverage, peers = [anchor]) {
    return (a, b) => {
        const aRole = roleForState(a);
        const bRole = roleForState(b);
        const aSupport = SUPPORT_ROLES.includes(aRole) && !coverage[aRole] ? 0 : 1;
        const bSupport = SUPPORT_ROLES.includes(bRole) && !coverage[bRole] ? 0 : 1;
        if (aSupport !== bSupport) return aSupport - bSupport;

        const aAffinity = PartyAffinity.affinity(a, peers);
        const bAffinity = PartyAffinity.affinity(b, peers);
        if (aAffinity !== bAffinity) return bAffinity - aAffinity;

        const aDistance = Math.abs(levelOf(a) - levelOf(anchor));
        const bDistance = Math.abs(levelOf(b) - levelOf(anchor));
        if (aDistance !== bDistance) return aDistance - bDistance;
        return Number(a.characterId || 0) - Number(b.characterId || 0);
    };
}

function buildAround(anchor, candidates, maxSize, levelRange) {
    const eligible = candidates.filter((state) => Math.abs(levelOf(state) - levelOf(anchor)) <= levelRange);
    const selected = [anchor];
    const used = new Set([Number(anchor.characterId)]);
    const coverage = roleCoverage(selected);

    SUPPORT_ROLES.forEach((role) => {
        if (selected.length >= maxSize || coverage[role]) return;
        const support = eligible
            .filter((state) => !used.has(Number(state.characterId)) && roleForState(state) === role)
            .sort(compareCandidate(anchor, coverage, selected))[0];
        if (!support) return;
        selected.push(support);
        used.add(Number(support.characterId));
        coverage[role] = 1;
    });

    eligible
        .filter((state) => !used.has(Number(state.characterId)))
        .sort(compareCandidate(anchor, coverage, selected))
        .some((state) => {
            if (selected.length >= maxSize) return true;
            selected.push(state);
            used.add(Number(state.characterId));
            const role = roleForState(state);
            coverage[role] = (coverage[role] || 0) + 1;
            return false;
        });

    const levels = selected.map(levelOf);
    const levelSpread = Math.max(...levels) - Math.min(...levels);
    const supportCount = SUPPORT_ROLES.filter((role) => coverage[role]).length;
    return {
        members: selected,
        coverage,
        levelSpread,
        score: supportCount * 1000 + selected.length * 100 - levelSpread
    };
}

function selectMembers(candidates = [], options = {}) {
    const maxSize = Math.max(2, Number(options.maxSize || 5));
    const minSize = Math.max(2, Math.min(maxSize, Number(options.minSize || 2)));
    const levelRange = Math.max(0, Number(options.levelRange ?? DEFAULT_LEVEL_RANGE));
    const unique = Array.from(new Map((candidates || [])
        .filter((state) => state?.characterId)
        .map((state) => [Number(state.characterId), state])).values());
    if (unique.length < minSize) return [];

    const best = unique.reduce((current, anchor) => {
        const candidate = buildAround(anchor, unique, maxSize, levelRange);
        if (candidate.members.length < minSize) return current;
        if (!current || candidate.score > current.score) return candidate;
        if (candidate.score === current.score && candidate.levelSpread < current.levelSpread) return candidate;
        return current;
    }, null);

    return best?.members || [];
}

function selectRecruits(members = [], candidates = [], options = {}) {
    const maxSize = Math.max(2, Number(options.maxSize || 5));
    const levelRange = Math.max(0, Number(options.levelRange ?? DEFAULT_LEVEL_RANGE));
    const leader = chooseLeader(members);
    if (!leader || members.length >= maxSize) return [];

    const used = new Set(members.map((state) => Number(state.characterId)));
    const coverage = roleCoverage(members);
    const eligible = (candidates || []).filter((state) => (
        state?.characterId &&
        !used.has(Number(state.characterId)) &&
        Math.abs(levelOf(state) - levelOf(leader)) <= levelRange
    ));
    const recruits = [];

    SUPPORT_ROLES.forEach((role) => {
        if (members.length + recruits.length >= maxSize || coverage[role]) return;
        const recruit = eligible
            .filter((state) => !used.has(Number(state.characterId)) && roleForState(state) === role)
            .sort(compareCandidate(leader, coverage, members))[0];
        if (!recruit) return;
        recruits.push(recruit);
        used.add(Number(recruit.characterId));
        coverage[role] = 1;
    });

    eligible
        .filter((state) => !used.has(Number(state.characterId)))
        .sort(compareCandidate(leader, coverage, members))
        .some((state) => {
            if (members.length + recruits.length >= maxSize) return true;
            recruits.push(state);
            used.add(Number(state.characterId));
            const role = roleForState(state);
            coverage[role] = (coverage[role] || 0) + 1;
            return false;
        });

    return recruits;
}

function chooseLeader(members = []) {
    return members.reduce((best, state) => {
        if (!best) return state;
        const bestTank = roleForState(best) === 'tank';
        const currentTank = roleForState(state) === 'tank';
        if (currentTank !== bestTank) return currentTank ? state : best;
        if (levelOf(state) !== levelOf(best)) return levelOf(state) > levelOf(best) ? state : best;
        return Number(state.characterId || 0) < Number(best.characterId || 0) ? state : best;
    }, null);
}

module.exports = { DEFAULT_LEVEL_RANGE, roleForState, roleCoverage, selectMembers, selectRecruits, chooseLeader };
