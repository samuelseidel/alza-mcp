import { describe, expect, it } from "vitest";
import { Catalog } from "../src/domain/catalog.js";
import type { AlzaBrowser } from "../src/infra/browser.js";

/**
 * getProduct keeps its public 30-row `params` contract while
 * getProductSpecs (PC builder) sees every scraped row — from one page load
 * (shared cache). Live motivation (2026-10-06): a GPU's "TDP" row was 29th.
 */
function fakeBrowser(rows: number, emptyFirstReads = 0) {
  const calls: string[] = [];
  let productReads = 0;
  const page = {
    goto: async (url: string) => {
      calls.push(url);
      return null;
    },
    waitForLoadState: async () => {},
    waitForSelector: async () => null,
    url: () => "https://www.alza.cz/x.htm",
    evaluate: async (script: string) => {
      if (script.includes("data-code")) return "https://www.alza.cz/gpu-d1.htm"; // resolveProductUrl
      const n = productReads++ < emptyFirstReads ? 0 : rows;
      return {
        title: "GPU",
        url: "https://www.alza.cz/gpu-d1.htm",
        h1: "GPU",
        product: { name: "GPU", sku: "GPU1", offers: { price: 100, priceCurrency: "CZK", availability: "https://schema.org/InStock" } },
        breadcrumb: null,
        availabilityText: "Na objednávku – termín upřesníme",
        params: Array.from({ length: n }, (_, i) => ({ name: `Row ${i + 1}`, value: `${i + 1}` })),
      };
    },
  };
  const browser = {
    locale: { baseUrl: "https://www.alza.cz", currency: "CZK" },
    withPage: async <T>(fn: (p: typeof page) => Promise<T>) => fn(page),
  } as unknown as AlzaBrowser;
  return { browser, calls };
}

describe("Catalog.getProduct vs getProductSpecs", () => {
  it("caps get_product at 30 params but keeps all rows for spec consumers, with one product-page load", async () => {
    const { browser, calls } = fakeBrowser(45);
    const c = new Catalog(browser);
    const full = await c.getProductSpecs("GPU1");
    expect(full.params).toHaveLength(45);
    expect(full.params?.[44]).toEqual({ name: "Row 45", value: "45" });
    const pub = await c.getProduct("GPU1");
    expect(pub.params).toHaveLength(30);
    expect(calls.filter((u) => u.includes("gpu-d1"))).toHaveLength(1);
  });

  it("prefers the visible availability text over JSON-LD InStock", async () => {
    const { browser } = fakeBrowser(1);
    const p = await new Catalog(browser).getProduct("GPU1");
    expect(p.availability).toBe("Na objednávku – termín upřesníme");
  });

  it("re-reads the page once when the spec table had not rendered yet", async () => {
    const { browser, calls } = fakeBrowser(12, 1);
    const p = await new Catalog(browser).getProductSpecs("GPU1");
    expect(p.params).toHaveLength(12);
    expect(calls.filter((u) => u.includes("gpu-d1"))).toHaveLength(1); // same page, no second navigation
  });

  it("the scrape script caps rows at 80", async () => {
    const { browser } = fakeBrowser(5);
    let script = "";
    const b = browser as unknown as { withPage: (fn: (p: unknown) => Promise<unknown>) => Promise<unknown> };
    const orig = b.withPage;
    b.withPage = (fn) =>
      orig((p: unknown) => {
        const pp = p as { evaluate: (s: string) => Promise<unknown> };
        const ev = pp.evaluate;
        pp.evaluate = (s: string) => {
          if (s.includes("paramTbl")) script = s;
          return ev(s);
        };
        return fn(pp);
      });
    await new Catalog(browser).getProductSpecs("GPU1");
    expect(script).toMatch(/\.slice\(0, 80\)/);
  });
});
