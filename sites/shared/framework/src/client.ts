/**
 * Client-side runtime for bext template sites.
 *
 * Provides:
 * 1. **Client-side navigation** — intercepts link clicks, fetches HTML,
 *    morphs the page without full reload (like Turbo/PJAX)
 * 2. **Live reload** — listens for server rebuild events via SSE,
 *    refreshes the page when the bundle changes
 * 3. **View transitions** — uses the View Transitions API when available
 *
 * Include in your template:
 * ```tsx
 * import { clientRuntime } from "@bext-stack/framework/client";
 * // In template <body>:
 * {clientRuntime({ liveReload: true })}
 * ```
 */

export interface ClientRuntimeOptions {
  /** Enable client-side navigation (SPA-like link interception). Default: true */
  navigation?: boolean;
  /** Enable live reload (auto-refresh on server rebuild). Default: false.
   *  - `"sse"` — uses Server-Sent Events (requires realtime feature)
   *  - `"poll"` — polls a version endpoint every few seconds (no server deps)
   *  - `true` — auto-detect: tries SSE, falls back to polling
   *  - `false` — disabled
   */
  liveReload?: boolean | "sse" | "poll";
  /** Polling interval in ms (for "poll" mode). Default: 2000 */
  pollInterval?: number;
  /** CSS selector for the content container to swap. Default: "main" */
  contentSelector?: string;
  /** CSS selector for elements to persist across navigations. Default: "nav, header, footer" */
  persistSelector?: string;
  /** Enable View Transitions API. Default: true */
  viewTransitions?: boolean;
  /** SSE endpoint for live reload events. Default: "/__bext/events?topics=reload" */
  sseEndpoint?: string;
  /** Emit `console.debug` lines from the runtime for diagnosing nav /
   *  prefetch behaviour. Default: false. Enabled output is gated under
   *  the `[bext]` prefix and grouped, so filtering for "bext" in
   *  DevTools shows the full lifecycle of each navigation. */
  debug?: boolean;
}

/**
 * Generate the client-side runtime `<script>` tag.
 *
 * This is a self-contained ~2KB script that runs in the browser.
 * No build step needed — it's injected directly into the HTML.
 */
export function clientRuntime(opts: ClientRuntimeOptions = {}): string {
  const nav = opts.navigation !== false;
  const lr = opts.liveReload;
  const sel = opts.contentSelector ?? "main";
  const vt = opts.viewTransitions !== false;
  const sse = opts.sseEndpoint ?? "/__bext/events?topics=reload";
  const pollMs = opts.pollInterval ?? 2000;

  // Determine reload mode
  const useSSE = lr === "sse" || lr === true;
  const usePoll = lr === "poll" || lr === true;

  let reloadScript = "";
  if (useSSE && usePoll) {
    // Auto-detect: try SSE first, fall back to polling
    reloadScript = LIVE_RELOAD_SSE_WITH_POLL_FALLBACK;
  } else if (useSSE) {
    reloadScript = LIVE_RELOAD_SSE_ONLY;
  } else if (usePoll) {
    reloadScript = LIVE_RELOAD_POLL;
  }

  return `<script data-bext-runtime>${clientRuntimeBody(opts)}</script>`;
}

/**
 * Same as `clientRuntime()` but returns just the JavaScript body (no
 * `<script>` tag wrapper). Use this from React layouts where you want
 * to render a `<script>` element via JSX:
 *
 * ```tsx
 * <script
 *   data-bext-runtime
 *   dangerouslySetInnerHTML={{ __html: clientRuntimeBody({ navigation: true }) }}
 * />
 * ```
 *
 * `<script>` tags inserted via `innerHTML` don't execute, but JSX-rendered
 * `<script>` elements with `dangerouslySetInnerHTML` are emitted as part
 * of the SSR HTML and run on parse like any other inline script.
 */
