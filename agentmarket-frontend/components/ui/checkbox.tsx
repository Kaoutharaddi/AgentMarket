"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Check } from "lucide-react";

interface CheckboxProps {
  id?: string;
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  className?: string;
}

const Checkbox = React.forwardRef<HTMLButtonElement, CheckboxProps>(
  ({ id, checked, onCheckedChange, className }, ref) => {
    return (
      <button
        ref={ref}
        id={id}
        role="checkbox"
        aria-checked={checked}
        onClick={() => onCheckedChange?.(!checked)}
        className={cn(
          "h-4 w-4 shrink-0 rounded border border-border bg-background transition-all",
          "focus:outline-none focus:ring-2 focus:ring-purple-500/30",
          checked && "border-purple-500 bg-purple-600",
          className
        )}
      >
        {checked && <Check className="h-3 w-3 text-white" strokeWidth={3} />}
      </button>
    );
  }
);
Checkbox.displayName = "Checkbox";

export { Checkbox };
