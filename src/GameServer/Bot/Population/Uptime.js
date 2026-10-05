// The uptime clock: the start of the server process, the same in its worker
// threads. Time before it was downtime.
const SERVER_STARTED_AT = Date.now() - process.uptime() * 1000;

// The uptime between two moments: a span that crosses the start counts only
// from the start; a span wholly before it (a journal replayed at boot) counts
// as it was.
function between(from, to, startedAt = SERVER_STARTED_AT) {
    const start = Number(from);
    const end = Number(to);
    if (!(end > start)) return 0;
    return start < startedAt && end >= startedAt ? end - startedAt : end - start;
}

module.exports = { SERVER_STARTED_AT, between };
