import { describe, expect, it } from "vitest";
import { applyPrimarySerialEdit } from "./previewSerialNumber";

describe("preview serial editing", () => {
  it.each(["Serial Number", "VIN", "S/N", "Serial No", "S. No", "Serial Number (Unverified)"])(
    "replaces a prior %s admin correction without changing unrelated overrides",
    (field) => {
      const original = {
        serial_number: "OLD-123",
        condition_report_specs: { [field]: "OLD-123", "Engine Serial Number": "ENGINE-456" },
        condition_report_specs_manual_overrides: { [field]: "ADMIN-OLD", Colour: "Red" },
        condition_report_specs_deleted: [field, "Hours"],
      };
      const edited = applyPrimarySerialEdit(original, "NEW-789");
      expect(edited.serial_number).toBe("NEW-789");
      expect(edited.condition_report_specs).toEqual({
        "Serial Number": "NEW-789", "Engine Serial Number": "ENGINE-456",
      });
      expect(edited.condition_report_specs_manual_overrides).toEqual({
        "Serial Number": "NEW-789", Colour: "Red",
      });
      expect(edited.condition_report_specs_deleted).toEqual(["Hours"]);
      expect(original.condition_report_specs_manual_overrides[field]).toBe("ADMIN-OLD");
      const cleared = applyPrimarySerialEdit(edited, "");
      expect(cleared.condition_report_specs_manual_overrides).toEqual({ "Serial Number": "", Colour: "Red" });
      expect(cleared.condition_report_specs_deleted).toEqual(["Hours", "Serial Number"]);
    },
  );

  it("allows re-entry after legacy deletion markers while keeping unrelated deleted fields", () => {
    const original = {
      serial_number: "",
      condition_report_specs_deleted: { "Serial Number (Unverified)": true, Colour: true, Axles: false },
      deleted_condition_report_specs: ["VIN", "Engine Serial Number"],
      removed_condition_report_specs: { "S. No": true, Hours: true },
      hidden_condition_report_specs: ["Serial No", "Make"],
    };
    const edited = applyPrimarySerialEdit(original, "RESTORED-123");
    expect(edited.serial_number).toBe("RESTORED-123");
    expect(edited.condition_report_specs_manual_overrides).toEqual({ "Serial Number": "RESTORED-123" });
    expect(edited.condition_report_specs_deleted).toEqual(["Colour"]);
    expect(edited.deleted_condition_report_specs).toEqual(["Engine Serial Number"]);
    expect(edited.removed_condition_report_specs).toEqual({ Hours: true });
    expect(edited.hidden_condition_report_specs).toEqual(["Make"]);
    expect(original.removed_condition_report_specs).toEqual({ "S. No": true, Hours: true });
  });

  it("removes primary aliases while preserving unrelated serial fields", () => {
    const lot = applyPrimarySerialEdit(
      {
        serial_number: "OLD-123",
        sn_vin: "OLD-123",
        condition_report_specs: {
          VIN: "OLD-123",
          "Engine Serial Number": "ENGINE-456",
        },
      },
      ""
    );

    expect(lot.serial_number).toBe("");
    expect(lot.sn_vin).toBe("");
    expect(lot.condition_report_specs).toEqual({
      "Engine Serial Number": "ENGINE-456",
    });
    expect(lot.condition_report_specs_deleted).toEqual(["Serial Number"]);
  });

  it("allows a serial to be entered again after it was deleted", () => {
    const lot = applyPrimarySerialEdit(
      {
        serial_number: "",
        condition_report_specs_deleted: ["Serial Number", "Colour"],
      },
      "NEW-789"
    );

    expect(lot.serial_number).toBe("NEW-789");
    expect(lot.condition_report_specs).toEqual({
      "Serial Number": "NEW-789",
    });
    expect(lot.condition_report_specs_deleted).toEqual(["Colour"]);
  });
});
