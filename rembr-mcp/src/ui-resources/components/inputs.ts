/**
 * Input Components
 * Reusable input field templates for Rembr UI
 */

export interface InputOptions {
  name: string;
  label?: string;
  type?: 'text' | 'email' | 'password' | 'search' | 'tel' | 'url' | 'number';
  placeholder?: string;
  value?: string;
  required?: boolean;
  disabled?: boolean;
  error?: string;
  helpText?: string;
  icon?: string;
  autoComplete?: string;
  className?: string;
}

/**
 * Render an input field component
 */
export function renderInput(options: InputOptions): string {
  const {
    name,
    label,
    type = 'text',
    placeholder,
    value = '',
    required = false,
    disabled = false,
    error,
    helpText,
    icon,
    autoComplete,
    className = '',
  } = options;

  const hasError = Boolean(error);
  const inputClass = hasError ? 'rembr-input rembr-input-error' : 'rembr-input';
  const wrapperClass = icon ? 'rembr-input-wrapper rembr-input-with-icon' : 'rembr-input-wrapper';

  const labelHtml = label
    ? `<label for="${name}" class="rembr-label">
         ${label}${required ? '<span class="rembr-required">*</span>' : ''}
       </label>`
    : '';

  const iconHtml = icon ? `<span class="rembr-input-icon">${icon}</span>` : '';

  const errorHtml = error
    ? `<span class="rembr-input-error-message">${error}</span>`
    : '';

  const helpTextHtml = helpText && !error
    ? `<span class="rembr-input-help-text">${helpText}</span>`
    : '';

  const requiredAttr = required ? 'required' : '';
  const disabledAttr = disabled ? 'disabled' : '';
  const autoCompleteAttr = autoComplete ? `autocomplete="${autoComplete}"` : '';

  return `
    <div class="rembr-input-group ${className}">
      ${labelHtml}
      <div class="${wrapperClass}">
        ${iconHtml}
        <input
          type="${type}"
          id="${name}"
          name="${name}"
          class="${inputClass}"
          placeholder="${placeholder || ''}"
          value="${value}"
          ${requiredAttr}
          ${disabledAttr}
          ${autoCompleteAttr}
        />
      </div>
      ${errorHtml}
      ${helpTextHtml}
    </div>
  `.trim();
}

/**
 * Textarea component options
 */
export interface TextareaOptions {
  name: string;
  label?: string;
  placeholder?: string;
  value?: string;
  rows?: number;
  required?: boolean;
  disabled?: boolean;
  error?: string;
  helpText?: string;
  maxLength?: number;
  className?: string;
}

/**
 * Render a textarea component
 */
export function renderTextarea(options: TextareaOptions): string {
  const {
    name,
    label,
    placeholder,
    value = '',
    rows = 4,
    required = false,
    disabled = false,
    error,
    helpText,
    maxLength,
    className = '',
  } = options;

  const hasError = Boolean(error);
  const textareaClass = hasError ? 'rembr-textarea rembr-input-error' : 'rembr-textarea';

  const labelHtml = label
    ? `<label for="${name}" class="rembr-label">
         ${label}${required ? '<span class="rembr-required">*</span>' : ''}
       </label>`
    : '';

  const errorHtml = error
    ? `<span class="rembr-input-error-message">${error}</span>`
    : '';

  const helpTextHtml = helpText && !error
    ? `<span class="rembr-input-help-text">${helpText}</span>`
    : '';

  const requiredAttr = required ? 'required' : '';
  const disabledAttr = disabled ? 'disabled' : '';
  const maxLengthAttr = maxLength ? `maxlength="${maxLength}"` : '';

  return `
    <div class="rembr-input-group ${className}">
      ${labelHtml}
      <textarea
        id="${name}"
        name="${name}"
        class="${textareaClass}"
        placeholder="${placeholder || ''}"
        rows="${rows}"
        ${requiredAttr}
        ${disabledAttr}
        ${maxLengthAttr}
      >${value}</textarea>
      ${errorHtml}
      ${helpTextHtml}
    </div>
  `.trim();
}

/**
 * Select dropdown component options
 */
export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectOptions {
  name: string;
  label?: string;
  options: SelectOption[];
  value?: string;
  required?: boolean;
  disabled?: boolean;
  error?: string;
  helpText?: string;
  placeholder?: string;
  className?: string;
}

/**
 * Render a select dropdown component
 */
