import { describe, expect, it } from "vitest";
import { assetCategorySpecs } from "../src/utils/assetCategorySpecs.js";
import {
  buildSalvageVehicleDetails, canonicalSalvageVehiclePhotoFactField, getSalvageVehicleCatalogue,
  getSalvageVehicleFieldSchema, getSalvageVehiclePhotoFactFields, isSalvageVehiclePhotoFactField,
  normalizeSalvageVehicleOverrides, salvageVehiclePhotoFactFields, salvageVehiclePhotoPrompt,
  validateSalvageVehicleOverrides, type SalvageVehicleDetails,
} from "../src/service/salvageVehicleDetails.js";

const VIN = "1FTFW1ET1EFA12345";
const photo = (photoId: string, field: string, value: unknown, evidence = `Readable label: ${value}`, extra: Record<string, unknown> = {}) => ({
  photoId, status: "analyzed", observations: [], uncertainties: [], facts: [{ field, value, evidence, source: "observed", ...extra }],
});
const field = (details: SalvageVehicleDetails, key: string) => details.fields.find(item => item.key === key)!;
const build = (photoFindings: unknown[] = [], extra: Record<string, unknown> = {}) => buildSalvageVehicleDetails({
  photoFindings, photoIds: ["photo-001", "photo-002", "photo-003", "photo-050"], ...extra,
});

describe("Salvage vehicle catalogue metadata", () => {
  it("takes category questions and their definitions only from the generated workbook catalogue", () => {
    const rows = getSalvageVehicleCatalogue();
    expect(rows.length).toBeGreaterThan(20);
    expect(new Set(rows.map(row => row.parentCategory))).toEqual(new Set(["Vehicles", "Vocational Trucks", "Trailers"]));
    for (const row of rows) {
      const generated = assetCategorySpecs.find(item => item.childCategory === row.childCategory)!;
      expect(row.fields.map(item => item.label)).toEqual(generated.fields);
      row.fields.forEach((item, index) => {
        expect(item).toMatchObject({ key: `spec:${generated.fieldDefinitions[index].name}`, type: generated.fieldDefinitions[index].type,
          options: generated.fieldDefinitions[index].options, required: generated.fieldDefinitions[index].required, source: "workbook" });
        expect(item).not.toHaveProperty("value");
        expect(item).not.toHaveProperty("default");
      });
    }
  });

  it("does not mutate shared generated arrays when a client customizes returned metadata", () => {
    const first = getSalvageVehicleCatalogue();
    const selected = first.find(row => row.childCategory === "Salvage Vehicles")!;
    selected.fields[0].options.push("FAKE DEFAULT");
    selected.fields[0].label = "Changed";
    expect(getSalvageVehicleCatalogue()).not.toEqual(first);
    expect(assetCategorySpecs.find(row => row.childCategory === "Salvage Vehicles")!.fields[0]).toBe("Ownership Type");
  });

  it("always exposes identity, separate VIN/serial and engine fields with no default category or inferred value", () => {
    const result = build();
    expect(result.category).toBeNull();
    for (const key of ["year", "make", "model", "trim", "vin", "serialNumber", "powertrain", "engineMake", "engineModel", "engineDisplacement", "engineCylinders", "fuelType", "transmission", "driveType", "bodyType"]) {
      expect(field(result, key)).toMatchObject({ value: null, status: "unknown", evidence: [], manualOverride: null });
    }
    expect(getSalvageVehicleFieldSchema("Apartment")).toEqual(getSalvageVehicleFieldSchema());
  });

  it("deduplicates standard aliases while preserving selected workbook definitions and unknown checkbox values", () => {
    const result = build([photo("photo-001", "category", "Salvage Vehicles", "Photographed body and damaged vehicle category: Salvage Vehicles")]);
    expect(result.category).toBe("Salvage Vehicles");
    expect(field(result, "transmission")).toMatchObject({ label: "Transmission Type", options: ["Automatic", "Manual", "CVT"], source: "workbook", value: null });
    expect(result.fields.filter(item => item.key === "serialNumber")).toHaveLength(1);
    expect(result.fields.some(item => item.key === "spec:Serial Number")).toBe(false);
    expect(field(result, "spec:Turbocharged").value).toBeNull();
    expect(result.fields.filter(item => item.type === "checkbox").every(item => item.value === null)).toBe(true);
  });

  it("bounds the base photo fields but supports heavy/trailer labels from the first photo", () => {
    expect(salvageVehiclePhotoFactFields.length).toBeLessThan(300);
    expect(isSalvageVehiclePhotoFactField("spec:Tank Capacity (Gallons)")).toBe(true);
    expect(salvageVehiclePhotoPrompt).toContain("spec:Tank Capacity (Gallons)");
    expect(getSalvageVehiclePhotoFactFields("Tank Trailers")).toContain("spec:Tank Capacity (Gallons)");
    const result = build([photo("photo-001", "spec:Tank Capacity (Gallons)", "500", "Tank rating label: capacity 500 gallons")]);
    expect(field(result, "spec:Tank Capacity (Gallons)")).toMatchObject({ value: "500", status: "observed" });
    expect(result.category).toBeNull();
    expect(result.warnings.join(" ")).toContain("outside the selected category");
  });
});

