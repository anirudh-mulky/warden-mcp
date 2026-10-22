import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Password hashing for dashboard users, with Node's built-in scrypt.
 *
 * Unlike API keys, passwords are chosen by humans and are guessable, so the
 * hash must be deliberately slow and memory-hungry: each guess an attacker
 * makes against a stolen hash costs real time and RAM. (This is the job
 * argon2 was planned for; scrypt does the same job and is built into Node,
 * so there is no native module to compile — on a Mac or in a Linux container.)
 *
 * Stored format: "scrypt$N$r$p$<salt b64>$<hash b64>". The parameters travel
 * with each hash, so they can be raised later without breaking old users.
 */

const N = 2 ** 15; // CPU/memory cost: 128 * N * r bytes = 32 MiB per hash
const R = 8;
const P = 1;
const KEY_LENGTH = 64;

function derive(password: string, salt: Buffer, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // maxmem must exceed 128*N*r, or Node refuses the parameters.
    scrypt(password, salt, KEY_LENGTH, { ...opts, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16); // unique per user, so equal passwords hash differently
  const hash = await derive(password, salt, { N, r: R, p: P });
  return ["scrypt", N, R, P, salt.toString("base64"), hash.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || saltB64 === undefined || hashB64 === undefined) return false;

  const expected = Buffer.from(hashB64, "base64");
  const actual = await derive(password, Buffer.from(saltB64, "base64"), {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  // Constant-time comparison: a normal === stops at the first differing
  // byte, and that timing difference can leak how close a guess was.
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * A real hash of a random password, computed once. Login verifies against it
 * when the email does not exist, so "no such user" takes as long as "wrong
 * password" and response times cannot be used to discover which emails
 * have accounts.
 */
export const DUMMY_HASH: Promise<string> = hashPassword(randomBytes(16).toString("hex"));
