import { afterEach, describe, expect, it, vi } from "vitest";
import { formatMessage, notify } from "../src/notify";

const spikes = [
  { metric: "d1.rows_read", today: 5000, baseline: 100, ratio: 50 },
  { metric: "kv.read", today: 50, baseline: 0, ratio: Number.POSITIVE_INFINITY },
];

describe("formatMessage", () => {
  it("one line per spike, singular/plural header", () => {
    const one = formatMessage("2026-09-14", [spikes[0] as (typeof spikes)[0]]);
    expect(one).toMatch(/^usage-guard-collector — 1 spike on 2026-09-14 \(UTC\)\n/);
    expect(one).toContain("• d1.rows_read: 5,000 today vs. 7-day median 100 (50.0×)");
    const two = formatMessage("2026-09-14", spikes);
    expect(two).toContain("2 spikes");
    expect(two).toContain("kv.read: 50 today vs. 7-day median 0 (new)");
  });
});

describe("notify (three paths)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("no webhook configured → no fetch, []", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    expect(await notify({}, "hi")).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });

  it("success: Discord gets {content}, Slack gets {text}", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init.body)) });
        expect(init.method).toBe("POST");
        return new Response(null, { status: 204 });
      }),
    );
    const out = await notify(
      {
        DISCORD_WEBHOOK_URL: "https://d.example/hook",
        SLACK_WEBHOOK_URL: "https://s.example/hook",
      },
      "msg",
    );
    expect(out).toEqual([
      { target: "discord", ok: true, status: 204 },
      { target: "slack", ok: true, status: 204 },
    ]);
    expect(calls).toEqual([
      { url: "https://d.example/hook", body: { content: "msg" } },
      { url: "https://s.example/hook", body: { text: "msg" } },
    ]);
  });

  it("non-2xx → ok:false with status; network error → ok:false with message; never throws", async () => {
    vi.stubGlobal("fetch", async () => new Response("rate limited", { status: 429 }));
    expect(await notify({ DISCORD_WEBHOOK_URL: "https://d.example/hook" }, "m")).toEqual([
      { target: "discord", ok: false, status: 429 },
    ]);
    const boom = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    expect(
      await notify(
        { SLACK_WEBHOOK_URL: "https://s.example/hook" },
        "m",
        boom as unknown as typeof fetch,
      ),
    ).toEqual([{ target: "slack", ok: false, error: "ECONNRESET" }]);
    const weird = vi.fn(async () => {
      throw "string-error";
    });
    expect(
      await notify(
        { SLACK_WEBHOOK_URL: "https://s.example/hook" },
        "m",
        weird as unknown as typeof fetch,
      ),
    ).toEqual([{ target: "slack", ok: false, error: "string-error" }]);
  });
});
