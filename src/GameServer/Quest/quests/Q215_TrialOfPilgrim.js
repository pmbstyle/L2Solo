// Lisvus C4 fdc7e33a; historical 37a3ec95 awards eight diamonds once.
const H = require('../SecondProfessionQuest');
const NPCS = [7648, 7571, 7649, 7550, 7650, 7651, 7117, 7036, 7362, 7652, 7612];
const eligible = s => s.session.actor.fetchLevel() >= 35 && [15, 29, 42, 50].includes(s.session.actor.fetchClassId());
// [condition, NPC, next, items consumed, items issued]
const STEPS = [
    [1, 7571, 2, [[2723, 1]], []], [2, 7649, 3, [], []],
    [4, 7649, 5, [[2725, 1]], [[2724, 1]]], [5, 7550, 6, [], [[2733, 1]]],
    [6, 7651, 8, [[2733, 1]], [[2727, 1]]], [7, 7651, 8, [[2733, 1]], [[2727, 1]]],
    [8, 7117, 9, [], []], [9, 7036, 10, [], [[2728, 1]]],
    [11, 7036, 12, [[2728, 1], [2729, 1]], [[2730, 1]]],
    [12, 7362, 13, [], []], [14, 7652, 15, [[2732, 1]], [[2731, 1]]],
    [16, 7612, 17, [[2727, 1], [2724, 1], [2730, 1]], [[2722, 1]]],
    [17, 7648, 0, [[2722, 1]], [[2721, 1], [7562, 8]]]
];
const l = (event, label) => H.link(215, event, label);
const quest = {
    id: 215, name: 'Trial of the Pilgrim', startNpcs: [7648], npcs: NPCS, killNpcs: [5116, 5117, 5118],
    questItems: Array.from({ length: 12 }, (_, n) => 2722 + n),
    eventNpc: e => e === 'start' ? 7648 : e === 'handin' ? NPCS : e === 'buy' || e === 'refund' ? 7650
        : e === 'burn' || e === 'keep' ? 7362 : null,
    canTalk: s => s.isStarted() || s.isCompleted() || eligible(s),
    async onTalk(s, npc) {
        if (s.isCompleted()) return H.page(s, 'You have earned the Mark of Pilgrim.');
        if (!s.isStarted()) return H.page(s, 'Hermit Santiago sends you to Tanapi and Martankus in the Orc Village.', l('start', 'Begin the pilgrimage'));
        const cond = s.getInt('cond'), id = npc.fetchSelfId(), row = STEPS.find(r => r[0] === cond);
        const actions = [];
        let text = row ? `Visit ${H.npcName(row[1])}.<br>` + row[3].map(([i, n]) => `${H.itemName(i)}: ${H.count(s, i)}/${n}`).join('<br>')
            : { 3: 'Hunt Lava Salamanders in the Forgotten Temple for the Essence of Flame.',
                6: 'Speak to Dorf in the Dwarven Village. Gerald also offers a book for 100000 Adena.',
                7: 'Take Gerald\'s book to Dorf in the Dwarven Village.',
                10: 'Defeat Nahir in the Forgotten Temple and return to Priest Potter in Gludin.',
                13: 'Hunt the Black Willow near the Swampland, then visit Uruha.',
                15: 'Return to Andellia in the Elven Village. You may burn or keep the Book of Darkness.' }[cond];
        if (row && id === row[1] && H.has(s, row[3])) actions.push(l('handin', 'Speak and continue'));
        if (cond === 6) text += '<br>Gerald also offers a book for 100000 Adena. Buying it is optional; Dorf will explain what to do.';
        if (id === 7650 && cond === 6 && H.count(s, 2733)) actions.push(l('buy', 'Buy Gerald\'s book for 100000 Adena'));
        if (id === 7650 && cond >= 8 && H.has(s, [[2727, 1], [2726, 1]])) actions.push(l('refund', 'Return Gerald\'s book and recover 100000 Adena'));
        if (id === 7362 && cond === 15 && H.count(s, 2731)) actions.push(l('burn', 'Burn the Book of Darkness'), l('keep', 'Keep the Book of Darkness'));
        return H.page(s, text, actions.join('<br>'));
    },
    async onEvent(s, e) {
        const cond = s.getInt('cond'), npc = s.session.activeNpcTalk.selfId;
        if (e === 'start') {
            if (s.isStarted() || s.isCompleted() || !eligible(s)) return null;
            await H.step(s, 1, { gives: [[2723, 1]] });
        } else {
            if (!s.isStarted()) return null;
            if (e === 'buy' && cond === 6 && H.has(s, [[2733, 1], [57, 100000]]) && !H.count(s, 2726)) {
                // Store the actual payment; refund it without multiplying by reward rates.
                await H.step(s, 7, { takes: [[57, 100000]], gives: [[2726, 1]], variables: { geraldPaid: '100000' } });
            } else if (e === 'refund' && cond >= 8 && H.has(s, [[2727, 1], [2726, 1]]) && s.getInt('geraldPaid') === 100000) {
                await H.step(s, cond, { takes: [[2726, 1]], gives: [[57, 100000]], variables: { geraldPaid: '0' } });
            } else if (['burn', 'keep'].includes(e) && cond === 15 && H.count(s, 2731)) {
                await H.step(s, 16, { takes: e === 'burn' ? [[2731, 1]] : [] });
            } else if (e === 'handin') {
                const row = STEPS.find(r => r[0] === cond && r[1] === npc);
                if (!row || !H.has(s, row[3])) return null;
                const finish = row[2] === 0;
                await H.step(s, row[2], { takes: finish ? quest.questItems.map(i => [i, H.count(s, i)])
                    : [...row[3], ...(cond === 16 && H.count(s, 2731) ? [[2731, 1]] : [])], gives: row[4],
                    ...(finish ? { status: 'completed', exp: 77832, sp: 16000 } : {}) });
            } else return null;
        }
        return quest.onTalk(s, { fetchSelfId: () => npc });
    },
    async onKill(s, npc) {
        const row = [[5116, 3, 2725, 4, true], [5117, 10, 2729, 11, false], [5118, 13, 2732, 14, true]]
            .find(r => r[0] === npc.fetchSelfId() && r[1] === s.getInt('cond'));
        if (!row || H.count(s, row[2]) || (row[4] && Math.floor(Math.random() * 5) !== 1)) return;
        await H.step(s, row[3], { gives: [[row[2], 1]] });
    },
    onAbort: H.abort
};
module.exports = quest;
