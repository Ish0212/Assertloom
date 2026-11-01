const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"`]+:[^\s@'"`]+@/gi,
];

const ASSIGNED_SECRET =
  /\b([A-Za-z0-9_]*(?:secret|password|passwd|api_?key|token|credential|authorization)[A-Za-z0-9_]*["']?\s*(?:[:=]|===?|!==?)\s*)(["'`])((?:(?!\2)[^\n\\]|\\.){8,})\2/gi;

/** Replaces likely credentials with a placeholder before code leaves the machine. */
export function redactSecrets(code: string): { code: string; redactions: number } {
  let redactions = 0;
  let result = code;

  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, () => {
      redactions++;
      return "<redacted>";
    });
  }

  result = result.replace(ASSIGNED_SECRET, (match, prefix: string, quote: string, value: string) => {
    if (value.includes("<redacted>")) return match;
    redactions++;
    return `${prefix}${quote}<redacted>${quote}`;
  });

  return { code: result, redactions };
}
