import { CampaignValidationError } from '../../shared/errors.js';

interface PublicationContent {
  title: string;
  summary: string;
  hazard: string;
  immediateAction: string;
  remedySummary: string;
  supportEmail: string;
  supportPhone: string;
  supportHours: string;
}

/** Presence is a technical publish requirement; approval is checked separately. */
export function validatePublicationContent(content: PublicationContent): void {
  for (const field of Object.keys(content) as (keyof PublicationContent)[]) {
    const value = content[field];
    if (!value.trim() || /\[[^\]]+\]|\b(?:TBD|TODO|26-DRAFT|December DAY)\b/i.test(value)) {
      throw new CampaignValidationError(
        `Publication field ${field} is empty or contains draft placeholders.`,
      );
    }
  }
  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(content.supportEmail) ||
    /@(?:example\.(?:com|org|net)|test\.com)$|\.invalid$/i.test(content.supportEmail)
  ) {
    throw new CampaignValidationError(
      'Publication requires a recall support email, not an example address.',
    );
  }
  const digits = content.supportPhone.replace(/\D/g, '');
  if (
    digits.length < 10 ||
    /555[-\s]*SAFE/i.test(content.supportPhone) ||
    /55501\d{2}$/.test(digits) ||
    /^(?:1)?555\d{7}$/.test(digits)
  ) {
    throw new CampaignValidationError(
      'Publication requires a recall support phone, not a placeholder number.',
    );
  }
}
