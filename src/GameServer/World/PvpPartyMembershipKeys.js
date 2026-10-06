'use strict';

// Keep the original party key policy, including native Map key identities.
module.exports = function pvpPartyMembershipKeys(session) {
    const leader = session.partyCompanion === true ? session.followPlayerSession : session;
    const result = leader ? [leader] : [];
    const partyId = session.coldLifeState?.party?.partyId;
    if (!session.partyCompanion && partyId && partyId !== 'forming') result.push(`party:${partyId}`);
    return result;
};
