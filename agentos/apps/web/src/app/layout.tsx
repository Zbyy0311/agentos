import type { Metadata } from 'next';
import './globals.css';
import { ThemeProvider } from '@/components/theme/ThemeProvider';

export const metadata: Metadata = {
  title: 'AgentOS',
  description: 'Multi-Agent Orchestration Platform',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `try { var savedTheme = localStorage.getItem('agentos-theme'); document.documentElement.dataset.theme = savedTheme === 'light' || savedTheme === 'dark' ? savedTheme : 'dark'; } catch (error) { document.documentElement.dataset.theme = 'dark'; }`,
          }}
        />
      </head>
      <body className="h-screen overflow-hidden app-shell" suppressHydrationWarning>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
