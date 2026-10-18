import { describe, expect, it, vi } from "vitest";
import { handleDiag } from "../src/diag";
import type { Env } from "../src/env";
import { createFakeD1 } from "./helpers/fake-d1";

const env = (over: Partial<Env> = {}): Env => ({
  USAGE: createFakeD1(),
  CF_API_TOKEN: "t",
  ...over,
});
const req = (q = "", headers: Record<string, string> = { "X-Requested-With": "max-free-tier" }) =>
  new Request(`https://x.test/api/diag/schema${q}`, { headers });

describe("schema probe (temporary)", () => {
  it("asks Cloudflare for the requested type's schema and returns it as is", async () => {
    const f = vi.fn(async () =>
      Response.json({ data: { __type: { name: "account" } } }),
    ) as unknown as typeof fetch;
    const res = await handleDiag(req("?type=account"), env(), f);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { __type: { name: "account" } } });
    const call = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(call[1].body)).variables).toEqual({ n: "account" });
  });
  it("refuses without the site header, without a token, and for a type name that is not a plain identifier", async () => {
    const f = vi.fn() as unknown as typeof fetch;
    expect((await handleDiag(req("", {}), env(), f)).status).toBe(403);
    expect((await handleDiag(req(), env({ CF_API_TOKEN: undefined }), f)).status).toBe(409);
    expect((await handleDiag(req("?type=a b"), env(), f)).status).toBe(400);
    expect(f).not.toHaveBeenCalled();
    const defaulted = vi.fn(async () => new Response("{}")) as unknown as typeof fetch;
    await handleDiag(req(), env(), defaulted);
    expect(
      JSON.parse(
        String(
          (
            (defaulted as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
              string,
              RequestInit,
            ]
          )[1].body,
        ),
      ).variables.n,
    ).toBe("account");
  });
});
