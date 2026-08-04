import { createMiddleware } from 'hono/factory';

export interface AppEnv {
  Variables: {
    requestId: string;
  };
}

export const requestContext = createMiddleware<AppEnv>(async (context, next) => {
  const incoming = context.req.header('X-Request-Id');
  const requestId =
    incoming && /^[A-Za-z0-9._:-]{1,128}$/.test(incoming) ? incoming : crypto.randomUUID();
  context.set('requestId', requestId);
  context.header('X-Request-Id', requestId);
  await next();
});
