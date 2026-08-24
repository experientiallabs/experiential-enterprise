import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ErrorTile } from "@/components/ui/ErrorTile";

describe("ErrorTile", () => {
  it("renders the title, message, and raw error detail", () => {
    render(
      <ErrorTile
        title="World model build failed"
        message="The worker stopped before completing this run."
        detail="cannot import name 'run_session'"
      />
    );

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("World model build failed")).toBeInTheDocument();
    expect(screen.getByText("cannot import name 'run_session'")).toBeInTheDocument();
  });

  it("omits the retry button when no handler is provided", () => {
    render(<ErrorTile title="Failed" detail="boom" />);

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("calls onRetry when the retry button is clicked", () => {
    const onRetry = vi.fn();
    render(<ErrorTile title="Failed" detail="boom" onRetry={onRetry} />);

    screen.getByRole("button", { name: /try again/i }).click();

    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
