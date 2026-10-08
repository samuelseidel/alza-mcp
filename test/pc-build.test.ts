import { describe, expect, it } from "vitest";
import {
  allocateBudget,
  checkBuild,
  checkCoolerClearance,
  checkCoolerSocket,
  checkCpuSocket,
  checkDisplayOutput,
  checkGpuLength,
  checkMotherboardFormFactor,
  checkPsuFormFactor,
  checkPsuWattage,
  checkRamCpu,
  checkRamMotherboard,
  detectRole,
  estimatePower,
  normalizeFormFactor,
  normalizeMemoryFormFactor,
  normalizeSocket,
  normalizeSpecs,
  overallVerdict,
  parseCzechNumber,
  parseMemoryTypes,
  parseRadiatorSizes,
  socketHintFromBoardName,
  wattageHintFromName,
  type PcRole,
  type RulePart,
} from "../src/domain/pc-build.js";
import { PcBuilder, inStockFrom, prefilter, type PcCatalog } from "../src/domain/pc-build-service.js";
import type { Product, ProductParam } from "../src/domain/types.js";
import { PC_BUILD_OUTPUT } from "../src/tools/output-schemas.js";
import { formatBuildReport } from "../src/tools/pc-builder.js";

/*
 * Spec rows below are verbatim (trimmed to the relevant rows) from live
 * alza.cz product pages fetched 2026-10-06 — see
 * docs/live-evidence/2026-10-06-pc-builder.md.
 */
const P = (rows: Array<[string, string]>): ProductParam[] => rows.map(([name, value]) => ({ name, value }));

const CPU_AM4 = P([
  ["Řada procesoru", "AMD Ryzen 7"],
  ["Socket", "AMD AM4"],
  ["Počet jader procesoru", "8 ×"],
  ["Podporovaný typ paměti", "DDR4"],
  ["Typ integrované grafické karty", "Bez integrovaného grafického čipu"],
  ["TDP", "105 W"],
]);
const CPU_AM5_IGPU = P([
  ["Řada procesoru", "AMD Ryzen 7"],
  ["Socket", "AMD AM5"],
  ["Počet jader procesoru", "8 ×"],
  ["Podporovaný typ paměti", "DDR5"],
  ["Typ integrované grafické karty", "AMD Radeon Graphics"],
  ["TDP", "120 W"],
]);
const MB_LGA1700_DDR4 = P([
  ["Socket", "Intel 1700"],
  ["Čipset", "Intel B760"],
  ["Formát základní desky", "mATX (Micro ATX)"],
  ["Typ paměti", "DDR4"],
  ["Počet slotů RAM", "4 ×"],
  ["Provedení", "DIMM"],
]);
const MB_AM5_DDR5_ATX = P([
  ["Socket", "AMD AM5"],
  ["Čipset", "AMD B650"],
  ["Formát základní desky", "ATX"],
  ["Typ paměti", "DDR5"],
  ["Počet slotů RAM", "2 ×"],
  ["Provedení", "DIMM"],
]);
const MB_AM4_DDR4 = P([
  ["Socket", "AMD AM4"],
  ["Čipset", "AMD B550"],
  ["Formát základní desky", "ATX"],
  ["Typ paměti", "DDR4"],
  ["Počet slotů RAM", "4 ×"],
]);
const RAM_DDR5_KIT = P([
  ["Určení", "Pro počítač"],
  ["Provedení", "DIMM"],
  ["Typ paměti", "DDR5"],
  ["Moduly v balení", "2 × 16GB"],
  ["Velikost operační paměti RAM", "32 GB"],
  ["Počet modulů v balení", "2 ks"],
  ["Frekvence paměti", "6 000 MHz"],
]);
const RAM_SODIMM_DDR5 = P([
  ["Provedení", "SO-DIMM"],
  ["Typ paměti", "DDR5"],
  ["Počet modulů v balení", "1 ks"],
  ["Frekvence paměti", "5 600 MHz"],
  ["Moduly v balení", "1 × 16GB"],
]);
const GPU_RTX = P([
  ["Výrobce čipu", "NVIDIA GeForce"],
  ["Kapacita VRAM", "16 GB"],
  ["Šířka", "291,9 mm"],
  ["Výška", "41,3 mm"],
  ["Hloubka", "116,5 mm"],
  ["TDP", "180 W"],
]);
const GPU_RADEON_NO_TDP = P([
  ["Výrobce čipu", "AMD Radeon"],
  ["Kapacita VRAM", "16 GB"],
  ["Šířka", "360 mm"],
  ["Výška", "72 mm"],
  ["Hloubka", "155 mm"],
  ["Doporučený výkon zdroje", "800 W"],
]);
const CASE_H5 = P([
  ["Velikost", "Midi Tower"],
  ["Formát základní desky", "ATX,mATX (Micro ATX),mITX (Mini ITX),eATX (Extended ATX)"],
  ["Max. výška chladiče procesoru", "170 mm"],
  ["Max. délka grafické karty", "410 mm"],
  ["Podporovaný formát zdroje", "ATX"],
  ["Podporovaná velikost radiátoru navrchu", "120mm,140mm,240mm,280mm"],
  ["Podporovaná velikost radiátoru zepředu", "120mm,140mm,240mm,280mm,360mm"],
]);
const CASE_SMALL = P([
  ["Formát základní desky", "mATX (Micro ATX),mITX (Mini ITX)"],
  ["Max. výška chladiče procesoru", "150 mm"],
  ["Max. délka grafické karty", "300 mm"],
  ["Podporovaný formát zdroje", "SFX"],
  ["Podporovaná velikost radiátoru navrchu", "120mm,240mm"],
]);
const COOLER_AIR = P([
  ["Chlazení", "Vzduchem"],
  ["AMD Socket", "AM4,AM5"],
  ["Intel Socket", "1150,1151,1155,1200,1700,1851"],
  ["Šířka", "124 mm"],
  ["Výška", "155 mm"],
  ["Hloubka", "114 mm"],
]);
const COOLER_LIQUID_360 = P([
  ["Chlazení", "Vodou"],
  ["AMD Socket", "AM4,AM5"],
  ["Intel Socket", "1150,1151,1155,1156,1200,1700,1851"],
  ["Kompatibilní velikost radiátoru", "360mm"],
  ["Výška pumpy", "65 mm (6,5 cm)"],
]);
const COOLER_OLD = P([
  ["Chlazení", "Vzduchem"],
  ["AMD Socket", "AM4"],
  ["Intel Socket", "1200"],
  ["Výška", "140 mm"],
]);
const PSU_850 = P([
  ["Výkon", "850 W"],
  ["Formát", "ATX"],
  ["Verze ATX", "3.1"],
  ["Certifikace", "80 PLUS Gold"],
]);
const PSU_450 = P([
  ["Výkon", "450 W"],
  ["Formát", "ATX"],
  ["Certifikace", "80 PLUS Bronze"],
]);
const SSD = P([
  ["Kapacita úložiště (celková)", "2 000 GB (2 TB)"],
  ["Typ úložiště", "SSD"],
  ["Rozhraní interní", "M.2 (PCIe 4.0 4x NVMe)"],
]);

