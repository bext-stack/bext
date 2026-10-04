/**
 * Islands architecture for bext — server renders static HTML with hydration
 * markers. Client-side JS progressively enhances interactive components.
 *
 * Server usage:
 * ```tsx
 * import { island } from "@bext-stack/framework/island";
 * <div>{island("Counter", { initial: 0 }, "<span>0</span>")}</div>
 * ```
 *
 * Client: call `islandScript()` and inject it near `</body>`. It emits a
 * lazy loader that `import()`s + `mount(el, props)`s each island only as it
 * nears the viewport (IntersectionObserver) or on first interaction — the
 * server-rendered fallback stays interactive until hydration happens.
 */

/**
 * Render an island marker with server-side fallback HTML.
 *
 * @param name — Component name (matches `/islands/{name}.js` on the client)
 * @param props — Serializable props passed to the client component
 * @param fallback — Static HTML rendered server-side (shown before hydration)
 */
export function island(name: string, props: Record<string, any>, fallback = ""): string {
  const propsJson = JSON.stringify(props)
    .replace(/&/g, "&amp;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "\\u003c");
  // Prefix the safe-HTML sentinel (\x01) so a bare `{island(...)}` child is
  // passed through (not escaped) under the runtime's auto-escaping; the
  // response sink strips it before the browser sees it. `<Raw html={island()}>`
  // still works too (double sentinel, both stripped).
  return `\x01<bext-island data-component="${name}" data-props='${propsJson}'>${fallback}</bext-island>`;
}

/**
 * Generate the minimal client-side hydration script.
 * Include this in your template's `<body>` or as a separate `<script>`.
 *
 * Hydration is LAZY: each `<bext-island>`'s module is `import()`-ed and mounted
 * only when the element approaches the viewport (IntersectionObserver, with
 * `rootMargin: "200px"` so it hydrates just BEFORE it scrolls into view to
 * avoid interaction lag) OR on the first user interaction that reaches it
 * (`focusin` / `pointerover` / `touchstart`) — whichever comes first, so a fast
 * user is never blocked waiting for the observer.
 *
 * Safety:
 *  - Above-the-fold islands hydrate immediately: `IntersectionObserver` queues
 *    an initial callback for every observed target, and already-visible ones
 *    report `isIntersecting` on the first tick.
 *  - No `IntersectionObserver` (old browsers) → falls back to the original eager
 *    behavior (import + mount every island up-front). No regression.
 *  - The server-rendered fallback HTML inside `<bext-island>` stays visible and
 *    interactive before hydration — nothing is hidden or gated on JS.
 *  - Each island hydrates exactly once: a per-element `__bextHydrated` flag
 *    guards against the observer and the interaction listeners both firing.
 *
 * Opt out of laziness for a critical island (e.g. primary nav): add a
 * `data-eager` attribute to its `<bext-island>` marker and it hydrates on load.
 */
export function islandScript(basePath = "/islands"): string {
  // Sentinel-prefixed (see island()) so a bare `{islandScript()}` child isn't escaped.
  return `\x01<script type="module">
(function(){
  var BASE='${basePath}';
  // Import an island's module + mount it on its element. Idempotent: the
  // per-element flag lets the observer and the interaction fallback both fire safely.
  function hydrate(el){
    if(el.__bextHydrated)return;
    el.__bextHydrated=true;
    var n=el.dataset.component,p={};
    try{p=JSON.parse(el.dataset.props||'{}')}catch(e){}
    import(BASE+'/'+n+'.js').then(function(m){if(m&&m.mount)m.mount(el,p)}).catch(function(e){console.warn('Island '+n+':',e)});
  }
  var els=document.querySelectorAll('bext-island');
  // No IntersectionObserver → keep the original eager behavior (no regression).
  if(!('IntersectionObserver'in window)){els.forEach(hydrate);return;}
  var io=new IntersectionObserver(function(entries){
    entries.forEach(function(en){if(!en.isIntersecting)return;var el=en.target;el.__bextFire?el.__bextFire():hydrate(el)});
  },{rootMargin:'200px'});
  var EV=['focusin','pointerover','touchstart'],OPT={once:true,passive:true,capture:true};
  els.forEach(function(el){
    // data-eager opts a critical island (e.g. nav) into immediate hydration.
    if(el.dataset.eager!=null){hydrate(el);return;}
    // Hydrate on first interaction OR intersection, whichever wins. fire() also
    // tears itself down so the loser can't re-run (hydrate() is guarded anyway).
    function fire(){EV.forEach(function(t){el.removeEventListener(t,fire,OPT)});io.unobserve(el);hydrate(el)}
    el.__bextFire=fire;
    EV.forEach(function(t){el.addEventListener(t,fire,OPT)});
    // observe() fires an initial callback — above-the-fold islands hydrate at once.
    io.observe(el);
  });
})();
</script>`;
}
