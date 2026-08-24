"use client";

import { clsx } from "clsx";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

// The right-hand heading rail: reads the rendered article's h2/h3 elements
// (any with an id) after each navigation, so content pages get a rail by just
// writing headings with ids — no per-page registration. Hidden when a page
// has fewer than two headings; scroll position drives the active item via
// IntersectionObserver when the browser provides one.

type Heading = {
  id: string;
  text: string;
  level: number;
};

export function OnThisPage() {
  const pathname = usePathname();
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    const article = document.getElementById("docs-article");
    const found = Array.from(article?.querySelectorAll("h2[id], h3[id]") ?? []).map(
      (element) => ({
        id: element.id,
        text: element.textContent ?? "",
        level: element.tagName === "H3" ? 3 : 2
      })
    );
    setHeadings(found);
    setActiveId(found[0]?.id ?? null);
    if (found.length === 0 || typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.find((entry) => entry.isIntersecting);
        if (visible) {
          setActiveId(visible.target.id);
        }
      },
      // Trigger when a heading crosses the upper quarter of the viewport.
      { rootMargin: "0% 0% -75% 0%" }
    );
    for (const heading of found) {
      const element = document.getElementById(heading.id);
      if (element) {
        observer.observe(element);
      }
    }
    return () => observer.disconnect();
  }, [pathname]);

  if (headings.length < 2) {
    return null;
  }
  return (
    <nav aria-label="On this page">
      <p className="mono-label m-0 mb-2">On this page</p>
      <ul className="m-0 flex list-none flex-col gap-1.5 border-l border-line p-0">
        {headings.map((heading) => (
          <li key={heading.id}>
            <a
              className={clsx(
                "-ml-px block border-l pr-2 text-[12.5px] leading-snug",
                heading.level === 3 ? "pl-6" : "pl-3",
                heading.id === activeId
                  ? "border-accent text-accent"
                  : "border-transparent text-muted hover:text-ink"
              )}
              href={`#${heading.id}`}
            >
              {heading.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
