/* ═══════════════════════════════════════════════════════════════════════════════
   EX LIBRIS JURIS v3.4 — JAVASCRIPT
   ═══════════════════════════════════════════════════════════════════════════════ */
var token=null,currentUser=null,currentMatter=null,matters=[],documents=[],matterHistory=[],focusAreas=new Set(),isLoading=false,histOpen=false,jurisdiction='Bermuda',pendingTool=null;
var toolHistoryCache={};
var libraryData={caseTypes:[],subcats:[],docTypes:[],precedents:[],sections:[]};
var selectedPrecedentId=null;
var draftHeading={court:'',caseNo:'',party1:'',party1Role:'',party2:'',party2Role:'',docTitle:''};
var quickAddType='';
var openTabs=['chat'];
var activeTab='chat';

var stored=localStorage.getItem('elj_token');
if(stored){token=stored;}

/* ── API ─────────────────────────────────────────────────────────────────── */
async function api(url,method,body){
  method=method||'GET';
  var opts={method:method,headers:{'Content-Type':'application/json'}};
  if(token)opts.headers['Authorization']='Bearer '+token;
  if(body)opts.body=JSON.stringify(body);
  var r=await fetch(url,opts);
  /* v2.5: Token refresh — if 401, try to get a fresh token */
  if(r.status===401&&token&&!url.includes('action=login')){
    var refreshed=await tryRefreshToken();
    if(refreshed){
      opts.headers['Authorization']='Bearer '+token;
      r=await fetch(url,opts);
    }else{
      token=null;localStorage.removeItem('elj_token');showLogin();
      throw new Error('Session expired — please sign in again');
    }
  }
  var ct=r.headers.get('content-type')||'';
  if(!ct.includes('application/json')){var t=await r.text();throw new Error(t.slice(0,120));}
  var d=await r.json();
  if(!r.ok)throw new Error(d.error||'Request failed');
  return d;
}

