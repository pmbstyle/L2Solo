'use strict';

// Party membership commits as one database transaction (party row, member
// rows, event). Fixtures without a database route that transaction through
// their own BackgroundPartyState.createOrUpdate / BotLifeState.assignParty /
// BotLifeEvents.record recorders, whatever those are when the commit runs.
// Returns the restore function.
function install() {
    const Database = invoke('Database');
    const PartyState = invoke('GameServer/Bot/Population/BackgroundPartyState');
    const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
    const LifeEvents = invoke('GameServer/Bot/Population/BotLifeEvents');
    const original = Database.commitBackgroundPartyMembership;
    Database.commitBackgroundPartyMembership = async ({ party: row, members: entries, event }) => {
        const committed = PartyState.acceptRow(row);
        await PartyState.createOrUpdate(committed);
        for (const { snapshot } of entries) {
            await LifeState.assignParty(snapshot, committed.partyId, snapshot.party.role, committed.leaderId);
        }
        if (event) await LifeEvents.record(event.characterId, event.eventType, event.summary, event.meta, event.weight);
        return { ok: true, partyRow: row, lifeRows: [] };
    };
    return () => { Database.commitBackgroundPartyMembership = original; };
}

module.exports = { install };
