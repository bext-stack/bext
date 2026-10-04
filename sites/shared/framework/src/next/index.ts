/**
 * Next.js compatibility layer for PRISM.
 *
 * Provides shims for the most common next/* imports so existing
 * Next.js apps can run on PRISM with minimal changes.
 *
 * Setup in tsconfig.json:
 *   {
 *     "compilerOptions": {
 *       "paths": {
 *         "next/link": ["@bext-stack/framework/next/link"],
 *         "next/image": ["@bext-stack/framework/next/image"],
 *         "next/navigation": ["@bext-stack/framework/next/navigation"],
 *         "next/headers": ["@bext-stack/framework/next/headers"],
 *         "next/font/google": ["@bext-stack/framework/next/font"],
 *         "next/font/local": ["@bext-stack/framework/next/font"]
 *       }
 *     }
 *   }
 *
 * Or use PRISM's auto-detection: if the site has no next.config.js
 * but imports from "next/*", PRISM auto-resolves to these shims.
 */

export { default as Link } from "./link";
export { default as Image } from "./image";
export { useRouter, usePathname, useSearchParams, useParams } from "./navigation";
export { cookies, headers } from "./headers";
