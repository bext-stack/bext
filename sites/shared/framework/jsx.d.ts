// Opt-in strict ambient JSX namespace for @bext-stack/framework (T1.2).
//
// This is NOT auto-applied. The framework's default JSX typing stays permissive
// for back-compat (77 sites). A site opts INTO strict checking by adding this
// file to its tsconfig "types":
//
//   // tsconfig.json
//   { "compilerOptions": {
//       "jsx": "react-jsx",
//       "jsxImportSource": "@bext-stack/framework",
//       "types": ["@bext-stack/framework/jsx"]   // <- opt-in
//   } }
//
// What it adds over the permissive default:
//   • A real `IntrinsicElements` map — common HTML elements with typed
//     attributes, using bext's actual attribute names: `class` / `for`
//     (NOT React's `className` / `htmlFor`). The runtime still accepts the
//     React aliases via ATTR_ALIASES; this namespace just types the canonical
//     bext spelling.
//   • `LibraryManagedAttributes` that keeps a component's REQUIRED props
//     required (fixes the `Partial<P>` footgun where every prop became
//     optional under the permissive default).
//   • `ElementChildrenAttribute = { children: {} }` so `children` is the
//     recognized child slot.
//
// Pure compile-time. Importing/declaring it has zero runtime effect.

import type { Renderable } from "./src/jsx";

