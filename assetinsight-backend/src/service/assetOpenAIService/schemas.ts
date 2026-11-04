/**
 * Strict JSON schemas for the configured primary Responses API model.
 * All schemas require `required` to list ALL properties and `additionalProperties: false`
 */

import { allowedCategories } from "../../utils/assetCategorySpecs.js";

const conditionReportSpecPairSchema = {
  type: "object" as const,
  properties: {
    field: { type: "string" },
    value: { type: "string" },
  },
  required: ["field", "value"],
  additionalProperties: false,
};

export const lotItemSchema = {
  type: "object" as const,
  properties: {
    lot_id: { type: "string" },
    lot_number: { type: ["string", "number", "null"] },
    title: { type: "string" },
    description: { type: "string" },
    condition_report_specs: {
      type: "array",
      items: conditionReportSpecPairSchema,
    },
    condition: { type: "string" },
    estimated_value: { type: "string" },
    damage_analysis: { type: ["string", "null"] },
    quantity: { type: "number" },
    must_take: { type: "boolean" },
    categories: { type: "string", enum: allowedCategories },
    serial_number: { type: ["string", "null"] },
    show_on_website: { type: "boolean" },
    close_date: { type: ["string", "null"] },
    bid_increment: { type: ["number", "null"] },
    location: { type: "string" },
    opening_bid: { type: ["number", "null"] },
    latitude: { type: ["number", "null"] },
    longitude: { type: ["number", "null"] },
    item_condition: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    image_indexes: { type: "array", items: { type: "number" } },
    // per_item specific fields
    image_url: { type: ["string", "null"] },
    serial_no_or_label: { type: ["string", "null"] },
    details: { type: ["string", "null"] },
  },
  required: [
    "lot_id",
    "lot_number",
    "title",
    "description",
    "condition_report_specs",
    "condition",
    "estimated_value",
    "damage_analysis",
    "quantity",
    "must_take",
    "categories",
    "serial_number",
    "show_on_website",
    "close_date",
    "bid_increment",
    "location",
    "opening_bid",
    "latitude",
    "longitude",
    "item_condition",
    "tags",
    "image_indexes",
    "image_url",
    "serial_no_or_label",
    "details",
  ],
  additionalProperties: false,
};

export const assetAnalysisResponseSchema = {
  type: "object" as const,
  properties: {
    lots: {
      type: "array",
      items: lotItemSchema,
    },
    summary: { type: "string" },
    language: { type: "string" },
    currency: { type: "string" },
  },
  required: ["lots", "summary", "language", "currency"],
  additionalProperties: false,
};
