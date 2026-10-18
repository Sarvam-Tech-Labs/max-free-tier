/**
 * Encryption for tokens pasted into the site: AES-256-GCM, a fresh random IV per save, and the token's name bound in as
 * additional authenticated data, so a stored ciphertext cannot be moved to another name. The key is the Worker secret
 * TOKEN_ENCRYPTION_KEY (32 random bytes, base64). Losing it means re-pasting the tokens.
 * shortcut: one key, no rotation; to rotate, set a new key and re-paste each token.
 */
const enc = new TextEncoder();

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function importKey(keyB64: string, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = fromB64(keyB64.trim());
  } catch {
    throw new Error("TOKEN_ENCRYPTION_KEY is not valid base64");
  }
  if (raw.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [usage]);
}

export interface Sealed {
  ciphertext: string;
  iv: string;
}

export async function seal(keyB64: string, name: string, plaintext: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: enc.encode(name) },
    await importKey(keyB64, "encrypt"),
    enc.encode(plaintext),
  );
  return { ciphertext: toB64(new Uint8Array(ct)), iv: toB64(iv) };
}

/** Throws when the key is wrong, the data was altered, or it belongs to another name. */
export async function unseal(keyB64: string, name: string, sealed: Sealed): Promise<string> {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64(sealed.iv), additionalData: enc.encode(name) },
    await importKey(keyB64, "decrypt"),
    fromB64(sealed.ciphertext),
  );
  return new TextDecoder().decode(pt);
}
