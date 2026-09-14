import assert from "node:assert/strict";
import { createDecipheriv } from "node:crypto";
import * as nodeModule from "node:module";
import type { ResolveFnOutput, ResolveHookContext } from "node:module";
import test, { after, mock } from "node:test";

type Resolve = (specifier: string, context: ResolveHookContext, nextResolve: (specifier: string, context: ResolveHookContext) => ResolveFnOutput) => ResolveFnOutput;
const { registerHooks } = nodeModule as typeof nodeModule & { registerHooks(hooks: { resolve: Resolve }): { deregister(): void } };
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === "server-only" ? { url: "data:text/javascript,export {};", shortCircuit: true } : nextResolve(specifier, context);
  },
});
after(() => hooks.deregister());
const { sealConnectionSecret, openConnectionSecret } = await import("../../src/lib/connection-crypto.ts");
const key = "ab".repeat(32);

test("secret sealing round-trips UTF-8 and empty strings without disclosing plaintext", () => {
  for (const plaintext of ["", "synthetic-secret-value", "résumé 🔐\nsecond line"]) {
    const sealed = sealConnectionSecret(plaintext, key);
    assert.equal(openConnectionSecret(sealed, key), plaintext);
    if (plaintext) assert.equal(sealed.includes(plaintext), false);
  }
});

test("sealing uses independent 96-bit nonces and authenticates the versioned envelope", () => {
  const envelopes = Array.from({ length: 32 }, () => sealConnectionSecret("fixture", key));
  assert.equal(new Set(envelopes.map((value) => value.split(".")[1])).size, 32);
  const [version, nonce, ciphertext, tag] = envelopes[0].split(".");
  assert.equal(version, "v1");
  assert.equal(Buffer.from(nonce, "base64url").length, 12);
  assert.equal(Buffer.from(tag, "base64url").length, 16);
  // Independent decryption proves the seal is AES-256-GCM with this AAD,
  // rather than two mutually compatible but unauthenticated helpers.
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "hex"), Buffer.from(nonce, "base64url"));
  decipher.setAAD(Buffer.from("signal:connection-secret:v1"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  assert.equal(Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString(), "fixture");
});

test("keys must be exactly 32 bytes encoded as 64 hexadecimal characters", () => {
  const sealed = sealConnectionSecret("fixture", key);
  for (const invalid of ["", "ab".repeat(16), "ab".repeat(33), "z".repeat(64), ` ${key}`, `${key}\n`, Buffer.alloc(32).toString("base64"), null, 12]) {
    assert.throws(() => sealConnectionSecret("fixture", invalid as string));
    assert.throws(() => openConnectionSecret(sealed, invalid as string));
  }
  assert.equal(openConnectionSecret(sealed, key.toUpperCase()), "fixture");
});

test("wrong keys and changes to version, nonce, ciphertext, or tag are rejected", () => {
  const sealed = sealConnectionSecret("private-token-marker", key);
  assert.throws(() => openConnectionSecret(sealed, "cd".repeat(32)));
  for (let index = 0; index < 4; index++) {
    const parts = sealed.split(".");
    if (index === 0) parts[0] = "v2";
    else {
      const bytes = Buffer.from(parts[index], "base64url");
      bytes[0] ^= 1;
      parts[index] = bytes.toString("base64url");
    }
    assert.throws(() => openConnectionSecret(parts.join("."), key));
  }
});

test("malformed or noncanonical envelopes fail closed", () => {
  const sealed = sealConnectionSecret("fixture", key);
  const parts = sealed.split(".");
  for (const invalid of ["", "fixture", null, 12, ` ${sealed}`, `${sealed}\n`, `${sealed}.extra`, sealed.slice(0, -1),
    [parts[0], `${parts[1]}=`, parts[2], parts[3]].join("."),
    [parts[0], "AA", parts[2], parts[3]].join("."),
    [parts[0], parts[1], "!not-base64!", parts[3]].join("."),
    [parts[0], parts[1], parts[2], "AA"].join("."),
  ]) assert.throws(() => openConnectionSecret(invalid as string, key));
});

test("crypto failure messages and logs never expose keys, envelopes, or plaintext", () => {
  const output: unknown[] = [];
  for (const method of ["log", "warn", "error", "info", "debug"] as const) mock.method(console, method, (...args: unknown[]) => { output.push(args); });
  const secret = "private-token-marker";
  const sealed = sealConnectionSecret(secret, key);
  try {
    for (const work of [() => openConnectionSecret(sealed, "cd".repeat(32)), () => openConnectionSecret(secret, key), () => sealConnectionSecret(secret, secret)]) {
      assert.throws(work, (error: unknown) => {
        assert.ok(error instanceof Error);
        const visible = `${error.message} ${error.stack} ${JSON.stringify(error)}`;
        for (const hidden of [secret, key, sealed]) assert.equal(visible.includes(hidden), false);
        assert.equal(error.cause, undefined);
        return true;
      });
    }
    assert.deepEqual(output, []);
  } finally { mock.restoreAll(); }
});
