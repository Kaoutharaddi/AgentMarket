"use client";

import { useEffect, useState, useCallback } from "react";
import { AuditCard } from "@/components/AuditCard";
import { Button } from "@/components/ui/button";
import { getReadOnlyProgram, type JobWithPubkey } from "@/lib/anchor";
import {
  LayoutGrid,
  RefreshCw,
  AlertCircle,
  ShoppingBag,
} from "lucide-react";
import Link from "next/link";

type FilterStatus = "all" | "open" | "inProgress" | "completed";

const filterLabels: Record<FilterStatus, string> = {
  all: "All Jobs",
  open: "Open",
  inProgress: "In Progress",
  completed: "Completed",
};

export default function MarketplacePage() {
  const [jobs, setJobs] = useState<JobWithPubkey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterStatus>("all");
  const [refreshing, setRefreshing] = useState(false);

  const fetchJobs = useCallback(async () => {
    setError(null);
    try {
      const program = getReadOnlyProgram();
      const allJobs = await (program.account as any).job.all();
      setJobs(allJobs as JobWithPubkey[]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to fetch jobs";
      setError(msg);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchJobs();
  }, [fetchJobs]);

  async function handleRefresh() {
    setRefreshing(true);
    await fetchJobs();
  }

  const filteredJobs = jobs.filter((job) => {
    if (filter === "all") return true;
    if (filter === "open") return "open" in job.account.status;
    if (filter === "inProgress") return "inProgress" in job.account.status;
    if (filter === "completed") return "completed" in job.account.status;
    return true;
  });

  const counts = {
    all: jobs.length,
    open: jobs.filter((j) => "open" in j.account.status).length,
    inProgress: jobs.filter((j) => "inProgress" in j.account.status).length,
    completed: jobs.filter((j) => "completed" in j.account.status).length,
  };

  return (
    <div className="min-h-screen px-4 py-10 sm:px-6">
      <div className="mx-auto max-w-7xl">
        {/* Header */}
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="mb-1 flex items-center gap-2">
              <LayoutGrid className="h-5 w-5 text-purple-400" />
              <h1 className="text-2xl font-bold text-white">Audit Marketplace</h1>
            </div>
            <p className="text-sm text-zinc-500">
              Browse open smart contract audits on Solana Devnet
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleRefresh}
              disabled={refreshing}
              className="gap-2"
            >
              <RefreshCw
                className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
              />
              Refresh
            </Button>
            <Link href="/submit">
              <Button size="sm">Post Audit</Button>
            </Link>
          </div>
        </div>

        {/* Filter tabs */}
        <div className="mb-6 flex gap-2 overflow-x-auto pb-1">
          {(Object.keys(filterLabels) as FilterStatus[]).map((key) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={`whitespace-nowrap rounded-lg px-4 py-2 text-sm font-medium transition-all ${
                filter === key
                  ? "bg-purple-600 text-white"
                  : "border border-border bg-surface text-zinc-400 hover:border-purple-500/40 hover:text-white"
              }`}
            >
              {filterLabels[key]}
              <span
                className={`ml-2 rounded-full px-1.5 py-0.5 text-xs ${
                  filter === key ? "bg-purple-500/40" : "bg-white/10"
                }`}
              >
                {counts[key]}
              </span>
            </button>
          ))}
        </div>

        {/* Loading state */}
        {loading && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[...Array(6)].map((_, i) => (
              <div
                key={i}
                className="h-64 rounded-xl border border-border bg-surface animate-pulse"
              />
            ))}
          </div>
        )}

        {/* Error state */}
        {!loading && error && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full border border-red-500/20 bg-red-500/10">
              <AlertCircle className="h-6 w-6 text-red-400" />
            </div>
            <p className="mb-2 font-medium text-white">Failed to load jobs</p>
            <p className="mb-6 text-sm text-zinc-500">{error}</p>
            <Button variant="outline" onClick={handleRefresh}>
              Try again
            </Button>
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && filteredJobs.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full border border-border bg-surface">
              <ShoppingBag className="h-6 w-6 text-zinc-500" />
            </div>
            <p className="mb-2 font-medium text-white">
              {filter === "all" ? "No jobs found" : `No ${filterLabels[filter]} jobs`}
            </p>
            <p className="mb-6 text-sm text-zinc-500">
              {filter === "all"
                ? "Be the first to submit a smart contract audit"
                : "Try changing the filter"}
            </p>
            {filter === "all" && (
              <Link href="/submit">
                <Button>Post First Audit</Button>
              </Link>
            )}
          </div>
        )}

        {/* Jobs grid */}
        {!loading && !error && filteredJobs.length > 0 && (
          <>
            <p className="mb-4 text-sm text-zinc-500">
              Showing {filteredJobs.length} job
              {filteredJobs.length !== 1 ? "s" : ""}
            </p>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filteredJobs.map((job) => (
                <AuditCard
                  key={job.publicKey.toBase58()}
                  job={job}
                  onClaimed={handleRefresh}
                  onCancelled={handleRefresh}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