const part = (role: PcRole, code: string, rows: ProductParam[]): RulePart => ({ code, specs: normalizeSpecs(role, rows) });

describe("value parsers", () => {
  it("parses Czech numbers with comma decimals and space thousands", () => {
    expect(parseCzechNumber("291,9 mm")).toBe(291.9);
    expect(parseCzechNumber("1 810 g")).toBe(1810);
    expect(parseCzechNumber("2 × 16GB")).toBe(2);
    expect(parseCzechNumber("750 W")).toBe(750);
    expect(parseCzechNumber("300 mm (30 cm)")).toBe(300);
    expect(parseCzechNumber("n/a")).toBeUndefined();
  });

  it("normalises sockets across vendor/LGA spellings", () => {
    expect(normalizeSocket("AMD AM5")).toBe("AM5");
    expect(normalizeSocket("AM4")).toBe("AM4");
    expect(normalizeSocket("Intel 1700")).toBe("LGA1700");
    expect(normalizeSocket("LGA 1851")).toBe("LGA1851");
    expect(normalizeSocket("1700")).toBe("LGA1700");
    expect(normalizeSocket("2011-3")).toBe("LGA2011-3");
    expect(normalizeSocket("AMD TR5")).toBe("TR5");
    expect(normalizeSocket("sTR5")).toBe("TR5");
    expect(normalizeSocket("AM3+")).toBe("AM3+");
  });

  it("parses memory generations, module form factor and board form factor", () => {
    expect(parseMemoryTypes("DDR4/DDR5")).toEqual(["DDR4", "DDR5"]);
    expect(parseMemoryTypes("PC5-48000 DDR5")).toEqual(["DDR5"]);
    expect(normalizeMemoryFormFactor("SO-DIMM")).toBe("SO-DIMM");
    expect(normalizeMemoryFormFactor("DIMM")).toBe("DIMM");
    expect(normalizeMemoryFormFactor("RDIMM")).toBe("RDIMM");
    expect(normalizeFormFactor("mATX (Micro ATX)")).toBe("mATX");
    expect(normalizeFormFactor("mITX (Mini ITX)")).toBe("mITX");
    expect(normalizeFormFactor("eATX (Extended ATX)")).toBe("eATX");
    expect(normalizeFormFactor("Micro-ATX")).toBe("mATX");
    expect(normalizeFormFactor("ATX")).toBe("ATX");
    expect(parseRadiatorSizes("120mm,140mm,240mm,280mm,360mm")).toEqual([120, 140, 240, 280, 360]);
  });
});

