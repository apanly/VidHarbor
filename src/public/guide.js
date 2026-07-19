const toc = document.querySelector('#guide-toc');
const headings = document.querySelectorAll('#guide-content h2');
headings.forEach((heading, index) => {
  heading.id = `guide-section-${index + 1}`;
  const link = document.createElement('a');
  link.href = `#${heading.id}`;
  link.textContent = heading.textContent;
  toc.append(link);
});
