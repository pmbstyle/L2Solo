// Lisvus C4 fdc7e33a, 227_TestOfReformer. Quest opponents belong to their summoner.
const H = require('../SecondProfessionQuest');
const BONES = [[404, 2834], [104, 2835], [102, 2836], [22, 2837], [100, 2838]];
const LETTERS = [2827, 3037, 2828, 2830];
const PILGRIM = [-4015, 40141, -3664], INSPECTOR = [-4034, 40201, -3665], BETRAYER = [-4106, 40174, -3660];
const WEREWOLF = [-9382, -89852, -2333], LIZARDMAN = [126019, -179983, -1781];
const STEPS = [
    [3, 7118, 4, [[2822, 1], [2832, 1]], [[2823, 1]]], [4, 7666, 5, [[2823, 1]], [[2824, 1]]],
    [7, 7668, 8, [[2826, 1]], []], [9, 7668, 9, [[2833, 1]], [[2827, 1]]],
    [9, 7666, 10, [[2827, 1], [2826, 1]], [[2825, 3]]],
    [12, 7669, 13, [[2825, 1]], [[3037, 1]]], [15, 7670, 16, [[2825, 1]], [[2828, 1]]],
    [16, 7667, 17, [[2825, 1]], [[2829, 1]]], [18, 7667, 19, [[2829, 1], ...BONES.map(([, i]) => [i, 1])], [[2830, 1]]]
];
const CHALLENGES = { 5: [7668, 6, [[2824, 1]]], 10: [7669, 11, [[2825, 1]]], 13: [7670, 14, [[2825, 1]]] };
const BATTLES = { 2: [5128, 3, 2832], 6: [5129, 7, null], 8: [5130, 9, 2833],
    11: [5131, 12, null], 14: [5132, 15, null] };
