import { Component, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

interface Props {
  children: ReactNode;
  contactName?: string;
}

interface State {
  hasError: boolean;
  error?: Error;
}

/**
 * Error boundary specifically for the Timeline component.
 * Catches rendering errors and displays a fallback UI instead of crashing.
 */
export class TimelineErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // Log the error for debugging
    console.error("[TimelineErrorBoundary] Caught rendering error:", {
      error: error.message,
      stack: error.stack,
      contactName: this.props.contactName,
      componentStack: errorInfo.componentStack,
    });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center py-8 text-center border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800 rounded-lg">
          <div className="w-10 h-10 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center mb-3">
            <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400" />
          </div>
          <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
            Unable to load activity timeline
          </p>
          <p className="text-xs text-amber-600 dark:text-amber-400 mt-1 max-w-xs">
            There was a problem displaying this contact's activity. The rest of the page should work normally.
          </p>
          {this.props.contactName && (
            <p className="text-[10px] text-amber-500 dark:text-amber-500 mt-2">
              Contact: {this.props.contactName}
            </p>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}
