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
/* v5.1: Hierarchical folder view. foldersOpen maps folderId -> true when open.
   Reset on every matter switch — all folders start closed per session. */
var foldersOpen={};
/* v5.1c: Sentinel ID for the virtual "Unassigned" folder. Never sent to the
   backend; used only in foldersOpen tracking and as the inFolderId passed
   to renderDocRow when rendering Unassigned children. */
var UNASSIGNED_ID='__unassigned__';
/* v5.2: State for resuming a failed batched upload. When a batched upload
   fails part-way through, the batches already uploaded are preserved in
   the database and the remaining state is stashed here so the user can
   retry. Cleared on successful completion or when the user dismisses. */
var pendingUploadRetry=null;
/* v5.1: Context menu state — docId of the row the menu was opened on, and
   mode ('root' | 'moveTo' | 'addTo') for the single-level replace-contents flow. */
var ctxMenuDocId=null;
var ctxMenuMode='root';
/* v5.1: Long-press timer handle for iPad (touchstart -> 500ms -> show menu) */
var longPressTimer=null;
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
  /* v5.1: all folders start closed on every matter switch */
  foldersOpen={};
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
   description. Also shows a "Manage folders" button above the list.
   v5.1: HIERARCHICAL VIEW. Documents are grouped into expandable folder rows
   (closed by default). A document in N folders appears as N separate child
   rows. Uncategorised documents appear in a section at the bottom. Drag-and-
   drop moves documents between folders; long-press/right-click opens a
   context menu for move/add/edit/delete. */
