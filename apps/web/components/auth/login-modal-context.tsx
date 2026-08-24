"use client";

import {
  createContext,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { LoginModal } from "@/components/auth/LoginModal";
import { PLATFORM_SERVING_BASE_URL } from "@/components/world-models/endpoint-snippets";
import { PLATFORM_WEB_URL } from "@/lib/llms-txt";
import { WELCOME_PARAM } from "@/lib/routes";

// The welcome-reveal marker contract is single-sourced in lib/routes.ts so the
// server `/signup` route and this client listener agree; re-exported here for
// the modal siblings that already import it from this module.
export { WELCOME_PARAM };

type LoginModalApi = {
  /** Opens the login modal in place. No-op for a signed-in user. */
  open: () => void;
  /**
   * The gating primitive (docs/design-system.md "Gating patterns"): runs `fn`
   * immediately when signed in, otherwise opens the modal and runs `fn` after
   * a successful in-modal login. An OAuth login reloads the page, so `fn`
   * cannot survive that path — the surface re-renders signed-in and the modal
   * re-opens on the success step instead.
   */
  requireAuth: (fn: () => void) => void;
};

const LoginModalContext = createContext<LoginModalApi | null>(null);

export function useLoginModal(): LoginModalApi {
  const api = useContext(LoginModalContext);
  if (api === null) {
    throw new Error("useLoginModal must be used under LoginModalProvider (the workspace layout).");
  }
  return api;
}

export type LoginModalStep = "closed" | "form" | "success";

type LoginModalProviderProps = {
  /** Server-derived audience from the mounting layout. */
  isAuthenticated: boolean;
  /**
   * Public web origin for the success step's onboarding prompts. Resolved
   * server-side in the mounting layout; defaults to the hosted platform (the
   * same fallback the base-URL resolvers use) when a caller omits it.
   */
  webBaseUrl?: string;
  /** Public API base URL for the onboarding prompts; hosted platform by default. */
  apiBaseUrl?: string;
  children: ReactNode;
};

/**
 * App-wide host for the login modal: mounted once in the workspace layout so
 * every surface gates through the same hook instead of navigating to /signin.
 */
export function LoginModalProvider({
  isAuthenticated,
  webBaseUrl = PLATFORM_WEB_URL,
  apiBaseUrl = PLATFORM_SERVING_BASE_URL,
  children
}: LoginModalProviderProps) {
  const router = useRouter();
  const [step, setStep] = useState<LoginModalStep>("closed");
  // An in-modal login establishes the session before router.refresh() brings
  // the server-derived prop up to date; the OR keeps the hook truthful in the
  // gap so a gated action clicked right after login runs instead of re-gating.
  const [sessionEstablished, setSessionEstablished] = useState(false);
  const signedIn = isAuthenticated || sessionEstablished;
  const pendingActionRef = useRef<(() => void) | null>(null);

  const open = useCallback(() => {
    if (!signedIn) {
      setStep("form");
    }
  }, [signedIn]);

  const requireAuth = useCallback(
    (fn: () => void) => {
      if (signedIn) {
        fn();
        return;
      }
      pendingActionRef.current = fn;
      setStep("form");
    },
    [signedIn]
  );

  const handleAuthSuccess = useCallback(
    ({ created }: { created: boolean }) => {
      setSessionEstablished(true);
      // A returning login just closes so no modal pops on ordinary sign-ins.
      // A brand-new account advances to the success step, but the reveal itself
      // is gated on the initial key mint (LoginModal): it shows only when the
      // org's first key is actually created, and never again afterwards.
      setStep(created ? "success" : "closed");
      // Re-render the server tree (sidebar account block, page audience) behind
      // the modal; the modal's own state survives the refresh.
      router.refresh();
      const pending = pendingActionRef.current;
      pendingActionRef.current = null;
      pending?.();
    },
    [router]
  );

  const close = useCallback(() => {
    setStep("closed");
    pendingActionRef.current = null;
  }, []);

  // The success step's welcome read (grant + minted key) can resolve only after
  // the new membership is visible to the RLS session, which is later than the
  // early refresh in handleAuthSuccess. Refresh again once it loads so the
  // server-rendered sidebar credit meter shows the welcome grant.
  const onWelcomeLoaded = useCallback(() => {
    router.refresh();
  }, [router]);

  const api = useMemo<LoginModalApi>(() => ({ open, requireAuth }), [open, requireAuth]);

  return (
    <LoginModalContext.Provider value={api}>
      {children}
      {/* useSearchParams needs its own Suspense boundary for prerendering. */}
      <Suspense fallback={null}>
        <WelcomeReturnListener
          isAuthenticated={isAuthenticated}
          onWelcome={() => setStep("success")}
        />
        <LoginModal
          step={step}
          onAuthSuccess={handleAuthSuccess}
          onClose={close}
          webBaseUrl={webBaseUrl}
          apiBaseUrl={apiBaseUrl}
          onWelcomeLoaded={onWelcomeLoaded}
        />
      </Suspense>
    </LoginModalContext.Provider>
  );
}

/**
 * Re-opens the modal on the success step when an OAuth round-trip returns
 * with the welcome marker, then strips the marker so a reload or share of
 * the URL does not replay the celebration. Signed-out (someone typing the
 * marker by hand), the marker is only stripped.
 */
function WelcomeReturnListener({
  isAuthenticated,
  onWelcome
}: {
  isAuthenticated: boolean;
  onWelcome: () => void;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const firedRef = useRef(false);

  useEffect(() => {
    if (firedRef.current || searchParams.get(WELCOME_PARAM) !== "1") {
      return;
    }
    firedRef.current = true;
    if (isAuthenticated) {
      onWelcome();
    }
    const rest = new URLSearchParams(searchParams);
    rest.delete(WELCOME_PARAM);
    const query = rest.toString();
    router.replace(query.length > 0 ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [isAuthenticated, onWelcome, pathname, router, searchParams]);

  return null;
}
