import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReportThumbnail } from "./ReportThumbnail";

describe("ReportThumbnail", () => {
  it("uses native lazy loading without a per-row observer", () => {
    render(
      <ReportThumbnail
        src="https://images.sellsnap.store/reports/excavator.jpg"
        title="2019 Caterpillar 320 Excavator"
      />
    );

    const image = screen.getByAltText(
      "Preview image for 2019 Caterpillar 320 Excavator"
    );
    expect(image).toHaveAttribute("loading", "lazy");
    expect(image).toHaveAttribute("decoding", "async");
    expect(image).toHaveAttribute("fetchpriority", "low");
    expect(image).toHaveAttribute("width", "64");
    expect(image).toHaveAttribute("height", "48");

    fireEvent.error(image);
    expect(
      screen.queryByAltText("Preview image for 2019 Caterpillar 320 Excavator")
    ).not.toBeInTheDocument();
    expect(
      screen.getByLabelText(
        "No preview image available for 2019 Caterpillar 320 Excavator"
      )
    ).toBeInTheDocument();
  });

  it("renders the fallback without creating a broken image request", () => {
    render(<ReportThumbnail title="Report without photos" size="card" />);

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(
      screen.getByLabelText(
        "No preview image available for Report without photos"
      )
    ).toHaveClass("h-[4.5rem]", "w-24");
  });
});
