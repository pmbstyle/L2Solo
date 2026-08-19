const assert = require('assert');

require('../src/Global');

const Composition = invoke('GameServer/Bot/Population/BackgroundPartyComposition');
const Affinity = invoke('GameServer/Bot/Population/BackgroundPartyAffinity');
const PersonaPolicy = invoke('GameServer/Bot/Population/PersonaPartyPolicy');
const SUPPORT_ROLES = ['tank', 'healer', 'buffer'];

function levelOf(state) {
    return Math.max(1, Number(state?.level || 1));
}

function roleForState(state) {
    return state?.party?.role || state?.stats?.role || 'dps';
}

function coverageFor(states) {
    return states.reduce((coverage, state) => {
        const role = roleForState(state);
        coverage[role] = (coverage[role] || 0) + 1;
        return coverage;
    }, {});
}

function legacyCompare(anchor, coverage, peers = [anchor]) {
    return (a, b) => {
        const aRole = roleForState(a);
        const bRole = roleForState(b);
        const aSupport = SUPPORT_ROLES.includes(aRole) && !coverage[aRole] ? 0 : 1;
        const bSupport = SUPPORT_ROLES.includes(bRole) && !coverage[bRole] ? 0 : 1;
        if (aSupport !== bSupport) return aSupport - bSupport;
        const aAffinity = Affinity.affinity(a, peers);
        const bAffinity = Affinity.affinity(b, peers);
        if (aAffinity !== bAffinity) return bAffinity - aAffinity;
        const aDistance = Math.abs(levelOf(a) - levelOf(anchor));
        const bDistance = Math.abs(levelOf(b) - levelOf(anchor));
        if (aDistance !== bDistance) return aDistance - bDistance;
        const aPreference = PersonaPolicy.preference(a, peers, coverage).score;
        const bPreference = PersonaPolicy.preference(b, peers, coverage).score;
        if (aPreference !== bPreference) return bPreference - aPreference;
        return Number(a.characterId || 0) - Number(b.characterId || 0);
    };
}

function legacyBuildAround(anchor, candidates, maxSize, levelRange) {
    const eligible = candidates.filter((state) => Math.abs(levelOf(state) - levelOf(anchor)) <= levelRange);
    const selected = [anchor];
    const used = new Set([Number(anchor.characterId)]);
    const coverage = coverageFor(selected);
    SUPPORT_ROLES.forEach((role) => {
        if (selected.length >= maxSize || coverage[role]) return;
        const support = eligible
            .filter((state) => !used.has(Number(state.characterId)) && roleForState(state) === role)
            .sort(legacyCompare(anchor, coverage, selected))[0];
        if (!support) return;
        selected.push(support);
        used.add(Number(support.characterId));
        coverage[role] = 1;
    });
    eligible
        .filter((state) => !used.has(Number(state.characterId)))
        .sort(legacyCompare(anchor, coverage, selected))
        .some((state) => {
            if (selected.length >= maxSize) return true;
            selected.push(state);
            used.add(Number(state.characterId));
            const role = roleForState(state);
            coverage[role] = (coverage[role] || 0) + 1;
            return false;
        });
    const levels = selected.map(levelOf);
    const spread = Math.max(...levels) - Math.min(...levels);
    const supportCount = SUPPORT_ROLES.filter((role) => coverage[role]).length;
    return { members: selected, levelSpread: spread, score: supportCount * 1000 + selected.length * 100 - spread };
}

function legacySelectMembers(candidates, { minSize = 2, maxSize = 5, levelRange = 4 } = {}) {
    const unique = Array.from(new Map(candidates.map((state) => [Number(state.characterId), state])).values());
    const best = unique.reduce((current, anchor) => {
        const candidate = legacyBuildAround(anchor, unique, maxSize, levelRange);
        if (candidate.members.length < minSize) return current;
        if (!current || candidate.score > current.score) return candidate;
        if (candidate.score === current.score && candidate.levelSpread < current.levelSpread) return candidate;
        return current;
    }, null);
    return best?.members || [];
}

function seededRandom(seed) {
    let value = seed >>> 0;
    return () => {
        value = (value * 1664525 + 1013904223) >>> 0;
        return value / 0x100000000;
    };
}

const random = seededRandom(0x51a2c4);
const roles = ['tank', 'healer', 'buffer', 'dps', 'dps'];
for (let sample = 0; sample < 80; sample += 1) {
    const size = 5 + Math.floor(random() * 76);
    const candidates = Array.from({ length: size }, (_, index) => {
        const characterId = sample * 1000 + index + 1;
        const history = {};
        for (let peer = 0; peer < 4; peer += 1) {
            const peerId = sample * 1000 + 1 + Math.floor(random() * size);
            history[peerId] = { runs: Math.floor(random() * 6) };
        }
        return {
            characterId,
            level: 10 + Math.floor(random() * 16),
            party: { role: roles[Math.floor(random() * roles.length)] },
            stats: { partyHistory: history },
            persona: {
                primaryDrive: random() > 0.5 ? 'social' : 'progression',
                archetype: 'equivalence_probe',
                traits: {
                    sociability: random(), commitment: random(), empathy: random(),
                    ambition: random(), caution: random()
                }
            }
        };
    });
    const options = { minSize: 2, maxSize: 5, levelRange: 4 };
    const expected = legacySelectMembers(candidates, options).map((state) => state.characterId);
    const actual = Composition.selectMembers(candidates, options).map((state) => state.characterId);
    assert.deepStrictEqual(actual, expected, `top-K selection changed composition for sample ${sample}`);
}

const large = Array.from({ length: 600 }, (_, index) => ({
    characterId: 9000000 + index,
    level: 30 + (index % 5),
    party: { role: roles[index % roles.length] },
    stats: { partyHistory: {} },
    persona: {
        primaryDrive: 'progression', archetype: 'performance_probe',
        traits: { sociability: 0.5, commitment: 0.5, empathy: 0.5, ambition: 0.5, caution: 0.5 }
    }
}));
const startedAt = performance.now();
assert.strictEqual(Composition.selectMembers(large, { minSize: 2, maxSize: 5 }).length, 5);
console.log(`Party composition top-K equivalence checks passed large=${(performance.now() - startedAt).toFixed(1)}ms`);
