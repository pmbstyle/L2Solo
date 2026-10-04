// Lisvus C4 fdc7e33a, 226_TestOfHealer. Both authored reward branches are reachable.
const H = require('../SecondProfessionQuest');
const GUIDES = [7662, 7663, 7664];
const RADARS = [[-59985, 79234, -3502], [-14158, 44953, -3556], [-44358, 79442, -3634]];
const AMBUSH = [[-97547, 106503, -3405], [-97526, 106584, -3405], [-97441, 106585, -3405]];
const LETTERS = [2816, 2817, 2818, 2819];
// [condition, NPC, next condition, consume, issue]
const STEPS = [
    [3, 7428, 4, [[2810, 1]], []], [4, 7424, 5, [], []], [5, 7658, 6, [], []],
    [7, 7660, 8, [[2812, 1]], [[2814, 1]]], [8, 7658, 9, [[2814, 1]], [[2813, 1]]],
    [9, 7327, 10, [], [[2815, 1]]], [12, 7674, 13, [[2816, 1]], []],
    [19, 7661, 20, [], []], [20, 7665, 22, LETTERS.map(i => [i, 1]), [[2811, 1]]],
    [21, 7665, 22, LETTERS.map(i => [i, 1]), [[2811, 1]]], [22, 7327, 23, [[2811, 1]], []]
];
const BATTLES = { 2: [5134, 3, null], 11: [5123, 12, 2816], 14: [5124, 15, 2817],
    16: [5125, 17, 2818], 18: [5127, 19, 2819] };
const CHALLENGES = { 1: [7428, 2, [[2810, 1]], []], 10: [7674, 11, [[2815, 1]], [[2815, 1]]],
    13: [7661, 14, [[2816, 1]], []], 15: [7661, 16, [[2817, 1]], []], 17: [7661, 18, [[2818, 1]], []] };
