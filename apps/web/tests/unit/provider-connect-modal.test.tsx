import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { ProviderConnectModal } from "@/components/settings/ProviderConnectModal";

function renderModal(overrides?: Partial<Parameters<typeof ProviderConnectModal>[0]>) {
  const onClose = vi.fn();
  const utils = render(
    <ProviderConnectModal
      apiBaseUrl="https://api.test"
      canManage
      connected={false}
      onClose={onClose}
      provider="bedrock"
      status="Not connected"
      webBaseUrl="https://web.test"
      {...overrides}
    >
      <div data-testid="form-body">form</div>
    </ProviderConnectModal>
  );
  return { onClose, ...utils };
}

describe("ProviderConnectModal", () => {
  it("renders the provider's real brand logo in the header", () => {
    const { container } = renderModal({ provider: "openai" });
    // ProviderLogo paints a monochrome brand mark (an svg), not a text glyph —
    // the same mark the models page uses.
    expect(container.querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
  });

  it("shows the credential form children and, for managers, the transfer prompt", () => {
    renderModal({ provider: "bedrock" });
    expect(screen.getByTestId("form-body")).toBeInTheDocument();
    const prompt = screen.getByTestId("provider-transfer-prompt-bedrock");
    expect(prompt).toBeInTheDocument();
    // Collapsed by default; expanding reveals the copy-paste text.
    fireEvent.click(screen.getByRole("button", { name: /Connect from your coding agent/ }));
    expect(prompt).toHaveTextContent("provider-connections/bedrock");
  });

  it("hides the transfer prompt from read-only members", () => {
    renderModal({ provider: "bedrock", canManage: false });
    expect(screen.getByTestId("form-body")).toBeInTheDocument();
    expect(screen.queryByTestId("provider-transfer-prompt-bedrock")).not.toBeInTheDocument();
  });

  it("closes on the close button and on the scrim, not on the panel", () => {
    const { onClose } = renderModal();
    fireEvent.click(screen.getByTestId("form-body"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("moves focus into the dialog on open and restores it to the trigger on close", () => {
    // A trigger that opens the modal, mirroring the provider tile in the panel.
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button data-testid="trigger" onClick={() => setOpen(true)} type="button">
            open
          </button>
          {open && (
            <ProviderConnectModal
              apiBaseUrl="https://api.test"
              canManage
              connected={false}
              onClose={() => setOpen(false)}
              provider="openai"
              status="Not connected"
              webBaseUrl="https://web.test"
            >
              <div data-testid="form-body">form</div>
            </ProviderConnectModal>
          )}
        </>
      );
    }

    render(<Harness />);
    const trigger = screen.getByTestId("trigger");
    trigger.focus();
    expect(trigger).toHaveFocus();

    // Opening moves focus off the background and into the dialog.
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog")).toHaveFocus();

    // Escape closes it and hands focus back to the trigger.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("wraps Tab back inside when the active control is untracked (disabled/panel)", () => {
    // On open the panel (tabIndex -1, not a tracked focusable) holds focus; this
    // is the same "untracked active" state the submit button enters when it goes
    // disabled mid-request. Tab must wrap into the dialog, never out to the page.
    renderModal({ provider: "openai" });
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveFocus();

    fireEvent.keyDown(window, { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(document.body);

    // Re-focus the panel and Shift+Tab wraps to the last control, still inside.
    dialog.focus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(document.body);
  });
});