const SUMMONERS = { 2: 7118, 6: 7668, 7: 7668, 8: 7668, 11: 7669, 14: 7670 };
const eligible = s => s.session.actor.fetchLevel() >= 39 && [15, 42].includes(s.session.actor.fetchClassId());
const l = (e, label) => H.link(227, e, label);
function recover(s) {
    const cond = s.getInt('cond');
    if (cond === 2 && s.get('encounter')) H.spawn(s, 5128, JSON.parse(s.get('encounter')), 300000);
    if ([6, 7].includes(cond) && !H.count(s, 2826)) H.spawn(s, 7732, PILGRIM);
    if (cond === 6) H.spawn(s, 5129, INSPECTOR);
    if (cond === 8) H.spawn(s, 5130, BETRAYER);
    if (cond === 11) H.spawn(s, 5131, WEREWOLF);
    if (cond === 14) H.spawn(s, 5132, LIZARDMAN);
}
const quest = {
    id: 227, name: 'Test of the Reformer', startNpcs: [7118], npcs: [7118, 7666, 7667, 7668, 7669, 7670, 7732],
    killNpcs: [5099, 5128, 5129, 5130, 5131, 5132, ...BONES.map(([id]) => id)],
    questSpawns: [7732, 5128, 5129, 5130, 5131, 5132], personalNpcs: [7732],
    radarPoints: [PILGRIM, INSPECTOR, BETRAYER, WEREWOLF, LIZARDMAN], questItems: [...Array.from({ length: 18 }, (_, n) => 2822 + n), 3037],
    eventNpc: e => e === 'start' ? 7118 : e === 'handin' ? quest.npcs : e === 'challenge' ? [7668, 7669, 7670]
        : e === 'recover' ? [7118, 7668, 7669, 7670] : e === 'thanks' ? 7732 : null,
    canTalk(s, npc) {
        if (npc.fetchSelfId() === 7732) return s.isStarted() && s.getInt('cond') === 7 && !H.count(s, 2826) && H.owns(s, npc);
        return s.isStarted() || s.isCompleted() || eligible(s);
    },
    async onTalk(s, npc) {
        if (s.isCompleted()) return H.page(s, 'You have earned the Mark of Reformer.');
        if (!s.isStarted()) return H.page(s, 'Priestess Pupina in Giran sends you to hunt Nameless Revenants in the Execution Grounds, then meet Sla and her pupils.', l('start', 'Accept the test'));
        const cond = s.getInt('cond'), id = npc.fetchSelfId(), actions = [], candidates = STEPS.filter(r => r[0] === cond);
        const row = candidates.find(r => r[1] === id && H.has(s, r[3])) || candidates.find(r => H.has(s, r[3])) || candidates[0];
        let text = cond === 7 && !H.count(s, 2826) ? 'Speak to the Ol Mahum Pilgrim you saved, then return to Katari with his gift.'
            : row ? `Visit ${H.npcName(row[1])}.<br>` + row[3].map(([i, n]) => `${H.itemName(i)}: ${H.count(s, i)}/${n}`).join('<br>')
            : cond === 1 ? `Hunt Nameless Revenants for seven diary fragments (${H.count(s, 2831)}/7). Aruraune will appear when you have them all.`
                : cond === 17 ? 'Ramus needs bones from Skeleton Archers, Skeleton Marksmen, Skeleton Lords, Skeleton Executioners and Misery Skeletons.<br>'
                        + BONES.map(([mob, i]) => `${H.npcName(mob)}: ${H.itemName(i)} ${H.count(s, i)}/1`).join('<br>')
                        : cond === 19 ? 'Return to Sla with the four pupils\' letters.'
                            : BATTLES[cond] ? `Defeat ${H.npcName(BATTLES[cond][0])}, then speak to the pupil you helped. You can ask for the encounter again if it disappeared.`
                                : 'Help Katari, Kakan, Nyakuri and Ramus in that order.';
        if (row && id === row[1] && H.has(s, row[3])) actions.push(l('handin', 'Speak and continue'));
        const challenge = CHALLENGES[cond];
        if (challenge && id === challenge[0] && H.has(s, challenge[2])) actions.push(l('challenge', 'Help this pupil'));
        if (id === SUMMONERS[cond] && (cond !== 7 || !H.count(s, 2826))) actions.push(l('recover', 'Locate the quest encounter again'));
        if (id === 7732 && cond === 7 && !H.count(s, 2826) && H.owns(s, npc)) actions.push(l('thanks', 'Receive the pilgrim\'s gift'));
        if (id === 7666 && cond === 19 && H.has(s, LETTERS.map(i => [i, 1]))) actions.push(l('handin', 'Receive the Mark of Reformer'));
        return H.page(s, text, actions.join('<br>'));
    },
    async onEvent(s, e) {
        const cond = s.getInt('cond'), id = s.session.activeNpcTalk.selfId;
        if (e === 'start') {
            if (s.isStarted() || s.isCompleted() || !eligible(s)) return null;
            await H.step(s, 1, { gives: [[2822, 1]] });
        } else {
            if (!s.isStarted()) return null;
            if (e === 'challenge') {
                const row = CHALLENGES[cond];
                if (!row || id !== row[0] || !H.has(s, row[2])) return null;
                await H.step(s, row[1], { takes: cond === 5 ? row[2] : [] });
                recover(s);
            } else if (e === 'recover' && id === SUMMONERS[cond] && (cond !== 7 || !H.count(s, 2826))) recover(s);
            else if (e === 'thanks' && cond === 7 && id === 7732 && !H.count(s, 2826)
                && H.owns(s, { fetchSelfId: () => id, fetchId: () => s.session.activeNpcTalk.objectId })) {
                await H.step(s, 7, { gives: [[2826, 1]] }); H.clearSpawns(s, 7732);
            } else if (e === 'handin' && cond === 19 && id === 7666 && H.has(s, LETTERS.map(i => [i, 1]))) {
                await H.step(s, 0, { status: 'completed', takes: quest.questItems.map(i => [i, H.count(s, i)]), gives: [[2821, 1]], exp: 164032, sp: 17500 });
                H.clearSpawns(s); H.clearRadars(s);
            } else if (e === 'handin') {
                const row = STEPS.find(r => r[0] === cond && r[1] === id);
                if (!row || !H.has(s, row[3])) return null;
                // Katari and Sla both inspect their letters; only Sla consumes the pilgrim's money.
                const takes = cond === 7 ? [] : cond === 9 && id === 7666 ? [[2826, 1]] : row[3];
                await H.step(s, row[2], { takes, gives: row[4] });
                if (cond === 7) recover(s);
            } else return null;
        }
        return quest.onTalk(s, { fetchSelfId: () => id, fetchId: () => s.session.activeNpcTalk.objectId });
    },
    async onKill(s, npc) {
        const cond = s.getInt('cond'), id = npc.fetchSelfId();
        if (cond === 1 && id === 5099 && H.count(s, 2822) && H.count(s, 2831) < 7) {
            const current = H.count(s, 2831), done = current === 6;
            const point = H.coords(npc, [s.session.actor.locX || 0, s.session.actor.locY || 0, s.session.actor.locZ || 0]);
            await H.step(s, done ? 2 : 1, done ? { takes: [[2831, current]], variables: { encounter: JSON.stringify(point) } } : { gives: [[2831, 1]] });
            if (done) recover(s);
            return;
        }
        const battle = BATTLES[cond];
        if (battle && id === battle[0] && H.owns(s, npc)) {
            await H.step(s, battle[1], { gives: battle[2] ? [[battle[2], 1]] : [] }); H.clearSpawns(s, id);
            return;
        }
        if (cond === 17 && H.count(s, 2829)) {
            const bone = BONES.find(([mob, item]) => id === mob && !H.count(s, item));
            if (!bone) return;
            const done = BONES.every(row => row === bone || H.count(s, row[1]));
            await H.step(s, done ? 18 : 17, { gives: [[bone[1], 1]] });
        }
    },
    onAbort: H.abort
};
module.exports = quest;
