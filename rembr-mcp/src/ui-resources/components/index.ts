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

// Parameterised HTML renderers are intentionally not re-exported from the
// runtime barrel. Their historical APIs accept trusted HTML/attributes and are
// retained only for internal compatibility tests until replaced with typed,
// escaped primitives. Exporting them would make a future MCP renderer an XSS
// footgun. Static style aggregation remains available below.

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
