import { describe, expect, it } from "vitest";
import {
  buildAssetScheduleCalculations,
  buildDefaultAssetAdminScheduleSheet,
  calculateAssetAdminScheduleSheet,
  deriveAssetScheduleSummary,
} from "../src/service/assetAdminScheduleSheetService.js";

function formulaFixture() {
  return calculateAssetAdminScheduleSheet({
    evaluator_columns: [
      { id: "eval_a", name: "A" },
      { id: "eval_b", name: "B" },
    ],
    rows: [
      {
        lot_id: "lot-1",
        asset_id: "1",
        market_check: {
          comparable_count: "High",
          avg_retail_asking_price: "High",
          market_saturation: "Low",
          market_velocity: "Fast",
          regional_demand: "Strong",
          notes: "",
        },
        evaluator_values: { eval_a: 100, eval_b: 200 },
        lien_search: 5,
        video_cost: 10,
      },
      {
        lot_id: "lot-2",
        asset_id: "2",
        market_check: {
          comparable_count: "Low",
          avg_retail_asking_price: "Low",
          market_saturation: "High",
          market_velocity: "Slow",
          regional_demand: "Weak",
          notes: "",
        },
        evaluator_values: { eval_a: 300, eval_b: 500 },
        lien_search: 0,
        video_cost: 0,
      },
    ],
    file_summary: {
      buyers_premium_basis: "uncapped",
      offer2_nmg_percent: 0.785,
      capped_threshold_percent: 0.1,
    },
  });
}

