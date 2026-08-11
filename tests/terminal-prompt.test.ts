import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

class FakeTtyInput extends EventEmitter {
  readonly isTTY = true;
  readonly rawModeChanges: boolean[] = [];

  setRawMode(enabled: boolean) {
    this.rawModeChanges.push(enabled);
  }

  resume() {}
  pause() {}
}

class FakeOutput {
  value = '';

  write(chunk: string) {
    this.value += chunk;
  }
}

describe('staff terminal prompt', () => {
  it('reads a secret from a TTY without echoing it', async () => {
    const modulePath = '../src/modules/staff/terminal-prompt.js';
    const promptModule = (await import(modulePath).catch(() => null)) as null | {
      promptSecret: (
        question: string,
        streams: { input: FakeTtyInput; output: FakeOutput },
      ) => Promise<string>;
    };
    expect(promptModule).not.toBeNull();
    if (!promptModule) return;
    const input = new FakeTtyInput();
    const output = new FakeOutput();

    const answerPromise = promptModule.promptSecret('Password: ', { input, output });
    input.emit('data', Buffer.from('s3cret-password\n'));
    const answer = await answerPromise;

    expect(answer).toBe('s3cret-password');
    expect(output.value).toBe('Password: \n');
    expect(input.rawModeChanges).toEqual([true, false]);
  });
});
