

# Rembr UI Component Library

A collection of reusable, parameterizable UI components built for the Rembr platform. All components are TypeScript functions that return HTML strings, making them easy to compose and integrate with Rembr's existing template system.

## Overview

This component library extends the Rembr UI Resources (`rembr-mcp/src/ui-resources`) with a comprehensive set of reusable components for building interactive user interfaces.

**Key Features:**
- 🎨 **Consistent Design** — All components use Rembr's CSS variables and design system
- 📦 **Composable** — Components can be nested and combined
- ⚡ **Parameterizable** — Extensive customization through TypeScript interfaces
- 🔧 **Type-Safe** — Full TypeScript support with detailed type definitions
- 📱 **Responsive** — Mobile-first design with responsive breakpoints

## Components

### Buttons (`buttons.ts`)

Create various button styles with support for variants, sizes, icons, and states.

**Available Functions:**
- `renderButton(options: ButtonOptions)` — Standard button
- `renderIconButton(options)` — Icon-only button
- `renderButtonGroup(options)` — Group of buttons

**Example:**
```typescript
import { renderButton, renderButtonGroup } from './components/buttons.js';

const submitBtn = renderButton({
  label: 'Submit',
  variant: 'primary',
  size: 'large',
  type: 'submit',
  fullWidth: true,
});

const actionGroup = renderButtonGroup({
  buttons: [
    { label: 'Cancel', variant: 'secondary' },
    { label: 'Save', variant: 'primary' },
  ],
  align: 'right',
});
```

**Variants:** `primary`, `secondary`, `success`, `warning`, `error`, `link`  
**Sizes:** `small`, `medium`, `large`

---

### Inputs (`inputs.ts`)

Form input components including text fields, textareas, selects, and checkboxes.

**Available Functions:**
- `renderInput(options: InputOptions)` — Text input with label, validation, icons
- `renderTextarea(options: TextareaOptions)` — Multi-line text input
- `renderSelect(options: SelectOptions)` — Dropdown select
- `renderCheckbox(options: CheckboxOptions)` — Checkbox with label

**Example:**
```typescript
import { renderInput, renderSelect } from './components/inputs.js';

const emailInput = renderInput({
  name: 'email',
  type: 'email',
  label: 'Email Address',
  placeholder: 'you@example.com',
  required: true,
  icon: '📧',
  error: 'Please enter a valid email',
});

const countrySelect = renderSelect({
  name: 'country',
  label: 'Country',
  options: [
    { value: 'us', label: 'United States' },
    { value: 'uk', label: 'United Kingdom' },
    { value: 'ca', label: 'Canada' },
  ],
  placeholder: 'Select a country',
  required: true,
});
```

**Input Types:** `text`, `email`, `password`, `search`, `tel`, `url`, `number`

---

### Forms (`forms.ts`)

Pre-built form templates with validation and submission handling.

**Available Functions:**
- `renderForm(fields, submitButton, options)` — Generic form builder
- `renderLoginForm(options: LoginFormOptions)` — Login form
- `renderSignupForm(options: SignupFormOptions)` — Registration form
- `renderContactForm(options: ContactFormOptions)` — Contact/support form

**Example:**
```typescript
import { renderLoginForm, renderSignupForm } from './components/forms.js';

const loginForm = renderLoginForm({
  action: '/auth/login',
  showRememberMe: true,
  showForgotPassword: true,
  submitLabel: 'Sign In',
});

const signupForm = renderSignupForm({
  action: '/auth/register',
  showNameField: true,
  showTermsCheckbox: true,
  submitLabel: 'Create Account',
});
```

---

### Cards (`cards.ts`)

Card components for displaying content, profiles, features, and statistics.

**Available Functions:**
- `renderCard(options: CardOptions)` — Basic card with title, content, footer
- `renderProfileCard(options: ProfileCardOptions)` — User profile card
- `renderFeatureCard(options: FeatureCardOptions)` — Feature highlight card
- `renderStatsCard(options: StatsCardOptions)` — Statistics display card
- `renderCardGrid(options: CardGridOptions)` — Responsive card grid

**Example:**
```typescript
import { renderCard, renderProfileCard, renderCardGrid } from './components/cards.js';

const basicCard = renderCard({
  title: 'Welcome',
  subtitle: 'Get started with Rembr',
  content: '<p>Your memory assistant is ready.</p>',
  variant: 'elevated',
});

const profileCard = renderProfileCard({
  name: 'Jane Doe',
  avatar: '/avatars/jane.jpg',
  title: 'Product Manager',
  description: 'Building the future of memory systems',
  stats: [
    { label: 'Memories', value: '1,234' },
    { label: 'Projects', value: '12' },
  ],
  actions: '<button class="rembr-button rembr-button-primary">Follow</button>',
});

const cardGrid = renderCardGrid({
  cards: [basicCard, profileCard],
  columns: 2,
  gap: 'large',
});
```