export function clientRuntimeBody(opts: ClientRuntimeOptions = {}): string {
  const nav = opts.navigation !== false;
  const lr = opts.liveReload;
  const sel = opts.contentSelector ?? "main";
  const vt = opts.viewTransitions !== false;
  const sse = opts.sseEndpoint ?? "/__bext/events?topics=reload";
  const pollMs = opts.pollInterval ?? 2000;
  const debug = !!opts.debug;

  const useSSE = lr === "sse" || lr === true;
  const usePoll = lr === "poll" || lr === true;
  let reloadScript = "";
  if (useSSE && usePoll) reloadScript = LIVE_RELOAD_SSE_WITH_POLL_FALLBACK;
  else if (useSSE) reloadScript = LIVE_RELOAD_SSE_ONLY;
  else if (usePoll) reloadScript = LIVE_RELOAD_POLL;

  return `(function(){
"use strict";
var SEL="${sel}",VT=${vt},SSE="${sse}",POLL_MS=${pollMs},DEBUG=${debug};
function dlog(){if(DEBUG)console.debug.apply(console,["[bext]"].concat([].slice.call(arguments)));}
${nav ? NAVIGATE_SCRIPT : ""}
${reloadScript}
})();`;
}

// ─── Client-side Navigation Script ──────────────────────────────────────────

