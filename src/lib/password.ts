import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";

/** Built-in password hashing: scrypt with a per-password random salt. */
const PARAMS = { N: 16384, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;

function scrypt(password: string, salt: Buffer, keyLength: number, options: ScryptOptions) {
  return new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, keyLength, { ...options, maxmem: 64 * 1024 * 1024 }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

export function passwordPolicyError(password: unknown): string | null {
  if (typeof password !== "string") return "Password is required.";
  if (password.length < MIN_PASSWORD_LENGTH) return "Password must be at least " + MIN_PASSWORD_LENGTH + " characters.";
  if (password.length > MAX_PASSWORD_LENGTH) return "Password is too long.";
  return null;
}

export async function hashPassword(password: string) {
  const error = passwordPolicyError(password);
  if (error) throw new Error(error);
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, PARAMS);
  return ["scrypt", PARAMS.N, PARAMS.r, PARAMS.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

// Used when no user/hash exists so response timing does not reveal accounts.
const DUMMY_HASH = "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$" + Buffer.alloc(KEY_LENGTH).toString("base64url");

export async function verifyPassword(password: string, stored: string | null | undefined) {
  if (typeof password !== "string" || password.length > MAX_PASSWORD_LENGTH) return false;
  const parts = (stored ?? DUMMY_HASH).split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every(Number.isSafeInteger) || N > 1 << 17 || r > 16 || p > 4) return false;
  const salt = Buffer.from(parts[4]!, "base64url");
  const expected = Buffer.from(parts[5]!, "base64url");
  if (expected.length !== KEY_LENGTH) return false;
  const actual = await scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, { N, r, p });
  return timingSafeEqual(actual, expected) && Boolean(stored);
}
