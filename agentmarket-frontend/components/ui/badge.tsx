import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors",
  {
    variants: {
      variant: {
        default: "border-transparent bg-purple-600/20 text-purple-300",
        open: "border-green-500/30 bg-green-500/10 text-green-400",
        inProgress: "border-blue-500/30 bg-blue-500/10 text-blue-400",
        pending: "border-yellow-500/30 bg-yellow-500/10 text-yellow-400",
        completed: "border-purple-500/30 bg-purple-500/10 text-purple-400",
        disputed: "border-red-500/30 bg-red-500/10 text-red-400",
        zk: "border-purple-500/50 bg-purple-500/20 text-purple-300",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
