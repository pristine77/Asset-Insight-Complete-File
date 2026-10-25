import { describe, expect, it } from "vitest";
import { deriveProposalValuationSummary, proposalValuationColumnTotals, recalculateProposalValuationSheet } from "./calculations";
import type { ProposalValuationSheet } from "./types";

const parityFixture: ProposalValuationSheet = {
  evaluator_columns: [
    { id: "riley", name: "Riley" },
    { id: "jay", name: "Jay" },
    { id: "chad", name: "Chad" },
    { id: "femi", name: "Femi" },
  ],
  rows: [
    {
      lot_id: "lot-13",
      asset_id: "13",
      asset_category: "Light Duty Pickup Truck",
      year: "2023",
      make: "Ford",
      model: "F-150",
      serial_number: "1FTFW1E57LKE217",
      cr_details: "SuperCrew pickup with 4WD",
      condition_score: "4",
      location: "Regina, SK",
      pictures: 30,
      picture_urls: [],
      market_check: {
        comparable_count: "Moderate",
        avg_retail_asking_price: "Moderate",
        market_saturation: "Low",
        market_velocity: "Normal",
        regional_demand: "Strong",
        notes: "Stable regional demand",
      },
      asset_insight: "US$42,000",
      evaluator_values: { riley: 40000, jay: 42000, chad: 41000, femi: 43000 },
      low_est_sale_value: 40000,
      high_est_sale_value: 43000,
      buyer_premium_percent: 15,
      buyer_premium_amount: 2000,
      total_expected_gross: 45000,
      allocated_value: 45000,
      notes: "",
      cleaning: 430,
      lien_search: 50,
      video_cost: 100,
      lotting_fee: 430,
      advertising: 430,
    },
  ],
  file_summary: {
    buyers_premium_basis: "uncapped",
    total_risk_weighted_value: 38000,
    file_risk_multiplier: 0.9,
    commission_percent_no_guarantee: 12,
    offer2_nmg_percent: 0.785,
    capped_threshold_percent: 0.1,
  },
};

describe("Proposal Valuation admin parity", () => {
  it("matches the canonical full Schedule A metric fixture", () => {
    expect(deriveProposalValuationSummary(parityFixture)).toEqual({
      row_appraiser_averages: { "lot-13": 41500 },
      total_asset_value: 41500,
      total_low_est_value: 40000,
      total_high_est_value: 43000,
      total_capped_bp: 2000,
      total_projected_costs: 1440,
      low_risk_value: 41500,
      medium_risk_value: 0,
      high_risk_value: 0,
      low_risk_percent: 1,
      medium_risk_percent: 0,
      high_risk_percent: 0,
      weighted_average_risk_score: 1.6,
      overall_file_risk_rating: "Low",
      selected_nmg: 34147.5,
      selected_cash_purchase_price: 39150,
      selected_commission_basis_value: 6926.086956521736,
      uncapped: {
        get: 43500,
        costs: 1440,
        get_after_costs: 42060,
        adjusted_get: 36573.913043478264,
        bp_15: 6926.086956521736,
        potential_get: 45000,
        adjusted_potential_get: 39130.434782608696,
        potential_bp_15: 5869.565217391304,
        offer1_cash_offer: 39150,
        offer1_total_costs: 40590,
        offer1_mcd_take: 2910,
        offer1_roi: 0.07169253510716925,
        offer1_risk: 1410,
        offer2_nmg: 34147.5,
        offer2_threshold: 5122.125,
        offer2_upper_value: 39269.625,
        offer2_total_costs: 35587.5,
        offer2_aquajets_take: 34147.5,
        offer2_overage: 2426.4130434782637,
        offer2_mcd_take: 5486.086956521736,
        offer2_roi: 0.15415769459843306,
        offer2_risk: 6412.5,
        aquajets_potential_take: 34011.09358695652,
        mcd_potential_take: 9548.906413043478,
        potential_roi: 0.2683219223897008,
        offer3_mcd_take: 6926.086956521736,
      },
      capped: {
        avg: 41500,
        high: 43000,
        low: 40000,
        bp: 2000,
        sale_total_inc_bp: 43500,
        ads: 415,
        svr: 415,
        refurb: 415,
        total_cost: 1245,
        nmg: 36105,
        threshold: 4150,
        risk: 0.14819277108433737,
      },
    });
  });
});

