/**
 * Rembr UI Component Library
 * 
 * A collection of reusable, parameterizable UI components for Rembr.
 * All components are TypeScript functions that return HTML strings,
 * consistent with the existing Rembr design system.
 * 
 * @module ui-resources/components
 */

// Import style constants for aggregation functions
import { BUTTON_STYLES } from './buttons.js';
import { INPUT_STYLES } from './inputs.js';
import { FORM_STYLES } from './forms.js';
import { CARD_STYLES } from './cards.js';
import { NAVIGATION_STYLES } from './navigation.js';
import { LAYOUT_STYLES } from './layouts.js';

// Button components
export {
  renderButton,
  renderIconButton,
  renderButtonGroup,
  BUTTON_STYLES,
  type ButtonOptions,
  type ButtonGroupOptions,
} from './buttons.js';

// Input components
export {
  renderInput,
  renderTextarea,
  renderSelect,
  renderCheckbox,
  INPUT_STYLES,
  type InputOptions,
  type TextareaOptions,
  type SelectOptions,
  type SelectOption,
  type CheckboxOptions,
} from './inputs.js';

// Form components
export {
  renderForm,
  renderLoginForm,
  renderSignupForm,
  renderContactForm,
  FORM_STYLES,
  type FormOptions,
  type FormField,
  type LoginFormOptions,
  type SignupFormOptions,
  type ContactFormOptions,
} from './forms.js';

// Card components
export {
  renderCard,
  renderProfileCard,
  renderFeatureCard,
  renderStatsCard,
  renderCardGrid,
  CARD_STYLES,
  type CardOptions,
  type ProfileCardOptions,
  type FeatureCardOptions,
  type StatsCardOptions,
  type CardGridOptions,
} from './cards.js';

// Navigation components
export {
  renderHeader,
  renderFooter,
  renderSidebar,
  renderBreadcrumb,
  NAVIGATION_STYLES,
  type HeaderOptions,
  type NavLink,
  type FooterOptions,
  type FooterSection,
  type SidebarOptions,
  type BreadcrumbOptions,
  type BreadcrumbItem,
} from './navigation.js';

// Layout components
export {
  renderDashboardLayout,
  renderLandingPageLayout,
  renderCenteredLayout,
  renderTwoColumnLayout,
  LAYOUT_STYLES,
  type DashboardLayoutOptions,
  type LandingPageLayoutOptions,
  type CenteredLayoutOptions,
  type TwoColumnLayoutOptions,
} from './layouts.js';

/**
 * Collect all component styles into a single string
 * Useful for including all styles in a single <style> tag
 */
export function getAllComponentStyles(): string {
  return [
    BUTTON_STYLES,
    INPUT_STYLES,
    FORM_STYLES,
    CARD_STYLES,
    NAVIGATION_STYLES,
    LAYOUT_STYLES,
  ].join('\n');
}

/**
 * Helper function to combine multiple component styles
 */
export function combineStyles(...styles: string[]): string {
  return styles.join('\n');
}
