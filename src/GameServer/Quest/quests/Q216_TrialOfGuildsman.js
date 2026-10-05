// Lisvus C4 fdc7e33a; historical C4 37a3ec95 fixes the duplicated diamond reward.
const H = require('../SecondProfessionQuest');
const NpcIndex = invoke('GameServer/World/NpcObjectIndex');
const World = invoke('GameServer/World/World');
const NPCS = [7103, 7283, 7210, 7688, 7298];
const MATERIALS = [[200, 3130, 2], [201, 3130, 2], [83, 3131, 7], [202, 3132, 7], [168, 3133, 10]];
const seen = new WeakMap();
const eligible = s => [54, 56].includes(s.session.actor.fetchClassId()) && s.session.actor.fetchLevel() >= 35;
const l = (event, label) => H.link(216, event, label);

function handin(s, npc) {
    const cond = s.getInt('cond'), normal = s.getInt('norman'), pinter = s.getInt('pinter');
    if (cond === 1 && npc === 7283) return { next: 2, takes: [], gives: [] };
    if (cond === 2 && npc === 7103) return { next: 3, takes: [], gives: [] };
    if (cond === 4 && npc === 7283) return { next: 5, takes: [[3120, 1], [3121, 1]],
        gives: [[3122, 1], [3123, 1], [3124, 1], [3024, 1]] };
    if (cond !== 5) return null;
    if (npc === 7210 && !normal) return { takes: [[3123, 1]], gives: [[3125, 1], [3126, 1]], variables: { norman: '1' } };
    if (npc === 7688 && normal === 1) return { takes: [[3126, 1]], gives: [[3127, 1]], variables: { norman: '2' } };
    if (npc === 7210 && normal === 2) return { takes: [[3128, 30], [3125, 1]], gives: [[3129, 1]], variables: { norman: '3' } };
    if (npc === 7210 && normal === 3) return { takes: [[3129, 1], ...[3130, 3131, 3132, 3133].map(id => [id, 70])],
        gives: [[3134, 7]], variables: { norman: '4' } };
    if (npc === 7298 && !pinter) return { takes: [[3124, 1]],
        gives: [[3135, 1], ...(s.session.actor.fetchClassId() === 56 ? [[3025, 1]] : [])], variables: { pinter: '1' }, level: 36 };
    if (npc === 7298 && pinter === 1) return { takes: [[3135, 1], [3136, 70], [3025, H.count(s, 3025)]],
        gives: [[3138, 7]], variables: { pinter: '2' }, removeRecipes: [316] };
    return null;
}

