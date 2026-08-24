"use client";

import { ErrorTile } from "@/components/ui/ErrorTile";

type AppErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function AppError({ error, reset }: AppErrorProps) {
  return (
    <div className="flex items-center justify-center min-h-screen p-8">
      <div className="max-w-[36rem] w-full">
        <ErrorTile
          title="Couldn't reach the Experiential backend"
          message="This page needs the Experiential backend. If you're viewing a preview deployment it may not be fully configured, or the backend may be starting up."
          detail={error.message}
          onRetry={reset}
        />
      </div>
    </div>
  );
}
