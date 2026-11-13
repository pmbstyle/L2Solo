'use strict';
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Rules = invoke('GameServer/Skills/C4SkillRules');
const Loadout = invoke('GameServer/Bot/AI/PartyBuffLoadout');
const Policy = invoke('GameServer/Bot/Economy/BuffServicePolicy');
const MAX_OFFER_BYTES = 512, MAX_PROVIDERS = 16;

function available(state) {
    return state?.phase === 'cold' && ['hunting', 'resting'].includes(state.activity)
        && !!state.spotId && !state.party?.partyId && !state.partyId
        && !state.stats?.backgroundPartyId && !state.stats?.pveEncounter && !state.stats?.pvpEncounter
        && Number(state.vitals?.hp || 0) > 0;
}

function skillAdapter(record) {
    const resolved = Profile.skillSnapshotsFromRecords([record])[0] || record;
    const semantic = Rules.resolve({ selfId: Number(record.selfId), level: Number(record.level || 1) });
    return {
        record, semantic,
        fetchSelfId: () => Number(record.selfId),
        fetchLevel: () => Number(record.level || 1),
        fetchSemantic: () => semantic,
        fetchTargetKind: () => semantic.target,
        fetchConsumedMp: () => Math.max(0, Number(resolved.mp ?? semantic.mpConsume ?? 0)),
        fetchBuffTime: () => Math.max(0, Number(resolved.buffTime ?? semantic.durationMs ?? 0))
    };
}

// The gates of one sale: both bots trade here (a buyer buys when its rebuff answers a
// buffer, Bot/AI/Rebuff: no cooldown of its own).
function canServe(provider, recipient) {
    return available(provider) && available(recipient) && provider.spotId === recipient.spotId
        && provider.characterId !== recipient.characterId && Policy.serviceClass(provider);
}

// The provider's sellable buffs depend only on the provider: one project
// builds them once for all its recipients.
function providerSkills(provider, timestamp) {
    return (Profile.profileFor(provider, timestamp).skills || [])
        .filter(record => !record.passive)
        .map(skillAdapter)
        .filter(Policy.eligibleSkill);
}

function select(provider, recipient, timestamp = Date.now()) {
    if (!canServe(provider, recipient)) return null;
    return choose(provider, recipient, timestamp, providerSkills(provider, timestamp));
}

function choose(provider, recipient, timestamp, skills) {
    const active = (recipient.stats?.coldCombat?.effects || [])
        .filter(effect => Number(effect.expiresAt || 0) > timestamp);
    const byFamily = new Map();
    skills
        .filter(skill => Loadout.useful(recipient, skill))
        .forEach(skill => {
            const semantic = skill.fetchSemantic();
            const family = Loadout.family(semantic.effect);
            if (active.some(effect => Loadout.family(effect.key) === family
                && Number(effect.level || 0) >= skill.fetchLevel())) return;
            const previous = byFamily.get(family);
            if (!previous || previous.fetchLevel() < skill.fetchLevel()) byFamily.set(family, skill);
        });
    const selected = [];
    let mpCost = 0;
    const mpBudget = Math.max(0, Number(provider.vitals?.mp || 0) - Number(provider.vitals?.maxMp || 0) * 0.2);
    for (const skill of byFamily.values()) {
        const cost = skill.fetchConsumedMp();
        if (selected.length >= 12 || mpCost + cost > mpBudget) continue;
        selected.push(skill);
        mpCost += cost;
    }
    if (!selected.length) return null;
    return { selected, mpCost };
}

function effectsFor(selected, timestamp) {
    return selected.map(skill => {
        const semantic = skill.fetchSemantic();
        const durationMs = Math.max(60000, Number(semantic.durationMs ?? skill.fetchBuffTime()) || 20 * 60000);
        const key = Loadout.normalize(semantic.effect);
        return { key, id: skill.fetchSelfId(), level: skill.fetchLevel(), name: semantic.effect,
            type: 'buff', durationMs, expiresAt: timestamp + durationMs,
            stackFamily: semantic.stackFamily || Loadout.family(key),
            stackOrder: semantic.stackOrder ?? null, stats: { ...(semantic.stats || {}) } };
    });
}

// The buffer at a buyer's spot its rebuff buys from (ColdSimulationWorker's
// decision): the first of the spot's buffers (service classes other than the buyer),
// at most MAX_PROVIDERS of them looked at (a buffer left past them counted
// rebuff:buffer:capped), that sells it support now within its price read
// (BuffServicePolicy.affordable; trust is the sale's, read by main when it prices
// it). units: the spot's [key, state] pairs or states. Its id, or null.
function providerFor(recipient, units, timestamp = Date.now()) {
    if (!available(recipient)) return null;
    let looked = 0;
    for (const entry of units) {
        const provider = Array.isArray(entry) ? entry[1] : entry;
        if (!provider || provider.characterId === recipient.characterId || !Policy.serviceClass(provider)) continue;
        if (looked++ >= MAX_PROVIDERS) { require('../Situations').note('rebuff:buffer:capped'); return null; }
        const choice = select(provider, recipient, timestamp);
        if (!choice) continue;
        const price = Policy.priceFor({ provider, recipient, mp: choice.mpCost, count: choice.selected.length, town: false });
        if (Policy.affordable(price, recipient.adena, recipient)) return Number(provider.characterId);
    }
}

// The sale a buyer's rebuff answered (its named provider at its spot): the packet
// main applies (ColdBuffService.applyOffer), or null when the provider sells it
// nothing now. A buyer asks it once per answer (the step's buffOffer).
function offer(provider, recipient, timestamp = Date.now()) {
    const choice = select(provider, recipient, timestamp);
    if (!choice) return null;
    // ARCH-NOTE: Full effect objects exceed 0.5 KB. Native id/rank tuples
    // restore the identical static effects on main without a combat review.
    const packet = { providerId: Number(provider.characterId), recipientId: Number(recipient.characterId),
        providerRevision: Number(provider.simulation?.revision || 0), recipientRevision: Number(recipient.simulation?.revision || 0),
        spotId: provider.spotId, mpCost: choice.mpCost,
        effects: choice.selected.map(skill => [skill.fetchSelfId(), skill.fetchLevel()]), timestamp };
    return Buffer.byteLength(JSON.stringify(packet), 'utf8') <= MAX_OFFER_BYTES ? packet : null;
}
function expand(effects, timestamp) {
    return effectsFor(effects.map(([selfId, level]) => skillAdapter({ selfId, level })), timestamp);
}
module.exports = { available, skillAdapter, select, choose, effectsFor, providerFor, offer, expand,
    MAX_OFFER_BYTES, MAX_PROVIDERS };
