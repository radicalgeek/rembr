/**
 * Layout Components
 * Reusable page layout templates for Rembr UI
 */

import { renderHeader, renderFooter, renderSidebar, type HeaderOptions, type FooterOptions, type SidebarOptions } from './navigation.js';

export interface DashboardLayoutOptions {
  sidebar: SidebarOptions;
  header?: HeaderOptions;
  content: string;
  footer?: FooterOptions;
  className?: string;
}

/**
 * Render a dashboard layout (header + sidebar + main content + footer)
 */
export function renderDashboardLayout(options: DashboardLayoutOptions): string {
  const {
    sidebar,
    header,
    content,
    footer,
    className = '',
  } = options;

  const headerHtml = header ? renderHeader(header) : '';
  const sidebarHtml = renderSidebar(sidebar);
  const footerHtml = footer ? renderFooter(footer) : '';

  return `
    <div class="rembr-dashboard-layout ${className}">
      ${headerHtml}
      <div class="rembr-dashboard-body">
        ${sidebarHtml}
        <main class="rembr-dashboard-main">
          ${content}
        </main>
      </div>
      ${footerHtml}
    </div>
  `.trim();
}

/**
 * Landing page layout options
 */
export interface LandingPageLayoutOptions {
  header?: HeaderOptions;
  hero?: {
    title: string;
    subtitle?: string;
    cta?: string; // HTML for CTA buttons
    image?: string;
  };
  sections: Array<{
    id?: string;
    title?: string;
    content: string;
    background?: 'default' | 'secondary' | 'gradient';
  }>;
  footer?: FooterOptions;
  className?: string;
}

/**
 * Render a landing page layout
 */
export function renderLandingPageLayout(options: LandingPageLayoutOptions): string {
  const {
    header,
    hero,
    sections,
    footer,
    className = '',
  } = options;

  const headerHtml = header ? renderHeader(header) : '';

  const heroHtml = hero
    ? `
      <section class="rembr-hero">
        <div class="rembr-hero-container">
          <div class="rembr-hero-content">
            <h1 class="rembr-hero-title">${hero.title}</h1>
            ${hero.subtitle ? `<p class="rembr-hero-subtitle">${hero.subtitle}</p>` : ''}
            ${hero.cta ? `<div class="rembr-hero-cta">${hero.cta}</div>` : ''}
          </div>
          ${hero.image ? `<div class="rembr-hero-image"><img src="${hero.image}" alt="${hero.title}" /></div>` : ''}
        </div>
      </section>
    `
    : '';

  const sectionsHtml = sections
    .map(
      section => `
      <section 
        ${section.id ? `id="${section.id}"` : ''}
        class="rembr-landing-section rembr-landing-section-${section.background || 'default'}"
      >
        <div class="rembr-landing-section-container">
          ${section.title ? `<h2 class="rembr-landing-section-title">${section.title}</h2>` : ''}
          ${section.content}
        </div>
      </section>
    `
    )
    .join('');

  const footerHtml = footer ? renderFooter(footer) : '';

  return `
    <div class="rembr-landing-layout ${className}">
      ${headerHtml}
      ${heroHtml}
      ${sectionsHtml}
      ${footerHtml}
    </div>
  `.trim();
}

/**
 * Centered content layout options
 */
export interface CenteredLayoutOptions {
  header?: HeaderOptions;
  content: string;
  maxWidth?: 'small' | 'medium' | 'large';
  verticalCenter?: boolean;
  className?: string;
}

/**
 * Render a centered content layout (useful for auth pages, forms, etc.)
 */
export function renderCenteredLayout(options: CenteredLayoutOptions): string {
  const {
    header,
    content,
    maxWidth = 'small',
    verticalCenter = true,
    className = '',
  } = options;

  const headerHtml = header ? renderHeader(header) : '';
  const maxWidthClass = `rembr-centered-layout-${maxWidth}`;
  const verticalCenterClass = verticalCenter ? 'rembr-centered-layout-vertical' : '';

  return `
    <div class="rembr-centered-layout ${verticalCenterClass} ${className}">
      ${headerHtml}
      <main class="rembr-centered-main">
        <div class="rembr-centered-content ${maxWidthClass}">
          ${content}
        </div>
      </main>
    </div>
  `.trim();
}

/**
 * Two-column layout options
 */
export interface TwoColumnLayoutOptions {
  header?: HeaderOptions;
  leftColumn: string;
  rightColumn: string;
  leftWidth?: '1/3' | '1/2' | '2/3';
  footer?: FooterOptions;
  className?: string;
}

/**
 * Render a two-column layout
 */
