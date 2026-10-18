/** HTTP Basic: any username, the password must equal the DASHBOARD_PASSWORD secret. Compared by SHA-256 digest, in constant time. */
async function digest(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

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
  const [a, b] = await Promise.all([digest(given), digest(password)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}
