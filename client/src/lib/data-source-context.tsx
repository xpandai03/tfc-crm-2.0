import { createContext, useContext, useState, useCallback } from "react";

export type DataSource = "mock" | "live" | "fallback";
export type DataMode = "mock" | "live";

interface DataSourceContextType {
  dataMode: DataMode;
  lastSource: DataSource;
  lastSyncTime: Date | null;
  isFallback: boolean;
  updateSource: (source: DataSource) => void;
  updateSyncTime: () => void;
}

const DataSourceContext = createContext<DataSourceContextType | undefined>(undefined);

export function DataSourceProvider({ children }: { children: React.ReactNode }) {
  const [dataMode, setDataMode] = useState<DataMode>("mock");
  const [lastSource, setLastSource] = useState<DataSource>("mock");
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null);

  const updateSource = useCallback((source: DataSource) => {
    setLastSource(source);
    if (source === "live") {
      setDataMode("live");
    } else if (source === "mock") {
      setDataMode("mock");
    }
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
        updateSource,
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
