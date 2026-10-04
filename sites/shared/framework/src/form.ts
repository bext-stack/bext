// Server-action forms with progressive enhancement.
//
// The default — no JS, no Form helper — already works: a plain
// `<form action="/_bext/action/X" method="POST">` POSTs FormData to the
// server-action handler, which on form-encoded submissions redirects 303
// back to the Referer (see serve.ts). The page reloads, the action's
// side effects are visible.
//
// This module adds two ergonomics on top of that baseline:
//
//   1. <Form name="X"> — same HTML as above, no surprises, just less typing.
//
//   2. FORM_CLIENT_RUNTIME — a ~850-byte inline script that hijacks
//      submissions on `<form data-bext-form>` and POSTs via fetch,
//      sending `x-bext-form: 1` so the server returns JSON instead of
//      303-ing. The result is dispatched on the form as a CustomEvent
//      `bext:result` with `{ ok, status, result }`. Listeners can update
//      the DOM optimistically. Without this script, the form still works
//      via the no-JS path.
//
// Why a CustomEvent and not callbacks: the framework's components are
// pure render functions producing HTML strings. There's no client-side
// component instance to hand a callback to. Events bubble through the
// DOM tree and any island can listen.

import { h, type Renderable } from "./jsx";

export interface FormProps {
  /** Action name. Maps to /_bext/action/{name}. Required. */
  name: string;
  /** Standard form props passthrough. */
  method?: "POST" | "post";
  className?: string;
  id?: string;
  children?: Renderable;
  /** Allow extra HTML attributes (e.g. `enctype`, `autocomplete`). */
  [key: string]: any;
}

/** Renders <form action="/_bext/action/{name}" method="POST" data-bext-form="{name}">.
 *  Works without JS via the server's 303-back-to-referer fallback.
 *  With FORM_CLIENT_RUNTIME loaded, submissions go through fetch and
 *  dispatch a `bext:result` CustomEvent on the form. */
export function Form(props: FormProps): Renderable {
  const { name, children, method, ...rest } = props;
  return h(
    "form",
    {
      ...rest,
      action: `/_bext/action/${name}`,
      method: method ?? "POST",
      "data-bext-form": name,
    },
    children,
  );
}

/** Inline client-side runtime that intercepts <form data-bext-form>
 *  submissions, posts via fetch with `x-bext-form: 1`, and dispatches
 *  the result as a `bext:result` CustomEvent on the form. ~850 bytes.
 *  Inject once per page (typically alongside SUSPENSE_CLIENT_RUNTIME). */
export const FORM_CLIENT_RUNTIME = `<script>document.addEventListener("submit",function(e){var f=e.target;if(!(f&&f.tagName==="FORM"&&f.dataset&&f.dataset.bextForm))return;e.preventDefault();var fd=new FormData(f);var sb=f.querySelector('[type="submit"]');if(sb)sb.disabled=true;f.dispatchEvent(new CustomEvent("bext:pending",{bubbles:true}));fetch(f.action,{method:f.method||"POST",body:fd,headers:{"x-bext-form":"1"},credentials:"same-origin"}).then(function(r){return r.json().then(function(j){return{ok:r.ok,status:r.status,result:j}},function(){return{ok:r.ok,status:r.status,result:null}})}).then(function(d){f.dispatchEvent(new CustomEvent("bext:result",{detail:d,bubbles:true}));if(d.ok)f.reset()}).catch(function(err){f.dispatchEvent(new CustomEvent("bext:result",{detail:{ok:false,status:0,error:String(err)},bubbles:true}))}).finally(function(){if(sb)sb.disabled=false})},true);</script>`;
