import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { decrypt, encrypt, parseKey } from "@/lib/crypto";

const key = randomBytes(32);

describe("token-encryptie (AES-256-GCM)", () => {
  it("versleutelt en ontsleutelt heen en terug", () => {
    const secret = "ya29.a0Af_test-access-token_ÄÖÜ";
    const enc = encrypt(secret, key);
    expect(enc).not.toContain(secret);
    expect(enc.startsWith("v1.")).toBe(true);
    expect(decrypt(enc, key)).toBe(secret);
  });

  it("gebruikt elke keer een nieuwe IV", () => {
    expect(encrypt("zelfde", key)).not.toBe(encrypt("zelfde", key));
  });

  it("weigert gemanipuleerde ciphertext (auth tag)", () => {
    const [v, iv, tag, data] = encrypt("geheim", key).split(".");
    const flipped = Buffer.from(data, "base64url");
    flipped[0] ^= 0xff;
    expect(() => decrypt([v, iv, tag, flipped.toString("base64url")].join("."), key)).toThrow();
  });

  it("weigert een verkeerde sleutel", () => {
    const enc = encrypt("geheim", key);
    expect(() => decrypt(enc, randomBytes(32))).toThrow();
  });

  it("accepteert sleutels als base64 of hex, en weigert verkeerde lengtes", () => {
    expect(parseKey(key.toString("base64")).equals(key)).toBe(true);
    expect(parseKey(key.toString("hex")).equals(key)).toBe(true);
    expect(() => parseKey(randomBytes(16).toString("base64"))).toThrow();
    expect(() => parseKey(undefined)).toThrow();
  });

  it("gebruikt CONNECTOR_ENCRYPTION_KEY uit de omgeving", () => {
    const old = process.env.CONNECTOR_ENCRYPTION_KEY;
    process.env.CONNECTOR_ENCRYPTION_KEY = key.toString("base64");
    try {
      expect(decrypt(encrypt("x"))).toBe("x");
    } finally {
      process.env.CONNECTOR_ENCRYPTION_KEY = old;
    }
  });
});