describe("whole-report PV column totals", () => {
  it.each([
    { values: { riley: 4000, jay: 4500 }, average: 4250, premium: 637.5, gross: 4887.5 },
    { values: { riley: 50, jay: 100 }, average: 75, premium: 11.25, gross: 86.25 },
    { values: { riley: 25, jay: 100 }, average: 62.5, premium: 9.375, gross: 71.875 },
    { values: { riley: 0, jay: 20000 }, average: 10000, premium: 1500, gross: 11500 },
    { values: { riley: 20000, jay: 40000 }, average: 30000, premium: 2000, gross: 32000 },
    { values: { riley: 0, jay: null }, average: 0, premium: 0, gross: 0 },
  ])("uses the unrounded average for premium and gross: $average", ({ values, average, premium, gross }) => {
    const sheet = structuredClone(parityFixture);
    sheet.rows[0].evaluator_values = { ...values, removed: 999999, chad: null, femi: Number.NaN };
    const before = structuredClone(sheet);
    const row = recalculateProposalValuationSheet(sheet).rows[0];
    expect(row).toMatchObject({ buyer_premium_amount: premium, total_expected_gross: gross, allocated_value: gross });
    expect(row.cleaning).toBe(Math.max(...Object.values(values).filter((value): value is number => value !== null)) * 0.01);
    expect(proposalValuationColumnTotals(sheet)).toMatchObject({ average, buyerPremium: premium, totalExpectedGross: gross, allocatedValue: gross });
    expect(sheet).toEqual(before);
  });

  it("retains blank derived row values when no active evaluator has entered a value", () => {
    const sheet = structuredClone(parityFixture);
    sheet.rows[0].evaluator_values = { removed: 1000, riley: null, jay: Number.NaN, chad: Infinity };
    expect(recalculateProposalValuationSheet(sheet).rows[0]).toMatchObject({ buyer_premium_amount: null, total_expected_gross: null, allocated_value: null });
    expect(proposalValuationColumnTotals(sheet)).toMatchObject({ average: 0, buyerPremium: 0, totalExpectedGross: 0, allocatedValue: 0 });
  });

  it("sums evaluator values and existing row formulas without rounding or mutating the sheet", () => {
    const sheet = structuredClone(parityFixture);
    sheet.rows.push({ ...structuredClone(sheet.rows[0]), lot_id: "second", evaluator_values: { riley: 0, jay: 100.75, chad: null, femi: 200.5 } });
    const before = structuredClone(sheet);
    const totals = proposalValuationColumnTotals(sheet);
    expect(totals.evaluators.map(({ total }) => total)).toEqual([40000, 42100.75, 41000, 43200.5]);
    expect(totals.average).toBe(41500 + (0 + 100.75 + 200.5) / 3);
    expect(totals.low).toBe(40000);
    expect(totals.high).toBe(43200.5);
    const secondAverage = (0 + 100.75 + 200.5) / 3;
    expect(totals.buyerPremium).toBe(2000 + secondAverage * 0.15);
    expect(totals.totalExpectedGross).toBe(43500 + secondAverage + secondAverage * 0.15);
    expect(totals.allocatedValue).toBe(totals.totalExpectedGross);
    expect(totals.cleaning).toBe(432.005);
    expect(totals.lottingFee).toBe(432.005);
    expect(totals.advertising).toBe(432.005);
    expect(totals.lienSearch).toBe(100);
    expect(totals.videoCost).toBe(200);
    expect(totals.lotCount).toBe(2);
    expect(sheet).toEqual(before);
  });

  it("ignores absent and nonfinite entries, includes zero, and does not sum percentages", () => {
    const sheet = structuredClone(parityFixture);
    sheet.rows[0].evaluator_values = { riley: 0, jay: null, chad: Number.NaN, femi: Infinity };
    sheet.rows[0].buyer_premium_percent = 99;
    const totals = proposalValuationColumnTotals(sheet);
    expect(totals.evaluators.map(({ total }) => total)).toEqual([0, 0, 0, 0]);
    expect(totals).toMatchObject({ average: 0, low: 0, high: 0, buyerPremium: 0, totalExpectedGross: 0, allocatedValue: 0, cleaning: 0, lottingFee: 0, advertising: 0 });
    expect(totals).not.toHaveProperty("buyerPremiumPercent");
    sheet.rows[0].evaluator_values = {};
    expect(proposalValuationColumnTotals(sheet)).toEqual(totals);
  });

  it("tracks dynamic evaluator order, ignores removed columns, and supports an empty sheet", () => {
    const sheet = structuredClone(parityFixture);
    sheet.evaluator_columns = [{ id: "new", name: "New appraiser" }, { id: "jay", name: "Jay renamed" }];
    sheet.rows[0].evaluator_values.new = 10000;
    expect(proposalValuationColumnTotals(sheet)).toMatchObject({
      evaluators: [{ id: "new", name: "New appraiser", total: 10000 }, { id: "jay", name: "Jay renamed", total: 42000 }],
      average: 26000, low: 10000, high: 42000, buyerPremium: 2000,
    });
    sheet.rows = [];
    expect(proposalValuationColumnTotals(sheet)).toMatchObject({
      lotCount: 0, evaluators: [{ total: 0 }, { total: 0 }], average: 0, low: 0, high: 0, buyerPremium: 0,
      totalExpectedGross: 0, allocatedValue: 0, cleaning: 0, lienSearch: 0, videoCost: 0, lottingFee: 0, advertising: 0,
    });
  });

  it("uses live evaluator averages, not stale saved gross values or high estimates", () => {
    const sheet = structuredClone(parityFixture);
    sheet.rows[0].evaluator_values = { riley: 45, jay: 90 };
    sheet.rows[0].lien_search = null;
    sheet.rows[0].video_cost = Number.NaN;
    expect(proposalValuationColumnTotals(sheet)).toMatchObject({
      average: 67.5, high: 90, buyerPremium: 10.125,
      totalExpectedGross: 77.625, allocatedValue: 77.625,
      cleaning: 0.9, lienSearch: 0, videoCost: 0, lottingFee: 0.9, advertising: 0.9,
    });
    sheet.rows[0].evaluator_values = {};
    sheet.rows[0].lien_search = 12.25;
    sheet.rows[0].video_cost = 7.5;
    expect(proposalValuationColumnTotals(sheet)).toMatchObject({
      totalExpectedGross: 0, allocatedValue: 0, cleaning: 0,
      lienSearch: 12.25, videoCost: 7.5, lottingFee: 0, advertising: 0,
    });
  });
});
