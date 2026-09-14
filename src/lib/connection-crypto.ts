import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const version = "v1";
const aad = Buffer.from("signal:connection-secret:v1", "utf8");
const maxBytes = 65_536;
const unavailable = "Connection secret is unavailable.";

function decodeKey(key: string): Buffer {
  // One explicit encoding. Buffer.from alone silently accepts truncated hex.
  if (typeof key !== "string" || !/^[a-fA-F0-9]{64}$/.test(key)) throw new Error(unavailable);
  return Buffer.from(key, "hex");
}

function decodePart(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error(unavailable);
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) throw new Error(unavailable);
  return decoded;
}

/** Server-only AES-256-GCM; key is exactly 64 hex characters (32 bytes). */
export function sealConnectionSecret(plaintext: string, key: string): string {
  try {
    const keyBytes = decodeKey(key);
    if (typeof plaintext !== "string" || !plaintext.isWellFormed() || Buffer.byteLength(plaintext, "utf8") > maxBytes) throw new Error();
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", keyBytes, nonce, { authTagLength: 16 });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return [version, nonce.toString("base64url"), ciphertext.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
  } catch {
    // Crypto/decoder exceptions may contain inputs; expose neither cause nor values.
    throw new Error(unavailable);
  }
}

export function openConnectionSecret(ciphertext: string, key: string): string {
  try {
    const keyBytes = decodeKey(key);
    if (typeof ciphertext !== "string" || ciphertext.length > maxBytes * 2) throw new Error();
    const parts = ciphertext.split(".");
    if (parts.length !== 4 || parts[0] !== version) throw new Error();
    const [nonce, encrypted, tag] = parts.slice(1).map(decodePart);
    if (nonce.length !== 12 || tag.length !== 16 || encrypted.length > maxBytes) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", keyBytes, nonce, { authTagLength: 16 });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    // Do not release update() output until final() authenticates the whole envelope.
    const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
  } catch {
    throw new Error(unavailable);
  }
}