describe("normalizeSpecs (Czech spec-name map)", () => {
  it("keeps the Czech source row and raw value for every spec", () => {
    const s = normalizeSpecs("case", CASE_H5);
    expect(s.maxGpuLengthMm).toEqual({ value: 410, source: "Max. délka grafické karty", raw: "410 mm" });
    expect(s.supportedFormFactors?.value).toEqual(["ATX", "mATX", "mITX", "eATX"]);
    expect(s.supportedRadiatorsMm?.value).toEqual([120, 140, 240, 280, 360]);
    expect(s.supportedPsuFormFactors?.value).toEqual(["ATX"]);
  });

  it("takes a GPU's length as its longest dimension row", () => {
    expect(normalizeSpecs("gpu", GPU_RTX).gpuLengthMm).toMatchObject({ value: 291.9, source: "Šířka" });
    const radeon = normalizeSpecs("gpu", GPU_RADEON_NO_TDP);
    expect(radeon.gpuLengthMm?.value).toBe(360);
    expect(radeon.tdpW).toBeUndefined();
    expect(radeon.recommendedPsuW?.value).toBe(800);
  });

  it("separates air cooler height from liquid radiator size and merges socket lists", () => {
    const air = normalizeSpecs("cooler", COOLER_AIR);
    expect(air.coolerType?.value).toBe("air");
    expect(air.coolerHeightMm?.value).toBe(155);
    expect(air.coolerSockets?.value).toEqual(["AM4", "AM5", "LGA1150", "LGA1151", "LGA1155", "LGA1200", "LGA1700", "LGA1851"]);
    const liquid = normalizeSpecs("cooler", COOLER_LIQUID_360);
    expect(liquid.coolerType?.value).toBe("liquid");
    expect(liquid.radiatorMm?.value).toBe(360);
    expect(liquid.coolerHeightMm).toBeUndefined();
  });

  it("reads CPU, board, RAM and PSU rows", () => {
    expect(normalizeSpecs("cpu", CPU_AM4)).toMatchObject({
      socket: { value: "AM4" },
      memoryTypes: { value: ["DDR4"] },
      integratedGpu: { value: false },
      tdpW: { value: 105 },
    });
    expect(normalizeSpecs("motherboard", MB_LGA1700_DDR4)).toMatchObject({
      socket: { value: "LGA1700" },
      formFactor: { value: "mATX" },
      memorySlots: { value: 4 },
      memoryFormFactor: { value: "DIMM" },
    });
    expect(normalizeSpecs("ram", RAM_DDR5_KIT)).toMatchObject({ memoryTypes: { value: ["DDR5"] }, memoryModules: { value: 2 } });
    expect(normalizeSpecs("psu", PSU_850)).toMatchObject({ psuWattage: { value: 850 }, psuFormFactor: { value: "ATX" } });
  });
});

describe("detectRole", () => {
  it("recognises every component type from its spec signature", () => {
    expect(detectRole("AMD Ryzen 7 5800X3D", CPU_AM4)).toBe("cpu");
    expect(detectRole("ASUS PRIME B760M-A WIFI D4", MB_LGA1700_DDR4)).toBe("motherboard");
    expect(detectRole("Patriot Viper Venom 32GB KIT DDR5", RAM_DDR5_KIT)).toBe("ram");
    expect(detectRole("GAINWARD GeForce RTX 5060 Ti", GPU_RTX)).toBe("gpu");
    expect(detectRole("NZXT H5 Flow", CASE_H5)).toBe("case");
    expect(detectRole("Be quiet! PURE ROCK PRO 3", COOLER_AIR)).toBe("cooler");
    expect(detectRole("Corsair RM850x", PSU_850)).toBe("psu");
    expect(detectRole("WD_BLACK SN7100 2 TB", SSD)).toBe("storage");
    expect(detectRole("Something", [])).toBeUndefined();
  });
});

describe("compatibility rules", () => {
  it("cpu_socket_motherboard: pass / fail / unknown / not_applicable", () => {
    expect(checkCpuSocket(part("cpu", "C", CPU_AM5_IGPU), part("motherboard", "M", MB_AM5_DDR5_ATX)).verdict).toBe("pass");
    const fail = checkCpuSocket(part("cpu", "C", CPU_AM4), part("motherboard", "M", MB_LGA1700_DDR4));
    expect(fail.verdict).toBe("fail");
    expect(fail.values.cpuSocket).toMatchObject({ value: "AM4", source: "Socket", raw: "AMD AM4", part: "C" });
    expect(checkCpuSocket(part("cpu", "C", []), part("motherboard", "M", MB_AM5_DDR5_ATX)).verdict).toBe("unknown");
    expect(checkCpuSocket(undefined, part("motherboard", "M", MB_AM5_DDR5_ATX)).verdict).toBe("not_applicable");
  });

  it("ram_motherboard: generation, SO-DIMM and slot count", () => {
    const mb = part("motherboard", "M", MB_AM5_DDR5_ATX);
    expect(checkRamMotherboard([part("ram", "R", RAM_DDR5_KIT)], mb).verdict).toBe("pass");
    expect(checkRamMotherboard([part("ram", "R", RAM_DDR5_KIT)], part("motherboard", "M", MB_LGA1700_DDR4)).verdict).toBe("fail");
    const sodimm = checkRamMotherboard([part("ram", "R", RAM_SODIMM_DDR5)], mb);
    expect(sodimm.verdict).toBe("fail");
    expect(sodimm.detail).toMatch(/SO-DIMM/);
    const tooMany = checkRamMotherboard([part("ram", "R1", RAM_DDR5_KIT), part("ram", "R2", RAM_DDR5_KIT)], mb);
    expect(tooMany.verdict).toBe("fail");
    expect(tooMany.detail).toMatch(/4 modules but only 2 slots/);
    expect(checkRamMotherboard([part("ram", "R", [])], mb).verdict).toBe("unknown");
  });

  it("ram_cpu: memory controller generation", () => {
    expect(checkRamCpu([part("ram", "R", RAM_DDR5_KIT)], part("cpu", "C", CPU_AM5_IGPU)).verdict).toBe("pass");
    expect(checkRamCpu([part("ram", "R", RAM_DDR5_KIT)], part("cpu", "C", CPU_AM4)).verdict).toBe("fail");
    const dual = part("cpu", "C", P([["Podporovaný typ paměti", "DDR4/DDR5"]]));
    expect(checkRamCpu([part("ram", "R", RAM_DDR5_KIT)], dual).verdict).toBe("pass");
  });

  it("psu_wattage: draw estimate, headroom and the GPU vendor's recommendation", () => {
    const cpu = part("cpu", "C", CPU_AM5_IGPU); // 120 W TDP → 162 W
    const gpu = part("gpu", "G", GPU_RTX); // 180 W
    const est = estimatePower({ cpu, gpu });
    expect(est).toMatchObject({ cpuW: 162, gpuW: 180, platformW: 75, totalW: 417, recommendedPsuW: 550 });
    expect(checkPsuWattage({ cpu, gpu, psu: part("psu", "P", PSU_850) }).verdict).toBe("pass");
    expect(checkPsuWattage({ cpu, gpu, psu: part("psu", "P", PSU_450) }).verdict).toBe("warn"); // 450 ≥ 417 but < 550
    const radeon = part("gpu", "G", GPU_RADEON_NO_TDP);
    const radeonEst = estimatePower({ cpu, gpu: radeon });
    expect(radeonEst.gpuW).toBe(320);
    expect(radeonEst.recommendedPsuW).toBe(800); // vendor recommendation wins
    expect(checkPsuWattage({ cpu, gpu: radeon, psu: part("psu", "P", PSU_450) }).verdict).toBe("fail"); // 450 < 557
    expect(checkPsuWattage({ cpu, gpu: radeon, psu: part("psu", "P", PSU_850) }).verdict).toBe("pass"); // derived from a listed spec
    const blind = checkPsuWattage({ cpu, gpu: part("gpu", "G", []), psu: part("psu", "P", PSU_850) });
    expect(blind.verdict).toBe("warn"); // no GPU power spec at all → assumed 250 W, can't vouch for a pass
    expect(blind.detail).toMatch(/assumed 250 W/);
    expect(checkPsuWattage({ cpu, gpu, psu: part("psu", "P", []) }).verdict).toBe("unknown");
    expect(checkPsuWattage({ psu: part("psu", "P", PSU_850) }).verdict).toBe("not_applicable");
  });

  it("gpu_length_case", () => {
    expect(checkGpuLength(part("gpu", "G", GPU_RTX), part("case", "K", CASE_H5)).verdict).toBe("pass");
    const fail = checkGpuLength(part("gpu", "G", GPU_RADEON_NO_TDP), part("case", "K", CASE_SMALL));
    expect(fail.verdict).toBe("fail");
    expect(fail.values).toMatchObject({ gpuLengthMm: { value: 360 }, caseMaxGpuLengthMm: { value: 300, source: "Max. délka grafické karty" } });
    const tight = part("case", "K", P([["Max. délka grafické karty", "295 mm"]]));
    expect(checkGpuLength(part("gpu", "G", GPU_RTX), tight).verdict).toBe("warn");
    expect(checkGpuLength(part("gpu", "G", []), part("case", "K", CASE_H5)).verdict).toBe("unknown");
  });

  it("cooler_clearance_case: air height and liquid radiator size", () => {
    expect(checkCoolerClearance(part("cooler", "A", COOLER_AIR), part("case", "K", CASE_H5)).verdict).toBe("pass");
    expect(checkCoolerClearance(part("cooler", "A", COOLER_AIR), part("case", "K", CASE_SMALL)).verdict).toBe("fail");
    expect(checkCoolerClearance(part("cooler", "L", COOLER_LIQUID_360), part("case", "K", CASE_H5)).verdict).toBe("pass");
    expect(checkCoolerClearance(part("cooler", "L", COOLER_LIQUID_360), part("case", "K", CASE_SMALL)).verdict).toBe("fail");
    expect(checkCoolerClearance(part("cooler", "A", COOLER_AIR), part("case", "K", [])).verdict).toBe("unknown");
  });

  it("cooler_socket", () => {
    expect(checkCoolerSocket(part("cooler", "A", COOLER_AIR), part("cpu", "C", CPU_AM5_IGPU)).verdict).toBe("pass");
    expect(checkCoolerSocket(part("cooler", "O", COOLER_OLD), part("cpu", "C", CPU_AM5_IGPU)).verdict).toBe("fail");
  });

  it("motherboard_form_factor_case", () => {
    expect(checkMotherboardFormFactor(part("motherboard", "M", MB_AM5_DDR5_ATX), part("case", "K", CASE_H5)).verdict).toBe("pass");
    const fail = checkMotherboardFormFactor(part("motherboard", "M", MB_AM5_DDR5_ATX), part("case", "K", CASE_SMALL));
    expect(fail.verdict).toBe("fail");
    expect(fail.detail).toMatch(/ATX board is not supported/);
    expect(checkMotherboardFormFactor(part("motherboard", "M", MB_LGA1700_DDR4), part("case", "K", CASE_SMALL)).verdict).toBe("pass");
  });

  it("psu_form_factor_case", () => {
    expect(checkPsuFormFactor(part("psu", "P", PSU_850), part("case", "K", CASE_H5)).verdict).toBe("pass");
    expect(checkPsuFormFactor(part("psu", "P", PSU_850), part("case", "K", CASE_SMALL)).verdict).toBe("fail");
    const sfx = part("psu", "S", P([["Výkon", "750 W"], ["Formát", "SFX"]]));
    expect(checkPsuFormFactor(sfx, part("case", "K", CASE_H5)).verdict).toBe("warn");
  });

  it("display_output", () => {
    expect(checkDisplayOutput(part("cpu", "C", CPU_AM4), part("gpu", "G", GPU_RTX)).verdict).toBe("pass");
    expect(checkDisplayOutput(part("cpu", "C", CPU_AM5_IGPU), undefined).verdict).toBe("pass");
    expect(checkDisplayOutput(part("cpu", "C", CPU_AM4), undefined).verdict).toBe("fail");
  });

  it("checkBuild runs all 10 rules and overallVerdict aggregates", () => {
    const good = checkBuild({
      cpu: part("cpu", "C", CPU_AM5_IGPU),
      motherboard: part("motherboard", "M", MB_AM5_DDR5_ATX),
      ram: [part("ram", "R", RAM_DDR5_KIT)],
      gpu: part("gpu", "G", GPU_RTX),
      case: part("case", "K", CASE_H5),
      cooler: part("cooler", "A", COOLER_AIR),
      psu: part("psu", "P", PSU_850),
    });
    expect(good).toHaveLength(10);
    expect(good.every((v) => v.verdict === "pass")).toBe(true);
    expect(overallVerdict(good)).toBe("compatible");
    const bad = checkBuild({ cpu: part("cpu", "C", CPU_AM4), motherboard: part("motherboard", "M", MB_AM5_DDR5_ATX) });
    expect(overallVerdict(bad)).toBe("incompatible");
  });
});

