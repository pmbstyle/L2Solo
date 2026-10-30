#!/usr/bin/env node
'use strict';
const fs = require('node:fs'), path = require('node:path');
const file = process.argv[2] && path.resolve(process.argv[2]);
if (!file || !fs.existsSync(`${file}.fixture.json`)) throw Error('Pass a database created by scripts/clan-war-fixture.js');
const metadata = JSON.parse(fs.readFileSync(`${file}.fixture.json`, 'utf8'));
if (file !== metadata.database || file === path.resolve(metadata.source)) throw Error('The probe only accepts the saved test copy');
require('../src/Global');
options.default.Database.path = file;
const DB = invoke('Database'), Life = invoke('GameServer/Bot/Population/BotLifeState');
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState'), Clans = invoke('GameServer/Clan/ClanService');
const War = invoke('GameServer/Clan/ClanWarRuntime'), Social = invoke('GameServer/Clan/ClanSocialRuntime');
const Memory = invoke('GameServer/Social/InteractionMemoryRuntime');
const Population = invoke('GameServer/Bot/Population/PopulationService');
let director;
async function main() {
    invoke('GameServer/DataCache').init(); DB.init();
    await Life.init(); await Parties.init(); await Clans.reload(); await Social.refresh(true);
    Population.started = true;
    director = new (require('../src/GameServer/Clan/ClanWarDirector').ClanWarDirector)({ database: DB, life: Life,
        parties: Parties, clans: Clans, war: War, social: Social.view, memory: Memory,
        personaFor: state => invoke('GameServer/Bot/AI/BotPersona').of(state),
        form: (members, operation) => Population.formClanWarParty(members, operation),
        actions: { apply: async () => ({ ok: false, reason: 'probe_does_not_execute_combat' }) }, canWork: () => true });
    await director.start();
    for (let n = 0; n < 64; n++) await new Promise(resolve => setImmediate(resolve));
    const at = Date.now(), a = Clans.findById(metadata.from.id), b = Clans.findById(metadata.to.id);
    await director.review(a, at); await director.review(b, at);
    let releasedParty = null;
    if (process.argv.includes('--free-slot')) {
        // A test-only session completion exercises demand admission at a full
        // world budget. It uses the native whole-party release transaction.
        const Lifecycle = require('../src/GameServer/Bot/Population/BackgroundPartyLifecycle');
        for (const p of Parties.active()) {
            const members = await Life.statesForParty(p.partyId);
            if (p.stats?.warOperation || members.length !== p.memberIds.length || members.some(s =>
                s.phase !== 'cold' || s.stats?.travel || s.stats?.tradeMeeting || s.stats?.pvpEncounter
                || [a.id, b.id].includes(Clans.clanOfMember(s.characterId)?.id))) continue;
            const preparedParty = Parties.prepareCommit({ ...p, status: 'dissolved', memberIds: [],
                stats: { ...p.stats, dissolvedReason: 'fixture_session_completion' } });
            const prepared = members.map(s => Life.preparePartyReview(s, Lifecycle.releaseMember(s, at, 'party_session_rotation', p.stats?.objective)));
            const ended = await DB.commitBackgroundPartyMembership({ party: preparedParty.row, members: prepared,
                review: true, preserveClanOperations: true, expectedPartyRevision: p.revision });
            if (!ended.ok) continue;
            Life.acceptPartyAssignments(prepared, ended.lifeRows); Parties.acceptRow(ended.partyRow);
            releasedParty = p.partyId; break;
        }
    }
    for (const clan of [a, b]) {
        const plan = director.plans.get(clan.id);
        if (plan) await director.assemble(clan, plan, Date.now());
    }
    const result = { at: new Date().toISOString(), from: a.name, to: b.name, war: War.view.between(a.id, b.id),
        releasedParty, formation: Population.lastClanWarFormation,
        decisions: [a, b].map(c => ({ clan: c.name, available: director.ownMembers(c, at).length,
            freeRoles: director.ownMembers(c, at).filter(s => !s.party?.partyId && !s.partyId).reduce((out, s) => {
                const role = invoke('GameServer/Bot/AI/BotRoles').inferRole(s); out[role] = (out[role] || 0) + 1; return out;
            }, {}),
            witnessedClans: director.plans.get(c.id)?.intel?.map(i => i.enemyClanId),
            lastDecision: director.plans.get(c.id)?.lastDecision, sightings: director.plans.get(c.id)?.intel?.length || 0,
            lastOperation: director.plans.get(c.id)?.lastOperation || null })),
        operations: Parties.active().filter(p => p.stats?.warOperation).map(p => ({ partyId: p.partyId,
            members: p.memberIds, ...p.stats.warOperation })) };
    fs.writeFileSync(`${file}.probe.json`, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    if (!result.war.outgoing) throw Error('The real-world fixture did not produce a declaration; inspect readiness and leader decision');
}
main().catch(e => { console.error(e.stack); process.exitCode = 1; }).finally(async () => {
    director?.stop(); Population.started = false; await DB.close();
});
