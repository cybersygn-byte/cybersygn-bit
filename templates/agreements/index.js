/**
 * Template registry.
 *
 * Every shippable template imports here. The generator script and the
 * site UI both read from this file as the canonical list. Adding a new
 * template means: write the module, import it here, add it to the
 * registry array, and run `npm run build:templates`.
 */

import ndaMutual from './nda-mutual.js';
import independentContractor from './independent-contractor.js';
import servicesAgreement from './services-agreement.js';

export const TEMPLATES = [
  ndaMutual,
  independentContractor,
  servicesAgreement,
];

export function getTemplate(id) {
  return TEMPLATES.find(t => t.id === id) || null;
}

export function listTemplates({ includePreview = true } = {}) {
  return TEMPLATES.filter(t => includePreview || t.reviewedBy != null);
}
