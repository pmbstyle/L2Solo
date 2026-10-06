// Native membership uses addressed current World registrations. Injected
// legacy worlds retain their snapshot; neither path adds spatial eligibility.
const REFRESH_MS = 250;
let source, revision, length = -1, expiresAt = 0;
let parties = new Map();

function keys(session) {
    const leader = session.partyCompanion === true ? session.followPlayerSession : session;
    const result = leader ? [leader] : [];
    const partyId = session.coldLifeState?.party?.partyId;
    if (!session.partyCompanion && partyId && partyId !== 'forming') result.push(`party:${partyId}`);
    return result;
}

function refresh() {
    const users = invoke('GameServer/World/World').user;
    const sessions = users?.sessions || [];
    const now = Date.now();
    if (sessions === source && users?.revision === revision && sessions.length === length && now < expiresAt) return;
    source = sessions; revision = users?.revision; length = sessions.length; expiresAt = now + REFRESH_MS;
    parties = new Map();
    for (const session of sessions) {
        if (!session?.actor) continue;
        for (const key of keys(session)) {
            if (!parties.has(key)) parties.set(key, new Set());
            parties.get(key).add(session);
        }
    }
}

function actor(id) {
    const lookup = Number(id);
    const registered = invoke('GameServer/World/World').registeredActorById(lookup);
    const current = registered?.actor;
    return Number(current?.fetchId?.()) === lookup ? current : null;
}

function members(session) {
    const World = invoke('GameServer/World/World');
    const native = World.pvpPartyMembershipIndex === true;
    if (native) {
        if (typeof World.pvpPartyMembershipKeys !== 'function' || typeof World.pvpPartySessionsForKey !== 'function') {
            throw new TypeError('invalid_party_membership_index');
        }
    } else {
        // Explicit legacy injected worlds retain their original snapshot reader.
        refresh();
    }
    const found = new Set([session, session?.partyCompanion ? session.followPlayerSession : null]);
    for (const key of native ? World.pvpPartyMembershipKeys(session) : keys(session)) {
        const selected = native ? World.pvpPartySessionsForKey(key) : parties.get(key) || [];
        for (const member of selected) found.add(member);
    }
    return [...found].filter(Boolean);
}

module.exports = { actor, members, invalidate() {
    expiresAt = 0; source = undefined; parties.clear();
}, REFRESH_MS };
