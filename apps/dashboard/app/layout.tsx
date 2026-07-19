import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Algo VWAP — CoinDCX Institutional Bot',
  description: 'Live scanner, ranking, positions, and risk dashboard',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="min-h-screen">
          <header className="border-b border-surface-border bg-surface-card/80 backdrop-blur sticky top-0 z-50">
            <div className="mx-auto flex max-w-[1600px] items-center justify-between px-4 py-3">
              <div className="flex items-center gap-3">
                <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-accent-blue to-accent-green" />
                <div>
                  <h1 className="text-lg font-semibold tracking-tight">Algo VWAP</h1>
                  <p className="text-xs text-slate-400">CoinDCX Institutional Scanner</p>
                </div>
              </div>
              <nav className="flex gap-4 text-sm text-slate-300">
                <span className="text-accent-blue">Live Dashboard</span>
              </nav>
            </div>
          </header>
          <main className="mx-auto max-w-[1600px] px-4 py-6">{children}</main>
        </div>
      </body>
    </html>
  );
}
