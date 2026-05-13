/**
 * Test for Demo UI
 */

import { describe, it, expect } from 'vitest';
import { renderDemoUI } from './demo-ui.js';

describe('renderDemoUI', () => {
  it('should render demo UI with default data', () => {
    const html = renderDemoUI();

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Rembr');
    expect(html).toContain('Interactive Demo');
    expect(html).toContain('Memory Operations');
    expect(html).toContain('Try Interactive Action');
  });

  it('should render with custom message', () => {
    const html = renderDemoUI({
      message: 'Custom test message'
    });

    expect(html).toContain('Custom test message');
  });

  it('should render with custom items', () => {
    const html = renderDemoUI({
      items: [
        { id: '1', label: 'Test Item', value: 100, status: 'active' }
      ]
    });

    expect(html).toContain('Test Item');
    expect(html).toContain('100');
    expect(html).toContain('active');
  });

  it('should include interactive JavaScript', () => {
    const html = renderDemoUI();

    expect(html).toContain('handleDemoAction');
    expect(html).toContain('toggleTheme');
    expect(html).toContain('clickCount');
  });

  it('should escape HTML in user content', () => {
    const html = renderDemoUI({
      message: '<script>alert("xss")</script>Test'
    });

    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
