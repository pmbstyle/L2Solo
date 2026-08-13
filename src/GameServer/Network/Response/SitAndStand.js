const changeWaitType = require('./ChangeWaitType');

function sitAndStand(actor) {
    return changeWaitType(actor, actor.state.fetchSeated() ? 0 : 1);
}

module.exports = sitAndStand;