const NAVIGATE_SCRIPT = `
  // Client-side navigation: intercept <a> clicks, fetch HTML, swap content
  var cache={};

  function navigate(url,push,force){
    var u=new URL(url,location.origin);
    var requestPath=u.pathname+u.search;
    var fullPath=requestPath+u.hash;
    // Same-path guard skips a redundant click to the page you're already on. It must NOT
    // apply to popstate: the browser updates location.* to the popped URL BEFORE firing
    // popstate, so fullPath always equals the (already-changed) current location and the
    // guard would skip the swap — leaving the URL changed but the content stale. popstate
    // passes force=1 to re-render.
    if(!force&&fullPath===location.pathname+location.search+location.hash){dlog("navigate: same path, skip",{url:url});return Promise.resolve();}

    var hit=!!cache[requestPath];
    dlog("navigate: starting",{fullPath:fullPath,cache_hit:hit,push:push});

    // Prefetched/cached as buffered text → swap when ready.
    if(cache[requestPath]){
      return cache[requestPath].then(function(html){swap(html,fullPath,push);}).catch(function(){location.href=url;});
    }
    // Live nav → STREAM the response. A streaming page flushes its shell first, so we swap
    // <main> the moment the shell arrives and resolve Suspense reveals as they stream in —
    // instead of buffering the whole response and waiting on the slowest boundary. A
    // non-streaming page (no shell sentinel) just buffers + swaps once at the end (same as
    // before). Falls back to a buffered swap when ReadableStream/TextDecoder are unavailable.
    return fetch(requestPath,{headers:{"X-Bext-Nav":"1"}}).then(function(r){
      // fetch follows HTTP redirects. A protected-page 302 therefore arrives here as the
      // login page with status 200; swapping only its main would strand it inside the old
      // authenticated chrome and omit login scripts outside main. Cross that document/auth
      // boundary with a hard navigation, carrying the requested fragment that HTTP never sent.
      if(r.redirected){
        var target=new URL(r.url,location.origin);
        // Fragments can contain sensitive UI state. Only carry one to a redirect that
        // remains on this origin, and never replace a fragment chosen by the target.
        if(target.origin===location.origin&&!target.hash&&u.hash)target.hash=u.hash;
        dlog("navigate: response redirected, hard navigation",{from:fullPath,to:target.href});
        location.href=target.href;
        return;
      }
      if(!r.ok)throw r;
      if(!r.body||!r.body.getReader||typeof TextDecoder==="undefined"){
        return r.text().then(function(html){cache[requestPath]=Promise.resolve(html);swap(html,fullPath,push);});
      }
      return streamNav(r,fullPath,push,requestPath);
    }).catch(function(err){
      dlog("navigate: error, falling back to location.href",{url:url,err:String(err)});
      location.href=url;
    });
  }

  // Stream a navigation response. A streaming page emits a shell-end sentinel comment right
  // after its shell content (before the deferred closing tags and the Suspense reveals). We
  // swap main the instant that sentinel arrives — a SYNC swap (no View Transition) so the
  // placeholder is live before reveals apply — then replace each bext-suspense placeholder
  // with its template as it streams in. No sentinel (a non-streaming page) → buffer and swap
  // once at the end.
  function streamNav(r,path,push,cachePath){
    var reader=r.body.getReader(),dec=new TextDecoder(),buf="",full="",shellDone=false,applied=false,cursor=0;
    // Markers built from char codes so THIS script (itself part of the served shell) doesn't
    // contain the literals — else indexOf would match our own source. (String concat gets
    // constant-folded back to the literal by the bundler, so fromCharCode for the lt char.)
    var SENT=String.fromCharCode(60,33,45,45)+"bext-shell-end"+String.fromCharCode(45,45,62);
    var TOPEN=String.fromCharCode(60)+'template data-suspense-real="',TCLOSE=String.fromCharCode(60,47)+"template>";
    function applyReveals(){
      var start;
      while((start=full.indexOf(TOPEN,cursor))>=0){
        var idEnd=full.indexOf('"',start+TOPEN.length);
        var gt=idEnd>=0?full.indexOf(">",idEnd):-1;
        var close=gt>=0?full.indexOf(TCLOSE,gt):-1;
        if(idEnd<0||gt<0||close<0)break; // incomplete → wait for the next chunk
        var id=full.slice(start+TOPEN.length,idEnd);
        var ph=document.querySelector('bext-suspense[data-id="'+id+'"]');
        if(ph){var tp=document.createElement("template");tp.innerHTML=full.slice(gt+1,close);ph.replaceWith(tp.content.cloneNode(true));applied=true;}
        cursor=close+TCLOSE.length;
      }
    }
    function pump(){
      return reader.read().then(function(res){
        if(res.value){var s=dec.decode(res.value,{stream:!res.done});buf+=s;full+=s;}
        if(!shellDone){
          var si=buf.indexOf(SENT);
          // Scan for reveals only AFTER the sentinel — the shell itself can contain the
          // literal "<template data-suspense-real" (e.g. inside this very runtime's comments),
          // which would otherwise be mis-matched as a reveal.
          if(si>=0){shellDone=true;cursor=si+SENT.length;swap(buf.slice(0,si),path,push,1);}
        }
        if(shellDone)applyReveals();
        if(res.done){
          if(!shellDone)swap(full,path,push,1); // no sentinel → whole response is the shell
          cache[cachePath]=Promise.resolve(full);
          if(applied){try{document.dispatchEvent(new CustomEvent("bext:navigated",{detail:{path:location.pathname}}));}catch(e){}}
          return;
        }
        return pump();
      });
    }
    return pump().catch(function(){location.href=path;});
  }

  // Metadata-managed <head> tags (what prism-runtime's renderMetadataHtml emits), grouped
  // by key. A key's live tags are made exactly equal (count, order, attributes) to the
  // fetched document's, and a key the new page no longer has is removed. Families that
  // repeat or go together (og:image + og:image:*, twitter:image + twitter:image:*, all
  // hreflang alternates) are one key, replaced as a block. Anything else in <head>
  // (charset, viewport, stylesheets, scripts, JSON-LD, icons, preconnect) is never touched.
  // Only direct <head> children count: a <meta> inside <noscript> is not the page's.
  var HEAD_META=["description","keywords","robots","googlebot","referrer",
    "og:title","og:description","og:url","og:type","og:site_name","og:locale",
    "twitter:card","twitter:title","twitter:description","twitter:site","twitter:creator"];
  function headKey(el){
    var tag=el.tagName.toLowerCase();
    if(tag==="meta"){
      var n=(el.getAttribute("property")||el.getAttribute("name")||"").trim().toLowerCase();
      if(!n)return null;
      if(n==="og:image"||n.indexOf("og:image:")===0)return "og:image";
      if(n==="twitter:image"||n.indexOf("twitter:image:")===0)return "twitter:image";
      return HEAD_META.indexOf(n)>=0?"meta:"+n:null;
    }
    if(tag==="link"){
      var rel=" "+(el.getAttribute("rel")||"").toLowerCase().replace(/\\s+/g," ")+" ";
      if(rel.indexOf(" canonical ")>=0)return "canonical";
      if(rel.indexOf(" alternate ")>=0&&el.hasAttribute("hreflang"))return "hreflang";
    }
    return null;
  }
  function headGroups(head){
    var g={},order=[],kids=head?head.children:[];
    for(var i=0;i<kids.length;i++){
      var k=headKey(kids[i]);
      if(!k)continue;
      if(!g[k]){g[k]=[];order.push(k);}
      g[k].push(kids[i]);
    }
    return {g:g,order:order};
  }
  function sameAttrs(a,b){
    if(a.tagName!==b.tagName||a.attributes.length!==b.attributes.length)return false;
    for(var i=0;i<a.attributes.length;i++){
      if(b.getAttribute(a.attributes[i].name)!==a.attributes[i].value)return false;
    }
    return true;
  }
  function syncHeadMeta(doc){
    var head=document.head;
    if(!head)return;
    var nw=headGroups(doc.head),old=headGroups(head);
    // Keys gone from the new page: drop their live tags.
    for(var i=0;i<old.order.length;i++){
      var k=old.order[i];
      if(nw.g[k])continue;
      for(var j=0;j<old.g[k].length;j++)old.g[k][j].remove();
    }
    for(var a=0;a<nw.order.length;a++){
      var key=nw.order[a],nt=nw.g[key],ot=old.g[key]||[];
      var same=nt.length===ot.length;
      for(var b=0;same&&b<nt.length;b++)same=sameAttrs(nt[b],ot[b]);
      if(same)continue; // unchanged: leave the live nodes alone
      // Insert where the key's first live tag sat (keeps head order), else at the end.
      var ref=ot.length?ot[0]:null;
      for(var c=0;c<nt.length;c++){
        var clone=document.importNode(nt[c],true);
        if(ref)head.insertBefore(clone,ref);else head.appendChild(clone);
      }
      for(var d=0;d<ot.length;d++)ot[d].remove();
    }
  }

  function swap(html,path,push,sync){
    var doc=new DOMParser().parseFromString(html,"text/html");

    // Full-page hydration pages need a hard navigation — SPA swap can't
    // set up hydrateRoot(document). Detect by __BEXT_DATA__ script tag.
    if(doc.getElementById("__BEXT_DATA__")){
      dlog("swap: bail to location.href (target has __BEXT_DATA__)",{path:path});
      location.href=path;
      return;
    }

    var newContent=doc.querySelector(SEL);
    var oldContent=document.querySelector(SEL);
    if(!newContent||!oldContent){
      dlog("swap: bail to location.href (no content selector match)",{path:path,sel:SEL,has_new:!!newContent,has_old:!!oldContent});
      location.href=path;
      return;
    }
    dlog("swap: morphing "+SEL,{path:path});

    // Update <head>: title + every metadata-managed tag the PRISM runtime emits.
    var t=doc.querySelector("title");
    if(t)document.title=t.textContent;
    syncHeadMeta(doc);

    // Route-CSS: each route ships its own per-route JIT <style data-bext-css> in <head>.
    // A content-only swap leaves the OLD route-css in place, so a class the new page uses
    // that the previous page didn't (tables/badges/toolbars on a list reached from a card
    // hub) renders unstyled. Swap the live block(s) in — but ATOMICALLY with the content
    // swap (same synchronous block, and INSIDE the View-Transition callback which runs
    // AFTER the "before" snapshot) so the browser never paints OLD content under NEW css.
    // Doing it earlier flashes the still-visible old page unstyled for a frame. (The
    // X-Bext-Nav fetch is a full render, not a partial, so doc carries the new route-css.)
    function applyHeadCss(){
      var ncss=doc.querySelectorAll("style[data-bext-css]");
      if(!ncss.length)return;
      var ocss=document.querySelectorAll("style[data-bext-css]");
      if(ncss.length===1&&ocss.length===1){
        if(ocss[0].textContent!==ncss[0].textContent)ocss[0].textContent=ncss[0].textContent;
      }else{
        for(var ci=0;ci<ocss.length;ci++)if(ocss[ci].parentNode)ocss[ci].parentNode.removeChild(ocss[ci]);
        var cref=document.head.querySelector("style:not([data-bext-css]),link[rel=stylesheet]");
        for(var cj=0;cj<ncss.length;cj++){var cn=ncss[cj].cloneNode(true);if(cref)document.head.insertBefore(cn,cref);else document.head.appendChild(cn);}
      }
    }

    // Swap content + route-css together so the page is never styled by the wrong CSS.
    // sync (streamed nav) skips the View Transition: the swap must be synchronous so the
    // Suspense placeholders are live in the DOM before the streamed reveals apply to them.
    if(VT&&document.startViewTransition&&!sync){
      document.startViewTransition(function(){
        applyHeadCss();
        oldContent.replaceWith(newContent);
        if(push!==false)history.pushState(null,"",path);
        afterSwap(doc,push);
      });
    }else{
      applyHeadCss();
      oldContent.replaceWith(newContent);
      if(push!==false)history.pushState(null,"",path);
      afterSwap(doc,push);
    }
  }

  function afterSwap(doc,push){
    // Resolve streamed Suspense boundaries (buffered-swap path). The server emits each
    // boundary's real content as a template[data-suspense-real] AFTER the main content —
    // outside the swapped container — plus an inline swap script that only fires on a hard
    // document load, NOT when we soft-swap main. So apply them here from the fetched doc:
    // replace each bext-suspense placeholder (now live) with its template content. Done BEFORE
    // the script re-run so islands inside resolved content re-init. (No-op without Suspense.)
    if(doc){
      doc.querySelectorAll('template[data-suspense-real]').forEach(function(tpl){
        var sid=tpl.getAttribute('data-suspense-real');
        var ph=document.querySelector('bext-suspense[data-id="'+sid+'"]');
        if(ph)ph.replaceWith(tpl.content.cloneNode(true));
      });
    }

    // Re-run inline scripts in new content
    document.querySelector(SEL)?.querySelectorAll("script").forEach(function(s){
      var n=document.createElement("script");
      if(s.src)n.src=s.src;else n.textContent=s.textContent;
      if(s.type)n.type=s.type;
      s.replaceWith(n);
    });

    // Clean up old island/hydration scripts from previous navigation
    document.querySelectorAll('script[data-prism-nav]').forEach(function(s){s.remove();});

    // Re-run island + hydration scripts from the full response body
    // (these live outside the content selector, near the end of body)
    if(doc){
      doc.querySelectorAll('script[type="module"]').forEach(function(s){
        // Island loader or full-page hydration entry
        if(s.src&&s.src.includes("/_bext/")){
          var n=document.createElement("script");
          n.type="module";n.src=s.src;n.setAttribute("data-prism-nav","1");
          document.body.appendChild(n);
        }else if(s.textContent&&s.textContent.indexOf("bext-island")>-1){
          var n=document.createElement("script");
          n.type="module";n.textContent=s.textContent;n.setAttribute("data-prism-nav","1");
          document.body.appendChild(n);
        }
      });
      // Update __BEXT_DATA__ if present in new page
      var newData=doc.getElementById("__BEXT_DATA__");
      var oldData=document.getElementById("__BEXT_DATA__");
      if(newData){
        if(oldData)oldData.textContent=newData.textContent;
        else{var d=document.createElement("script");d.id="__BEXT_DATA__";d.type="application/json";d.textContent=newData.textContent;document.body.appendChild(d);}
      }else if(oldData){oldData.remove();}
    }

    // Scroll to top on forward navigation (back/forward restores via popstate)
    if(push!==false)window.scrollTo(0,0);
    // Clear prefetch cache on navigation
    cache={};
    // Lifecycle hook: content scripts (syntax highlighting, charts, analytics)
    // re-initialize on this event after a soft navigation. Mirrors Astro's
    // astro:page-load. The event also fires once on initial load (see init).
    try{document.dispatchEvent(new CustomEvent("bext:navigated",{detail:{path:path}}));}catch(e){}
  }

  // Detect full-page-hydration pages. PRISM injects a script with
  // id=__BEXT_DATA__ near the end of body, plus a hydration entry script
  // typically pointing at /_bext/. The detection has to run lazily, NOT
  // at init time: this inline runtime is parsed earlier in body than
  // the framework data + entry scripts, so a synchronous check at
  // init would always see them missing. Some frameworks also remove
  // __BEXT_DATA__ after consuming it, so we double-check for the
  // hydration entry too. Re-evaluated on each click.
  function isFullHydration(){
    if(document.getElementById("__BEXT_DATA__"))return true;
    var entries=document.querySelectorAll('script[type="module"][src]');
    for(var i=0;i<entries.length;i++){
      var src=entries[i].getAttribute("src")||"";
      if(src.indexOf("/_bext/")!==-1)return true;
    }
    return false;
  }
  dlog("init",{selector:SEL,view_transitions:VT,location:location.pathname,bext_data_at_init:!!document.getElementById("__BEXT_DATA__")});

  // Intercept link clicks (skip for full-page-hydrated docs, see above).
  document.addEventListener("click",function(e){
    var a=e.target.closest("a[href]");
    if(!a)return;
    if(isFullHydration()){dlog("click: skip intercept (full hydration page)",{href:a.getAttribute("href")});return;}
    // Escape hatches via attributes: data-no-spa leaves the click alone
    // (full-page reload, used for auth flows + same-origin sub-apps).
    // data-no-prefetch alone disables hover prefetch but still SPA-navs.
    if(a.hasAttribute("data-no-spa")){dlog("click: skip intercept (data-no-spa)",{href:a.getAttribute("href")});return;}
    var href=a.getAttribute("href");
    if(!href||href.startsWith("#")||href.startsWith("mailto:")||href.startsWith("tel:"))return;
    if(a.target==="_blank"||a.hasAttribute("download"))return;
    if(e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;

    try{
      var url=new URL(href,location.origin);
      if(url.origin!==location.origin)return; // External link
      if(url.pathname.match(/\\.(pdf|zip|gz|tar|png|jpg|jpeg|gif|svg|ico|woff2?)$/i))return; // File
    }catch(x){return;}

    e.preventDefault();
    dlog("click: SPA intercept",{href:href});
    // Cancel any pending hover-prefetch — otherwise a fast click (under
    // the 65ms prefetch delay) races: click fires its own fetch and
    // populates cache, then the prefetch timer fires and overwrites
    // cache with a duplicate fetch. Two requests for one navigation.
    clearTimeout(prefetchTimer);
    // Save scroll position before navigating
    history.replaceState({scrollY:window.scrollY},"",location.href);
    navigate(href,true);
  });

  // Handle back/forward with scroll restoration
  window.addEventListener("popstate",function(e){
    {
      navigate(location.href,false,true).then(function(){
        if(e.state&&typeof e.state.scrollY==="number")window.scrollTo(0,e.state.scrollY);
      });
    }
  });

  // Prefetch on hover (after 65ms, cancel on leave).
  //
  // Uses <link rel="prefetch" as="document"> rather than a JS-side fetch.
  // Reasons:
  //   1. SPA-incompatible pages (full-page React hydration with
  //      __BEXT_DATA__) bail out of swap() and fall back to a hard
  //      navigation via location.href. That hard nav DOES consume the
  //      browser's prefetch cache populated by <link rel="prefetch">,
  //      so the prefetch is no longer wasted on those pages.
  //   2. SPA-compatible pages still benefit: navigate()'s own fetch()
  //      hits the same prefetch cache (browser dedupes the request).
  //   3. The browser handles cache eviction, max-concurrent-prefetches,
  //      and the "low-priority background" scheduling for free.
  //
  // Escape hatches: data-no-prefetch and data-no-spa both skip the
  // pre-warm (data-no-spa wouldn't SPA-nav anyway).
  var prefetchTimer;
  var prefetched={};
  document.addEventListener("mouseover",function(e){
    var a=e.target.closest("a[href]");
    if(!a)return;
    if(a.hasAttribute("data-no-prefetch")||a.hasAttribute("data-no-spa"))return;
    var href=a.getAttribute("href");
    if(!href||href.startsWith("#"))return;
    try{
      var url=new URL(href,location.origin);
      if(url.origin!==location.origin)return;
      var fp=url.pathname+url.search;
      if(prefetched[fp]||cache[fp]){dlog("hover: already prefetched",{fp:fp});return;}
      prefetchTimer=setTimeout(function(){
        if(prefetched[fp]||cache[fp])return;
        var l=document.createElement("link");
        l.rel="prefetch";
        l.href=fp;
        l.as="document";
        document.head.appendChild(l);
        prefetched[fp]=l;
        dlog("hover: <link rel=prefetch> injected",{fp:fp});
      },65);
    }catch(x){}
  });
  document.addEventListener("mouseout",function(){clearTimeout(prefetchTimer);});
`;