describe("canonical Proposal Valuation formulas", () => {
  it("starts new sheets empty while preserving explicit historical columns", () => {
    const fresh = buildDefaultAssetAdminScheduleSheet({
      lots: [{ lot_id: "lot-1", lot_number: "1" }],
      preview_data: {},
    } as any);
    expect(fresh.evaluator_columns).toEqual([]);
    expect(fresh.rows[0].evaluator_values).toEqual({});

    expect(
      calculateAssetAdminScheduleSheet({
        evaluator_columns: [],
        rows: [],
        file_summary: {},
      }).evaluator_columns
    ).toEqual([]);
    expect(
      calculateAssetAdminScheduleSheet({
        evaluator_columns: [{ id: "legacy", name: "Historical evaluator" }],
        rows: [],
        file_summary: {},
      }).evaluator_columns
    ).toEqual([{ id: "legacy", name: "Historical evaluator" }]);
  });

  it("matches the admin workbook fixture for summary and final values", () => {
    const sheet = formulaFixture();
    const summary = deriveAssetScheduleSummary(sheet);

    expect(summary.row_appraiser_averages).toEqual({
      "lot-1": 150,
      "lot-2": 400,
    });
    expect(summary.total_asset_value).toBe(550);
    expect(summary.total_low_est_value).toBe(400);
    expect(summary.total_high_est_value).toBe(700);
    expect(summary.total_capped_bp).toBe(82.5);
    expect(summary.total_projected_costs).toBe(36);
    expect(summary.weighted_average_risk_score).toBeCloseTo(
      (150 + 400 * 3) / 550,
      12
    );
    expect(summary.overall_file_risk_rating).toBe("High");
    expect(summary.uncapped.get).toBe(632.5);
    expect(summary.uncapped.get_after_costs).toBe(596.5);
    expect(summary.uncapped.adjusted_get).toBeCloseTo(596.5 / 1.15, 12);
    expect(summary.uncapped.offer2_nmg).toBeCloseTo(632.5 * 0.785, 12);
    expect(summary.capped).toMatchObject({
      avg: 550,
      high: 700,
      low: 400,
      bp: 82.5,
      total_cost: 16.5,
      threshold: 55,
      nmg: 478.5,
    });
    expect(summary.selected_nmg).toBeCloseTo(632.5 * 0.785, 12);
    expect(summary.selected_cash_purchase_price).toBeCloseTo(632.5 * 0.9, 12);
    expect(summary.selected_commission_basis_value).toBeCloseTo(
      632.5 - 596.5 / 1.15,
      12
    );
  });

  it("bases premium and gross on the entered evaluator average, retaining high-based costs", () => {
    const sheet = formulaFixture();
    expect(sheet.rows[0]).toMatchObject({
      low_est_sale_value: 100, high_est_sale_value: 200,
      buyer_premium_percent: 15, buyer_premium_amount: 22.5,
      total_expected_gross: 172.5, allocated_value: 172.5,
      cleaning: 2, lotting_fee: 2, advertising: 2,
    });
    expect(sheet.rows[1]).toMatchObject({
      buyer_premium_amount: 60, total_expected_gross: 460, allocated_value: 460,
    });
  });

  it("keeps blank inputs distinct from zero and caps premiums per lot without rounding averages", () => {
    const input = {
      evaluator_columns: ["a", "b", "c"].map(id => ({ id, name: id })),
      rows: [
        { lot_id: "missing", evaluator_values: { a: null, b: "", c: Number.NaN } },
        { lot_id: "zero", evaluator_values: { a: 0, b: 100, c: null, removed: 999999 } },
        { lot_id: "fractional", evaluator_values: { a: 1, b: 2, c: 2 } },
        { lot_id: "average-below-cap", evaluator_values: { a: 10000, b: 15000 } },
        { lot_id: "cap-a", evaluator_values: { a: 10000, b: 50000 } },
        { lot_id: "cap-b", evaluator_values: { a: 40000 } },
      ],
      file_summary: {},
    };
    const before = structuredClone(input);
    const sheet = calculateAssetAdminScheduleSheet(input);
    expect(input).toEqual(before);
    expect(sheet.rows[0]).toMatchObject({ buyer_premium_amount: null, total_expected_gross: null, allocated_value: null });
    expect(sheet.rows[1]).toMatchObject({ buyer_premium_amount: 7.5, total_expected_gross: 57.5 });
    expect(sheet.rows[2].buyer_premium_amount).toBe((5 / 3) * 0.15);
    expect(sheet.rows[2].total_expected_gross).toBe(5 / 3 + (5 / 3) * 0.15);
    expect(sheet.rows[3]).toMatchObject({ buyer_premium_amount: 1875, total_expected_gross: 14375 });
    expect(sheet.rows[4]).toMatchObject({ buyer_premium_amount: 2000, total_expected_gross: 32000 });
    expect(sheet.rows[5]).toMatchObject({ buyer_premium_amount: 2000, total_expected_gross: 42000 });
    const summary = deriveAssetScheduleSummary(sheet);
    expect(summary.total_capped_bp).toBe(7.5 + (5 / 3) * 0.15 + 1875 + 2000 + 2000);
    expect(summary.uncapped.get).toBeCloseTo(sheet.rows.reduce((sum, row) => sum + (row.total_expected_gross ?? 0), 0), 10);
    expect(calculateAssetAdminScheduleSheet({ ...sheet, evaluator_columns: [] }).rows.every(row => row.buyer_premium_amount === null && row.total_expected_gross === null)).toBe(true);
  });

  it("provides server explanations for every summary and final table row", () => {
    const sheet = formulaFixture();
    const summary = deriveAssetScheduleSummary(sheet);
    const calculations = buildAssetScheduleCalculations(sheet, summary);
    const byKey = new Map(calculations.map((item) => [item.key, item]));

    expect(byKey.get("total_asset_value")).toMatchObject({
      label: "Total Asset Value",
      value: 550,
    });
    for (const key of [
      "estimated_range",
      "low_risk_percent",
      "weighted_average_risk_score",
      "selected_nmg",
      "selected_cash_purchase_price",
      "selected_commission_basis_value",
      "uncapped.offer2_roi",
      "uncapped.mcd_potential_take",
      "capped.sale_total_inc_bp",
      "capped.nmg",
      "capped.risk",
    ]) {
      expect(byKey.get(key), key).toMatchObject({
        key,
        formula: expect.any(String),
        inputs: expect.any(Object),
      });
    }
  });
});
