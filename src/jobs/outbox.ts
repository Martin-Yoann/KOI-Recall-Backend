export interface OutboxJobResult {
  claimed: number;
  succeeded: number;
  failed: number;
}

export interface OutboxWorker {
  runBatch(limit: number): Promise<OutboxJobResult>;
}
