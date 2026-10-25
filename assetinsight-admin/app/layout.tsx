import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import AdminThemeProvider from "@/app/components/providers/AdminThemeProvider";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Asset Insight Admin",
  description: "Asset Insight Admin",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased min-h-screen`}
      >
        <AdminThemeProvider>{children}</AdminThemeProvider>
      </body>
    </html>
  );
}
