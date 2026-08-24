import Link from "next/link";
import { Gamepad2 } from "lucide-react";

import { buttonClassName } from "@/components/ui/Button";
import { playgroundPath } from "@/lib/routes";

/**
 * The one "Open in playground" affordance. Every surface that deep-links a
 * model into the playground (the model page's API card, Telemetry's
 * first-call section) renders this exact button, so the action reads as the
 * same door wherever it appears: ink, gamepad mark, model preselected.
 */
export function PlaygroundLink({
  modelName,
  className
}: {
  modelName: string;
  className?: string;
}) {
  return (
    <Link className={buttonClassName("primary", className, "sm")} href={playgroundPath(modelName)}>
      <Gamepad2 aria-hidden size={14} strokeWidth={1.8} />
      Open in playground
    </Link>
  );
}
