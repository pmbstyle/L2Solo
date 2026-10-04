// Lisvus C4 fdc7e33a Q212: wield the trial sword, then complete the three virtues.
const H = require('../SecondProfessionQuest');
const SWORD = 3027, HEROD = 5119, TALIANUS = 7656;
const NPCS = [7109, 7116, 7311, 7653, 7654, 7655, TALIANUS];
const BONES = [2643, 2644, 2645];
const HANDINS = [
    [1, 7653, 2, [], [[SWORD, 1]]],
    [3, 7653, 4, [[2635, 1], [SWORD, 1]], []],
    [4, 7654, 5, [], []], [6, 7654, 7, [], [[2636, 1]]],
    [8, TALIANUS, 9, [[2636, 1], [2639, 1]], [[2637, 1]]],
    [9, 7654, 10, [[2637, 1]], []], [10, 7655, 11, [], []],
    [12, 7655, 13, [[2641, 20]], [[2640, 1]]],
    [13, 7116, 14, [[2640, 1]], []], [15, 7116, 16, BONES.map(id => [id, 1]), [[2642, 1]]],
    [16, 7311, 17, [[2642, 1]], [[2646, 1]]], [17, 7116, 18, [[2646, 1]], [[2634, 1]]],
    [18, 7109, 0, [[2634, 1]], [[2633, 1], [7562, 8]]]
];
const eligible = s => s.session.actor.fetchLevel() >= 35 && [4, 19, 32].includes(s.session.actor.fetchClassId());
const l = (event, label) => H.link(212, event, label);
function recover(s) {
    const cond = s.getInt('cond'), saved = JSON.parse(s.get('encounter', 'null'));
    if (!saved || ![2, 8].includes(cond)) return null;
    return H.spawn(s, cond === 2 ? HEROD : TALIANUS, saved, cond === 8 ? 300000 : 600000);
}

