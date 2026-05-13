/**
 * Form Components
 * Reusable form templates for Rembr UI
 */

import { renderInput, renderCheckbox, type InputOptions } from './inputs.js';
import { renderButton, renderButtonGroup, type ButtonOptions } from './buttons.js';

export interface FormOptions {
  action?: string;
  method?: 'GET' | 'POST';
  onSubmit?: string;
  className?: string;
}

export interface FormField {
  type: 'input' | 'checkbox' | 'custom';
  options?: InputOptions | any;
  html?: string; // for custom fields
}

/**
 * Render a generic form with fields
 */
export function renderForm(
  fields: FormField[],
  submitButton: ButtonOptions,
  options: FormOptions = {}
): string {
  const {
    action = '',
    method = 'POST',
    onSubmit = '',
    className = '',
  } = options;

  const actionAttr = action ? `action="${action}"` : '';
  const onSubmitAttr = onSubmit ? `onsubmit="${onSubmit}"` : '';

  const fieldsHtml = fields
    .map(field => {
      if (field.type === 'input' && field.options) {
        return renderInput(field.options as InputOptions);
      } else if (field.type === 'checkbox' && field.options) {
        return renderCheckbox(field.options);
      } else if (field.type === 'custom' && field.html) {
        return field.html;
      }
      return '';
    })
    .join('\n');

  const submitBtn = renderButton({ ...submitButton, type: 'submit' });

  return `
    <form 
      method="${method}" 
      ${actionAttr} 
      ${onSubmitAttr}
      class="rembr-form ${className}"
    >
      ${fieldsHtml}
      <div class="rembr-form-actions">
        ${submitBtn}
      </div>
    </form>
  `.trim();
}

/**
 * Render a login form
 */
export interface LoginFormOptions {
  action?: string;
  onSubmit?: string;
  showRememberMe?: boolean;
  showForgotPassword?: boolean;
  emailLabel?: string;
  passwordLabel?: string;
  submitLabel?: string;
}

export function renderLoginForm(options: LoginFormOptions = {}): string {
  const {
    action,
    onSubmit,
    showRememberMe = true,
    showForgotPassword = true,
    emailLabel = 'Email',
    passwordLabel = 'Password',
    submitLabel = 'Sign In',
  } = options;

  const fields: FormField[] = [
    {
      type: 'input',
      options: {
        name: 'email',
        type: 'email',
        label: emailLabel,
        placeholder: 'Enter your email',
        required: true,
        autoComplete: 'email',
      },
    },
    {
      type: 'input',
      options: {
        name: 'password',
        type: 'password',
        label: passwordLabel,
        placeholder: 'Enter your password',
        required: true,
        autoComplete: 'current-password',
      },
    },
  ];

  if (showRememberMe) {
    fields.push({
      type: 'checkbox',
      options: {
        name: 'remember',
        label: 'Remember me',
      },
    });
  }

  if (showForgotPassword) {
    fields.push({
      type: 'custom',
      html: `
        <div style="text-align: right; margin-bottom: 1rem;">
          <a href="/forgot-password" class="rembr-link" style="font-size: 0.875rem;">
            Forgot password?
          </a>
        </div>
      `,
    });
  }

  return renderForm(
    fields,
    { label: submitLabel, variant: 'primary', fullWidth: true },
    { action, method: 'POST', onSubmit }
  );
}

/**
 * Render a signup form
 */
export interface SignupFormOptions {
  action?: string;
  onSubmit?: string;
  showNameField?: boolean;
  showTermsCheckbox?: boolean;
  nameLabel?: string;
  emailLabel?: string;
  passwordLabel?: string;
  submitLabel?: string;
  termsText?: string;
}