function renderDocs(){
  var list=document.getElementById('docsList');
  var newFolderBtnRow=document.getElementById('newFolderButtonRow');
  if(!currentMatter){
    list.innerHTML='<div class="docs-empty-msg">Select a matter to see documents.</div>';
    if(newFolderBtnRow)newFolderBtnRow.style.display='none';
    return;
  }
  if(newFolderBtnRow)newFolderBtnRow.style.display='';
  /* Small secondary "Manage folders" link and folder count, right-aligned. */
  var header='<div class="docs-header-row" style="display:flex;justify-content:flex-end;align-items:center;margin-bottom:.35rem;gap:.5rem">'
    +(currentFolders.length?'<span style="font-size:.68rem;color:var(--text-faint);font-weight:500">'+currentFolders.length+' folder'+(currentFolders.length!==1?'s':'')+'</span>':'')
    +'<button class="btn-dl" onclick="openManageFoldersModal()" style="font-size:.7rem;padding:.22rem .5rem;background:var(--off-white);color:var(--text-mid);font-weight:600" title="Rename or delete folders">🗂 Manage</button>'
    +'</div>';
  if(!documents.length&&!currentFolders.length){
    list.innerHTML=header+'<div class="docs-empty-msg">No documents yet.<br>Upload PDFs above.</div>';
    return;
  }
  var icons={'Pleading':'📋','Skeleton Argument':'📝','Witness Statement':'👤','Exhibit':'📎','Case Law':'⚖️','Statute / Regulation':'📖','Correspondence':'✉️','Expert Report':'🔬','Trial Bundle':'📦','Other':'📄'};
  /* Build folder lookup and document groupings */
  var folderById={};
  currentFolders.forEach(function(f){folderById[f.id]=f;});
  /* Group documents by folder id. A doc in 2 folders lands in 2 bins. */
  var byFolder={};
  currentFolders.forEach(function(f){byFolder[f.id]=[];});
  var uncategorised=[];
  documents.forEach(function(doc){
    var fids=doc.folder_ids||[];
    if(fids.length===0){uncategorised.push(doc);return;}
    fids.forEach(function(fid){
      if(byFolder[fid])byFolder[fid].push(doc);
    });
  });
  /* Sort folders alphabetically by name for stable display */
  var sortedFolders=currentFolders.slice().sort(function(a,b){
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
  /* Render a single document row. inFolderId is the folder whose child row
     this is ('' if rendered under Uncategorised). Used by drag-to-move to
     know which folder to remove from. */
  function renderDocRow(doc,inFolderId){
    var folderIds=doc.folder_ids||[];
    var chipsHtml='';
    if(folderIds.length){
      chipsHtml=folderIds.map(function(fid){
        var f=folderById[fid];
        if(!f)return '';
        return '<span class="folder-chip" onclick="event.stopPropagation();openDocumentEditModal(\''+doc.id+'\')" title="Click to edit classification" style="display:inline-block;font-size:.66rem;font-weight:600;padding:.08rem .4rem;margin:.12rem .18rem 0 0;border-radius:10px;background:var(--blue-pale);color:var(--blue);border:1px solid var(--border);cursor:pointer">'+esc(f.name)+'</span>';
      }).join('');
    }else{
      chipsHtml='<span class="folder-classify-btn" onclick="event.stopPropagation();openDocumentEditModal(\''+doc.id+'\')" title="Assign to a folder" style="display:inline-block;font-size:.66rem;font-weight:600;padding:.08rem .4rem;margin-top:.12rem;border-radius:10px;background:var(--off-white);color:var(--text-faint);border:1px dashed var(--border-strong);cursor:pointer">+ classify</span>';
    }
    var descHtml=doc.description?'<div class="doc-desc" style="font-size:.66rem;color:var(--text-light);margin-top:.06rem;font-style:italic;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(doc.description)+'">'+esc(doc.description)+'</div>':'';
    /* v5.1c: docs live INSIDE a boxed container when their folder is open,
       so no left indent on the wrapper itself \u2014 the box provides the
       visual containment. */
    /* v5.1a/b: Safari has a long-standing bug where draggable=true on a
       display:flex container drops all dragover/drop events silently.
       Workaround: put draggable on an outer plain-block wrapper.
       v5.1b: ALSO add -webkit-user-drag:element. Without this, Safari
       defaults to "auto" which silently refuses to start a drag on a
       generic <div>. With "element" Safari unambiguously initiates the
       drag. position:relative is added because some Safari versions block
       dragstart on elements inside an overflow:auto container unless the
       draggable element has its own positioning context. */
    /* v5.1c: Move button label varies by where the doc lives. Inside a
       real folder it offers Move and Copy options; inside Unassigned it
       offers a flat list of folders to move into. The button calls
       openMoveToMenu which inspects inFolderId to pick the right menu
       shape. UNASSIGNED_ID is the sentinel for the virtual folder. */
    var moveTitle=(inFolderId&&inFolderId!==UNASSIGNED_ID)?'Move or copy to another folder':'Move to a folder';
    return '<div class="doc-item-wrap" draggable="true"'
      +' data-doc-id="'+doc.id+'"'
      +' data-in-folder="'+(inFolderId||'')+'"'
      +' ondragstart="docDragStart(event,\''+doc.id+'\',\''+(inFolderId||'')+'\')"'
      +' oncontextmenu="return showDocContextMenu(event,\''+doc.id+'\')"'
      +' ontouchstart="docTouchStart(event,\''+doc.id+'\')"'
      +' ontouchend="docTouchEnd(event)"'
      +' ontouchmove="docTouchEnd(event)"'
      +' style="display:block;cursor:grab;position:relative;-webkit-user-drag:element">'
      +'<div class="doc-item">'
      +'<span class="doc-icon">'+(icons[doc.doc_type]||'📄')+'</span><div class="doc-info">'
      +'<div class="doc-name" title="'+esc(doc.name)+'">'+esc(doc.name)+'</div>'
      +'<div class="doc-meta">'+esc(doc.doc_type)+(doc.chunk_count?' · '+doc.chunk_count+' passages':'')+'</div>'
      +descHtml
      +'<div class="doc-chips">'+chipsHtml+'</div>'
      +'</div>'
      +'<button onclick="event.stopPropagation();openMoveToMenu(event,\''+doc.id+'\',\''+(inFolderId||'')+'\')" title="'+moveTitle+'" style="background:var(--off-white);border:1px solid var(--border);color:var(--text-mid);cursor:pointer;font-size:.66rem;padding:.18rem .42rem;flex-shrink:0;font-weight:700;border-radius:4px;margin-right:.22rem;white-space:nowrap">Move \u25be</button>'
      +'<button onclick="event.stopPropagation();deleteDoc(\''+doc.id+'\',\''+esc(doc.name).replace(/'/g,"\\'")+'\')" style="background:none;border:none;color:var(--text-faint);cursor:pointer;font-size:1.1rem;padding:0 3px;flex-shrink:0;font-weight:700" title="Remove">×</button>'
      +'</div>'
      +'</div>';
  }

  /* v5.1c: Render a single folder (header + boxed children if open).
     Used for both real folders and the virtual Unassigned folder. The
     `isUnassigned` flag suppresses the delete button and changes the
     drop semantics (drop on Unassigned removes from source folder only).
     `folderId` for Unassigned is the UNASSIGNED_ID sentinel. */
  function renderFolderBlock(folderId,folderName,kids,isUnassigned){
    var open=!!foldersOpen[folderId];
    var glyph=open?'\u25BC':'\u25B6';
    /* The drop handler uses the empty string as the "drop on Unassigned"
       signal in folderDrop \u2014 keep that protocol for backward compat. */
    var dropArg=isUnassigned?'':folderId;
    var out='';
    /* When open, wrap the whole thing in a brown-bordered box. When closed,
       render only the header row standalone. */
    if(open){
      out+='<div class="folder-box" style="margin-top:.4rem;border:2px solid #8b6f47;border-radius:8px;overflow:hidden;background:#fff;box-shadow:0 1px 4px rgba(139,111,71,.2)">';
    }
    /* Folder header row \u2014 brown */
    out+='<div class="folder-row" data-folder-id="'+folderId+'"'
      +' ondragenter="folderDragOver(event,\''+dropArg+'\')"'
      +' ondragover="folderDragOver(event,\''+dropArg+'\')"'
      +' ondragleave="folderDragLeave(event)"'
      +' ondrop="folderDrop(event,\''+dropArg+'\')"'
      +' style="display:flex;align-items:center;gap:.45rem;padding:.65rem .55rem;'
      +(open?'':'margin-top:.35rem;border-radius:7px;')
      +'background:#8b6f47;border:none;color:#fff;font-weight:700;font-size:.88rem;'
      +(open?'':'box-shadow:0 1px 3px rgba(139,111,71,.25);')
      +'">'
      +'<div onclick="toggleFolderOpen(\''+folderId+'\')" style="display:flex;align-items:center;gap:.45rem;flex:1;cursor:pointer;min-width:0">'
      +'<span style="font-size:.78rem;width:.9rem;display:inline-block;text-align:center;color:rgba(255,255,255,.85)">'+glyph+'</span>'
      +'<span style="font-size:1.4rem;line-height:1">\uD83D\uDCC1</span>'
      +'<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#fff">'+esc(folderName)+'</span>'
      +'<span style="font-size:.72rem;color:rgba(255,255,255,.8);font-weight:600">('+kids.length+')</span>'
      +'</div>';
    /* Real folders get a delete button. Unassigned does not. */
    if(!isUnassigned){
      out+='<button onclick="event.stopPropagation();confirmAndDeleteFolder(\''+folderId+'\',\''+esc(folderName).replace(/'/g,"\\'")+'\')" style="background:none;border:none;color:rgba(255,255,255,.85);cursor:pointer;font-size:1.15rem;padding:0 5px;flex-shrink:0;font-weight:700" title="Delete folder">\u00D7</button>';
    }
    out+='</div>';
    /* When open, render the boxed children area below the header */
    if(open){
      out+='<div class="folder-children" style="padding:.5rem .5rem .55rem .5rem;background:#fff"'
        +' ondragenter="folderDragOver(event,\''+dropArg+'\')"'
        +' ondragover="folderDragOver(event,\''+dropArg+'\')"'
        +' ondragleave="folderDragLeave(event)"'
        +' ondrop="folderDrop(event,\''+dropArg+'\')">';
      if(kids.length===0){
        out+='<div style="padding:.5rem .25rem;font-size:.74rem;color:var(--text-faint);font-style:italic;text-align:center">'
          +(isUnassigned?'No unassigned documents.':'Empty folder. Drag documents here to classify them.')
          +'</div>';
      }else{
        /* Pass the inFolderId so renderDocRow knows whether to offer
           Move-only or Move+Copy in the menu. For Unassigned children we
           pass UNASSIGNED_ID, which renderDocRow uses to pick the simple
           menu shape. */
        var inId=isUnassigned?UNASSIGNED_ID:folderId;
        out+=kids.map(function(d){return renderDocRow(d,inId);}).join('');
      }
      out+='</div>';
      out+='</div>';
    }
    return out;
  }

  /* Render real folders, then Unassigned pinned to the bottom */
  var html=header;
  sortedFolders.forEach(function(f){
    html+=renderFolderBlock(f.id,f.name,byFolder[f.id]||[],false);
  });
  /* v5.1c: Unassigned is now a virtual folder pinned to the bottom of the
     list. Always shown, even when empty (so the user has a visible drop
     target for unassigning a doc by dragging it out of a real folder). */
  html+=renderFolderBlock(UNASSIGNED_ID,'Unassigned',uncategorised,true);
  list.innerHTML=html;
}

/* v5.1: Toggle a folder row open/closed (no network). */
function toggleFolderOpen(folderId){
  foldersOpen[folderId]=!foldersOpen[folderId];
  renderDocs();
}

/* v5.1: PATCH a document's folder_ids. Used by drag-drop and context menu. */
async function updateDocFolders(docId,newIds){
  try{
    await api('/api/documents?id='+docId,'PATCH',{folder_ids:newIds});
    await loadDocuments(currentMatter.id);
    await loadFolders(currentMatter.id);
  }catch(e){showToast('Error: '+e.message);}
}

/* v5.1: Drag-and-drop handlers for documents and folders.
   Dragstart carries the docId and the folder the drag originated from
   (empty string = Uncategorised). Drop target is a folder id
   (empty string = Uncategorised header).
   v5.1a: Console-log every dnd event for post-deploy diagnosis. If anything
   misbehaves, open devtools Console, try a drag, and check which log lines
   appear. dragstart missing → Safari is rejecting the flex container.
   dragstart but no dragover → target has no ondragenter. dragover but no
   drop → dropEffect mismatch. */
function docDragStart(ev,docId,fromFolderId){
  console.log('v5.1a dragstart: doc='+docId+' from='+(fromFolderId||'(uncategorised)'));
  try{
    ev.dataTransfer.setData('text/plain',JSON.stringify({docId:docId,from:fromFolderId||''}));
    ev.dataTransfer.effectAllowed='move';
  }catch(e){console.log('v5.1a dragstart setData failed:',e);}
}
function folderDragOver(ev,folderId){
  ev.preventDefault();
  try{ev.dataTransfer.dropEffect='move';}catch(e){}
  /* currentTarget is the folder-row wrapper — outline it blue */
  if(ev.currentTarget&&ev.currentTarget.style){
    ev.currentTarget.style.outline='2px solid var(--blue)';
    ev.currentTarget.style.outlineOffset='-2px';
  }
}
function folderDragLeave(ev){
  if(ev.currentTarget&&ev.currentTarget.style){
    ev.currentTarget.style.outline='';
    ev.currentTarget.style.outlineOffset='';
  }
}
function folderDrop(ev,targetFolderId){
  ev.preventDefault();
  ev.stopPropagation();
  if(ev.currentTarget&&ev.currentTarget.style){
    ev.currentTarget.style.outline='';
    ev.currentTarget.style.outlineOffset='';
  }
  var raw='';
  try{raw=ev.dataTransfer.getData('text/plain');}catch(e){}
  console.log('v5.1a drop: target='+(targetFolderId||'(uncategorised)')+' raw='+raw);
  if(!raw){console.log('v5.1a drop: no dataTransfer payload');return;}
  var data;try{data=JSON.parse(raw);}catch(e){console.log('v5.1a drop: parse failed');return;}
  if(!data||!data.docId){console.log('v5.1a drop: no docId');return;}
  var doc=documents.find(function(d){return d.id===data.docId;});
  if(!doc){console.log('v5.1a drop: doc not in memory');return;}
  var current=(doc.folder_ids||[]).slice();
  var from=data.from||'';
  console.log('v5.1a drop: doc='+data.docId+' from='+(from||'(uncat)')+' to='+(targetFolderId||'(uncat)')+' current='+JSON.stringify(current));
  /* Case: drop onto Uncategorised — remove only the source folder (\u00a7spec). */
  if(!targetFolderId){
    if(from){
      current=current.filter(function(x){return x!==from;});
      updateDocFolders(doc.id,current);
    }
    return;
  }
  /* Drop onto a real folder */
  if(current.indexOf(targetFolderId)!==-1&&from===targetFolderId)return; /* no-op */
  /* v5.1c: Real-folder-to-real-folder drop \u2014 prompt Move or Copy.
     "Real-folder-to-real" means BOTH source and target are real folder ids.
     Source from Unassigned (empty from) skips the prompt and just adds
     the target folder, since there's nothing to "copy from" in Unassigned. */
  if(from&&targetFolderId&&from!==targetFolderId){
    showMoveCopyPopup(ev,doc.id,from,targetFolderId);
    return;
  }
  /* From Unassigned to a real folder: just add the target. */
  if(current.indexOf(targetFolderId)===-1)current.push(targetFolderId);
  console.log('v5.1a drop: PATCH folder_ids='+JSON.stringify(current));
  updateDocFolders(doc.id,current);
}

/* v5.1c: Atomic helpers for move and copy. Both go through updateDocFolders
   (same PATCH endpoint) but compute the new folder_ids array differently. */
function doMoveDoc(docId,fromFolderId,toFolderId){
  var doc=documents.find(function(d){return d.id===docId;});
  if(!doc){showToast('Document not found');return;}
  var current=(doc.folder_ids||[]).slice();
  if(fromFolderId&&fromFolderId!==UNASSIGNED_ID){
    current=current.filter(function(x){return x!==fromFolderId;});
  }
  if(toFolderId&&current.indexOf(toFolderId)===-1)current.push(toFolderId);
  console.log('v5.1c doMoveDoc: doc='+docId+' from='+fromFolderId+' to='+toFolderId+' new='+JSON.stringify(current));
  updateDocFolders(docId,current);
}
function doCopyDoc(docId,toFolderId){
  var doc=documents.find(function(d){return d.id===docId;});
  if(!doc){showToast('Document not found');return;}
  var current=(doc.folder_ids||[]).slice();
  if(toFolderId&&current.indexOf(toFolderId)===-1)current.push(toFolderId);
  console.log('v5.1c doCopyDoc: doc='+docId+' to='+toFolderId+' new='+JSON.stringify(current));
  updateDocFolders(docId,current);
}

/* v5.1c: Show a small Move | Copy | Cancel popup positioned near the drop
   point. Used only when the user drops a doc from one real folder onto
   another real folder. Reuses the docContextMenu div as the host. */
function showMoveCopyPopup(ev,docId,fromFolderId,toFolderId){
  var menu=document.getElementById('docContextMenu');
  if(!menu){
    /* Fallback: just move silently if the popup host is missing */
    doMoveDoc(docId,fromFolderId,toFolderId);
    return;
  }
  var fromName=(currentFolders.find(function(f){return f.id===fromFolderId;})||{}).name||'(folder)';
  var toName=(currentFolders.find(function(f){return f.id===toFolderId;})||{}).name||'(folder)';
  var item='padding:.55rem .85rem;cursor:pointer;white-space:nowrap';
  var hover=' onmouseover="this.style.background=\'var(--blue-faint)\'" onmouseout="this.style.background=\'\'"';
  menu.innerHTML='<div style="padding:.45rem .85rem;font-size:.7rem;text-transform:uppercase;letter-spacing:.04em;color:var(--text-faint);font-weight:700;border-bottom:1px solid var(--border);max-width:280px;overflow:hidden;text-overflow:ellipsis">'+esc(fromName)+' \u2192 '+esc(toName)+'</div>'
    +'<div style="'+item+';font-weight:600"'+hover+' onclick="moveCopyPopupPick(\'move\',\''+docId+'\',\''+fromFolderId+'\',\''+toFolderId+'\')">\u2192 Move</div>'
    +'<div style="'+item+';font-weight:600"'+hover+' onclick="moveCopyPopupPick(\'copy\',\''+docId+'\',\''+fromFolderId+'\',\''+toFolderId+'\')">+ Copy (keeps in '+esc(fromName)+')</div>'
    +'<div style="height:1px;background:var(--border);margin:.2rem 0"></div>'
    +'<div style="'+item+';color:var(--text-faint)"'+hover+' onclick="hideCtxMenu()">Cancel</div>';
  /* Position near the drop point, kept on-screen */
  var x=(ev&&ev.clientX)||100,y=(ev&&ev.clientY)||100;
  var vw=window.innerWidth,vh=window.innerHeight;
  var mw=300,mh=180;
  if(x+mw>vw)x=vw-mw-8;
  if(y+mh>vh)y=vh-mh-8;
  if(x<8)x=8;if(y<8)y=8;
  menu.style.left=x+'px';
  menu.style.top=y+'px';
  menu.style.display='';
  /* Track this as a context menu so click-outside dismisses it */
  ctxMenuDocId=docId;
  setTimeout(function(){document.addEventListener('click',ctxMenuOutsideClick,true);},10);
}
function moveCopyPopupPick(action,docId,fromFolderId,toFolderId){
  hideCtxMenu();
  if(action==='move')doMoveDoc(docId,fromFolderId,toFolderId);
  else if(action==='copy')doCopyDoc(docId,toFolderId);
}

/* v5.1c: Move \u25be button entry point. Builds a flat folder menu (Unassigned
   source) or a Move+Copy menu (real-folder source). Reuses the docContextMenu
   host. The inFolderId arg is the folder the doc is currently being rendered
   inside \u2014 used to decide menu shape and as the "from" for moves. */
function openMoveToMenu(ev,docId,inFolderId){
  if(ev&&ev.preventDefault)ev.preventDefault();
  if(ev&&ev.stopPropagation)ev.stopPropagation();
  ctxMenuDocId=docId;
  var menu=document.getElementById('docContextMenu');
  if(!menu)return;
  var doc=documents.find(function(d){return d.id===docId;});
  if(!doc)return;
  var isFromUnassigned=(!inFolderId||inFolderId===UNASSIGNED_ID);
  var item='padding:.5rem .85rem;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:300px';
  var hover=' onmouseover="this.style.background=\'var(--blue-faint)\'" onmouseout="this.style.background=\'\'"';
  var folders=currentFolders.slice().sort(function(a,b){return a.name.toLowerCase().localeCompare(b.name.toLowerCase());});
  var html='';
  if(isFromUnassigned){
    /* Unassigned source: flat list, move-only. No copy because there's
       nothing to keep the doc in. Tapping a folder moves the doc into it. */
    html='<div style="padding:.45rem .85rem;font-size:.7rem;text-transform:uppercase;letter-spacing:.04em;color:var(--text-faint);font-weight:700;border-bottom:1px solid var(--border)">Move to folder</div>';
    if(folders.length===0){
      html+='<div style="padding:.5rem .85rem;color:var(--text-faint);font-style:italic">No folders yet. Create one first.</div>';
    }else{
      html+=folders.map(function(f){
        return '<div style="'+item+'"'+hover+' onclick="moveToMenuPick(\'move\',\''+docId+'\',\'\',\''+f.id+'\')">\uD83D\uDCC1 '+esc(f.name)+'</div>';
      }).join('');
    }
  }else{
    /* Real-folder source: each folder shown twice (Move and Copy). The
       folder the doc is currently in is excluded from the Move list (no
       point) but included in the Copy list as a no-op (filtered out at
       PATCH time). */
    var fromName=(currentFolders.find(function(f){return f.id===inFolderId;})||{}).name||'';
    html='<div style="padding:.45rem .85rem;font-size:.7rem;text-transform:uppercase;letter-spacing:.04em;color:var(--text-faint);font-weight:700;border-bottom:1px solid var(--border);max-width:300px;overflow:hidden;text-overflow:ellipsis">From '+esc(fromName)+'</div>';
    if(folders.length<=1){
      html+='<div style="padding:.5rem .85rem;color:var(--text-faint);font-style:italic">No other folders. Create one first.</div>';
    }else{
      folders.forEach(function(f){
        if(f.id===inFolderId)return; /* skip the source folder */
        html+='<div style="'+item+';font-weight:600"'+hover+' onclick="moveToMenuPick(\'move\',\''+docId+'\',\''+inFolderId+'\',\''+f.id+'\')">\u2192 Move to '+esc(f.name)+'</div>';
        html+='<div style="'+item+'"'+hover+' onclick="moveToMenuPick(\'copy\',\''+docId+'\',\''+inFolderId+'\',\''+f.id+'\')">+ Copy to '+esc(f.name)+'</div>';
      });
    }
  }
  html+='<div style="height:1px;background:var(--border);margin:.2rem 0"></div>'
    +'<div style="'+item+';color:var(--text-faint)"'+hover+' onclick="hideCtxMenu()">Cancel</div>';
  menu.innerHTML=html;
  /* Position near the button click point */
  var x=(ev&&ev.clientX)||100,y=(ev&&ev.clientY)||100;
  var vw=window.innerWidth,vh=window.innerHeight;
  var mw=320,mh=Math.min(420,40+folders.length*40);
  if(x+mw>vw)x=vw-mw-8;
  if(y+mh>vh)y=vh-mh-8;
  if(x<8)x=8;if(y<8)y=8;
  menu.style.left=x+'px';
  menu.style.top=y+'px';
  menu.style.display='';
  setTimeout(function(){document.addEventListener('click',ctxMenuOutsideClick,true);},10);
}
function moveToMenuPick(action,docId,fromFolderId,toFolderId){
  hideCtxMenu();
  if(action==='move')doMoveDoc(docId,fromFolderId,toFolderId);
  else if(action==='copy')doCopyDoc(docId,toFolderId);
}

/* v5.1: Context menu (desktop right-click + iPad long-press).
   Single-level replace-contents flow: root menu -> pick action -> if the
   action is "Move to..." or "Also add to..." the same menu's contents are
   replaced with a list of folders to pick from. Cancel/click-outside
   dismisses. */
function showDocContextMenu(ev,docId){
  if(ev&&ev.preventDefault)ev.preventDefault();
  ctxMenuDocId=docId;
  ctxMenuMode='root';
  var menu=document.getElementById('docContextMenu');
  if(!menu)return false;
  renderCtxMenuRoot();
  var x=(ev&&ev.clientX)||0,y=(ev&&ev.clientY)||0;
  if(ev&&ev.touches&&ev.touches[0]){x=ev.touches[0].clientX;y=ev.touches[0].clientY;}
  else if(ev&&ev.changedTouches&&ev.changedTouches[0]){x=ev.changedTouches[0].clientX;y=ev.changedTouches[0].clientY;}
  /* Keep menu on-screen */
  var vw=window.innerWidth,vh=window.innerHeight;
  var mw=220,mh=220;
  if(x+mw>vw)x=vw-mw-8;
  if(y+mh>vh)y=vh-mh-8;
  if(x<8)x=8;if(y<8)y=8;
  menu.style.left=x+'px';
  menu.style.top=y+'px';
  menu.style.display='';
  /* Dismiss on next outside click */
  setTimeout(function(){document.addEventListener('click',ctxMenuOutsideClick,true);},10);
  return false;
}
function ctxMenuOutsideClick(ev){
  var menu=document.getElementById('docContextMenu');
  if(menu&&!menu.contains(ev.target)){
    hideCtxMenu();
  }
}
function hideCtxMenu(){
  var menu=document.getElementById('docContextMenu');
  if(menu)menu.style.display='none';
  document.removeEventListener('click',ctxMenuOutsideClick,true);
  ctxMenuDocId=null;
  ctxMenuMode='root';
}
function renderCtxMenuRoot(){
  var menu=document.getElementById('docContextMenu');
  if(!menu)return;
  var item='padding:.5rem .85rem;cursor:pointer;white-space:nowrap';
  var hover=' onmouseover="this.style.background=\'var(--blue-faint)\'" onmouseout="this.style.background=\'\'"';
  menu.innerHTML='<div style="'+item+'"'+hover+' onclick="ctxMenuPick(\'moveTo\')">Move to folder…</div>'
    +'<div style="'+item+'"'+hover+' onclick="ctxMenuPick(\'addTo\')">Also add to…</div>'
    +'<div style="'+item+'"'+hover+' onclick="ctxMenuEdit()">Edit…</div>'
    +'<div style="height:1px;background:var(--border);margin:.2rem 0"></div>'
    +'<div style="'+item+';color:var(--error)"'+hover+' onclick="ctxMenuDelete()">Delete</div>'
    +'<div style="height:1px;background:var(--border);margin:.2rem 0"></div>'
    +'<div style="'+item+';color:var(--text-faint)"'+hover+' onclick="hideCtxMenu()">Cancel</div>';
}
function ctxMenuPick(mode){
  ctxMenuMode=mode;
  var doc=documents.find(function(d){return d.id===ctxMenuDocId;});
  if(!doc){hideCtxMenu();return;}
  var current=doc.folder_ids||[];
  var candidates;
  if(mode==='moveTo'){
    /* All folders are valid targets for "move to", including the one it's
       already in (moving to the same folder is a no-op but harmless). */
    candidates=currentFolders.slice();
  }else{
    /* "Also add to" only offers folders the doc isn't already in. */
    candidates=currentFolders.filter(function(f){return current.indexOf(f.id)===-1;});
  }
  /* Always offer Uncategorised as a target for "moveTo" (makes it unclassified) */
  var menu=document.getElementById('docContextMenu');
  var item='padding:.5rem .85rem;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:280px';
  var hover=' onmouseover="this.style.background=\'var(--blue-faint)\'" onmouseout="this.style.background=\'\'"';
  var title=mode==='moveTo'?'Move to…':'Also add to…';
  var html='<div style="padding:.4rem .85rem;font-size:.72rem;text-transform:uppercase;letter-spacing:.04em;color:var(--text-faint);font-weight:700">'+title+'</div>';
  if(candidates.length===0){
    html+='<div style="padding:.5rem .85rem;color:var(--text-faint);font-style:italic">No folders available</div>';
  }else{
    candidates.sort(function(a,b){return a.name.toLowerCase().localeCompare(b.name.toLowerCase());});
    html+=candidates.map(function(f){
      return '<div style="'+item+'"'+hover+' onclick="ctxMenuTargetFolder(\''+f.id+'\')">📁 '+esc(f.name)+'</div>';
    }).join('');
  }
  if(mode==='moveTo'){
    html+='<div style="height:1px;background:var(--border);margin:.2rem 0"></div>'
      +'<div style="'+item+'"'+hover+' onclick="ctxMenuTargetFolder(\'\')">Uncategorised</div>';
  }
  html+='<div style="height:1px;background:var(--border);margin:.2rem 0"></div>'
    +'<div style="'+item+';color:var(--text-faint)"'+hover+' onclick="hideCtxMenu()">Cancel</div>';
  menu.innerHTML=html;
}
function ctxMenuTargetFolder(folderId){
  var doc=documents.find(function(d){return d.id===ctxMenuDocId;});
  if(!doc){hideCtxMenu();return;}
  var current=(doc.folder_ids||[]).slice();
  if(ctxMenuMode==='moveTo'){
    if(!folderId){current=[];}
    else{current=[folderId];}
  }else if(ctxMenuMode==='addTo'){
    if(folderId&&current.indexOf(folderId)===-1)current.push(folderId);
  }
  hideCtxMenu();
  updateDocFolders(doc.id,current);
}
function ctxMenuEdit(){
  var id=ctxMenuDocId;
  hideCtxMenu();
  if(id)openDocumentEditModal(id);
}
function ctxMenuDelete(){
  var id=ctxMenuDocId;
  var doc=documents.find(function(d){return d.id===id;});
  hideCtxMenu();
  if(doc)deleteDoc(doc.id,doc.name);
}
/* v5.1: iPad long-press (500ms) triggers the same context menu as right-click.
   Uses touch events; any movement or touchend before 500ms cancels the timer. */
function docTouchStart(ev,docId){
  if(longPressTimer){clearTimeout(longPressTimer);longPressTimer=null;}
  var t=ev.touches&&ev.touches[0];
  var fakeEv={clientX:(t?t.clientX:0),clientY:(t?t.clientY:0),preventDefault:function(){}};
  longPressTimer=setTimeout(function(){
    longPressTimer=null;
    showDocContextMenu(fakeEv,docId);
  },500);
}
function docTouchEnd(ev){
  if(longPressTimer){clearTimeout(longPressTimer);longPressTimer=null;}
}

/* v5.1: Main-list "New folder" button handlers. Mirrors the upload-picker
   inline input flow but mounts into its own DOM nodes so both can coexist. */
async function showNewFolderInputMain(){
  var row=document.getElementById('newFolderMainInputRow');
  if(!row)return;
  row.style.display='';
  var input=document.getElementById('newFolderMainNameInput');
  if(input){input.value='';setTimeout(function(){input.focus();},40);}
  /* Populate the shared suggestions datalist (same as upload-picker uses) */
  try{
    var d=await api('/api/folders?action=defaults');
    var defaults=(d&&d.defaults)||[];
    var existing={};currentFolders.forEach(function(f){existing[f.name.toLowerCase()]=true;});
    var listEl=document.getElementById('newFolderSuggestions');
    if(listEl){
      listEl.innerHTML=defaults.filter(function(n){return !existing[String(n).toLowerCase()];}).map(function(n){return '<option value="'+esc(n)+'">';}).join('');
    }
  }catch(e){/* defaults are optional — silent */}
}
function hideNewFolderInputMain(){
  var row=document.getElementById('newFolderMainInputRow');
  if(row)row.style.display='none';
}
async function createFolderFromMainInput(){
  var input=document.getElementById('newFolderMainNameInput');
  if(!input)return;
  var name=input.value.trim();
  if(!name){showToast('Folder name required');return;}
  if(!currentMatter){showToast('Select a matter first');return;}
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
      /* Open the new folder in the hierarchical view */
      foldersOpen[d.folder.id]=true;
      hideNewFolderInputMain();
      renderUploadFolderPicker();
      renderDocs();
      showToast('Folder "'+name+'" created');
    }
  }catch(e){showToast('Error: '+e.message);}
}

/* v5.1: Unified delete-folder flow used by both the main-list × button and
   the manage-folders modal. Three-way choice if the folder has documents. */
async function confirmAndDeleteFolder(folderId,folderName){
  var f=currentFolders.find(function(x){return x.id===folderId;});
  if(!f){showToast('Folder not found');return;}
  var count=f.document_count||0;
  /* Recount from in-memory documents in case document_count is stale */
  var docsInFolder=documents.filter(function(d){return (d.folder_ids||[]).indexOf(folderId)!==-1;});
  count=docsInFolder.length;
  if(count===0){
    if(!confirm('Delete folder "'+folderName+'"?'))return;
    await doDeleteFolderOnly(folderId,folderName);
    return;
  }
  /* Folder has documents. Three-way prompt via two confirms — keeps this
     on native browser dialogs which is consistent with the rest of ELJ. */
  var msg='Folder "'+folderName+'" contains '+count+' document'+(count!==1?'s':'')+'.\n\n'
    +'Press OK to delete the folder ONLY (documents become uncategorised, but are kept).\n\n'
    +'Press Cancel to get the option to delete the documents as well.';
  if(confirm(msg)){
    await doDeleteFolderOnly(folderId,folderName);
    return;
  }
  /* User cancelled the "folder only" option — now offer the destructive path */
  var soloCount=docsInFolder.filter(function(d){return (d.folder_ids||[]).length===1;}).length;
  var sharedCount=count-soloCount;
  var destructiveMsg='DESTRUCTIVE ACTION\n\n'
    +'Delete folder "'+folderName+'" AND '+soloCount+' document'+(soloCount!==1?'s':'')+' whose only folder this is?';
  if(sharedCount>0){
    destructiveMsg+='\n\n('+sharedCount+' document'+(sharedCount!==1?'s':'')+' also belong to other folders and will NOT be deleted — just unassigned from this folder.)';
  }
  destructiveMsg+='\n\nThis cannot be undone.';
  if(!confirm(destructiveMsg))return;
  /* Second confirm for irreversibility */
  if(!confirm('Really delete '+soloCount+' document'+(soloCount!==1?'s':'')+'? Last chance to cancel.'))return;
  await doDeleteFolderAndDocs(folderId,folderName,docsInFolder);
}
async function doDeleteFolderOnly(folderId,folderName){
  try{
    await api('/api/folders?id='+folderId,'DELETE');
    currentFolders=currentFolders.filter(function(x){return x.id!==folderId;});
    uploadSelectedFolderIds=uploadSelectedFolderIds.filter(function(id){return id!==folderId;});
    docEditSelectedFolderIds=docEditSelectedFolderIds.filter(function(id){return id!==folderId;});
    delete foldersOpen[folderId];
    await loadDocuments(currentMatter.id);
    renderManageFoldersList();
    renderUploadFolderPicker();
    showToast('Folder deleted');
  }catch(e){showToast('Error: '+e.message);}
}
async function doDeleteFolderAndDocs(folderId,folderName,docsInFolder){
  var soloDocs=docsInFolder.filter(function(d){return (d.folder_ids||[]).length===1;});
  var failed=0;
  for(var i=0;i<soloDocs.length;i++){
    try{
      await api('/api/documents?id='+soloDocs[i].id,'DELETE');
    }catch(e){failed++;console.error('Delete doc failed:',soloDocs[i].name,e);}
  }
  try{
    await api('/api/folders?id='+folderId,'DELETE');
  }catch(e){showToast('Folder delete failed: '+e.message);}
  currentFolders=currentFolders.filter(function(x){return x.id!==folderId;});
  uploadSelectedFolderIds=uploadSelectedFolderIds.filter(function(id){return id!==folderId;});
  docEditSelectedFolderIds=docEditSelectedFolderIds.filter(function(id){return id!==folderId;});
  delete foldersOpen[folderId];
  await loadDocuments(currentMatter.id);
  await loadMatters();
  renderManageFoldersList();
  renderUploadFolderPicker();
  if(failed>0)showToast('Deleted with '+failed+' error'+(failed!==1?'s':''));
  else showToast('Folder and '+soloDocs.length+' document'+(soloDocs.length!==1?'s':'')+' deleted');
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

/* v4.5: Dispatch by extension, reject legacy .doc, support .docx via mammoth
   v5.2: Route each file through uploadFileBatched so very large files
   (3 GB hearing bundles extracting to >4.5 MB of text) can be split into
   multiple POSTs that each fit under Vercel's gateway limit. */
async function uploadFiles(files){
  if(!files.length||!currentMatter)return;
  /* Clear any previous retry state — a fresh upload session replaces it */
  pendingUploadRetry=null;
  clearUploadRetryUI();
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
      /* Hand off to the batched uploader. It handles both the single-POST
         happy path and the multi-POST large-file path transparently. */
      var ok=await uploadFileBatched(file,pages,docType,uploadSelectedFolderIds.slice(),fullText,isDocx);
      if(!ok){
        /* Failure state is already set by uploadFileBatched. Stop the
           outer loop so the user can retry before continuing with the
           rest of the batch. */
        break;
      }
    }catch(e){errEl.textContent='Failed: '+file.name+' — '+e.message;errEl.classList.add('on');}
  }
  prog.classList.remove('on');await loadDocuments(currentMatter.id);await loadMatters();
  /* v5.0: Clear the upload folder selection after a batch and refresh the
     folder picker (document counts may have changed). */
  uploadSelectedFolderIds=[];
  await loadFolders(currentMatter.id);
}

/* v5.2: Batched upload for a single file. Packs pageTexts into batches
   capped at ~2 MB of JSON per POST, then sends them sequentially. The
   first batch creates the document row; subsequent batches append
   chunks to the same documentId. Returns true on full success, false
   on failure (in which case pendingUploadRetry is populated and the
   retry UI is shown). */
async function uploadFileBatched(file,pages,docType,folderIds,fullText,isDocx){
  var errEl=document.getElementById('uploadErr');
  var prog=document.getElementById('uploadProg');
  /* v5.2a: Reduced from 2 MB to 1 MB after v5.2 still hit 413s on real
     dense hearing bundles. JSON encoding expands bytes due to
     backslash-escaping and Unicode, and Vercel's gateway limit is 4.5 MB
     on the body. 1 MB of raw text typically produces ~1.2-2.5 MB of
     actual JSON body, leaving >2 MB of safety margin. */
  var BATCH_TARGET_BYTES=1*1024*1024;
  var batches=packPagesIntoBatches(pages,BATCH_TARGET_BYTES);
  var unitLabel=isDocx?'block(s)':'page(s)';
  var totalKB=Math.round(fullText.length/1024);
  /* Single-batch happy path — matches old behaviour exactly, no batch
     fields sent to the server. */
  if(batches.length===1){
    var singleBody={matterId:currentMatter.id,fileName:file.name,pageTexts:pages,docType:docType,folderIds:folderIds};
    var singleBodyKB=Math.round(JSON.stringify(singleBody).length/1024);
    console.log('v5.2a single-batch upload: '+pages.length+' pages, body='+singleBodyKB+'KB');
    prog.textContent='Uploading: '+file.name+' ('+totalKB+'KB text, '+pages.length+' '+unitLabel+')…';
    try{
      var d=await api('/api/upload','POST',singleBody);
      if(d)showToast('\u2713 '+file.name+' — '+d.chunks+' passages indexed'+(d.pageAware?' (page-aware)':''));
      return true;
    }catch(e){
      console.log('v5.2a single-batch FAILED: body was '+singleBodyKB+'KB, error='+e.message);
      errEl.textContent='Failed: '+file.name+' \u2014 '+e.message+' (body '+singleBodyKB+'KB)';
      errEl.classList.add('on');
      return false;
    }
  }
  /* Multi-batch path. Send batches sequentially, updating progress. */
  return await runBatchedUploadFromIndex(file,pages,docType,folderIds,batches,0,null,unitLabel,totalKB);
}

/* v5.2: Execute a batched upload starting at fromBatchIndex. Used both
   for fresh uploads (fromBatchIndex=0, documentId=null) and for retries
   (fromBatchIndex=N, documentId=<existing>).
   v5.2a: logs the actual JSON body size before each POST so that any
   future 413 can be diagnosed from the Console output without guessing. */
async function runBatchedUploadFromIndex(file,pages,docType,folderIds,batches,fromBatchIndex,documentId,unitLabel,totalKB){
  var errEl=document.getElementById('uploadErr');
  var prog=document.getElementById('uploadProg');
  var totalBatches=batches.length;
  for(var bi=fromBatchIndex;bi<totalBatches;bi++){
    var batchPages=batches[bi];
    var body={
      matterId:currentMatter.id,
      fileName:file.name,
      pageTexts:batchPages,
      docType:docType,
      folderIds:folderIds,
      batchIndex:bi,
      batchTotal:totalBatches,
    };
    if(bi>0&&documentId)body.documentId=documentId;
    var bodyJson=JSON.stringify(body);
    var bodyKB=Math.round(bodyJson.length/1024);
    console.log('v5.2a batch '+(bi+1)+'/'+totalBatches+': '+batchPages.length+' pages, body='+bodyKB+'KB');
    prog.textContent='Uploading: '+file.name+' (batch '+(bi+1)+' of '+totalBatches+', '+bodyKB+'KB, '+totalKB+'KB total)…';
    prog.classList.add('on');
    try{
      var d=await api('/api/upload','POST',body);
      /* First batch response carries the documentId; stash it for the rest. */
      if(bi===0&&d&&d.documentId){documentId=d.documentId;}
      /* Last batch complete — full success. */
      if(bi===totalBatches-1&&d&&d.complete){
        showToast('\u2713 '+file.name+' \u2014 uploaded in '+totalBatches+' batches');
        pendingUploadRetry=null;
        clearUploadRetryUI();
        return true;
      }
    }catch(e){
      console.log('v5.2a batch '+(bi+1)+' FAILED: body was '+bodyKB+'KB, error='+e.message);
      /* Store what we need to resume and show the retry button. */
      pendingUploadRetry={
        file:file,
        pages:pages,
        docType:docType,
        folderIds:folderIds,
        batches:batches,
        fromBatchIndex:bi,
        documentId:documentId,
        unitLabel:unitLabel,
        totalKB:totalKB,
        error:e.message,
      };
      errEl.innerHTML='Failed on batch '+(bi+1)+' of '+totalBatches+' ('+bodyKB+'KB): '+esc(e.message)
        +' <button onclick="retryPendingUpload()" style="margin-left:.5rem;padding:.2rem .6rem;background:var(--blue);color:#fff;border:none;border-radius:4px;font-size:.78rem;font-weight:700;cursor:pointer">Retry from batch '+(bi+1)+'</button>'
        +' <button onclick="dismissPendingUpload()" style="margin-left:.25rem;padding:.2rem .6rem;background:var(--off-white);color:var(--text-faint);border:1px solid var(--border);border-radius:4px;font-size:.78rem;font-weight:600;cursor:pointer">Dismiss</button>';
      errEl.classList.add('on');
      prog.classList.remove('on');
      return false;
    }
  }
  /* Shouldn't reach here \u2014 the last-batch branch returns on success. */
  return true;
}

/* v5.2: Pack pages into batches each below targetBytes of JSON.
   v5.2a: Rewritten to MEASURE real JSON size (JSON.stringify) rather than
   estimate raw character count. JSON encoding expands bytes due to
   backslash-escaping of quotes, backslashes, and Unicode, plus the
   {"page":N,"text":"..."} overhead. A naive character-count estimate
   can under-report by 2x on dense text. Also splits individual pages
   that exceed targetBytes by slicing their text; preserves the page
   number so page-aware chunking still works on the server. */
function packPagesIntoBatches(pages,targetBytes){
  /* Step 1: split any individual page whose JSON representation exceeds
     targetBytes into smaller slices with the same page number. */
  var splitPages=[];
  for(var i=0;i<pages.length;i++){
    var pg=pages[i];
    var asJson=JSON.stringify(pg);
    if(asJson.length<=targetBytes){
      splitPages.push(pg);
      continue;
    }
    /* Page is too big on its own. Slice the text. We need each slice's
       JSON form to fit under targetBytes. Leave 200 bytes of headroom
       for the {"page":N,"text":""} wrapper overhead. */
    var maxChars=targetBytes-200;
    var text=pg.text||'';
    var start=0;
    while(start<text.length){
      var slice=text.slice(start,start+maxChars);
      /* Re-check the actual JSON size of the slice; if escaping blew it
         up past targetBytes, halve the slice and retry. Very rare. */
      while(JSON.stringify({page:pg.page,text:slice}).length>targetBytes&&slice.length>100){
        slice=slice.slice(0,Math.floor(slice.length*0.8));
      }
      splitPages.push({page:pg.page,text:slice});
      start+=slice.length;
    }
  }
  /* Step 2: greedy-pack splitPages into batches by measuring the JSON
     size of the batch-so-far plus the candidate page. */
  var batches=[];
  var current=[];
  for(var j=0;j<splitPages.length;j++){
    var candidate=splitPages[j];
    if(current.length===0){
      current.push(candidate);
      continue;
    }
    /* Would adding this page push the batch over targetBytes? */
    var withCandidate=JSON.stringify(current.concat([candidate]));
    if(withCandidate.length>targetBytes){
      batches.push(current);
      current=[candidate];
    }else{
      current.push(candidate);
    }
  }
  if(current.length>0)batches.push(current);
  return batches;
}

/* v5.2: Retry handler for the button shown in the upload error area. */
async function retryPendingUpload(){
  if(!pendingUploadRetry)return;
  var r=pendingUploadRetry;
  var errEl=document.getElementById('uploadErr');
  errEl.classList.remove('on');
  errEl.innerHTML='';
  var ok=await runBatchedUploadFromIndex(r.file,r.pages,r.docType,r.folderIds,r.batches,r.fromBatchIndex,r.documentId,r.unitLabel,r.totalKB);
  if(ok){
    /* Refresh the document list so the user sees the completed upload */
    await loadDocuments(currentMatter.id);
    await loadMatters();
    await loadFolders(currentMatter.id);
  }
}

/* v5.2: Clear the retry state and hide the retry button. Leaves any
   partially-uploaded document in place \u2014 the user can delete it from
   the document list if they want to abandon it. */
function dismissPendingUpload(){
  pendingUploadRetry=null;
  clearUploadRetryUI();
}
function clearUploadRetryUI(){
  var errEl=document.getElementById('uploadErr');
  if(errEl){errEl.classList.remove('on');errEl.innerHTML='';}
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
  /* v5.1: Delegate to the unified confirm-and-delete helper so the main-list
     × button and the Manage Folders modal have identical semantics. */
  await confirmAndDeleteFolder(folderId,folderName);
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

/* v5.1b: Document-level event delegation for drag-and-drop and diagnostic
   probes. The inline ondragstart= attributes on .doc-item-wrap should fire
   first; this delegated listener is a backup in case Safari is silently
   ignoring inline handlers on dynamically-injected HTML (which it sometimes
   does for elements inside scroll containers). The mousedown probe logs
   whenever a click hits a doc-item-wrap, so we can tell whether the drag
   never starts because mousedown isn't reaching the wrapper or because
   dragstart isn't firing despite mousedown working. */
document.addEventListener('mousedown',function(ev){
  var wrap=ev.target&&ev.target.closest&&ev.target.closest('.doc-item-wrap');
  if(wrap){
    console.log('v5.1b mousedown on doc-item-wrap: doc='+(wrap.getAttribute('data-doc-id')||'?')+' draggable='+wrap.getAttribute('draggable'));
  }
},true);
document.addEventListener('dragstart',function(ev){
  var wrap=ev.target&&ev.target.closest&&ev.target.closest('.doc-item-wrap');
  if(!wrap)return;
  console.log('v5.1b delegated dragstart fired for doc='+(wrap.getAttribute('data-doc-id')||'?'));
  /* If inline handler already populated dataTransfer, this is a no-op cosmetic
     log. If inline handler didn't fire, populate dataTransfer here. */
  try{
    var existing=ev.dataTransfer.getData('text/plain');
    if(!existing){
      console.log('v5.1b delegated: inline handler did NOT populate dataTransfer, doing it now');
      var docId=wrap.getAttribute('data-doc-id')||'';
      var fromFolder=wrap.getAttribute('data-in-folder')||'';
      ev.dataTransfer.setData('text/plain',JSON.stringify({docId:docId,from:fromFolder}));
      ev.dataTransfer.effectAllowed='move';
    }else{
      console.log('v5.1b delegated: inline handler already set dataTransfer');
    }
  }catch(e){console.log('v5.1b delegated dataTransfer error:',e);}
},true);
/* init() is called at the end of the last loaded script file (diagram.js) */
