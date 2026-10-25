"use client";

import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

type ToastTone = "default" | "success" | "error" | "warning" | "info";
type ToastItem = { id: number; message: string; tone: ToastTone };
type Listener = (item: ToastItem) => void;

let nextId = 1;
const listeners = new Set<Listener>();

function publish(message: unknown, tone: ToastTone = "default") {
  const text =
    typeof message === "string"
      ? message
      : message instanceof Error
        ? message.message
        : String(message ?? "");
  const item = { id: nextId++, message: text, tone };
  listeners.forEach((listener) => listener(item));
  return item.id;
}

type ToastFunction = {
  (message: unknown): number;
  success: (message: unknown) => number;
  error: (message: unknown) => number;
  warning: (message: unknown) => number;
  warn: (message: unknown) => number;
  info: (message: unknown) => number;
  dismiss: (id?: number) => void;
};

export const toast = Object.assign(
  (message: unknown) => publish(message),
  {
    success: (message: unknown) => publish(message, "success"),
    error: (message: unknown) => publish(message, "error"),
    warning: (message: unknown) => publish(message, "warning"),
    warn: (message: unknown) => publish(message, "warning"),
    info: (message: unknown) => publish(message, "info"),
    dismiss: (_id?: number) => undefined,
  }
) as ToastFunction;

const ToastContext = createContext<(id: number) => void>(() => undefined);

function ToastIcon({ tone }: { tone: ToastTone }) {
  const props = { size: 18, "aria-hidden": true };
  if (tone === "success") return <CircleCheck {...props} />;
  if (tone === "error") return <CircleAlert {...props} />;
  if (tone === "warning") return <TriangleAlert {...props} />;
  return <Info {...props} />;
}

function ToastCard({ item }: { item: ToastItem }) {
  const dismiss = useContext(ToastContext);

  useEffect(() => {
    const timer = window.setTimeout(() => dismiss(item.id), 3600);
    return () => window.clearTimeout(timer);
  }, [dismiss, item.id]);

  return (
    <div className="app-toast" data-tone={item.tone} role="status">
      <ToastIcon tone={item.tone} />
      <span style={{ flex: 1 }}>{item.message}</span>
      <button
        className="app-button app-button--icon"
        style={{ width: 28, minHeight: 28 }}
        onClick={() => dismiss(item.id)}
        aria-label="Dismiss notification"
      >
        <X size={15} aria-hidden />
      </button>
    </div>
  );
}

export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);
  const dismiss = useCallback(
    (id: number) => setItems((current) => current.filter((item) => item.id !== id)),
    []
  );

  useEffect(() => {
    const listener: Listener = (item) =>
      setItems((current) => [...current.slice(-3), item]);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const context = useMemo(() => dismiss, [dismiss]);

  return (
    <ToastContext.Provider value={context}>
      <div className="toast-viewport" aria-live="polite">
        {items.map((item) => (
          <ToastCard key={item.id} item={item} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}