**Card Variants:** `default`, `bordered`, `elevated`, `flat`

---

### Navigation (`navigation.ts`)

Navigation components including headers, footers, sidebars, and breadcrumbs.

**Available Functions:**
- `renderHeader(options: HeaderOptions)` — Top navigation bar
- `renderFooter(options: FooterOptions)` — Footer with links and social
- `renderSidebar(options: SidebarOptions)` — Vertical navigation sidebar
- `renderBreadcrumb(options: BreadcrumbOptions)` — Breadcrumb trail

**Example:**
```typescript
import { renderHeader, renderFooter, renderSidebar } from './components/navigation.js';

const header = renderHeader({
  logo: { text: 'Rembr', href: '/' },
  links: [
    { label: 'Dashboard', href: '/dashboard', active: true },
    { label: 'Memories', href: '/memories' },
    { label: 'Settings', href: '/settings' },
  ],
  actions: '<button class="rembr-button rembr-button-primary">Upgrade</button>',
});

const sidebar = renderSidebar({
  links: [
    { label: 'Overview', href: '/dashboard', icon: '📊', active: true },
    { label: 'Memories', href: '/memories', icon: '💭' },
    { label: 'Search', href: '/search', icon: '🔍' },
  ],
  collapsible: true,
});

const footer = renderFooter({
  sections: [
    {
      title: 'Product',
      links: [
        { label: 'Features', href: '/features' },
        { label: 'Pricing', href: '/pricing' },
      ],
    },
    {
      title: 'Company',
      links: [
        { label: 'About', href: '/about' },
        { label: 'Contact', href: '/contact' },
      ],
    },
  ],
  copyright: '© 2026 Rembr. All rights reserved.',
  socialLinks: [
    { icon: '🐦', href: 'https://twitter.com/rembr', label: 'Twitter' },
    { icon: '💼', href: 'https://linkedin.com/company/rembr', label: 'LinkedIn' },
  ],
});
```

---

### Layouts (`layouts.ts`)

Complete page layout templates combining navigation, content, and footer.

**Available Functions:**
- `renderDashboardLayout(options: DashboardLayoutOptions)` — App dashboard layout
- `renderLandingPageLayout(options: LandingPageLayoutOptions)` — Marketing landing page
- `renderCenteredLayout(options: CenteredLayoutOptions)` — Centered content (auth pages)
- `renderTwoColumnLayout(options: TwoColumnLayoutOptions)` — Side-by-side content

**Example:**
```typescript
import { renderDashboardLayout, renderLandingPageLayout } from './components/layouts.js';

const dashboard = renderDashboardLayout({
  header: {
    logo: { text: 'Rembr', href: '/' },
    actions: '<button class="rembr-button">Logout</button>',
  },
  sidebar: {
    links: [
      { label: 'Dashboard', href: '/dashboard', icon: '📊', active: true },
      { label: 'Memories', href: '/memories', icon: '💭' },
    ],
  },
  content: '<h1>Welcome to your dashboard</h1>',
  footer: {
    copyright: '© 2026 Rembr',
  },
});

const landingPage = renderLandingPageLayout({
  header: {
    logo: { text: 'Rembr', href: '/' },
    links: [
      { label: 'Features', href: '#features' },
      { label: 'Pricing', href: '#pricing' },
    ],
    actions: '<button class="rembr-button rembr-button-primary">Get Started</button>',
  },
  hero: {
    title: 'Your AI Memory Assistant',
    subtitle: 'Never forget anything important again',
    cta: '<button class="rembr-button rembr-button-primary">Start Free Trial</button>',
  },
  sections: [
    {
      id: 'features',
      title: 'Features',
      content: '<p>Feature cards go here...</p>',
    },
  ],
  footer: {
    copyright: '© 2026 Rembr',
  },
});
```

---

## Usage with Existing Template System

The component library integrates seamlessly with Rembr's existing `renderTemplate()` function from `ui-resources/index.ts`:

