'use strict';

const { isMainThread } = require('node:worker_threads');

// Projector workers must not load World, even through a public writer helper.
module.exports = function refreshPartyMemberships(changedSessions, load) {
    if (!isMainThread) return 0;
    return load('GameServer/World/World').refreshPartyMemberships(changedSessions);
};
