// Lisvus C4 fdc7e33a, 217_TestimonyOfTrust. Native C4 NPC/item ids.
const H = require('../SecondProfessionQuest');
const NPCS = [7031, 7154, 7191, 7358, 7464, 7515, 7531, 7565, 7621, 7657];
// [condition, NPC, next condition, hand-in, reward]
const HANDINS = [
    [1, 7154, 2, [[1558, 1]], [[2745, 1]]],
    [3, 7154, 4, [[2746, 1], [2747, 1], [2745, 1]], [[2741, 1]]],
    [4, 7358, 5, [[1556, 1]], [[2748, 1]]],
    [5, 7464, 6, [[2748, 1]], [[2755, 1]]],
    [7, 7464, 8, [], []],
    [8, 7358, 9, [[2755, 1], [2752, 1], [2753, 1], [2754, 1]], [[2740, 1]]],
    [9, 7191, 10, [[2740, 1], [2741, 1]], [[2739, 1]]],
    [10, 7657, 12, [[2739, 1]], [[2738, 1], [2737, 1]]],
    [11, 7657, 12, [[2739, 1]], [[2738, 1], [2737, 1]]],
    [12, 7565, 13, [[2738, 1]], [[2757, 1]]],
    [13, 7515, 14, [[2757, 1]], []],
    [15, 7515, 16, [[2756, 10]], [[2758, 1]]],
    [16, 7565, 17, [[2758, 1]], [[2743, 1]]],
    [17, 7531, 18, [[2737, 1]], [[2759, 1]]],
    [18, 7621, 19, [[2759, 1]], [[2760, 1]]],
    [20, 7621, 21, [[2761, 10], [2760, 1]], []],
    [21, 7531, 22, [], [[2742, 1]]],
    [22, 7191, 23, [[2742, 1], [2743, 1]], [[2744, 1]]],
    [23, 7031, 0, [[2744, 1]], [[2734, 1], [7562, 16]]]
];
const MATERIALS = [
    { mobs: [550], raw: 2749, result: 2752 },
    { mobs: [82, 84, 86, 87, 88], raw: 2750, result: 2753 },
    { mobs: [157, 230, 232, 234], raw: 2751, result: 2754 }
];
const SPIRITS = [
    { mobs: [36, 44], npc: 5120, item: 2746, coords: [9410, 50301, -3713] },
    { mobs: [13, 19], npc: 5121, item: 2747, coords: [16895, 47210, -3673] }
];
const eligible = state => state.session.actor.fetchRace() === 0 && state.session.actor.fetchLevel() >= 37;
const l = (event, label) => H.link(217, event, label);

