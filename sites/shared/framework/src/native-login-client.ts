/**
 * Progressive enhancement for PRISM password-login forms.
 *
 * It discovers the existing server-rendered form, so sites keep their own
 * presentation and no-JS POST fallback. Routes opt into the JSON contract by
 * honoring Accept: application/json.
 */
export const NATIVE_LOGIN_CLIENT_SCRIPT = String.raw`
(function(){
  function ready(){
    var form=document.querySelector('form[data-native-login],form[action="/api/auth/password-login"]');
    if(!form||form.__nativeLoginReady)return; form.__nativeLoginReady=true;
    var email=form.querySelector('input[name="email"]');
    var password=form.querySelector('input[name="password"]');
    var submit=form.querySelector('button[type="submit"],input[type="submit"]');
    if(!email||!password||!submit)return;
    var lang=((form.querySelector('input[name="lang"],input[name="locale"]')||{}).value||document.documentElement.lang||'fr').toLowerCase();
    var en=lang.indexOf('en')===0;
    var copy=en?{
      show:'Show',hide:'Hide',showAria:'Show password',hideAria:'Hide password',
      missing:'Enter your email and password.',busy:'Signing in…',done:'Signed in',
      choose:'Several workspaces use this address. Choose one to continue.',
      fallback:'Unable to sign in. Try again.',network:'Network unavailable. Try again shortly.',space:'Workspace'
    }:{
      show:'Afficher',hide:'Masquer',showAria:'Afficher le mot de passe',hideAria:'Masquer le mot de passe',
      missing:'Renseignez votre email et votre mot de passe.',busy:'Connexion en cours…',done:'Connexion réussie',
      choose:'Plusieurs espaces sont associés à cette adresse. Choisissez celui à ouvrir.',
      fallback:'Connexion impossible. Réessayez.',network:'Réseau indisponible. Réessayez dans un instant.',space:'Espace'
    };
    var style=document.createElement('style');
    style.textContent='@keyframes native-login-spin{to{transform:rotate(360deg)}}.native-login-password{position:relative;width:100%}.native-login-password input{padding-right:84px!important}.native-login-toggle{position:absolute;right:8px;top:50%;transform:translateY(-50%);border:0;background:transparent;color:inherit;padding:7px 8px;border-radius:7px;font:inherit;font-size:12px;font-weight:700;cursor:pointer}.native-login-toggle:focus-visible,.native-login-choice:focus-visible{outline:2px solid currentColor;outline-offset:2px}.native-login-error{padding:11px 13px;border-radius:10px;background:#fef2f2;border:1px solid #fecaca;color:#991b1b;font-size:13px;line-height:1.45}.native-login-picker{padding:13px;border-radius:12px;background:#eff6ff;border:1px solid #bfdbfe;color:#1e3a8a}.native-login-picker p{margin:0 0 10px;font-size:13px;line-height:1.45;font-weight:600}.native-login-list{display:flex;flex-direction:column;gap:7px}.native-login-choice{width:100%;padding:10px 12px;border:1px solid #bfdbfe;border-radius:9px;background:#fff;color:#172554;text-align:left;font:inherit;font-weight:650;cursor:pointer}.native-login-spin{display:inline-block;width:14px;height:14px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:native-login-spin .7s linear infinite;vertical-align:-2px;margin-right:7px}';
    document.head.appendChild(style);
    var error=document.createElement('div'); error.className='native-login-error'; error.hidden=true; error.setAttribute('role','alert'); error.setAttribute('tabindex','-1'); form.insertBefore(error,form.firstChild);
    var picker=document.createElement('div'); picker.className='native-login-picker'; picker.hidden=true; picker.setAttribute('aria-live','polite'); form.insertBefore(picker,error.nextSibling);
    var wrap=document.createElement('div'); wrap.className='native-login-password'; password.parentNode.insertBefore(wrap,password); wrap.appendChild(password);
    var toggle=document.createElement('button'); toggle.type='button'; toggle.className='native-login-toggle'; toggle.textContent=copy.show; toggle.setAttribute('aria-label',copy.showAria); toggle.setAttribute('aria-pressed','false'); wrap.appendChild(toggle);
    toggle.addEventListener('click',function(){var reveal=password.type==='password';password.type=reveal?'text':'password';toggle.textContent=reveal?copy.hide:copy.show;toggle.setAttribute('aria-label',reveal?copy.hideAria:copy.showAria);toggle.setAttribute('aria-pressed',reveal?'true':'false');password.focus();});
    var submitHtml=submit.innerHTML;
    function busy(on){form.setAttribute('aria-busy',on?'true':'false');submit.disabled=on;submit.innerHTML=on?'<span class="native-login-spin" aria-hidden="true"></span>'+copy.busy:submitHtml;}
    function fail(message){error.textContent=message||copy.fallback;error.hidden=false;try{error.focus({preventScroll:true});}catch(_){error.focus();}}
    function clearChoice(){var h=form.querySelector('input[name="tenant_id"]');if(h)h.remove();picker.textContent='';picker.hidden=true;}
    email.addEventListener('input',clearChoice);
    function choose(id){var h=form.querySelector('input[name="tenant_id"]');if(!h){h=document.createElement('input');h.type='hidden';h.name='tenant_id';form.appendChild(h);}h.value=id;if(form.requestSubmit)form.requestSubmit(submit);else form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));}
    function showPicker(tenants,message){picker.textContent='';var p=document.createElement('p');p.textContent=message||copy.choose;picker.appendChild(p);var list=document.createElement('div');list.className='native-login-list';tenants.forEach(function(t,i){if(!t||!t.id)return;var b=document.createElement('button');b.type='button';b.className='native-login-choice';b.textContent=t.name||(copy.space+' '+(i+1));b.addEventListener('click',function(){choose(String(t.id));});list.appendChild(b);});picker.appendChild(list);picker.hidden=false;var first=list.querySelector('button');if(first)first.focus();}
    form.addEventListener('submit',function(event){event.preventDefault();error.hidden=true;if(!String(email.value||'').trim()||!String(password.value||'')){fail(copy.missing);return;}var params=new URLSearchParams();new FormData(form).forEach(function(v,k){params.append(k,String(v));});busy(true);fetch(form.action,{method:'POST',headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded;charset=UTF-8'},body:params.toString(),credentials:'same-origin'}).then(function(r){return r.text().then(function(t){var p={};try{p=JSON.parse(t);}catch(_){}return{ok:r.ok,p:p};});}).then(function(r){if(r.ok&&r.p&&r.p.ok){submit.textContent=copy.done;var from=form.querySelector('input[name="from"],input[name="next"]');window.location.replace(r.p.next||(from&&from.value)||'/');return;}busy(false);if(r.p&&(r.p.status==='tenant_selection_required'||r.p.tenant_selection_required===true)&&Array.isArray(r.p.tenants)){showPicker(r.p.tenants,r.p.message||r.p.error);return;}fail(r.p&&r.p.error);}).catch(function(){busy(false);fail(copy.network);});});
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ready);else ready();
})();`;