// ─── Live Reload Scripts ────────────────────────────────────────────────────

// Shared: soft-reload function (re-fetch page, swap content + styles)
const SOFT_RELOAD_FN = `
  function softReload(reason){
    console.log("[bext] "+reason+" — refreshing");
    fetch(location.pathname,{headers:{"X-Bext-Nav":"1","Cache-Control":"no-cache"}})
      .then(function(r){return r.text();})
      .then(function(html){
        var doc=new DOMParser().parseFromString(html,"text/html");
        // Update external stylesheets (cache-busted URLs)
        doc.querySelectorAll('link[rel="stylesheet"]').forEach(function(link){
          var href=link.getAttribute("href");
          if(!document.querySelector('link[href="'+href+'"]')){
            document.head.appendChild(link.cloneNode());
          }
        });
        // Remove old stylesheets not in new doc
        document.querySelectorAll('link[rel="stylesheet"]').forEach(function(link){
          var href=link.getAttribute("href");
          if(!doc.querySelector('link[href="'+href+'"]'))link.remove();
        });
        // Update inline styles
        var ns=doc.querySelectorAll("style:not([data-bext-runtime])");
        var os=document.querySelectorAll("style:not([data-bext-runtime])");
        os.forEach(function(s,i){if(ns[i])s.textContent=ns[i].textContent;});
        // Swap content
        var nc=doc.querySelector(SEL),oc=document.querySelector(SEL);
        if(nc&&oc){try{var H1=globalThis.__bextHmr;if(H1)H1.snapshot();}catch(e){}oc.replaceWith(nc);try{var Hr=globalThis.__bextHmr;if(Hr&&Hr.remountIslands)Hr.remountIslands();}catch(e){}try{document.dispatchEvent(new CustomEvent("bext:navigated",{detail:{path:location.pathname}}));}catch(e){}}
        else {try{var H2=globalThis.__bextHmr;if(H2)H2.snapshot();}catch(e){}location.reload();}
      })
      .catch(function(){try{var H3=globalThis.__bextHmr;if(H3)H3.snapshot();}catch(e){}location.reload();});
  }
`;

