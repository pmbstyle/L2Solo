'use strict';

// The next event-loop turn: a long run of work that awaits it lets timers, messages and I/O in
// between (the one owner; safe on main and in workers, no dependencies).
module.exports = () => new Promise(resolve => setImmediate(resolve));
