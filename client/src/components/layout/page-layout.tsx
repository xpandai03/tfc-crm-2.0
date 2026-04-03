import { TopNav } from "./top-nav";

interface PageLayoutProps {
  children: React.ReactNode;
}

export function PageLayout({ children }: PageLayoutProps) {
  return (
    <div className="min-h-screen bg-[hsl(220,20%,96%)] dark:bg-gray-950 relative">
      <TopNav />
      <main className="relative px-6 py-8 md:px-8 md:py-10">
        {children}
      </main>
    </div>
  );
}
