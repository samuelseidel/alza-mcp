/**
 * PC builder orchestration (issue #15): fetches real Alza products and runs
 * the pure rules from `pc-build.ts` over them.
 *
 * - `check`: an agent-chosen parts list → one detail fetch per part (cached
 *   15 min by `Catalog`), role detection, rule verdicts.
 * - `suggest`: a budget → for each role in dependency order, one category
 *   listing page (the real component category, `/{categoryId}.htm`), a
 *   name-based pre-filter (chipset → socket, DDR type, PSU wattage), then
 *   bounded detail fetches until a candidate passes the rules that apply to
 *   that role given the parts already chosen.
 *
 * Every product detail is a full browser page load, so detail fetches are
 * budgeted (`maxDetailFetches`) and reported back.
 */
import type { Catalog } from "./catalog.js";
import type { Product } from "./types.js";
import {
  MULTI_ROLES,
  PC_CATEGORY_IDS,
  RAM_CATEGORY_BY_TYPE,
  SUGGEST_ORDER,
  allocateBudget,
  checkBuild,
  detectRole,
  estimatePower,
  normalizeSpecs,
  overallVerdict,
  rulesForRole,
  socketHintFromBoardName,
  wattageHintFromName,
  type BuildParts,
  type BuildProfile,
  type NormalizedSpecs,
  type OverallVerdict,
  type PcRole,
  type PowerEstimate,
  type RulePart,
  type RuleVerdict,
} from "./pc-build.js";

export type PcCatalog = Pick<Catalog, "getProductSpecs" | "searchProducts" | "getCategoryFilters">;

export interface BuildPartOut {
  role: PcRole;
  code: string;
  name: string;
  url: string;
  price?: number;
  currency: string;
  /** Raw availability (schema.org value from the product page, or the card CTA). */
  availability?: string;
  /** true = purchasable now, false = not, null = undetermined. */
  inStock: boolean | null;
  /** Normalised specs the rules used, each with its Czech source row. */
  specs: NormalizedSpecs;
  /** false when the part was chosen from its listing card only (no detail fetch). */
  specsFetched: boolean;
  /** Where this part came from in `pc_build_suggest`: "fixed" (user-pinned) or "suggested". */
  origin?: "fixed" | "suggested";
}

export interface BuildReport {
  parts: BuildPartOut[];
  total: number;
  currency: string;
  /** Codes of parts without a known price (excluded from `total`). */
  unpriced: string[];
  verdicts: RuleVerdict[];
  overall: OverallVerdict;
  powerEstimate?: PowerEstimate;
  notes: string[];
  /** Product detail page loads this call requested (cache hits included). */
  detailFetches: number;
  /** Category listing page loads (suggest only). */
  categoryPages: number;
  budget?: number;
  withinBudget?: boolean;
  profile?: BuildProfile;
  allocation?: Partial<Record<PcRole, number>>;
}

export interface CheckInput {
  parts: Array<{ code: string; role?: PcRole }>;
  psuHeadroom?: number;
}

export interface SuggestInput {
  budget: number;
  profile?: BuildProfile;
  cpuVendor?: "amd" | "intel";
  fixedParts?: Array<{ code: string; role?: PcRole }>;
  skipRoles?: PcRole[];
  maxDetailFetches?: number;
  psuHeadroom?: number;
}

export const DEFAULT_MAX_DETAIL_FETCHES = 14;
export const MAX_DETAIL_FETCHES = 24;
export const MAX_CHECK_PARTS = 10;
/** Detail fetches tried per role before giving up on that role. */
const TRIES_PER_ROLE = 3;
/** Listing cards considered per role (one category page). */
const CARDS_PER_ROLE = 24;

export function inStockFrom(availability: string | undefined): boolean | null {
  if (!availability) return null;
  if (/^(InStock|in stock)$/i.test(availability)) return true;
  // Visible Czech availability line from the product page.
  if (/^(Není skladem|Na objednávku|Vyprodáno|Dočasně nedostupn|Předobjednávk)/i.test(availability)) return false;
  if (/^Skladem/i.test(availability)) return true;
  if (/OutOfStock|not purchasable|SoldOut|Discontinued|PreOrder|BackOrder/i.test(availability)) return false;
  return null;
}

function toPart(role: PcRole, p: Product, specsFetched: boolean, origin?: "fixed" | "suggested"): BuildPartOut {
  return {
    role,
    code: p.code,
    name: p.name,
    url: p.url,
    price: p.price,
    currency: p.currency,
    availability: p.availability,
    inStock: inStockFrom(p.availability),
    specs: specsFetched ? normalizeSpecs(role, p.params) : {},
    specsFetched,
    origin,
  };
}

