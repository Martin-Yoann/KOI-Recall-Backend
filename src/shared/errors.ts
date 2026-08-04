export class NotImplementedServiceError extends Error {
  constructor(readonly capability: string) {
    super(`${capability} is defined by contract but is not implemented in the Phase 1 skeleton.`);
    this.name = 'NotImplementedServiceError';
  }
}

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  requestId?: string;
  errors?: Array<{ path: string; message: string }>;
}
