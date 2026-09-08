import { EmailRenderer } from '../platform/email/renderer.js';

async function testPipeline() {
  console.log('--- Start: email engine safety/compliance test ---');

  const template = 'Hello {{NAME}}, your case {{ID}} is processed.';
  const vars = { NAME: 'John', ID: 'C-123' };
  const rendered = EmailRenderer.render(template, vars);
  console.log('Test 1 (normal render):', rendered);

  try {
    EmailRenderer.render('Hello {{NAME}}, your case {{ID}}.', { NAME: 'John' });
    console.error('Test 2 (missing placeholder): FAILED - did not block');
  } catch (e) {
    console.log('Test 2 (missing placeholder): Pass - blocked');
  }

  try {
    EmailRenderer.render('Your status is approved.', {});
    console.error('Test 3 (state wording): FAILED - did not block');
  } catch (e) {
    console.log('Test 3 (state wording): Pass - blocked');
  }

  console.log('--- End of test ---');
}

testPipeline().catch(console.error);
