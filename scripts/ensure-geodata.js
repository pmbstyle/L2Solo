#!/usr/bin/env node
'use strict';

const { ensureGeodata } = require('./geodata-bootstrap');

ensureGeodata().catch((error) => {
    console.error(`Geodata   :: bootstrap failed: ${error.message}`);
    process.exit(1);
});
