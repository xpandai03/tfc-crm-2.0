import { TopNav } from "./top-nav";

interface PageLayoutProps {
  children: React.ReactNode;
}

export function PageLayout({ children }: PageLayoutProps) {
  return (
    <div className="min-h-screen bg-background">
      <TopNav />
      <main className="px-6 py-8 md:px-8 md:py-10">
        {children}
      </main>
    </div>
  );
}
