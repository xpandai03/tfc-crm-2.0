import { useState, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth-context";
import { getStaffList } from "@/lib/api";
import { Check, ChevronDown, User, UserMinus, UserPlus, Loader2 } from "lucide-react";

interface AssignmentSelectorProps {
  contactId: number;
  /** Current assignee value - controlled by parent */
  value: string | null | undefined;
  /** Called immediately when user selects a new assignee (for optimistic update) */
  onChange: (newAssignee: string | null) => void;
  /** Whether an assignment operation is in progress */
  isLoading?: boolean;
}

/**
 * Derive initials from an email address
 */
function getInitialsFromEmail(email: string): string {
  const localPart = email.split("@")[0];
  if (!localPart) return "??";

  const dotParts = localPart.split(".");
  if (dotParts.length >= 2) {
    return (dotParts[0][0] + dotParts[1][0]).toUpperCase();
  }
  return localPart.substring(0, 2).toUpperCase();
}

/**
 * Derive a display name from an email address
 * e.g., "raunek@tfc.help" -> "Raunek"
 * e.g., "jessica.smith@tfc.help" -> "Jessica Smith"
 */
function getNameFromEmail(email: string): string {
  const localPart = email.split("@")[0];
  if (!localPart) return email;

  // Handle firstname.lastname format
  const dotParts = localPart.split(".");
  if (dotParts.length >= 2) {
    return dotParts
      .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join(" ");
  }

  // Single word - capitalize first letter
  return localPart.charAt(0).toUpperCase() + localPart.slice(1).toLowerCase();
}

/**
 * Controlled AssignmentSelector component.
 * Parent owns the state and handles API calls with optimistic updates.
 */
export function AssignmentSelector({
  contactId,
  value,
  onChange,
  isLoading = false,
}: AssignmentSelectorProps) {
  const { toast } = useToast();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [manualEmail, setManualEmail] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Fetch staff list
  const { data: staffData, isLoading: staffLoading } = useQuery({
    queryKey: ["/api/staff-list"],
    queryFn: getStaffList,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });

  const staff = staffData?.staff || [];

  const handleAssign = (email: string | null) => {
    setOpen(false);
    setManualEmail("");
    // Call parent's onChange immediately for optimistic update
    onChange(email);
  };

  const handleAssignToMe = () => {
    if (user?.email) {
      handleAssign(user.email);
    }
  };

  const handleManualAssign = () => {
    const email = manualEmail.trim();
    if (!email) return;

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      toast({
        title: "Invalid email",
        description: "Please enter a valid email address",
        variant: "destructive",
      });
      return;
    }

    handleAssign(email);
  };

  // Focus input when popover opens
  useEffect(() => {
    if (open) {
      setTimeout(() => {
        inputRef.current?.focus();
      }, 100);
    }
  }, [open]);

  const isCurrentUser = value && user?.email &&
    value.toLowerCase() === user.email.toLowerCase();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between"
          disabled={isLoading}
        >
          <div className="flex items-center gap-2">
            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : value ? (
              <Avatar className="h-5 w-5">
                <AvatarFallback className={cn(
                  "text-[10px] font-medium",
                  isCurrentUser ? "bg-primary/20 text-primary" : "bg-muted"
                )}>
                  {getInitialsFromEmail(value)}
                </AvatarFallback>
              </Avatar>
            ) : (
              <User className="h-4 w-4 text-muted-foreground" />
            )}
            <span className={cn(!value && "text-muted-foreground")}>
              {value ? getNameFromEmail(value) : "Unassigned"}
            </span>
          </div>
          <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[280px] p-0" align="start">
        <div className="p-2 space-y-1">
          {/* Assign to Me */}
          {user?.email && (
            <Button
              variant="ghost"
              className="w-full justify-start gap-2"
              onClick={handleAssignToMe}
              disabled={isLoading}
            >
              <UserPlus className="h-4 w-4" />
              Assign to Me
              {isCurrentUser && <Check className="h-4 w-4 ml-auto" />}
            </Button>
          )}

          {/* Unassign */}
          <Button
            variant="ghost"
            className="w-full justify-start gap-2 text-muted-foreground"
            onClick={() => handleAssign(null)}
            disabled={isLoading || !value}
          >
            <UserMinus className="h-4 w-4" />
            Unassign
            {!value && <Check className="h-4 w-4 ml-auto" />}
          </Button>
        </div>

        {/* Staff list */}
        {staff.length > 0 && (
          <>
            <Separator />
            <div className="p-2 max-h-[200px] overflow-y-auto">
              <p className="text-xs text-muted-foreground px-2 py-1">Known Staff</p>
              {staffLoading ? (
                <div className="flex items-center justify-center py-4">
                  <Loader2 className="h-4 w-4 animate-spin" />
                </div>
              ) : (
                <div className="space-y-1">
                  {staff.map((email) => {
                    const isSelected = value?.toLowerCase() === email.toLowerCase();
                    const initials = getInitialsFromEmail(email);
                    const displayName = getNameFromEmail(email);
                    return (
                      <Button
                        key={email}
                        variant={isSelected ? "secondary" : "ghost"}
                        className="w-full justify-start gap-2"
                        onClick={() => handleAssign(email)}
                        disabled={isLoading}
                      >
                        <Avatar className="h-5 w-5">
                          <AvatarFallback className="text-[10px] font-medium">
                            {initials}
                          </AvatarFallback>
                        </Avatar>
                        <div className="flex flex-col items-start min-w-0 flex-1">
                          <span className="truncate text-sm font-medium">{displayName}</span>
                          <span className="truncate text-xs text-muted-foreground">{email}</span>
                        </div>
                        {isSelected && <Check className="h-4 w-4 ml-auto shrink-0" />}
                      </Button>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}

        {/* Manual entry */}
        <Separator />
        <div className="p-2 space-y-2">
          <p className="text-xs text-muted-foreground px-2">Assign to other</p>
          <div className="flex gap-2">
            <Input
              ref={inputRef}
              type="email"
              placeholder="email@tfc.help"
              value={manualEmail}
              onChange={(e) => setManualEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  handleManualAssign();
                }
              }}
              className="h-8 text-sm"
            />
            <Button
              size="sm"
              onClick={handleManualAssign}
              disabled={!manualEmail.trim() || isLoading}
            >
              Add
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
