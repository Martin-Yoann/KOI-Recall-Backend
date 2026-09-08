/**
 * Renders `{{placeholder}}` tokens in a stored email template. Values are
 * HTML-escaped once here so the same rendered string serves both the HTML and
 * text parts; rendering happens at send time (outbox worker) so the stored
 * template can be corrected without re-queueing communications.
 *
 * Fail-closed: a template that still contains an unresolved placeholder after
 * substitution throws instead of sending half-filled content to a consumer.
 */
export class EmailRenderError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'EmailRenderError';
  }
}

export class EmailRenderer {
  static render(template: string, variables: Record<string, string>): string {
    let result = template;
    for (const [key, value] of Object.entries(variables)) {
      const sanitizedValue = String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      // A function replacement keeps `$`-sequences in the value (e.g. `$&`)
      // from being interpreted as replacement patterns.
      result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), () => sanitizedValue);
    }

    if (/\{\{[^}]+\}\}/.test(result)) {
      throw new EmailRenderError('Unresolved template variables remain after rendering.');
    }

    return result;
  }
}
