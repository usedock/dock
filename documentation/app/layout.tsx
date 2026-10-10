import type { Metadata } from 'next';
import { IBM_Plex_Mono, Manrope } from 'next/font/google';
import { RootProvider } from 'fumadocs-ui/provider/next';
import './global.css';

const manrope = Manrope({ subsets: ['latin'], variable: '--font-manrope', display: 'swap' });
const ibmPlexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  variable: '--font-ibm-plex-mono',
  weight: ['400', '500'],
  display: 'swap',
});

export const metadata: Metadata = {
  metadataBase: new URL('https://docs.usedock.io'),
  title: { default: 'Dock Docs', template: '%s | Dock Docs' },
  description: 'Guides and API reference for Dock, open-source sandbox infrastructure for agents.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${manrope.variable} ${ibmPlexMono.variable}`} suppressHydrationWarning>
      <body className="flex min-h-screen flex-col font-[family-name:var(--font-manrope)] antialiased">
        <RootProvider search={{ options: { type: 'static' } }}>{children}</RootProvider>
      </body>
    </html>
  );
}
