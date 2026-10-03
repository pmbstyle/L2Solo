// Lisvus C4 fdc7e33a, 223_TestOfChampion. No diamond reward.
const H = require('../SecondProfessionQuest');
// [step, NPC, required items, issued items, next step]
const HANDINS = [
    [1, 7625, [[3277, 1]], [[3279, 1]], 2],
    [2, 7625, [[3279, 1], [3290, 100]], [[3278, 1]], 2],
    [2, 7624, [[3278, 1]], [[3280, 1]], 2],
    [2, 7093, [[3280, 1]], [[3281, 1]], 3],
    [3, 7093, [[3281, 1], [3287, 30], [3288, 30], [3289, 30]], [[3282, 1]], 3],
    [3, 7624, [[3282, 1]], [[3283, 1]], 3],
    [3, 7196, [[3283, 1]], [[3284, 1]], 4],
    [4, 7196, [[3284, 1], [3291, 100]], [[3285, 1]], 5],
    [5, 7196, [[3285, 1], [3292, 100]], [[3286, 1]], 5],
    [5, 7624, [[3286, 1]], [[3276, 1]], 0]
];
// [NPC, step, authorization item, trophy, limit, percent]
// The source also accepts legacy quest templates 5088/5089, but never spawns
// them. Register the world Harpy and Road Scavenger used by the actual hunt.
const DROPS = [
    [780, 2, 3279, 3290, 100, 100],
    [145, 3, 3281, 3287, 30, 50],
    [158, 3, 3281, 3288, 30, 50], [553, 3, 3281, 3289, 30, 50],
    [551, 4, 3284, 3291, 100, 100],
    ...[577, 578, 579, 580, 581, 582].map((id, i) => [id, 5, 3285, 3292, 100, [50, 60, 70, 80, 90, 95][i]])
];
const eligible = state => state.session.actor.fetchLevel() >= 39
    && [1, 45].includes(state.session.actor.fetchClassId());
const current = state => HANDINS.find(row => row[0] === state.getInt('step') && H.count(state, row[2][0][0]));
const quest = {
    id: 223, name: 'Test of the Champion', startNpcs: [7624], npcs: [7624, 7625, 7093, 7196],
    killNpcs: DROPS.map(row => row[0]), questItems: Array.from({ length: 16 }, (_, n) => 3277 + n),
    eventNpc: event => event === 'start' ? 7624 : event === 'handin' ? [7624, 7625, 7093, 7196] : null,
    canTalk: state => state.isStarted() || state.isCompleted() || eligible(state),
    async onTalk(state, npc) {
        if (state.isCompleted()) return H.page(state, 'You have earned the Mark of Champion.');
        if (!state.isStarted()) return H.page(state,
            'Ascalon in Giran sends you to Mason in Dion, then Groot in Giran and Mouen in Oren.',
            H.link(223, 'start', 'Accept the test'));
        const row = current(state);
        if (!row) return null;
        const hunts = { 3279: 'Hunt Bloody Axe Elite north of the Death Pass, near the Town of Oren.',
            3281: 'Hunt Harpies and Medusas near Giran, and Windsus near the Town of Oren.',
            3284: 'Hunt Road Scavengers along the Death Pass.',
            3285: 'Hunt Leto Lizardmen near the Town of Oren.' };
        return H.page(state, `${hunts[row[2][0][0]] || ''}<br>Visit ${H.npcName(row[1])}.<br>`
            + row[2].map(([id, amount]) => `${H.itemName(id)}: ${H.count(state, id)}/${amount}`).join('<br>'),
            npc.fetchSelfId() === row[1] && H.has(state, row[2]) ? H.link(223, 'handin', 'Report and continue') : '');
    },
    async onEvent(state, event) {
        if (event === 'start') {
            if (state.isStarted() || state.isCompleted() || !eligible(state)) return null;
            await H.step(state, 1, { variables: { step: '1' }, gives: [[3277, 1]] });
        } else if (event === 'handin' && state.isStarted()) {
            const row = current(state);
            if (!row || row[1] !== state.session.activeNpcTalk.selfId || !H.has(state, row[2])) return null;
            const finish = row[4] === 0;
            await H.step(state, finish ? 0 : 1, { variables: { step: String(row[4]) },
                takes: finish ? quest.questItems.map(id => [id, H.count(state, id)]) : row[2], gives: row[3],
                ...(finish ? { status: 'completed', exp: 117454, sp: 25000 } : {}) });
        } else return null;
        return quest.onTalk(state, { fetchSelfId: () => state.session.activeNpcTalk.selfId });
    },
    async onKill(state, npc) {
        const row = DROPS.find(row => row[0] === npc.fetchSelfId() && row[1] === state.getInt('step'));
        if (!row || !H.count(state, row[2]) || H.count(state, row[3]) >= row[4] || Math.random() * 100 >= row[5]) return;
        const amount = invoke('GameServer/Quest/QuestService').questDropAmount(1, row[4], H.count(state, row[3]));
        if (amount) await H.step(state, 1, { gives: [[row[3], amount]] });
    },
    onAbort: H.abort
};
module.exports = quest;
