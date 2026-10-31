const Rules = require('./Rules');
const { inClientView } = require('../World/WorldConstants');
const messages = { invalid_target: 144, self: 829, level: 898, duplicate: 832, exhausted: 833, full: 1188 };
let timer = null, running = null, cursor = 0, sweptDay = -1, stopping = false;
const notified = new Set();
const database = () => invoke('Database');
const world = () => invoke('GameServer/World/World');
const response = () => invoke('GameServer/Network/Response');

function activeRecord(id) {
    const record = world().registeredActorById(id);
    return record && !record.retired && record.session?.actor === record.actor
        && record.actor?.fetchIsOnline?.() === true ? record : null;
}
function sync(rows, extraActor = null, publish = true) {
    for (const row of rows) {
        // Login may hydrate an actor before publication. Sending packets always
        // requires a current, non-retired world registration.
        const actor = !publish && Number(extraActor?.fetchId()) === row.id ? extraActor : activeRecord(row.id)?.actor;
        if (!actor?.model || Number(actor.model.recRevision || 0) > row.recRevision) continue;
        const changed = actor.model.evalScore !== row.evalScore || actor.model.recRemain !== row.recRemain;
        Object.assign(actor.model, { evalScore: row.evalScore, recRemain: row.recRemain, recDay: row.recDay,
            recSpent: row.recSpent, recRevision: row.recRevision });
        const session = actor.session;
        if (publish && changed && session?.actor === actor) {
            session.dataSendToMe?.(response().userInfo(actor));
            session.dataSendToOthers?.(response().charInfo(actor), actor);
        }
    }
}
function notify(event, rows) {
    const source = rows.find(row => row.id === event.sourceId), target = rows.find(row => row.id === event.targetId);
    if (!source || !target) return;
    const sender = activeRecord(source.id)?.session, recipient = activeRecord(target.id)?.session;
    sender?.dataSendToMe?.(response().systemMessage.typed(830, target.name, { number: source.recRemain }));
    recipient?.dataSendToMe?.(response().systemMessage(831, source.name));
}
async function refresh(actor) {
    if (!database().isReady()) return [];
    const rows = await database().refreshRecommendations([Number(actor.fetchId())]);
    sync(rows, actor, false);
    return rows;
}
async function recommend(session, targetId) {
    const actor = session?.actor, sourceRecord = actor && activeRecord(Number(actor.fetchId()));
    const targetRecord = activeRecord(Number(targetId)), target = targetRecord?.actor;
    const eligible = () => !!sourceRecord && !!targetRecord && sourceRecord.session === session
        && session.actor === actor && activeRecord(sourceRecord.id) === sourceRecord
        && activeRecord(Number(targetId)) === targetRecord
        && Number(actor.fetchDestId()) === Number(targetId)
        && inClientView(actor.fetchLocX(), actor.fetchLocY(), target.fetchLocX(), target.fetchLocY());
    if (!eligible()) {
        session?.dataSendToMe?.(response().systemMessage(messages.invalid_target));
        return { ok: false, code: 'invalid_target' };
    }
    // Check selection and session again at admission to the serialized SQL
    // queue; the selected character is captured, never looked up by name.
    const result = await database().giveRecommendation(Number(actor.fetchId()), Number(targetId), eligible);
    sync(result.rows, session.actor === actor ? actor : null);
    if (result.ok) {
        notify(result.event, result.rows);
        notified.add(result.event.id);
    } else if (session.actor === actor) session.dataSendToMe(response().systemMessage(messages[result.code] || 144));
    return result;
}
async function flushPage() {
    const events = await database().fetchRecommendationEvents(cursor);
    if (events.length) {
        const ids = [...new Set(events.flatMap(event => [event.sourceId, event.targetId]))];
        const rows = [];
        for (let i = 0; i < ids.length; i += 128) rows.push(...await database().refreshRecommendations(ids.slice(i, i + 128)));
        sync(rows);
        for (const event of events) {
            // Old events are retained for pair limits and auditing, not login spam.
            if (!notified.has(event.id) && Date.now() - event.createdAt < 60000) notify(event, rows);
            notified.delete(event.id);
            cursor = event.id;
        }
    }
    const day = Rules.day(Date.now());
    if (day !== sweptDay) {
        const ids = (world().user?.sessions || []).filter(session => activeRecord(Number(session.actor?.fetchId()))?.session === session)
            .map(session => Number(session.actor.fetchId()));
        for (let i = 0; i < ids.length; i += 128) sync(await database().refreshRecommendations(ids.slice(i, i + 128)));
        await database().pruneRecommendations();
        sweptDay = day;
    }
    return events.length === 128;
}
function flush() {
    if (running) return running;
    running = flushPage().finally(() => { running = null; });
    return running;
}
async function start() {
    if (timer) return;
    stopping = false;
    cursor = await database().recommendationHead();
    await flush();
    const schedule = (delay = 1000) => {
        if (stopping) return;
        timer = setTimeout(() => {
            timer = null;
            flush().then(more => schedule(more ? 0 : 1000), error => {
                utils.infoWarn('Recommendations', 'publication failed: %s', error.message);
                schedule();
            });
        }, delay);
        timer.unref?.();
    };
    schedule();
}
async function stop() {
    stopping = true;
    clearTimeout(timer); timer = null;
    if (running) await running;
    notified.clear();
}
module.exports = { refresh, recommend, sync, flush, start, stop };
