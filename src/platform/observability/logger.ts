export interface SafeLogFields {
  requestId?: string;
  campaignId?: string;
  caseId?: string;
  method?: string;
  path?: string;
  status?: number;
  /** Total wall time of the operation being reported. */
  elapsedMs?: number;
  /** Submission phase timings; see the claim-submission log line. */
  prepareMs?: number;
  transactionMs?: number;
  /** The public case reference; the id the consumer sees, not a database id. */
  caseReference?: string | undefined;
  /** True when the work was served from an earlier result rather than done again. */
  replayed?: boolean;
  errorCode?: string;
  errorMessage?: string;
  stack?: string | undefined;
}

export interface SafeLogger {
  info(message: string, fields?: SafeLogFields): void;
  error(message: string, fields?: SafeLogFields): void;
}

export const consoleSafeLogger: SafeLogger = {
  info(message, fields = {}) {
    console.info(JSON.stringify({ level: 'info', message, ...fields }));
  },
  error(message, fields = {}) {
    console.error(JSON.stringify({ level: 'error', message, ...fields }));
  },
};
