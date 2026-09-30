// AES-256-GCM voor connector-tokens (en de OAuth-state-cookie).
// Sleutel: CONNECTOR_ENCRYPTION_KEY = 32 bytes, als base64 (44 tekens) of hex (64 tekens).
// Formaat: "v1.<iv>.<tag>.<ciphertext>" (base64url). Alleen serverside gebruiken.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";

export function parseKey(raw: string | undefined): Buffer {
  if (!raw) throw new Error("CONNECTOR_ENCRYPTION_KEY ontbreekt");
  const trimmed = raw.trim();
  const key = /^[0-9a-f]{64}$/i.test(trimmed) ? Buffer.from(trimmed, "hex") : Buffer.from(trimmed, "base64");
  if (key.length !== 32) throw new Error("CONNECTOR_ENCRYPTION_KEY moet 32 bytes zijn (base64 of hex)");
  return key;
}

function key(explicit?: Buffer) {
  return explicit ?? parseKey(process.env.CONNECTOR_ENCRYPTION_KEY);
}

export function encrypt(plaintext: string, keyOverride?: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(keyOverride), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decrypt(token: string, keyOverride?: Buffer): string {
  const [version, iv, tag, data] = token.split(".");
  if (version !== VERSION || !iv || !tag || data === undefined) throw new Error("Ongeldig versleuteld formaat");
  const decipher = createDecipheriv("aes-256-gcm", key(keyOverride), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}
