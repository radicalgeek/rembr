/**
 * PII Detection Service
 * 
 * Detects personally identifiable information in text content.
 * Uses pattern-based detection for common PII types.
 * 
 * Phase 0.5 of Master Implementation Plan
 */

export type PIIType = 
  | 'email'
  | 'phone'
  | 'credit_card'
  | 'ssn'
  | 'uk_nino'
  | 'ip_address'
  | 'crypto_wallet'
  | 'date_of_birth';

export interface PIILocation {
  type: PIIType;
  start: number;
  end: number;
  matched: string;
}

export interface PIIDetectionResult {
  hasPII: boolean;
  types: PIIType[];
  locations: PIILocation[];
  confidence: number;
  redactedContent?: string;
}

export type RedactionMode = 'mask' | 'hash' | 'remove';
export type Sensitivity = 'low' | 'medium' | 'high';

// Pattern definitions for different PII types
const PII_PATTERNS: Record<PIIType, RegExp> = {
  // Email addresses
  email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  
  // Phone numbers (international formats)
  phone: /(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}/g,
  
  // Credit card numbers (with Luhn validation in detection)
  credit_card: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
  
  // US Social Security Numbers
  ssn: /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g,
  
  // UK National Insurance Numbers
  uk_nino: /\b[A-Za-z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-Da-d]\b/g,
  
  // IP Addresses (IPv4)
  ip_address: /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g,
  
  // Crypto wallet addresses (BTC and ETH)
  crypto_wallet: /\b(?:0x[a-fA-F0-9]{40}|[13][a-km-zA-HJ-NP-Z1-9]{25,34}|bc1[a-z0-9]{39,59})\b/g,
  
  // Dates of birth (various formats)
  date_of_birth: /\b(?:DOB|D\.O\.B\.?|born|birth(?:day|date)?)[:\s]+\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4}\b/gi,
};

// Sensitivity levels determine which patterns to check
const SENSITIVITY_PATTERNS: Record<Sensitivity, PIIType[]> = {
  low: ['email', 'phone'],
  medium: ['email', 'phone', 'credit_card', 'ssn', 'uk_nino'],
  high: ['email', 'phone', 'credit_card', 'ssn', 'uk_nino', 'ip_address', 'crypto_wallet', 'date_of_birth'],
};

/**
 * Luhn algorithm for credit card validation
 */
function isValidCreditCard(number: string): boolean {
  const digits = number.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  
  let sum = 0;
  let isEven = false;
  
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = parseInt(digits[i], 10);
    if (isEven) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    isEven = !isEven;
  }
  
  return sum % 10 === 0;
}

/**
 * Validate SSN format (not a valid SSN pattern)
 */
function isValidSSN(ssn: string): boolean {
  const digits = ssn.replace(/\D/g, '');
  if (digits.length !== 9) return false;
  
  // Reject known invalid SSNs
  const area = parseInt(digits.substring(0, 3), 10);
  if (area === 0 || area === 666 || area >= 900) return false;
  
  const group = parseInt(digits.substring(3, 5), 10);
  if (group === 0) return false;
  
  const serial = parseInt(digits.substring(5, 9), 10);
  if (serial === 0) return false;
  
  return true;
}

export class PIIDetectorService {
  /**
   * Detect PII in content
   */
  detectPII(content: string, sensitivity: Sensitivity = 'medium'): PIIDetectionResult {
    const locations: PIILocation[] = [];
    const typesFound = new Set<PIIType>();
    
    const patternsToCheck = SENSITIVITY_PATTERNS[sensitivity];
    
    for (const piiType of patternsToCheck) {
      const pattern = PII_PATTERNS[piiType];
      // Reset regex state
      pattern.lastIndex = 0;
      
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        const matched = match[0];
        
        // Additional validation for specific types
        if (piiType === 'credit_card' && !isValidCreditCard(matched)) {
          continue;
        }
        if (piiType === 'ssn' && !isValidSSN(matched)) {
          continue;
        }
        
        locations.push({
          type: piiType,
          start: match.index,
          end: match.index + matched.length,
          matched,
        });
        typesFound.add(piiType);
      }
    }
    
    // Sort locations by start position
    locations.sort((a, b) => a.start - b.start);
    
    // Calculate confidence based on number and type of matches
    const confidence = this.calculateConfidence(locations, content.length);
    
    return {
      hasPII: locations.length > 0,
      types: Array.from(typesFound),
      locations,
      confidence,
    };
  }
  
  /**
   * Redact PII from content
   */
  redactPII(content: string, mode: RedactionMode = 'mask', sensitivity: Sensitivity = 'medium'): string {
    const result = this.detectPII(content, sensitivity);
    
    if (!result.hasPII) {
      return content;
    }
    
    // Process in reverse order to preserve positions
    const sortedLocations = [...result.locations].sort((a, b) => b.start - a.start);
    let redacted = content;
    
    for (const location of sortedLocations) {
      const replacement = this.getRedactionReplacement(location, mode);
      redacted = redacted.substring(0, location.start) + replacement + redacted.substring(location.end);
    }
    
    return redacted;
  }
  
  /**
   * Detect and return redacted content in one call
   */
  detectAndRedact(content: string, mode: RedactionMode = 'mask', sensitivity: Sensitivity = 'medium'): PIIDetectionResult {
    const result = this.detectPII(content, sensitivity);
    
    if (result.hasPII) {
      result.redactedContent = this.redactPII(content, mode, sensitivity);
    }
    
    return result;
  }
  
  /**
   * Calculate confidence score based on matches
   */
  private calculateConfidence(locations: PIILocation[], contentLength: number): number {
    if (locations.length === 0) return 0;
    
    // Base confidence on number and type of matches
    let score = 0;
    
    // High-confidence PII types
    const highConfidenceTypes: PIIType[] = ['ssn', 'credit_card', 'uk_nino'];
    const mediumConfidenceTypes: PIIType[] = ['email', 'phone', 'crypto_wallet'];
    
    for (const location of locations) {
      if (highConfidenceTypes.includes(location.type)) {
        score += 0.4;
      } else if (mediumConfidenceTypes.includes(location.type)) {
        score += 0.25;
      } else {
        score += 0.1;
      }
    }
    
    // Cap at 1.0
    return Math.min(score, 1.0);
  }
  
  /**
   * Get replacement text for redaction
   */
  private getRedactionReplacement(location: PIILocation, mode: RedactionMode): string {
    switch (mode) {
      case 'mask':
        // Replace with asterisks, keeping first and last char for some types
        const len = location.matched.length;
        if (location.type === 'email') {
          const atIndex = location.matched.indexOf('@');
          if (atIndex > 2) {
            return location.matched[0] + '*'.repeat(atIndex - 2) + location.matched.substring(atIndex - 1);
          }
        }
        return '*'.repeat(len);
        
      case 'hash':
        // Return type-prefixed hash placeholder
        return `[${location.type.toUpperCase()}_REDACTED]`;
        
      case 'remove':
        // Remove entirely
        return '';
        
      default:
        return '*'.repeat(location.matched.length);
    }
  }
}

// Export singleton instance
export const piiDetector = new PIIDetectorService();
