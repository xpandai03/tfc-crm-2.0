import { createContext, useContext, useState, useCallback } from "react";
import { QueryClient } from "@tanstack/react-query";

export type DataSource = "mock" | "live" | "fallback";
export type DataMode = "mock" | "live";

/**
 * NOTE:
 * Kanban requires contact-level rows.
 * Aggregates alone are insufficient.
 * Do NOT mark Kanban as live unless rows come from Excel-backed source.
 */

interface EnableLiveResult {
  success: boolean;
  partial?: boolean;
}

interface DataSourceContextType {
  dataMode: DataMode;
  lastSource: DataSource;
  lastSyncTime: Date | null;
  isFallback: boolean;
  isEnablingLive: boolean;
  summarySource: DataSource;
  contactsSource: DataSource;
  isContactsLive: boolean;
  isFullyLive: boolean;
  updateSource: (source: DataSource) => void;
  updateSummarySource: (source: DataSource) => void;
  updateContactsSource: (source: DataSource) => void;
  updateSyncTime: () => void;
  enableLiveMode: (queryClient: QueryClient) => Promise<EnableLiveResult>;
  disableLiveMode: () => void;
}

const DataSourceContext = createContext<DataSourceContextType | undefined>(undefined);

export function DataSourceProvider({ children }: { children: React.ReactNode }) {
  const [dataMode, setDataMode] = useState<DataMode>("mock");
  const [lastSource, setLastSource] = useState<DataSource>("mock");
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null);
  const [summarySource, setSummarySource] = useState<DataSource>("mock");
  const [contactsSource, setContactsSource] = useState<DataSource>("mock");
  const [isEnablingLive, setIsEnablingLive] = useState(false);

  const updateSource = useCallback((source: DataSource) => {
    setLastSource(source);
  }, []);

  const updateSummarySource = useCallback((source: DataSource) => {
    setSummarySource(source);
    setLastSource(source);
  }, []);

  const updateContactsSource = useCallback((source: DataSource) => {
    setContactsSource(source);
  }, []);

  const updateSyncTime = useCallback(() => {
    setLastSyncTime(new Date());
  }, []);

  const enableLiveMode = useCallback(async (queryClient: QueryClient): Promise<EnableLiveResult> => {
    setIsEnablingLive(true);
    try {
      // Test the live connection by fetching both summary and contacts
      const [summaryResponse, contactsResponse] = await Promise.all([
        fetch("/api/get-waitlist-summary", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }),
        fetch("/api/waitlist-contacts"),
      ]);
      
      if (!summaryResponse.ok) {
        setIsEnablingLive(false);
        return { success: false };
      }
      
      const summaryData = await summaryResponse.json();
      const contactsData = contactsResponse.ok ? await contactsResponse.json() : null;
      
      const summaryIsLive = summaryData._source === "live";
      const contactsAreLive = contactsData?._source === "live";
      
      // Only succeed if BOTH are live - this ensures Kanban actually works
      if (summaryIsLive && contactsAreLive) {
        // CRITICAL: Hydrate cache FIRST, before updating state
        // This ensures Kanban has live rows when it unlocks
        queryClient.setQueryData(["/api/waitlist-summary"], summaryData);
        queryClient.setQueryData(["/api/waitlist-contacts"], contactsData);
        
        // Invalidate contact detail queries to refresh them
        await queryClient.invalidateQueries({ queryKey: ["/api/contact"] });
        
        // NOW update state - Kanban will unlock with live data already in cache
        setDataMode("live");
        setSummarySource("live");
        setContactsSource("live");
        setLastSource("live");
        setLastSyncTime(new Date());
        setIsEnablingLive(false);
        return { success: true };
      } else if (summaryIsLive) {
        // Partial success - summary is live but contacts are not
        // Keep mock mode but update sources for accurate display
        setSummarySource("live");
        if (contactsData?._source) {
          setContactsSource(contactsData._source);
        }
        setIsEnablingLive(false);
        return { success: false, partial: true };
      } else {
        // Neither is live - stay in mock mode
        setIsEnablingLive(false);
        return { success: false };
      }
    } catch (error) {
      console.error("Failed to enable live mode:", error);
      setIsEnablingLive(false);
      return { success: false };
    }
  }, []);

  const disableLiveMode = useCallback(() => {
    setDataMode("mock");
    setSummarySource("mock");
    setContactsSource("mock");
    setLastSource("mock");
  }, []);

  const isContactsLive = contactsSource === "live";
  const isFullyLive = dataMode === "live" && summarySource === "live" && isContactsLive;

  return (
    <DataSourceContext.Provider
      value={{
        dataMode,
        lastSource,
        lastSyncTime,
        isFallback: lastSource === "fallback",
        isEnablingLive,
        summarySource,
        contactsSource,
        isContactsLive,
        isFullyLive,
        updateSource,
        updateSummarySource,
        updateContactsSource,
        updateSyncTime,
        enableLiveMode,
        disableLiveMode,
      }}
    >
      {children}
    </DataSourceContext.Provider>
  );
}

export function useDataSource() {
  const context = useContext(DataSourceContext);
  if (context === undefined) {
    throw new Error("useDataSource must be used within a DataSourceProvider");
  }
  return context;
}
