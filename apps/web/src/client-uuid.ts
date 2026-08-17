/**
 * A UUID from a browser that may not have `crypto.randomUUID`.
 *
 * `crypto.randomUUID` is restricted to secure contexts, and this product is
 * routinely reached over plain HTTP: the bundled proxy listens on HTTP and
 * `ORCASYNAPSE_PUBLIC_SCHEME` defaults to it, so an operator on a LAN address
 * has `crypto` without `randomUUID`. Calling it directly there is `undefined is
 * not a function` at the moment somebody presses a button.
 *
 * Extracted from `chat-view.tsx`, which has needed exactly this since
 * optimistic message ids existed. It lives in its own module rather than being
 * imported from there because the views are code split per route, and reaching
 * into the chat view for one helper would pull its 200 kB chunk into every
 * route that wanted a UUID. `chat-view.tsx` re-exports it so its own tests, and
 * anything else that already imported it from there, are unaffected.
 */

interface ClientCrypto {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array) => Uint8Array;
}

let fallbackSequence = 0;

export function createClientMessageId(
  cryptoApi: ClientCrypto | null | undefined = globalThis.crypto as ClientCrypto | undefined,
): string {
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();

  const bytes = new Uint8Array(16);
  if (typeof cryptoApi?.getRandomValues === "function") {
    cryptoApi.getRandomValues(bytes);
  } else {
    // This identifier exists only until the server-supplied message replaces
    // the optimistic row. It is never used as an authentication token.
    const seed = `${Date.now()}-${fallbackSequence += 1}-${Math.random()}`;
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = seed.charCodeAt(index % seed.length) ^ ((index * 31) & 0xff);
    }
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
