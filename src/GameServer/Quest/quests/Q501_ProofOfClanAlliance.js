const Rules = require('../../Clan/ClanAllianceRules');
const service = () => invoke('GameServer/Clan/ClanAllianceService');
const link = (event, text) => `<a action="bypass -h quest 501 ${event}">${text}</a><br>`;
const escape = value => String(value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);
const memberName = id => escape(service().sessions().find(s => service().idOf(s) === id)?.actor.fetchName?.() || `Member ${id}`);
const page = text => `<html><body>Proof of Clan Alliance:<br>${text}</body></html>`;
module.exports = {
    id: 501, name: 'Proof of Clan Alliance', npcs: Object.values(Rules.NPC), startNpcs: Object.values(Rules.NPC),
    sharedKillNpcs: [...Rules.HERBS.map(h => h.npcId), 5173, 5174, 5175, 5176, 5177],
    questSpawns: [5173, 5174, 5175, 5176, 5177],
    canTalk: state => Number(state.session.actor.fetchClanId?.()) > 0,
    eventNpc: event => ['assign', 'choose_blood', 'status'].includes(service().eventName(event)) ? Rules.NPC.kalis : ({ start: 7756, finish: 7756, ritual: 7759, poison: 7759, cure: 7759, fail: 7759,
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
            ? 'Each box breaks with one damaging hit. Find four BINGOs within 60 seconds. The first attempt is free; retries cost 10,000 Adena.<br>'
                + (state.chests?.bingo >= 4 ? link('blood', 'Receive the Blood of Eva.') : link('chests', 'Begin the chest trial.'))
            : 'The clan member assigned Blood of Eva must take this trial.');
        let body = '';
        if (leader && state.stage === 'started') {
            body = 'Assign one clan member to each herb. Leave a healer with you if needed. There is no character-level requirement.<br>'
                + 'The Oel Mahum courier also collects Blood of Eva by default. Athrea\'s boxes break with one damaging hit; find four BINGOs within 60 seconds. Retries cost 10,000 Adena.<br>';
            const selected = state.selection || [0, 0, 0];
            Rules.HERBS.forEach((herb, slot) => {
                body += `${herb.name}: ${selected[slot] ? memberName(selected[slot]) : 'Unassigned'}<br>`;
            });
            body += '<br>Available members:<br>';
            const available = service().candidates(session);
            const pageIndex = Math.min(Math.max(0, session.clanAlliancePage || 0), Math.max(0, Math.ceil(available.length / 4) - 1));
            for (const candidate of available.slice(pageIndex * 4, pageIndex * 4 + 4)) {
                const id = service().idOf(candidate);
                body += `${memberName(id)} (level ${candidate.actor.fetchLevel()}):<br>`;
                Rules.HERBS.forEach((herb, slot) => { body += link(`assign_${slot}_${id}`, `Assign ${herb.name}${slot === 2 ? ' (Blood of Eva by default)' : ''}`); });
            }
            if (pageIndex > 0) body += link(`status_${pageIndex - 1}`, 'Previous members');
            if ((pageIndex + 1) * 4 < available.length) body += link(`status_${pageIndex + 1}`, 'More members');
            const bloodId = selected.includes(state.bloodId) ? state.bloodId : selected[2];
            body += `<br>Blood of Eva: ${bloodId ? memberName(bloodId) : 'Unassigned'}<br>`;
            if (selected.filter(Boolean).length === 3) body += link('ritual', 'Confirm assignments and begin the ritual.');
        }
        if (state.stage === 'loyalty') {
            body += `Altar sacrifices completed: ${state.members.filter(m => m.pledged).length}/3.<br>`
                + `Symbols of Loyalty delivered: ${state.members.filter(m => m.loyaltyDelivered).length}/3.<br>`
                + 'Three different clan members must each offer their life at the altar. Resurrect the fallen members so they can return their Symbols of Loyalty. These symbols are not antidote ingredients.<br>';
            if (leader) body += state.members.length === 3 && state.members.every(m => m.pledged && m.loyaltyDelivered)
                ? 'All three symbols are here. Your couriers are waiting for your decision.<br>' + link('poison', 'Drink the poison and send the couriers for ingredients.')
                : 'The poison trial becomes available after all three symbols reach you. No ingredients can be gathered before you drink the poison.<br>';
            else if (member) body += link('deliver', 'Hand my Symbol of Loyalty to the nearby leader.');
        }
        if (state.stage === 'gathering') {
            body += 'The poison roots the leader and drains 50 HP each second. Keep a healer beside them. Collect the three herbs and Blood of Eva within one hour and bring them back to the leader.<br>';
            for (const herb of Rules.HERBS) body += `${herb.name}: ${herb.area}.<br>`;
            body += `Herbs delivered: ${state.members.filter(m => m.delivered).length}/3. Blood of Eva: ${state.members.some(m => m.bloodDelivered) ? 'delivered' : 'pending'}.<br>`;
            if (member) body += `Your task: ${Rules.ITEMS[member.itemId]}${member.blood ? ' and Blood of Eva from Athrea' : ''}.<br>`;
            body += leader ? link('cure', 'Give Kalis the ingredients and receive the Potion of Recovery.') : link('deliver', 'Give my ingredients to the nearby leader.');
        }
        if (state.stage === 'cured') body += (state.antidoteReceived && session.actor.effects?.clan_alliance_poison
            ? 'Use the Potion of Recovery from your inventory to remove the poison and free yourself.<br>' : '')
            + 'Take the Voucher of Faith to Sir Kristof Rodemai in Giran for the Proof of Alliance and 120,000 SP.';
        if (state.members.length) {
            body += '<br>Assignments:<br>';
            for (const member of state.members) body += `${memberName(member.id)} — ${Rules.ITEMS[member.itemId]}${member.blood ? ' + Blood of Eva' : ''}: ${service().memberStatus(state, member)}.<br>`;
        }
        body += link('status', 'Refresh progress.');
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
