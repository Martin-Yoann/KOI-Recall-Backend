export interface SafeLogFields {
  requestId?: string;
  campaignId?: string;
  caseId?: string;
  method?: string;
  path?: string;
  status?: number;
  elapsedMs?: number;
  errorCode?: string;
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
