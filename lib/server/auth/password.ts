import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const N = 16384, r = 8, p = 1, KEYLEN = 32;

function scryptAsync(pw: string, salt: Buffer): Promise<Buffer> {
  return new Promise((res, rej) => scrypt(pw, salt, KEYLEN, { N, r, p }, (e, k) => (e ? rej(e) : res(k))));
}

/** scrypt$N$r$p$salt$hash */
export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(pw, salt);
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(pw: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [alg, , , , salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const key = await scryptAsync(pw, Buffer.from(salt, "base64url"));
  const expected = Buffer.from(hash, "base64url");
  return key.length === expected.length && timingSafeEqual(key, expected);
}
