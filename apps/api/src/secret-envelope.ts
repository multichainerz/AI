import type { EncryptedEnvelope, EnvelopeEncryption } from "@orcasynapse/security";
export { storedEnvelope } from "@orcasynapse/security";

/**
 * Adapters between sealed database rows and the envelope the crypto expects.
 *
 * Both directions existed in two hand-written copies, and every read site
 * hardcoded `encryptionVersion: 1` — which quietly defeated the version guard
 * in `EnvelopeEncryption.decrypt`, since a row written under a future format
 * would be presented as if it were version 1 and fail later as a confusing
 * authentication-tag error instead of an unsupported-format one.
 */

/** Envelope bytes as the database wants them: owned, copyable buffers. */
export function sealedColumns(envelope: EncryptedEnvelope) {
  const own = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => {
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    return copy;
  };
  return {
    encryptedValue: own(envelope.encryptedValue),
    valueNonce: own(envelope.valueNonce),
    valueAuthTag: own(envelope.valueAuthTag),
    wrappedDataKey: own(envelope.wrappedDataKey),
    keyNonce: own(envelope.keyNonce),
    keyAuthTag: own(envelope.keyAuthTag),
    encryptionVersion: envelope.encryptionVersion,
    masterKeyVersion: envelope.masterKeyVersion,
  };
}

/** Seals one named field of a service connection's secret set. */
export function encryptedSecretData(
  connectionId: string,
  fieldName: string,
  value: string,
  encryption: EnvelopeEncryption,
) {
  return { fieldName, ...sealedColumns(encryption.encrypt(value, `${connectionId}:${fieldName}`)) };
}
