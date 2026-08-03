import { customType } from "drizzle-orm/pg-core";

/**
 * PostgreSQL `bytea` as `Uint8Array`.
 *
 * drizzle-kit cannot introspect bytea and emits an `unknown()` placeholder for
 * it, so the twenty envelope-encryption and token-digest columns need this
 * explicit type. Values surface as `Uint8Array` to match what the security
 * primitives already produce and compare with `timingSafeEqual`.
 */
export const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
  toDriver(value: Uint8Array): Buffer {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  },
  fromDriver(value: Buffer): Uint8Array {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  },
});
