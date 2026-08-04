export interface ProductCheckInput {
  campaignSlug: string;
  shape: string;
  flavor: string;
  lotCode: string;
  dateCode: string;
}

export interface ProductCheckService {
  check(input: ProductCheckInput): Promise<unknown>;
}
