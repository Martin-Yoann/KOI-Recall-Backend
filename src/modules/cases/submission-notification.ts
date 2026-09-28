/**
 * The variables the claim-confirmation email renders with.
 *
 * Extracted from `submit` for two reasons: the wording is consumer-facing and was only
 * reachable through a real submission, and the constraint that shapes it is easy to undo by
 * accident. The renderer substitutes flat `{{key}}` placeholders, HTML-escapes every value,
 * and refuses to send when a placeholder is unresolved — it has no conditionals, so the
 * template cannot ask whether a disposal step exists. A sentence therefore has to be
 * composed here, whole, for each branch.
 */
export interface ClaimConfirmationInput {
  caseReference: string;
  submittedAt: Date;
  campaignSlug: string;
  consumerWebBaseUrl: string;
  /** The disposal task created for this submission, when the campaign carries an approved one. */
  disposal: { taskId: string; token: string } | null | undefined;
}

/**
 * A type alias rather than an interface on purpose: an alias carries an implicit index
 * signature, so the result still satisfies the email queue's `Record<string, string>` while
 * callers and tests reach the fields by name instead of through an index.
 */
export type ClaimConfirmationVariables = {
  caseReference: string;
  submittedAt: string;
  /** Empty when no disposal step applies. */
  disposalResumeUrl: string;
  /** The whole sentence for either branch; see the note above. */
  disposalSection: string;
};

export function claimConfirmationVariables(
  input: ClaimConfirmationInput,
): ClaimConfirmationVariables {
  const disposalResumeUrl = input.disposal
    ? `${input.consumerWebBaseUrl}/recalls/${input.campaignSlug}/disposal/${input.disposal.taskId}#token=${input.disposal.token}`
    : '';

  return {
    caseReference: input.caseReference,
    submittedAt: input.submittedAt.toISOString(),
    // The URL on its own, for a template that can put it in an href.
    disposalResumeUrl,
    // The same thing as a self-contained sentence, because the renderer has no
    // conditionals and HTML-escapes every value: a link cannot be built from a variable,
    // so the template drops this in as its own paragraph and both branches read correctly
    // without an empty href ever being emitted.
    disposalSection: input.disposal
      ? `You can return to your product-disposal step at ${disposalResumeUrl}. Keep this email: the link is the only way back to it.`
      : 'No product-disposal step applies to this claim.',
  };
}
