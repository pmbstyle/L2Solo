function queueRequest(session, actor, event, data) {
    if (actor.state.fetchHits() || actor.state.fetchCasts() || actor.state.fetchAnimated()) {
        actor.attack.queueEvent(event, data);
    }
}

module.exports = queueRequest;