```typescript
import { renderTemplate } from '../index.js';
import { renderDashboardLayout } from './components/layouts.js';
import { renderCard } from './components/cards.js';
import { getAllComponentStyles } from './components/index.js';

const dashboardContent = renderCard({
  title: 'Analytics',
  content: '<p>Your memory statistics...</p>',
});

const dashboard = renderDashboardLayout({
  content: dashboardContent,
  // ... sidebar, header, footer options
});

const html = renderTemplate({
  title: 'Dashboard',
  subtitle: 'View your memory analytics',
  content: dashboard,
  extraHead: getAllComponentStyles(),
});
```

## Styling

All components include their own CSS styles via `*_STYLES` constants:

- `BUTTON_STYLES` — Button component styles
- `INPUT_STYLES` — Input component styles
- `FORM_STYLES` — Form component styles
- `CARD_STYLES` — Card component styles
- `NAVIGATION_STYLES` — Navigation component styles
- `LAYOUT_STYLES` — Layout component styles

**Include all styles at once:**
```typescript
import { getAllComponentStyles } from './components/index.js';

const allStyles = getAllComponentStyles();
```

**CSS Variables (from `base.html`):**
```css
--rembr-primary: #6366f1;       /* Indigo */
--rembr-secondary: #8b5cf6;     /* Purple */
--rembr-accent: #ec4899;        /* Pink */
--rembr-success: #10b981;       /* Green */
--rembr-warning: #f59e0b;       /* Amber */
--rembr-error: #ef4444;         /* Red */
--rembr-bg: #0f172a;            /* Dark background */
--rembr-bg-secondary: #1e293b;  /* Secondary background */
--rembr-text: #f8fafc;          /* Light text */
--rembr-text-secondary: #cbd5e1;/* Secondary text */
--rembr-border: #334155;        /* Border color */
```

## TypeScript Support

All components have full TypeScript type definitions. Import types for customization:

```typescript
import type { ButtonOptions, CardOptions, HeaderOptions } from './components/index.js';

const buttonConfig: ButtonOptions = {
  label: 'Click Me',
  variant: 'primary',
  size: 'large',
};
```

## Responsive Design

All components are mobile-responsive with breakpoints:

- **Desktop:** > 1024px
- **Tablet:** 640px - 1024px
- **Mobile:** < 640px

Grids automatically stack on smaller screens, and layouts adjust for better mobile UX.

## File Structure

```
components/
├── index.ts           # Main export file
├── buttons.ts         # Button components
├── inputs.ts          # Input components
├── forms.ts           # Form components
├── cards.ts           # Card components
├── navigation.ts      # Navigation components
├── layouts.ts         # Layout components
└── README.md          # This file
```

## Integration Examples

### Example 1: Login Page

```typescript
import { renderTemplate } from '../index.js';
import { renderCenteredLayout } from './components/layouts.js';
import { renderCard } from './components/cards.js';
import { renderLoginForm } from './components/forms.js';
import { getAllComponentStyles } from './components/index.js';

const loginForm = renderLoginForm({
  action: '/auth/login',
  onSubmit: 'handleLogin(event)',
  submitLabel: 'Sign In',
});

const loginCard = renderCard({
  title: 'Welcome Back',
  subtitle: 'Sign in to your account',
  content: loginForm,
});

const layout = renderCenteredLayout({
  header: {
    logo: { text: 'Rembr', href: '/' },
  },
  content: loginCard,
  maxWidth: 'small',
  verticalCenter: true,
});

const html = renderTemplate({
  title: 'Login',
  content: layout,
  extraHead: getAllComponentStyles(),
});
```

### Example 2: Dashboard with Stats

```typescript
import { renderDashboardLayout } from './components/layouts.js';
import { renderStatsCard, renderCardGrid } from './components/cards.js';

const stats = renderCardGrid({
  cards: [
    renderStatsCard({
      label: 'Total Memories',
      value: '1,234',
      change: { value: '+12%', positive: true },
      icon: '💭',
    }),
    renderStatsCard({
      label: 'Projects',
      value: '42',
      change: { value: '+3', positive: true },
      icon: '📁',
    }),
    renderStatsCard({
      label: 'Storage Used',
      value: '2.4 GB',
      change: { value: '+500 MB', positive: false },
      icon: '💾',
    }),
  ],
  columns: 3,
});

const dashboard = renderDashboardLayout({
  content: stats,
  // ... sidebar, header configuration
});
```

---

## Next Steps

1. **Extend Components** — Add more specialized components as needed
2. **Theme Support** — Add light/dark theme variants
3. **Animation** — Add CSS transitions for better UX
4. **Accessibility** — Enhance ARIA labels and keyboard navigation
5. **Documentation** — Add interactive component playground

---

**Last Updated:** 2026-02-25  
**Author:** Iris (Rembr Agent)  
**Status:** ✅ Complete
