import type { TransactionalEmail } from '../../platform/email/port.js';

/** Security links use a fragment so access logs and referrers cannot capture the secret. */
export function consumerVerificationEmail(input: { id: string; email: string; token: string; baseUrl: string; locale: string }): TransactionalEmail {
  const url = new URL('/verify-email', input.baseUrl);
  if (input.locale === 'es-US') url.searchParams.set('lang', 'es');
  url.hash = `token=${input.token}`;
  const link = url.toString();
  const spanish = input.locale === 'es-US';
  const heading = spanish ? 'Confirme su correo para consultar sus solicitudes' : 'Confirm your email to view your claims';
  const instructions = spanish
    ? 'Abra este enlace en el mismo navegador y con la misma sesión en que solicitó la verificación. Caduca en 20 minutos y solo se puede utilizar una vez.'
    : 'Open this link in the same browser and login session where you requested verification. It expires in 20 minutes and can only be used once.';
  const ignore = spanish
    ? 'Si no solicitó esta verificación, ignore este mensaje. No comparta el enlace.'
    : 'If you did not request this verification, ignore this message. Do not share the link.';
  const escapedLink = link.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  return { messageKey: `consumer.email.verify:${input.id}`, to: input.email, subject: heading,
    text: `${heading}\n\n${instructions}\n\n${link}\n\n${ignore}`,
    html: `<h1>${heading}</h1><p>${instructions}</p><p><a href="${escapedLink}">${spanish ? 'Confirmar correo' : 'Confirm email'}</a></p><p>${ignore}</p>`,
  };
}
