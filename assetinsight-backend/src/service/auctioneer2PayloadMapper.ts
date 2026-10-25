/**
 * Defines the anti-corruption mapping between permissive Auctioneer2 records and the
 * internal asset-lot schema. Alias handling is intentionally concentrated here, with
 * explicit precedence for canonical source facts versus editable report values, so
 * integration schema drift does not spread through report services.
 */
import {
  collectAuctioneerSpecRecord,
  deriveAuctioneerSerial,
  normalizeAuctioneerSpecKey,
} from "../utils/auctioneerSpecRows.js";

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function first(...values: unknown[]): string {
  for (const value of values) {
    const text = clean(value);
    if (text) return text;
  }
  return "";
}

function pickSpec(specs: Record<string, string>, ...aliases: string[]): string {
  const normalizedAliases = aliases.map(normalizeAuctioneerSpecKey);
  for (const [field, value] of Object.entries(specs)) {
    if (normalizedAliases.includes(normalizeAuctioneerSpecKey(field)) && clean(value)) {
      return clean(value);
    }
  }
  return "";
}

function readableValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map(readableValue).filter(Boolean).join(", ");
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => {
        const rendered = readableValue(item);
        return rendered ? `${key.replace(/_/g, " ")}: ${rendered}` : "";
      })
      .filter(Boolean)
      .join("; ");
  }
  return clean(value);
}

