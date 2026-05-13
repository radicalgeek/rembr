/**
 * Component Library Tests
 * Basic usage examples and integration tests
 */

import { renderButton, renderButtonGroup } from './buttons.js';
import { renderInput, renderSelect, renderCheckbox } from './inputs.js';
import { renderLoginForm, renderSignupForm } from './forms.js';
import { renderCard, renderProfileCard, renderFeatureCard, renderStatsCard, renderCardGrid } from './cards.js';
import { renderHeader, renderFooter, renderSidebar } from './navigation.js';
import { renderDashboardLayout, renderLandingPageLayout, renderCenteredLayout } from './layouts.js';
import { getAllComponentStyles } from './index.js';

describe('Component Library', () => {
  describe('Buttons', () => {
    it('should render a primary button', () => {
      const html = renderButton({
        label: 'Submit',
        variant: 'primary',
      });
      expect(html).toContain('rembr-button');
      expect(html).toContain('rembr-button-primary');
      expect(html).toContain('Submit');
    });

    it('should render a button group', () => {
      const html = renderButtonGroup({
        buttons: [
          { label: 'Cancel', variant: 'secondary' },
          { label: 'Save', variant: 'primary' },
        ],
      });
      expect(html).toContain('rembr-button-group');
      expect(html).toContain('Cancel');
      expect(html).toContain('Save');
    });
  });

  describe('Inputs', () => {
    it('should render an email input', () => {
      const html = renderInput({
        name: 'email',
        type: 'email',
        label: 'Email',
        placeholder: 'Enter email',
        required: true,
      });
      expect(html).toContain('type="email"');
      expect(html).toContain('name="email"');
      expect(html).toContain('Email');
      expect(html).toContain('required');
    });

    it('should render a select dropdown', () => {
      const html = renderSelect({
        name: 'country',
        label: 'Country',
        options: [
          { value: 'us', label: 'United States' },
          { value: 'uk', label: 'United Kingdom' },
        ],
      });
      expect(html).toContain('select');
      expect(html).toContain('United States');
      expect(html).toContain('United Kingdom');
    });
  });

  describe('Forms', () => {
    it('should render a login form', () => {
      const html = renderLoginForm({
        showRememberMe: true,
        showForgotPassword: true,
      });
      expect(html).toContain('type="email"');
      expect(html).toContain('type="password"');
      expect(html).toContain('Remember me');
      expect(html).toContain('Forgot password');
    });

    it('should render a signup form', () => {
      const html = renderSignupForm({
        showNameField: true,
        showTermsCheckbox: true,
      });
      expect(html).toContain('name="name"');
      expect(html).toContain('name="email"');
      expect(html).toContain('name="password"');
      expect(html).toContain('Terms of Service');
    });
  });

  describe('Cards', () => {
    it('should render a basic card', () => {
      const html = renderCard({
        title: 'Test Card',
        content: '<p>Card content</p>',
      });
      expect(html).toContain('rembr-card');
      expect(html).toContain('Test Card');
      expect(html).toContain('Card content');
    });

    it('should render a profile card', () => {
      const html = renderProfileCard({
        name: 'Jane Doe',
        title: 'Developer',
        stats: [
          { label: 'Projects', value: '12' },
          { label: 'Stars', value: '234' },
        ],
      });
      expect(html).toContain('Jane Doe');
      expect(html).toContain('Developer');
      expect(html).toContain('12');
      expect(html).toContain('234');
    });

    it('should render a card grid', () => {
      const card1 = renderCard({ title: 'Card 1', content: 'Content 1' });
      const card2 = renderCard({ title: 'Card 2', content: 'Content 2' });
      const html = renderCardGrid({
        cards: [card1, card2],
        columns: 2,
      });
      expect(html).toContain('rembr-card-grid');
      expect(html).toContain('Card 1');
      expect(html).toContain('Card 2');
    });
  });

  describe('Navigation', () => {
    it('should render a header', () => {
      const html = renderHeader({
        logo: { text: 'Rembr', href: '/' },
        links: [
          { label: 'Home', href: '/', active: true },
          { label: 'About', href: '/about' },
        ],
      });
      expect(html).toContain('rembr-header');
      expect(html).toContain('Rembr');
      expect(html).toContain('Home');
      expect(html).toContain('About');
    });

    it('should render a footer', () => {
      const html = renderFooter({
        sections: [
          {
            title: 'Company',
            links: [
              { label: 'About', href: '/about' },
              { label: 'Contact', href: '/contact' },
            ],
          },
        ],
        copyright: '© 2026 Rembr',
      });
      expect(html).toContain('rembr-footer');
      expect(html).toContain('Company');
      expect(html).toContain('About');
      expect(html).toContain('© 2026 Rembr');
    });

    it('should render a sidebar', () => {
      const html = renderSidebar({
        links: [
          { label: 'Dashboard', href: '/dashboard', icon: '📊', active: true },
          { label: 'Settings', href: '/settings', icon: '⚙️' },
        ],
      });
      expect(html).toContain('rembr-sidebar');
      expect(html).toContain('Dashboard');
      expect(html).toContain('Settings');
      expect(html).toContain('rembr-sidebar-link-active');
    });
  });

  describe('Layouts', () => {
    it('should render a dashboard layout', () => {
      const html = renderDashboardLayout({
        sidebar: {
          links: [{ label: 'Home', href: '/', active: true }],
        },
        content: '<h1>Dashboard Content</h1>',
      });
      expect(html).toContain('rembr-dashboard-layout');
      expect(html).toContain('rembr-sidebar');
      expect(html).toContain('Dashboard Content');
    });

    it('should render a landing page layout', () => {
      const html = renderLandingPageLayout({
        hero: {
          title: 'Welcome',
          subtitle: 'Get started',
        },
        sections: [
          { title: 'Features', content: '<p>Feature list</p>' },
        ],
      });
      expect(html).toContain('rembr-landing-layout');
      expect(html).toContain('Welcome');
      expect(html).toContain('Features');
    });

    it('should render a centered layout', () => {
      const html = renderCenteredLayout({
        content: '<div>Centered content</div>',
        maxWidth: 'small',
      });
      expect(html).toContain('rembr-centered-layout');
      expect(html).toContain('Centered content');
      expect(html).toContain('rembr-centered-layout-small');
    });
  });

  describe('Style Aggregation', () => {
    it('should combine all component styles', () => {
      const styles = getAllComponentStyles();
      expect(styles).toContain('.rembr-button');
      expect(styles).toContain('.rembr-input');
      expect(styles).toContain('.rembr-card');
      expect(styles).toContain('.rembr-header');
      expect(styles).toContain('.rembr-dashboard-layout');
    });
  });
});