const quest = {
    id: 212, name: 'Trial of Duty', startNpcs: [7109], npcs: NPCS,
    killNpcs: [144, 190, 191, 200, 201, 270, HEROD, 577, 578, 579, 580, 581, 582],
    personalNpcs: [TALIANUS], questSpawns: [HEROD, TALIANUS],
    questItems: [...Array.from({ length: 13 }, (_, n) => 2634 + n), SWORD], equippedQuestItems: [SWORD],
    eventNpc: event => ({ start: 7109, handin: NPCS, recover: [7653, 7654] })[event],
    canTalk(s, npc) {
        if (npc.fetchSelfId() === TALIANUS) return s.isStarted() && H.owns(s, npc);
        return s.isStarted() || s.isCompleted() || eligible(s);
    },
    async onTalk(s, npc) {
        if (s.isCompleted()) return H.page(s, 'You have earned the Mark of Duty.');
        if (!s.isStarted()) return H.page(s,
            'Grand Master Hannavalt in Giran asks you to prove dignity, justice and loyalty. Begin with Sir Aron Tanford in the southern Wasteland.', l('start', 'Accept the trial'));
        const cond = s.getInt('cond'), id = npc.fetchSelfId(), row = HANDINS.find(row => row[0] === cond), actions = [];
        if (row && id === row[1] && H.has(s, row[3]) && (cond !== 6 || H.count(s, 2639))) actions.push(l('handin', cond === 18 ? 'Receive the Mark of Duty' : 'Speak and continue the trial'));
        if (id === (cond === 2 ? 7653 : cond === 8 ? 7654 : 0) && s.get('encounter')) actions.push(l('recover', 'Locate the spirit again'));
        const hunt = {
            2: 'Hunt Skeleton Marauders and Raiders in the Wasteland until the Spirit of Sir Herod appears. Equip the Old Knight\'s Sword to defeat your spirit. If you used another weapon, ask Tanford to locate him again.',
            5: `Hunt Strains and Ghouls in the Execution Grounds to restore Talianus\'s Report.<br>Report pieces: ${H.count(s, 2638)}/10.`,
            7: 'Carry the Mirror of Orpic and Talianus\'s Report. Hunt Hangman Trees in the Execution Grounds until the Spirit of Sir Talianus appears.',
            11: `Hunt Leto Lizardmen near Oren for the guards\' belongings.<br>Militas articles: ${H.count(s, 2641)}/20.`,
            14: 'Hunt Breka Orc Overlords near Giran for Sir Athebaldt\'s skull, ribs and shinbone.<br>' + BONES.map(id => `${H.itemName(id)}: ${H.count(s, id)}/1`).join('<br>')
        };
        const text = hunt[cond] || (row ? `Visit ${H.npcName(row[1])}.<br>` + row[3].map(([id, n]) => `${H.itemName(id)}: ${H.count(s, id)}/${n}`).join('<br>') : 'Follow the trial of dignity, justice and loyalty.');
        return H.page(s, text + (cond === 10 ? '<br>Isael Silvershadow requires level 36.' : ''), actions.join('<br>'));
    },
    async onEvent(s, event) {
        const cond = s.getInt('cond'), id = s.session.activeNpcTalk.selfId;
        if (event === 'start') {
            if (s.isStarted() || s.isCompleted() || !eligible(s)) return null;
            await H.step(s, 1);
        } else {
            if (!s.isStarted()) return null;
            if (event === 'recover') {
                if (id !== (cond === 2 ? 7653 : cond === 8 ? 7654 : 0) || !s.get('encounter')) return null;
                recover(s);
            } else if (event === 'handin') {
                const row = HANDINS.find(row => row[0] === cond && row[1] === id);
                if (!row || !H.has(s, row[3]) || (cond === 6 && !H.count(s, 2639))) return null;
                if (cond === 10 && s.session.actor.fetchLevel() < 36) return H.page(s, 'Return to Isael Silvershadow at level 36.');
                const finish = cond === 18;
                await H.step(s, row[2], { takes: finish ? quest.questItems.map(id => [id, H.count(s, id)]) : row[3], gives: row[4],
                    ...([3, 8].includes(cond) ? { variables: { encounter: '' } } : {}),
                    ...(finish ? { status: 'completed', exp: 79832, sp: 3750 } : {}) });
                if (cond === 8 || finish) H.clearSpawns(s);
            } else return null;
        }
        return quest.onTalk(s, { fetchSelfId: () => id });
    },
    async onKill(s, npc) {
        const cond = s.getInt('cond'), id = npc.fetchSelfId();
        if (cond === 2 && [190, 191].includes(id) && Math.floor(Math.random() * 50) < 2) {
            if (H.personalSpawns(s, HEROD).some(npc => !npc.isDead())) return;
            const coords = H.coords(npc, [s.session.actor.locX || 0, s.session.actor.locY || 0, s.session.actor.locZ || 0]);
            await H.step(s, cond, { variables: { encounter: JSON.stringify(coords) } });
            recover(s);
        } else if (cond === 2 && id === HEROD && H.owns(s, npc) && H.count(s, SWORD)
            && s.session.actor.backpack.fetchEquippedWeapon()?.fetchSelfId() === SWORD) {
            await H.step(s, 3, { gives: [[2635, 1]] }); H.clearSpawns(s);
        } else if (cond === 5 && [200, 201].includes(id) && H.count(s, 2638) < 10 && !H.count(s, 2639) && Math.floor(Math.random() * 2) === 1) {
            const complete = H.count(s, 2638) === 9;
            await H.step(s, complete ? 6 : cond, { takes: complete ? [[2638, 9]] : [], gives: [[complete ? 2639 : 2638, 1]] });
        } else if (cond === 7 && id === 144 && H.has(s, [[2636, 1], [2639, 1]]) && Math.floor(Math.random() * 100) < 33) {
            const coords = H.coords(npc, [s.session.actor.locX || 0, s.session.actor.locY || 0, s.session.actor.locZ || 0]);
            await H.step(s, 8, { variables: { encounter: JSON.stringify(coords) } }); recover(s);
        } else if (cond === 11 && id >= 577 && id <= 582 && H.count(s, 2641) < 20) {
            await H.step(s, H.count(s, 2641) === 19 ? 12 : cond, { gives: [[2641, 1]] });
        } else if (cond === 14 && id === 270 && Math.floor(Math.random() * 2) === 1) {
            const bone = BONES.find(id => !H.count(s, id));
            if (bone) await H.step(s, bone === 2645 ? 15 : cond, { gives: [[bone, 1]] });
        }
    },
    onAbort: H.abort
};
module.exports = quest;
