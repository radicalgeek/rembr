/**
 * Card Components
 * Reusable card templates for Rembr UI
 */

export interface CardOptions {
  title?: string;
  subtitle?: string;
  content: string;
  footer?: string;
  variant?: 'default' | 'bordered' | 'elevated' | 'flat';
  className?: string;
}

/**
 * Render a basic card component
 */
export function renderCard(options: CardOptions): string {
  const {
    title,
    subtitle,
    content,
    footer,
    variant = 'default',
    className = '',
  } = options;

  const variantClass = `rembr-card-${variant}`;

  const titleHtml = title
    ? `<div class="rembr-card-title">${title}</div>`
    : '';

  const subtitleHtml = subtitle
    ? `<div class="rembr-card-subtitle">${subtitle}</div>`
    : '';

  const footerHtml = footer
    ? `<div class="rembr-card-footer">${footer}</div>`
    : '';

  return `
    <div class="rembr-card ${variantClass} ${className}">
      ${titleHtml}
      ${subtitleHtml}
      <div class="rembr-card-content">
        ${content}
      </div>
      ${footerHtml}
    </div>
  `.trim();
}

/**
 * Profile card options
 */
export interface ProfileCardOptions {
  name: string;
  avatar?: string;
  title?: string;
  description?: string;
  stats?: Array<{ label: string; value: string | number }>;
  actions?: string; // HTML for action buttons
  className?: string;
}

/**
 * Render a profile card
 */
export function renderProfileCard(options: ProfileCardOptions): string {
  const {
    name,
    avatar,
    title,
    description,
    stats,
    actions,
    className = '',
  } = options;

  const avatarHtml = avatar
    ? `<img src="${avatar}" alt="${name}" class="rembr-profile-avatar" />`
    : `<div class="rembr-profile-avatar rembr-profile-avatar-placeholder">
         ${name.charAt(0).toUpperCase()}
       </div>`;

  const titleHtml = title
    ? `<div class="rembr-profile-title">${title}</div>`
    : '';

  const descriptionHtml = description
    ? `<p class="rembr-profile-description">${description}</p>`
    : '';

  const statsHtml = stats && stats.length > 0
    ? `
      <div class="rembr-profile-stats">
        ${stats
          .map(
            stat => `
          <div class="rembr-profile-stat">
            <div class="rembr-profile-stat-value">${stat.value}</div>
            <div class="rembr-profile-stat-label">${stat.label}</div>
          </div>
        `
          )
          .join('')}
      </div>
    `
    : '';

  const actionsHtml = actions
    ? `<div class="rembr-profile-actions">${actions}</div>`
    : '';

  return `
    <div class="rembr-card rembr-profile-card ${className}">
      <div class="rembr-profile-header">
        ${avatarHtml}
        <div class="rembr-profile-info">
          <div class="rembr-profile-name">${name}</div>
          ${titleHtml}
        </div>
      </div>
      ${descriptionHtml}
      ${statsHtml}
      ${actionsHtml}
    </div>
  `.trim();
}

/**
 * Feature card options
 */
export interface FeatureCardOptions {
  icon?: string;
  title: string;
  description: string;
  link?: { text: string; href: string };
  variant?: 'horizontal' | 'vertical';
  className?: string;
}

/**
 * Render a feature card
 */
export function renderFeatureCard(options: FeatureCardOptions): string {
  const {
    icon,
    title,
    description,
    link,
    variant = 'vertical',
    className = '',
  } = options;

  const iconHtml = icon
    ? `<div class="rembr-feature-icon">${icon}</div>`
    : '';

  const linkHtml = link
    ? `<a href="${link.href}" class="rembr-feature-link">${link.text} →</a>`
    : '';

  const layoutClass = `rembr-feature-card-${variant}`;

  return `
    <div class="rembr-card rembr-feature-card ${layoutClass} ${className}">
      ${iconHtml}
      <div class="rembr-feature-content">
        <h3 class="rembr-feature-title">${title}</h3>
        <p class="rembr-feature-description">${description}</p>
        ${linkHtml}
      </div>
    </div>
  `.trim();
}