function toBuildParts(parts: BuildPartOut[]): BuildParts {
  const b: BuildParts = {};
  for (const p of parts) {
    const rp: RulePart = { code: p.code, name: p.name, specs: p.specs };
    if (p.role === "ram" || p.role === "storage") (b[p.role] ??= []).push(rp);
    else b[p.role] = rp;
  }
  return b;
}

function summarize(parts: BuildPartOut[], verdicts: RuleVerdict[], psuHeadroom: number | undefined) {
  const priced = parts.filter((p) => p.price !== undefined);
  const total = priced.reduce((s, p) => s + (p.price ?? 0), 0);
  const b = toBuildParts(parts);
  const powerEstimate = b.cpu || b.gpu ? estimatePower(b, psuHeadroom) : undefined;
  return {
    total,
    currency: parts[0]?.currency ?? "CZK",
    unpriced: parts.filter((p) => p.price === undefined).map((p) => p.code),
    overall: overallVerdict(verdicts),
    powerEstimate,
  };
}

export class PcBuilder {
  constructor(private readonly catalog: PcCatalog) {}

  async check(input: CheckInput): Promise<BuildReport> {
    const codes = input.parts.map((p) => p.code.trim());
    if (codes.length === 0) throw new Error("parts must contain at least one product code");
    if (codes.length > MAX_CHECK_PARTS) throw new Error(`at most ${MAX_CHECK_PARTS} parts per check (each is a product page load)`);
    const dup = codes.find((c, i) => codes.indexOf(c) !== i);
    if (dup) throw new Error(`product code ${dup} is listed twice — list each part once`);

    const parts: BuildPartOut[] = [];
    let detailFetches = 0;
    for (const req of input.parts) {
      const product = await this.catalog.getProductSpecs(req.code.trim());
      detailFetches++;
      const role = req.role ?? detectRole(product.name, product.params);
      if (!role) {
        const why = product.params?.length ? "from its specs" : "— its product page returned no spec table";
        throw new Error(
          `Could not tell which component ${req.code} ("${product.name}") is ${why}. Pass its role explicitly (cpu, motherboard, ram, gpu, storage, case, cooler, psu).`
        );
      }
      parts.push(toPart(role, product, true));
    }
    const specless = parts.filter((p) => p.role !== "storage" && Object.keys(p.specs).length === 0);
    assertSingleRoles(parts);
    const verdicts = checkBuild(toBuildParts(parts), { psuHeadroom: input.psuHeadroom });
    const notes: string[] = [];
    const missingRoles = (["cpu", "motherboard", "ram", "psu", "case"] as PcRole[]).filter((r) => !parts.some((p) => p.role === r));
    if (missingRoles.length) notes.push(`Not a complete build — no ${missingRoles.join(", ")}; rules needing them are not_applicable.`);
    if (specless.length) notes.push(`No usable spec rows found for ${specless.map((p) => p.code).join(", ")} — their rules are unknown; retry later or check the product page.`);
    notes.push(...advisoryNotes(parts));
    const oos = parts.filter((p) => p.inStock === false);
    if (oos.length) notes.push(`Not purchasable right now: ${oos.map((p) => p.code).join(", ")}.`);
    return { parts, verdicts, notes, detailFetches, categoryPages: 0, ...summarize(parts, verdicts, input.psuHeadroom) };
  }

  async suggest(input: SuggestInput): Promise<BuildReport> {
    const profile = input.profile ?? "gaming";
    const maxFetches = Math.min(MAX_DETAIL_FETCHES, Math.max(1, input.maxDetailFetches ?? DEFAULT_MAX_DETAIL_FETCHES));
    const notes: string[] = [];
    let detailFetches = 0;
    let categoryPages = 0;
    const parts: BuildPartOut[] = [];

    // 1. User-pinned parts first: they constrain everything else.
    for (const req of input.fixedParts ?? []) {
      const product = await this.catalog.getProductSpecs(req.code.trim());
      detailFetches++;
      const role = req.role ?? detectRole(product.name, product.params);
      if (!role) throw new Error(`Could not tell which component fixed part ${req.code} is — pass its role explicitly.`);
      parts.push(toPart(role, product, true, "fixed"));
    }
    assertSingleRoles(parts);

    const skip = new Set(input.skipRoles ?? []);
    const fixedRoles = new Set(parts.map((p) => p.role));
    const roles = SUGGEST_ORDER.filter((r) => !skip.has(r) && !fixedRoles.has(r) && (profile !== "office" || r !== "gpu"));
    if (profile === "office" && !skip.has("gpu") && !fixedRoles.has("gpu")) {
      notes.push("Office profile: no graphics card — the CPU must have integrated graphics (display_output rule).");
    }
    const fixedSpend = parts.reduce((s, p) => s + (p.price ?? 0), 0);
    const allocation = allocateBudget(input.budget, profile, roles, fixedSpend);
    if (fixedSpend >= input.budget) notes.push(`Fixed parts already cost ${fixedSpend} — over the ${input.budget} budget.`);
    const plannedGpu = roles.includes("gpu") || fixedRoles.has("gpu");

    let carry = 0;
    for (const role of SUGGEST_ORDER) {
      if (!roles.includes(role)) continue;
      const target = Math.max(0, (allocation[role] ?? 0) + carry);
      const built = toBuildParts(parts);
      const categoryId = role === "ram" ? ramCategory(built) : PC_CATEGORY_IDS[role];
      // CPU vendor → the category's real brand facet (list_category_filters'
      // `brands`, which Alza honours as a URL filter in every category).
      let producerIds: number[] | undefined;
      if (role === "cpu" && input.cpuVendor) {
        const facets = await this.catalog.getCategoryFilters(categoryId);
        categoryPages++;
        const brand = facets.brands.find((b) => b.description.trim().toLowerCase() === input.cpuVendor);
        if (brand) producerIds = [brand.valueId];
        else notes.push(`cpu: brand "${input.cpuVendor}" not among category ${categoryId}'s brand facets — filtered by name instead.`);
      }
      const listing = await this.catalog.searchProducts({ query: "", categoryId, browse: true, inStock: true, limit: CARDS_PER_ROLE, producerIds });
      categoryPages++;
      const cards = listing.products.filter((p) => p.price !== undefined && prefilter(role, p, built, input));
      if (cards.length === 0) {
        notes.push(`${role}: no in-stock candidate on the first listing page of category ${categoryId} after filtering — left empty.`);
        continue;
      }
      // Most expensive card within the allocation first (best part the money
      // buys); for RAM, multi-module kits first (dual channel).
      const kitFirst = (p: Product) => (role === "ram" && /\bKIT\b|\b[24]\s?[x×]\s?\d+\s?GB/i.test(p.name) ? 0 : 1);
      const within = cards.filter((p) => p.price! <= target).sort((a, b) => kitFirst(a) - kitFirst(b) || b.price! - a.price!);
      const over = cards.filter((p) => p.price! > target).sort((a, b) => a.price! - b.price!);
      const ordered = [...within, ...over];

      let chosen: BuildPartOut | undefined;
      if (role === "storage") {
        // No compatibility rule depends on storage specs — save the page load.
        chosen = toPart(role, ordered[0]!, false, "suggested");
      } else {
        const ruleIds = rulesForRole(role).filter((r) => !(r === "display_output" && plannedGpu));
        // Detail fetches still needed by the roles after this one (storage needs none).
        const laterRoles = roles.slice(roles.indexOf(role) + 1).filter((r) => r !== "storage").length;
        let fallback: BuildPartOut | undefined; // no fail, but a warn/unknown — used if no clean pass turns up
        let tries = 0;
        for (const card of ordered) {
          if (tries >= TRIES_PER_ROLE) break;
          if (detailFetches >= maxFetches) break;
          // Keep looking past a warn only while the budget still covers the later roles.
          if (fallback && maxFetches - detailFetches <= laterRoles) break;
          detailFetches++;
          tries++;
          let product: Product;
          try {
            product = await this.catalog.getProductSpecs(card.code);
          } catch (e) {
            // One candidate's page failing (timeout, delisted, CF hiccup) must
            // not abort a multi-minute suggest run — skip it like a failed rule.
            notes.push(`${role}: skipped ${card.code} (product page failed: ${e instanceof Error ? e.message : String(e)}).`);
            continue;
          }
          const candidate = toPart(role, product, true, "suggested");
          if (candidate.price === undefined) candidate.price = card.price;
          const relevant = checkBuild(toBuildParts([...parts, candidate]), { psuHeadroom: input.psuHeadroom }).filter((v) =>
            ruleIds.includes(v.rule)
          );
          const failing = relevant.filter((v) => v.verdict === "fail");
          if (failing.length > 0) {
            notes.push(`${role}: skipped ${card.code} (${failing.map((f) => f.rule).join(", ")} failed).`);
            continue;
          }
          const doubtful = relevant.filter((v) => v.verdict === "warn" || v.verdict === "unknown");
          if (doubtful.length === 0) {
            chosen = candidate;
            break;
          }
          if (!fallback) {
            fallback = candidate;
            notes.push(`${role}: ${card.code} only got ${doubtful.map((d) => `${d.rule}=${d.verdict}`).join(", ")} — looking for a clean pass.`);
          }
        }
        if (!chosen && fallback) {
          chosen = fallback;
          notes.push(`${role}: kept ${fallback.code} (no candidate passed cleanly within the tries/budget).`);
        } else if (!chosen && detailFetches >= maxFetches) {
          chosen = toPart(role, ordered[0]!, false, "suggested");
          notes.push(`${role}: detail-fetch budget (${maxFetches}) exhausted — ${chosen.code} picked from its listing card without specs; its rules are unknown. Re-run pc_build_check on the final list.`);
        } else if (!chosen) {
          notes.push(`${role}: none of the first ${TRIES_PER_ROLE} candidates passed ${ruleIds.join(", ")} — left empty; pin a part via fixed_parts.`);
        }
      }
      if (chosen) {
        parts.push(chosen);
        carry = target - (chosen.price ?? 0);
      }
    }

    const verdicts = checkBuild(toBuildParts(parts), { psuHeadroom: input.psuHeadroom });
    const s = summarize(parts, verdicts, input.psuHeadroom);
    notes.push(...advisoryNotes(parts));
    if (s.total > input.budget) notes.push(`Total ${s.total} exceeds the ${input.budget} budget by ${s.total - input.budget}.`);
    const ordered = SUGGEST_ORDER.flatMap((r) => parts.filter((p) => p.role === r));
    return {
      parts: ordered,
      verdicts,
      notes,
      detailFetches,
      categoryPages,
      budget: input.budget,
      withinBudget: s.total <= input.budget,
      profile,
      allocation,
      ...s,
    };
  }
}

