/**
 * The single canonical JSON serialization used for every signed or hashed body.
 *
 * This existed in three identical copies — two managers and a test that carried
 * its own — which meant the test validated the algorithm against itself and
 * could never catch a divergence. One implementation, imported everywhere,
 * including by the tests.
 *
 * The runtime node installer signs with `jq -cS`, so this must agree with jq
 * byte for byte. It does for strings, booleans, null, arrays and objects with
 * ASCII keys. **It does not agree for non-integer numbers**: `JSON.stringify(1.0)`
 * yields `1` where jq yields `1.0`. No signed body carries a number today, and
 * `assertSignableBody` keeps it that way rather than leaving the trap armed.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
}

/**
 * Rejects a body this serialization cannot canonicalize identically to jq.
 *
 * Called on the signature-verification path, so adding a numeric field to a
 * signed payload fails loudly here instead of producing signatures that two
 * correct implementations disagree about.
 */
export function assertSignableBody(value: unknown): void {
  const walk = (node: unknown, path: string): void => {
    if (typeof node === "number") {
      throw new Error(`Signed request bodies must not contain numbers (${path || "root"}); canonical forms differ across implementations.`);
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (node && typeof node === "object") {
      for (const [key, item] of Object.entries(node)) walk(item, path ? `${path}.${key}` : key);
    }
  };
  walk(value, "");
}
