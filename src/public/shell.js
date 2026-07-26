import { LANGUAGES } from './i18n.js';

const toggleSidebar = () => document.body.classList.toggle('sidebar-open');
for (const button of document.querySelectorAll('[data-sidebar-toggle]')) {
  button.addEventListener('click', toggleSidebar);
}

for (const button of document.querySelectorAll('[data-language-switch]')) {
  button.addEventListener('click', () => {
    const language = button.dataset.languageSwitch;
    if (!LANGUAGES.includes(language)) throw new TypeError(`unknown language: ${String(language)}`);
    document.cookie = `vidharbor_language=${language}; Path=/; SameSite=Lax`;
    location.reload();
  });
}
