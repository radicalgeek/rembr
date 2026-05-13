/**
 * Button Components
 * Reusable button templates for Rembr UI
 */

export interface ButtonOptions {
  label: string;
  variant?: 'primary' | 'secondary' | 'success' | 'warning' | 'error' | 'link';
  size?: 'small' | 'medium' | 'large';
  onClick?: string;
  disabled?: boolean;
  icon?: string;
  fullWidth?: boolean;
  type?: 'button' | 'submit' | 'reset';
  className?: string;
}

/**
 * Render a button component
 */
export function renderButton(options: ButtonOptions): string {
  const {
    label,
    variant = 'primary',
    size = 'medium',
    onClick,
    disabled = false,
    icon,
    fullWidth = false,
    type = 'button',
    className = '',
  } = options;

  const variantClass = `rembr-button-${variant}`;
  const sizeClass = size !== 'medium' ? `rembr-button-${size}` : '';
  const fullWidthClass = fullWidth ? 'rembr-button-full-width' : '';
  const classes = ['rembr-button', variantClass, sizeClass, fullWidthClass, className]
    .filter(Boolean)
    .join(' ');

  const onClickAttr = onClick ? `onclick="${onClick}"` : '';
  const disabledAttr = disabled ? 'disabled' : '';

  const iconHtml = icon ? `<span class="rembr-button-icon">${icon}</span>` : '';

  return `
    <button 
      type="${type}" 
      class="${classes}" 
      ${onClickAttr} 
      ${disabledAttr}
    >
      ${iconHtml}
      <span class="rembr-button-label">${label}</span>
    </button>
  `.trim();
}

/**
 * Render an icon button (icon only, no label)
 */
export function renderIconButton(options: Omit<ButtonOptions, 'label'> & { icon: string; ariaLabel: string }): string {
  const {
    icon,
    ariaLabel,
    variant = 'secondary',
    size = 'medium',
    onClick,
    disabled = false,
    className = '',
  } = options;

  const variantClass = `rembr-button-${variant}`;
  const sizeClass = size !== 'medium' ? `rembr-button-${size}` : '';
  const classes = ['rembr-button', 'rembr-icon-button', variantClass, sizeClass, className]
    .filter(Boolean)
    .join(' ');

  const onClickAttr = onClick ? `onclick="${onClick}"` : '';
  const disabledAttr = disabled ? 'disabled' : '';

  return `
    <button 
      type="button" 
      class="${classes}" 
      aria-label="${ariaLabel}"
      ${onClickAttr} 
      ${disabledAttr}
    >
      ${icon}
    </button>
  `.trim();
}

/**
 * Render a button group (multiple buttons side-by-side)
 */
export interface ButtonGroupOptions {
  buttons: ButtonOptions[];
  align?: 'left' | 'center' | 'right';
  gap?: 'small' | 'medium' | 'large';
}

export function renderButtonGroup(options: ButtonGroupOptions): string {
  const { buttons, align = 'left', gap = 'medium' } = options;

  const alignClass = `rembr-button-group-${align}`;
  const gapClass = `rembr-button-group-gap-${gap}`;

  const buttonsHtml = buttons.map(button => renderButton(button)).join('\n');

  return `
    <div class="rembr-button-group ${alignClass} ${gapClass}">
      ${buttonsHtml}
    </div>
  `.trim();
}

/**
 * CSS styles for button components
 * These styles should be included in the base template or component stylesheet
 */
export const BUTTON_STYLES = `
<style>
  .rembr-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 0.625rem 1rem;
    font-size: 0.875rem;
    font-weight: 500;
    border-radius: 6px;
    border: 1px solid transparent;
    cursor: pointer;
    transition: all 0.2s ease;
    text-decoration: none;
    white-space: nowrap;
  }

  .rembr-button:hover:not(:disabled) {
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  }

  .rembr-button:active:not(:disabled) {
    transform: translateY(0);
  }

  .rembr-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Variants */
  .rembr-button-primary {
    background: var(--rembr-primary);
    color: var(--rembr-text);
    border-color: var(--rembr-primary);
  }

  .rembr-button-primary:hover:not(:disabled) {
    background: var(--rembr-primary-dark);
  }

  .rembr-button-secondary {
    background: var(--rembr-bg-secondary);
    color: var(--rembr-text);
    border-color: var(--rembr-border);
  }

  .rembr-button-secondary:hover:not(:disabled) {
    border-color: var(--rembr-primary);
  }

  .rembr-button-success {
    background: var(--rembr-success);
    color: var(--rembr-text);
    border-color: var(--rembr-success);
  }

  .rembr-button-warning {
    background: var(--rembr-warning);
    color: var(--rembr-bg);
    border-color: var(--rembr-warning);
  }

  .rembr-button-error {
    background: var(--rembr-error);
    color: var(--rembr-text);
    border-color: var(--rembr-error);
  }

  .rembr-button-link {
    background: transparent;
    color: var(--rembr-primary);
    border-color: transparent;
    padding: 0.25rem 0.5rem;
  }

  .rembr-button-link:hover:not(:disabled) {
    color: var(--rembr-primary-dark);
    text-decoration: underline;
    transform: none;
    box-shadow: none;
  }

  /* Sizes */
  .rembr-button-small {
    padding: 0.375rem 0.75rem;
    font-size: 0.75rem;
  }

  .rembr-button-large {
    padding: 0.875rem 1.5rem;
    font-size: 1rem;
  }

  /* Icon button */
  .rembr-icon-button {
    padding: 0.5rem;
    aspect-ratio: 1;
  }

  .rembr-icon-button .rembr-button-icon {
    margin: 0;
  }

  /* Full width */
  .rembr-button-full-width {
    width: 100%;
  }

  /* Button group */
  .rembr-button-group {
    display: flex;
    flex-wrap: wrap;
  }

  .rembr-button-group-left {
    justify-content: flex-start;
  }

  .rembr-button-group-center {
    justify-content: center;
  }

  .rembr-button-group-right {
    justify-content: flex-end;
  }

  .rembr-button-group-gap-small {
    gap: 0.5rem;
  }

  .rembr-button-group-gap-medium {
    gap: 0.75rem;
  }

  .rembr-button-group-gap-large {
    gap: 1rem;
  }
</style>
`;
