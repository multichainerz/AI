export interface RuntimeTextPolicy {
  maxInputCharacters: number;
  maxOutputCharacters: number;
  blockControlCharacters: boolean;
  blockCredentialPatterns: boolean;
}

export type RuntimePolicyViolation =
  | "INPUT_CHARACTER_LIMIT"
  | "CONTROL_CHARACTERS"
  | "CREDENTIAL_PATTERN";

const UNSAFE_CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const CREDENTIAL_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/iu,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bgh[oprsu]_[A-Za-z0-9]{30,}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u,
];

export function inspectInputText(
  value: string,
  policy: Pick<RuntimeTextPolicy, "maxInputCharacters" | "blockControlCharacters" | "blockCredentialPatterns">,
): RuntimePolicyViolation | null {
  if (value.length > policy.maxInputCharacters) return "INPUT_CHARACTER_LIMIT";
  if (policy.blockControlCharacters && UNSAFE_CONTROL_CHARACTER.test(value)) return "CONTROL_CHARACTERS";
  if (policy.blockCredentialPatterns && CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value))) {
    return "CREDENTIAL_PATTERN";
  }
  return null;
}
