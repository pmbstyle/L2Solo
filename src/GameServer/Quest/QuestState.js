const Database = invoke('Database');
const ServerResponse = invoke('GameServer/Network/Response');

const CREATED = 'created';
const STARTED = 'started';
const COMPLETED = 'completed';

class QuestState {
    constructor(session, quest, row = {}) {
        this.session = session;
        this.quest = quest;
        this.state = row.state || CREATED;
        try {
            this.variables = typeof row.variables === 'string' ? JSON.parse(row.variables || '{}') : (row.variables || {});
        } catch (_) {
            this.variables = {};
        }
    }

    get(name, fallback = null) { return this.variables[name] ?? fallback; }
    getInt(name, fallback = 0) { return Number(this.get(name, fallback)) || 0; }
    set(name, value) { this.variables[name] = String(value); return this.save(); }
    setState(state) { this.state = state; return this.save(); }
    isStarted() { return this.state === STARTED; }
    isCompleted() { return this.state === COMPLETED; }
    playSound(sound) { this.session.dataSendToMe(ServerResponse.playSound(sound)); }

    save() {
        return Database.setCharacterQuest(this.session.actor.fetchId(), this.quest.id, this.state, this.variables);
    }

    async exit(repeatable = false) {
        if (repeatable) {
            this.state = CREATED;
            this.variables = {};
        } else {
            this.state = COMPLETED;
        }
        await this.save();
    }
}

QuestState.CREATED = CREATED;
QuestState.STARTED = STARTED;
QuestState.COMPLETED = COMPLETED;
QuestState.SOUND_ACCEPT = 'ItemSound.quest_accept';
QuestState.SOUND_ITEMGET = 'ItemSound.quest_itemget';
QuestState.SOUND_MIDDLE = 'ItemSound.quest_middle';
QuestState.SOUND_FINISH = 'ItemSound.quest_finish';

module.exports = QuestState;
