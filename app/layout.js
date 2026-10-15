import { Poppins, DM_Sans, JetBrains_Mono } from 'next/font/google';
import './globals.css';

const display = Poppins({ subsets: ['latin'], weight: ['600', '700', '800'], variable: '--font-display' });
const body = DM_Sans({ subsets: ['latin'], weight: ['400', '500', '700'], variable: '--font-body' });
const mono = JetBrains_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-mono' });

export const metadata = {
  title: 'Yapper — Terminal',
  description: 'Voice trading terminal for Solana. Just yap it.',
};

export const viewport = {
  themeColor: '#000000',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