export function renderSignupForm(options: SignupFormOptions = {}): string {
  const {
    action,
    onSubmit,
    showNameField = true,
    showTermsCheckbox = true,
    nameLabel = 'Name',
    emailLabel = 'Email',
    passwordLabel = 'Password',
    submitLabel = 'Create Account',
    termsText = 'I agree to the Terms of Service and Privacy Policy',
  } = options;

  const fields: FormField[] = [];

  if (showNameField) {
    fields.push({
      type: 'input',
      options: {
        name: 'name',
        type: 'text',
        label: nameLabel,
        placeholder: 'Enter your name',
        required: true,
        autoComplete: 'name',
      },
    });
  }

  fields.push(
    {
      type: 'input',
      options: {
        name: 'email',
        type: 'email',
        label: emailLabel,
        placeholder: 'Enter your email',
        required: true,
        autoComplete: 'email',
      },
    },
    {
      type: 'input',
      options: {
        name: 'password',
        type: 'password',
        label: passwordLabel,
        placeholder: 'Create a password',
        required: true,
        autoComplete: 'new-password',
        helpText: 'Must be at least 8 characters',
      },
    }
  );

  if (showTermsCheckbox) {
    fields.push({
      type: 'checkbox',
      options: {
        name: 'terms',
        label: termsText,
      },
    });
  }

  return renderForm(
    fields,
    { label: submitLabel, variant: 'primary', fullWidth: true },
    { action, method: 'POST', onSubmit }
  );
}

/**
 * Render a contact form
 */
export interface ContactFormOptions {
  action?: string;
  onSubmit?: string;
  showPhoneField?: boolean;
  showSubjectField?: boolean;
  nameLabel?: string;
  emailLabel?: string;
  phoneLabel?: string;
  subjectLabel?: string;
  messageLabel?: string;
  submitLabel?: string;
}

export function renderContactForm(options: ContactFormOptions = {}): string {
  const {
    action,
    onSubmit,
    showPhoneField = false,
    showSubjectField = true,
    nameLabel = 'Name',
    emailLabel = 'Email',
    phoneLabel = 'Phone',
    subjectLabel = 'Subject',
    messageLabel = 'Message',
    submitLabel = 'Send Message',
  } = options;

  const fields: FormField[] = [
    {
      type: 'input',
      options: {
        name: 'name',
        type: 'text',
        label: nameLabel,
        placeholder: 'Your name',
        required: true,
        autoComplete: 'name',
      },
    },
    {
      type: 'input',
      options: {
        name: 'email',
        type: 'email',
        label: emailLabel,
        placeholder: 'your.email@example.com',
        required: true,
        autoComplete: 'email',
      },
    },
  ];

  if (showPhoneField) {
    fields.push({
      type: 'input',
      options: {
        name: 'phone',
        type: 'tel',
        label: phoneLabel,
        placeholder: 'Your phone number',
        autoComplete: 'tel',
      },
    });
  }

  if (showSubjectField) {
    fields.push({
      type: 'input',
      options: {
        name: 'subject',
        type: 'text',
        label: subjectLabel,
        placeholder: 'What is this about?',
        required: true,
      },
    });
  }

  fields.push({
    type: 'custom',
    html: `
      <div class="rembr-input-group">
        <label for="message" class="rembr-label">
          ${messageLabel}<span class="rembr-required">*</span>
        </label>
        <textarea
          id="message"
          name="message"
          class="rembr-textarea"
          placeholder="Your message"
          rows="6"
          required
        ></textarea>
      </div>
    `,
  });

  return renderForm(
    fields,
    { label: submitLabel, variant: 'primary', fullWidth: true },
    { action, method: 'POST', onSubmit }
  );
}

/**
 * CSS styles for form components
 */
export const FORM_STYLES = `
<style>
  .rembr-form {
    width: 100%;
  }

  .rembr-form-actions {
    margin-top: 1.5rem;
    display: flex;
    gap: 0.75rem;
    justify-content: flex-end;
  }

  .rembr-link {
    color: var(--rembr-primary);
    text-decoration: none;
    transition: color 0.2s ease;
  }

  .rembr-link:hover {
    color: var(--rembr-primary-dark);
    text-decoration: underline;
  }
</style>
`;