/**
 * Stats card options
 */
export interface StatsCardOptions {
  label: string;
  value: string | number;
  change?: { value: string; positive?: boolean };
  icon?: string;
  className?: string;
}

/**
 * Render a stats card
 */
export function renderStatsCard(options: StatsCardOptions): string {
  const {
    label,
    value,
    change,
    icon,
    className = '',
  } = options;

  const iconHtml = icon
    ? `<div class="rembr-stats-icon">${icon}</div>`
    : '';

  const changeHtml = change
    ? `
      <div class="rembr-stats-change ${change.positive !== false ? 'rembr-stats-change-positive' : 'rembr-stats-change-negative'}">
        ${change.positive !== false ? '↑' : '↓'} ${change.value}
      </div>
    `
    : '';

  return `
    <div class="rembr-card rembr-stats-card ${className}">
      <div class="rembr-stats-header">
        <div class="rembr-stats-label">${label}</div>
        ${iconHtml}
      </div>
      <div class="rembr-stats-value">${value}</div>
      ${changeHtml}
    </div>
  `.trim();
}

/**
 * Card grid options
 */
export interface CardGridOptions {
  cards: string[]; // Array of rendered card HTML
  columns?: 1 | 2 | 3 | 4;
  gap?: 'small' | 'medium' | 'large';
  className?: string;
}

/**
 * Render a grid of cards
 */
export function renderCardGrid(options: CardGridOptions): string {
  const {
    cards,
    columns = 3,
    gap = 'medium',
    className = '',
  } = options;

  const columnsClass = `rembr-card-grid-cols-${columns}`;
  const gapClass = `rembr-card-grid-gap-${gap}`;

  return `
    <div class="rembr-card-grid ${columnsClass} ${gapClass} ${className}">
      ${cards.join('\n')}
    </div>
  `.trim();
}

/**
 * CSS styles for card components
 */