describe("Salvage direct photo evidence", () => {
  it("populates core fields from exact worksheet aliases without duplicated engine controls", () => {
    const result = build([photo("photo-001", "spec:Engine Model", "EcoTec3"), photo("photo-002", "Engine Manufacturer", "GM"), photo("photo-003", "spec:Engine Displacement", "5.3 L")]);
    expect(field(result, "engineMake").value).toBe("GM");
    expect(field(result, "engineModel").value).toBe("EcoTec3");
    expect(field(result, "engineDisplacement").value).toBe("5.3 L");
    expect(result.fields.some(item => item.key === "spec:Engine Model")).toBe(false);
    expect(canonicalSalvageVehiclePhotoFactField("spec:Serial Number")).toBe("serialNumber");
    expect(canonicalSalvageVehiclePhotoFactField("spec:Engine")).toBe("spec:Engine");
  });

  it("accepts the final uploaded photo with readable VIN and never turns a serial number into VIN", () => {
    const result = build([photo("photo-001", "Serial Number", VIN), photo("photo-050", "vin", VIN, `VIN plate reads ${VIN}`)]);
    expect(field(result, "vin")).toMatchObject({ value: VIN, status: "observed" });
    expect(field(result, "vin").evidence[0].photoId).toBe("photo-050");
    expect(field(build([photo("photo-001", "Serial Number", VIN)]), "vin").value).toBeNull();
    expect(field(result, "serialNumber").value).toBe(VIN);
  });

  it.each(["photo-000", "photo-004", "photo-051", "photo-1", "https://assetinsight.pro/photo-001", "../../photo-001"])("rejects nonexistent or malformed evidence photo ID %s", id => {
    const result = build([photo(id, "make", "Ford")]);
    expect(field(result, "make").value).toBeNull();
    expect(field(result, "make").evidence).toEqual([]);
    expect(result.warnings).toContain("Out-of-scope photo evidence was ignored.");
  });

  it("excludes failed photo batches and supplied/model-source claims from observed facts", () => {
    const result = build([{ ...photo("photo-001", "make", "Ford"), status: "not_analyzed" }, photo("photo-002", "make", "Ford", "Ford badge", { source: "supplied" })]);
    expect(field(result, "make").value).toBeNull();
    expect(field(result, "make").evidence[0]).toMatchObject({ accepted: false, rejectionReason: "Not an observed photo fact." });
  });

  it.each([
    ["vin", VIN, "VIN is probably 1FTFW1ET1EFA12345"],
    ["vin", "1FTFW1ET1EFA12?45", "VIN plate reads 1FTFW1ET1EFA12?45"],
    ["vin", "1FTFW1ET1EFAI2345", "VIN plate reads 1FTFW1ET1EFAI2345"],
    ["vin", VIN, "Engine serial number 1FTFW1ET1EFA12345"],
    ["engineModel", "V8", "VIN decoding gives V8"],
    ["engineMake", "Ford", "Based on the make this is a Ford engine"],
    ["engineDisplacement", "5.0 L", "The standard engine is 5.0 L"],
    ["engineDisplacement", "5.0 L", "Visible engine label says 50 L"],
    ["year", "2020", "Label reads 20200"],
    ["engineCylinders", "4", "Plate reads 14 cylinders"],
    ["make", "Ford", "A badge is visible"],
    ["make", "Ford", "The Fordham label is readable"],
    ["spec:Engine/HP", "300", "Large engine visible"],
  ])("does not invent a supported %s reading from %s / %s", (key, value, evidence) => {
    const result = build([photo("photo-001", key, value, evidence)]);
    const target = field(result, canonicalSalvageVehiclePhotoFactField(key)!);
    expect(target.value).toBeNull();
    expect(target.status).toBe("unknown");
    expect(target.evidence[0]).toMatchObject({ rawValue: value, accepted: false });
  });

  it("retains numeric zero only when visibly stated and distinguishes decimal evidence", () => {
    expect(field(build([photo("photo-001", "odometer", "0", "Odometer reads 0 km")]), "odometer").value).toBe("0");
    expect(field(build([photo("photo-001", "odometer", "125,000", "Odometer reads 125,000 km")]), "odometer").value).toBe("125000");
    const result = build([photo("photo-001", "engineDisplacement", "5.0 L"), photo("photo-002", "engineDisplacement", "50 L")]);
    expect(field(result, "engineDisplacement").status).toBe("conflict");
    expect(field(result, "engineDisplacement").value).toBeNull();
  });

  it("records a readable odometer display without claiming its true mileage is verified", () => {
    const result = build([photo("photo-001", "spec:Odometer (Showing Unverified)", "120,000", "Odometer (Showing Unverified): 120,000 km")]);
    expect(field(result, "odometer")).toMatchObject({ value: "120000", status: "observed" });
    expect(field(result, "odometer").evidence[0].evidence).toContain("Showing Unverified");
  });

  it("does not let a field-specific uncertain note suppress unrelated readable identity", () => {
    const result = build([{ ...photo("photo-001", "vin", VIN), uncertainties: ["VIN unreadable in glare"],
      facts: [...photo("photo-001", "vin", VIN).facts, ...photo("photo-001", "make", "Ford").facts] }]);
    expect(field(result, "vin").value).toBeNull();
    expect(field(result, "make").value).toBe("Ford");
  });

  it.each([
    ["spec:Running Condition", "Starts And Runs", "Starts And Runs"],
    ["spec:Sold Under Garage Keepers Act", "Yes", "Sold Under Garage Keepers Act notice"],
    ["spec:Has Key", "No", "Keys not visible in the photo"],
    ["spec:Battery Type", "Good battery health", "Good battery health indicated"],
  ])("does not certify non-photo facts or absence for %s", (key, value, evidence) => {
    const result = build([photo("photo-001", key, value, evidence)]);
    expect(field(result, canonicalSalvageVehiclePhotoFactField(key)!).value).toBeNull();
    expect(field(result, canonicalSalvageVehiclePhotoFactField(key)!).evidence[0].accepted).toBe(false);
  });

  it("deduplicates replayed evidence but retains separate contradictory readings", () => {
    const first = photo("photo-001", "make", "Ford");
    const result = build([first, first, photo("photo-002", "make", "Chevrolet")]);
    expect(field(result, "make")).toMatchObject({ value: null, status: "conflict" });
    expect(field(result, "make").evidence).toHaveLength(2);
    expect(result.warnings.join(" ")).toContain("conflicts");
  });
});

