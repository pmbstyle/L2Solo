'use strict';

const endpoint = 'https://l2solo.com/api/launcher/news';
const preview = [
    { id: 'welcome', category: 'WELCOME', title: 'Your world. Your pace.', excerpt: 'A living Chronicle 4 world, ready whenever you are. Install your server, find your rates, and make yourself at home.', publishedAt: '2026-10-31', url: 'https://l2solo.com' },
    { id: 'world', category: 'INSIDE L2SOLO', title: 'A world that lives alongside you', excerpt: 'Bots form parties, build clans, craft equipment and shape a working economy. There is always a story unfolding.', publishedAt: '2026-10-30', url: 'https://l2solo.com' },
    { id: 'community', category: 'COMMUNITY', title: 'Meet us by the campfire', excerpt: 'Follow development, share your adventures and help shape what comes next. Join the L2Solo community.', publishedAt: '2026-10-29', url: 'https://discord.gg/dXsQ8SJA7k' }
];

function safeLink(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password
            && ['l2solo.com', 'www.l2solo.com', 'github.com', 'discord.gg'].includes(url.hostname);
    } catch { return false; }
}

async function news(fetcher = fetch) {
    try {
        const response = await fetcher(endpoint, { signal: AbortSignal.timeout(7000), headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error('News unavailable');
        const raw = await response.text();
        if (raw.length > 256 * 1024) throw new Error('News response too large');
        const data = JSON.parse(raw);
        if (data.schemaVersion !== 1 || !Array.isArray(data.articles) || !data.articles.length) throw new Error('Unsupported news response');
        const articles = data.articles.slice(0, 12).map(article => {
            if (!['id', 'title', 'excerpt', 'category', 'publishedAt', 'url'].every(key => typeof article[key] === 'string')
                || !safeLink(article.url)) throw new Error('Invalid news article');
            return { id: article.id.slice(0, 80), title: article.title.slice(0, 160), excerpt: article.excerpt.slice(0, 600),
                category: article.category.slice(0, 40), publishedAt: article.publishedAt.slice(0, 30), url: article.url };
        });
        return { preview: false, articles };
    } catch { return { preview: true, articles: preview }; }
}

module.exports = { endpoint, news, safeLink };
