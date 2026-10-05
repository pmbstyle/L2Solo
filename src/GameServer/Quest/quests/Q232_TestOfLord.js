// Lisvus C4 fdc7e33a, 232_TestOfLord. The First Orc conversation is optional.
const H = require('../SecondProfessionQuest');
const BRANCHES = ['atubaStat', 'nerugaStat', 'urutuStat', 'urutuDrop', 'dudaStat', 'gandiStat', 'markantusStat'];
// [branch, current stage, NPC, next stage, hand-in, issue]
const STEPS = [
    ['atubaStat', 0, 7566, 1, [], [[3392, 1]]],
    ['atubaStat', 1, 7515, 2, [], [[3397, 1]]],
    ['atubaStat', 3, 7515, 4, [[3397, 1], [3398, 20]], [[3399, 1]]],
    ['atubaStat', 4, 7566, 5, [[3392, 1], [3399, 1]], [[3400, 1]]],
    ['nerugaStat', 0, 7567, 1, [], [[3393, 1]]],
    ['nerugaStat', 1, 7558, 2, [[57, 1000]], [[3405, 1]]],
    ['nerugaStat', 2, 7567, 3, [[3393, 1], [3405, 1], [1341, 1000]], [[3406, 1]]],
    ['urutuStat', 0, 7568, 1, [], [[3394, 1]]],
    ['urutuStat', 1, 7564, 2, [], [[3401, 1]]],
    ['urutuStat', 2, 7510, 3, [[3401, 1]], [[3402, 1]]],
    ['urutuStat', 3, 7568, 4, [[3394, 1], [3402, 1], [3403, 10]], [[3404, 1]]],
    ['dudaStat', 0, 7641, 1, [], [[3395, 1]]],
    ['dudaStat', 3, 7641, 4, [[3395, 1], [3407, 10], [3408, 10]], [[3409, 1]]],
    ['gandiStat', 0, 7642, 1, [], [[3396, 1]]],
    ['gandiStat', 2, 7642, 3, [[3396, 1], [3410, 20]], [[3411, 1]]]
];
const PROOFS = [[3391, 1], [3400, 1], [3404, 1], [3406, 1], [3409, 1], [3411, 1]];
const FIRST_ORC = [21036, -107690, -3038];
const DROPS = [[269, 'atubaStat', 2, 3, 40, 20, 3398], [270, 'atubaStat', 2, 3, 50, 20, 3398],
    ...[583, 584, 585, 586, 587, 588].map((id, n) => [id, 'urutuDrop', 0, 1, 50 + n * 5, 10, 3403]),
    [564, 'gandiStat', 1, 2, 90, 20, 3410],
    [778, 'markantusStat', 1, 1, 100, 1, 3414], [779, 'markantusStat', 1, 1, 100, 1, 3415]];
