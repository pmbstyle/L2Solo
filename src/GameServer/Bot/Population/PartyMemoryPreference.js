// One selection owns this cache; scoring performs no SQL and never changes memory.
function create({ memory = invoke('GameServer/Social/InteractionMemoryRuntime'), timestamp = Date.now() } = {}) {
    const pairs = new Map();
    const directed = (sourceId, targetId) => {
        const relation = memory.assess({ id: sourceId }, { id: targetId }, {}, timestamp);
        if (!relation.ready || !(relation.effective || relation.personal)) return 0;
        const p = relation.effective || relation.personal;
        return Math.max(-100, Math.min(100, p.affinity + p.trust * 2 - p.hostility * 2 - p.fear));
    };
    const pair = (a, b) => {
        const left = Number(a.characterId), right = Number(b.characterId);
        if (left === right) return 0;
        const key = left < right ? `${left}:${right}` : `${right}:${left}`;
        if (!pairs.has(key)) pairs.set(key, (directed(left, right) + directed(right, left)) / 2);
        return pairs.get(key);
    };
    return {
        score(state, peers) {
            return peers.length ? peers.reduce((sum, peer) => sum + pair(state, peer), 0) / peers.length : 0;
        },
        groupScore(members) {
            let total = 0, count = 0;
            for (let i = 0; i < members.length; i++) {
                for (let j = i + 1; j < members.length; j++) { total += pair(members[i], members[j]); count++; }
            }
            return count ? total / count : 0;
        }
    };
}

module.exports = { create };
