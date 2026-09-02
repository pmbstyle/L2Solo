const PrivateStore = invoke('GameServer/PrivateStore');
module.exports = (session) => {
    const opened = PrivateStore.open(session, PrivateStore.BUY);
    const reject = () => session?.dataSendToMe?.(invoke('GameServer/Network/Response').actionFailed());
    if (opened && typeof opened.then === 'function') return opened.then((ok) => { if (!ok) reject(); }).catch(reject);
    if (!opened) reject();
};
