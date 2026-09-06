(function(){
  const API = window.NAGA_API || {};
  const UPLOAD_BASE = (window.NAGA_CONFIG && window.NAGA_CONFIG.api && window.NAGA_CONFIG.api.uploadBaseUrl) || '';
  const input=document.querySelector('.deposit-field input');
  const submit=document.querySelector('.submit-btn');
  const grid=document.querySelector('.payment-grid');
  let paymentMethods=[];
  let selectedIndex=-1;
  const PAYMENT_CACHE_KEY='naga_payment_methods_v2:'+location.host;
  function readPaymentCache(){try{const x=JSON.parse(localStorage.getItem(PAYMENT_CACHE_KEY)||'[]');return Array.isArray(x)?x.filter(m=>!m?.isGateway&&String(m?.methodType||'').toUpperCase()!=='GATEWAY'):[];}catch(e){return [];}}
  function writePaymentCache(rows){try{localStorage.setItem(PAYMENT_CACHE_KEY,JSON.stringify((rows||[]).filter(m=>!m?.isGateway&&String(m?.methodType||'').toUpperCase()!=='GATEWAY')));}catch(e){}}
  let minimumDeposit=Number(window.NAGA_TRANSACTION_LIMITS&&window.NAGA_TRANSACTION_LIMITS.minDepositAmount)||null;
  const minimumDisplay=document.getElementById('depositMinimumDisplay');

  function token(){return localStorage.getItem('member_token')||'';}
  function requireLogin(){ if(!token()){ location.href='login.html?redirect=deposit.html'; return false;} return true; }
  function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  function money(v){const n=Number(v||0); return 'MYR '+(Number.isFinite(n)?n.toFixed(2):'0.00');}
  function fileUrl(name){ if(!name) return ''; if(/^https?:\/\//i.test(name)) return name; return UPLOAD_BASE.replace(/\/+$/,'') + '/payment/' + name; }
  function msg(text, ok){ let box=document.getElementById('depositMsg'); if(!box){ box=document.createElement('div'); box.id='depositMsg'; box.className='deposit-note'; document.querySelector('.deposit-actions')?.before(box); } box.style.color=ok?'#19ff5a':'#ff4040'; box.textContent=text; }
  function setBalance(v){ const n=Number(v); if(!Number.isFinite(n)) return; document.querySelectorAll('[data-main-wallet-balance]').forEach(el=>el.textContent=money(n)); localStorage.setItem('member_main_wallet_balance', String(n)); localStorage.setItem('member_main_wallet_balance_confirmed_at', String(Date.now())); }
  function extractBalance(json){ const d=(json&&json.data)||json||{}; const list=[d.balance,d.mainWalletBalance,d.walletBalance,d.mainWallet&&d.mainWallet.balance,d.wallet&&d.wallet.balance]; for(const v of list){ if(v!==undefined&&v!==null&&v!==''){ const n=Number(v); if(!isNaN(n)) return n; } } return null; }
  async function loadBalance(){ const url=String(API.playerMainWalletBalance)+(String(API.playerMainWalletBalance).includes('?')?'&':'?')+'_wallet_ts='+Date.now(); const res=await fetch(url,{cache:'no-store',headers:{Authorization:'Bearer '+token(),'Cache-Control':'no-cache, no-store, must-revalidate',Pragma:'no-cache'}}); const json=await res.json().catch(()=>({})); if(!res.ok||json.status==='error') throw new Error(json.message||'Unable to load balance'); const b=extractBalance(json); if(b!==null) setBalance(b); }


  async function loadTransactionLimits(){
    try{
      const base=(window.NAGA_CONFIG&&window.NAGA_CONFIG.api&&window.NAGA_CONFIG.api.baseUrl)||'';
      const endpoint=API.frontendDisplaySetting||(String(base).replace(/\/+$/,'')+'/api/frontend/display-setting');
      const url=String(endpoint)+(String(endpoint).includes('?')?'&':'?')+'_limit_ts='+Date.now();
      const res=await fetch(url,{cache:'no-store',headers:{'Cache-Control':'no-cache, no-store, must-revalidate','Pragma':'no-cache'}});
      const json=await res.json().catch(()=>({}));
      if(res.ok&&json.status!=='error'){ const n=Number((json.data||{}).minDepositAmount); if(Number.isFinite(n)&&n>0) minimumDeposit=n; }
    }catch(e){}
    if(minimumDeposit!=null){ if(input) input.min=String(minimumDeposit); if(minimumDisplay) minimumDisplay.textContent='Minimum Deposit: '+money(minimumDeposit); }
  }

  function selectedMethod(){ const m=paymentMethods[selectedIndex]; return m ? (m.displayName || m.methodType || '') : ''; }
  function icon(type,m){ if(m&&m.isGateway){const u=String(m.gatewayLogoUrl||'').trim();return u?`<img class="gateway-method-logo" src="${esc(u)}" alt="${esc(m.gatewayName||m.displayName||'Gateway')}" onerror="this.style.display='none';this.nextElementSibling.style.display=''"><i class="gateway-method-fallback" style="display:none">⚡</i>`:'⚡';} if(type==='EWALLET') return '📱'; if(type==='CARD') return '💳'; return '🏦'; }
  function renderMethodButtons(){
    if(!grid) return;
    if(!paymentMethods.length){
      selectedIndex=-1;
      grid.innerHTML='<div class="payment-empty" aria-hidden="true">&nbsp;</div>';
      renderPaymentInfo();
      return;
    }
    if(selectedIndex < 0 || selectedIndex >= paymentMethods.length) selectedIndex=0;
    grid.innerHTML=paymentMethods.map((m,i)=>`<button type="button" class="pay-method ${i===selectedIndex?'active':''}" data-method-index="${i}"><span>${icon(String(m.methodType||'').toUpperCase(),m)}</span><b>${esc(m.displayName||m.methodType||'-')}</b><em>${esc(m.subtitle||'')}</em></button>`).join('');
    grid.querySelectorAll('.pay-method').forEach(btn=>btn.addEventListener('click',()=>{
      grid.querySelectorAll('.pay-method').forEach(x=>x.classList.remove('active'));
      btn.classList.add('active');
      selectedIndex=Number(btn.dataset.methodIndex);
      renderPaymentInfo();
    }));
    renderPaymentInfo();
  }
  async function loadPaymentMethods(){
    if(!paymentMethods.length){
      paymentMethods=readPaymentCache().filter(m=>Number(m&&m.status==null?1:m.status)!==0);
      if(paymentMethods.length) renderMethodButtons();
    }
    const manualUrl=String(API.paymentMethodList)+(String(API.paymentMethodList).includes('?')?'&':'?')+'_payment_ts='+Date.now();
    const gatewayUrl=String(API.paymentGatewayChannels||'')+(String(API.paymentGatewayChannels||'').includes('?')?'&':'?')+'direction=DEPOSIT&_gateway_ts='+Date.now();
    const [manualResult,gatewayResult]=await Promise.allSettled([
      fetch(manualUrl,{cache:'no-store',headers:{'Cache-Control':'no-cache, no-store, must-revalidate',Pragma:'no-cache'}}).then(async res=>({res,json:await res.json().catch(()=>({}))})),
      API.paymentGatewayChannels?fetch(gatewayUrl,{cache:'no-store',headers:{'Cache-Control':'no-cache, no-store, must-revalidate',Pragma:'no-cache'}}).then(async res=>({res,json:await res.json().catch(()=>({}))})):Promise.resolve(null)
    ]);
    const merged=[];
    if(manualResult.status==='fulfilled'&&manualResult.value){const {res,json}=manualResult.value;if(res.ok&&json.status!=='error'){const rows=(json.data&&json.data.content)||json.data||[];if(Array.isArray(rows))merged.push(...rows.filter(m=>Number(m&&m.status==null?1:m.status)!==0&&String(m?.methodType||'').toUpperCase()!=='GATEWAY'));}}
    if(gatewayResult.status==='fulfilled'&&gatewayResult.value){const {res,json}=gatewayResult.value;if(res.ok&&json.status!=='error'){const rows=(json.data&&json.data.content)||[];if(Array.isArray(rows)){const grouped=new Map();for(const g of rows){const separate=Number(g.depositChannelSelection||0)===1;if(separate){merged.push({...g,id:'gateway:'+g.id,gatewayChannelId:g.id,isGateway:true,methodType:'GATEWAY',subtitle:g.gatewayName||'Online Payment',status:1});continue;}const key=String(g.gatewayId);if(!grouped.has(key))grouped.set(key,{...g,id:'gateway-group:'+g.gatewayId,gatewayChannelId:null,isGateway:true,isGatewayGroup:true,methodType:'GATEWAY',displayName:g.gatewayName||g.displayName||'Online Payment',gatewayLogoUrl:g.gatewayLogoUrl||'',subtitle:'Online Payment',minAmount:0,maxAmount:0,status:1});}merged.push(...grouped.values());}}}
    if(merged.length){paymentMethods=merged;writePaymentCache(paymentMethods);}else if(!paymentMethods.length){paymentMethods=[];}
    renderMethodButtons();
  }
  function renderPaymentInfo(){
    let box=document.getElementById('paymentInfoBox'); if(!box){ box=document.createElement('div'); box.id='paymentInfoBox'; box.className='deposit-note payment-config-box'; grid?.after(box); }
    const m=paymentMethods[selectedIndex]||null;
    if(!m){ box.innerHTML=''; return; }
    if(m.isGateway){
      box.innerHTML=`<b>${esc(m.displayName||m.gatewayName||'Online Payment')}</b><p>Secure online payment via ${esc(m.gatewayName||'payment gateway')}. You will be redirected to complete payment after submit.</p>${m.minAmount?`<small>Minimum: ${esc(money(m.minAmount))}</small>`:''}${m.maxAmount&&Number(m.maxAmount)>0?`<small> · Maximum: ${esc(money(m.maxAmount))}</small>`:''}`;
      const proofWrap=document.getElementById('depositProofWrap'); if(proofWrap) proofWrap.hidden=true;
      return;
    }
    const proofWrap=document.getElementById('depositProofWrap'); if(proofWrap) proofWrap.hidden=false;
    const rows=[];
    if(m.bankName) rows.push(`<div><b>Bank Name</b><span>${esc(m.bankName)}</span></div>`);
    if(m.accountName) rows.push(`<div><b>Account Name</b><span>${esc(m.accountName)}</span></div>`);
    if(m.accountNumber) rows.push(`<div><b>Account No</b><span>${esc(m.accountNumber)}</span></div>`);
    if(m.bankBsb) rows.push(`<div><b>Bank BSB</b><span>${esc(m.bankBsb)}</span></div>`);
    if(m.payId) rows.push(`<div><b>Pay ID</b><span>${esc(m.payId)}</span></div>`);
    const qr=m.qrImage?`<div class="payment-config-qr"><img src="${esc(fileUrl(m.qrImage))}" alt="QR"></div>`:'';
    const info=rows.length?`<div class="payment-config-list">${rows.join('')}</div>`:'';
    const inst=m.instructions?`<p>${esc(m.instructions).replace(/\n/g,'<br>')}</p>`:'';
    box.innerHTML=`<b>${esc(m.displayName||m.methodType||'-')}</b>${info}${qr}${inst}`;
  }

  document.querySelectorAll('.quick-amounts button').forEach(btn=>btn.addEventListener('click',()=>{ if(input){ input.value=btn.textContent.trim(); input.focus(); } }));
  function ensureProof(){
    let wrap=document.getElementById('depositProofWrap'); if(wrap) return;
    wrap=document.createElement('div'); wrap.id='depositProofWrap'; wrap.className='deposit-field deposit-proof-field';
    wrap.innerHTML=`<span data-i18n="payment_proof">Payment Proof</span><label class="payment-proof-upload" for="depositProof"><input type="file" id="depositProof" accept="image/*"><div class="payment-proof-empty" id="paymentProofEmpty"><i class="fa-solid fa-cloud-arrow-up"></i><b data-i18n="choose_payment_proof">Choose payment proof or drag here</b><em data-i18n="payment_proof_hint">PNG, JPG, WEBP accepted</em></div><div class="payment-proof-preview" id="paymentProofPreview" hidden><img id="paymentProofImg" alt="Payment proof preview"><div><b id="paymentProofName">-</b><em id="paymentProofSize">-</em><button type="button" class="payment-proof-remove" id="paymentProofRemove" data-i18n="remove">Remove</button></div></div></label>`;
    document.querySelector('.deposit-note')?.before(wrap);
    const fileInput=wrap.querySelector('#depositProof'), box=wrap.querySelector('.payment-proof-upload'), empty=wrap.querySelector('#paymentProofEmpty'), preview=wrap.querySelector('#paymentProofPreview'), img=wrap.querySelector('#paymentProofImg'), name=wrap.querySelector('#paymentProofName'), size=wrap.querySelector('#paymentProofSize'), remove=wrap.querySelector('#paymentProofRemove');
    function prettySize(bytes){ if(!bytes) return ''; if(bytes<1024*1024) return (bytes/1024).toFixed(1)+' KB'; return (bytes/1024/1024).toFixed(2)+' MB'; }
    function showFile(file){ if(!file){ empty.hidden=false; preview.hidden=true; img.removeAttribute('src'); return; } name.textContent=file.name; size.textContent=prettySize(file.size); img.src=URL.createObjectURL(file); empty.hidden=true; preview.hidden=false; }
    fileInput.addEventListener('change',()=>showFile(fileInput.files&&fileInput.files[0]));
    remove.addEventListener('click',e=>{ e.preventDefault(); e.stopPropagation(); fileInput.value=''; showFile(null); });
    ['dragenter','dragover'].forEach(evt=>box.addEventListener(evt,e=>{ e.preventDefault(); box.classList.add('is-dragover'); }));
    ['dragleave','drop'].forEach(evt=>box.addEventListener(evt,e=>{ e.preventDefault(); box.classList.remove('is-dragover'); }));
    box.addEventListener('drop',e=>{ const file=e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files[0]; if(!file)return; const dt=new DataTransfer(); dt.items.add(file); fileInput.files=dt.files; showFile(file); });
    if(window.NAGA_LANG&&typeof window.NAGA_LANG.apply==='function') window.NAGA_LANG.apply();
  }
  async function submitDeposit(){
    if(!requireLogin()) return; if(minimumDeposit==null){ msg('Deposit setting is still loading from BO. Please try again.',false); return; } const amount=Number(input?.value||0); if(amount<minimumDeposit){ msg('Minimum deposit is '+money(minimumDeposit),false); return; }
    const method=paymentMethods[selectedIndex]; if(!method){ msg('Please select a payment method',false); return; }
    if(Number(method.minAmount||0)>0&&amount<Number(method.minAmount)){msg('Minimum for this payment method is '+money(method.minAmount),false);return;}
    if(Number(method.maxAmount||0)>0&&amount>Number(method.maxAmount)){msg('Maximum for this payment method is '+money(method.maxAmount),false);return;}
    submit.disabled=true; msg(method.isGateway?'Starting secure payment...':'Submitting deposit request...', true);
    try{
      if(method.isGateway){
        const res=await fetch(API.paymentGatewayDeposit,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token()},body:JSON.stringify(method.gatewayChannelId?{amount,channelId:method.gatewayChannelId}:{amount,gatewayId:method.gatewayId})});
        const json=await res.json().catch(()=>({})); if(!res.ok||json.status==='error') throw new Error(json.message||'Payment gateway failed');
        const redirect=json.data&&json.data.redirectUrl; if(!redirect) throw new Error('Payment gateway did not return a payment URL');
        msg('Redirecting to '+(method.gatewayName||'payment gateway')+'...',true); location.href=redirect; return;
      }
      const fd=new FormData(); fd.append('amount', String(amount)); if(method.id!=null){ fd.append('paymentMethodId', String(method.id)); fd.append('selectedPaymentMethodId', String(method.id)); } fd.append('paymentMethod', String(method.displayName||method.bankName||method.methodType||selectedMethod())); const proof=document.getElementById('depositProof')?.files?.[0]; if(proof) fd.append('proof', proof);
      const res=await fetch(API.memberDeposit,{method:'POST',headers:{Authorization:'Bearer '+token()},body:fd}); const json=await res.json().catch(()=>({})); if(!res.ok||json.status==='error') throw new Error(json.message||'Deposit failed'); msg(json.message||'Deposit submitted, waiting BO approval.', true); input.value=''; const proofInput=document.getElementById('depositProof'); if(proofInput){ proofInput.value=''; document.getElementById('paymentProofEmpty')?.removeAttribute('hidden'); document.getElementById('paymentProofPreview')?.setAttribute('hidden','hidden'); } await loadBalance().catch(()=>{});
    }
    catch(e){ msg(e.message||'Deposit failed', false); }
    finally{ submit.disabled=false; }
  }
  window.addEventListener('naga:transaction-limits',function(e){ const n=Number(e.detail&&e.detail.minDepositAmount); if(Number.isFinite(n)&&n>0){ minimumDeposit=n; if(input) input.min=String(minimumDeposit); if(minimumDisplay) minimumDisplay.textContent='Minimum Deposit: '+money(minimumDeposit); } });

  document.addEventListener('DOMContentLoaded',()=>{ if(!requireLogin()) return; ensureProof(); loadTransactionLimits(); loadPaymentMethods(); loadBalance().catch(()=>{}); submit?.addEventListener('click',submitDeposit); });
})();
