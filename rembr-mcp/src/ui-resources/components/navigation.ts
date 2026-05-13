/**
 * Navigation Components
 * Reusable navigation templates for Rembr UI
 */

export interface NavLink {
  label: string;
  href: string;
  active?: boolean;
  icon?: string;
}

export interface HeaderOptions {
  logo?: { text: string; href?: string; image?: string };
  links?: NavLink[];
  actions?: string; // HTML for action buttons (e.g., login/signup)
  className?: string;
}

/**
 * Render a header navigation component
 */
export function renderHeader(options: HeaderOptions = {}): string {
  const {
    logo = { text: 'Rembr', href: '/' },
    links = [],
    actions,
    className = '',
  } = options;

  const logoImageHtml = logo.image
    ? `<img src="${logo.image}" alt="${logo.text}" class="rembr-header-logo-image" />`
    : '';

  const logoHtml = `
    <a href="${logo.href || '/'}" class="rembr-header-logo">
      ${logoImageHtml}
      <span class="rembr-header-logo-text">${logo.text}</span>
    </a>
  `;

  const linksHtml = links.length > 0
    ? `
      <nav class="rembr-header-nav">
        ${links
          .map(
            link => `
          <a 
            href="${link.href}" 
            class="rembr-header-link ${link.active ? 'rembr-header-link-active' : ''}"
          >
            ${link.icon ? `<span class="rembr-header-link-icon">${link.icon}</span>` : ''}
            ${link.label}
          </a>
        `
          )
          .join('')}
      </nav>
    `
    : '';

  const actionsHtml = actions
    ? `<div class="rembr-header-actions">${actions}</div>`
    : '';

  return `
    <header class="rembr-header ${className}">
      <div class="rembr-header-container">
        ${logoHtml}
        ${linksHtml}
        ${actionsHtml}
      </div>
    </header>
  `.trim();
}

/**
 * Footer options
 */
export interface FooterSection {
  title: string;
  links: Array<{ label: string; href: string }>;
}

export interface FooterOptions {
  sections?: FooterSection[];
  copyright?: string;
  socialLinks?: Array<{ icon: string; href: string; label: string }>;
  className?: string;
}

/**
 * Render a footer component
 */
export function renderFooter(options: FooterOptions = {}): string {
  const {
    sections = [],
    copyright,
    socialLinks = [],
    className = '',
  } = options;

  const sectionsHtml = sections.length > 0
    ? `
      <div class="rembr-footer-sections">
        ${sections
          .map(
            section => `
          <div class="rembr-footer-section">
            <h4 class="rembr-footer-section-title">${section.title}</h4>
            <ul class="rembr-footer-links">
              ${section.links
                .map(
                  link => `
                <li>
                  <a href="${link.href}" class="rembr-footer-link">${link.label}</a>
                </li>
              `
                )
                .join('')}
            </ul>
          </div>
        `
          )
          .join('')}
      </div>
    `
    : '';

  const socialLinksHtml = socialLinks.length > 0
    ? `
      <div class="rembr-footer-social">
        ${socialLinks
          .map(
            link => `
          <a 
            href="${link.href}" 
            class="rembr-footer-social-link" 
            aria-label="${link.label}"
            target="_blank"
            rel="noopener noreferrer"
          >
            ${link.icon}
          </a>
        `
          )
          .join('')}
      </div>
    `
    : '';

  const copyrightHtml = copyright
    ? `<p class="rembr-footer-copyright">${copyright}</p>`
    : '';

  return `
    <footer class="rembr-footer ${className}">
      <div class="rembr-footer-container">
        ${sectionsHtml}
        <div class="rembr-footer-bottom">
          ${copyrightHtml}
          ${socialLinksHtml}
        </div>
      </div>
    </footer>
  `.trim();
}

/**
 * Sidebar options
 */
export interface SidebarOptions {
  links: NavLink[];
  collapsible?: boolean;
  collapsed?: boolean;
  className?: string;
}

