import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  // Whitespace-nowrap: Badges should never wrap.
  "whitespace-nowrap inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2" +
  " hover-elevate hover:scale-105",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary/90 backdrop-blur-sm text-primary-foreground shadow-md hover:shadow-lg",
        secondary: "border-transparent bg-secondary/80 backdrop-blur-sm text-secondary-foreground border-white/40 dark:border-gray-700/40 shadow-md",
        destructive:
          "border-transparent bg-destructive/90 backdrop-blur-sm text-destructive-foreground shadow-md hover:shadow-lg",

        outline: "border [border-color:var(--badge-outline)] backdrop-blur-sm shadow-md bg-white/60 dark:bg-gray-800/60",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants }
