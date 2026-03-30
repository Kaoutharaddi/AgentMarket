import { Badge } from "./ui/badge";
import type { JobStatus } from "@/lib/anchor";
import { getStatusLabel } from "@/lib/anchor";
import { Shield, Clock, Loader, CheckCircle, AlertTriangle } from "lucide-react";

interface StatusBadgeProps {
  status: JobStatus;
}

const statusConfig = {
  Open: {
    variant: "open" as const,
    Icon: Clock,
    dot: "bg-green-400",
  },
  "In Progress": {
    variant: "inProgress" as const,
    Icon: Loader,
    dot: "bg-blue-400",
  },
  "Pending Verification": {
    variant: "pending" as const,
    Icon: Shield,
    dot: "bg-yellow-400",
  },
  Completed: {
    variant: "completed" as const,
    Icon: CheckCircle,
    dot: "bg-purple-400",
  },
  Disputed: {
    variant: "disputed" as const,
    Icon: AlertTriangle,
    dot: "bg-red-400",
  },
};

export function StatusBadge({ status }: StatusBadgeProps) {
  const label = getStatusLabel(status);
  const config = statusConfig[label as keyof typeof statusConfig] ?? {
    variant: "default" as const,
    Icon: Clock,
    dot: "bg-zinc-400",
  };

  const { variant, Icon } = config;

  return (
    <Badge variant={variant}>
      <Icon className="h-3 w-3" />
      {label}
    </Badge>
  );
}

export function ZkVerifiedBadge() {
  return (
    <Badge variant="zk">
      <Shield className="h-3 w-3" />
      ZK Verified
    </Badge>
  );
}