const quest = {
    id: 216, name: 'Trial of the Guildsman', startNpcs: [7103], npcs: NPCS,
    killNpcs: [154, 155, 156, 223, 267, 268, 269, 270, 271, 200, 201, 83, 202, 168, 79, 80, 81],
    skillNpcs: [79, 80, 81], questRecipes: [315, 316],
    questItems: [3024, 3025, ...Array.from({ length: 20 }, (_, n) => 3120 + n)],
    eventNpc: e => e === 'start' || e === 'virtues' || e === 'bribes' ? 7103 : e === 'handin' ? NPCS : null,
    canTalk: s => s.isStarted() || s.isCompleted() || eligible(s),
    async onTalk(s, npc) {
        if (s.isCompleted()) return H.page(s, 'You have earned the Mark of Guildsman.');
        if (!s.isStarted()) return H.page(s, 'Valkon charges 2000 adena. Visit Blacksmith Altran on Talking Island and make seven Journeyman Rings.', l('start', 'Pay 2000 adena and accept'));
        const row = handin(s, npc.fetchSelfId()), actions = [];
        if (row && H.has(s, row.takes)) actions.push(l('handin', 'Speak and continue the trial'));
        if (s.getInt('cond') === 6 && npc.fetchSelfId() === 7103 && H.has(s, [[3139, 7], [3122, 1]]))
            actions.push(l('virtues', 'I learned the virtues of a faithful guild member'), l('bribes', 'I learned how to flatter and bribe guild authorities'));
        const text = { 1: 'Visit Altran on Talking Island.', 2: 'Ask Valkon about Altran\'s arthritis.',
            3: 'Hunt Mandragoras in the Execution Grounds for a Mandragora Berry.', 4: 'Bring the berry to Altran.',
            5: 'Visit Norman in Gludin, Duning in Hunters Village, and Pinter in Gludio. Pinter requires level 36.<br>'
                + 'Norman needs 30 keys from Breka Orcs, then 70 each of Gray Bone Powder (Ghouls/Strains), Granite Whetstone (Granite Golems), Red Pigment (Dead Seekers), and Braided Yarn (Silenos).<br>'
                + 'Pinter needs 70 Amber Beads. Scavengers can use Spoil on Ants, Ant Captains and Ant Overseers; Artisans can craft beads from Amber Lumps.<br>'
                + `Keys: ${H.count(s, 3128)}/30; beads: ${H.count(s, 3136)}/70.`,
            6: 'Craft seven Journeyman Rings, then report to Valkon. Each ring requires a gem, a decoration bead, 1 Steel, 10 Varnish and 10 D-grade Crystals.' };
        return H.page(s, text[s.getInt('cond')], actions.join('<br>'));
    },
    async onEvent(s, e) {
        if (e === 'start') {
            if (s.isStarted() || s.isCompleted() || !eligible(s) || !H.has(s, [[57, 2000]])) return null;
            await H.step(s, 1, { takes: [[57, 2000]], gives: [[3120, 1]] });
        } else {
            if (!s.isStarted()) return null;
            if (e === 'handin') {
                const row = handin(s, s.session.activeNpcTalk.selfId);
                if (!row || !H.has(s, row.takes)) return null;
                if (row.level && s.session.actor.fetchLevel() < row.level) return H.page(s, 'Return to Pinter at level 36.');
                const vars = { ...s.variables, ...row.variables };
                const next = vars.norman === '4' && vars.pinter === '2' ? 6 : row.next || s.getInt('cond');
                await H.step(s, next, row);
            } else if (['virtues', 'bribes'].includes(e) && s.getInt('cond') === 6 && H.has(s, [[3139, 7], [3122, 1]])) {
                const strong = e === 'bribes';
                await H.step(s, 0, { status: 'completed', takes: quest.questItems.map(id => [id, H.count(s, id)]),
                    gives: [[3119, 1], ...(strong ? [[7562, 8]] : [])], exp: strong ? 80933 : 32000, sp: strong ? 12250 : 3900,
                    removeRecipes: quest.questRecipes });
            } else return null;
        }
        return quest.onTalk(s, { fetchSelfId: () => s.session.activeNpcTalk.selfId });
    },
    async onSkillSee(s, npc, skill) {
        if (skill.fetchSelfId?.() !== 254 || s.session.actor.fetchClassId() !== 54 || s.getInt('cond') !== 5
            || s.getInt('pinter') !== 1 || !H.has(s, [[3122, 1], [3135, 1]])) return;
        const actual = NpcIndex.find(World, npc.fetchId());
        if (actual !== npc || npc.isDead() || !quest.skillNpcs.includes(npc.fetchSelfId())) return;
        const receipts = seen.get(npc) || new Set(), owner = s.session.actor.fetchId();
        if (receipts.has(owner)) return;
        const amount = invoke('GameServer/Quest/QuestService').questDropAmount(5, 70, H.count(s, 3136));
        if (!amount) return;
        await H.step(s, 5, { gives: [[3136, amount]] });
        receipts.add(owner); seen.set(npc, receipts);
    },
    async onKill(s, npc) {
        const cond = s.getInt('cond'), id = npc.fetchSelfId();
        if (cond === 3 && [154, 155, 156, 223].includes(id) && H.count(s, 3120))
            await H.step(s, 4, { gives: [[3121, 1]] });
        else if (cond === 5 && H.count(s, 3122)) {
            if (s.getInt('norman') === 2 && [267, 268, 269, 270, 271].includes(id) && Math.floor(Math.random() * 100) <= 30) {
                const amount = invoke('GameServer/Quest/QuestService').questDropAmount(1, 30, H.count(s, 3128));
                if (amount) await H.step(s, cond, { gives: [[3128, amount]],
                    takes: H.count(s, 3128) + amount === 30 ? [[3127, 1]] : [] });
            } else if (s.getInt('norman') === 3 && MATERIALS.some(row => row[0] === id)) {
                const row = MATERIALS.find(row => row[0] === id);
                if (!row) return;
                const amount = invoke('GameServer/Quest/QuestService').questDropAmount(row[2], 70, H.count(s, row[1]));
                if (amount) await H.step(s, cond, { gives: [[row[1], amount]] });
            } else if (s.getInt('pinter') === 1 && [79, 80, 81].includes(id) && H.count(s, 3136) < 70) {
                const bead = Math.floor(Math.random() * 100) <= 30;
                if (bead) await H.step(s, cond, { gives: [[3136, invoke('GameServer/Quest/QuestService').questDropAmount(1, 70, H.count(s, 3136))]] });
                else if (s.session.actor.fetchClassId() === 56) await H.step(s, cond, { gives: [[3137, 1]] });
            }
        }
    },
    onAbort: H.abort
};
module.exports = quest;
