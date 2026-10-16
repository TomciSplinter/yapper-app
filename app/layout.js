import { Geist, Geist_Mono, Poppins } from 'next/font/google';
import './globals.css';

const ui = Geist({ subsets: ['latin'], variable: '--font-ui' });
const mono = Geist_Mono({ subsets: ['latin'], variable: '--font-mono' });
const brand = Poppins({ subsets: ['latin'], weight: ['800'], variable: '--font-brand' });

export const metadata = {
  title: 'Yapper Terminal',
  description: 'Trade Solana coins from one fast terminal. Voice trading is coming soon.',
};

export const viewport = {
  themeColor: '#000000',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${ui.variable} ${mono.variable} ${brand.variable}`}>
      <body>{children}</body>
    </html>
  );
}
