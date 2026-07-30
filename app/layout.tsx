import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Simple Sigma - Treasury Workbench',
  description: 'Smart decisions for financing and hedging, liquidity investment management. Interactive treasury workbench for Market Risk, Investment, Asset/Liability management and other Treasury decision making.'
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}
