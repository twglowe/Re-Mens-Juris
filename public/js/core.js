/* ═══════════════════════════════════════════════════════════════════════════════
   EX LIBRIS JURIS v3.4 — JAVASCRIPT
   ═══════════════════════════════════════════════════════════════════════════════ */
var token=null,currentUser=null,currentMatter=null,matters=[],documents=[],matterHistory=[],focusAreas=new Set(),isLoading=false,histOpen=false,jurisdiction='Bermuda',pendingTool=null;
var toolHistoryCache={};
/* v5.0: Folders for the current matter. Loaded on matter select. Each entry:
   { id, name, sort_order, created_at, document_count }. */
var currentFolders=[];
/* v5.0: Folder IDs selected in the upload modal for the current upload batch. */
var uploadSelectedFolderIds=[];
/* v5.0: Folder IDs being edited in the per-document edit modal. */
var docEditSelectedFolderIds=[];
var docEditCurrentId=null;
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
  list.innerHTML=matters.map(function(m){return '<div class="matter-item'+(currentMatter&&currentMatter.id===m.id?' active':'')+'" tabindex="0" role="button" onclick="selectMatter(\''+m.id+'\')" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();selectMatter(\''+m.id+'\');}">'
    +'<div class="matter-name">'+esc(m.name)+'</div>'
    +'<div class="matter-meta">'
    +'<span class="badge badge-jur">'+esc(m.jurisdiction==='British Virgin Islands'?'BVI':m.jurisdiction)+'</span>'
    +(m.shared?'<span class="badge badge-shared">Shared</span>':'')
    +'<span>'+(m.document_count||0)+' doc'+((m.document_count||0)!==1?'s':'')+'</span>'
    +'</div>'
    +'<div class="matter-actions">'
    +'<button class="btn-icon" onclick="event.stopPropagation();editMatter(\''+m.id+'\')" title="Edit" aria-label="Edit matter">✏️</button>'
    +'<button class="btn-icon" onclick="event.stopPropagation();shareMatter(\''+m.id+'\')" title="Share" aria-label="Share matter">🔗</button>'
    +'<button class="btn-icon" onclick="event.stopPropagation();deleteMatter(\''+m.id+'\',\''+esc(m.name)+'\')" title="Delete" aria-label="Delete matter">🗑️</button>'
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
  await loadFolders(id);
  await loadHistory(id);
  toolHistoryCache[id]={};
  sysMsg('Matter loaded: **'+currentMatter.name+'** · '+currentMatter.jurisdiction+(currentMatter.acting_for?' · Acting for: '+currentMatter.acting_for:''));
  if(currentMatter.nature)sysMsg('Dispute: '+currentMatter.nature);
  renderMatterRecord();
  /* v4.4: Resume polling for any in-progress tool jobs on this matter */
  if(typeof resumeInProgressJobs==='function')resumeInProgressJobs(id);
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
  openModal('newMatterModal');
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
  openModal('editMatterModal');
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
    openModal('shareModal');
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
  /* Stage 5: diagram has its own loader */
  if(h.tool_name==='diagram'){
    loadDiagramFromHistory(h);
    if(histOpen)toggleHistory();
    return;
  }
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
/* v5.0: Render docs with folder chips and a "+ classify" affordance for
   unassigned docs. Clicking a chip OR the "+ classify" opens the per-document
   edit modal where the user can change folder assignments and edit the
   description. Also shows a "Manage folders" button above the list. */
function renderDocs(){
  var list=document.getElementById('docsList');
  if(!currentMatter){list.innerHTML='<div class="docs-empty-msg">Select a matter to see documents.</div>';return;}
  var header='<div class="docs-header-row" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.5rem;gap:.4rem">'
    +'<button class="btn-dl" onclick="openManageFoldersModal()" style="font-size:.74rem;padding:.28rem .55rem" title="Rename or delete folders">🗂 Manage folders</button>'
    +(currentFolders.length?'<span style="font-size:.7rem;color:var(--text-faint);font-weight:500">'+currentFolders.length+' folder'+(currentFolders.length!==1?'s':'')+'</span>':'')
    +'</div>';
  if(!documents.length){list.innerHTML=header+'<div class="docs-empty-msg">No documents yet.<br>Upload PDFs above.</div>';return;}
  var icons={'Pleading':'📋','Skeleton Argument':'📝','Witness Statement':'👤','Exhibit':'📎','Case Law':'⚖️','Statute / Regulation':'📖','Correspondence':'✉️','Expert Report':'🔬','Trial Bundle':'📦','Other':'📄'};
  /* Build a quick lookup from folder id → folder name */
  var folderById={};currentFolders.forEach(function(f){folderById[f.id]=f;});
  list.innerHTML=header+documents.map(function(doc){
    var folderIds=doc.folder_ids||[];
    var chipsHtml='';
    if(folderIds.length){
      chipsHtml=folderIds.map(function(fid){
        var f=folderById[fid];
        if(!f)return '';
        return '<span class="folder-chip" onclick="event.stopPropagation();openDocumentEditModal(\''+doc.id+'\')" title="Click to edit classification" style="display:inline-block;font-size:.68rem;font-weight:600;padding:.1rem .45rem;margin:.15rem .2rem 0 0;border-radius:10px;background:var(--blue-pale);color:var(--blue);border:1px solid var(--border);cursor:pointer">'+esc(f.name)+'</span>';
      }).join('');
    }else{
      chipsHtml='<span class="folder-classify-btn" onclick="event.stopPropagation();openDocumentEditModal(\''+doc.id+'\')" title="Assign to a folder" style="display:inline-block;font-size:.68rem;font-weight:600;padding:.1rem .45rem;margin-top:.15rem;border-radius:10px;background:var(--off-white);color:var(--text-faint);border:1px dashed var(--border-strong);cursor:pointer">+ classify</span>';
    }
    var descHtml=doc.description?'<div class="doc-desc" style="font-size:.68rem;color:var(--text-light);margin-top:.08rem;font-style:italic;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(doc.description)+'">'+esc(doc.description)+'</div>':'';
    return '<div class="doc-item"><span class="doc-icon">'+(icons[doc.doc_type]||'📄')+'</span><div class="doc-info">'
      +'<div class="doc-name" title="'+esc(doc.name)+'">'+esc(doc.name)+'</div>'
      +'<div class="doc-meta">'+esc(doc.doc_type)+(doc.chunk_count?' · '+doc.chunk_count+' passages':'')+'</div>'
      +descHtml
      +'<div class="doc-chips">'+chipsHtml+'</div>'
      +'</div>'
      +'<button onclick="deleteDoc(\''+doc.id+'\',\''+esc(doc.name)+'\')" style="background:none;border:none;color:var(--text-faint);cursor:pointer;font-size:1.1rem;padding:0 3px;flex-shrink:0;font-weight:700" title="Remove">×</button>'
      +'</div>';
  }).join('');
}
async function deleteDoc(id,name){if(!confirm('Remove "'+name+'"?'))return;try{await api('/api/documents?id='+id,'DELETE');await loadDocuments(currentMatter.id);await loadMatters();showToast('Document removed');}catch(e){showToast('Error: '+e.message);}}

/* v4.5a: Rebuild trigger */
/* ── UPLOAD ──────────────────────────────────────────────────────────────── */
var uploadZone=document.getElementById('uploadZone'),fileInput=document.getElementById('fileInput');
uploadZone.addEventListener('dragover',function(e){e.preventDefault();uploadZone.classList.add('drag-over');});
uploadZone.addEventListener('dragleave',function(){uploadZone.classList.remove('drag-over');});
/* v4.5: Drop handler filters by extension (.pdf/.docx) instead of MIME type */
uploadZone.addEventListener('drop',function(e){e.preventDefault();uploadZone.classList.remove('drag-over');if(!currentMatter){showToast('Select a matter first');return;}uploadFiles(Array.from(e.dataTransfer.files).filter(function(f){var n=f.name.toLowerCase();return n.endsWith('.pdf')||n.endsWith('.docx');}));});
fileInput.addEventListener('change',function(){if(!currentMatter){showToast('Select a matter first');return;}uploadFiles(Array.from(fileInput.files));fileInput.value='';});

/* v4.5: Dispatch by extension, reject legacy .doc, support .docx via mammoth */
async function uploadFiles(files){
  if(!files.length||!currentMatter)return;
  var docType=document.getElementById('docTypeSelect').value;
  var prog=document.getElementById('uploadProg'),errEl=document.getElementById('uploadErr');
  errEl.classList.remove('on');
  for(var fi=0;fi<files.length;fi++){
    var file=files[fi];
    var lowerName=file.name.toLowerCase();
    var isDocx=lowerName.endsWith('.docx');
    var isPdf=lowerName.endsWith('.pdf');
    if(lowerName.endsWith('.doc')&&!isDocx){errEl.textContent=file.name+': legacy .doc format is not supported. Please save as .docx first.';errEl.classList.add('on');continue;}
    if(!isPdf&&!isDocx){errEl.textContent=file.name+': unsupported file type. Please use .pdf or .docx.';errEl.classList.add('on');continue;}
    prog.textContent='Extracting text: '+file.name+'…';prog.classList.add('on');
    try{
      var pages=isDocx?await extractDocxText(file):await extractPdfText(file);
      var fullText=pages.map(function(p){return p.text;}).join('\n\n');
      if(!fullText||fullText.trim().length<50){errEl.textContent='No readable text in '+file.name+'. '+(isPdf?'Try OCR at ilovepdf.com first.':'The document may be empty or corrupted.');errEl.classList.add('on');continue;}
      var unitLabel=isDocx?'block(s)':'page(s)';
      prog.textContent='Uploading: '+file.name+' ('+Math.round(fullText.length/1024)+'KB text, '+pages.length+' '+unitLabel+')…';
      var d=await api('/api/upload','POST',{matterId:currentMatter.id,fileName:file.name,pageTexts:pages,docType:docType,folderIds:uploadSelectedFolderIds.slice()});
      if(d)showToast('\u2713 '+file.name+' — '+d.chunks+' passages indexed'+(d.pageAware?' (page-aware)':''));
    }catch(e){errEl.textContent='Failed: '+file.name+' — '+e.message;errEl.classList.add('on');}
  }
  prog.classList.remove('on');await loadDocuments(currentMatter.id);await loadMatters();
  /* v5.0: Clear the upload folder selection after a batch and refresh the
     folder picker (document counts may have changed). */
  uploadSelectedFolderIds=[];
  await loadFolders(currentMatter.id);
}
/* v3.2: Extract text per page for page-aware chunking */
async function extractPdfText(file){
  var pdfjsLib=window['pdfjs-dist/build/pdf']||window.pdfjsLib;
  if(!pdfjsLib)throw new Error('PDF library not loaded. Refresh and try again.');
  pdfjsLib.GlobalWorkerOptions.workerSrc='/js/pdf.worker.min.js';
  var buf=await file.arrayBuffer();
  var pdf=await pdfjsLib.getDocument({data:buf}).promise;
  var pages=[];
  for(var i=1;i<=pdf.numPages;i++){var page=await pdf.getPage(i);var tc=await page.getTextContent();var pageText=tc.items.map(function(item){return item.str;}).join(' ');pages.push({page:i,text:pageText});}
  return pages;
}
/* v4.5: Extract raw text from a .docx file via mammoth.js. Returns the same
   [{page,text},...] shape as extractPdfText so callers can treat both uniformly.
   .docx has no true page concept, so we return a single "page 1" block. */
async function extractDocxText(file){
  if(!window.mammoth||!window.mammoth.extractRawText){
    throw new Error('Word library not loaded. Refresh and try again.');
  }
  var buf=await file.arrayBuffer();
  var result=await window.mammoth.extractRawText({arrayBuffer:buf});
  var text=(result&&result.value)||'';
  return [{page:1,text:text}];
}

/* ═══════════════════════════════════════════════════════════════════════════
   v5.0 — DOCUMENT FOLDERS (categorisation)
   ═══════════════════════════════════════════════════════════════════════════ */

/* Load the current matter's folders and refresh the upload picker UI. */
async function loadFolders(matterId){
  try{
    var d=await api('/api/folders?matter_id='+matterId);
    currentFolders=(d&&d.folders)?d.folders:[];
  }catch(e){currentFolders=[];console.error('loadFolders:',e);}
  renderUploadFolderPicker();
  /* Re-render docs so the chips reflect the latest folder names */
  renderDocs();
}

/* Render the chip-style folder picker above the upload drop zone. */
function renderUploadFolderPicker(){
  var host=document.getElementById('uploadFolderPicker');
  if(!host)return;
  if(!currentMatter){host.innerHTML='';host.style.display='none';return;}
  host.style.display='';
  var chipsHtml=currentFolders.map(function(f){
    var on=uploadSelectedFolderIds.indexOf(f.id)!==-1;
    return '<span class="upload-folder-chip'+(on?' on':'')+'" data-fid="'+f.id+'" onclick="toggleUploadFolder(\''+f.id+'\')" style="display:inline-block;font-size:.72rem;font-weight:600;padding:.2rem .55rem;margin:.15rem .2rem 0 0;border-radius:11px;cursor:pointer;border:1.5px solid '+(on?'var(--blue)':'var(--border)')+';background:'+(on?'var(--blue-pale)':'var(--white)')+';color:'+(on?'var(--blue)':'var(--text-mid)')+'">'+esc(f.name)+'</span>';
  }).join('');
  var addBtn='<span class="upload-folder-chip chip-add" onclick="showNewFolderInput()" style="display:inline-block;font-size:.72rem;font-weight:700;padding:.2rem .55rem;margin:.15rem .2rem 0 0;border-radius:11px;cursor:pointer;border:1.5px dashed var(--border-strong);background:var(--off-white);color:var(--text-faint)">+ new folder</span>';
  host.innerHTML='<div class="focus-label" style="margin-bottom:.25rem">Classify upload <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--text-faint)">(optional — applies to all files in this batch)</span></div>'
    +'<div id="uploadFolderChipRow" style="margin-bottom:.4rem">'+chipsHtml+addBtn+'</div>'
    +'<div id="newFolderInputRow" style="display:none;margin-bottom:.5rem">'
    +'<div style="display:flex;gap:.3rem;align-items:center">'
    +'<input type="text" id="newFolderNameInput" list="newFolderSuggestions" placeholder="Folder name…" style="flex:1;padding:.35rem .55rem;border:1.5px solid var(--border);border-radius:5px;font-size:.82rem;background:var(--white)" onkeydown="if(event.key===\'Enter\'){event.preventDefault();createFolderInline();}else if(event.key===\'Escape\'){event.preventDefault();hideNewFolderInput();}">'
    +'<datalist id="newFolderSuggestions"></datalist>'
    +'<button class="btn-dl" onclick="createFolderInline()" style="font-size:.72rem;padding:.28rem .55rem">Add</button>'
    +'<button class="btn-dl" onclick="hideNewFolderInput()" style="font-size:.72rem;padding:.28rem .55rem;background:var(--off-white);color:var(--text-faint)">Cancel</button>'
    +'</div>'
    +'</div>';
}

function toggleUploadFolder(folderId){
  var idx=uploadSelectedFolderIds.indexOf(folderId);
  if(idx===-1)uploadSelectedFolderIds.push(folderId);
  else uploadSelectedFolderIds.splice(idx,1);
  renderUploadFolderPicker();
}

async function showNewFolderInput(){
  var row=document.getElementById('newFolderInputRow');
  if(!row)return;
  row.style.display='';
  var input=document.getElementById('newFolderNameInput');
  if(input){input.value='';setTimeout(function(){input.focus();},40);}
  /* Populate suggestions from per-user defaults */
  try{
    var d=await api('/api/folders?action=defaults');
    var defaults=(d&&d.defaults)||[];
    /* Filter out names that already exist in this matter */
    var existing={};currentFolders.forEach(function(f){existing[f.name.toLowerCase()]=true;});
    var list=document.getElementById('newFolderSuggestions');
    if(list){
      list.innerHTML=defaults.filter(function(n){return !existing[String(n).toLowerCase()];}).map(function(n){return '<option value="'+esc(n)+'">';}).join('');
    }
  }catch(e){/* defaults are optional — silent */}
}

function hideNewFolderInput(){
  var row=document.getElementById('newFolderInputRow');
  if(row)row.style.display='none';
}

async function createFolderInline(){
  var input=document.getElementById('newFolderNameInput');
  if(!input)return;
  var name=input.value.trim();
  if(!name){showToast('Folder name required');return;}
  if(!currentMatter){showToast('Select a matter first');return;}
  /* Client-side duplicate guard */
  var lower=name.toLowerCase();
  for(var i=0;i<currentFolders.length;i++){
    if(currentFolders[i].name.toLowerCase()===lower){
      showToast('Folder "'+name+'" already exists');
      return;
    }
  }
  try{
    var d=await api('/api/folders','POST',{matter_id:currentMatter.id,name:name});
    if(d&&d.folder){
      currentFolders.push(d.folder);
      /* Auto-select the new folder for the current upload batch */
      uploadSelectedFolderIds.push(d.folder.id);
      hideNewFolderInput();
      renderUploadFolderPicker();
      renderDocs();
      showToast('Folder "'+name+'" created');
    }
  }catch(e){showToast('Error: '+e.message);}
}

/* ── Per-document edit modal ─────────────────────────────────────────────── */

function openDocumentEditModal(docId){
  var doc=documents.find(function(d){return d.id===docId;});
  if(!doc){showToast('Document not found');return;}
  docEditCurrentId=docId;
  docEditSelectedFolderIds=(doc.folder_ids||[]).slice();
  document.getElementById('docEditName').textContent=doc.name;
  document.getElementById('docEditType').textContent=doc.doc_type||'';
  document.getElementById('docEditDescription').value=doc.description||'';
  renderDocEditFolderChips();
  openModal('documentEditModal');
}

function renderDocEditFolderChips(){
  var host=document.getElementById('docEditFolderChips');
  if(!host)return;
  if(!currentFolders.length){
    host.innerHTML='<div style="font-size:.78rem;color:var(--text-faint);font-style:italic;padding:.3rem 0">No folders yet. Create one from the upload area, or use Manage folders.</div>';
    return;
  }
  host.innerHTML=currentFolders.map(function(f){
    var on=docEditSelectedFolderIds.indexOf(f.id)!==-1;
    return '<span class="doc-edit-chip'+(on?' on':'')+'" data-fid="'+f.id+'" onclick="toggleDocEditFolder(\''+f.id+'\')" style="display:inline-block;font-size:.78rem;font-weight:600;padding:.25rem .6rem;margin:.2rem .25rem 0 0;border-radius:12px;cursor:pointer;border:1.5px solid '+(on?'var(--blue)':'var(--border)')+';background:'+(on?'var(--blue-pale)':'var(--white)')+';color:'+(on?'var(--blue)':'var(--text-mid)')+'">'+esc(f.name)+'</span>';
  }).join('');
}

function toggleDocEditFolder(folderId){
  var idx=docEditSelectedFolderIds.indexOf(folderId);
  if(idx===-1)docEditSelectedFolderIds.push(folderId);
  else docEditSelectedFolderIds.splice(idx,1);
  renderDocEditFolderChips();
}

async function saveDocumentEdit(){
  if(!docEditCurrentId){closeModal('documentEditModal');return;}
  var desc=document.getElementById('docEditDescription').value;
  var btn=document.getElementById('docEditSaveBtn');
  if(btn)btn.disabled=true;
  try{
    await api('/api/documents?id='+docEditCurrentId,'PATCH',{description:desc,folder_ids:docEditSelectedFolderIds.slice()});
    closeModal('documentEditModal');
    docEditCurrentId=null;
    docEditSelectedFolderIds=[];
    await loadDocuments(currentMatter.id);
    await loadFolders(currentMatter.id);
    showToast('Document updated');
  }catch(e){
    showToast('Error: '+e.message);
  }finally{
    if(btn)btn.disabled=false;
  }
}

/* ── Manage folders modal ────────────────────────────────────────────────── */

function openManageFoldersModal(){
  if(!currentMatter){showToast('Select a matter first');return;}
  renderManageFoldersList();
  openModal('manageFoldersModal');
}

function renderManageFoldersList(){
  var host=document.getElementById('manageFoldersList');
  if(!host)return;
  if(!currentFolders.length){
    host.innerHTML='<div style="font-size:.82rem;color:var(--text-faint);font-style:italic;padding:.75rem 0;text-align:center">No folders yet. Create one from the upload area in the Documents panel.</div>';
    return;
  }
  host.innerHTML=currentFolders.map(function(f){
    return '<div class="manage-folder-row" data-fid="'+f.id+'" style="display:flex;gap:.4rem;align-items:center;padding:.45rem 0;border-bottom:1px solid var(--border)">'
      +'<input type="text" value="'+esc(f.name)+'" data-orig="'+esc(f.name)+'" id="mf-name-'+f.id+'" style="flex:1;padding:.35rem .55rem;border:1.5px solid var(--border);border-radius:5px;font-size:.88rem;background:var(--white)">'
      +'<span style="font-size:.7rem;color:var(--text-faint);font-weight:600;min-width:42px;text-align:right">'+(f.document_count||0)+' doc'+((f.document_count||0)!==1?'s':'')+'</span>'
      +'<button class="btn-dl" onclick="renameFolderFromModal(\''+f.id+'\')" style="font-size:.72rem;padding:.28rem .55rem">Rename</button>'
      +'<button class="btn-dl" onclick="deleteFolderFromModal(\''+f.id+'\',\''+esc(f.name)+'\')" style="font-size:.72rem;padding:.28rem .55rem;background:#fdf0f0;color:var(--error);border-color:#f0b0b0">Delete</button>'
      +'</div>';
  }).join('');
}

async function renameFolderFromModal(folderId){
  var input=document.getElementById('mf-name-'+folderId);
  if(!input)return;
  var newName=input.value.trim();
  var orig=input.getAttribute('data-orig')||'';
  if(!newName){showToast('Folder name required');input.value=orig;return;}
  if(newName===orig){showToast('No change');return;}
  try{
    await api('/api/folders?id='+folderId,'PATCH',{name:newName});
    /* Update in-memory folder and refresh */
    var f=currentFolders.find(function(x){return x.id===folderId;});
    if(f)f.name=newName;
    renderManageFoldersList();
    renderDocs();
    renderUploadFolderPicker();
    showToast('Folder renamed');
  }catch(e){
    showToast('Error: '+e.message);
    input.value=orig;
  }
}

async function deleteFolderFromModal(folderId,folderName){
  var f=currentFolders.find(function(x){return x.id===folderId;});
  var count=f?(f.document_count||0):0;
  var msg='Delete folder "'+folderName+'"?';
  if(count>0)msg+='\n\n'+count+' document'+(count!==1?'s':'')+' currently assigned to this folder will be un-classified (the documents themselves will NOT be deleted).';
  if(!confirm(msg))return;
  try{
    await api('/api/folders?id='+folderId,'DELETE');
    /* Remove from in-memory state and clean selections */
    currentFolders=currentFolders.filter(function(x){return x.id!==folderId;});
    uploadSelectedFolderIds=uploadSelectedFolderIds.filter(function(id){return id!==folderId;});
    docEditSelectedFolderIds=docEditSelectedFolderIds.filter(function(id){return id!==folderId;});
    renderManageFoldersList();
    renderUploadFolderPicker();
    /* Reload documents so folder_ids on each doc reflect the delete */
    await loadDocuments(currentMatter.id);
    showToast('Folder deleted');
  }catch(e){showToast('Error: '+e.message);}
}

/* ── CHAT ─────────────────────────────────────────────────────────────────── */
async function sendMessage(){
  if(isLoading||!currentMatter)return;
  var input=document.getElementById('chatInput');
  var text=input.value.trim();if(!text)return;
  isLoading=true;input.value='';input.style.height='auto';
  document.getElementById('sendBtn').disabled=true;

  /* Tool follow-up: open dedicated follow-up view */
  var isToolFollowUp=activeTab!=='chat'&&activeTab!=='diagram'&&toolDefs[activeTab];
  if(isToolFollowUp){
    await sendToolFollowUp(text,activeTab);
    isLoading=false;document.getElementById('sendBtn').disabled=false;input.focus();
    return;
  }

  var area=getActiveMessagesArea();
  appendMsgTo(area,'user',text);
  var toolContext='';
  var typing=document.createElement('div');
  typing.className='msg msg-assistant';
  typing.innerHTML='<div class="typing-bubble"><span></span><span></span><span></span></div>';
  area.appendChild(typing);area.scrollTop=area.scrollHeight;
  try{
    var d=await api('/api/analyse','POST',{matterId:currentMatter.id,matterName:currentMatter.name,matterNature:currentMatter.nature||'',matterIssues:currentMatter.issues||'',actingFor:currentMatter.acting_for||'',messages:[{role:'user',content:text}],jurisdiction:jurisdiction,queryType:document.getElementById('qtypeSelect').value,focusAreas:Array.from(focusAreas)});
    typing.remove();
    if(d&&d.result){var hId=await saveHistory(text,d.result);var costStr=d.usage&&d.usage.costUsd?' · $'+d.usage.costUsd.toFixed(4):'';appendMsgTo(area,'assistant',d.result,'',text,costStr,null,hId);}
  }catch(e){typing.remove();var errEl=document.createElement('div');errEl.style.cssText='text-align:center;font-size:.78rem;color:var(--error);padding:.45rem;';errEl.textContent='\u26A0\uFE0F Error: '+e.message;area.appendChild(errEl);}
  finally{isLoading=false;document.getElementById('sendBtn').disabled=false;input.focus();}
}

/* ── Tool Follow-Up with Document Focus ────────────────────────────────── */
async function sendToolFollowUp(question,toolName){
  var cfg=toolDefs[toolName];
  var toolLabel=cfg?cfg.title:toolName;
  /* Get selected focus documents from the follow-up doc selector (if present) */
  var focusDocNames=[];
  document.querySelectorAll('#followUpDocList input:checked').forEach(function(cb){focusDocNames.push(cb.value);});
  /* Get the current tool result text for context */
  var msgsArea=document.getElementById('msgs-'+toolName);
  var currentResult='';
  if(msgsArea){
    var bubbles=msgsArea.querySelectorAll('.msg-bubble');
    if(bubbles.length>0)currentResult=bubbles[bubbles.length-1].innerText.slice(0,8000);
  }
  var toolContext='The user is viewing the '+toolLabel+' output for this matter. Answer their follow-up question in that context.';
  /* Replace the tool workspace with follow-up layout: question at top, answer below */
  var ws=msgsArea;
  if(!ws)return;
  ws.innerHTML='';ws.style.display='flex';
  /* Follow-up header */
  var header=document.createElement('div');
  header.className='followup-header';
  header.innerHTML='<div class="followup-question-label">Follow-up on '+esc(toolLabel.replace(/^[^\w]*/,''))+'</div>'
    +'<div class="followup-question-text">'+esc(question)+'</div>';
  if(focusDocNames.length>0){
    header.innerHTML+='<div class="followup-docs-label">Focused on: '+focusDocNames.map(function(n){return esc(n);}).join(', ')+'</div>';
  }
  ws.appendChild(header);
  /* Typing indicator */
  var typing=document.createElement('div');
  typing.className='msg msg-assistant';
  typing.innerHTML='<div class="typing-bubble"><span></span><span></span><span></span></div>';
  ws.appendChild(typing);ws.scrollTop=ws.scrollHeight;
  try{
    var body={matterId:currentMatter.id,matterName:currentMatter.name,matterNature:currentMatter.nature||'',matterIssues:currentMatter.issues||'',actingFor:currentMatter.acting_for||'',messages:[{role:'user',content:question+'\n\n[Context: '+toolContext+']\n\n[Previous tool output summary (first 8000 chars):\n'+currentResult+']'}],jurisdiction:jurisdiction,queryType:document.getElementById('qtypeSelect').value,focusAreas:Array.from(focusAreas)};
    if(focusDocNames.length>0)body.focusDocNames=focusDocNames;
    var d=await api('/api/analyse','POST',body);
    typing.remove();
    if(d&&d.result){
      var costStr=d.usage&&d.usage.costUsd?' · $'+d.usage.costUsd.toFixed(4):'';
      var hId=await saveHistory(toolLabel+' follow-up: '+question.slice(0,80),d.result,toolName);
      /* Render answer in full workspace */
      var answerWrap=document.createElement('div');
      answerWrap.className='followup-answer';
      answerWrap.innerHTML=renderMdWithSourceLinks(d.result);
      ws.appendChild(answerWrap);
      /* Meta bar */
      var meta=document.createElement('div');meta.className='followup-meta';
      meta.innerHTML='<span>Ex Libris Juris · '+(jurisdiction==='British Virgin Islands'?'BVI':jurisdiction)+(costStr||'')+'</span>';
      var dlBtn=document.createElement('button');dlBtn.className='btn-dl';dlBtn.textContent='\u2B07 Word';
      dlBtn.onclick=function(){downloadWord(d.result,toolLabel+' follow-up: '+question.slice(0,40));};
      meta.appendChild(dlBtn);
      ws.appendChild(meta);
      /* Doc selector + new follow-up input for chaining */
      buildFollowUpDocSelector(ws,toolName);
    }
  }catch(e){
    typing.remove();
    var errEl=document.createElement('div');errEl.style.cssText='text-align:center;font-size:.78rem;color:var(--error);padding:.45rem;';
    errEl.textContent='\u26A0\uFE0F Error: '+e.message;ws.appendChild(errEl);
    buildFollowUpDocSelector(ws,toolName);
  }
}

/* Build the document focus selector below a follow-up answer */
function buildFollowUpDocSelector(container,toolName){
  var html='<div class="followup-doc-selector">'
    +'<details open><summary class="followup-doc-summary">Focus next question on specific documents <span style="font-weight:400;color:var(--text-faint)">(optional — leave unchecked for all documents)</span></summary>'
    +'<div class="followup-doc-list" id="followUpDocList">';
  if(documents.length){
    for(var i=0;i<documents.length;i++){
      var d=documents[i];
      html+='<label class="anchor-item"><input type="checkbox" value="'+esc(d.name)+'"> '+esc(d.name)+' <span style="color:var(--text-faint);font-size:.72rem">['+esc(d.doc_type)+']</span></label>';
    }
  }else{
    html+='<div style="font-size:.82rem;color:var(--text-faint);font-style:italic">No documents uploaded for this matter.</div>';
  }
  html+='</div></details></div>';
  var wrap=document.createElement('div');
  wrap.innerHTML=html;
  container.appendChild(wrap.firstChild);
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
function closeModal(id){
  var modal=document.getElementById(id);
  modal.style.display='none';
  /* Restore focus to the element that opened the modal */
  if(window._modalOpener){window._modalOpener.focus();window._modalOpener=null;}
}
function openModal(id){
  window._modalOpener=document.activeElement;
  var modal=document.getElementById(id);
  modal.style.display='flex';
  /* Focus the first input or button inside the modal */
  var target=modal.querySelector('input:not([type=hidden]):not([style*="display:none"]),select,textarea,button.btn-primary');
  if(target)setTimeout(function(){target.focus();},60);
}
document.querySelectorAll('.overlay').forEach(function(o){o.addEventListener('click',function(e){if(e.target===o)closeModal(o.id);});});
/* Escape key closes topmost open modal */
document.addEventListener('keydown',function(e){
  if(e.key==='Escape'){
    var overlays=document.querySelectorAll('.overlay');
    /* Close the highest z-index open modal first */
    var topModal=null;var topZ=0;
    overlays.forEach(function(o){
      if(o.style.display!=='none'&&o.style.display!==''){
        var z=parseInt(getComputedStyle(o).zIndex)||200;
        if(z>=topZ){topZ=z;topModal=o;}
      }
    });
    if(topModal){e.preventDefault();closeModal(topModal.id);}
  }
});
/* Focus trap: keep Tab/Shift+Tab inside open modals */
document.addEventListener('keydown',function(e){
  if(e.key!=='Tab')return;
  var overlays=document.querySelectorAll('.overlay');
  var openModal=null;var topZ=0;
  overlays.forEach(function(o){
    if(o.style.display!=='none'&&o.style.display!==''){
      var z=parseInt(getComputedStyle(o).zIndex)||200;
      if(z>=topZ){topZ=z;openModal=o;}
    }
  });
  if(!openModal)return;
  var focusable=openModal.querySelectorAll('input:not([type=hidden]):not([style*="display:none"]),select,textarea,button,[tabindex]:not([tabindex="-1"])');
  if(!focusable.length)return;
  var first=focusable[0];var last=focusable[focusable.length-1];
  if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
  else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
});
function showToast(msg){var old=document.querySelector('.toast');if(old)old.remove();var t=document.createElement('div');t.className='toast';t.textContent=msg;document.body.appendChild(t);setTimeout(function(){t.remove();},3200);}
function clearMessages(){document.getElementById('messagesArea').innerHTML='';}
function sysMsg(text){var area=document.getElementById('messagesArea');var el=document.createElement('div');el.style.cssText='text-align:center;font-size:.78rem;font-weight:500;color:var(--text-faint);padding:.45rem;font-style:italic;';el.innerHTML=renderMd(text);area.appendChild(el);area.scrollTop=area.scrollHeight;}
/* init() is called at the end of the last loaded script file (diagram.js) */
