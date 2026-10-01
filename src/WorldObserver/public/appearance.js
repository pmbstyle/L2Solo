(function appearance(root) {
    const key = 'observer.appearance';
    const media = root.matchMedia('(prefers-color-scheme: dark)');
    let preference = 'system';
    try { preference = root.localStorage.getItem(key) || 'system'; } catch (_) { /* Storage may be unavailable. */ }
    if (!['system', 'light', 'dark'].includes(preference)) preference = 'system';
    function apply() {
        const theme = preference === 'system' ? (media.matches ? 'dark' : 'light') : preference;
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.colorScheme = theme;
        root.dispatchEvent(new CustomEvent('observer:appearance', { detail: { theme, preference } }));
    }
    root.WorldObserverAppearance = {
        get preference() { return preference; },
        set(value) {
            if (!['system', 'light', 'dark'].includes(value)) return;
            preference = value;
            try { root.localStorage.setItem(key, value); } catch (_) { /* Keep the in-memory preference. */ }
            apply();
        }
    };
    media.addEventListener('change', () => { if (preference === 'system') apply(); });
    apply();
}(window));
