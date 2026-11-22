const Rules = require('../../Clan/ClanAmbitionRules');
const Cost = require('../../Clan/ClanRules').LEVEL_REQUIREMENTS[4];
const { ID, NPC, ITEM, TALK } = Rules;
const service = () => invoke('GameServer/Clan/ClanAmbitionService');
const page = body => `<html><body>Pursuit of Clan Ambition!<br><br>${body}</body></html>`;
const link = (event, label) => `<a action="bypass -h quest ${ID} ${event}">${label}</a><br>`;
const JOURNAL = {
    1: 'Take Gustav’s letter to Martien by the north entrance to Giran.',
    2: 'Hunt Drakes and Thunder Wyrms in Dragon Valley. Search Fritz, Lutz and Kurtz for the rarer eggs. Deal with the Blitz Wyrms that appear by the bodies.',
    3: 'Return to Gustav in Oren.',
    4: 'Deliver the second letter to Balthazar in Hunters Village.',
    5: 'Hunt Lesser Giant Soldiers and Scouts in the Giant’s Cave. Balthazar needs ten working powerstones and ten crystals. A dwarf can use his recipe to repair broken stones.',
    6: 'Report the results to Gustav in Oren.',
    7: 'Deliver Gustav’s third letter to Sir Eric Rodemai in Aden.',
    8: 'Find Cleo beyond the bridge east of Aden.',
    9: 'Tell Sir Eric Rodemai what Cleo said.',
    10: 'Hunt Grave Guards until Grave Keymasters appear and collect six Imperial Keys. Then defeat the Imperial Gravekeeper and use the keys on the Imperial Coffer.',
    11: 'Take the scepter back to Gustav in Oren. You can report to Sir Eric Rodemai on the way.',
    12: 'Hand the Scepter of Judgment to Gustav in Oren.'
};
const totals = (items, requirements) => requirements.map(([id, max]) => `${Rules.NAMES[id]}: ${Rules.count(items, id)}/${max}<br>`).join('');

module.exports = {
    id: ID, name: 'Pursuit of Clan Ambition!', npcs: Object.values(NPC), startNpcs: [NPC.gustav],
    personalNpcs: [NPC.coffer], sharedKillNpcs: Rules.KILL_NPCS, questSpawns: Rules.DYNAMIC_NPCS,
    canTalk(log, npc) {
        if (!service().eligible(log.session)) return false;
        const cond = service().state(log.session).cond || 0;
        if (npc.fetchSelfId() === NPC.gustav || npc.fetchSelfId() === NPC.cleo && cond === 9) return true;
        if (npc.questSpawn?.ownerId && npc.questSpawn.ownerId !== log.actorId) return false;
        return Object.values(TALK).some(step => step.npc === npc.fetchSelfId() && step.from.includes(cond));
    },
    eventNpc: event => Object.hasOwn(TALK, event) ? TALK[event].npc : null,
    onTalk(log, npc) {
        const session = log.session;
        const state = service().state(session);
        const items = service().inventoryCounts(session);
        const cond = Number(state.cond) || 0;
        if (Rules.canTalkEvent(cond, items, 'restore_seal') && npc.fetchSelfId() === NPC.gustav)
            return page('If you lost the seal, Gustav can replace it.<br><br>' + link('restore_seal', TALK.restore_seal.label));
        if (cond === 13 || Rules.count(items, ITEM.seal))
            return page(`You have earned the Seal of Aspiration. Take it to a Clan Manager with ${Cost.sp.toLocaleString('en-US')} SP.`);
        const npcId = npc.fetchSelfId();
        let body = JOURNAL[cond] || 'Gustav seeks the help of a level 4 clan. His first commission will take you to Dragon Valley.';
        if (cond === 2) body += '<br><br>' + totals(items, Rules.EGGS);
        if (cond === 5) body += '<br><br>' + totals(items, Rules.GOLEM);
        if (cond === 10) body += '<br><br>' + totals(items, [[ITEM.key, Rules.KEYS]]);
        if (cond === 9 && npcId === NPC.cleo) body = 'The key is carried by the keeper’s servant. Seek the guarded tomb, and bring back what the old empire buried.';
        if (cond === 12 && npcId === NPC.gustav) body = 'Gustav plans to use the scepter to win the loyalty of soldiers. Give him the scepter to settle your bargain.';
        for (const [event, step] of Object.entries(TALK)) {
            if (step.npc !== npcId || !Rules.canTalkEvent(cond, items, event)) continue;
            const corpse = Rules.CORPSES[event];
            if (state[event] && corpse && state[event].kills >= (corpse.ambush || 0)) continue;
            body += '<br>' + link(event, step.label);
        }
        return page(body);
    },
    async onEvent(log, event) {
        const session = log.session;
        const npc = invoke('GameServer/World/NpcObjectIndex').find(invoke('GameServer/World/World'), session.activeNpcTalk?.objectId);
        const result = await service().event(session, event, npc);
        if (!result.ok) return page('This step is unavailable. Check the quest journal and speak to the NPC again.');
        return this.onTalk(log, npc);
    },
    onAbort: log => service().abort(log.session)
};
