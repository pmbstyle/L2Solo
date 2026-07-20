const PrivateStore = invoke('GameServer/PrivateStore');
module.exports = (type) => (session) => { if (!PrivateStore.quit(session, type)) session?.dataSendToMe?.(invoke('GameServer/Network/Response').actionFailed()); };