/* v2.5: Try to refresh an expired token by re-verifying or re-authenticating */
async function tryRefreshToken(){
  /* First try: use the Supabase refresh token if stored */
  var refreshToken=localStorage.getItem('elj_refresh_token');
  if(refreshToken){
    try{
      var r=await fetch('/api/auth?action=refresh','POST',{headers:{'Content-Type':'application/json'},body:JSON.stringify({refresh_token:refreshToken})});
      if(r&&r.ok){
        var d=await r.json();
        if(d.token){
          token=d.token;
          localStorage.setItem('elj_token',token);
          if(d.refresh_token)localStorage.setItem('elj_refresh_token',d.refresh_token);
          return true;
        }
      }
    }catch(e){console.log('Refresh attempt failed:',e.message);}
  }
  /* Second try: if we have stored credentials, re-authenticate silently */
  var storedEmail=localStorage.getItem('elj_email');
  var storedPassB64=localStorage.getItem('elj_pass');
  if(storedEmail&&storedPassB64){
    try{
      var storedPass=atob(storedPassB64);
      var r2=await fetch('/api/auth?action=login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:storedEmail,password:storedPass})});
      if(r2.ok){
        var d2=await r2.json();
        if(d2.token){
          token=d2.token;
          localStorage.setItem('elj_token',token);
          if(d2.refresh_token)localStorage.setItem('elj_refresh_token',d2.refresh_token);
          currentUser=d2.user;
          return true;
        }
      }
    }catch(e){console.log('Re-auth attempt failed:',e.message);}
  }
  return false;
}

/* ── INIT ────────────────────────────────────────────────────────────────── */
async function init(){
  if(!token){showLogin();return;}
  try{
    var d=await api('/api/auth?action=verify','POST');
    currentUser=d.user;
    document.getElementById('userLabel').textContent=currentUser.name||currentUser.email;
    showApp();await loadMatters();await loadLibrary();
  }catch(e){token=null;localStorage.removeItem('elj_token');showLogin();}
}
function showLogin(){document.getElementById('loginScreen').style.display='flex';document.getElementById('appShell').style.display='none';}
function showApp(){document.getElementById('loginScreen').style.display='none';document.getElementById('appShell').style.display='flex';}
async function logout(){token=null;localStorage.removeItem('elj_token');localStorage.removeItem('elj_email');localStorage.removeItem('elj_pass');localStorage.removeItem('elj_refresh_token');currentUser=null;currentMatter=null;showLogin();}

/* ── AUTH ─────────────────────────────────────────────────────────────────── */
document.getElementById('loginBtn').addEventListener('click',async function(){
  var email=document.getElementById('loginEmail').value.trim();
  var password=document.getElementById('loginPassword').value;
  var err=document.getElementById('loginErr');
  err.style.display='none';
  try{
    var d=await api('/api/auth?action=login','POST',{email:email,password:password});
    token=d.token;
    if(document.getElementById('rememberMe').checked){
      localStorage.setItem('elj_token',token);
      localStorage.setItem('elj_email',email);
      localStorage.setItem('elj_pass',btoa(password));
      if(d.refresh_token)localStorage.setItem('elj_refresh_token',d.refresh_token);
    }
    currentUser=d.user;
    document.getElementById('userLabel').textContent=currentUser.name||currentUser.email;
    showApp();await loadMatters();await loadLibrary();
  }catch(e){err.textContent=e.message;err.style.display='block';}
});
document.getElementById('loginEmail').addEventListener('keydown',function(e){if(e.key==='Enter')document.getElementById('loginBtn').click();});
document.getElementById('loginPassword').addEventListener('keydown',function(e){if(e.key==='Enter')document.getElementById('loginBtn').click();});

/* ── JURISDICTION ────────────────────────────────────────────────────────── */
document.querySelectorAll('.jur-tab').forEach(function(btn){
  btn.addEventListener('click',function(){
    document.querySelectorAll('.jur-tab').forEach(function(b){b.classList.remove('active');});
    btn.classList.add('active');jurisdiction=btn.dataset.jur;
  });
});

/* ── FOCUS CHIPS ─────────────────────────────────────────────────────────── */
document.querySelectorAll('.chip').forEach(function(c){
  c.addEventListener('click',function(){
    var v=c.dataset.v;if(!v)return;
    if(focusAreas.has(v)){focusAreas.delete(v);c.classList.remove('on');}
    else{focusAreas.add(v);c.classList.add('on');}
  });
});
function addFocusChip(){var name=prompt('Focus area name:');if(!name||!name.trim())return;var chip=document.createElement('span');chip.className='chip';chip.setAttribute('data-v',name.trim());chip.innerHTML=esc(name.trim())+' <button class="chip-del" onclick="this.parentElement.remove()">&times;</button>';var container=document.getElementById('focusChips');var addBtn=container.querySelector('.chip-add');container.insertBefore(chip,addBtn);}

/* ── MATTERS CRUD ────────────────────────────────────────────────────────── */
async function loadMatters(){
  try{var d=await api('/api/matters');matters=d.matters||[];renderMatters();}catch(e){console.error(e);}
}
function renderMatters(){
  var list=document.getElementById('mattersList');
  if(!matters.length){list.innerHTML='<div class="empty-state">No matters yet.<br>Create one to begin.</div>';return;}
  list.innerHTML=matters.map(function(m){return '<div class="matter-item'+(currentMatter&&currentMatter.id===m.id?' active':'')+'" onclick="selectMatter(\''+m.id+'\')">'
    +'<div class="matter-name">'+esc(m.name)+'</div>'
    +'<div class="matter-meta">'
    +'<span class="badge badge-jur">'+esc(m.jurisdiction==='British Virgin Islands'?'BVI':m.jurisdiction)+'</span>'
    +(m.shared?'<span class="badge badge-shared">Shared</span>':'')
    +'<span>'+(m.document_count||0)+' doc'+((m.document_count||0)!==1?'s':'')+'</span>'
    +'</div>'
    +'<div class="matter-actions">'
    +'<button class="btn-icon" onclick="event.stopPropagation();editMatter(\''+m.id+'\')" title="Edit">✏️</button>'
    +'<button class="btn-icon" onclick="event.stopPropagation();shareMatter(\''+m.id+'\')" title="Share">🔗</button>'
    +'<button class="btn-icon" onclick="event.stopPropagation();deleteMatter(\''+m.id+'\',\''+esc(m.name)+'\')" title="Delete">🗑️</button>'
    +'</div></div>';}).join('');
}

async function selectMatter(id){
  currentMatter=matters.find(function(m){return m.id===id;})||null;
  if(!currentMatter)return;
  document.getElementById('chatTitle').textContent=currentMatter.name;
  document.getElementById('chatTitle').classList.remove('empty');
  document.getElementById('toolsBar').style.display='flex';
  document.getElementById('histBtn').style.display='';
  document.getElementById('tabBar').style.display='flex';
  document.getElementById('matterLeftTabs').style.display='flex';
  var rp=document.getElementById('rightPanel');if(rp)rp.style.display='';
  renderMatters();
  openTabs.slice().forEach(function(t){if(t!=='chat')closeTabSilent(t);});
  switchTab('chat');
  clearMessages();
  await loadDocuments(id);
  await loadHistory(id);
  toolHistoryCache[id]={};
  sysMsg('Matter loaded: **'+currentMatter.name+'** · '+currentMatter.jurisdiction+(currentMatter.acting_for?' · Acting for: '+currentMatter.acting_for:''));
  if(currentMatter.nature)sysMsg('Dispute: '+currentMatter.nature);
  renderMatterRecord();
}

/* Matter left tab switching */
function switchMatterLeftTab(which){
  document.querySelectorAll('.matter-left-tab').forEach(function(t){t.classList.toggle('active',t.dataset.mlt===which);});
  document.getElementById('matterListView').style.display=which==='list'?'':'none';
  document.getElementById('matterRecordView').style.display=which==='record'?'':'none';
}
function showMatterRecord(){
  if(!currentMatter){showToast('Select a matter first');return;}
  document.getElementById('matterLeftTabs').style.display='flex';
  switchMatterLeftTab('record');
}

/* Matter Record panel */
function renderMatterRecord(){
  var panel=document.getElementById('matterRecordPanel');
  if(!currentMatter){panel.innerHTML='<div style="font-size:.82rem;color:var(--text-faint);font-style:italic;padding:.5rem 0">Select a matter to view its record.</div>';return;}
  var m=currentMatter;
  var hd=m.heading_data||{};
  panel.innerHTML=
    '<div class="mr-box"><div class="mr-box-label">Client</div><input id="mrClient" value="'+esc(m.client||'')+'" placeholder="Client name…"></div>'
    +'<div class="mr-box"><div class="mr-box-label">Case Type</div>'
    +'<div style="display:flex;gap:.3rem"><select id="mrCaseType" onchange="mrCaseTypeChanged()" style="flex:1;padding:.3rem .5rem;border:1.5px solid var(--border);border-radius:5px;font-size:.85rem"><option value="">— Select —</option></select>'
    +'<button class="lib-box-btn" onclick="libQuickAdd(\'casetype\')" title="Add new">+</button>'
    +'<button class="lib-box-btn del" onclick="draftDeleteFromSelect(\'casetype\')" title="Delete">−</button></div></div>'
    +'<div class="mr-box"><div class="mr-box-label">Procedural Stage</div>'
    +'<div style="display:flex;gap:.3rem"><select id="mrStage" style="flex:1;padding:.3rem .5rem;border:1.5px solid var(--border);border-radius:5px;font-size:.85rem"><option value="">— Select —</option></select>'
    +'<button class="lib-box-btn" onclick="libQuickAdd(\'subcat\')" title="Add new">+</button>'
    +'<button class="lib-box-btn del" onclick="draftDeleteFromSelect(\'subcat\')" title="Delete">−</button></div></div>'
    +'<div class="mr-box"><div class="mr-box-label">Date of Commencement</div><input id="mrDate" type="month" value="'+(m.commencement_date||'')+'"></div>'
    +'<div class="mr-box"><div class="mr-box-label">Instructing Law Firm</div>'
    +'<div style="display:flex;gap:.3rem"><select id="mrLawFirm" style="flex:1;padding:.3rem .5rem;border:1.5px solid var(--border);border-radius:5px;font-size:.85rem"><option value="">— Select —</option></select>'
    +'<button class="lib-box-btn" onclick="addLawFirm()" title="Add firm">+</button></div></div>'
    +'<div class="mr-box"><div class="mr-box-label">Responsible Individual</div><input id="mrResponsible" value="'+esc(m.responsible_individual||'')+'" placeholder="Name…"></div>'
    +'<div class="mr-box" style="border:2px solid var(--blue-light);background:var(--blue-faint)"><div class="mr-box-label" style="color:var(--blue);font-size:.72rem">⚖ Court Heading (appears on all tool outputs)</div>'
    +'<input id="mrHdCourt" value="'+esc(hd.court||'')+'" placeholder="e.g. IN THE SUPREME COURT OF BERMUDA" style="margin-bottom:.3rem">'
    +'<input id="mrHdCaseNo" value="'+esc(hd.caseNo||'')+'" placeholder="e.g. Civil Jurisdiction 2024 No. 123" style="margin-bottom:.3rem">'
    +'<div style="display:flex;gap:.3rem;margin-bottom:.3rem"><input id="mrHdParty1" value="'+esc(hd.party1||'')+'" placeholder="Party 1 name" style="flex:1"><input id="mrHdParty1Role" value="'+esc(hd.party1Role||'')+'" placeholder="Role (e.g. Plaintiff)" style="width:100px"></div>'
    +'<div style="display:flex;gap:.3rem;margin-bottom:.3rem"><input id="mrHdParty2" value="'+esc(hd.party2||'')+'" placeholder="Party 2 name" style="flex:1"><input id="mrHdParty2Role" value="'+esc(hd.party2Role||'')+'" placeholder="Role (e.g. Defendant)" style="width:100px"></div>'
    +'</div>'
    +'<button class="mr-save-btn" onclick="saveMatterRecord()">Save Record</button>';
  loadLawFirms();
  loadMrCaseTypes();
}
async function loadLawFirms(){
  try{
    var d=await api('/api/library?type=law_firms');
    var sel=document.getElementById('mrLawFirm');if(!sel)return;
    var firms=d.data||[];
    var current=currentMatter?currentMatter.law_firm:'';
    sel.innerHTML='<option value="">— Select —</option>'+firms.map(function(f){return '<option value="'+esc(f.name)+'"'+(f.name===current?' selected':'')+'>'+esc(f.name)+'</option>';}).join('');
  }catch(e){console.error('loadLawFirms:',e);}
}
function loadMrCaseTypes(){
  var ct=document.getElementById('mrCaseType');if(!ct)return;
  var currentCtId=currentMatter?currentMatter.case_type_id:'';
  ct.innerHTML='<option value="">— Select —</option>'+libraryData.caseTypes.map(function(c){return '<option value="'+c.id+'"'+(c.id===currentCtId?' selected':'')+'>'+esc(c.name)+'</option>';}).join('');
  mrCaseTypeChanged();
}
function mrCaseTypeChanged(){
  var ctId=document.getElementById('mrCaseType')?document.getElementById('mrCaseType').value:'';
  var st=document.getElementById('mrStage');if(!st)return;
  var currentStId=currentMatter?currentMatter.subcategory_id:'';
  st.innerHTML='<option value="">— Select —</option>'+libraryData.subcats.filter(function(s){return s.case_type_id===ctId;}).map(function(s){return '<option value="'+s.id+'"'+(s.id===currentStId?' selected':'')+'>'+esc(s.name)+'</option>';}).join('');
}
async function addLawFirm(){
  var name=prompt('Law firm name:');if(!name||!name.trim())return;
  try{
    await api('/api/library','POST',{action:'create_law_firm',name:name.trim()});
    await loadLawFirms();showToast('Firm added');
  }catch(e){showToast('Error: '+e.message);}
}
async function saveMatterRecord(){
  if(!currentMatter)return;
  try{
    var headingData={
      court:(document.getElementById('mrHdCourt')?document.getElementById('mrHdCourt').value.trim():''),
      caseNo:(document.getElementById('mrHdCaseNo')?document.getElementById('mrHdCaseNo').value.trim():''),
      party1:(document.getElementById('mrHdParty1')?document.getElementById('mrHdParty1').value.trim():''),
      party1Role:(document.getElementById('mrHdParty1Role')?document.getElementById('mrHdParty1Role').value.trim():''),
      party2:(document.getElementById('mrHdParty2')?document.getElementById('mrHdParty2').value.trim():''),
      party2Role:(document.getElementById('mrHdParty2Role')?document.getElementById('mrHdParty2Role').value.trim():'')
    };
    await api('/api/matters?id='+currentMatter.id,'PATCH',{
      client:document.getElementById('mrClient').value.trim(),
      commencement_date:document.getElementById('mrDate').value,
      law_firm:document.getElementById('mrLawFirm').value,
      responsible_individual:document.getElementById('mrResponsible').value.trim(),
      case_type_id:document.getElementById('mrCaseType').value||null,
      subcategory_id:document.getElementById('mrStage').value||null,
      heading_data:headingData
    });
    await loadMatters();
    currentMatter=matters.find(function(m){return m.id===currentMatter.id;})||currentMatter;
    showToast('Record saved');
  }catch(e){showToast('Error: '+e.message);}
}

function closeTabSilent(toolName){
  document.querySelectorAll('.tab').forEach(function(t){if(t.dataset.tab===toolName)t.remove();});
  document.querySelectorAll('.tool-workspace').forEach(function(ws){if(ws.dataset.tool===toolName)ws.remove();});
  openTabs=openTabs.filter(function(t){return t!==toolName;});
}

/* New Matter */
document.getElementById('newMatterBtn').addEventListener('click',function(){
  document.getElementById('newMatterName').value='';
  document.getElementById('newMatterNature').value='';
  document.getElementById('newMatterIssues').value='';
  document.getElementById('newMatterModal').style.display='flex';
  setTimeout(function(){document.getElementById('newMatterName').focus();},100);
});
document.getElementById('createMatterBtn').addEventListener('click',async function(){
  var name=document.getElementById('newMatterName').value.trim();
  if(!name){showToast('Please enter a matter name');return;}
  try{
    var d=await api('/api/matters','POST',{name:name,jurisdiction:document.getElementById('newMatterJur').value,nature:document.getElementById('newMatterNature').value,issues:document.getElementById('newMatterIssues').value,acting_for:document.getElementById('newMatterActingFor').value});
    closeModal('newMatterModal');await loadMatters();selectMatter(d.matter.id);
  }catch(e){showToast('Error: '+e.message);}
});

/* Edit Matter */
var editingMatterId=null;
function editMatter(id){
  var m=matters.find(function(x){return x.id===id;});if(!m)return;
  editingMatterId=id;
  document.getElementById('editMatterName').value=m.name;
  document.getElementById('editMatterNature').value=m.nature||'';
  document.getElementById('editMatterIssues').value=m.issues||'';
  var sel=document.getElementById('editMatterActingFor');
  if(sel&&m.acting_for){sel.value=m.acting_for;}
  document.getElementById('editMatterModal').style.display='flex';
}
document.getElementById('saveMatterBtn').addEventListener('click',async function(){
  if(!editingMatterId)return;
  try{
    await api('/api/matters?id='+editingMatterId,'PATCH',{name:document.getElementById('editMatterName').value.trim(),nature:document.getElementById('editMatterNature').value,issues:document.getElementById('editMatterIssues').value,acting_for:document.getElementById('editMatterActingFor').value});
    closeModal('editMatterModal');await loadMatters();
    if(currentMatter&&currentMatter.id===editingMatterId){var m=matters.find(function(x){return x.id===editingMatterId;});if(m){currentMatter=m;document.getElementById('chatTitle').textContent=m.name;}}
  }catch(e){showToast('Error: '+e.message);}
});

/* Delete Matter */
async function deleteMatter(id,name){
  if(!confirm('Delete matter "'+name+'" and all its documents?'))return;
  try{await api('/api/matters?id='+id,'DELETE');if(currentMatter&&currentMatter.id===id){currentMatter=null;document.getElementById('chatTitle').textContent='Select or create a matter';document.getElementById('chatTitle').classList.add('empty');document.getElementById('toolsBar').style.display='none';document.getElementById('histBtn').style.display='none';document.getElementById('matterLeftTabs').style.display='none';clearMessages();}await loadMatters();}
  catch(e){showToast('Error: '+e.message);}
}

/* Share */
var shareTargetId=null;
async function shareMatter(id){
  shareTargetId=id;
  try{
    var res=await Promise.all([api('/api/sharing?matter_id='+id),api('/api/auth?action=users')]);
    var shares=res[0].shares||[];var users=res[1].users||[];
    document.getElementById('shareList').innerHTML=shares.length?shares.map(function(s){return '<div class="share-item"><span>'+esc(s.email)+' ('+s.permission+')</span><button onclick="removeShare(\''+id+'\',\''+s.user_id+'\')" style="background:none;border:none;color:var(--error);cursor:pointer;font-weight:700">Remove</button></div>';}).join(''):'<div style="font-size:.85rem;color:var(--text-faint);margin-bottom:.5rem">Not shared with anyone yet.</div>';
    document.getElementById('shareUserSelect').innerHTML=users.map(function(u){return '<option value="'+u.id+'">'+esc(u.email)+'</option>';}).join('')||'<option>No other users</option>';
    document.getElementById('shareModal').style.display='flex';
  }catch(e){showToast('Error: '+e.message);}
}
document.getElementById('addShareBtn').addEventListener('click',async function(){
  if(!shareTargetId)return;
  try{await api('/api/sharing','POST',{matter_id:shareTargetId,user_id:document.getElementById('shareUserSelect').value,permission:document.getElementById('sharePermSelect').value});await shareMatter(shareTargetId);showToast('Shared');}
  catch(e){showToast('Error: '+e.message);}
});
async function removeShare(matterId,userId){
  try{await api('/api/sharing','DELETE',{matter_id:matterId,user_id:userId});await shareMatter(matterId);showToast('Share removed');}
  catch(e){showToast('Error: '+e.message);}
}

/* ── HISTORY ─────────────────────────────────────────────────────────────── */
async function loadHistory(matterId){
  try{var d=await api('/api/history?matter_id='+matterId);matterHistory=d&&d.history?d.history:[];renderHistory();}
  catch(e){matterHistory=[];}
}
function renderHistory(){
  var list=document.getElementById('histList');
  if(!matterHistory.length){list.innerHTML='<div style="padding:.75rem .85rem;font-size:.82rem;color:var(--text-faint);font-style:italic">No previous queries for this matter.</div>';return;}
  list.innerHTML=matterHistory.slice().reverse().map(function(h,i){var realIdx=matterHistory.length-1-i;return '<div class="history-item" style="display:flex;align-items:center;gap:.4rem"><div style="flex:1;overflow:hidden;cursor:pointer" onclick="loadHistItem('+realIdx+')"><div class="history-q">'+esc(h.question.slice(0,90))+(h.question.length>90?'…':'')+'</div><div class="history-meta">'+(h.tool_name||'Q&A')+' · '+new Date(h.created_at).toLocaleDateString('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})+'</div></div><button onclick="event.stopPropagation();deleteHistItem(\''+h.id+'\')" style="background:none;border:1px solid var(--error);border-radius:4px;color:var(--error);cursor:pointer;font-size:1rem;padding:.1rem .4rem;flex-shrink:0;font-weight:700" title="Delete">×</button></div>';}).join('');
}
async function deleteHistItem(id){
  if(!confirm('Delete this history item?'))return;
  try{await api('/api/history?id='+id,'DELETE');if(currentMatter)await loadHistory(currentMatter.id);showToast('Deleted');}
  catch(e){showToast('Error: '+e.message);}
}
function loadHistItem(i){
  var h=matterHistory[i];if(!h)return;
  if(h.tool_name){getOrCreateToolTab(h.tool_name);var area=showToolResult(h.tool_name);area.innerHTML='';appendMsgTo(area,'assistant',h.answer,'tool',h.question,'',h.tool_name,h.id);}
  else{switchTab('chat');clearMessages();appendMsg('user',h.question);appendMsg('assistant',h.answer,'','','',null,h.id);}
  if(histOpen)toggleHistory();
}
function toggleHistory(){histOpen=!histOpen;document.getElementById('histPanel').classList.toggle('open',histOpen);document.getElementById('histBtn').classList.toggle('active',histOpen);}
async function saveHistory(q,a,toolName){
  if(!currentMatter)return null;
  try{var d=await api('/api/history','POST',{matter_id:currentMatter.id,question:q,answer:a,tool_name:toolName||null});await loadHistory(currentMatter.id);return d&&d.id?d.id:null;}catch(e){return null;}
}

/* ── DOCUMENTS ───────────────────────────────────────────────────────────── */
async function loadDocuments(matterId){try{var d=await api('/api/documents?matter_id='+matterId);documents=d&&d.documents?d.documents:[];renderDocs();}catch(e){documents=[];renderDocs();}}
function renderDocs(){
  var list=document.getElementById('docsList');
  if(!currentMatter){list.innerHTML='<div class="docs-empty-msg">Select a matter to see documents.</div>';return;}
  if(!documents.length){list.innerHTML='<div class="docs-empty-msg">No documents yet.<br>Upload PDFs above.</div>';return;}
  var icons={'Pleading':'📋','Skeleton Argument':'📝','Witness Statement':'👤','Exhibit':'📎','Case Law':'⚖️','Statute / Regulation':'📖','Correspondence':'✉️','Expert Report':'🔬','Trial Bundle':'📦','Other':'📄'};
  list.innerHTML=documents.map(function(doc){return '<div class="doc-item"><span class="doc-icon">'+(icons[doc.doc_type]||'📄')+'</span><div class="doc-info"><div class="doc-name" title="'+esc(doc.name)+'">'+esc(doc.name)+'</div><div class="doc-meta">'+esc(doc.doc_type)+(doc.chunk_count?' · '+doc.chunk_count+' passages':'')+'</div></div><button onclick="deleteDoc(\''+doc.id+'\',\''+esc(doc.name)+'\')" style="background:none;border:none;color:var(--text-faint);cursor:pointer;font-size:1.1rem;padding:0 3px;flex-shrink:0;font-weight:700" title="Remove">×</button></div>';}).join('');
}
async function deleteDoc(id,name){if(!confirm('Remove "'+name+'"?'))return;try{await api('/api/documents?id='+id,'DELETE');await loadDocuments(currentMatter.id);await loadMatters();showToast('Document removed');}catch(e){showToast('Error: '+e.message);}}

/* ── UPLOAD ──────────────────────────────────────────────────────────────── */
var uploadZone=document.getElementById('uploadZone'),fileInput=document.getElementById('fileInput');
uploadZone.addEventListener('dragover',function(e){e.preventDefault();uploadZone.classList.add('drag-over');});
uploadZone.addEventListener('dragleave',function(){uploadZone.classList.remove('drag-over');});
uploadZone.addEventListener('drop',function(e){e.preventDefault();uploadZone.classList.remove('drag-over');if(!currentMatter){showToast('Select a matter first');return;}uploadFiles(Array.from(e.dataTransfer.files).filter(function(f){return f.type==='application/pdf';}));});
fileInput.addEventListener('change',function(){if(!currentMatter){showToast('Select a matter first');return;}uploadFiles(Array.from(fileInput.files));fileInput.value='';});

async function uploadFiles(files){
  if(!files.length||!currentMatter)return;
  var docType=document.getElementById('docTypeSelect').value;
  var prog=document.getElementById('uploadProg'),errEl=document.getElementById('uploadErr');
  errEl.classList.remove('on');
  for(var fi=0;fi<files.length;fi++){
    var file=files[fi];
    prog.textContent='Extracting text: '+file.name+'…';prog.classList.add('on');
    try{
      var pages=await extractPdfText(file);
      var fullText=pages.map(function(p){return p.text;}).join('\n\n');
      if(!fullText||fullText.trim().length<50){errEl.textContent='No readable text in '+file.name+'. Try OCR at ilovepdf.com first.';errEl.classList.add('on');continue;}
      prog.textContent='Uploading: '+file.name+' ('+Math.round(fullText.length/1024)+'KB text, '+pages.length+' pages)…';
      var d=await api('/api/upload','POST',{matterId:currentMatter.id,fileName:file.name,pageTexts:pages,docType:docType});
      if(d)showToast('\u2713 '+file.name+' — '+d.chunks+' passages indexed'+(d.pageAware?' (page-aware)':''));
    }catch(e){errEl.textContent='Failed: '+file.name+' — '+e.message;errEl.classList.add('on');}
  }
  prog.classList.remove('on');await loadDocuments(currentMatter.id);await loadMatters();
}
/* v3.2: Extract text per page for page-aware chunking */
async function extractPdfText(file){
  var pdfjsLib=window['pdfjs-dist/build/pdf']||window.pdfjsLib;
  if(!pdfjsLib)throw new Error('PDF library not loaded. Refresh and try again.');
  pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  var buf=await file.arrayBuffer();
  var pdf=await pdfjsLib.getDocument({data:buf}).promise;
  var pages=[];
  for(var i=1;i<=pdf.numPages;i++){var page=await pdf.getPage(i);var tc=await page.getTextContent();var pageText=tc.items.map(function(item){return item.str;}).join(' ');pages.push({page:i,text:pageText});}
  return pages;
}
/* ── CHAT ─────────────────────────────────────────────────────────────────── */
async function sendMessage(){
  if(isLoading||!currentMatter)return;
  var input=document.getElementById('chatInput');
  var text=input.value.trim();if(!text)return;
  isLoading=true;input.value='';input.style.height='auto';
  document.getElementById('sendBtn').disabled=true;
  var area=getActiveMessagesArea();
  appendMsgTo(area,'user',text);
  var toolContext=activeTab!=='chat'&&toolDefs[activeTab]?'The user is viewing the '+toolDefs[activeTab].title+' output for this matter. Answer their question in that context.':'';
  var typing=document.createElement('div');
  typing.className='msg msg-assistant';
  typing.innerHTML='<div class="typing-bubble"><span></span><span></span><span></span></div>';
  area.appendChild(typing);area.scrollTop=area.scrollHeight;
  try{
    var d=await api('/api/analyse','POST',{matterId:currentMatter.id,matterName:currentMatter.name,matterNature:currentMatter.nature||'',matterIssues:currentMatter.issues||'',actingFor:currentMatter.acting_for||'',messages:[{role:'user',content:text+(toolContext?'\n\n[Context: '+toolContext+']':'')}],jurisdiction:jurisdiction,queryType:document.getElementById('qtypeSelect').value,focusAreas:Array.from(focusAreas)});
    typing.remove();
    if(d&&d.result){var hId=await saveHistory(text,d.result);var costStr=d.usage&&d.usage.costUsd?' · $'+d.usage.costUsd.toFixed(4):'';appendMsgTo(area,'assistant',d.result,'',text,costStr,null,hId);}
  }catch(e){typing.remove();var errEl=document.createElement('div');errEl.style.cssText='text-align:center;font-size:.78rem;color:var(--error);padding:.45rem;';errEl.textContent='\u26A0\uFE0F Error: '+e.message;area.appendChild(errEl);}
  finally{isLoading=false;document.getElementById('sendBtn').disabled=false;input.focus();}
}
document.getElementById('sendBtn').addEventListener('click',sendMessage);
document.getElementById('chatInput').addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage();}});
document.getElementById('chatInput').addEventListener('input',function(){this.style.height='auto';this.style.height=Math.min(this.scrollHeight,200)+'px';});
function clearChat(){clearMessages();if(currentMatter)sysMsg('Chat cleared. Documents remain indexed.');}


/* ── MESSAGE RENDERING ───────────────────────────────────────────────────── */
function appendMsg(role,content,variant,question,costStr,toolName,historyId){appendMsgTo(document.getElementById('messagesArea'),role,content,variant,question,costStr,toolName,historyId);}

function appendMsgTo(area,role,content,variant,question,costStr,toolName,historyId){
  if(!area)area=document.getElementById('messagesArea');
  var welcome=area.querySelector('.welcome-state');if(welcome)welcome.remove();
  var w=document.createElement('div');w.className='msg msg-'+role+(variant?' msg-'+(variant==='prop'?'tool':variant):'');
  var time=new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
  var bubble=document.createElement('div');bubble.className='msg-bubble';
  if(role==='assistant'){bubble.innerHTML=variant==='prop'?renderProp(content):renderMdWithSourceLinks(content);}
  else{bubble.textContent=content;}
  var meta=document.createElement('div');meta.className='msg-meta';
  if(role==='assistant'){
    var ts=document.createElement('span');ts.textContent='Ex Libris Juris · '+(jurisdiction==='British Virgin Islands'?'BVI':jurisdiction)+' · '+time;
    if(costStr){var cp=document.createElement('span');cp.className='cost-pill';cp.textContent=costStr;ts.appendChild(cp);}
    meta.appendChild(ts);
    var dl=document.createElement('button');dl.className='btn-dl';dl.textContent='\u2B07 Word';dl.onclick=function(){downloadWord(content,question||currentMatter&&currentMatter.name);};meta.appendChild(dl);
    if(toolName){
      var editBtn=document.createElement('button');editBtn.className='btn-dl';editBtn.textContent='\u270F\uFE0F Edit';
      var editing=false;var findRefsBtn=document.createElement('button');findRefsBtn.className='find-refs-btn';findRefsBtn.textContent='\uD83D\uDD0D Find References';findRefsBtn.style.display='none';findRefsBtn.onclick=function(){findReferences(bubble,toolName);};
      editBtn.onclick=function(){editing=!editing;bubble.contentEditable=editing?'true':'false';editBtn.textContent=editing?'\u2705 Done':'\u270F\uFE0F Edit';if(!editing)findRefsBtn.style.display='';};
      meta.appendChild(editBtn);meta.appendChild(findRefsBtn);
      var bundleBtn=document.createElement('button');bundleBtn.className='btn-dl';bundleBtn.textContent='\uD83D\uDCD1 Bundle';bundleBtn.onclick=function(){showBundleIndex(extractDocRefs(content));};meta.appendChild(bundleBtn);
      if(toolName==='persons'){var diagramBtn=document.createElement('button');diagramBtn.className='btn-dl';diagramBtn.style.cssText='background:var(--blue-pale);border-color:var(--blue-light);color:var(--blue)';diagramBtn.textContent='\uD83D\uDCC8 Relationship Diagram';diagramBtn.onclick=function(){generateDiagram(content);};meta.appendChild(diagramBtn);}
      if(toolName==='issues'){var ibBtn=document.createElement('button');ibBtn.className='btn-dl';ibBtn.style.cssText='background:var(--blue-pale);border-color:var(--blue-light);color:var(--blue)';ibBtn.textContent='\uD83D\uDCDD Issue Briefing';ibBtn.onclick=function(){showIssueBriefingModal(content);};meta.appendChild(ibBtn);}
    }
  }else{meta.textContent='You · '+time;}
  w.appendChild(bubble);w.appendChild(meta);
  if(toolName&&historyId){var histBar=renderToolHistoryBar(toolName,historyId);if(histBar.children.length)w.appendChild(histBar);}
  area.appendChild(w);area.scrollTop=area.scrollHeight;
}

function extractDocRefs(content){
  var refs=new Set();
  var sourceMatches=content.matchAll(/\*\(Source:\s*([^)]+)\)\*/g);
  for(var m of sourceMatches)refs.add(m[1].trim());
  var bracketMatches=content.matchAll(/\[([^\]]{5,80})\]/g);
  for(var m2 of bracketMatches){var name=m2[1].trim();if(documents.some(function(d){return d.name.toLowerCase().indexOf(name.toLowerCase().slice(0,20))!==-1;}))refs.add(name);}
  return Array.from(refs);
}

