const PrivateStore = invoke('GameServer/PrivateStore');
module.exports = (session) => { if (!PrivateStore.open(session, PrivateStore.SELL)) session?.dataSendToMe?.(invoke('GameServer/Network/Response').actionFailed()); };
