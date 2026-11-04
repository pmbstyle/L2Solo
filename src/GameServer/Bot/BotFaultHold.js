'use strict';

// The bounded answer to a bot whose work throws again and again (a deterministic bug in its
// state or a rule), hot and cold alike: each fault in a row holds the bot off longer, 1 s, 5 s,
// 30 s, then 2 min, and from the fifth it is quarantined 10 min at a time, until a success
// clears the run. Cold (ColdSimulationKernel.fault) holds the bot's step or its party's run;
// hot (BotAI.stateFaulted) holds the bot's AI state, and at the fifth fault in a row the bot
// also leaves that plan and its held decision is taken again. Pure: the cold worker loads it.
const BACKOFF_MS = [1000, 5000, 30000, 120000];
const QUARANTINE_AFTER = 5;
const QUARANTINE_MS = 10 * 60 * 1000;

// One more fault in a row on entry ({ count, holdUntil }, kept by the caller): its hold's end.
function fault(entry, now) {
    entry.count += 1;
    entry.holdUntil = now + (quarantined(entry) ? QUARANTINE_MS
        : BACKOFF_MS[Math.min(entry.count, BACKOFF_MS.length) - 1]);
    return entry.holdUntil;
}

function quarantined(entry) {
    return Number(entry?.count) >= QUARANTINE_AFTER;
}

module.exports = { BACKOFF_MS, QUARANTINE_AFTER, QUARANTINE_MS, fault, quarantined };
