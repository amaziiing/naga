(function(){
  const API = window.NAGA_API || {};
  const API_BASE = (window.NAGA_CONFIG && window.NAGA_CONFIG.api && window.NAGA_CONFIG.api.baseUrl) || '';
  const amount=document.querySelector('.withdraw-field input[type="number"]');
  const txInput=document.querySelector('.withdraw-field input[type="password"]');
  const submit=document.querySelector('.submit-btn');
  const quickButtons=[...document.querySelectorAll('.withdraw-quick button')];
  const minimumDisplay=document.getElementById('withdrawMinimumDisplay');
  let mainBalance = null;
  let withdrawalPolicy = null;
  let globalMinWithdraw = Number(window.NAGA_TRANSACTION_LIMITS&&window.NAGA_TRANSACTION_LIMITS.minWithdrawalAmount)||null;
  let gatewayChannels=[];

  function token(){return localStorage.getItem('member_token')||'';}
  function requireLogin(){ if(!token()){ location.href='login.html?redirect=withdraw.html'; return false;} return true; }
  function money(v){ const n=Number(v||0); return 'MYR '+(isNaN(n)?0:n).toFixed(2); }
  function numeric(v){ const n=Number(v); return Number.isFinite(n)?n:0; }
  function setBalance(v){ const n=Number(v); if(!Number.isFinite(n)) return; mainBalance=n; localStorage.setItem('member_main_wallet_balance', String(mainBalance)); localStorage.setItem('member_main_wallet_balance_confirmed_at', String(Date.now())); document.querySelectorAll('[data-main-wallet-balance], .withdraw-balance strong').forEach(el=>el.textContent=money(mainBalance)); }
  function msg(text, ok){ let box=document.getElementById('withdrawMsg'); if(!box){ box=document.createElement('div'); box.id='withdrawMsg'; box.className='withdraw-note'; document.querySelector('.deposit-actions')?.before(box); } box.style.color=ok?'#19ff5a':'#ff4040'; box.textContent=text; }
  function getBalanceFromJson(json){ const d=(json&&json.data)||json||{}; const arr=[d.balance,d.mainWalletBalance,d.main_wallet_balance,d.walletBalance,d.wallet_balance,d.mainWallet&&d.mainWallet.balance,d.wallet&&d.wallet.balance]; for(const v of arr){ if(v!==undefined&&v!==null&&v!==''){ const n=Number(v); if(!isNaN(n)) return n; } } return null; }

  function exactPromotionAmount(){
    if(!withdrawalPolicy || withdrawalPolicy.restricted!==true || withdrawalPolicy.exactAmountRequired!==true) return null;
    const n=numeric(withdrawalPolicy.allowed);
    return n>0?n:null;
  }

  function applyWithdrawalPolicy(policy){
    withdrawalPolicy=policy||null;
    const fixed=exactPromotionAmount();
    if(fixed!==null){
      if(minimumDisplay) minimumDisplay.textContent=money(fixed)+' (Promotion Fixed)';
      if(amount){ amount.value=String(fixed); amount.min=String(fixed); amount.max=String(fixed); amount.step='0.01'; amount.readOnly=true; }
      quickButtons.forEach(btn=>{ btn.disabled=true; btn.setAttribute('aria-disabled','true'); });
      msg('Promotion withdrawal is fixed at '+money(fixed)+'. After BO approval, any remaining promotion balance will be cleared.', true);
      return;
    }
    if(globalMinWithdraw!=null){ if(minimumDisplay) minimumDisplay.textContent=money(globalMinWithdraw); if(amount){ amount.readOnly=false; amount.min=String(globalMinWithdraw); amount.removeAttribute('max'); } }
    quickButtons.forEach(btn=>{ btn.disabled=false; btn.removeAttribute('aria-disabled'); });
  }


  async function fetchTransactionLimits(){
    try{
      const url=API.frontendDisplaySetting||(API_BASE.replace(/\/+$/,'')+'/api/frontend/display-setting');
      const res=await fetch(url+(url.includes('?')?'&':'?')+'_limit_ts='+Date.now(),{cache:'no-store',headers:{'Cache-Control':'no-cache, no-store, must-revalidate','Pragma':'no-cache'}});
      const json=await res.json().catch(()=>({}));
      if(res.ok&&json.status!=='error'){ const n=Number((json.data||{}).minWithdrawalAmount); if(Number.isFinite(n)&&n>0) globalMinWithdraw=n; }
    }catch(e){}
    applyWithdrawalPolicy(withdrawalPolicy);
    return globalMinWithdraw;
  }

  async function fetchMainBalance(){
    const url=(API.playerMainWalletBalance||API.playerProviderWalletBalance||(API_BASE.replace(/\/+$/,'')+'/api/player/provider/wallet-balance'));
    const freshUrl=String(url)+(String(url).includes('?')?'&':'?')+'_wallet_ts='+Date.now();
    const res=await fetch(freshUrl,{cache:'no-store',headers:{Authorization:'Bearer '+token(),'Cache-Control':'no-cache, no-store, must-revalidate',Pragma:'no-cache'}});
    const json=await res.json().catch(()=>({}));
    if(!res.ok||json.status==='error') throw new Error(json.message||'Unable to load wallet balance');
    const b=getBalanceFromJson(json); if(b!==null) setBalance(b); return b;
  }

  async function fetchWithdrawalPolicy(){
    const url=API.memberWithdrawalPolicy||(API_BASE.replace(/\/+$/,'')+'/api/member/withdrawal-policy');
    const res=await fetch(url+(url.includes('?')?'&':'?')+'_policy_ts='+Date.now(),{cache:'no-store',headers:{Authorization:'Bearer '+token(),'Cache-Control':'no-cache, no-store, must-revalidate',Pragma:'no-cache'}});
    const json=await res.json().catch(()=>({}));
    if(!res.ok||json.status==='error') throw new Error(json.message||'Unable to load withdrawal policy');
    applyWithdrawalPolicy(json.data||{});
    return json.data||{};
  }

  async function loadMe(){
    const res=await fetch((window.NAGA_CONFIG?.api?.baseUrl||'')+'/api/auth/member/me',{headers:{Authorization:'Bearer '+token()}});
    const json=await res.json().catch(()=>({}));
    if(!res.ok||json.status==='error') throw new Error(json.message||'Unauthorized');
    const m=json.data||{};
    const rows=[['Bank Account Name',m.bankAccountName],['Bank Account No',m.bankAccountNumber]];
    if(Number(m.showBankBsb??1)===1) rows.push(['Bank BSB',m.bankBsb]);
    if(Number(m.showPayId??1)===1) rows.push(['Pay ID',m.payId]);
    const box=document.querySelector('.withdraw-bank-box');
    if(box) box.innerHTML=rows.map(r=>'<div class="bank-row"><span>'+r[0]+'</span><b>'+(r[1]||'-')+'</b></div>').join('');
    const bank=document.querySelector('.withdraw-info-grid div:nth-child(3) b'); if(bank) bank.textContent=m.bankName||'-';
    if(!m.hasTransactionPassword) msg('Please set transaction password in Setting before withdraw.', false);
  }


  async function fetchGatewayChannels(){
    if(!API.paymentGatewayChannels) return [];
    try{
      const url=String(API.paymentGatewayChannels)+(String(API.paymentGatewayChannels).includes('?')?'&':'?')+'direction=WITHDRAW&_gateway_ts='+Date.now();
      const res=await fetch(url,{cache:'no-store',headers:{'Cache-Control':'no-cache, no-store, must-revalidate',Pragma:'no-cache'}});
      const json=await res.json().catch(()=>({}));
      if(!res.ok||json.status==='error') return [];
      gatewayChannels=Array.isArray(json.data&&json.data.content)?json.data.content:[];
      renderGatewayChannels(); return gatewayChannels;
    }catch(e){gatewayChannels=[];renderGatewayChannels();return [];}
  }
  function renderGatewayChannels(){
    let wrap=document.getElementById('withdrawGatewayWrap');
    if(!gatewayChannels.length){ if(wrap) wrap.remove(); return; }
    if(!wrap){
      wrap=document.createElement('label');wrap.id='withdrawGatewayWrap';wrap.className='withdraw-field';
      const bankBox=document.querySelector('.withdraw-bank-box');bankBox?.before(wrap);
    }
    wrap.innerHTML=`<span>Withdrawal Method</span><select id="withdrawGatewayChannel"><option value="">Manual / BO payout</option>${gatewayChannels.map(g=>`<option value="${String(g.id).replace(/"/g,'')}">${String(g.displayName||g.gatewayName||'Payment Gateway').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))} · ${String(g.gatewayName||'Gateway').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}</option>`).join('')}</select><small style="display:block;margin-top:6px;opacity:.78">If a gateway is selected, BO approval will send the payout through that configured API.</small>`;
  }
  async function submitWithdraw(){
    if(!requireLogin()) return;
    const val=Number(amount?.value||0);
    const fixed=exactPromotionAmount();
    if(fixed!==null && Math.abs(val-fixed)>0.000001){ msg('Promotion withdrawal amount is fixed at '+money(fixed)+'.',false); return; }
    if(fixed===null && globalMinWithdraw==null){ msg('Withdrawal setting is still loading from BO. Please try again.',false); return; }
    if(fixed===null && val<globalMinWithdraw){msg('Minimum withdraw is '+money(globalMinWithdraw),false);return;}
    submit.disabled=true; msg('Submitting withdraw request...',true);
    try{
      const res=await fetch(API.memberWithdraw,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token()},body:JSON.stringify({amount:val,transactionPassword:txInput?.value||'',gatewayChannelId:document.getElementById('withdrawGatewayChannel')?.value||null})});
      const json=await res.json().catch(()=>({}));
      if(!res.ok||json.status==='error') throw new Error(json.message||'Withdraw failed');
      msg(json.message||'Withdraw submitted, waiting BO approval.',true);
      if(amount && fixed===null) amount.value='';
      if(txInput) txInput.value='';
      await fetchMainBalance().catch(()=>{});
      await fetchWithdrawalPolicy().catch(()=>{});
    }catch(e){msg(e.message||'Withdraw failed',false);} finally{submit.disabled=false;}
  }

  quickButtons.forEach(btn=>btn.addEventListener('click',()=>{
    if(!amount || btn.disabled) return;
    amount.value=btn.textContent.trim()==='MAX'?(mainBalance==null?'':String(mainBalance)):btn.textContent.trim();
    amount.focus();
  }));

  window.addEventListener('naga:transaction-limits',function(e){ const n=Number(e.detail&&e.detail.minWithdrawalAmount); if(Number.isFinite(n)&&n>0){ globalMinWithdraw=n; applyWithdrawalPolicy(withdrawalPolicy); } });

  document.addEventListener('DOMContentLoaded',async()=>{
    if(!requireLogin()) return;
    await Promise.allSettled([loadMe(),fetchMainBalance(),fetchTransactionLimits(),fetchGatewayChannels()]);
    fetchWithdrawalPolicy().catch(e=>msg(e.message,false));
    submit?.addEventListener('click',submitWithdraw);
  });
})();
