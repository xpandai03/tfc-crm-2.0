import { createContext, useContext, useState, useCallback } from "react";

export type DataSource = "mock" | "live" | "fallback";
export type DataMode = "mock" | "live";

/**
 * NOTE:
 * Kanban requires contact-level rows.
 * Aggregates alone are insufficient.
 * Do NOT mark Kanban as live unless rows come from Excel-backed source.
 */

interface DataSourceContextType {
  dataMode: DataMode;
  lastSource: DataSource;
  lastSyncTime: Date | null;
  isFallback: boolean;
  // Per-screen data source tracking
  summarySource: DataSource;
  contactsSource: DataSource;
  // Check if contacts are truly live (not fallback/mock)
  isContactsLive: boolean;
  // Legacy method (kept for backward compatibility)
  updateSource: (source: DataSource) => void;
  // Per-screen source tracking
  updateSummarySource: (source: DataSource) => void;
  updateContactsSource: (source: DataSource) => void;
  updateSyncTime: () => void;
}

const DataSourceContext = createContext<DataSourceContextType | undefined>(undefined);

export function DataSourceProvider({ children }: { children: React.ReactNode }) {
  const [dataMode, setDataMode] = useState<DataMode>("mock");
  const [lastSource, setLastSource] = useState<DataSource>("mock");
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null);
  const [summarySource, setSummarySource] = useState<DataSource>("mock");
  const [contactsSource, setContactsSource] = useState<DataSource>("mock");

  // Legacy method - kept for backward compatibility
  const updateSource = useCallback((source: DataSource) => {
    setLastSource(source);
    if (source === "live") {
      setDataMode("live");
    } else if (source === "mock") {
      setDataMode("mock");
    }
  }, []);

  const updateSummarySource = useCallback((source: DataSource) => {
    setSummarySource(source);
    setLastSource(source);
    if (source === "live") {
      setDataMode("live");
    }
  }, []);

  const updateContactsSource = useCallback((source: DataSource) => {
    setContactsSource(source);
  }, []);

  const updateSyncTime = useCallback(() => {
    setLastSyncTime(new Date());
  }, []);

  return (
    <DataSourceContext.Provider
      value={{
        dataMode,
        lastSource,
        lastSyncTime,
        isFallback: lastSource === "fallback",
        summarySource,
        contactsSource,
        isContactsLive: contactsSource === "live",
        updateSource,
        updateSummarySource,
        updateContactsSource,
        updateSyncTime,
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
