const Database = invoke('Database');
const ClanService = invoke('GameServer/Clan/ClanService');
const ClanRules = invoke('GameServer/Clan/ClanRules');
const ServerResponse = invoke('GameServer/Network/Response');

function npcId(session) {
    return session.activeNpcTalk?.objectId || session.actor?.fetchId?.() || 0;
}

function sendHtml(session, body) {
    session.dataSendToMe(ServerResponse.npcHtml(npcId(session), body));
}

function speak(session, text) {
    session.dataSendToMe(ServerResponse.speak(session.actor, { kind: 0, text }));
}

function page(body) {
    return `<html><body>Clan Manager:<br>${body}</body></html>`;
}

function returnLink() {
    return '<br><a action="bypass -h clan menu">Back</a>';
}

function menu(session) {
    const actor = session.actor;
    const clan = ClanService.clanForActor(actor);
    const role = clan
        ? `${clan.name}, level ${clan.level}${ClanService.isLeader(actor, clan) ? ' (leader)' : ''}`
        : 'No clan';

    sendHtml(session, page(
        `Status: <font color="LEVEL">${role}</font><br><br>` +
        '<a action="bypass -h clan create-form">Create a Clan</a><br1>' +
        '<a action="bypass -h clan level-info">Increase Clan Level</a><br1>' +
        '<a action="bypass -h clan members">Clan Members</a>'
    ));
}

function createForm(session) {
    sendHtml(session, page(
        'Create Clan:<br>Enter Clan Name:<br>' +
        '<edit var="name" width=120 height=15><br>' +
        '<button value="Create" action="bypass -h clan create $name" width=60 height=15 back="sek.cbui94" fore="sek.cbui92">' +
        returnLink()
    ));
}

function createClan(session, name) {
    ClanService.create(session.actor, name).then((result) => {
        if (!result.ok) {
            sendHtml(session, page(errorText(result.code) + returnLink()));
            return;
        }

        const clan = result.clan;
        ClanService.refreshOnlineMembers(clan);
        session.dataSendToMe(ServerResponse.pledgeShowInfoUpdate(clan));
        session.dataSendToMe(ServerResponse.pledgeShowMemberListAll(clan, session.actor));
        session.dataSendToMe(ServerResponse.userInfo(session.actor));
        speak(session, `Clan ${clan.name} has been created.`);
        sendHtml(session, page(`Clan <font color="LEVEL">${clan.name}</font> has been created.` + returnLink()));
    }).catch((err) => {
        utils.infoWarn('Clan', 'create clan failed: %s', err.message);
        sendHtml(session, page('Failed to create clan.' + returnLink()));
    });
}

function levelInfo(session) {
    sendHtml(session, page(
        'You may raise the level of the clan. You will need the following:<br>' +
        '<font color="LEVEL">Clan Level 1:</font> 30,000 SP plus 650,000 adena<br>' +
        '<font color="LEVEL">Clan Level 2:</font> 150,000 SP plus 2,500,000 adena<br>' +
        '<font color="LEVEL">Clan Level 3:</font> 500,000 SP plus Proof of Blood<br>' +
        '<font color="LEVEL">Clan Level 4:</font> 1,400,000 SP plus Proof of Alliance<br>' +
        '<font color="LEVEL">Clan Level 5:</font> 3,500,000 SP plus Proof of Aspiration<br><br>' +
        '<button value="Level Up" action="bypass -h clan level-up" width=60 height=15 back="sek.cbui94" fore="sek.cbui92">' +
        returnLink()
    ));
}

function deleteItem(session, item, amount) {
    return new Promise((resolve) => {
        session.actor.backpack.deleteItem(session, item.fetchId(), amount, resolve);
    });
}

