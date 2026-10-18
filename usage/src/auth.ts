/** SHA-256 digests compared in constant time, so neither length nor content leaks through timing. */
async function digest(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

export async function sameSecret(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([digest(given), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

/** HTTP Basic: any username, the password must equal the DASHBOARD_PASSWORD secret. */
export async function authorized(request: Request, password: string): Promise<boolean> {
  const header = request.headers.get("Authorization") ?? "";
  if (!header.startsWith("Basic ")) return false;
  let given: string;
  try {
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(header.slice(6)), (c) => c.charCodeAt(0)),
    );
    given = decoded.slice(decoded.indexOf(":") + 1);
  } catch {
    return false; // not valid base64
  }
  return sameSecret(given, password);
}

/** `Authorization: Bearer <token>` equal to `token`. */
export async function bearer(request: Request, token: string): Promise<boolean> {
  const header = request.headers.get("Authorization") ?? "";
  return header.startsWith("Bearer ") && sameSecret(header.slice(7), token);
}