export function renderTwoColumnLayout(options: TwoColumnLayoutOptions): string {
  const {
    header,
    leftColumn,
    rightColumn,
    leftWidth = '1/2',
    footer,
    className = '',
  } = options;

  const headerHtml = header ? renderHeader(header) : '';
  const footerHtml = footer ? renderFooter(footer) : '';
  const widthClass = `rembr-two-column-${leftWidth.replace('/', '-')}`;

  return `
    <div class="rembr-two-column-layout ${className}">
      ${headerHtml}
      <main class="rembr-two-column-main ${widthClass}">
        <div class="rembr-two-column-left">
          ${leftColumn}
        </div>
        <div class="rembr-two-column-right">
          ${rightColumn}
        </div>
      </main>
      ${footerHtml}
    </div>
  `.trim();
}

/**
 * CSS styles for layout components
 */
export const LAYOUT_STYLES = `
<style>
  /* Dashboard layout */
  .rembr-dashboard-layout {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }

  .rembr-dashboard-body {
    display: flex;
    flex: 1;
  }

  .rembr-dashboard-main {
    flex: 1;
    padding: 2rem;
    overflow-y: auto;
  }

  /* Landing page layout */
  .rembr-landing-layout {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }

  .rembr-hero {
    background: linear-gradient(135deg, var(--rembr-primary) 0%, var(--rembr-secondary) 100%);
    padding: 4rem 2rem;
  }

  .rembr-hero-container {
    max-width: 1200px;
    margin: 0 auto;
    display: flex;
    align-items: center;
    gap: 4rem;
  }

  .rembr-hero-content {
    flex: 1;
  }

  .rembr-hero-title {
    font-size: 3rem;
    font-weight: 700;
    line-height: 1.2;
    color: var(--rembr-text);
    margin-bottom: 1rem;
  }

  .rembr-hero-subtitle {
    font-size: 1.25rem;
    color: var(--rembr-text);
    opacity: 0.9;
    margin-bottom: 2rem;
    line-height: 1.6;
  }

  .rembr-hero-cta {
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .rembr-hero-image {
    flex: 1;
    max-width: 500px;
  }

  .rembr-hero-image img {
    width: 100%;
    height: auto;
    border-radius: 12px;
    box-shadow: 0 20px 40px rgba(0, 0, 0, 0.2);
  }

  .rembr-landing-section {
    padding: 4rem 2rem;
  }

  .rembr-landing-section-default {
    background: var(--rembr-bg);
  }

  .rembr-landing-section-secondary {
    background: var(--rembr-bg-secondary);
  }

  .rembr-landing-section-gradient {
    background: linear-gradient(135deg, rgba(99, 102, 241, 0.1) 0%, rgba(139, 92, 246, 0.1) 100%);
  }

  .rembr-landing-section-container {
    max-width: 1200px;
    margin: 0 auto;
  }

  .rembr-landing-section-title {
    font-size: 2.5rem;
    font-weight: 700;
    color: var(--rembr-text);
    margin-bottom: 2rem;
    text-align: center;
  }

  /* Centered layout */
  .rembr-centered-layout {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }

  .rembr-centered-main {
    flex: 1;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 2rem;
  }

  .rembr-centered-layout-vertical .rembr-centered-main {
    align-items: center;
  }

  .rembr-centered-content {
    width: 100%;
  }

  .rembr-centered-layout-small {
    max-width: 400px;
  }

  .rembr-centered-layout-medium {
    max-width: 600px;
  }

  .rembr-centered-layout-large {
    max-width: 900px;
  }

  /* Two-column layout */
  .rembr-two-column-layout {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }

  .rembr-two-column-main {
    flex: 1;
    display: grid;
    gap: 2rem;
    padding: 2rem;
    max-width: 1400px;
    margin: 0 auto;
    width: 100%;
  }

  .rembr-two-column-1-3 {
    grid-template-columns: 1fr 2fr;
  }

  .rembr-two-column-1-2 {
    grid-template-columns: 1fr 1fr;
  }

  .rembr-two-column-2-3 {
    grid-template-columns: 2fr 1fr;
  }

  /* Responsive adjustments */
  @media (max-width: 1024px) {
    .rembr-hero-container {
      flex-direction: column;
      text-align: center;
    }

    .rembr-hero-title {
      font-size: 2.5rem;
    }

    .rembr-hero-cta {
      justify-content: center;
    }

    .rembr-landing-section-title {
      font-size: 2rem;
    }

    .rembr-two-column-main {
      grid-template-columns: 1fr;
    }

    .rembr-dashboard-body {
      flex-direction: column;
    }
  }

  @media (max-width: 640px) {
    .rembr-hero {
      padding: 2rem 1rem;
    }

    .rembr-hero-title {
      font-size: 2rem;
    }

    .rembr-hero-subtitle {
      font-size: 1rem;
    }

    .rembr-landing-section {
      padding: 2rem 1rem;
    }

    .rembr-landing-section-title {
      font-size: 1.5rem;
    }

    .rembr-dashboard-main {
      padding: 1rem;
    }

    .rembr-centered-main {
      padding: 1rem;
    }

    .rembr-two-column-main {
      padding: 1rem;
    }
  }
</style>
`;
