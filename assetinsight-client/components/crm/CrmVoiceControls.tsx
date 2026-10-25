"use client";

import { Mic, Square, X } from "lucide-react";
import type { useCrmVoiceInput } from "./useCrmVoiceInput";
import styles from "./CrmTaskDetail.module.css";

export default function CrmVoiceControls({ voice, disabled = false }: { voice: ReturnType<typeof useCrmVoiceInput>; disabled?: boolean }) {
  const recording = voice.state === "recording";
  const label = recording ? `Stop & transcribe (${Math.floor(voice.seconds / 60)}:${String(voice.seconds % 60).padStart(2, "0")})`
    : voice.state === "requesting" ? "Opening microphone…"
    : voice.state === "transcribing" ? "Transcribing…" : "Record note";
  return (
    <>
      <button type="button" className={styles.textButton} onClick={() => recording ? voice.stop() : void voice.start()}
        disabled={disabled || !voice.available || (voice.busy && !recording)}
        title={!voice.available ? "Voice input needs a supported browser and a secure connection. You can type your notes." : undefined}>
        {recording ? <Square size={17} aria-hidden /> : <Mic size={18} aria-hidden />}{label}
      </button>
      {voice.busy ? <button type="button" className={styles.textButton} onClick={voice.cancel}><X size={15} aria-hidden />Cancel voice input</button> : null}
      {voice.error ? <p className={styles.voiceError} role="alert">{voice.error}</p> : null}
    </>
  );
}