function spendLevelCost(session, requirement) {
    const actor = session.actor;
    const currentSp = Number(actor.fetchSp()) || 0;
    if (currentSp < requirement.sp) {
        return Promise.resolve({ ok: false, code: 'not_enough_sp' });
    }

    const adenaItem = requirement.adena ? actor.backpack.fetchItemFromSelfId(57) : null;
    if (requirement.adena && (!adenaItem || adenaItem.fetchAmount() < requirement.adena)) {
        return Promise.resolve({ ok: false, code: 'not_enough_adena' });
    }

    const proofItem = requirement.itemId ? actor.backpack.fetchItemFromSelfId(requirement.itemId) : null;
    if (requirement.itemId && !proofItem) {
        return Promise.resolve({ ok: false, code: 'missing_item', itemName: requirement.itemName });
    }

    actor.setSp(currentSp - requirement.sp);
    const persistSp = Database.updateCharacterExperience(actor.fetchId(), actor.fetchLevel(), actor.fetchExp(), actor.fetchSp());
    const spendItem = requirement.adena
        ? deleteItem(session, adenaItem, requirement.adena)
        : (proofItem ? deleteItem(session, proofItem, 1) : Promise.resolve());

    return Promise.all([persistSp, spendItem]).then(() => ({ ok: true }));
}

function statusParams(actor) {
    return [
        { id: 0x0d, value: Number(actor.fetchSp()) || 0 }
    ];
}

function levelUp(session) {
    const actor = session.actor;
    const clan = ClanService.clanForActor(actor);
    if (!clan) {
        sendHtml(session, page('You are not in a clan.' + returnLink()));
        return;
    }
    if (!ClanService.isLeader(actor, clan)) {
        sendHtml(session, page('Only the clan leader may raise the clan level.' + returnLink()));
        return;
    }
    if (clan.dissolvingExpiryTime > Date.now()) {
        sendHtml(session, page('Cannot raise clan level while dissolution is in progress.' + returnLink()));
        return;
    }

    const requirement = ClanRules.LEVEL_REQUIREMENTS[clan.level];
    if (!requirement) {
        sendHtml(session, page('The clan cannot be raised further in this Chronicle slice.' + returnLink()));
        return;
    }

    spendLevelCost(session, requirement).then((spent) => {
        if (!spent.ok) {
            sendHtml(session, page(errorText(spent.code, spent) + returnLink()));
            return;
        }

        ClanService.changeLevel(clan, requirement.nextLevel).then(() => {
            ClanService.onlineSessions(clan).forEach((memberSession) => {
                memberSession.dataSendToMe(ServerResponse.pledgeShowInfoUpdate(clan));
            });
            session.dataSendToMe(ServerResponse.statusUpdate(actor.fetchId(), statusParams(actor)));
            session.dataSendToMe(ServerResponse.userInfo(actor));
            speak(session, `Clan level increased to ${clan.level}.`);
            sendHtml(session, page(`Clan level increased to <font color="LEVEL">${clan.level}</font>.` + returnLink()));
        });
    }).catch((err) => {
        utils.infoWarn('Clan', 'level up failed: %s', err.message);
        sendHtml(session, page('Failed to increase clan level.' + returnLink()));
    });
}

function members(session) {
    const clan = ClanService.clanForActor(session.actor);
    if (!clan) {
        sendHtml(session, page('You are not in a clan.' + returnLink()));
        return;
    }

    const rows = clan.members
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((member) => `${member.name} Lv.${member.level}${Number(member.id) === Number(clan.leaderId) ? ' leader' : ''}`)
        .join('<br1>');

    sendHtml(session, page(`<font color="LEVEL">${clan.name}</font><br>${rows || 'No members.'}` + returnLink()));
}

function errorText(code, details = {}) {
    return ({
        name_too_short: 'Clan name is too short.',
        name_too_long: 'Clan name is too long.',
        name_invalid: 'Clan name must use letters and numbers only.',
        level_too_low: 'You must be at least level 10 to create a clan.',
        already_in_clan: 'You are already in a clan.',
        create_cooldown: 'You must wait before creating another clan.',
        name_exists: 'Clan name already exists.',
        no_privilege: 'You are not authorized.',
        not_enough_sp: 'You do not have enough SP.',
        not_enough_adena: 'You do not have enough Adena.',
        missing_item: `You need ${details.itemName || 'the required item'}.`
    })[code] || 'Action failed.';
}

module.exports = function(session, parts) {
    const action = parts[1] || 'menu';

    if (!session.actor || session.actor.isDead()) return;

    if (action === 'menu') return menu(session);
    if (action === 'create-form') return createForm(session);
    if (action === 'create') return createClan(session, parts.slice(2).join(' '));
    if (action === 'level-info') return levelInfo(session);
    if (action === 'level-up') return levelUp(session);
    if (action === 'members') return members(session);

    return menu(session);
};

module.exports.statusParams = statusParams;
