import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  getAccessToken: vi.fn(),
  getDeviceKey: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  default: { get: mocks.apiGet },
}));
vi.mock("@/lib/auth-storage", () => ({
  getAccessToken: mocks.getAccessToken,
}));
vi.mock("@/lib/device-access", () => ({
  getDeviceKey: mocks.getDeviceKey,
}));
vi.mock("@/lib/config", () => ({
  API_BASE: "https://api.example.test/api",
}));

import {
  ProposalValuationAccessLost,
  ProposalValuationService,
  ProposalValuationStreamAuthenticationError,
  type ProposalValuationEvent,
} from "./proposalValuation";

describe("ProposalValuationService", () => {
  beforeEach(() => {
    mocks.apiGet.mockReset().mockResolvedValue({ data: { id: "user-1" } });
    mocks.getAccessToken.mockReset().mockReturnValue("token");
    mocks.getDeviceKey.mockReset().mockReturnValue("device-1");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("downloads an XLSX export and prefers the encoded response filename", async () => {
    const blob = new Blob(["workbook"], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    mocks.apiGet.mockResolvedValueOnce({
      data: blob,
      headers: {
        "content-disposition":
          "attachment; filename=proposal.xlsx; filename*=UTF-8''McDougall%20PV%20Summary.xlsx",
      },
    });

    await expect(
      ProposalValuationService.exportExcel("report / 1")
    ).resolves.toEqual({
      blob,
      filename: "McDougall PV Summary.xlsx",
    });
    expect(mocks.apiGet).toHaveBeenCalledWith(
      "/asset/report%20%2F%201/proposal-valuation/export",
      { responseType: "blob" }
    );
  });

  it("parses a quoted filename and removes any supplied path", async () => {
    const blob = new Blob(["workbook"]);
    mocks.apiGet.mockResolvedValueOnce({
      data: blob,
      headers: {
        get: vi.fn(() => 'attachment; filename="unsafe\\\\path\\\\PV Export.xlsx"'),
      },
    });

    await expect(ProposalValuationService.exportExcel("report-1")).resolves.toEqual({
      blob,
      filename: "PV Export.xlsx",
    });
  });

  it("uses the coalesced API refresh path once after a stream 401", async () => {
    mocks.getAccessToken
      .mockReturnValueOnce("expired-token")
      .mockReturnValue("fresh-token");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(
        new Response(
          'event: resync\ndata: {"reportId":"report-1","revision":8,"reason":"access-changed"}\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } }
        )
      );
    vi.stubGlobal("fetch", fetchMock);
    const events: ProposalValuationEvent[] = [];
    const signal = new AbortController().signal;

    await ProposalValuationService.streamEvents(
      "report-1",
      7,
      signal,
      (event) => events.push(event)
    );

    expect(mocks.apiGet).toHaveBeenCalledTimes(1);
    expect(mocks.apiGet).toHaveBeenCalledWith("/user/me", { signal });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryHeaders = new Headers(fetchMock.mock.calls[1][1]?.headers);
    expect(retryHeaders.get("Authorization")).toBe("Bearer fresh-token");
    expect(events).toEqual([
      {
        type: "resync",
        reportId: "report-1",
        revision: 8,
        reason: "access-changed",
      },
    ]);
  });

  it("makes authentication failure terminal instead of retrying the raw stream", async () => {
    mocks.apiGet.mockRejectedValue(new Error("refresh failed"));
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, { status: 401 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      ProposalValuationService.streamEvents(
        "report-1",
        7,
        new AbortController().signal,
        vi.fn()
      )
    ).rejects.toBeInstanceOf(ProposalValuationStreamAuthenticationError);
    expect(mocks.apiGet).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats stream 403 and 404 responses as terminal access loss", async () => {
    for (const status of [403, 404]) {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response(null, { status }))
      );
      await expect(
        ProposalValuationService.streamEvents(
          "report-1",
          7,
          new AbortController().signal,
          vi.fn()
        )
      ).rejects.toBeInstanceOf(ProposalValuationAccessLost);
    }
  });
});
