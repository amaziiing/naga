(function(){
  'use strict';
  const state={baseCurrency:'MYR',currency:'MYR',enabledCurrencies:['MYR'],rateFromBase:1,symbol:'RM',decimalPlaces:2};
  function apply(d){if(!d)return;state.baseCurrency=String(d.baseCurrency||state.baseCurrency||'MYR').toUpperCase();state.currency=String(d.currency||state.currency||state.baseCurrency).toUpperCase();state.enabledCurrencies=Array.isArray(d.enabledCurrencies)&&d.enabledCurrencies.length?d.enabledCurrencies.map(x=>String(x).toUpperCase()):[state.currency];state.rateFromBase=Number(d.rateFromBase||1)||1;state.symbol=d.currencySymbol||d.symbol||state.currency;state.decimalPlaces=Math.max(0,Math.min(6,Number(d.currencyDecimals??d.decimalPlaces??2)));document.documentElement.dataset.currency=state.currency;replaceLabels(document.body);}
  function code(){return state.currency||'MYR';}
  function format(value){const n=Number(value);if(!Number.isFinite(n))return '-';return code()+' '+n.toLocaleString('en-US',{minimumFractionDigits:state.decimalPlaces,maximumFractionDigits:state.decimalPlaces});}
  function replaceLabels(root){if(!root||code()==='MYR')return;const w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);const nodes=[];while(w.nextNode())nodes.push(w.currentNode);nodes.forEach(n=>{if(n.parentElement&&/^(SCRIPT|STYLE|TEXTAREA|OPTION)$/i.test(n.parentElement.tagName))return;if(/\b(MYR|RM)\b/.test(n.nodeValue||''))n.nodeValue=n.nodeValue.replace(/\b(MYR|RM)\b/g,code());});root.querySelectorAll&&root.querySelectorAll('option').forEach(o=>{if(/^(MYR|RM)(?:\s|$)/.test(o.textContent||''))o.textContent=o.textContent.replace(/^(MYR|RM)/,code());});}
  window.NAGA_CURRENCY={state,code,format,apply};
  window.addEventListener('naga:brand-ready',e=>apply(e.detail||{}));
  if(window.NAGA_BRAND&&window.NAGA_BRAND.data)apply(window.NAGA_BRAND.data);
  document.addEventListener('DOMContentLoaded',()=>{if(window.NAGA_BRAND&&window.NAGA_BRAND.data)apply(window.NAGA_BRAND.data);const obs=new MutationObserver(ms=>ms.forEach(m=>m.addedNodes.forEach(n=>{if(n.nodeType===1)replaceLabels(n);else if(n.nodeType===3&&n.parentElement)replaceLabels(n.parentElement);})));if(document.body)obs.observe(document.body,{childList:true,subtree:true});});
})();
