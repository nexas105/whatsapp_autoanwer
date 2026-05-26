// PII redaction for chat content that gets sent to the AI.
//
// Contract:
//   redactPII(text, enabled?) -> string
//   redactPIIIfEnabled(text, repo) -> string  // checks global_config.pii_redaction_enabled
//
// Replaces:
//   phone numbers           -> <TEL>
//   e-mail addresses        -> <EMAIL>
//   IBAN-shaped strings     -> <IBAN>
//   German street addresses -> <ADDR>

export function redactPII(text, enabled = true) {
  if (!enabled || !text) return text;
  let t = String(text);
  // phone (very loose; matches +49 1578 4577870 / 030 41738314 / 015...)
  t = t.replace(/(\+?\d[\d \-/()]{7,}\d)/g, '<TEL>');
  // email
  t = t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<EMAIL>');
  // IBAN-ish
  t = t.replace(/\b[A-Z]{2}\d{2}[A-Z0-9 ]{12,30}\b/g, '<IBAN>');
  // German street: "Musterstraße 12"
  t = t.replace(/\b([A-ZÄÖÜ][a-zäöüß-]{2,}(?:straße|str\.|weg|allee|platz))\s+\d+[a-z]?/gi, '<ADDR>');
  return t;
}

export function redactPIIIfEnabled(text, repo) {
  try {
    const cfg = repo.getGlobalConfig();
    return redactPII(text, !!cfg.pii_redaction_enabled);
  } catch {
    return text;
  }
}