// Mode 1: SSE only (requires bext realtime feature)
const LIVE_RELOAD_SSE_ONLY = SOFT_RELOAD_FN + `
  function connectSSE(){
    var es;try{es=new EventSource(SSE);}catch(x){return;}
    es.addEventListener("reload",function(e){
      var d;try{d=JSON.parse(e.data);}catch(x){d={};}
      softReload("Server rebuilt ("+(d.build_ms||"?")+"ms)");
    });
    es.onerror=function(){es.close();setTimeout(connectSSE,3000);};
  }
  connectSSE();
`;

// Mode 2: Polling only (no server deps — works everywhere)
const LIVE_RELOAD_POLL = SOFT_RELOAD_FN + `
  // Poll: check ETag/Last-Modified of current page
  var lastEtag=null;
  function pollForChanges(){
    fetch(location.pathname,{method:"HEAD",headers:{"Cache-Control":"no-cache"}})
      .then(function(r){
        var etag=r.headers.get("etag")||r.headers.get("x-bext-render-us")||"";
        if(lastEtag===null){lastEtag=etag;return;}
        if(etag&&etag!==lastEtag){
          lastEtag=etag;
          softReload("Content changed");
        }
      })
      .catch(function(){});
  }
  setInterval(pollForChanges,POLL_MS);
  pollForChanges();
`;

