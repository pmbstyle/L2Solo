#!/usr/bin/env node
'use strict';

const { wipe } = require('./world-wipe');

wipe('bots').then((result) => {
    console.info(`Wiped ${result.characters} bot characters and ${result.accounts} bot accounts.`);
}).catch((err) => {
    console.error('Bot wipe failed:', err.message || err);
    process.exit(1);
});
