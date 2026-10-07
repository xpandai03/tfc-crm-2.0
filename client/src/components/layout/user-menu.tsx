import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Bell, BellOff, LogOut, Upload } from "lucide-react";
import { useLocation } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";

interface NotificationSettings { muted: boolean; enabled: boolean; canManage: boolean }

export function UserMenu() {
  const { user, logout } = useAuth();
  const [, setLocation] = useLocation();
  const { data: notify } = useQuery<NotificationSettings>({
    queryKey: ["/api/notifications/me"],
    enabled: !!user,
  });
  const toggleMute = useMutation({
    mutationFn: async (muted: boolean) =>
      (await apiRequest("PUT", "/api/notifications/me", { muted })).json(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/notifications/me"] }),
  });

  if (!user) {
    return null;
  }

  const isAdmin =
    user.email.endsWith("@tfc.help") ||
    user.email.endsWith("@tfc.health") ||
    user.email.endsWith("@thefamilyconnection.org");

  // Get initials from name
  const initials = user.name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="relative h-8 w-8 rounded-full">
          <Avatar className="h-8 w-8">
            <AvatarFallback className="bg-primary/10 text-primary text-xs font-medium">
              {initials}
            </AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56" align="end" forceMount>
        <DropdownMenuLabel className="font-normal">
          <div className="flex flex-col space-y-1">
            <p className="text-sm font-medium leading-none">{user.name}</p>
            <p className="text-xs leading-none text-muted-foreground">
              {user.email}
            </p>
          </div>
        </DropdownMenuLabel>
        {notify && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={(e) => { e.preventDefault(); toggleMute.mutate(!notify.muted); }}
              disabled={toggleMute.isPending}
              className="cursor-pointer"
            >
              {notify.muted ? <BellOff className="mr-2 h-4 w-4" /> : <Bell className="mr-2 h-4 w-4" />}
              <span>Teams notifications: {notify.muted ? "Off" : "On"}</span>
            </DropdownMenuItem>
            {notify.canManage && (
              <DropdownMenuItem onClick={() => setLocation("/admin/notifications")} className="cursor-pointer">
                <Bell className="mr-2 h-4 w-4" />
                <span>Notification log</span>
              </DropdownMenuItem>
            )}
          </>
        )}
        {isAdmin && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => setLocation("/admin/migrate")}
              className="cursor-pointer"
            >
              <Upload className="mr-2 h-4 w-4" />
              <span>Migrate Data</span>
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={logout} className="cursor-pointer text-destructive focus:text-destructive">
          <LogOut className="mr-2 h-4 w-4" />
          <span>Sign out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