/** The approved display number, never an upstream GUID or source placeholder. */
export function resolveAuctioneerLotNumber(lot: any): string {
  const value = lot?.lot_number ?? lot?.lotNumber;
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/**
 * Auctioneer expects estimatedValue as an unformatted numeric string. Report
 * values may include a currency prefix and grouping separators (for example
 * "CA$15,000"), so normalize those values at the integration boundary.
 */
export function resolveAuctioneerEstimatedValue(
  lot: any,
  sourceLot?: any
): string {
  const source = sourceLot?.lot || sourceLot || {};
  const candidate = first(
    lot?.estimatedValue,
    lot?.estimated_value,
    lot?.fair_market_value,
    lot?.fmv,
    lot?.valuation_data?.fmv,
    lot?.valuationData?.fmv,
    source?.estimatedValue,
    source?.estimated_value,
    source?.fair_market_value,
    source?.fmv
  );
  if (!candidate) return "";

  const numericText = candidate.replace(/[^0-9.-]/g, "");
  const amount = Number(numericText);
  if (!numericText || !Number.isFinite(amount) || amount < 0) return "";
  return String(amount);
}

export function mergeAuctioneerSourceLot(
  approvedOrAiLot: any,
  sourceLot: any,
  sourceKey?: string
): any {
  const lot = { ...(approvedOrAiLot || {}) };
  const source = sourceLot?.lot || sourceLot || {};
  const sourceSubmission = sourceLot?.submission || {};
  const fill = (field: string, ...fallbacks: unknown[]) => {
    if (!clean(lot[field])) {
      const value = first(...fallbacks);
      if (value) lot[field] = value;
    }
  };

  fill("title", source.title, source.description);
  fill("description", source.description, sourceSubmission.conditionReport);
  fill("year", source.year);
  fill("make", source.make);
  fill("model", source.model);
  fill("serial_number", source.serialNumber, source.serial_number);
  fill("hours", source.hours);
  fill("category", source.category, source.categories);
  fill("location", source.location, source.storageLocation);
  fill("base_condition", source.baseCondition);
  fill("condition_report", source.conditionReport, sourceSubmission.conditionReport);
  fill("estimated_value", source.estimatedValue, source.estimated_value);

  const resolvedSourceKey = first(
    sourceKey,
    sourceLot?.sourceKey,
    sourceSubmission.id,
    source.id
  );
  if (resolvedSourceKey) lot.auctioneer_source_key = resolvedSourceKey;
  return lot;
}

export function buildAuctioneerConditionReport(lot: any): string {
  const specs = collectAuctioneerSpecRecord(lot || {});
  const lines: string[] = [];
  const title = first(lot?.title, lot?.name);
  const description = first(lot?.description, lot?.condition_report);
  if (title) lines.push(title);
  if (description && description !== title) lines.push(description);

  const conditionParts = [
    first(lot?.base_condition, lot?.baseCondition),
    readableValue(lot?.condition_selections),
    readableValue(lot?.condition),
    readableValue(lot?.running_condition),
  ].filter(Boolean);
  if (conditionParts.length > 0) {
    lines.push(`Condition: ${Array.from(new Set(conditionParts)).join("; ")}`);
  }

  const damage = first(
    readableValue(lot?.damage_analysis),
    readableValue(lot?.damageAnalysis),
    readableValue(lot?.damages)
  );
  if (damage) lines.push(`Damage: ${damage}`);

  const specText = Object.entries(specs)
    .filter(([, value]) => clean(value))
    .map(([field, value]) => `${field}: ${clean(value)}`)
    .join("; ");
  if (specText) lines.push(`Specifications: ${specText}`);

  return lines.join("\n").trim();
}

export function buildAuctioneerKnownLotPatch(
  lot: any,
  sourceLot: any,
  options: { useSourceFallbacks?: boolean } = {}
) {
  const useSourceFallbacks = options.useSourceFallbacks !== false;
  const source = useSourceFallbacks
    ? sourceLot?.lot || sourceLot || {}
    : {};
  const merged = useSourceFallbacks
    ? mergeAuctioneerSourceLot(lot, sourceLot)
    : { ...(lot || {}) };
  const specs = collectAuctioneerSpecRecord(merged);
  const conditionReport = buildAuctioneerConditionReport(merged);
  const patch: Record<string, string | boolean> = {
    description: first(merged.title, merged.description, source.description),
    year: first(merged.year, pickSpec(specs, "year"), source.year),
    make: first(merged.make, pickSpec(specs, "make", "manufacturer"), source.make),
    model: first(merged.model, pickSpec(specs, "model"), source.model),
    serialNumber: first(
      merged.serial_number,
      merged.serialNumber,
      deriveAuctioneerSerial(merged),
      source.serialNumber
    ),
    hours: first(
      merged.hours,
      pickSpec(specs, "hours", "meter hours", "hour meter"),
      source.hours
    ),
    categories: first(
      merged.category,
      merged.categories,
      source.category,
      source.categories
    ),
    conditionReport,
    storageLocation: first(
      merged.storage_location,
      merged.location,
      source.storageLocation,
      source.location
    ),
    baseCondition: first(
      merged.base_condition,
      merged.baseCondition,
      source.baseCondition
    ),
    estimatedValue: resolveAuctioneerEstimatedValue(merged, source),
  };

  return Object.fromEntries(
    Object.entries(patch).filter(([, value]) => clean(value))
  );
}

export function buildAuctioneerUnknownLotPayload(input: {
  lot: any;
  sourceLot?: any;
  contractId: string;
  eventId: string;
  contractLotRef: string;
  /**
   * The Schedule A line this lot was split out of, when it was.
   *
   * Auctioneer creates a Schedule A line for the split and copies this line's
   * commission onto it, so the consignor is charged the rate they signed for.
   * Absent for a genuinely new Unknown lot, which has no line to inherit from.
   */
  scheduleAParentRef?: string;
  destination: "LottingBoard" | "OpToDoBoard";
  opTaskDescription?: string;
  submittedBy: string;
}) {
  // The source-to-AI merge happens once while the preview is generated. From
  // this point onward the approved preview is authoritative, including an
  // intentional user edit that clears a previously imported field.
  const merged = { ...(input.lot || {}) };
  const patch = buildAuctioneerKnownLotPatch(merged, undefined, {
    useSourceFallbacks: false,
  });
  const sourceServices = Array.isArray(input.sourceLot?.selectedServices)
    ? input.sourceLot.selectedServices
    : Array.isArray(input.sourceLot?.services)
      ? input.sourceLot.services
      : [];

  const selectedServices = sourceServices
    .map((service: any) => ({
      revenueContractId: first(service?.revenueContractId, service?.contractId),
      revenueContractServiceId: first(
        service?.revenueContractServiceId,
        service?.serviceId,
        service?.id
      ),
      serviceName: first(service?.serviceName, service?.name),
      price: Number(service?.price ?? service?.defaultPrice ?? 0),
      quantity: Number(service?.quantity ?? 1),
    }))
    .filter(
      (service: any) =>
        service.revenueContractId &&
        service.revenueContractServiceId &&
        service.serviceName
    );

  return {
    contractId: input.contractId,
    eventId: input.eventId,
    contractLotRef: input.contractLotRef,
    ...(input.scheduleAParentRef
      ? { scheduleAParentRef: input.scheduleAParentRef }
      : {}),
    description: first(patch.description),
    year: first(patch.year),
    make: first(patch.make),
    model: first(patch.model),
    serialNumber: first(patch.serialNumber),
    hours: first(patch.hours),
    category: first(patch.categories),
    conditionReport: first(patch.conditionReport),
    ...(selectedServices.length > 0 ? { selectedServices } : {}),
    destination: input.destination,
    ...(input.opTaskDescription
      ? { opTaskDescription: input.opTaskDescription }
      : {}),
    submittedBy: input.submittedBy,
  };
}