const eligible = s => s.session.actor.fetchLevel() >= 39 && [4, 15, 29, 19].includes(s.session.actor.fetchClassId());
const l = (e, label) => H.link(226, e, label);
const playerPosition = s => H.coords(s.session.actor, [s.session.actor.locX || 0, s.session.actor.locY || 0, s.session.actor.locZ || 0]);
function waveAt(cond, center) {
    const nearby = [[0, 0], [-40, -40], [40, 40]].map(([x, y]) => [center[0] + x, center[1] + y, center[2]]);
    if (cond === 2) return [[5134, [center]]];
    if (cond === 11) return [[5122, AMBUSH.slice(0, 2)], [5123, AMBUSH.slice(2)]];
    if (cond === 14 || cond === 16) return [[cond === 14 ? 5124 : 5125, nearby]];
    if (cond === 18) return [[5126, nearby.slice(0, 2)], [5127, nearby.slice(2)]];
    return [];
}
function recover(s) {
    for (const [id, points] of waveAt(s.getInt('cond'), JSON.parse(s.get('encounter')))) H.spawnGroup(s, id, points, points.length);
}
function clearBattle(s, saved = s.get('encounterPoints')) {
    H.clearSpawns(s);
    for (const point of JSON.parse(saved || '[]')) s.removeRadar(...point);
}
const quest = {
    id: 226, name: 'Test of the Healer', startNpcs: [7473],
    npcs: [7327, 7424, 7428, 7473, 7658, 7659, 7660, 7661, ...GUIDES, 7665, 7674],
    killNpcs: [5134, 5122, 5123, 5124, 5125, 5126, 5127], questSpawns: [5134, 5122, 5123, 5124, 5125, 5126, 5127],
    questItems: Array.from({ length: 10 }, (_, n) => 2810 + n), radarPoints: RADARS,
    eventNpc: e => e === 'start' || e === 'finish' ? 7473 : e === 'handin' ? quest.npcs
        : e === 'challenge' || e === 'recover' ? [7428, 7674, 7661]
            : e === 'donate' || e === 'skip' ? 7658 : e === 'guide' ? GUIDES : null,
    canTalk: s => s.isStarted() || s.isCompleted() || eligible(s),
    async onTalk(s, npc) {
        if (s.isCompleted()) return H.page(s, 'You have earned the Mark of Healer.');
        if (!s.isStarted()) return H.page(s, 'Priest Bandellos in Giran asks you to find the missing saintess. Begin with Perrin.', l('start', 'Accept the test'));
        const cond = s.getInt('cond'), id = npc.fetchSelfId(), actions = [], row = STEPS.find(r => r[0] === cond);
        let text = row ? `Visit ${H.npcName(row[1])}.<br>` + row[3].map(([i, n]) => `${H.itemName(i)}: ${H.count(s, i)}/${n}`).join('<br>')
            : cond === 6 ? 'Gupu asks for a donation of 100000 Adena. Donate and find Windy in the Wasteland to earn a Golden Statue and a larger final reward, or continue the search for Kristina without donating.'
                : cond === 23 ? 'Return to Bandellos in Giran for the Mark of Healer.'
                    : BATTLES[cond] ? `Defeat ${H.npcName(BATTLES[cond][0])}. If the encounter disappeared, ask the person who summoned it to locate it again.`
                        : 'Follow Daurin and the Gludio Elves to the Mysterious Dark Elf.';
        if (row && id === row[1] && H.has(s, row[3])) actions.push(l('handin', 'Speak and continue'));
        const challenge = CHALLENGES[cond];
        if (challenge && id === challenge[0] && H.has(s, challenge[2])) actions.push(l('challenge', 'Begin the encounter'));
        const summoner = { 2: 7428, 11: 7674, 14: 7661, 16: 7661, 18: 7661 }[cond];
        if (id === summoner && s.get('encounter')) actions.push(l('recover', 'Locate the quest opponents again'));
        if (cond === 6 && id === 7658) actions.push(l('donate', 'Donate 100000 Adena and help Windy'), l('skip', 'Continue without making a donation'));
        if (GUIDES.includes(id) && cond >= 13) actions.push(l('guide', cond >= 20 ? 'Locate Kristina' : 'Locate the Mysterious Dark Elf'));
        if (cond === 23 && id === 7473) actions.push(l('finish', H.count(s, 2813) ? 'Return the Golden Statue and receive the mark' : 'Receive the Mark of Healer'));
        return H.page(s, text, actions.join('<br>'));
    },
    async onEvent(s, e) {
        const cond = s.getInt('cond'), id = s.session.activeNpcTalk.selfId;
        if (e === 'start') {
            if (s.isStarted() || s.isCompleted() || !eligible(s)) return null;
            await H.step(s, 1, { gives: [[2810, 1]] });
        } else {
            if (!s.isStarted()) return null;
            if (e === 'challenge') {
                const row = CHALLENGES[cond];
                if (!row || id !== row[0] || !H.has(s, row[2])) return null;
                clearBattle(s);
                const center = playerPosition(s);
                await H.step(s, row[1], { takes: row[3], variables: { encounter: JSON.stringify(center),
                    encounterPoints: JSON.stringify(waveAt(row[1], center).flatMap(([, points]) => points)) } });
                recover(s);
            } else if (e === 'recover') {
                if (id !== { 2: 7428, 11: 7674, 14: 7661, 16: 7661, 18: 7661 }[cond] || !s.get('encounter')) return null;
                recover(s);
            } else if (e === 'donate' && cond === 6 && H.count(s, 57) >= 100000 && !H.count(s, 2812)) {
                await H.step(s, 7, { takes: [[57, 100000]], gives: [[2812, 1]] });
            } else if (e === 'skip' && cond === 6) {
                // The reference's decline event loops back to the donation. Allow its no-statue reward branch to finish.
                await H.step(s, 9);
            } else if (e === 'guide' && GUIDES.includes(id) && cond >= 13 && cond <= 23) {
                if (cond === 20) await H.step(s, 21);
                s.addRadar(...RADARS[cond >= 20 ? 2 : cond === 13 ? 0 : 1]);
            } else if (e === 'handin') {
                const row = STEPS.find(r => r[0] === cond && r[1] === id);
                if (!row || !H.has(s, row[3])) return null;
                // Daurin reads the first letter but Kristina needs all four originals.
                await H.step(s, row[2], { takes: cond === 12 ? [] : row[3], gives: row[4] });
                if (cond === 12) s.addRadar(...RADARS[0]);
            } else if (e === 'finish' && cond === 23 && id === 7473) {
                const statue = H.count(s, 2813) > 0;
                await H.step(s, 0, { status: 'completed', takes: quest.questItems.map(i => [i, H.count(s, i)]), gives: [[2820, 1]],
                    exp: statue ? 134839 : 118304, sp: statue ? 50000 : 26250 });
                clearBattle(s); H.clearRadars(s);
            } else return null;
        }
        return quest.onTalk(s, { fetchSelfId: () => id });
    },
    async onKill(s, npc) {
        const row = BATTLES[s.getInt('cond')];
        if (!row || npc.fetchSelfId() !== row[0] || !H.owns(s, npc) || (row[2] && H.count(s, row[2]))) return;
        await H.step(s, row[1], { gives: row[2] ? [[row[2], 1]] : [] });
        clearBattle(s);
    },
    async onAbort(s) { const saved = s.get('encounterPoints'); await H.abort(s); clearBattle(s, saved); }
};
module.exports = quest;
