import { useState, useEffect } from "react";
import LoadingLines from "./loading-lines";

const PHRASES = {
  today: [
    "Gathering your data...",
    "Checking Excel...",
    "Loading priorities...",
    "Preparing your workspace...",
  ],
  waitlist: [
    "Reviewing the waitlist...",
    "Loading contact queue...",
    "Checking statuses...",
    "Syncing pipeline...",
  ],
  insights: [
    "Analyzing trends...",
    "Crunching numbers...",
    "Preparing analytics...",
    "Reviewing patterns...",
  ],
  providers: [
    "Loading provider data...",
    "Reading spreadsheet...",
    "Preparing provider list...",
    "Syncing capabilities...",
  ],
};

interface PageLoaderProps {
  context: "today" | "waitlist" | "insights" | "providers";
}

export function PageLoader({ context }: PageLoaderProps) {
  const [phraseIndex, setPhraseIndex] = useState(0);
  const [isVisible, setIsVisible] = useState(true);
  const phrases = PHRASES[context];

  useEffect(() => {
    const interval = setInterval(() => {
      setIsVisible(false);
      setTimeout(() => {
        setPhraseIndex((prev) => (prev + 1) % phrases.length);
        setIsVisible(true);
      }, 300);
    }, 2000);
    return () => clearInterval(interval);
  }, [phrases.length]);

  return (
    <div className="flex flex-col items-center justify-center min-h-[calc(100vh-12rem)]">
      <LoadingLines />
      <p
        className={`text-sm text-muted-foreground mt-4 transition-opacity duration-300 ${
          isVisible ? "opacity-100" : "opacity-0"
        }`}
      >
        {phrases[phraseIndex]}
      </p>
    </div>
  );
}
