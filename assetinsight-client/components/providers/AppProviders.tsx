"use client";

import { ColorModeProvider } from "./ColorModeProvider";

export default function AppProviders({ children }: { children: React.ReactNode }) {
  return <ColorModeProvider>{children}</ColorModeProvider>;
}
