"use client";

import { useEffect, useRef, useState } from "react";

export const CRM_TRANSCRIPTION_MAX_BYTES = 25 * 1024 * 1024;

type VoiceOptions = {
  transcribe: (file: File, signal: AbortSignal) => Promise<string>;
  onText: (text: string) => void;
};

type VoiceState = "idle" | "requesting" | "recording" | "transcribing";

/** Browser audio stays local until the user explicitly stops to transcribe. */
export function useCrmVoiceInput({ transcribe, onText }: VoiceOptions) {
  const [available, setAvailable] = useState(false);
  const [state, setState] = useState<VoiceState>("idle");
  const [error, setError] = useState("");
  const [seconds, setSeconds] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const generationRef = useRef(0);
  const lockedRef = useRef(false);
  const mountedRef = useRef(false);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  function releaseResources() {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
  }

  function cancel() {
    generationRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    releaseResources();
    lockedRef.current = false;
    if (mountedRef.current) {
      setState("idle");
      setSeconds(0);
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    setAvailable(Boolean(window.isSecureContext && typeof navigator.mediaDevices?.getUserMedia === "function" && typeof MediaRecorder !== "undefined"));
    return () => {
      mountedRef.current = false;
      cancel();
    };
  }, []);

  async function start() {
    if (lockedRef.current) return;
    if (!window.isSecureContext || typeof navigator.mediaDevices?.getUserMedia !== "function" || typeof MediaRecorder === "undefined") {
      setError("Voice input needs a supported browser and a secure connection. You can still type your notes.");
      return;
    }
    lockedRef.current = true;
    const generation = ++generationRef.current;
    const isCurrent = () => mountedRef.current && generation === generationRef.current;
    setError("");
    setSeconds(0);
    setState("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!isCurrent()) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      const mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((mime) => MediaRecorder.isTypeSupported(mime));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      const chunks: Blob[] = [];
      let bytes = 0;
      let failed = false;
      recorder.ondataavailable = (event: BlobEvent) => {
        if (!isCurrent() || failed || !event.data.size) return;
        bytes += event.data.size;
        if (bytes > CRM_TRANSCRIPTION_MAX_BYTES) {
          failed = true;
          setError("Recording is too large. Record a shorter note (up to 25 MiB).");
          if (recorder.state !== "inactive") recorder.stop();
          return;
        }
        chunks.push(event.data);
      };
      recorder.onerror = () => {
        if (!isCurrent()) return;
        failed = true;
        setError("Recording stopped unexpectedly. Your typed notes are still available.");
        if (recorder.state !== "inactive") recorder.stop();
        else {
          releaseResources();
          lockedRef.current = false;
          setState("idle");
        }
      };
      recorder.onstop = async () => {
        // A cancelled generation must not release a newer recording's stream.
        if (!isCurrent()) return;
        releaseResources();
        if (failed || !chunks.length) {
          lockedRef.current = false;
          setState("idle");
          if (!failed) setError("No audio was recorded. You can try again or type your notes.");
          return;
        }
        const type = recorder.mimeType || chunks[0].type || "audio/webm";
        const extension = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
        const file = new File(chunks, `crm-voice-note.${extension}`, { type });
        const controller = new AbortController();
        controllerRef.current = controller;
        setState("transcribing");
        try {
          const text = await transcribe(file, controller.signal);
          if (!isCurrent()) return;
          if (text.trim()) onTextRef.current(text.trim());
          else setError("No speech was detected. Try again or type your notes.");
        } catch (cause) {
          if (isCurrent() && !controller.signal.aborted) {
            const message = cause instanceof Error ? cause.message : "Please try again.";
            setError(`Could not transcribe audio. ${message}`);
          }
        } finally {
          if (isCurrent()) {
            controllerRef.current = null;
            lockedRef.current = false;
            setState("idle");
          }
        }
      };
      recorder.start(1000);
      setState("recording");
      timerRef.current = setInterval(() => {
        if (isCurrent()) setSeconds((current) => current + 1);
      }, 1000);
    } catch (cause) {
      if (!isCurrent()) return;
      releaseResources();
      lockedRef.current = false;
      setState("idle");
      setError(cause instanceof DOMException && cause.name === "NotAllowedError"
        ? "Microphone access was not allowed. You can still type your notes."
        : "Could not start the microphone. You can still type your notes.");
    }
  }

  function stop() {
    const recorder = recorderRef.current;
    if (recorder?.state === "recording") {
      setState("transcribing");
      recorder.stop();
    }
  }

  return { available, state, seconds, error, start, stop, cancel, busy: state !== "idle" };
}
