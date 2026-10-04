/**
 * Shared bext Tailwind v4 theme configuration.
 *
 * Returns the CSS preamble with @import + @theme + @variant directives
 * that define all bext design tokens for Tailwind v4's compile() API.
 */

export const bextThemeCSS = `@import "tailwindcss";

@theme {
  --color-bext-black: #0a0a0a;
  --color-bext-white: #fafafa;
  --color-bext-accent: #0c0c0c;
  --color-bext-accent-2: #10b981;
  --color-bext-error: #ef4444;
  --color-bext-warning: #f59e0b;
  --color-bext-success: #10b981;
  --color-bext-info: #3b82f6;
  --color-bext-cloud: #8b5cf6;
  --color-bext-registry: #f59e0b;
  --color-bext-learn: #10b981;
  --color-bext-companion: #6366f1;
  --font-sans: "Inter", system-ui, -apple-system, sans-serif;
  --font-mono: "JetBrains Mono", "Fira Code", monospace;
}

@variant dark (&:where(.dark, .dark *));
`;
