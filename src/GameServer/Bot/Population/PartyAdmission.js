const MeetingFare = require('../../AfkTrade/MeetingFare');
const MeetingAnchor = require('../../AfkTrade/MeetingAnchor');
const { isMainThread } = require('node:worker_threads');

// The safety bound on background parties, derived from the population: a quarter
// of maxPlayingPopulation (half the bots in two-member parties; 425 at 1700). A
// party's round costs the worker about its members' solo rounds (measured: ~134 vs
// ~123 ms per simulated member-hour), so the bound guards against a runaway, not a
// CPU budget: the party decisions never reach it. A hit is counted (onCap).
const BOTS_PER_PARTY_SLOT = 4;
function limit(config) {
    return Math.max(0, Math.floor((Number(config?.maxPlayingPopulation) || 0) / BOTS_PER_PARTY_SLOT));
}

// All formation paths share this admission budget. Historical origin labels
// never grant slots or protect a party; reservations include in-flight commits.
// onCap: called on each reservation the bound refuses (the caller counts it).
class PartyAdmission {
    constructor({ onCap = null } = {}) { this.pending = 0; this.warWaiters = new Map(); this.managedWars = new Set(); this.onCap = onCap; }
    // The director refreshes these from cached roster readiness every five
    // seconds. Its FIFO survives slow diplomatic reviews and capacity waits.
    syncWarRequests(clanIds) {
        const next = new Set(clanIds);
        for (const id of this.managedWars) if (!next.has(id)) this.warWaiters.delete(id);
        const unmanaged = [...this.warWaiters].filter(([id]) => !this.managedWars.has(id) && !next.has(id));
        this.managedWars = next;
        this.warWaiters = new Map([...clanIds.map(id => [id, Infinity]), ...unmanaged]);
    }
    reserveWar(parties, config, clanId, now = Date.now()) {
        this.warWaiters.set(clanId, this.managedWars.has(clanId) ? Infinity : now + 60000);
        return this.reserve(parties, config, { warClanId: clanId, now });
    }
    canReclaim(parties, config) {
        // Reclaiming cannot satisfy an ordinary request while the next slots
        // belong to ready armies. Avoid dissolving unrelated parties in vain.
        return !this.warWaiters.size && parties.length + this.pending >= limit(config);
    }
    reserve(parties, config, { warClanId = null, now = Date.now() } = {}) {
        for (const [id, until] of this.warWaiters) if (until <= now) this.warWaiters.delete(id);
        const bound = limit(config);
        if (parties.length + this.pending >= bound) { this.onCap?.(); return null; }
        // Accepted military demand waits for a real free slot. It cannot
        // exceed the shared cap or interrupt an existing required contract.
        if (warClanId !== null) {
            if (this.warWaiters.keys().next().value !== warClanId) return null;
            this.warWaiters.delete(warClanId);
        } else if (bound - parties.length - this.pending <= this.warWaiters.size) return null;
        this.pending++;
        let released = false;
        return () => { if (!released) { released = true; this.pending--; } };
    }
}
// Waiting can eventually outweigh a fresh urgent request. Only a current open
// objective contributes age; stale metadata and group origin grant no priority.
function priority(objectives, timestamp) {
    const open = objectives.filter(o => o?.status === 'open');
    if (!open.length) return 0;
    return Math.max(...open.map(o => {
        const urgency = o.priority === 'required' ? 2 : 0;
        const requestedAt = Number(o.requestedAt || 0);
        const age = requestedAt > 0 ? Math.max(0, timestamp - requestedAt) : 0;
        return urgency + Math.min(6, age / 120000);
    }));
}
// E169: admission only. Existing group reviews and accepted trade receipts
// keep their native owner; no departure/return policy is introduced here.
function partyTradeAllowed(direction, state = {}, session = null, preparing = false, accepted = false) {
    if (direction === 'party') return !preparing && !accepted && !state?.stats?.tradeMeeting;
    if (direction === 'trade') return !(state?.party?.partyId || state?.partyId || state?.playerPartyId || state?.stats?.playerPartyTakeover?.playerId
        || session?.hotBackgroundPartyId || session?.partyCompanion || session?.followPlayerSession);
    throw new TypeError('invalid_party_trade_direction');
}
let tradeStateFor = id => typeof invoke === 'function'
    ? invoke('GameServer/Bot/Population/BotLifeState')?.cachedState?.(Number(id)) : null;
let tradeSessionFor = id => typeof invoke === 'function'
    ? invoke('GameServer/World/World')?.registeredActorById?.(Number(id))?.session : null;
// A player's meeting anchor: main keeps it, the cold worker mirrors it.
let playerAnchorFor = id => typeof invoke === 'function' && isMainThread
    ? invoke('GameServer/AfkTrade/TradeMeetingService').playerAnchor(id) : null;
function configureTradeAdmission(stateFor, sessionFor = () => null, anchorFor = () => null) {
    tradeStateFor = stateFor;
    tradeSessionFor = sessionFor;
    playerAnchorFor = anchorFor;
}
function personalOfferAllowed(offer, ownState, otherState, ownSession = null, otherSession = null) {
    if (!(offer?.conditional || offer?.custodyPolicy === 1)) return true;
    const otherId = Number(offer.ownerId ?? offer.sourceId);
    if (ownSession === null && ownState?.characterId) ownSession = tradeSessionFor(ownState.characterId);
    if (otherState === undefined) otherState = tradeStateFor(otherId);
    if (otherSession === null) otherSession = tradeSessionFor(otherId);
    const seller = Number(offer.storeType) === 3 ? ownState : otherState;
    // A side already committed to a meeting elsewhere cannot meet in this
    // offer's town until that meeting ends (its marker is rewritten then).
    return partyTradeAllowed('trade', ownState, ownSession) && partyTradeAllowed('trade', otherState, otherSession)
        && MeetingAnchor.compatible(offer.town, [
            MeetingAnchor.of(ownState, ownState || !ownSession?.actor ? null : playerAnchorFor(Number(ownSession.actor.fetchId()))),
            MeetingAnchor.of(otherState, otherState ? null : playerAnchorFor(otherId))])
        && MeetingFare.sellerCanReach(offer, seller);
}
module.exports = { PartyAdmission, limit, priority, partyTradeAllowed, personalOfferAllowed, configureTradeAdmission };
