'use strict';

// These encounters have script-owned NPCs, heals and movement. They always
// execute through native actors, including when no real player is nearby.
const Rules = require('../../RaidBoss/GrandBossRules');
const pending = new Map();
let unsubscribe = null, unsubscribeBoss = null, running = false;
const objective = party => party?.stats?.objective;
const applies = party => objective(party)?.sourceKind === 'raid' && Rules.isGrandBoss(objective(party));
const expired = party => Number(objective(party)?.expiresAt) > 0 && Number(objective(party).expiresAt) <= Date.now();
function liveBoss(party) {
    const world = invoke('GameServer/World/World');
    const boss = invoke('GameServer/World/RaidEntityIndex').bossByTemplateId(world, Rules.templateId(objective(party)));
    return boss && !boss.isDead?.() && Number(boss.fetchHp?.()) > 0 ? boss : null;
}

function keepHot(party) {
    if (!applies(party) || party.status !== 'hot' || expired(party)
        || ['failed','defeated'].includes(party.stats?.raidEncounter?.status)) return false;
    return !!liveBoss(party);
}
function queue(party, delay = 1000) {
    if (!running || !applies(party) || party.status !== 'active' || pending.has(party.partyId)) return;
    const timer = setTimeout(async () => {
        pending.delete(party.partyId);
        if (!running) return;
        const parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
        const current = parties.find(party.partyId);
        if (!applies(current) || current.status !== 'active' || expired(current) || !liveBoss(current)) return;
        // Publication callbacks can run before the cold step's commit ACK.
        // A separate turn lets activate() fence and wait without blocking it.
        try {
            const result = await invoke('GameServer/Bot/Population/HotPartyLifecycle').activate(current.partyId, 'grand_boss_encounter');
            if (!result.ok) queue(parties.find(current.partyId), 5000);
        } catch (error) {
            utils.infoWarn('GrandBoss', 'party activation %s: %s', current.partyId, error.message);
            queue(parties.find(current.partyId), 5000);
        }
    }, delay);
    timer.unref?.();
    pending.set(party.partyId, timer);
}
function start() {
    stop(); running = true;
    const parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
    unsubscribe = parties.subscribeChanges(party => {
        if (party.status === 'active') queue(party);
        else { clearTimeout(pending.get(party.partyId)); pending.delete(party.partyId); }
    });
    unsubscribeBoss = invoke('GameServer/World/RaidEntityIndex').onBossChanged(id => {
        if (Rules.isGrandBoss(id)) for (const party of parties.admitted()) {
            if (Rules.templateId(objective(party)) === Number(id)) queue(party);
        }
    });
    for (const party of parties.admitted()) queue(party);
}
function stop() {
    running = false;
    unsubscribe?.(); unsubscribe = null;
    unsubscribeBoss?.(); unsubscribeBoss = null;
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
}
module.exports = { applies, keepHot, queue, start, stop };