/**
 * Render a sidebar navigation component
 */
export function renderSidebar(options: SidebarOptions): string {
  const {
    links,
    collapsible = false,
    collapsed = false,
    className = '',
  } = options;

  const collapsibleClass = collapsible ? 'rembr-sidebar-collapsible' : '';
  const collapsedClass = collapsed ? 'rembr-sidebar-collapsed' : '';

  const linksHtml = links
    .map(
      link => `
      <a 
        href="${link.href}" 
        class="rembr-sidebar-link ${link.active ? 'rembr-sidebar-link-active' : ''}"
      >
        ${link.icon ? `<span class="rembr-sidebar-link-icon">${link.icon}</span>` : ''}
        <span class="rembr-sidebar-link-label">${link.label}</span>
      </a>
    `
    )
    .join('');

  return `
    <aside class="rembr-sidebar ${collapsibleClass} ${collapsedClass} ${className}">
      <nav class="rembr-sidebar-nav">
        ${linksHtml}
      </nav>
    </aside>
  `.trim();
}

/**
 * Breadcrumb options
 */
export interface BreadcrumbItem {
  label: string;
  href?: string;
}

export interface BreadcrumbOptions {
  items: BreadcrumbItem[];
  separator?: string;
  className?: string;
}

/**
 * Render a breadcrumb navigation component
 */
export function renderBreadcrumb(options: BreadcrumbOptions): string {
  const {
    items,
    separator = '/',
    className = '',
  } = options;

  const itemsHtml = items
    .map((item, index) => {
      const isLast = index === items.length - 1;
      const itemContent = item.href && !isLast
        ? `<a href="${item.href}" class="rembr-breadcrumb-link">${item.label}</a>`
        : `<span class="rembr-breadcrumb-current">${item.label}</span>`;

      const separatorHtml = !isLast
        ? `<span class="rembr-breadcrumb-separator">${separator}</span>`
        : '';

      return `
        <li class="rembr-breadcrumb-item">
          ${itemContent}
          ${separatorHtml}
        </li>
      `;
    })
    .join('');

  return `
    <nav class="rembr-breadcrumb ${className}" aria-label="Breadcrumb">
      <ol class="rembr-breadcrumb-list">
        ${itemsHtml}
      </ol>
    </nav>
  `.trim();
}

/**
 * CSS styles for navigation components
 */