const eligible = s => s.session.actor.fetchRace() === 3 && s.session.actor.fetchClassId() === 50 && s.session.actor.fetchLevel() >= 39;
const l = (e, label) => H.link(232, e, label);
const ready = s => H.has(s, PROOFS) && [['atubaStat', 5], ['nerugaStat', 3], ['urutuStat', 4], ['dudaStat', 4], ['gandiStat', 3]].every(([v, n]) => s.getInt(v) === n);
const quest = {
    id: 232, name: 'Test of the Lord', startNpcs: [7565],
    npcs: [7510, 7515, 7558, 7564, 7565, 7566, 7567, 7568, 7641, 7642, 7643, 7649],
    killNpcs: [233, ...DROPS.map(r => r[0])], questSpawns: [7643], personalNpcs: [7643], radarPoints: [FIRST_ORC],
    questItems: Array.from({ length: 26 }, (_, n) => 3391 + n),
    eventNpc: e => e === 'start' ? 7565 : e === 'handin' ? quest.npcs : e === 'summon' ? 7649 : ['story', 'legacy'].includes(e) ? 7643 : null,
    canTalk(s, npc) {
        if (npc.fetchSelfId() === 7643) return s.isStarted() && s.getInt('phase') === 2 && s.getInt('markantusStat') >= 3 && H.owns(s, npc);
        return s.isStarted() || s.isCompleted() || eligible(s);
    },
    async onTalk(s, npc) {
        if (s.isCompleted()) return H.page(s, 'You have earned the Mark of Lord.');
        if (!s.isStarted()) return H.page(s, 'Flame Lord Kakai requires approval from five tribes before sending you to Martankus.', l('start', 'Accept the test'));
        const id = npc.fetchSelfId(), phase = s.getInt('phase'), actions = [];
        let text;
        if (phase === 1) {
            const row = STEPS.find(r => r[2] === id && r[1] === s.getInt(r[0]));
            text = 'Seek Varkees, Tantus, Hatos, Takuna and Chianta. Each tribe has its own trial.<br>'
                + PROOFS.slice(1).map(([i]) => `${H.itemName(i)}: ${H.count(s, i)}/1`).join('<br>');
            if (row) {
                text += '<br>Bring:<br>' + (row[4].map(([i, n]) => `${H.itemName(i)}: ${H.count(s, i)}/${n}`).join('<br>') || 'Speak to receive your instructions.');
                if (H.has(s, row[4])) actions.push(l('handin', 'Speak and continue this tribe\'s trial'));
            }
            if (s.getInt('atubaStat') === 2) text += `<br>Manakia: hunt ${H.npcName(269)} and ${H.npcName(270)} for 20 Breka Orc Fangs (${H.count(s, 3398)}/20).`;
            if (!s.getInt('urutuDrop')) text += `<br>Hatos: hunt Timak Orcs for ten skulls (${H.count(s, 3403)}/10).`;
            if (s.getInt('dudaStat') === 1) text += `<br>Takuna: hunt Marsh Spiders; collect ten feet, then ten feelers (${H.count(s, 3408)}/10 feet; ${H.count(s, 3407)}/10 feelers).`;
            if (s.getInt('gandiStat') === 1) text += `<br>Chianta: hunt ${H.npcName(564)} for twenty corneas (${H.count(s, 3410)}/20).`;
            if (id === 7565 && ready(s)) actions.push(l('handin', 'Bring the five tribal proofs to Kakai'));
        } else {
            const stage = s.getInt('markantusStat');
            text = stage === 0 ? 'Take the Bear Fang Necklace to Martankus in the Cave of Trials.'
                : stage < 3 ? `Hunt Ragna Orc Overlords and Seers on the Immortal Plateau, then return to Martankus.<br>Ragna Orc Head: ${H.count(s, 3414)}/1<br>Ragna Chief Notice: ${H.count(s, 3415)}/1`
                    : 'You may hear the First Orc\'s story from Martankus, then return to Kakai with the Immortal Flame.';
            if (id === 7649 && (stage === 0 || stage === 2)) actions.push(l('handin', 'Speak with Martankus'));
            if (id === 7649 && stage >= 3) actions.push(l('summon', 'Summon or locate the First Orc'));
            if (id === 7643 && H.owns(s, npc)) actions.push(l('story', 'Hear the First Orc\'s story'));
            if (id === 7565 && stage >= 3 && H.count(s, 3416)) actions.push(l('handin', 'Receive the Mark of Lord'));
        }
        return H.page(s, text, actions.join('<br>'));
    },
    async onEvent(s, e) {
        const id = s.session.activeNpcTalk.selfId, phase = s.getInt('phase');
        if (e === 'start') {
            if (s.isStarted() || s.isCompleted() || !eligible(s)) return null;
            await H.step(s, 1, { gives: [[3391, 1]], variables: { phase: '1', ...Object.fromEntries(BRANCHES.map(v => [v, '0'])) } });
        } else {
            if (!s.isStarted()) return null;
            if (e === 'handin' && phase === 1) {
                if (id === 7565 && ready(s)) await H.step(s, 1, { takes: PROOFS, gives: [[3412, 1]], variables: { phase: '2' } });
                else {
                    const row = STEPS.find(r => r[2] === id && r[1] === s.getInt(r[0]));
                    if (!row || !H.has(s, row[4])) return null;
                    await H.step(s, 1, { takes: row[4], gives: row[5], variables: { [row[0]]: String(row[3]) } });
                }
            } else if (phase === 2 && e === 'handin') {
                const stage = s.getInt('markantusStat');
                if (id === 7649 && stage === 0 && H.count(s, 3412)) await H.step(s, 1, { takes: [[3412, 1]], gives: [[3413, 1]], variables: { markantusStat: '1' } });
                else if (id === 7649 && stage === 2 && H.has(s, [[3413, 1], [3414, 1], [3415, 1]])) await H.step(s, 1, { takes: [[3413, 1], [3414, 1], [3415, 1]], gives: [[3416, 1]], variables: { markantusStat: '3' } });
                else if (id === 7565 && stage >= 3 && H.count(s, 3416)) {
                    await H.step(s, 0, { status: 'completed', takes: quest.questItems.map(i => [i, H.count(s, i)]), gives: [[3390, 1]], exp: 92955, sp: 16250 });
                    H.clearSpawns(s); H.clearRadars(s);
                } else return null;
            } else if (e === 'summon' && phase === 2 && s.getInt('markantusStat') >= 3 && H.count(s, 3416)) {
                if (s.getInt('markantusStat') === 3) await H.step(s, 1, { variables: { markantusStat: '4' } });
                H.spawn(s, 7643, FIRST_ORC);
            } else if (['story', 'legacy'].includes(e) && phase === 2 && s.getInt('markantusStat') >= 3) {
                return H.page(s, e === 'story' ? 'The First Orc was forged from the eternal flame and sent to earth by Paagrio. The jealous gods destroyed his body, but his spirit protects his descendants.'
                    : 'Return to Flame Lord Kakai with the Immortal Flame.', e === 'story' ? l('legacy', 'Hear his legacy') : '');
            } else return null;
        }
        return quest.onTalk(s, { fetchSelfId: () => id, fetchId: () => s.session.activeNpcTalk.objectId });
    },
    async onKill(s, npc) {
        const id = npc.fetchSelfId(), phase = s.getInt('phase');
        if (phase === 1 && id === 233 && s.getInt('dudaStat') === 1 && H.count(s, 3395)) {
            const item = H.count(s, 3408) < 10 ? 3408 : 3407, current = H.count(s, item);
            if (current >= 10) return;
            await H.step(s, 1, { gives: [[item, 1]], variables: item === 3407 && current === 9 ? { dudaStat: '3' } : {} });
            return;
        }
        const row = DROPS.find(r => r[0] === id);
        if (!row || (phase === 2) !== (row[1] === 'markantusStat') || s.getInt(row[1]) !== row[2]
            || H.count(s, row[6]) >= row[5] || Math.floor(Math.random() * 100) >= row[4]) return;
        if (row[1] === 'atubaStat' && !H.count(s, 3397)) return;
        if (row[1] === 'gandiStat' && !H.count(s, 3396)) return;
        if (row[1] === 'markantusStat' && !H.count(s, 3413)) return;
        const complete = H.count(s, row[6]) + 1 === row[5];
        const next = row[1] === 'markantusStat' && H.count(s, row[6] === 3414 ? 3415 : 3414) ? 2 : row[3];
        await H.step(s, 1, { gives: [[row[6], 1]], variables: complete ? { [row[1]]: String(next) } : {} });
    },
    onAbort: H.abort
};
module.exports = quest;
