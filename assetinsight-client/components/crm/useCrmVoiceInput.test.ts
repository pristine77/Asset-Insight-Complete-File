import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CRM_TRANSCRIPTION_MAX_BYTES, useCrmVoiceInput } from "./useCrmVoiceInput";

class FakeRecorder {
  static isTypeSupported = () => true;
  static latest: FakeRecorder;
  state = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { FakeRecorder.latest = this; }
  start() { this.state = "recording"; }
  stop() {
    this.state = "inactive";
    queueMicrotask(() => this.onstop?.());
  }
  data(data: Blob) { this.ondataavailable?.({ data }); }
}

const stopTrack = vi.fn();
const stream = { getTracks: () => [{ stop: stopTrack }] };
const getUserMedia = vi.fn();

beforeEach(() => {
  stopTrack.mockReset();
  getUserMedia.mockReset().mockResolvedValue(stream);
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
});
afterEach(() => vi.unstubAllGlobals());

describe("CRM voice input", () => {
  it("makes no provider request until the user stops and appends only the returned text", async () => {
    const onText = vi.fn();
    const transcribe = vi.fn().mockResolvedValue("  Follow up tomorrow.  ");
    const { result } = renderHook(() => useCrmVoiceInput({ onText, transcribe }));
    await act(async () => { await result.current.start(); });
    expect(result.current.state).toBe("recording");
    expect(transcribe).not.toHaveBeenCalled();
    act(() => FakeRecorder.latest.data(new Blob(["audio"], { type: "audio/webm" })));
    await act(async () => result.current.stop());
    await waitFor(() => expect(onText).toHaveBeenCalledWith("Follow up tomorrow."));
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(transcribe.mock.calls[0][0]).toBeInstanceOf(File);
    expect(stopTrack).toHaveBeenCalledTimes(1);
  });

  it("aborts transcription on unmount and ignores a late transcript", async () => {
    let resolve!: (text: string) => void;
    const transcribe = vi.fn().mockReturnValue(new Promise<string>((done) => { resolve = done; }));
    const onText = vi.fn();
    const { result, unmount } = renderHook(() => useCrmVoiceInput({ onText, transcribe }));
    await act(async () => { await result.current.start(); });
    act(() => FakeRecorder.latest.data(new Blob(["audio"])));
    await act(async () => result.current.stop());
    await waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));
    const signal = transcribe.mock.calls[0][1] as AbortSignal;
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => resolve("Stale text"));
    expect(onText).not.toHaveBeenCalled();
  });

  it("releases permission granted after cancellation without starting a recording", async () => {
    let grant!: (value: typeof stream) => void;
    getUserMedia.mockReturnValue(new Promise((resolve) => { grant = resolve; }));
    const transcribe = vi.fn();
    const { result } = renderHook(() => useCrmVoiceInput({ onText: vi.fn(), transcribe }));
    let starting!: Promise<void>;
    act(() => { starting = result.current.start(); });
    act(() => result.current.cancel());
    await act(async () => { grant(stream); await starting; });
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe("idle");
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("keeps audio local when cancelled and rejects oversized recordings", async () => {
    const transcribe = vi.fn();
    const { result } = renderHook(() => useCrmVoiceInput({ onText: vi.fn(), transcribe }));
    await act(async () => { await result.current.start(); });
    act(() => FakeRecorder.latest.data(new Blob(["audio"])));
    await act(async () => result.current.cancel());
    expect(transcribe).not.toHaveBeenCalled();
    await act(async () => { await result.current.start(); });
    await act(async () => FakeRecorder.latest.data({ size: CRM_TRANSCRIPTION_MAX_BYTES + 1 } as Blob));
    expect(result.current.error).toMatch(/too large/);
    expect(result.current.state).toBe("idle");
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("reports denied or unsupported microphone access without calling transcription", async () => {
    const transcribe = vi.fn();
    getUserMedia.mockRejectedValue(new DOMException("Denied", "NotAllowedError"));
    const { result } = renderHook(() => useCrmVoiceInput({ onText: vi.fn(), transcribe }));
    await act(async () => { await result.current.start(); });
    expect(result.current.error).toMatch(/not allowed/);
    vi.stubGlobal("isSecureContext", false);
    await act(async () => { await result.current.start(); });
    expect(result.current.error).toMatch(/secure connection/);
    expect(transcribe).not.toHaveBeenCalled();
  });
});
