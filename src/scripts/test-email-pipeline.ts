import { EmailRenderer } from '../platform/email/renderer.js';

/**
 * Smoke script mirroring the EmailRenderer unit tests (see
 * tests/email-trigger.test.ts) — handy for a quick manual check.
 */
function testPipeline() {
  console.log('--- Start: email engine render-safety test ---');

  const template = 'Hello {{NAME}}, your case {{ID}} is processed.';
  const vars = { NAME: 'John', ID: 'C-123' };
  const rendered = EmailRenderer.render(template, vars);
  console.log('Test 1 (normal render):', rendered);

  try {
    EmailRenderer.render('Hello {{NAME}}, your case {{ID}}.', { NAME: 'John' });
    console.error('Test 2 (missing placeholder): FAILED - did not block');
  } catch {
    console.log('Test 2 (missing placeholder): Pass - blocked');
  }

  const escaped = EmailRenderer.render('Hi {{NAME}}', { NAME: '<b>Ann</b> & Co' });
  const escapedOk = escaped === 'Hi &lt;b&gt;Ann&lt;/b&gt; &amp; Co';
  console.log(
    escapedOk ? 'Test 3 (html escaping): Pass' : `Test 3 (html escaping): FAILED - ${escaped}`,
  );

  console.log('--- End of test ---');
  if (!escapedOk) process.exitCode = 1;
}

try {
  testPipeline();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
