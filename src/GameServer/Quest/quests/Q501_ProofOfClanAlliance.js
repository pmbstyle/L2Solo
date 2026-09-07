const Rules = require('../../Clan/ClanAllianceRules');
const service = () => invoke('GameServer/Clan/ClanAllianceService');
const link = (event, text) => `<a action="bypass -h quest 501 ${event}">${text}</a><br>`;
const page = text => `<html><body>Proof of Clan Alliance:<br>${text}</body></html>`;
module.exports = {
    id: 501, name: 'Proof of Clan Alliance', npcs: Object.values(Rules.NPC), startNpcs: Object.values(Rules.NPC),
    sharedKillNpcs: [...Rules.HERBS.map(h => h.npcId), 5173, 5174, 5175, 5176, 5177],
    questSpawns: [5173, 5174, 5175, 5176, 5177],
    canTalk: state => Number(state.session.actor.fetchClanId?.()) > 0,
    eventNpc: event => ({ start: 7756, finish: 7756, ritual: 7759, poison: 7759, cure: 7759, fail: 7759,
        pledge: 7757, chests: 7758, blood: 7758, deliver: 7759 })[event] ?? null,
    async onTalk(log, npc) {
        const session = log.session;
        const state = await service().snapshot(session);
        const npcId = npc.fetchSelfId();
        if (!state || ['failed', 'completed'].includes(state.stage)) return page(npcId === Rules.NPC.rodemai
            ? 'A level 3 clan may attempt this trial. There is no character-level requirement.<br>' + link('start', 'Begin the trial.')
            : 'Your clan leader must speak to Sir Kristof Rodemai in Giran.');
        const leader = service().idOf(session) === state.leaderId;
        const member = state.members?.find(m => m.id === service().idOf(session));
        if (npcId === Rules.NPC.rodemai) return page(state.stage === 'cured' && leader
            ? link('finish', 'Present the Voucher of Faith.') : 'Visit Witch Kalis near Ivory Tower.');
        if (npcId === Rules.NPC.altar) return page(member && state.stage === 'loyalty' && !member.pledged
            ? 'The offering costs your life. Your allies may resurrect you.<br>' + link('pledge', 'Offer my life to the clan.')
            : 'Only the three selected clan members may make an offering.');
        if (npcId === Rules.NPC.athrea) return page(member?.blood && state.stage === 'gathering'
            ? 'Break my boxes and find four BINGOs within 60 seconds. The first attempt is free; retries cost 10,000 Adena.<br>'
                + (state.chests?.bingo >= 4 ? link('blood', 'Receive the Blood of Eva.') : link('chests', 'Begin the chest trial.'))
            : 'The clan member assigned Blood of Eva must take this trial.');
        let body = '';
        if (leader && state.stage === 'started') body = 'Bring three online clan members. Your party companions are selected first. No character-level restriction applies.<br>' + link('ritual', 'Choose the three members and begin the ritual.');
        if (state.stage === 'loyalty') body += `Loyalty offerings delivered: ${state.members.filter(m => m.loyaltyDelivered).length}/3.<br>`
            + (leader ? 'Wait for your members to return from the altar.<br>' + link('poison', 'Drink the poison and send them for ingredients.') : link('deliver', 'Hand my Symbol of Loyalty to the nearby leader.'));
        if (state.stage === 'gathering') {
            body += 'Keep a healer with the poisoned leader. Collect the three herbs and Blood of Eva. Bring the ingredients back to the leader before the poison kills them.<br>';
            for (const herb of Rules.HERBS) body += `${herb.name}: ${herb.area}.<br>`;
            body += `Herbs delivered: ${state.members.filter(m => m.delivered).length}/3. Blood of Eva: ${state.members.some(m => m.bloodDelivered) ? 'delivered' : 'pending'}.<br>`;
            if (member) body += `Your task: ${Rules.ITEMS[member.itemId]}${member.blood ? ' and Blood of Eva from Athrea' : ''}.<br>`;
            body += leader ? link('cure', 'Prepare and drink the antidote.') : link('deliver', 'Give my ingredients to the nearby leader.');
        }
        if (state.stage === 'cured') body += 'Return to Sir Kristof Rodemai in Giran for the Proof of Alliance and 120,000 SP.';
        if (leader) body += link('fail', 'Abandon this attempt.');
        return page(body);
    },
    async onAbort(log) { await service().transition(log.session, 'fail'); },
    async onEvent(log, event) {
        const result = await service().event(log.session, event);
        if (!result.ok) return page(`The trial cannot advance: ${String(result.code).replace(/_/g, ' ')}. Speak to the NPC again.`);
        if (event === 'finish') return page('Your clan has earned the Proof of Alliance. The clan leader needs 1,400,000 SP to raise the clan to level 4 at a Clan Manager.');
        return this.onTalk(log, { fetchSelfId: () => this.eventNpc(event) });
    }
};
