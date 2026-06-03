const ServerResponse = invoke('GameServer/Network/Response');

const BotMerchant = {
    talk(session, merchantBot) {
        const name = merchantBot.fetchName();
        const html = `<html><body>
        <font color="LEVEL">${name}:</font><br>
        Приветствую, ${session.actor.fetchName()}! Я продаю ресурсы и предметы, добытые охотниками в окрестностях этого города.<br>
        Хочешь посмотреть мои товары?<br>
        <center>
            <br>
            <a action="bypass -h buy-bot-shop">Купить локальный дроп</a><br>
            <a action="bypass -h sell-junk">Продать ненужные вещи (все не надетое)</a><br>
        </center>
        </body></html>`;

        session.dataSendToMe(
            ServerResponse.npcHtml(merchantBot.fetchId(), html)
        );
    }
};

module.exports = BotMerchant;
