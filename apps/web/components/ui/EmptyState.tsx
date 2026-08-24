type EmptyStateProps = {
  title: string;
  body: string;
};

export function EmptyState({ title, body }: EmptyStateProps) {
  return (
    <div className="grid min-h-[240px] place-items-center border border-dashed border-line-strong rounded-[var(--radius-lg)] text-muted text-center">
      <div>
        <h2 className="m-0 text-[#474747] text-sm font-medium">{title}</h2>
        <p className="mt-2 max-w-[780px] text-muted text-[13px] leading-relaxed">{body}</p>
      </div>
    </div>
  );
}