const quest = {
    id: 217, name: 'Testimony of Trust', startNpcs: [7191], npcs: NPCS,
    killNpcs: [13, 19, 36, 44, 5120, 5121, 550, 82, 84, 86, 87, 88, 157, 230, 232, 234, 553, 213],
    questSpawns: [5120, 5121],
    questItems: [1556, 1558, ...Array.from({ length: 25 }, (_, n) => 2737 + n)],
    radarPoints: SPIRITS.map(row => row.coords),
    eventNpc: event => event === 'start' ? 7191 : event === 'handin' ? NPCS : null,
    canTalk: state => state.isStarted() || state.isCompleted() || eligible(state),
    async onTalk(state, npc) {
        if (state.isCompleted()) return H.page(state, 'You have earned the Mark of Trust.');
        if (!state.isStarted()) return H.page(state,
            'Hollint asks you to earn the trust of the Elves, Dark Elves, Orcs and Dwarves. Begin with Asterios in the Elven Village.', l('start', 'Accept the testimony'));
        const cond = state.getInt('cond');
        const handin = HANDINS.find(row => row[0] === cond);
        if (handin) return H.page(state,
            `Visit ${H.npcName(handin[1])}.${handin[3].length ? '<br>Bring: ' + handin[3].map(([id, amount]) =>
                `${H.itemName(id)} ${H.count(state, id)}/${amount}`).join('<br>') : ''}`,
            npc.fetchSelfId() === handin[1] && H.has(state, handin[3]) ? l('handin', 'Speak and continue the testimony') : '');
        if (cond === 2) return H.page(state,
            'Hunt Dryads and Lireins near the Elven Village to draw out Actea of Verdant Wilds and Luell of Zephyr Winds. Defeat both spirits and return to Asterios.<br>'
            + SPIRITS.map(row => `${H.itemName(row.item)}: ${H.count(state, row.item)}/1`).join('<br>'));
        if (cond === 6) return H.page(state,
            'Hunt Guardian Basilisks, Soldier Ants and Marsh Stakatos for Clayton. Ten samples of each kind become one prepared reagent.<br>'
            + MATERIALS.map(row => `${H.itemName(row.result)}: ${H.count(state, row.result)}/1; ${H.itemName(row.raw)}: ${H.count(state, row.raw)}/10`).join('<br>'));
        if (cond === 14) return H.page(state, `Hunt Windsus for Manakia: Parasite of Lota ${H.count(state, 2756)}/10.`);
        if (cond === 19) return H.page(state, `Hunt Porta in Cruma Tower for Nikola: Heart of Porta ${H.count(state, 2761)}/10.`);
        return null;
    },
    async onEvent(state, event) {
        if (event === 'start') {
            if (state.isStarted() || state.isCompleted() || !eligible(state)) return null;
            await H.step(state, 1, { gives: [[1558, 1], [1556, 1]] });
        } else if (event === 'handin' && state.isStarted()) {
            const cond = state.getInt('cond'), npcId = state.session.activeNpcTalk.selfId;
            const row = HANDINS.find(row => row[0] === cond && row[1] === npcId);
            if (!row || !H.has(state, row[3])) return null;
            if ([10, 11].includes(cond) && state.session.actor.fetchLevel() < 38) {
                if (cond !== 11) await H.step(state, 11);
                return H.page(state, 'Seresin will entrust you with the next letters at level 38.');
            }
            const finish = cond === 23;
            await H.step(state, row[2], { takes: finish ? quest.questItems.map(id => [id, H.count(state, id)]) : row[3],
                gives: row[4], ...(finish ? { status: 'completed', exp: 39571, sp: 2500 } : {}) });
            if (finish) { H.clearSpawns(state); H.clearRadars(state); }
        } else return null;
        return quest.onTalk(state, { fetchSelfId: () => state.session.activeNpcTalk.selfId });
    },
    async onKill(state, npc) {
        const cond = state.getInt('cond'), id = npc.fetchSelfId();
        if (cond === 2 && H.count(state, 2745)) {
            const spirit = SPIRITS.find(row => row.mobs.includes(id));
            if (spirit && !H.count(state, spirit.item)) {
                const attempts = state.getInt('id') + 1;
                await H.step(state, 2, { variables: { id: String(attempts) } });
                if (Math.random() * 100 < attempts * 33) H.spawn(state, spirit.npc, spirit.coords);
                return;
            }
            const killed = SPIRITS.find(row => row.npc === id);
            if (killed && !H.count(state, killed.item) && H.owns(state, npc)) {
                const done = SPIRITS.every(row => row === killed || H.count(state, row.item));
                await H.step(state, done ? 3 : 2, { gives: [[killed.item, 1]] });
                H.clearSpawns(state, killed.npc);
            }
        } else if (cond === 6 && H.count(state, 2755)) {
            const material = MATERIALS.find(row => row.mobs.includes(id));
            if (!material || H.count(state, material.result)) return;
            const current = H.count(state, material.raw);
            const amount = invoke('GameServer/Quest/QuestService').questDropAmount(1, 10, current);
            if (!amount) return;
            const complete = current + amount >= 10;
            const done = complete && MATERIALS.every(row => row === material || H.count(state, row.result));
            await H.step(state, done ? 7 : 6, complete
                ? { takes: [[material.raw, current]], gives: [[material.result, 1]] }
                : { gives: [[material.raw, amount]] });
        } else if ((cond === 14 && id === 553 && Math.random() >= .5)
            || (cond === 19 && id === 213 && H.count(state, 2760))) {
            const item = cond === 14 ? 2756 : 2761, current = H.count(state, item);
            const amount = invoke('GameServer/Quest/QuestService').questDropAmount(1, 10, current);
            if (amount) await H.step(state, current + amount === 10 ? cond + 1 : cond, { gives: [[item, amount]] });
        }
    },
    onAbort: H.abort
};
module.exports = quest;
