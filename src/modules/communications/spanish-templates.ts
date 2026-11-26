/** Transactional UI copy only; never translates an approved notice or an operator's statement. */
export function spanishEmailTemplates() {
  const entries = [
    [
      'claim_confirmation',
      'Hemos recibido su solicitud {{caseReference}}',
      'Hemos recibido su solicitud de retirada.',
      'Fecha de presentación: {{submittedAt}}',
      '{{disposalSection}}',
    ],
    [
      'disposal_update',
      'Actualización del caso {{caseReference}}',
      'Hay una actualización sobre el paso de eliminación de su producto.',
      'Mensaje del equipo (en su idioma original): {{updateSection}}',
      'Para volver a ese paso, utilice el enlace de su correo de confirmación.',
    ],
    [
      'need_info',
      'Necesitamos información para el caso {{caseReference}}',
      'Necesitamos información adicional para continuar.',
      'Instrucciones del equipo (en su idioma original): {{requestedInformation}}',
      'Consulte su caso: {{actionUrl}}',
    ],
    [
      'refund_approved',
      'Reembolso aprobado para {{caseReference}}',
      'Se ha aprobado el reembolso de su solicitud.',
      'Importe aprobado: {{refundAmount}} {{refundCurrency}}',
      'La aprobación no significa que el pago ya se haya enviado. Le informaremos cuando se registre su envío.',
    ],
    [
      'replacement_approved',
      'Reemplazo aprobado para {{caseReference}}',
      'Se ha aprobado el reemplazo de su producto.',
      'Producto: {{replacementItem}}',
      'La aprobación no significa que el reemplazo ya se haya enviado. Le informaremos cuando se registre el envío.',
    ],
    [
      'claim_rejected',
      'Decisión sobre el caso {{caseReference}}',
      'Su solicitud no ha sido aprobada.',
      'Motivo del equipo (en su idioma original): {{reason}}',
      'Si tiene preguntas, utilice los datos de contacto del aviso de retirada e indique la referencia del caso.',
    ],
    [
      'refund_completed',
      'Reembolso enviado para {{caseReference}}',
      'Se ha registrado el envío de su reembolso.',
      'Importe: {{refundAmount}} {{refundCurrency}}',
      'El plazo para recibirlo depende de su banco o proveedor de pago.',
    ],
    [
      'shipment_shipped',
      'Su reemplazo está en camino: {{caseReference}}',
      'Se ha registrado el envío de su reemplazo.',
      'Número de seguimiento: {{trackingNumber}}',
      'Utilice el número de seguimiento con el transportista para consultar la entrega.',
    ],
    [
      'case_completed',
      'El caso {{caseReference}} se ha completado',
      'Se ha completado la medida correctiva y el caso está cerrado.',
      'Medida: {{completedResolutionLabel}}',
      'Gracias por participar en esta retirada.',
    ],
    [
      'case_closed',
      'El caso {{caseReference}} se ha cerrado',
      'Su caso de retirada está cerrado.',
      'Motivo del equipo (en su idioma original): {{closureReason}}',
      'Si necesita ayuda, utilice los datos de contacto del aviso de retirada e indique la referencia de su caso.',
    ],
  ];
  return entries.map(([templateKey, subject, ...paragraphs]) => ({
    templateKey: templateKey!,
    locale: 'es-US',
    version: 1,
    subject: subject!,
    htmlBody: `<html lang="es"><body><h1>${subject}</h1><p>Referencia del caso: {{caseReference}}</p>${paragraphs.map((p) => `<p>${p}</p>`).join('')}<p>KOI Recall</p></body></html>`,
    textBody: `${subject}\n\nReferencia del caso: {{caseReference}}\n\n${paragraphs.join('\n\n')}\n\nKOI Recall`,
  }));
}
