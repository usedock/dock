import type { Metadata } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { cn } from "@/lib/utils";
import { PageTitle } from "@/components/dashboard/page-title";

// Same family as the website (Geist / Geist Mono) for brand parity.
const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Self-host bakes no URL: read the public origin per request instead of falling back to the cloud host.
async function metadataOrigin(): Promise<string> {
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL;
  const h = await headers();
  if (process.env.DOCK_PUBLIC_URL) return process.env.DOCK_PUBLIC_URL;
  const host = h.get('x-forwarded-host') ?? h.get('host');
  if (!host) return 'https://dashboard.usedock.io';
  return `${h.get('x-forwarded-proto') ?? 'http'}://${host}`;
}

export async function generateMetadata(): Promise<Metadata> {
  return {
    metadataBase: new URL(await metadataOrigin()),
    // No title here: <PageTitle /> owns it, and a metadata title would replace it on every navigation.
    description: 'Isolated Linux machines for agents. Sign in to manage your docks.',
  };
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={cn("h-full", "antialiased", geistSans.variable, geistMono.variable, "font-sans")}
    >
      <body className="min-h-full flex flex-col">
        <PageTitle />
        {children}
      </body>
    </html>
  );
}
