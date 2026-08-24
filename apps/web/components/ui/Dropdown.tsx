import type { SelectHTMLAttributes } from "react";

const DROPDOWN_CLASS =
  "border border-line-strong rounded-md bg-surface text-ink cursor-pointer text-[13px] font-semibold min-h-[34px] px-2.5";

export function Dropdown({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={className ? `${DROPDOWN_CLASS} ${className}` : DROPDOWN_CLASS} {...props} />;
}