describe("suggest helpers", () => {
  it("maps chipset names to sockets and PSU names to wattage", () => {
    expect(socketHintFromBoardName("GIGABYTE B650 EAGLE AX")).toBe("AM5");
    expect(socketHintFromBoardName("ASUS TUF GAMING B550-PLUS")).toBe("AM4");
    expect(socketHintFromBoardName("ASUS PRIME B760M-A WIFI D4")).toBe("LGA1700");
    expect(socketHintFromBoardName("ASUS TUF GAMING B860M-PLUS WIFI")).toBe("LGA1851");
    expect(socketHintFromBoardName("Unknown board")).toBeUndefined();
    expect(wattageHintFromName("Be quiet! PURE POWER 13 M 1000W")).toBe(1000);
    expect(wattageHintFromName("Corsair RM850x ATX 3.1")).toBeUndefined();
  });

  it("allocates the budget by profile after fixed spend", () => {
    const a = allocateBudget(40000, "gaming", ["cpu", "motherboard", "ram", "gpu", "storage", "case", "cooler", "psu"]);
    expect(a.gpu).toBe(15200);
    expect(Object.values(a).reduce((s, n) => s + (n ?? 0), 0)).toBeLessThanOrEqual(40000);
    const office = allocateBudget(20000, "office", ["cpu", "motherboard", "ram", "storage", "case", "psu"], 5000);
    expect(office.gpu).toBeUndefined();
    expect(Object.values(office).reduce((s, n) => s + (n ?? 0), 0)).toBeLessThanOrEqual(15000);
  });

  it("pre-filters listing cards by name before spending a detail fetch", () => {
    const card = (name: string): Product => ({ code: "X", id: 0, name, url: "u", currency: "CZK", price: 1 });
    const built = { cpu: part("cpu", "C", CPU_AM5_IGPU) };
    expect(prefilter("motherboard", card("ASUS TUF GAMING B550-PLUS"), built, {})).toBe(false);
    expect(prefilter("motherboard", card("GIGABYTE B650 EAGLE AX"), built, {})).toBe(true);
    expect(prefilter("ram", card("Kingston SO-DIMM 16GB DDR5"), built, {})).toBe(false);
    expect(prefilter("cpu", card("Intel Core i5-14400F"), {}, { cpuVendor: "amd" })).toBe(false);
    expect(prefilter("psu", card("Seasonic 400W"), { cpu: part("cpu", "C", CPU_AM5_IGPU), gpu: part("gpu", "G", GPU_RTX) }, {})).toBe(false);
  });

  it("derives stock from schema.org or card availability", () => {
    expect(inStockFrom("InStock")).toBe(true);
    expect(inStockFrom("in stock")).toBe(true);
    expect(inStockFrom("not purchasable now")).toBe(false);
    expect(inStockFrom("OutOfStock")).toBe(false);
    expect(inStockFrom("Skladem > 5 ks")).toBe(true);
    expect(inStockFrom("Na objednávku – termín upřesníme")).toBe(false);
    expect(inStockFrom("Není skladem")).toBe(false);
    expect(inStockFrom(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Service behaviour with a fake catalog (no network)
// ---------------------------------------------------------------------------

function product(code: string, name: string, price: number, params: ProductParam[]): Product {
  return { code, id: 0, name, url: `https://www.alza.cz/${code}`, price, currency: "CZK", availability: "InStock", params };
}

const PRODUCTS: Record<string, Product> = {
  CPU1: product("CPU1", "AMD Ryzen 7 7700", 6000, CPU_AM5_IGPU),
  CPU2: product("CPU2", "AMD Ryzen 7 5800X3D", 9000, CPU_AM4),
  MB_AM4: product("MB_AM4", "ASUS TUF GAMING B550-PLUS", 2700, MB_AM4_DDR4),
  CASE_SMALL: product("CASE_SMALL", "Tiny mATX case", 1950, CASE_SMALL),
  MB1: product("MB1", "GIGABYTE B650 EAGLE AX", 3200, MB_AM5_DDR5_ATX),
  RAM1: product("RAM1", "Patriot Viper Venom 32GB KIT DDR5", 3000, RAM_DDR5_KIT),
  GPU1: product("GPU1", "GAINWARD GeForce RTX 5060 Ti", 12000, GPU_RTX),
  SSD1: product("SSD1", "WD_BLACK SN7100 1 TB", 2000, SSD),
  CASE1: product("CASE1", "NZXT H5 Flow", 1900, CASE_H5),
  COOL1: product("COOL1", "Be quiet! PURE ROCK PRO 3", 1100, COOLER_AIR),
  PSU1: product("PSU1", "Corsair RM850x", 3000, PSU_850),
  PSU450: product("PSU450", "Cheap PSU 450W", 900, PSU_450),
};

const LISTINGS: Record<number, string[]> = {
  18842843: ["CPU2", "CPU1"],
  18842832: ["MB_AM4", "MB1"],
  18893268: ["RAM1"],
  18842862: ["GPU1"],
  18845887: ["SSD1"],
  18849057: ["CASE1", "CASE_SMALL"],
  18842846: ["COOL1"],
  18849164: ["PSU450", "PSU1"],
};

function fakeCatalog() {
  const calls = { details: [] as string[], listings: [] as number[], facets: [] as number[] };
  const catalog: PcCatalog = {
    async getProductSpecs(code: string) {
      calls.details.push(code);
      const p = PRODUCTS[code];
      if (!p) throw new Error(`no ${code}`);
      return p;
    },
    async searchProducts(opts) {
      calls.listings.push(opts.categoryId!);
      const products = (LISTINGS[opts.categoryId!] ?? []).map((c) => ({ ...PRODUCTS[c]!, params: undefined, availability: "in stock" }));
      return { query: "", total: products.length, page: 1, pageSize: 24, products };
    },
    async getCategoryFilters(categoryId: number) {
      calls.facets.push(categoryId);
      return { categoryId, brands: [{ valueId: 7, description: "AMD" }], groups: [] };
    },
  };
  return { catalog, calls };
}

describe("PcBuilder.check", () => {
  it("detects roles, prices the build and reports per-rule verdicts with values", async () => {
    const { catalog, calls } = fakeCatalog();
    const r = await new PcBuilder(catalog).check({
      parts: ["CPU1", "MB1", "RAM1", "GPU1", "SSD1", "CASE1", "COOL1", "PSU1"].map((code) => ({ code })),
    });
    expect(calls.details).toHaveLength(8);
    expect(r.parts.map((p) => p.role)).toEqual(["cpu", "motherboard", "ram", "gpu", "storage", "case", "cooler", "psu"]);
    expect(r.total).toBe(6000 + 3200 + 3000 + 12000 + 2000 + 1900 + 1100 + 3000);
    expect(r.overall).toBe("compatible");
    expect(r.parts.every((p) => p.inStock === true)).toBe(true);
    expect(r.verdicts.find((v) => v.rule === "gpu_length_case")?.values.caseMaxGpuLengthMm).toMatchObject({ value: 410, part: "CASE1" });
  });

  it("flags a socket mismatch as incompatible", async () => {
    const { catalog } = fakeCatalog();
    const r = await new PcBuilder(catalog).check({ parts: [{ code: "CPU2" }, { code: "MB1" }] });
    expect(r.overall).toBe("incompatible");
    expect(r.verdicts.find((v) => v.rule === "cpu_socket_motherboard")?.verdict).toBe("fail");
    expect(r.notes.join(" ")).toMatch(/Not a complete build/);
  });

  it("notes a single-module RAM configuration", async () => {
    const { catalog } = fakeCatalog();
    PRODUCTS.RAM_ONE = product("RAM_ONE", "Kingston 16GB DDR5", 1500, RAM_SODIMM_DDR5.map((r) => (r.name === "Provedení" ? { ...r, value: "DIMM" } : r)));
    const r = await new PcBuilder(catalog).check({ parts: [{ code: "MB1" }, { code: "RAM_ONE", role: "ram" }] });
    expect(r.notes.join(" ")).toMatch(/single module/);
    expect(r.verdicts.find((v) => v.rule === "ram_motherboard")?.verdict).toBe("pass");
  });

  it("rejects duplicate single-role parts and repeated codes", async () => {
    const { catalog } = fakeCatalog();
    await expect(new PcBuilder(catalog).check({ parts: [{ code: "CPU1" }, { code: "CPU2" }] })).rejects.toThrow(/Two parts have role cpu/);
    await expect(new PcBuilder(catalog).check({ parts: [{ code: "CPU1" }, { code: "CPU1" }] })).rejects.toThrow(/listed twice/);
  });
});

describe("PcBuilder.suggest", () => {
  it("picks a compatible build in dependency order, skipping incompatible candidates", async () => {
    const { catalog, calls } = fakeCatalog();
    const r = await new PcBuilder(catalog).suggest({ budget: 40000, cpuVendor: "amd" });
    const byRole = Object.fromEntries(r.parts.map((p) => [p.role, p.code]));
    // CPU2 (9000) is over the 8000 CPU allocation → CPU1 (AM5, DDR5) is picked.
    expect(byRole).toEqual({
      cpu: "CPU1",
      motherboard: "MB1", // the B550 card is name-pre-filtered (AM4 chipset) without a detail fetch
      ram: "RAM1", // DDR5 category chosen from the board's memory type
      gpu: "GPU1",
      storage: "SSD1",
      case: "CASE1", // CASE_SMALL (closer to the allocation) fails the ATX form-factor rule
      cooler: "COOL1",
      psu: "PSU1", // the 450 W card is name-pre-filtered (below the recommended wattage)
    });
    expect(r.overall).toBe("compatible");
    expect(r.notes.join(" ")).toMatch(/case: skipped CASE_SMALL \(motherboard_form_factor_case failed\)/);
    expect(calls.details).not.toContain("MB_AM4");
    expect(calls.details).not.toContain("PSU450");
    expect(calls.listings).toContain(18893268);
    expect(calls.facets).toEqual([18842843]); // cpu_vendor used the real brand facet
    expect(r.detailFetches).toBeLessThanOrEqual(14);
    expect(r.parts.find((p) => p.role === "storage")?.specsFetched).toBe(false);
    expect(r.budget).toBe(40000);
    expect(r.categoryPages).toBe(9); // 8 listings + 1 brand facet page
  });

  it("respects fixed parts and the detail-fetch budget", async () => {
    const { catalog } = fakeCatalog();
    const r = await new PcBuilder(catalog).suggest({ budget: 40000, fixedParts: [{ code: "CPU1" }], maxDetailFetches: 2 });
    expect(r.parts.find((p) => p.role === "cpu")).toMatchObject({ code: "CPU1", origin: "fixed" });
    expect(r.detailFetches).toBe(2);
    expect(r.notes.join(" ")).toMatch(/detail-fetch budget \(2\) exhausted/);
    expect(r.parts.filter((p) => !p.specsFetched).length).toBeGreaterThan(0);
  });

  it("prefers a clean pass over a warn-only candidate (PSU headroom)", async () => {
    const { catalog, calls } = fakeCatalog();
    PRODUCTS.PSU500 = product("PSU500", "Bigger-looking PSU", 3500, P([["Výkon", "500 W"], ["Formát", "ATX"], ["Certifikace", "80 PLUS Gold"]]));
    const saved = LISTINGS[18849164];
    LISTINGS[18849164] = ["PSU500", "PSU1"];
    try {
      const r = await new PcBuilder(catalog).suggest({
        budget: 30000,
        fixedParts: [{ code: "CPU1" }, { code: "GPU1" }],
        skipRoles: ["motherboard", "ram", "storage", "case", "cooler"],
      });
      // 500 W covers the 417 W draw but not the 550 W recommendation → warn → keep looking.
      expect(calls.details).toContain("PSU500");
      expect(r.parts.find((p) => p.role === "psu")?.code).toBe("PSU1");
      expect(r.verdicts.find((v) => v.rule === "psu_wattage")?.verdict).toBe("pass");
      expect(r.notes.join(" ")).toMatch(/PSU500 only got psu_wattage=warn/);
    } finally {
      LISTINGS[18849164] = saved!;
    }
  });

  it("skips a candidate whose product page fails instead of aborting the run", async () => {
    const { catalog } = fakeCatalog();
    const saved = LISTINGS[18849164];
    // Listing card exists but its detail page throws (fakeCatalog: unknown code).
    PRODUCTS.PSU_GONE = product("PSU_GONE", "Delisted PSU 1000W", 3100, PSU_850);
    LISTINGS[18849164] = ["PSU_GONE", "PSU1"];
    const orig = catalog.getProductSpecs;
    catalog.getProductSpecs = async (code: string) => {
      if (code === "PSU_GONE") throw new Error("product page timeout");
      return orig(code);
    };
    try {
      const r = await new PcBuilder(catalog).suggest({
        budget: 30000,
        fixedParts: [{ code: "CPU1" }, { code: "GPU1" }],
        skipRoles: ["motherboard", "ram", "storage", "case", "cooler"],
      });
      expect(r.parts.find((p) => p.role === "psu")?.code).toBe("PSU1");
      expect(r.notes.join(" ")).toMatch(/psu: skipped PSU_GONE \(product page failed: product page timeout\)/);
    } finally {
      LISTINGS[18849164] = saved!;
      delete PRODUCTS.PSU_GONE;
    }
  });

  it("office profile leaves out the GPU", async () => {
    const { catalog } = fakeCatalog();
    const r = await new PcBuilder(catalog).suggest({ budget: 20000, profile: "office" });
    expect(r.parts.some((p) => p.role === "gpu")).toBe(false);
    expect(r.verdicts.find((v) => v.rule === "display_output")?.verdict).toBe("pass");
  });
});

describe("pc_build_* tool output", () => {
  it("a check report satisfies the published output schema and formats as Markdown", async () => {
    const { catalog } = fakeCatalog();
    const r = await new PcBuilder(catalog).check({ parts: [{ code: "CPU2" }, { code: "MB1" }, { code: "PSU1" }] });
    const parsed = PC_BUILD_OUTPUT.safeParse(JSON.parse(JSON.stringify(r)));
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    const text = formatBuildReport(r, "PC build check");
    expect(text).toMatch(/\*\*Overall: incompatible\*\*/);
    expect(text).toMatch(/\*\*FAIL\*\* CPU socket/);
    expect(text).toMatch(/\| cpu \| \[AMD Ryzen 7 5800X3D\]/);
  });
});
