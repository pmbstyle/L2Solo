'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// A separate SQLite lock survives database replacement and is released by the OS
// even after a crash. Keep this file: unlinking it would split the lock domain.
function acquireDatabaseAccess(databasePath) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const canonicalPath = fs.existsSync(databasePath)
        ? fs.realpathSync(databasePath)
        : path.join(fs.realpathSync(path.dirname(databasePath)), path.basename(databasePath));
    const lock = new DatabaseSync(`${canonicalPath}.access.sqlite`);
    try {
        lock.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;');
    } catch (error) {
        lock.close();
        if (/locked|busy/i.test(error.message)) {
            throw Object.assign(new Error('The database is in use. Stop the server and wait for any database operation to finish.'), { statusCode: 409 });
        }
        throw error;
    }
    return () => lock.close();
}

module.exports = { acquireDatabaseAccess };
