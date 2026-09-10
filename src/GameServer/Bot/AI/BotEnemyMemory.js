const LIMIT = 3;
const ATTACK_WINDOW_MS = 60000;
const KILL_WEIGHT = 10;

function score(entry) {
    // Repeated swings cannot outweigh a death or inflate the counters forever.
    return entry.kills * KILL_WEIGHT + Math.min(3, entry.attacks);
}

function normalize(entries) {
    const unique = new Map();
    for (const raw of Array.isArray(entries) ? entries : []) {
        const id = Number(raw?.id);
        if (!Number.isSafeInteger(id) || id <= 0) continue;
        const entry = {
            id, name: String(raw.name || '').replace(/[\x00-\x1f]/g, '').slice(0, 24),
            kills: Math.min(1000, Math.max(0, Math.floor(Number(raw.kills) || 0))),
            attacks: Math.min(3, Math.max(0, Math.floor(Number(raw.attacks) || 0))),
            lastAttackAt: Math.max(0, Number(raw.lastAttackAt) || 0),
            lastSeenAt: Math.max(0, Number(raw.lastSeenAt) || 0)
        };
        if (entry.kills || entry.attacks) unique.set(id, entry);
    }
    return [...unique.values()].sort((a, b) => score(b) - score(a) || b.lastSeenAt - a.lastSeenAt || a.id - b.id).slice(0, LIMIT);
}

function entries(session) {
    if (!session) return [];
    if (!session.pvpEnemyMemory) {
        const persisted = session.coldLifeState || session.coldMarketState || session.coldCraftState ||
            invoke('GameServer/Bot/Population/BotLifeState').cachedState(session.actor?.fetchId?.());
        session.pvpEnemyMemory = normalize(persisted?.stats?.pvpEnemies);
    }
    return session.pvpEnemyMemory;
}

function record(victim, attacker, killed = false, now = Date.now()) {
    const session = victim?.session;
    if (!String(session?.accountId || '').startsWith('bot_') || session.arenaEphemeral ||
        !attacker || attacker.fetchKind || victim === attacker || victim.state?.fetchDead?.()) return false;
    const id = Number(attacker.fetchId?.());
    if (!id) return false;
    const known = entries(session);
    invoke('GameServer/Social/PvpInteractionMemory').record(session, id, killed, now, known);
    const entry = known.find(enemy => enemy.id === id) || { id, kills: 0, attacks: 0, lastAttackAt: 0 };
    if (!killed && entry.attacks && now - entry.lastAttackAt < ATTACK_WINDOW_MS) return false;
    const updated = { ...entry, name: attacker.fetchName?.() || entry.name || '', lastSeenAt: now };
    if (killed) updated.kills++;
    else { updated.attacks++; updated.lastAttackAt = now; }
    session.pvpEnemyMemory = normalize([...known.filter(enemy => enemy.id !== id), updated]);
    // Preserve the two strongest remembered enemies and admit the latest
    // killer. Otherwise a discarded newcomer starts at one death forever.
    if (killed && !session.pvpEnemyMemory.some(enemy => enemy.id === id)) {
        session.pvpEnemyMemory = normalize([...normalize(known).slice(0, LIMIT - 1), updated]);
    }
    if (JSON.stringify(session.pvpEnemyMemory) === JSON.stringify(known)) return false;
    // One compact write per accepted incident/death, never per damage tick.
    // The existing lifecycle write queue also orders this against cooldown.
    invoke('GameServer/Bot/Population/BotLifeState').rememberEnemies(session);
    return true;
}

function snapshot(session) {
    return normalize(entries(session));
}

module.exports = { record, entries, snapshot, normalize, score, LIMIT, ATTACK_WINDOW_MS, KILL_WEIGHT };