export const NAVIGATION_STYLES = `
<style>
  /* Header */
  .rembr-header {
    background: linear-gradient(135deg, var(--rembr-primary) 0%, var(--rembr-secondary) 100%);
    border-bottom: 1px solid var(--rembr-border);
    position: sticky;
    top: 0;
    z-index: 1000;
  }

  .rembr-header-container {
    max-width: 1400px;
    margin: 0 auto;
    padding: 1rem 2rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 2rem;
  }

  .rembr-header-logo {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    text-decoration: none;
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--rembr-text);
  }

  .rembr-header-logo-image {
    height: 32px;
    width: auto;
  }

  .rembr-header-nav {
    display: flex;
    gap: 1.5rem;
    flex: 1;
  }

  .rembr-header-link {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--rembr-text);
    text-decoration: none;
    font-size: 0.875rem;
    font-weight: 500;
    padding: 0.5rem 0.75rem;
    border-radius: 6px;
    transition: all 0.2s ease;
    opacity: 0.9;
  }

  .rembr-header-link:hover {
    opacity: 1;
    background: rgba(255, 255, 255, 0.1);
  }

  .rembr-header-link-active {
    opacity: 1;
    background: rgba(255, 255, 255, 0.2);
  }

  .rembr-header-actions {
    display: flex;
    gap: 0.75rem;
  }

  /* Footer */
  .rembr-footer {
    background: var(--rembr-bg-secondary);
    border-top: 1px solid var(--rembr-border);
    padding: 3rem 2rem 1.5rem;
    margin-top: auto;
  }

  .rembr-footer-container {
    max-width: 1400px;
    margin: 0 auto;
  }

  .rembr-footer-sections {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 2rem;
    margin-bottom: 2rem;
  }

  .rembr-footer-section-title {
    font-size: 0.875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--rembr-text);
    margin-bottom: 1rem;
  }

  .rembr-footer-links {
    list-style: none;
    padding: 0;
    margin: 0;
  }

  .rembr-footer-links li {
    margin-bottom: 0.5rem;
  }

  .rembr-footer-link {
    color: var(--rembr-text-secondary);
    text-decoration: none;
    font-size: 0.875rem;
    transition: color 0.2s ease;
  }

  .rembr-footer-link:hover {
    color: var(--rembr-primary);
  }

  .rembr-footer-bottom {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding-top: 2rem;
    border-top: 1px solid var(--rembr-border);
    flex-wrap: wrap;
    gap: 1rem;
  }

  .rembr-footer-copyright {
    font-size: 0.75rem;
    color: var(--rembr-text-secondary);
    margin: 0;
  }

  .rembr-footer-social {
    display: flex;
    gap: 1rem;
  }

  .rembr-footer-social-link {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: var(--rembr-bg);
    color: var(--rembr-text-secondary);
    text-decoration: none;
    transition: all 0.2s ease;
  }

  .rembr-footer-social-link:hover {
    background: var(--rembr-primary);
    color: var(--rembr-text);
  }

  /* Sidebar */
  .rembr-sidebar {
    width: 250px;
    background: var(--rembr-bg-secondary);
    border-right: 1px solid var(--rembr-border);
    padding: 1.5rem 0;
    height: 100vh;
    position: sticky;
    top: 0;
    overflow-y: auto;
    transition: width 0.2s ease;
  }

  .rembr-sidebar-collapsible.rembr-sidebar-collapsed {
    width: 70px;
  }

  .rembr-sidebar-collapsible.rembr-sidebar-collapsed .rembr-sidebar-link-label {
    display: none;
  }

  .rembr-sidebar-nav {
    display: flex;
    flex-direction: column;
  }

  .rembr-sidebar-link {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 1.5rem;
    color: var(--rembr-text-secondary);
    text-decoration: none;
    font-size: 0.875rem;
    font-weight: 500;
    transition: all 0.2s ease;
  }

  .rembr-sidebar-link:hover {
    background: rgba(99, 102, 241, 0.1);
    color: var(--rembr-text);
  }

  .rembr-sidebar-link-active {
    background: rgba(99, 102, 241, 0.15);
    color: var(--rembr-primary);
    border-right: 3px solid var(--rembr-primary);
  }

  .rembr-sidebar-link-icon {
    font-size: 1.25rem;
    width: 1.5rem;
    text-align: center;
  }

  /* Breadcrumb */
  .rembr-breadcrumb {
    margin-bottom: 1.5rem;
  }

  .rembr-breadcrumb-list {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    list-style: none;
    padding: 0;
    margin: 0;
  }

  .rembr-breadcrumb-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .rembr-breadcrumb-link {
    color: var(--rembr-text-secondary);
    text-decoration: none;
    font-size: 0.875rem;
    transition: color 0.2s ease;
  }

  .rembr-breadcrumb-link:hover {
    color: var(--rembr-primary);
  }

  .rembr-breadcrumb-current {
    color: var(--rembr-text);
    font-size: 0.875rem;
    font-weight: 500;
  }

  .rembr-breadcrumb-separator {
    color: var(--rembr-text-secondary);
    font-size: 0.75rem;
    opacity: 0.5;
  }

  @media (max-width: 768px) {
    .rembr-header-nav {
      display: none;
    }

    .rembr-sidebar {
      width: 100%;
      height: auto;
      position: relative;
    }

    .rembr-footer-sections {
      grid-template-columns: 1fr;
    }
  }
</style>
`;
