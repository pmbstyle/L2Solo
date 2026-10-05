// Shared transaction and dialogue plumbing for C4's delivery-and-hunt trials.
const H = require('./SecondProfessionQuest');
module.exports = function journey(d) {
    const rows = s => typeof d.rows === 'function' ? d.rows(s) : d.rows;
    const available = s => rows(s).filter(r => r[0] === s.getInt('cond'));
    const quest = {
        id: d.id, name: d.name, startNpcs: [d.startNpc], npcs: d.npcs,
        clientCondition: d.clientCondition,
        killNpcs: [...new Set(d.drops.map(r => r[1]))], questItems: d.questItems,
        eventNpc: e => e === 'start' ? d.startNpc : e === 'handin' ? d.npcs : null,
        canTalk: (s, npc) => s.isStarted() || s.isCompleted() || npc.fetchSelfId() === d.startNpc && d.eligible(s),
        async onTalk(s, npc) {
            if (s.isCompleted()) return H.page(s, 'Your trial is complete.');
            if (!s.isStarted()) return H.page(s, d.intro, H.link(d.id, 'start', 'Accept the trial'));
            const next = available(s), action = next.some(r => r[1] === npc.fetchSelfId() && H.has(s, r[3]));
            const objectives = d.drops.filter(r => r[0] === s.getInt('cond') && (!r[5] || H.has(s, r[5])));
            const text = next.map(r => `Visit ${H.npcName(r[1])}.<br>` + r[3].map(([id, n]) => `${H.itemName(id)}: ${H.count(s, id)}/${n}`).join('<br>')).join('<br>');
            const hunt = objectives.map(r => `Hunt ${H.npcName(r[1])}: ${H.itemName(r[2])} ${H.count(s, r[2])}/${r[3]}.`).join('<br>');
            return H.page(s, text + '<br>' + hunt + (d.note?.(s) || ''), action ? H.link(d.id, 'handin', 'Speak and continue the trial') : '');
        },
        async onEvent(s, e) {
            const id = s.session.activeNpcTalk.selfId;
            if (e === 'start') {
                if (s.isStarted() || s.isCompleted() || !d.eligible(s)) return null;
                await H.step(s, 1, { gives: d.startItems || [] });
            } else if (e === 'handin' && s.isStarted()) {
                const r = available(s).find(r => r[1] === id && H.has(s, r[3]));
                if (!r) return null;
                if (r[5]?.minLevel && s.session.actor.fetchLevel() < r[5].minLevel) return H.page(s, `Return at level ${r[5].minLevel}.`);
                const finish = r[2] === 0;
                await H.step(s, r[2], { takes: finish ? d.questItems.map(id => [id, H.count(s, id)]) : r[3], gives: r[4],
                    ...(finish ? { status: 'completed', exp: d.exp, sp: d.sp } : {}) });
            } else return null;
            return quest.onTalk(s, { fetchSelfId: () => id });
        },
        async onKill(s, npc) {
            const r = d.drops.find(r => r[0] === s.getInt('cond') && r[1] === npc.fetchSelfId()
                && H.count(s, r[2]) < r[3] && (!r[5] || H.has(s, r[5])) && (!r[6] || !H.count(s, r[6])));
            if (r && Math.floor(Math.random() * 100) < r[4]) await H.step(s, s.getInt('cond'), { gives: [[r[2], 1]] });
        },
        onAbort: H.abort
    };
    return quest;
};