export function renderSelect(options: SelectOptions): string {
  const {
    name,
    label,
    options: selectOptions,
    value = '',
    required = false,
    disabled = false,
    error,
    helpText,
    placeholder,
    className = '',
  } = options;

  const hasError = Boolean(error);
  const selectClass = hasError ? 'rembr-select rembr-input-error' : 'rembr-select';

  const labelHtml = label
    ? `<label for="${name}" class="rembr-label">
         ${label}${required ? '<span class="rembr-required">*</span>' : ''}
       </label>`
    : '';

  const placeholderOption = placeholder
    ? `<option value="" disabled ${!value ? 'selected' : ''}>${placeholder}</option>`
    : '';

  const optionsHtml = selectOptions
    .map(
      opt => `
        <option 
          value="${opt.value}" 
          ${opt.value === value ? 'selected' : ''}
          ${opt.disabled ? 'disabled' : ''}
        >
          ${opt.label}
        </option>
      `
    )
    .join('');

  const errorHtml = error
    ? `<span class="rembr-input-error-message">${error}</span>`
    : '';

  const helpTextHtml = helpText && !error
    ? `<span class="rembr-input-help-text">${helpText}</span>`
    : '';

  const requiredAttr = required ? 'required' : '';
  const disabledAttr = disabled ? 'disabled' : '';

  return `
    <div class="rembr-input-group ${className}">
      ${labelHtml}
      <select
        id="${name}"
        name="${name}"
        class="${selectClass}"
        ${requiredAttr}
        ${disabledAttr}
      >
        ${placeholderOption}
        ${optionsHtml}
      </select>
      ${errorHtml}
      ${helpTextHtml}
    </div>
  `.trim();
}

/**
 * Checkbox component options
 */
export interface CheckboxOptions {
  name: string;
  label: string;
  checked?: boolean;
  disabled?: boolean;
  value?: string;
  className?: string;
}

/**
 * Render a checkbox component
 */
export function renderCheckbox(options: CheckboxOptions): string {
  const {
    name,
    label,
    checked = false,
    disabled = false,
    value = 'on',
    className = '',
  } = options;

  const checkedAttr = checked ? 'checked' : '';
  const disabledAttr = disabled ? 'disabled' : '';

  return `
    <div class="rembr-checkbox-group ${className}">
      <label class="rembr-checkbox-label">
        <input
          type="checkbox"
          id="${name}"
          name="${name}"
          value="${value}"
          class="rembr-checkbox"
          ${checkedAttr}
          ${disabledAttr}
        />
        <span class="rembr-checkbox-text">${label}</span>
      </label>
    </div>
  `.trim();
}

/**
 * CSS styles for input components
 */
export const INPUT_STYLES = `
<style>
  .rembr-input-group {
    margin-bottom: 1rem;
  }

  .rembr-label {
    display: block;
    font-size: 0.875rem;
    font-weight: 500;
    margin-bottom: 0.5rem;
    color: var(--rembr-text);
  }

  .rembr-required {
    color: var(--rembr-error);
    margin-left: 0.25rem;
  }

  .rembr-input-wrapper {
    position: relative;
  }

  .rembr-input-with-icon {
    display: flex;
    align-items: center;
  }

  .rembr-input-icon {
    position: absolute;
    left: 0.75rem;
    color: var(--rembr-text-secondary);
    pointer-events: none;
  }

  .rembr-input-with-icon .rembr-input {
    padding-left: 2.5rem;
  }

  .rembr-input,
  .rembr-textarea,
  .rembr-select {
    width: 100%;
    padding: 0.625rem 0.75rem;
    font-size: 0.875rem;
    background: var(--rembr-bg-secondary);
    border: 1px solid var(--rembr-border);
    border-radius: 6px;
    color: var(--rembr-text);
    transition: border-color 0.2s ease;
  }

  .rembr-input:focus,
  .rembr-textarea:focus,
  .rembr-select:focus {
    outline: none;
    border-color: var(--rembr-primary);
    box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
  }

  .rembr-input::placeholder,
  .rembr-textarea::placeholder {
    color: var(--rembr-text-secondary);
    opacity: 0.6;
  }

  .rembr-input:disabled,
  .rembr-textarea:disabled,
  .rembr-select:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .rembr-input-error {
    border-color: var(--rembr-error);
  }

  .rembr-input-error:focus {
    box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.1);
  }

  .rembr-input-error-message {
    display: block;
    font-size: 0.75rem;
    color: var(--rembr-error);
    margin-top: 0.25rem;
  }

  .rembr-input-help-text {
    display: block;
    font-size: 0.75rem;
    color: var(--rembr-text-secondary);
    margin-top: 0.25rem;
  }

  .rembr-textarea {
    resize: vertical;
    min-height: 80px;
  }

  .rembr-select {
    cursor: pointer;
    appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%23cbd5e1'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M19 9l-7 7-7-7'%3E%3C/path%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 0.5rem center;
    background-size: 1.5rem;
    padding-right: 2.5rem;
  }

  .rembr-checkbox-group {
    margin-bottom: 1rem;
  }

  .rembr-checkbox-label {
    display: flex;
    align-items: center;
    cursor: pointer;
    user-select: none;
  }

  .rembr-checkbox {
    width: 1rem;
    height: 1rem;
    margin-right: 0.5rem;
    cursor: pointer;
    accent-color: var(--rembr-primary);
  }

  .rembr-checkbox-text {
    font-size: 0.875rem;
    color: var(--rembr-text);
  }

  .rembr-checkbox:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .rembr-checkbox-label:has(.rembr-checkbox:disabled) {
    cursor: not-allowed;
    opacity: 0.5;
  }
</style>
`;
