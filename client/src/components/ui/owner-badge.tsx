import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface OwnerBadgeProps {
  email: string | null | undefined;
  currentUserEmail?: string;
  showUnassigned?: boolean;
  size?: "sm" | "md";
}

/**
 * Derive initials from an email address
 * e.g., "jsmith@tfc.help" -> "JS"
 */
function getInitialsFromEmail(email: string): string {
  const localPart = email.split("@")[0];
  if (!localPart) return "??";

  // Try to extract initials from common email formats
  // Format: firstname.lastname@domain or firstnamelastname@domain
  const dotParts = localPart.split(".");
  if (dotParts.length >= 2) {
    // firstname.lastname format
    return (dotParts[0][0] + dotParts[1][0]).toUpperCase();
  }

  // Format: flastname or firstlast (single word)
  // Take first two chars
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

export function OwnerBadge({
  email,
  currentUserEmail,
  showUnassigned = false,
  size = "md",
}: OwnerBadgeProps) {
  const isCurrentUser = email && currentUserEmail && email.toLowerCase() === currentUserEmail.toLowerCase();

  // Handle unassigned state
  if (!email || email.trim() === "") {
    if (!showUnassigned) return null;
    return (
      <div className={cn(
        "flex items-center gap-1",
        size === "sm" && "text-[10px]",
        size === "md" && "text-xs"
      )}>
        <span className="text-muted-foreground italic">Unassigned</span>
      </div>
    );
  }

  const initials = getInitialsFromEmail(email);
  const displayText = isCurrentUser ? "You" : initials;

  const sizeClasses = {
    sm: "h-5 w-5 text-[10px]",
    md: "h-6 w-6 text-xs",
  };

  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-1.5 cursor-default">
          <Avatar className={cn(sizeClasses[size], "shrink-0")}>
            <AvatarFallback
              className={cn(
                "font-medium",
                isCurrentUser
                  ? "bg-primary/20 text-primary"
                  : "bg-muted text-muted-foreground"
              )}
            >
              {displayText}
            </AvatarFallback>
          </Avatar>
          {isCurrentUser && (
            <span className={cn(
              "font-medium text-primary",
              size === "sm" && "text-[10px]",
              size === "md" && "text-xs"
            )}>
              You
            </span>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        <div className="flex flex-col">
          <span className="font-medium">{getNameFromEmail(email)}</span>
          <span className="text-muted-foreground">{email}</span>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
