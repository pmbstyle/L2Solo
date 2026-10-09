'use strict';
const { MAX_COMMITMENTS } = require('./TradeMeeting');
const { isBotAccount } = require('./BoardRules');
const notices = new WeakMap();
const messages = {
    accepted: 'Trade in progress. Goods and payment are reserved. Wait at the meeting point.',
    completed: 'Trade completed. Goods and payment are delivered.',
    cancelled: 'Trade cancelled. Unused goods and payment are returned.'
};

// Only committed meeting rows reach here, after the player's bag is refreshed.
// Read the agreed basket, not a stack's new total or unrelated inventory changes.
function received(row, side) {
    const terms = typeof row.terms === 'string' ? JSON.parse(row.terms) : row.terms;
    const items = new Map();
    let adena = 0;
    for (const line of terms?.lines || []) {
        if (line.payer === side) items.set(line.selfId, (items.get(line.selfId) || 0) + line.count);
        else adena += line.count * line.price;
    }
    if (adena > 0) items.set(57, adena);
    return [...items];
}

function notify(session, row) {
    const id = session?.actor?.fetchId?.(), side = [row.actorA, row.actorB].indexOf(id);
    if (side < 0 || !session.dataSendToMe || isBotAccount(session.accountId) || !messages[row.state]) return;
    let ledger = notices.get(session);
    if (!ledger || ledger.actorId !== id) notices.set(session, ledger = { actorId: id, meetings: new Map() });
    let notice = ledger.meetings.get(row.id);
    if (notice?.terminalState && notice.terminalState !== row.state) return;
    const awards = row.state === 'completed' ? received(row, side) : [];
    if (!notice) {
        ledger.meetings.set(row.id, notice = { state: null, awardsSent: 0 });
        // Active commitments are bounded by native custody. Retain those while
        // capping the older terminal receipts kept for concurrent/replayed calls.
        for (const [meetingId, previous] of ledger.meetings) {
            if (ledger.meetings.size <= MAX_COMMITMENTS * 8) break;
            if (previous.terminalState) ledger.meetings.delete(meetingId);
        }
    }
    if (row.state !== 'accepted') notice.terminalState = row.state;
    if (notice.state !== row.state) {
        session.dataSendToMe(invoke('GameServer/Network/Response').systemMessage.text(messages[row.state]));
        notice.state = row.state;
    }
    while (notice.awardsSent < awards.length) {
        const [selfId, count] = awards[notice.awardsSent];
        invoke('GameServer/ConsoleText').transmitPickup(session, selfId, count);
        notice.awardsSent++;
    }
}

module.exports = { notify, messages };
