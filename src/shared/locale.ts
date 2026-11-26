export const supportedLocales = ['en-US', 'es-US'] as const;
export type SupportedLocale = (typeof supportedLocales)[number];
export const reservedLocales = [] as const;
export const defaultLocale = 'en-US' as const;
