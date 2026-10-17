import { describe, expect, it } from "vitest";
import { escapeHtml, FAVICON_SVG, faviconHref, fmtNum, renderPage } from "../src/page";

describe("escapeHtml / fmtNum", () => {
  it("escapes the four HTML specials", () => {
    expect(escapeHtml(`<a href="x">&</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
  });
  it("formats integers with separators, floats to 1 decimal, undefined as dash", () => {
    expect(fmtNum(1234567)).toBe("1,234,567");
    expect(fmtNum(2500.25)).toBe("2,500.3");
    expect(fmtNum(undefined)).toBe("–");
  });
});

describe("renderPage", () => {
  const dates = ["2026-09-13", "2026-09-14"];

  it("empty table → hint row, 'not collected yet', no spikes", () => {
    const html = renderPage({ dates, table: new Map(), spikes: [], lastCollected: null });
    expect(html).toContain("No rows yet");
    expect(html).toContain("Not collected yet");
    expect(html).toContain("No spikes today");
    expect(html).toContain("<th>09-13</th><th>09-14</th>");
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/<link[^>]+href="http/);
  });

  it("ships the Usage Guard gauge icon inline (no static assets, no /favicon.ico 404)", () => {
    const html = renderPage({ dates, table: new Map(), spikes: [], lastCollected: null });
    expect(html).toContain(`<link rel="icon" type="image/svg+xml" href="${faviconHref()}">`);
    expect(faviconHref().startsWith("data:image/svg+xml,")).toBe(true);
    expect(decodeURIComponent(faviconHref().slice("data:image/svg+xml,".length))).toBe(FAVICON_SVG);
    // Same geometry and colours as my-open-project apps/b-inbox/public/favicon.svg
    for (const s of [
      'stroke="#4f8cff"',
      'stroke-dasharray="75.40 100.53"',
      "rotate(135 32 34)",
      'stroke="#a78bfa"',
      'fill="#141821"',
    ]) {
      expect(FAVICON_SVG).toContain(s);
    }
  });

  it("renders totals, marks spike rows and escapes metric names", () => {
    const table = new Map([
      [
        "d1.rows_read",
        new Map([
          ["2026-09-13", 100],
          ["2026-09-14", 5000],
        ]),
      ],
      ["<evil>", new Map([["2026-09-14", 1]])],
    ]);
    const html = renderPage({
      dates,
      table,
      spikes: [{ metric: "d1.rows_read", today: 5000, baseline: 100, ratio: 50 }],
      lastCollected: "2026-09-14T12:00:00Z",
    });
    expect(html).toContain(
      '<tr class="spike"><td><code>d1.rows_read</code></td><td>100</td><td>5,000</td></tr>',
    );
    expect(html).toContain("<code>&lt;evil&gt;</code></td><td>–</td><td>1</td>");
    expect(html).toContain("5,000 today vs. median 100 (50.0×)");
    expect(html).toContain("Last collected 2026-09-14T12:00:00Z");
    expect(html).not.toContain("<evil>");
  });

  it("renders a baseline-0 spike as 'new'", () => {
    const html = renderPage({
      dates,
      table: new Map([["kv.read", new Map([["2026-09-14", 50]])]]),
      spikes: [{ metric: "kv.read", today: 50, baseline: 0, ratio: Number.POSITIVE_INFINITY }],
      lastCollected: null,
    });
    expect(html).toContain("(new)");
  });
});
