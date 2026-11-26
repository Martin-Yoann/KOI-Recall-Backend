import { createHash } from 'node:crypto';
import { z } from '@hono/zod-openapi';
import type { CampaignView } from '../../contracts/toc.js';
import { CampaignValidationError } from '../../shared/errors.js';

const copy = z.string().max(20000);
export const translationContentSchema = z.object({
  title: z.string().max(240), summary: copy, hazard: copy, immediateAction: copy,
  remedySummary: copy, supportHours: z.string().max(200),
  products: z.array(z.object({ productId: z.string().uuid(), name: z.string().max(240), description: copy }).strict()).max(200),
  remedies: z.array(z.object({ code: z.string().max(80), displayName: z.string().max(240), description: copy }).strict()).max(30),
  evidence: z.array(z.object({ category: z.string().max(80), instructions: copy }).strict()).max(30),
  faq: z.array(z.object({ topic: z.string().max(160), question: z.string().max(1000), answer: copy }).strict()).max(100),
}).strict();
export type TranslationContent = z.infer<typeof translationContentSchema>;
export type TranslationStatus = 'draft' | 'submitted' | 'approved' | 'changes_requested' | 'published' | 'superseded';

export function sourceContent(view: CampaignView): TranslationContent {
  return {
    title: view.title, summary: view.summary, hazard: view.hazard, immediateAction: view.immediateAction,
    remedySummary: view.remedySummary, supportHours: view.support.hours,
    products: view.products.map((p) => ({ productId: p.productId, name: p.name, description: p.description ?? '' })),
    remedies: view.remedies.map((r) => ({ code: r.code, displayName: r.displayName, description: r.description ?? '' })),
    evidence: view.evidenceRequirements.map((e) => ({ category: e.category, instructions: e.instructions })),
    faq: view.faq ?? [],
  };
}

export function contentHash(content: TranslationContent): string {
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

export function emptyTranslation(source: TranslationContent): TranslationContent {
  return { title: '', summary: '', hazard: '', immediateAction: '', remedySummary: '', supportHours: '',
    products: source.products.map((p) => ({ productId: p.productId, name: '', description: '' })),
    remedies: source.remedies.map((r) => ({ code: r.code, displayName: '', description: '' })),
    evidence: source.evidence.map((e) => ({ category: e.category, instructions: '' })),
    faq: source.faq.map(() => ({ topic: '', question: '', answer: '' })),
  };
}

/** The editor can change text, never identifiers, scope, limits or eligibility rules. */
export function assertTranslationShape(source: TranslationContent, target: TranslationContent): void {
  for (const [original, translated] of [
    [source.products.map((p) => p.productId), target.products.map((p) => p.productId)],
    [source.remedies.map((r) => r.code), target.remedies.map((r) => r.code)],
    [source.evidence.map((e) => e.category), target.evidence.map((e) => e.category)],
  ]) {
    if (JSON.stringify([...original!].sort()) !== JSON.stringify([...translated!].sort())) {
      throw new CampaignValidationError('Translation identifiers must match the source exactly. Reload the source before editing.');
    }
  }
  if (source.faq.length !== target.faq.length) throw new CampaignValidationError('The translated FAQ must contain the same number of items as the source.');
}

export function missingTranslationFields(source: TranslationContent, target: TranslationContent): string[] {
  const missing: string[] = [];
  const check = (key: string, original: string, translated: string) => {
    if (original.trim() && (!translated.trim() || /\[[^\]]+\]|\b(?:TBD|TODO)\b/i.test(translated))) missing.push(key);
  };
  for (const key of ['title', 'summary', 'hazard', 'immediateAction', 'remedySummary', 'supportHours'] as const) check(key, source[key], target[key]);
  source.products.forEach((s) => { const t = target.products.find((p) => p.productId === s.productId); check(`product:${s.productId}:name`, s.name, t?.name ?? ''); check(`product:${s.productId}:description`, s.description, t?.description ?? ''); });
  source.remedies.forEach((s) => { const t = target.remedies.find((r) => r.code === s.code); check(`remedy:${s.code}:name`, s.displayName, t?.displayName ?? ''); check(`remedy:${s.code}:description`, s.description, t?.description ?? ''); });
  source.evidence.forEach((s) => check(`evidence:${s.category}`, s.instructions, target.evidence.find((e) => e.category === s.category)?.instructions ?? ''));
  source.faq.forEach((s, i) => { for (const key of ['topic', 'question', 'answer'] as const) check(`faq:${i}:${key}`, s[key], target.faq[i]?.[key] ?? ''); });
  return missing;
}

export function applyTranslation(view: CampaignView, target: TranslationContent, metadata: { id: string; revision: number; sourceVersion: number }): CampaignView {
  assertTranslationShape(sourceContent(view), target);
  return { ...view, locale: 'es-US', translation: metadata,
    title: target.title, summary: target.summary, hazard: target.hazard, immediateAction: target.immediateAction, remedySummary: target.remedySummary,
    support: { ...view.support, hours: target.supportHours },
    products: view.products.map((p) => { const t = target.products.find((t) => t.productId === p.productId)!; return { ...p, name: t.name, description: t.description }; }),
    remedies: view.remedies.map((r) => { const t = target.remedies.find((t) => t.code === r.code)!; return { ...r, displayName: t.displayName, description: t.description }; }),
    evidenceRequirements: view.evidenceRequirements.map((r) => ({ ...r, instructions: target.evidence.find((t) => t.category === r.category)!.instructions })),
    faq: target.faq,
  };
}
