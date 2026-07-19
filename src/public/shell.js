const toggleSidebar = () => document.body.classList.toggle('sidebar-open');
for (const button of document.querySelectorAll('[data-sidebar-toggle]')) {
  button.addEventListener('click', toggleSidebar);
}
