"use client";

import { useRef } from "react";
import { FileImage, Mic, Sparkles, Square, X } from "lucide-react";
import CollapsibleSection from "./CollapsibleSection";
import { FIELD_CLASS } from "./Field";

interface AIAssistSectionProps {
  specFiles: File[];
  onSpecChange: (files: FileList | null) => void;
  onRemoveSpecFile: (index: number) => void;
  onAnalyzeSpec: () => void;
  notesText: string;
  onNotesChange: (text: string) => void;
  onFillFromText: () => void;
  audioBlob: Blob | null;
  audioUrl: string | null;
  isRecording: boolean;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onUseRecording: () => void;
  onClearRecording: () => void;
  aiLoading: boolean;
}

/*
   Software Form Fill: three ways to fill the form, each on its own labelled
   row with a button that says what it does (owner, 2026-11-01: "professional
   and easy usability"). Its buttons were white text on white after the
   gradients were flattened, so they showed as empty boxes; they now use the
   app's button styles. Nothing about what each one sends has changed.
*/
export default function AIAssistSection({
  specFiles,
  onSpecChange,
  onRemoveSpecFile,
  onAnalyzeSpec,
  notesText,
  onNotesChange,
  onFillFromText,
  audioBlob,
  audioUrl,
  isRecording,
  onStartRecording,
  onStopRecording,
  onUseRecording,
  onClearRecording,
  aiLoading,
}: AIAssistSectionProps) {
  const specInputRef = useRef<HTMLInputElement>(null);
  const rowClass = "grid gap-2 sm:grid-cols-[170px_minmax(0,1fr)] sm:gap-4";
  const rowTitle = "text-[13px] font-semibold text-[var(--app-text)]";
  const rowHint = "mt-0.5 text-xs leading-5 text-[var(--app-text-muted)]";

  return (
    <CollapsibleSection
      step={2}
      title="Software Form Fill"
      description="Reads spec sheets, typed notes or a voice note and fills in the details below. Check the values afterwards."
      icon={<Sparkles />}
      optional
    >
      <div className="grid gap-4">
        <div className={rowClass}>
          <div>
            <p className={rowTitle}>Spec sheets</p>
            <p className={rowHint}>Photos of listing or spec sheets, up to 5.</p>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <input
              ref={specInputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={(e) => onSpecChange(e.target.files)}
              className="sr-only"
              aria-label="Choose spec sheet images"
            />
            {specFiles.map((file, idx) => (
              <span key={`${file.name}-${idx}`} className="inline-flex max-w-[220px] items-center gap-1.5 rounded-md border border-[var(--app-border)] bg-[var(--app-panel-alt)] py-1 pl-2 pr-1 text-xs text-[var(--app-text)]">
                <FileImage className="size-3.5 shrink-0 text-[var(--app-text-muted)]" aria-hidden="true" />
                <span className="truncate">{file.name}</span>
                <button type="button" onClick={() => onRemoveSpecFile(idx)} aria-label={`Remove ${file.name}`} className="grid size-5 place-items-center rounded text-[var(--app-text-muted)] hover:bg-[var(--app-danger-soft)] hover:text-[var(--app-danger)]">
                  <X className="size-3" aria-hidden="true" />
                </button>
              </span>
            ))}
            <button type="button" onClick={() => specInputRef.current?.click()} disabled={specFiles.length >= 5} className="app-button app-button--secondary">
              {specFiles.length > 0 ? "Add more" : "Choose images"}
            </button>
            <button type="button" onClick={onAnalyzeSpec} disabled={specFiles.length === 0 || aiLoading} className="app-button app-button--primary">
              Read spec sheets
            </button>
          </div>
        </div>

        <hr className="app-divider" />

        <div className={rowClass}>
          <div>
            <p className={rowTitle}>Notes or transcript</p>
            <p className={rowHint}>Type or paste what you know about the property.</p>
          </div>
          <div className="grid min-w-0 gap-2">
            <textarea
              className={`${FIELD_CLASS} min-h-20 resize-y`}
              value={notesText}
              onChange={(e) => onNotesChange(e.target.value)}
              placeholder="e.g. 3 bed bungalow built 1998, 1,450 sq ft, new roof 2021…"
              aria-label="Notes or transcript"
            />
            <div>
              <button type="button" onClick={onFillFromText} disabled={!notesText.trim() || aiLoading} className="app-button app-button--primary">
                Fill from notes
              </button>
            </div>
          </div>
        </div>

        <hr className="app-divider" />

        <div className={rowClass}>
          <div>
            <p className={rowTitle}>Voice note</p>
            <p className={rowHint}>Describe the property out loud.</p>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {!isRecording ? (
              <button type="button" onClick={onStartRecording} className="app-button app-button--secondary">
                <Mic className="size-4" aria-hidden="true" />
                {audioBlob ? "Record again" : "Record"}
              </button>
            ) : (
              <button type="button" onClick={onStopRecording} className="app-button app-button--danger">
                <Square className="size-3.5" aria-hidden="true" />
                Stop recording
              </button>
            )}
            {isRecording ? (
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--app-danger)]" role="status">
                <span className="size-2 animate-pulse rounded-full bg-[var(--app-danger)]" aria-hidden="true" />
                Recording…
              </span>
            ) : null}
            {audioUrl ? <audio src={audioUrl} controls className="h-9 max-w-[240px]" /> : null}
            <button type="button" onClick={onUseRecording} disabled={!audioBlob || aiLoading} className="app-button app-button--primary">
              Fill from recording
            </button>
            {audioBlob ? (
              <button type="button" onClick={onClearRecording} className="app-button">
                Clear
              </button>
            ) : null}
          </div>
        </div>

        {aiLoading ? (
          <p role="status" className="flex items-center gap-2 text-xs font-semibold text-[var(--app-accent)]">
            <span className="app-spinner" style={{ width: 14, height: 14 }} aria-hidden="true" />
            Reading… the details below fill in when it is done.
          </p>
        ) : null}
      </div>
    </CollapsibleSection>
  );
}