declare global {
  namespace JSX {
    // What a JSX expression evaluates to in bext: a Renderable (string in the
    // sync fast path, Promise / AsyncIterable when async appears).
    type Element = Renderable;

    // The prop name that carries children.
    interface ElementChildrenAttribute {
      children: {};
    }

    // Keep a component's required props REQUIRED. The permissive default makes
    // the whole prop bag `Partial`, so missing required props slip through;
    // this preserves `P` verbatim (minus any explicit `key`/`ref`, which JSX
    // owns) so `<Card />` errors when `title` is required.
    type LibraryManagedAttributes<C, P> = P;

    // Common attributes shared by every intrinsic element. `class` and `for`
    // are the canonical bext spellings (NOT className / htmlFor).
    interface HTMLAttributes {
      // Core / global
      id?: string;
      class?: string;
      for?: string;
      style?: string | Record<string, string | number>;
      title?: string;
      lang?: string;
      dir?: "ltr" | "rtl" | "auto";
      hidden?: boolean;
      tabindex?: number | string;
      role?: string;
      slot?: string;
      draggable?: boolean | "true" | "false";
      contenteditable?: boolean | "true" | "false" | "plaintext-only";
      spellcheck?: boolean | "true" | "false";
      translate?: "yes" | "no";

      // children (echoed for ElementChildrenAttribute)
      children?: Renderable;
      key?: string | number;

      // Free-form data-* / aria-* / event handlers / any other attribute.
      // Intentionally open so authoring isn't blocked on an exhaustive attr
      // list — strictness here is about required *component* props, not about
      // forbidding HTML attributes.
      [attr: `data-${string}`]: unknown;
      [attr: `aria-${string}`]: unknown;
      [attr: `on${string}`]: unknown;
      [attr: string]: unknown;
    }

    interface AnchorHTMLAttributes extends HTMLAttributes {
      href?: string;
      target?: "_self" | "_blank" | "_parent" | "_top" | (string & {});
      rel?: string;
      download?: string | boolean;
      hreflang?: string;
      type?: string;
      referrerpolicy?: string;
    }

    interface ImgHTMLAttributes extends HTMLAttributes {
      src?: string;
      alt?: string;
      width?: number | string;
      height?: number | string;
      loading?: "eager" | "lazy";
      decoding?: "sync" | "async" | "auto";
      srcset?: string;
      sizes?: string;
      crossorigin?: "anonymous" | "use-credentials" | "";
      referrerpolicy?: string;
    }

    interface InputHTMLAttributes extends HTMLAttributes {
      type?: string;
      name?: string;
      value?: string | number;
      placeholder?: string;
      checked?: boolean | "checked";
      disabled?: boolean | "disabled";
      readonly?: boolean | "readonly";
      required?: boolean | "required";
      autocomplete?: string;
      autofocus?: boolean;
      min?: number | string;
      max?: number | string;
      step?: number | string;
      minlength?: number | string;
      maxlength?: number | string;
      pattern?: string;
      multiple?: boolean;
      accept?: string;
    }

    interface FormHTMLAttributes extends HTMLAttributes {
      action?: string;
      method?: "get" | "post" | "GET" | "POST" | (string & {});
      enctype?: string;
      name?: string;
      target?: string;
      autocomplete?: string;
      novalidate?: boolean;
    }

    interface ButtonHTMLAttributes extends HTMLAttributes {
      type?: "submit" | "reset" | "button";
      name?: string;
      value?: string | number;
      disabled?: boolean | "disabled";
      form?: string;
      formaction?: string;
    }

    interface LabelHTMLAttributes extends HTMLAttributes {
      for?: string;
      form?: string;
    }

    interface OptionHTMLAttributes extends HTMLAttributes {
      value?: string | number;
      selected?: boolean | "selected";
      disabled?: boolean | "disabled";
      label?: string;
    }

    interface SelectHTMLAttributes extends HTMLAttributes {
      name?: string;
      value?: string | number;
      disabled?: boolean | "disabled";
      required?: boolean | "required";
      multiple?: boolean;
      size?: number;
    }

    interface TextareaHTMLAttributes extends HTMLAttributes {
      name?: string;
      value?: string;
      placeholder?: string;
      rows?: number | string;
      cols?: number | string;
      disabled?: boolean | "disabled";
      readonly?: boolean | "readonly";
      required?: boolean | "required";
      minlength?: number | string;
      maxlength?: number | string;
    }

    interface ScriptHTMLAttributes extends HTMLAttributes {
      src?: string;
      type?: string;
      async?: boolean;
      defer?: boolean;
      nomodule?: boolean;
      crossorigin?: "anonymous" | "use-credentials" | "";
      integrity?: string;
      nonce?: string;
    }

    interface LinkHTMLAttributes extends HTMLAttributes {
      href?: string;
      rel?: string;
      type?: string;
      as?: string;
      media?: string;
      crossorigin?: "anonymous" | "use-credentials" | "";
      integrity?: string;
      sizes?: string;
    }

    interface MetaHTMLAttributes extends HTMLAttributes {
      name?: string;
      content?: string;
      charset?: string;
      property?: string;
      "http-equiv"?: string;
    }

    interface SourceHTMLAttributes extends HTMLAttributes {
      src?: string;
      srcset?: string;
      type?: string;
      media?: string;
      sizes?: string;
    }

    interface MediaHTMLAttributes extends HTMLAttributes {
      src?: string;
      controls?: boolean;
      autoplay?: boolean;
      loop?: boolean;
      muted?: boolean;
      preload?: "none" | "metadata" | "auto" | "";
      poster?: string;
    }

    interface TableCellHTMLAttributes extends HTMLAttributes {
      colspan?: number;
      rowspan?: number;
      headers?: string;
      scope?: "row" | "col" | "rowgroup" | "colgroup";
    }

    interface IntrinsicElements {
      // Document / sections
      html: HTMLAttributes;
      head: HTMLAttributes;
      body: HTMLAttributes;
      header: HTMLAttributes;
      footer: HTMLAttributes;
      main: HTMLAttributes;
      nav: HTMLAttributes;
      section: HTMLAttributes;
      article: HTMLAttributes;
      aside: HTMLAttributes;
      div: HTMLAttributes;
      span: HTMLAttributes;

      // Headings + text
      h1: HTMLAttributes;
      h2: HTMLAttributes;
      h3: HTMLAttributes;
      h4: HTMLAttributes;
      h5: HTMLAttributes;
      h6: HTMLAttributes;
      p: HTMLAttributes;
      blockquote: HTMLAttributes;
      pre: HTMLAttributes;
      code: HTMLAttributes;
      em: HTMLAttributes;
      strong: HTMLAttributes;
      small: HTMLAttributes;
      b: HTMLAttributes;
      i: HTMLAttributes;
      u: HTMLAttributes;
      s: HTMLAttributes;
      mark: HTMLAttributes;
      sub: HTMLAttributes;
      sup: HTMLAttributes;
      br: HTMLAttributes;
      hr: HTMLAttributes;
      abbr: HTMLAttributes;
      time: HTMLAttributes;
      kbd: HTMLAttributes;
      samp: HTMLAttributes;
      var: HTMLAttributes;
      cite: HTMLAttributes;
      q: HTMLAttributes;
      figure: HTMLAttributes;
      figcaption: HTMLAttributes;
      address: HTMLAttributes;
      details: HTMLAttributes;
      summary: HTMLAttributes;
      dialog: HTMLAttributes;

      // Lists
      ul: HTMLAttributes;
      ol: HTMLAttributes;
      li: HTMLAttributes;
      dl: HTMLAttributes;
      dt: HTMLAttributes;
      dd: HTMLAttributes;

      // Links + media
      a: AnchorHTMLAttributes;
      img: ImgHTMLAttributes;
      picture: HTMLAttributes;
      source: SourceHTMLAttributes;
      video: MediaHTMLAttributes;
      audio: MediaHTMLAttributes;
      track: HTMLAttributes;
      canvas: HTMLAttributes;
      svg: HTMLAttributes;
      path: HTMLAttributes;
      iframe: HTMLAttributes;

      // Forms
      form: FormHTMLAttributes;
      input: InputHTMLAttributes;
      textarea: TextareaHTMLAttributes;
      button: ButtonHTMLAttributes;
      label: LabelHTMLAttributes;
      select: SelectHTMLAttributes;
      option: OptionHTMLAttributes;
      optgroup: HTMLAttributes;
      fieldset: HTMLAttributes;
      legend: HTMLAttributes;
      datalist: HTMLAttributes;
      output: HTMLAttributes;
      progress: HTMLAttributes;
      meter: HTMLAttributes;

      // Tables
      table: HTMLAttributes;
      thead: HTMLAttributes;
      tbody: HTMLAttributes;
      tfoot: HTMLAttributes;
      tr: HTMLAttributes;
      th: TableCellHTMLAttributes;
      td: TableCellHTMLAttributes;
      caption: HTMLAttributes;
      colgroup: HTMLAttributes;
      col: HTMLAttributes;

      // Head / meta
      title: HTMLAttributes;
      base: HTMLAttributes;
      link: LinkHTMLAttributes;
      meta: MetaHTMLAttributes;
      style: HTMLAttributes;
      script: ScriptHTMLAttributes;
      noscript: HTMLAttributes;
      template: HTMLAttributes;

      // Escape hatch for any element not listed above (web components,
      // less-common tags). Keeps strict required-prop checking on components
      // while not blocking unlisted intrinsics.
      [tagName: string]: HTMLAttributes;
    }
  }
}

export {};