function renderMdWithSourceLinks(text){
  var srcMap={};var srcIdx=0;
  text=text.replace(/\*\(Source:\s*([^)]+)\)\*/g,function(match,docName){var key='__SRC'+srcIdx+'__';srcIdx++;srcMap[key]=docName.trim();return key;});
  var html=renderMd(text);
  html=html.replace(/<em>\(Source:\s*([^<]+)\)<\/em>/g,function(match,docName){var safe=esc(docName.trim());return '<span class="source-link" onclick="openSourcePanel(\''+safe.replace(/'/g,"\\'")+'\',\'\')" title="View source passage">\uD83D\uDCCE '+safe+'</span>';});
  for(var k in srcMap){var safe=esc(srcMap[k]);html=html.replace(k,'<span class="source-link" onclick="openSourcePanel(\''+safe.replace(/'/g,"\\'")+'\',\'\')" title="View source passage">\uD83D\uDCCE '+safe+'</span>');}
  return html;
}

/* ── WORD DOWNLOAD ───────────────────────────────────────────────────────── */
async function downloadWord(content,title){
  try{
    var r=await fetch('/api/export',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+(token||localStorage.getItem('elj_token'))},body:JSON.stringify({content:content,matterName:currentMatter?currentMatter.name:'Matter',jurisdiction:jurisdiction,title:title})});
    if(!r.ok){showToast('Export failed');return;}
    var blob=await r.blob();var url=URL.createObjectURL(blob);
    var a=document.createElement('a');a.href=url;a.download=(title||'analysis').replace(/[^a-z0-9]/gi,'-').toLowerCase()+'.docx';a.click();URL.revokeObjectURL(url);
    showToast('Downloaded as Word document');
  }catch(e){showToast('Export error: '+e.message);}
}

/* ── NAVIGATION ──────────────────────────────────────────────────────────── */
function switchMainNav(nav){
  document.querySelectorAll('.main-nav-btn').forEach(function(b){b.classList.toggle('active',b.getAttribute('data-nav')===nav);});
  var mattersLeft=document.getElementById('mattersLeftPanel');
  var libraryLeft=document.getElementById('libraryLeftPanel');
  var draftLeft=document.getElementById('draftLeftPanel');
  var mattersCentre=document.getElementById('mattersCentrePanel');
  var libraryCentre=document.getElementById('libraryCentrePanel');
  var draftCentre=document.getElementById('draftCentrePanel');
  var rightPanel=document.getElementById('rightPanel');
  var leftPanel=document.getElementById('leftPanel');
  /* Hide all */
  mattersLeft.style.display='none';libraryLeft.style.display='none';draftLeft.style.display='none';
  mattersCentre.style.display='none';libraryCentre.style.display='none';draftCentre.style.display='none';
  if(nav==='matters'){
    leftPanel.style.display='';
    mattersLeft.style.display='';
    mattersCentre.style.display='flex';
    if(rightPanel)rightPanel.style.display=currentMatter?'':'none';
  }else if(nav==='library'){
    leftPanel.style.display='';
    libraryLeft.style.display='flex';
    libraryCentre.style.display='flex';
    if(rightPanel)rightPanel.style.display='none';
    loadLibrary();
  }else if(nav==='draft'){
    leftPanel.style.display='';
    draftLeft.style.display='flex';
    draftCentre.style.display='flex';
    if(rightPanel)rightPanel.style.display='none';
    libPopulateDraftSelects();
  }
}

/* ── MARKDOWN RENDERING ──────────────────────────────────────────────────── */
function renderProp(text){
  var gLabels={5:'Strong — direct evidence',4:'Good — supportive evidence',3:'Moderate — indirect',2:'Weak — tangential',1:'Contrary — contradicts proposition'};
  var parts=text.split(/(?=###\s)/);var html='';
  for(var pi=0;pi<parts.length;pi++){var part=parts[pi];var gm=part.match(/GRADE:\s*([1-5])/i);if(gm){var g=parseInt(gm[1]);html+='<div class="strength-row g'+g+'"><div class="sdot"></div><div style="flex:1"><div class="slabel">'+(gLabels[g]||'Grade '+g)+'</div>'+renderMdWithSourceLinks(part.replace(/GRADE:\s*[1-5]/gi,'').trim())+'</div></div>';}else{html+=renderMdWithSourceLinks(part);}}
  return html;
}

function renderMd(text){
  var lines=text.split('\n');var html='';var i=0;
  while(i<lines.length){
    var l=lines[i];
    if(/^#{1,2} /.test(l)){html+='<h2>'+inl(l.replace(/^#+\s/,''))+'</h2>';}
    else if(l.indexOf('### ')===0){html+='<h3>'+inl(l.slice(4))+'</h3>';}
    else if(l.indexOf('#### ')===0){html+='<h4>'+inl(l.slice(5))+'</h4>';}
    else if(l.indexOf('- ')===0||l.indexOf('\u2022 ')===0){html+='<ul>';while(i<lines.length&&(lines[i].indexOf('- ')===0||lines[i].indexOf('\u2022 ')===0)){html+='<li>'+inl(lines[i].slice(2))+'</li>';i++;}html+='</ul>';continue;}
    else if(/^\d+\. /.test(l)){html+='<ol>';while(i<lines.length&&/^\d+\. /.test(lines[i])){html+='<li>'+inl(lines[i].replace(/^\d+\. /,''))+'</li>';i++;}html+='</ol>';continue;}
    else if(l.indexOf('> ')===0){html+='<blockquote>'+inl(l.slice(2))+'</blockquote>';}
    else if(l.indexOf('\u26A0\uFE0F')!==-1){html+='<div class="caution">'+inl(l)+'</div>';}
    else if(l.trim()){html+='<p>'+inl(l)+'</p>';}
    i++;
  }
  return html;
}

/* ── UTILITIES ───────────────────────────────────────────────────────────── */
function esc(t){return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function inl(t){return esc(t).replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/\*(.+?)\*/g,'<em>$1</em>').replace(/_(.+?)_/g,'<em>$1</em>');}
function closeModal(id){document.getElementById(id).style.display='none';}
document.querySelectorAll('.overlay').forEach(function(o){o.addEventListener('click',function(e){if(e.target===o)o.style.display='none';});});
function showToast(msg){var old=document.querySelector('.toast');if(old)old.remove();var t=document.createElement('div');t.className='toast';t.textContent=msg;document.body.appendChild(t);setTimeout(function(){t.remove();},3200);}
function clearMessages(){document.getElementById('messagesArea').innerHTML='';}
function sysMsg(text){var area=document.getElementById('messagesArea');var el=document.createElement('div');el.style.cssText='text-align:center;font-size:.78rem;font-weight:500;color:var(--text-faint);padding:.45rem;font-style:italic;';el.innerHTML=renderMd(text);area.appendChild(el);area.scrollTop=area.scrollHeight;}
/* init() is called at the end of the last loaded script file (diagram.js) */