describe("Salvage manual corrections", () => {
  it("retains photo evidence when the owner corrects a value, without manufacturing source evidence", () => {
    const findings = [photo("photo-001", "make", "Ford")];
    const before = JSON.stringify(findings);
    const result = build(findings, { overrides: { make: "Chevrolet" } });
    expect(field(result, "make")).toMatchObject({ value: "Chevrolet", status: "manual", manualOverride: { value: "Chevrolet", source: "manual" } });
    expect(field(result, "make").evidence[0]).toMatchObject({ value: "Ford", accepted: true });
    expect(result.warnings.join(" ")).toContain("conflicts");
    expect(JSON.stringify(findings)).toBe(before);
  });

  it("supports explicit null corrections and missing-value reset without falling back to observations", () => {
    const result = build([photo("photo-001", "vin", VIN)], { overrides: { vin: null }, legacySupplied: { vin: VIN } });
    expect(field(result, "vin")).toMatchObject({ value: null, status: "manual", manualOverride: { value: null, source: "manual" } });
    expect(field(result, "vin").evidence[0].value).toBe(VIN);
  });

  it("preserves owner-supplied legacy facts while allowing new explicit corrections to win", () => {
    const result = build([photo("photo-001", "year", "2018")], { legacySupplied: { year: 2019, make: "Ford", model: null }, overrides: { year: "2020" } });
    expect(field(result, "year")).toMatchObject({ value: "2020", status: "manual", manualOverride: { source: "manual" } });
    expect(field(result, "make")).toMatchObject({ value: "Ford", status: "manual", manualOverride: { source: "supplied" } });
    expect(field(result, "model")).toMatchObject({ value: null, status: "unknown", manualOverride: null });
  });

  it("keeps explicit category corrections and does not discard earlier schema evidence", () => {
    const result = build([photo("photo-001", "category", "Cars", "Car body photographed: Cars"), photo("photo-002", "spec:Tank Capacity (Gallons)", "500")], { overrides: { category: "Tank Trailers" } });
    expect(result.category).toBe("Tank Trailers");
    expect(field(result, "category").evidence[0].value).toBe("Cars");
    expect(field(result, "spec:Tank Capacity (Gallons)").value).toBe("500");
    expect(new Set(result.fields.map(item => item.key)).size).toBe(result.fields.length);
  });

  it("validates strings/null only, bounded values, canonical aliases and no arbitrary/prototype fields", () => {
    expect(normalizeSalvageVehicleOverrides({ engineManufacturer: "GM", "spec:Engine Model": "EcoTec3", odometer: "0", vin: null })).toEqual({ engineMake: "GM", engineModel: "EcoTec3", odometer: "0", vin: null });
    expect(validateSalvageVehicleOverrides({ engineModel: "EcoTec3", "spec:Has Key": "No", year: null })).toEqual({ valid: true, errors: [] });
    for (const overrides of [null, [], { make: {} }, { odometer: 0 }, { odometer: "-1" }, { year: "2200" }, { vin: "123" }, { category: "Apartment" }, { make: "x".repeat(1201) }, { engineMake: "Ford", engineManufacturer: "GM" }, JSON.parse('{"__proto__":"pollute"}'), { OPENAI_API_KEY: "untrusted" }]) {
      expect(validateSalvageVehicleOverrides(overrides).valid).toBe(false);
    }
    expect(normalizeSalvageVehicleOverrides(JSON.parse('{"__proto__":"pollute","constructor":"bad","make":"Ford"}'))).toEqual({ make: "Ford" });
    expect(Object.prototype).not.toHaveProperty("pollute");
  });
});
