export interface SecretPromptInput {
  readonly isTTY?: boolean;
  setRawMode?(enabled: boolean): void;
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  off(event: 'data', listener: (chunk: Buffer) => void): unknown;
  resume(): void;
  pause(): void;
}

export interface SecretPromptOutput {
  write(chunk: string): unknown;
}

/** Reads one line without echoing its contents when attached to a TTY. */
export function promptSecret(
  question: string,
  streams: { input: SecretPromptInput; output: SecretPromptOutput } = {
    input: process.stdin,
    output: process.stdout,
  },
): Promise<string> {
  const { input, output } = streams;
  output.write(question);
  input.setRawMode?.(true);
  input.resume();

  return new Promise((resolve, reject) => {
    let answer = '';
    const finish = (error?: Error) => {
      input.off('data', onData);
      input.setRawMode?.(false);
      input.pause();
      output.write('\n');
      if (error) reject(error);
      else resolve(answer.trim());
    };
    const onData = (chunk: Buffer) => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\r' || character === '\n') {
          finish();
          return;
        }
        if (character === '\u0003') {
          finish(new Error('Password prompt cancelled.'));
          return;
        }
        if (character === '\u007f' || character === '\b') {
          answer = answer.slice(0, -1);
          continue;
        }
        answer += character;
      }
    };
    input.on('data', onData);
  });
}
