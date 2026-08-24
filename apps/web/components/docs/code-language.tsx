"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

// One language selection shared by every CodeTabs block on a page: pick Python
// in one block and all of them switch, so a reader never re-picks per block.
// The provider mounts once in DocsShell.

export type CodeLanguage = "curl" | "python" | "javascript";

export const CODE_LANGUAGES: readonly { id: CodeLanguage; label: string }[] = [
  { id: "curl", label: "curl" },
  { id: "python", label: "Python" },
  { id: "javascript", label: "JavaScript" }
];

type CodeLanguageContextValue = {
  language: CodeLanguage;
  setLanguage: (language: CodeLanguage) => void;
};

const CodeLanguageContext = createContext<CodeLanguageContextValue | null>(null);

export function CodeLanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<CodeLanguage>("curl");
  return (
    <CodeLanguageContext.Provider value={{ language, setLanguage }}>
      {children}
    </CodeLanguageContext.Provider>
  );
}

export function useCodeLanguage(): CodeLanguageContextValue {
  const value = useContext(CodeLanguageContext);
  if (value === null) {
    throw new Error("useCodeLanguage requires a CodeLanguageProvider (DocsShell mounts one).");
  }
  return value;
}
