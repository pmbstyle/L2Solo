'use strict';

async function confirmDatabaseRestore(dialog, window, journal) {
    const files = journal.startupDatabasePaths || journal.databaseBackup.files;
    const result = await dialog.showMessageBox(window, {
        type: 'question', title: 'Server update failed',
        message: 'Restore the world database from backup?',
        detail: 'The new server failed to start after database migrations began. Restoring the backup taken before this update replaces the current world and history databases. Keeping current data leaves both files unchanged.\n\n'
            + files.map((file, index) => `${index ? 'History' : 'World'}: ${file.canonicalPath || file.path}`).join('\n'),
        buttons: ['Yes, restore backup', 'No, keep current data'],
        defaultId: 1, cancelId: 1, noLink: true
    });
    return result.response === 0;
}

module.exports = { confirmDatabaseRestore };
