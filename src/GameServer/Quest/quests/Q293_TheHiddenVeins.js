// Compatibility entry point; gameplay uses shared atomic quest steps.
module.exports = require('../DeclarativeQuest').create(require('../BeginnerQuestDefinitions').find(d => d.id === 293));