/** Non-compatibility advice worth surfacing (performance, not fit). */
export function advisoryNotes(parts: BuildPartOut[]): string[] {
  const notes: string[] = [];
  const ram = parts.filter((p) => p.role === "ram");
  const modules = ram.reduce((s, p) => s + (p.specs.memoryModules?.value ?? 0), 0);
  if (ram.length > 0 && modules === 1) notes.push("RAM is a single module — runs single-channel; a 2-module kit is noticeably faster.");
  return notes;
}

function assertSingleRoles(parts: BuildPartOut[]): void {
  const seen = new Map<PcRole, string>();
  for (const p of parts) {
    if (MULTI_ROLES.has(p.role)) continue;
    const prev = seen.get(p.role);
    if (prev) throw new Error(`Two parts have role ${p.role} (${prev}, ${p.code}) — a build takes one; only ram and storage may repeat.`);
    seen.set(p.role, p.code);
  }
}

function ramCategory(b: BuildParts): number {
  const types = b.motherboard?.specs.memoryTypes?.value ?? b.cpu?.specs.memoryTypes?.value ?? ["DDR5"];
  const t = types.includes("DDR5") ? "DDR5" : types.includes("DDR4") ? "DDR4" : "DDR5";
  return RAM_CATEGORY_BY_TYPE[t] ?? PC_CATEGORY_IDS.ram;
}

/**
 * Name-based pre-filter on listing cards — cheap, avoids detail fetches of
 * obviously wrong candidates. It never accepts on its own: the detail fetch
 * + rules decide.
 */
export function prefilter(role: PcRole, card: Product, built: BuildParts, input: Pick<SuggestInput, "cpuVendor" | "psuHeadroom">): boolean {
  const name = card.name;
  switch (role) {
    case "cpu":
      if (input.cpuVendor === "amd" && !/\bAMD\b|Ryzen/i.test(name)) return false;
      if (input.cpuVendor === "intel" && !/\bIntel\b|Core/i.test(name)) return false;
      return true;
    case "motherboard": {
      const want = built.cpu?.specs.socket?.value;
      const hint = socketHintFromBoardName(name);
      return !want || !hint || hint === want;
    }
    case "ram": {
      if (/SO-?DIMM|notebook/i.test(name)) return false;
      const types = built.motherboard?.specs.memoryTypes?.value ?? built.cpu?.specs.memoryTypes?.value;
      return !types || types.some((t) => new RegExp(`\\b${t}\\b`, "i").test(name));
    }
    case "psu": {
      const hint = wattageHintFromName(name);
      if (hint === undefined) return true;
      return hint >= estimatePower(built, input.psuHeadroom).recommendedPsuW;
    }
    default:
      return true;
  }
}
