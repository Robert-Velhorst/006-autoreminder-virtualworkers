/** Gmail metadata contains a preview, not the full body or a linked portal document. */
export function gmailContentScope(subject: string, snippet: string): "portal_notice" | "message_preview" {
  const text = `${subject}\n${snippet}`.toLocaleLowerCase();
  const externalLocation = /\b(?:portaal|portal|mijn[- ]?omgeving|persoonlijke\s+(?:online\s+)?omgeving|your\s+(?:online\s+)?account|online\s+(?:account|environment))\b/i.test(text);
  const accessInstruction = /\b(?:inloggen|log\s*in|sign\s*in|aanmelden|open\s+(?:the|your)\s+(?:portal|account))\b/i.test(text);
  const notice = /\b(?:bericht|message|document|brief|letter|correspondentie|correspondence)\b.{0,140}\b(?:klaar|beschikbaar|available|ready|waiting|gereed|in\s+(?:uw|your)\s+(?:portaal|portal|mijn[- ]?omgeving))\b/i.test(text)
    || /\b(?:staat|is)\s+(?:er\s+)?(?:een\s+)?(?:nieuw\s+)?(?:bericht|message|document|brief|letter)\b.{0,140}\b(?:klaar|beschikbaar|available|ready|waiting)\b/i.test(text);
  return notice && (externalLocation || accessInstruction) ? "portal_notice" : "message_preview";
}
