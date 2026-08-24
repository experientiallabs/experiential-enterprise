import type { ComponentPropsWithoutRef } from "react";
import { clsx } from "clsx";

type CardProps = ComponentPropsWithoutRef<"section"> & {
  subtle?: boolean;
};

export function Card({ children, className, subtle = false, ...props }: CardProps) {
  return (
    <section
      {...props}
      className={clsx("border border-line rounded-[var(--radius-lg)] bg-surface p-[18px]", subtle && "shadow-none", className)}
    >
      {children}
    </section>
  );
}
