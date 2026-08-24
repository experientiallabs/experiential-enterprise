"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, LogOut } from "lucide-react";

type SignOutButtonProps = {
  userEmail: string;
  isCollapsed?: boolean;
};

export function SignOutButton({ userEmail, isCollapsed }: SignOutButtonProps) {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function signOut() {
    setIsSubmitting(true);
    try {
      await fetch("/auth/sign-out", { method: "POST" });
    } catch {
      // Network-level failure: the session is still live, so stay put and
      // let the user retry instead of leaking an unhandled rejection.
      setIsSubmitting(false);
      return;
    }
    // The signed-out home is the public catalog at "/"; nothing in the app
    // navigates to /signin anymore (it stays for invite links only).
    router.push("/");
    router.refresh();
    setIsSubmitting(false);
  }

  if (isCollapsed) {
    return (
      <button
        aria-label={`Sign out ${userEmail}`}
        className="grid w-7 h-7 place-items-center border-0 rounded-full bg-transparent cursor-pointer p-0 hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-60"
        disabled={isSubmitting}
        onClick={signOut}
        type="button"
      >
        <span className="grid w-[22px] h-[22px] place-items-center rounded-full bg-line-strong text-[#404040] text-[9px] font-bold" aria-hidden>
          {userEmail.slice(0, 1).toUpperCase()}
        </span>
      </button>
    );
  }

  return (
    <button
      aria-label={`Sign out ${userEmail}`}
      className="flex w-full items-center gap-2.5 px-2.5 py-[7px] border-0 rounded-lg bg-transparent text-foreground/50 cursor-pointer text-[13px] font-normal text-left hover:bg-foreground/[0.02] hover:text-foreground/70 disabled:cursor-not-allowed disabled:opacity-60 transition-colors max-[900px]:w-auto"
      disabled={isSubmitting}
      onClick={signOut}
      type="button"
    >
      <span className="grid w-[20px] h-[20px] place-items-center rounded-full bg-line-strong text-[#404040] text-[9px] font-bold shrink-0" aria-hidden>
        {userEmail.slice(0, 1).toUpperCase()}
      </span>
      {/* The email drops in the top-bar shape; the avatar plus sign-out icon carry it. */}
      <span className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap max-[900px]:hidden">{userEmail}</span>
      {isSubmitting ? <Loader2 aria-hidden size={13} className="shrink-0 text-foreground/30" /> : <LogOut aria-hidden size={13} className="shrink-0 text-foreground/30" />}
    </button>
  );
}
