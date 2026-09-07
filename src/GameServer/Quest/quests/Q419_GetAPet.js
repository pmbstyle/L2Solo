// Q419 flow and question pool: L2J Lisvus, pinned by generate-c4-pets.js.
const { questions, tutorials } = require('../../../../data/Pets/c4-wolf-quiz.json');
const MARTIN = 7731;
const tutors = { 7256: ['Bella', 1, 'Wolves live in packs, led by the strongest pair. Learn how they communicate and hunt.'],
    7091: ['Ellie', 2, 'A pet needs food, equipment and care. Keep food in its inventory and resurrect it promptly if it dies.'],
    7072: ['Metty', 4, 'Wolves live in several regions of Aden. A pet earns combat experience through its contribution.'] };
const mobs = [[103, 106, 108], [460, 308, 466], [25, 105, 34], [474, 476, 478], [403, 508]];
const Q = () => invoke('GameServer/Quest/QuestService');
const count = (state, id) => state.session.actor.backpack.fetchItemFromSelfId(id)?.fetchAmount() || 0;
const link = (event, text) => `<a action="bypass -h quest 419 ${event}">${text}</a>`;
const page = text => `<html><body>Pet Manager Martin:<br>${text}</body></html>`;
function quizPage(state) {
    const quiz = JSON.parse(state.get('quiz', '[]'));
    const index = state.getInt('answers');
    const question = questions.find(q => q.id === quiz[index]);
    if (!question) return page('Speak to the animal lovers before taking the test.');
    return page(question.text + question.answers.map((answer, i) => link(`answer_${index}_${question.id}_${i}`, answer.text)).join('<br>'));
}
module.exports = {
    id: 419, name: 'Get a Pet', npcs: [MARTIN, ...Object.keys(tutors).map(Number)], startNpcs: [MARTIN], killNpcs: mobs.flat(),
    canTalk: state => state.isStarted() || state.session.actor.fetchLevel() >= 15,
    eventNpc: event => event.startsWith('learn_') ? Number(event.slice(6)) : ['start', 'proof', 'quiz'].includes(event) || /^answer_\d+_\d+_\d+$/.test(event) ? MARTIN : null,
    async onTalk(state, npc) {
        const id = npc.fetchSelfId();
        if (tutors[id]) return state.getInt('cond') === 2
            ? `<html><body>${tutors[id][0]}:<br>${tutors[id][2]}<br>${link(`learn_${id}`, 'Continue learning about pets.')}</body></html>` : page('Speak to Martin in Gludin.');
        if (!state.isStarted()) return page(state.session.actor.fetchLevel() >= 15 ? link('start', 'I would like to raise a wolf.') : 'Come back at level 15.');
        if (state.getInt('cond') === 1) return page(`Collect 50 proofs from the creatures on your Animal Slayer List.<br>${link('proof', 'I have brought the proofs.')}`);
        if (state.getInt('cond') === 2) return page(`Visit Bella in Gludio, Ellie in Giran and Metty in Dion, then answer ten questions correctly.<br>${link('quiz', 'I am ready for the test.')}`);
        return quizPage(state);
    },
    async onEvent(state, event) {
        const race = Number(state.session.actor.fetchRace());
        if (!mobs[race]) return null;
        if (event === 'start' && !state.isStarted() && state.session.actor.fetchLevel() >= 15) {
            await state.setState('started'); await state.set('cond', 1);
            await Q().giveItem(state.session, 3418 + race, 1);
            return page('Collect 50 proofs from the creatures on your Animal Slayer List.');
        }
        if (!state.isStarted()) return null;
        if (event === 'proof' && state.getInt('cond') === 1 && count(state, 3423 + race) >= 50) {
            if (!(await Q().takeItem(state.session, 3423 + race, 50))) return null;
            await Q().takeItem(state.session, 3418 + race, 1);
            await Q().giveItem(state.session, 3417, 1);
            await state.set('visits', 0); await state.set('cond', 2);
            return page('Visit Bella in Gludio, Ellie in Giran and Metty in Dion.');
        }
        if (event.startsWith('learn_') && state.getInt('cond') === 2) {
            const tutor = tutors[Number(event.slice(6))];
            if (!tutor) return null;
            await state.set('visits', state.getInt('visits') | tutor[1]);
            return `<html><body>${tutor[0]}:<br>${tutorials[Number(event.slice(6))]}<br>Return to Martin after visiting all three animal lovers.</body></html>`;
        }
        if (event === 'quiz' && state.getInt('cond') === 2 && state.getInt('visits') === 7) {
            const pool = questions.map(q => q.id);
            for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
            await state.set('quiz', JSON.stringify(pool.slice(0, 10))); await state.set('answers', 0); await state.set('cond', 3);
            return quizPage(state);
        }
        const answer = event.match(/^answer_(\d+)_(\d+)_(\d+)$/);
        if (answer && state.getInt('cond') === 3) {
            const [, position, id, option] = answer.map(Number);
            const quiz = JSON.parse(state.get('quiz', '[]'));
            if (position !== state.getInt('answers') || quiz[position] !== id) return null;
            const chosen = questions.find(q => q.id === id)?.answers[option];
            if (!chosen) return null;
            if (!chosen.correct) {
                await state.set('visits', 0); await state.set('cond', 2);
                return page('That answer was incorrect. Visit the three animal lovers again before another test.');
            }
            if (position === 9) {
                await Q().completeWolfQuest(state);
                state.playSound('ItemSound.quest_finish');
                return page('Here is your Wolf Collar. Keep food in your wolf\'s inventory, and take good care of it.');
            }
            await state.set('answers', position + 1);
            return quizPage(state);
        }
        return null;
    },
    async onKill(state, npc) {
        const race = state.session.actor.fetchRace();
        if (state.getInt('cond') !== 1 || !mobs[race]?.includes(npc.fetchSelfId())) return;
        const amount = Q().questDropAmount(1, 50, count(state, 3423 + race));
        if (amount > 0) await Q().giveItem(state.session, 3423 + race, amount);
    }
};