// Mode 3: Auto-detect — try SSE, fall back to polling
const LIVE_RELOAD_SSE_WITH_POLL_FALLBACK = SOFT_RELOAD_FN + `
  var sseOk=false;
  function connectSSE(){
    var es;try{es=new EventSource(SSE);}catch(x){startPoll();return;}
    es.addEventListener("reload",function(e){
      sseOk=true;
      var d;try{d=JSON.parse(e.data);}catch(x){d={};}
      softReload("Server rebuilt ("+(d.build_ms||"?")+"ms)");
    });
    es.onerror=function(){
      es.close();
      if(!sseOk){startPoll();}
      else{setTimeout(connectSSE,3000);}
    };
  }
  var polling=false;
  function startPoll(){
    if(polling)return;polling=true;
    console.log("[bext] SSE unavailable — using polling for live reload");
    var lastEtag=null;
    setInterval(function(){
      fetch(location.pathname,{method:"HEAD",headers:{"Cache-Control":"no-cache"}})
        .then(function(r){
          var etag=r.headers.get("etag")||r.headers.get("x-bext-render-us")||"";
          if(lastEtag===null){lastEtag=etag;return;}
          if(etag&&etag!==lastEtag){lastEtag=etag;softReload("Content changed");}
        }).catch(function(){});
    },POLL_MS);
  }
  connectSSE();
`;

/**
 * Generate a content-hashed URL for cache busting.
 * The hash is computed from the file content at build time.
 */
export function hashedUrl(path: string, hash: string): string {
  const ext = path.lastIndexOf(".");
  if (ext === -1) return `${path}?v=${hash}`;
  return `${path.slice(0, ext)}.${hash}${path.slice(ext)}`;
}
