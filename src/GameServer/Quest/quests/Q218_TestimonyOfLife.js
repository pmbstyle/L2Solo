// Lisvus C4 fdc7e33a, 218_TestimonyOfLife. Native C4 NPC/item ids.
const H = require('../SecondProfessionQuest');
const NPCS = [7460, 7154, 7371, 7300, 7419, 7375, 7655];
const PARTS = Array.from({ length: 6 }, (_, n) => 3166 + n);
// [condition, NPC, next condition, hand-in, reward]
const HANDINS = [
    [1, 7154, 2, [[3141, 1]], [[3144, 1], [3143, 1]]],
    [2, 7371, 3, [[3143, 1]], [[3145, 1]]],
    [3, 7300, 4, [[3145, 1]], [[3149, 1]]],
    [4, 7300, 5, [[3149, 1], [3161, 10], [3162, 20], [3163, 20]], [[3150, 1]]],
    [5, 7371, 6, [[3150, 1]], [[3146, 1]]],
    [6, 7419, 7, [[3146, 1]], [[3151, 1], [3152, 1]]],
    [7, 7375, 8, [[3152, 1]], [[3153, 1]]],
    [8, 7375, 9, [[3153, 1], [3164, 20], [3165, 20]], [[3154, 1]]],
    [9, 7419, 10, [[3151, 1], [3154, 1]], [[3155, 1]]],
    [10, 7371, 12, [[3155, 1]], [[3147, 1]]],
    [11, 7371, 12, [[3148, 1]], [[3147, 1]]],
    [12, 7655, 13, [[3147, 1]], [[3156, 1]]],
    [13, 7655, 14, [[3156, 1], ...PARTS.map(id => [id, 1])], [[3157, 1], [3026, 1]]],
    [14, 7371, 15, [[3157, 1]], [[3158, 1]]],
    [16, 7371, 17, [[3159, 1]], [[3160, 1]]],
    [17, 7154, 18, [[3144, 1], [3160, 1]], [[3142, 1]]],
    [18, 7460, 0, [[3142, 1]], [[3140, 1], [7562, 16]]]
];
const DROPS = [
    [4, [550], 3161, 10, .5], [4, [176], 3163, 20, .5],
    [4, [82, 84, 86], 3162, 20, .8], [4, [87, 88], 3162, 20, .5],
    [8, [233], 3164, 20, .5], [8, [145], 3165, 20, .5]
];
const eligible = state => state.session.actor.fetchRace() === 1 && state.session.actor.fetchLevel() >= 37;
const l = (event, label) => H.link(218, event, label);

const quest = {
    id: 218, name: 'Testimony of Life', startNpcs: [7460], npcs: NPCS,
    killNpcs: [550, 176, 82, 84, 86, 87, 88, 233, 145, 581, 582, 5077],
    questItems: [3026, ...Array.from({ length: 31 }, (_, n) => 3141 + n)],
    equippedQuestItems: [3026],
    eventNpc: event => event === 'start' ? 7460 : event === 'handin' ? NPCS : null,
    canTalk: state => state.isStarted() || state.isCompleted() || eligible(state),
    async onTalk(state, npc) {
        if (state.isCompleted()) return H.page(state, 'You have earned the Mark of Life.');
        if (!state.isStarted()) return H.page(state,
            'Cardien asks you to save the Mother Tree. Take his letter to Hierarch Asterios in the Elven Village.', l('start', 'Accept the testimony'));
        const cond = state.getInt('cond'), row = HANDINS.find(row => row[0] === cond);
        if (row) return H.page(state, `Visit ${H.npcName(row[1])}.<br>`
            + row[3].map(([id, amount]) => `${H.itemName(id)}: ${H.count(state, id)}/${amount}`).join('<br>')
            + ([10, 11].includes(cond) ? '<br>Thalia requires level 38 before sending you to Isael Silvershadow.' : '')
            + (cond === 4 ? '<br>Hunt Guardian Basilisks, Soldier Ants and Wyrms for Pushkin.' : '')
            + (cond === 8 ? '<br>Hunt Marsh Spiders and Harpies for Adonius.' : '')
            + (cond === 13 ? '<br>Recover the six spear pieces from Leto Lizardman Shamans and Overlords.' : ''),
            npc.fetchSelfId() === row[1] && H.has(state, row[3]) && (cond !== 14 || H.count(state, 3026))
                ? l('handin', 'Speak and continue the testimony') : '');
        if (cond === 15) return H.page(state,
            'Find the Unicorn of Eva in the Elven forest. Carry Talin\'s Spear and the Grail of Purity to collect its tears.');
        return null;
    },
    async onEvent(state, event) {
        if (event === 'start') {
            if (state.isStarted() || state.isCompleted() || !eligible(state)) return null;
            await H.step(state, 1, { gives: [[3141, 1]] });
        } else if (event === 'handin' && state.isStarted()) {
            const cond = state.getInt('cond'), npcId = state.session.activeNpcTalk.selfId;
            const row = HANDINS.find(row => row[0] === cond && row[1] === npcId);
            if (!row || !H.has(state, row[3]) || (cond === 14 && !H.count(state, 3026))) return null;
            if ([10, 11].includes(cond) && state.session.actor.fetchLevel() < 38) {
                if (cond === 10) await H.step(state, 11, { takes: row[3], gives: [[3148, 1]] });
                return H.page(state, 'Return to Thalia at level 38.');
            }
            const finish = cond === 18;
            await H.step(state, row[2], { takes: finish ? quest.questItems.map(id => [id, H.count(state, id)]) : row[3],
                gives: row[4], ...(finish ? { status: 'completed', exp: 104591, sp: 11250 } : {}) });
        } else return null;
        return quest.onTalk(state, { fetchSelfId: () => state.session.activeNpcTalk.selfId });
    },
    async onKill(state, npc) {
        const cond = state.getInt('cond'), id = npc.fetchSelfId();
        if (cond === 15 && id === 5077 && H.has(state, [[3144, 1], [3026, 1], [3158, 1]])) {
            // C4 checks possession of the spear; wielding it also counts.
            await H.step(state, 16, { takes: [[3026, 1], [3158, 1]], gives: [[3159, 1]] });
        } else if (cond === 13 && [581, 582].includes(id) && H.count(state, 3156) && Math.random() < .5) {
            const part = PARTS.find(id => !H.count(state, id));
            if (part) await H.step(state, cond, { gives: [[part, 1]] });
        } else if (H.count(state, 3144)) {
            const drop = DROPS.find(row => row[0] === cond && row[1].includes(id));
            if (!drop || !H.count(state, cond === 4 ? 3149 : 3153) || Math.random() >= drop[4]) return;
            const amount = invoke('GameServer/Quest/QuestService').questDropAmount(1, drop[3], H.count(state, drop[2]));
            if (amount) await H.step(state, cond, { gives: [[drop[2], amount]] });
        }
    },
    onAbort: H.abort
};
module.exports = quest;