export const CARD_STYLES = `
<style>
  .rembr-card {
    background: var(--rembr-bg-secondary);
    border: 1px solid var(--rembr-border);
    border-radius: 12px;
    padding: 1.5rem;
    margin-bottom: 1.5rem;
  }

  .rembr-card-title {
    font-size: 1.125rem;
    font-weight: 600;
    margin-bottom: 0.5rem;
    color: var(--rembr-text);
  }

  .rembr-card-subtitle {
    font-size: 0.875rem;
    color: var(--rembr-text-secondary);
    margin-bottom: 1rem;
  }

  .rembr-card-content {
    color: var(--rembr-text);
    line-height: 1.6;
  }

  .rembr-card-footer {
    margin-top: 1rem;
    padding-top: 1rem;
    border-top: 1px solid var(--rembr-border);
    display: flex;
    gap: 0.75rem;
    align-items: center;
  }

  /* Card variants */
  .rembr-card-bordered {
    border-width: 2px;
  }

  .rembr-card-elevated {
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
  }

  .rembr-card-elevated:hover {
    box-shadow: 0 10px 15px rgba(0, 0, 0, 0.15);
    transform: translateY(-2px);
    transition: all 0.2s ease;
  }

  .rembr-card-flat {
    border: none;
    background: transparent;
  }

  /* Profile card */
  .rembr-profile-card {
    text-align: center;
  }

  .rembr-profile-header {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin-bottom: 1rem;
    text-align: left;
  }

  .rembr-profile-avatar {
    width: 64px;
    height: 64px;
    border-radius: 50%;
    object-fit: cover;
  }

  .rembr-profile-avatar-placeholder {
    background: var(--rembr-primary);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1.5rem;
    font-weight: 600;
    color: var(--rembr-text);
  }

  .rembr-profile-name {
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--rembr-text);
  }

  .rembr-profile-title {
    font-size: 0.875rem;
    color: var(--rembr-text-secondary);
  }

  .rembr-profile-description {
    font-size: 0.875rem;
    color: var(--rembr-text-secondary);
    margin-bottom: 1rem;
    text-align: left;
  }

  .rembr-profile-stats {
    display: flex;
    gap: 1.5rem;
    justify-content: center;
    padding: 1rem 0;
    border-top: 1px solid var(--rembr-border);
    border-bottom: 1px solid var(--rembr-border);
    margin-bottom: 1rem;
  }

  .rembr-profile-stat {
    text-align: center;
  }

  .rembr-profile-stat-value {
    font-size: 1.5rem;
    font-weight: 600;
    color: var(--rembr-text);
  }

  .rembr-profile-stat-label {
    font-size: 0.75rem;
    color: var(--rembr-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .rembr-profile-actions {
    display: flex;
    gap: 0.75rem;
    justify-content: center;
  }

  /* Feature card */
  .rembr-feature-card {
    transition: all 0.2s ease;
  }

  .rembr-feature-card:hover {
    border-color: var(--rembr-primary);
  }

  .rembr-feature-card-vertical {
    text-align: center;
  }

  .rembr-feature-card-horizontal {
    display: flex;
    gap: 1rem;
    align-items: flex-start;
  }

  .rembr-feature-icon {
    font-size: 2rem;
    margin-bottom: 1rem;
    color: var(--rembr-primary);
  }

  .rembr-feature-card-horizontal .rembr-feature-icon {
    margin-bottom: 0;
  }

  .rembr-feature-title {
    font-size: 1.125rem;
    font-weight: 600;
    margin-bottom: 0.5rem;
    color: var(--rembr-text);
  }

  .rembr-feature-description {
    font-size: 0.875rem;
    color: var(--rembr-text-secondary);
    line-height: 1.6;
    margin-bottom: 0.75rem;
  }

  .rembr-feature-link {
    display: inline-block;
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--rembr-primary);
    text-decoration: none;
    transition: color 0.2s ease;
  }

  .rembr-feature-link:hover {
    color: var(--rembr-primary-dark);
  }

  /* Stats card */
  .rembr-stats-card {
    padding: 1.25rem;
  }

  .rembr-stats-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.75rem;
  }

  .rembr-stats-label {
    font-size: 0.875rem;
    color: var(--rembr-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .rembr-stats-icon {
    font-size: 1.5rem;
    color: var(--rembr-primary);
  }

  .rembr-stats-value {
    font-size: 2rem;
    font-weight: 600;
    color: var(--rembr-text);
    margin-bottom: 0.5rem;
  }

  .rembr-stats-change {
    font-size: 0.875rem;
    font-weight: 500;
  }

  .rembr-stats-change-positive {
    color: var(--rembr-success);
  }

  .rembr-stats-change-negative {
    color: var(--rembr-error);
  }

  /* Card grid */
  .rembr-card-grid {
    display: grid;
    margin-bottom: 1.5rem;
  }

  .rembr-card-grid-cols-1 {
    grid-template-columns: 1fr;
  }

  .rembr-card-grid-cols-2 {
    grid-template-columns: repeat(2, 1fr);
  }

  .rembr-card-grid-cols-3 {
    grid-template-columns: repeat(3, 1fr);
  }

  .rembr-card-grid-cols-4 {
    grid-template-columns: repeat(4, 1fr);
  }

  .rembr-card-grid-gap-small {
    gap: 0.75rem;
  }

  .rembr-card-grid-gap-medium {
    gap: 1.5rem;
  }

  .rembr-card-grid-gap-large {
    gap: 2rem;
  }

  @media (max-width: 1024px) {
    .rembr-card-grid-cols-4 {
      grid-template-columns: repeat(2, 1fr);
    }
    .rembr-card-grid-cols-3 {
      grid-template-columns: repeat(2, 1fr);
    }
  }

  @media (max-width: 640px) {
    .rembr-card-grid-cols-2,
    .rembr-card-grid-cols-3,
    .rembr-card-grid-cols-4 {
      grid-template-columns: 1fr;
    }
  }
</style>
`;
