/* ── TOOL DEFINITIONS ────────────────────────────────────────────────────── */
var toolDefs={
  inconsistency:{title:'🔍 Inconsistency Tracker',body:function(){return '<p class="tool-desc">Select anchor documents (your baseline factual position). The system finds all contradictions in the remaining documents.</p><div class="focus-label">Anchor Documents <span style="font-weight:400;text-transform:none;letter-spacing:0">(leave blank to compare all)</span></div><div class="anchor-list" id="anchorList">'+documents.map(function(d){return '<label class="anchor-item"><input type="checkbox" value="'+esc(d.name)+'"> '+esc(d.name)+' <span style="color:var(--text-faint);font-size:.72rem">['+d.doc_type+']</span></label>';}).join('')+'</div><div class="focus-label" style="margin-top:.85rem">Additional Instructions <span style="font-weight:400;text-transform:none;letter-spacing:0">(optional)</span></div><textarea id="toolInstructions" placeholder="e.g. Focus on the dates of payments"></textarea>';}},
  proposition:{title:'🎯 Proposition Evidence Finder',body:function(){return '<p class="tool-desc">State a proposition or factual assertion. The system finds all evidence supporting or contradicting it and grades each reference by strength.</p><div class="focus-label">Proposition or Statement</div><textarea id="toolInstructions" placeholder="e.g. The defendant had knowledge of the transactions before 1 January 2023" style="min-height:80px"></textarea>';}},
  chronology:{title:'📅 Chronology Builder',body:function(){return '<p class="tool-desc">Extracts all dates and events from every document and assembles a complete chronology with page and paragraph references.</p>'
    +'<div class="focus-label">Date Range <span style="font-weight:400;text-transform:none;letter-spacing:0">(optional — any format)</span></div>'
    +'<input type="text" id="chronoDateRange" class="f-input" style="margin-bottom:.6rem;padding:.5rem .7rem;font-size:.88rem" placeholder="e.g. January 2020 to March 2023, or after 1 Jan 2022">'
    +'<div class="focus-label">Focus on Individuals or Entities <span style="font-weight:400;text-transform:none;letter-spacing:0">(optional)</span></div>'
    +'<input type="text" id="chronoEntities" class="f-input" style="margin-bottom:.6rem;padding:.5rem .7rem;font-size:.88rem" placeholder="e.g. John Smith, Acme Ltd — comma-separated">'
    +'<div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.6rem"><input type="checkbox" id="chronoCorresFilter" style="width:16px;height:16px;accent-color:var(--blue)"><label for="chronoCorresFilter" style="font-size:.82rem;color:var(--text-mid);font-weight:500;cursor:pointer">Only include correspondence if referenced in a pleading or affidavit</label></div>'
    +'<div class="focus-label">Additional Instructions <span style="font-weight:400;text-transform:none;letter-spacing:0">(optional)</span></div>'
    +'<textarea id="toolInstructions" placeholder="e.g. Focus on the share transfer events"></textarea>';}},
  persons:{title:'👥 Dramatis Personae',body:function(){return '<p class="tool-desc">Identifies every person and entity across all documents with descriptions and references. Excludes attorneys and judges. References are ordered: first in pleadings/petitions, then in affidavits.</p><div class="focus-label">Additional Instructions <span style="font-weight:400;text-transform:none;letter-spacing:0">(optional)</span></div><textarea id="toolInstructions" placeholder="e.g. Focus on the directors and shareholders"></textarea>';}},
  issues:{title:'⚖ Issue Tracker',body:function(){return '<p class="tool-desc">Maps every legal and factual issue and assesses the supporting evidence for each party.</p><div class="focus-label">Additional Instructions <span style="font-weight:400;text-transform:none;letter-spacing:0">(optional)</span></div><textarea id="toolInstructions" placeholder="e.g. Focus on the limitation defence"></textarea>';}},
  citations:{title:'📚 Citation Checker',body:function(){return '<p class="tool-desc">Checks citations in skeleton arguments and pleadings against uploaded judgments.</p>'
    +'<div class="focus-label">Source Document <span style="font-weight:400;text-transform:none;letter-spacing:0">(containing citations to check — leave blank for all skeleton arguments &amp; pleadings)</span></div>'
    +'<select id="citationSourceSelect" class="f-input" style="margin-bottom:.6rem;padding:.5rem .7rem;font-size:.88rem"><option value="">— Auto-detect (skeleton arguments &amp; pleadings) —</option>'
    +documents.map(function(d){return '<option value="'+esc(d.name)+'">'+esc(d.name)+' ['+esc(d.doc_type)+']</option>';}).join('')
    +'</select>'
    +'<div class="focus-label">Target Case Law <span style="font-weight:400;text-transform:none;letter-spacing:0">(to check citations against — leave blank for all case law)</span></div>'
    +'<div class="anchor-list" id="citationTargetList" style="max-height:120px">'
    +documents.filter(function(d){return d.doc_type==='Case Law';}).map(function(d){return '<label class="anchor-item"><input type="checkbox" checked value="'+esc(d.name)+'"> '+esc(d.name)+'</label>';}).join('')
    +(documents.filter(function(d){return d.doc_type==='Case Law';}).length===0?'<div style="font-size:.84rem;color:var(--text-faint);padding:.3rem">No case law documents uploaded.</div>':'')
    +'</div>'
    +'<p style="font-size:.84rem;color:var(--text-faint)">Upload the relevant case law before running this tool.</p>';}},
  briefing:{title:'📋 Briefing Note',body:function(){return '<p class="tool-desc">Produces a structured briefing note: sets out the issues, explains common ground and admissions, then analyses how the case can be established on disputed matters.</p><div class="focus-label">Additional Instructions <span style="font-weight:400;text-transform:none;letter-spacing:0">(optional)</span></div><textarea id="toolInstructions" placeholder="e.g. Written for a colleague unfamiliar with the matter"></textarea>';}},
  issueBriefing:{title:'📝 Issue Briefing',body:function(){return '<p class="tool-desc">Produces a detailed briefing on selected issues: commentary, document references, and strengths and weaknesses for each party.</p><p style="font-size:.84rem;color:var(--text-faint)">Issues are pre-selected from the Issue Tracker output.</p>';}},
  diagram:{title:'📈 Relationship Diagram',body:function(){return '<p class="tool-desc">Entity relationship diagram generated from the Dramatis Personae analysis.</p>';}}
};

/* ── TAB MANAGEMENT ──────────────────────────────────────────────────────── */
function switchTab(tabId){
  activeTab=tabId;
  document.querySelectorAll('.tab').forEach(function(t){t.classList.toggle('active',t.dataset.tab===tabId);});
  document.getElementById('ws-chat').classList.toggle('active',tabId==='chat');
  document.querySelectorAll('.tool-workspace').forEach(function(ws){ws.classList.toggle('active',ws.dataset.tool===tabId);});
  var cfg=toolDefs[tabId];
  var inp=document.getElementById('chatInput');
  if(tabId==='diagram')inp.placeholder='Diagram view — use the toolbar to filter relationships…';
  else if(cfg)inp.placeholder='Ask a follow-up question about the '+cfg.title.replace(/^[^\w]*/,'')+'…';
  else inp.placeholder='Ask a question about this matter…';
}

function getOrCreateToolTab(toolName){
  if(openTabs.indexOf(toolName)!==-1){switchTab(toolName);return false;}
  var tabBar=document.getElementById('tabBar');
  var cfg=toolDefs[toolName];
  var tab=document.createElement('div');
  tab.className='tab';tab.dataset.tab=toolName;
  tab.innerHTML=cfg.title.split(' ').slice(0,2).join(' ')+'<button class="tab-close" title="Close tab">×</button>';
  tab.querySelector('.tab-close').addEventListener('click',function(e){e.stopPropagation();closeTab(toolName);});
  tab.addEventListener('click',function(){switchTab(toolName);});
  tabBar.appendChild(tab);
  var ws=document.createElement('div');
  ws.className='tool-workspace tab-workspace';ws.dataset.tool=toolName;
  ws.innerHTML='<div class="tool-ready" id="ready-'+toolName+'"><div class="tool-ready-icon">'+cfg.title.split(' ')[0]+'</div><div class="tool-ready-title">'+cfg.title.replace(/^[^\w]*/,'')+'</div><div class="tool-ready-sub">Click Run to analyse all documents in this matter.</div><button class="btn-run-tool" onclick="promptTool(\''+toolName+'\')">Run Analysis</button></div><div class="messages-area tool-msgs" id="msgs-'+toolName+'" style="display:none"></div>';
  /* v5.5: Reflect lock state on the freshly-created Run button. */
  if(typeof updateToolButtonStates==='function')updateToolButtonStates();
  document.getElementById('toolWorkspaces').appendChild(ws);
  openTabs.push(toolName);
  switchTab(toolName);
  return true;
}

function closeTab(toolName){
  document.querySelectorAll('.tab').forEach(function(t){if(t.dataset.tab===toolName)t.remove();});
  document.querySelectorAll('.tool-workspace').forEach(function(ws){if(ws.dataset.tool===toolName)ws.remove();});
  openTabs=openTabs.filter(function(t){return t!==toolName;});
  if(activeTab===toolName)switchTab('chat');
  showToast('Tab closed — result saved in History');
}

function openTool(t){
  if(!currentMatter){showToast('Select a matter first');return;}
  var isNew=getOrCreateToolTab(t);
  if(!isNew)return;
  promptTool(t);
}
/* ═══════════════════════════════════════════════════════════════════════════
   v5.0 — FOLDER FILTER for tool launcher
   ───────────────────────────────────────────────────────────────────────────
   The folder filter is the primary way to scope a tool run. It composes with
   the existing per-document exclude filter: folder selection produces an
   "include" set, then any per-doc boxes the user unticks further narrow it.
   ═══════════════════════════════════════════════════════════════════════════ */

/* Renders the folder filter section.
   v5.0a fix: original implementation used a <details open> wrapper with nested
   <label><input> checkboxes. On Safari inside the tool modal, clicks on the
   nested checkboxes were being swallowed (likely by the <details> click
   handling). Rebuilt as plain <div>s with click-on-row that manually toggles
   the checkbox state and then invokes folderFilterChanged(). No labels, no
   details, no summary — eliminates the entire class of click-capture issues. */
function folderFilterHtml(){
  if(!documents||!documents.length)return '';
  var folders=(typeof currentFolders!=='undefined'&&currentFolders)?currentFolders:[];
  var unassignedCount=0;
  documents.forEach(function(d){if(!d.folder_ids||!d.folder_ids.length)unassignedCount++;});
  if(!folders.length&&unassignedCount===documents.length)return '';
  var rowCss='display:flex;align-items:center;gap:.55rem;padding:.35rem .4rem;font-size:.85rem;cursor:pointer;border-radius:4px;user-select:none';
  var boxCss='width:15px;height:15px;border:1.5px solid var(--blue);border-radius:3px;flex-shrink:0;display:inline-flex;align-items:center;justify-content:center;font-size:.72rem;font-weight:900;color:var(--blue);background:var(--white)';
  var html='<div class="folder-filter-wrap" style="margin-top:.85rem;border:1.5px solid var(--blue);border-radius:6px;padding:.55rem .7rem;background:var(--blue-pale)">'
    +'<div style="font-size:.78rem;font-weight:700;color:var(--blue);letter-spacing:.04em;text-transform:uppercase;margin-bottom:.45rem">Folder Filter <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--text-mid)">(focus the tool on specific folders)</span></div>'
    +'<div id="folderFilterBody">'
    +'<div class="ff-row ff-all on" data-ff-mode="all" onclick="ffSelectAll()" style="'+rowCss+';font-weight:700;border-bottom:1px dashed var(--border);padding-bottom:.45rem;margin-bottom:.35rem">'
      +'<span class="ff-box" style="'+boxCss+'">\u25CF</span>'
      +'<span style="flex:1">All documents <span style="color:var(--text-faint);font-size:.72rem;font-weight:500">('+documents.length+')</span></span>'
      +'</div>';
  /* Unassigned bucket — only clickable if any unassigned docs exist */
  var unassignedClick=unassignedCount?'onclick="ffToggle(this)"':'';
  var unassignedOpacity=unassignedCount?'':';opacity:.45;cursor:not-allowed';
  html+='<div class="ff-row" data-ff-type="unassigned" data-ff-value="__unassigned" '+unassignedClick+' style="'+rowCss+unassignedOpacity+'">'
    +'<span class="ff-box" style="'+boxCss+'"></span>'
    +'<span style="flex:1">Unassigned <span style="color:var(--text-faint);font-size:.72rem">('+unassignedCount+')</span></span>'
    +'</div>';
  folders.forEach(function(f){
    html+='<div class="ff-row" data-ff-type="folder" data-ff-value="'+esc(f.id)+'" onclick="ffToggle(this)" style="'+rowCss+'">'
      +'<span class="ff-box" style="'+boxCss+'"></span>'
      +'<span style="flex:1">'+esc(f.name)+' <span style="color:var(--text-faint);font-size:.72rem">('+(f.document_count||0)+')</span></span>'
      +'</div>';
  });
  html+='</div></div>';
  return html;
}

/* Toggle a folder-filter row. Called from the row's onclick. Manipulates
   the classList and box glyph, then syncs the per-doc list below. */
function ffToggle(row){
  var on=row.classList.toggle('on');
  var box=row.querySelector('.ff-box');
  if(box)box.textContent=on?'\u2713':'';
  /* Clear the "All" row when any folder/unassigned is toggled on */
  var allRow=document.querySelector('.ff-row.ff-all');
  if(on&&allRow){
    allRow.classList.remove('on');
    var allBox=allRow.querySelector('.ff-box');
    if(allBox)allBox.textContent='';
  }
  /* If nothing is now ticked, re-arm "All" */
  var anyOn=document.querySelectorAll('#folderFilterBody .ff-row.on:not(.ff-all)').length>0;
  if(!anyOn&&allRow){
    allRow.classList.add('on');
    var ab=allRow.querySelector('.ff-box');
    if(ab)ab.textContent='\u25CF';
  }
  folderFilterChanged();
}

/* Re-arm the "All documents" row and clear every other folder-filter row. */
function ffSelectAll(){
  var allRow=document.querySelector('.ff-row.ff-all');
  if(allRow){
    allRow.classList.add('on');
    var ab=allRow.querySelector('.ff-box');
    if(ab)ab.textContent='\u25CF';
  }
  document.querySelectorAll('#folderFilterBody .ff-row:not(.ff-all)').forEach(function(r){
    r.classList.remove('on');
    var b=r.querySelector('.ff-box');
    if(b)b.textContent='';
  });
  folderFilterChanged();
}

/* Read folder filter state. Returns:
     { mode: 'all' }  — the "All documents" row is the only one on
     { mode: 'subset', folderIds: [...], includeUnassigned: bool }
   If subset mode but nothing is ticked, behaves like 'all'.
   v5.0a: Reads from .ff-row elements with .on class, not <input>. */
function getFolderFilterState(){
  var allRow=document.querySelector('.ff-row.ff-all');
  if(allRow&&allRow.classList.contains('on'))return {mode:'all'};
  var folderIds=[];var includeUnassigned=false;
  document.querySelectorAll('#folderFilterBody .ff-row.on').forEach(function(r){
    var type=r.getAttribute('data-ff-type');
    if(type==='unassigned')includeUnassigned=true;
    else if(type==='folder')folderIds.push(r.getAttribute('data-ff-value'));
  });
  if(!folderIds.length&&!includeUnassigned)return {mode:'all'};
  return {mode:'subset',folderIds:folderIds,includeUnassigned:includeUnassigned};
}

/* Walk the documents array and return the names matching the folder filter.
   Returns null when mode is 'all' (meaning: no include filter, let the worker
   process everything subject only to excludes). */
function resolveIncludeDocNames(){
  var state=getFolderFilterState();
  if(state.mode==='all')return null;
  var wantedFolders={};state.folderIds.forEach(function(id){wantedFolders[id]=true;});
  var names=[];
  documents.forEach(function(d){
    var fids=d.folder_ids||[];
    if(!fids.length){
      if(state.includeUnassigned)names.push(d.name);
      return;
    }
    for(var i=0;i<fids.length;i++){
      if(wantedFolders[fids[i]]){names.push(d.name);return;}
    }
  });
  return names;
}

/* Sync the per-document checkbox list with the current folder filter state.
   Called from ffToggle and ffSelectAll after they update row state. */
function folderFilterChanged(){
  var names=resolveIncludeDocNames();
  if(names===null){
    /* All documents mode — tick everything in the per-doc list */
    document.querySelectorAll('#docFilterDocs input[type="checkbox"]').forEach(function(cb){cb.checked=true;});
    return;
  }
  var wanted={};names.forEach(function(n){wanted[n]=true;});
  document.querySelectorAll('#docFilterDocs input[type="checkbox"]').forEach(function(cb){
    cb.checked=!!wanted[cb.value];
  });
}

/* v3.4: Document filter — exclude documents by name or type from tool runs */
function docFilterHtml(){
  if(!documents||!documents.length)return '';
  var types={};documents.forEach(function(d){types[d.doc_type]=true;});
  var typeList=Object.keys(types).sort();
  var html='<details class="doc-filter-details" style="margin-top:.85rem;border:1.5px solid var(--border);border-radius:6px;padding:.4rem .6rem;background:var(--blue-faint)">'
    +'<summary style="font-size:.78rem;font-weight:600;color:var(--text-mid);cursor:pointer;letter-spacing:.04em;text-transform:uppercase">Document Filter <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--text-faint)">(click to exclude documents)</span></summary>'
    +'<div style="margin-top:.5rem">'
    +'<div style="font-size:.75rem;font-weight:600;color:var(--text-light);margin-bottom:.3rem;text-transform:uppercase;letter-spacing:.04em">By Type</div>'
    +'<div id="docFilterTypes" style="display:flex;flex-wrap:wrap;gap:.3rem;margin-bottom:.5rem">';
  typeList.forEach(function(dt){
    html+='<label style="font-size:.78rem;display:flex;align-items:center;gap:.3rem;padding:.15rem .4rem;border:1px solid var(--border);border-radius:4px;cursor:pointer;background:var(--white)"><input type="checkbox" checked data-doctype="'+esc(dt)+'" onchange="docFilterTypeToggle(this)" style="width:14px;height:14px;accent-color:var(--blue)">'+esc(dt)+'</label>';
  });
  html+='</div>'
    +'<div style="font-size:.75rem;font-weight:600;color:var(--text-light);margin-bottom:.3rem;text-transform:uppercase;letter-spacing:.04em">By Document</div>'
    +'<div id="docFilterDocs" style="max-height:150px;overflow-y:auto">';
  documents.forEach(function(d){
    html+='<label class="anchor-item" style="font-size:.8rem"><input type="checkbox" checked value="'+esc(d.name)+'" data-dtype="'+esc(d.doc_type)+'"> '+esc(d.name)+' <span style="color:var(--text-faint);font-size:.72rem">['+esc(d.doc_type)+']</span></label>';
  });
  html+='</div></div></details>';
  return html;
}
function docFilterTypeToggle(el){
  var dt=el.getAttribute('data-doctype');var checked=el.checked;
  document.querySelectorAll('#docFilterDocs input[data-dtype="'+dt+'"]').forEach(function(cb){cb.checked=checked;});
}
function getExcludedDocNames(){
  var excluded=[];
  document.querySelectorAll('#docFilterDocs input[type="checkbox"]').forEach(function(cb){if(!cb.checked)excluded.push(cb.value);});
  return excluded;
}
function getExcludedDocTypes(){
  var excluded=[];
  document.querySelectorAll('#docFilterTypes input[type="checkbox"]').forEach(function(cb){if(!cb.checked)excluded.push(cb.getAttribute('data-doctype'));});
  return excluded;
}
/* v5.5: Click-debounce / running-tool lock.
   Tracks which tools currently have an in-flight job for the current matter.
   Prevents the user from launching the same tool twice on the same matter
   (which produced duplicate Claude runs and duplicate history rows).
   Persisted in sessionStorage so a page refresh preserves the locked state;
   also re-asserted on resume by resumeInProgressJobs. */
var runningTools=new Set();
function _rtKey(){return currentMatter?'rt-'+currentMatter.id:null;}
function _rtLoad(){
  runningTools=new Set();
  var k=_rtKey();if(!k)return;
  try{var s=sessionStorage.getItem(k);if(s){JSON.parse(s).forEach(function(t){runningTools.add(t);});}}catch(e){}
}
function _rtSave(){
  var k=_rtKey();if(!k)return;
  try{sessionStorage.setItem(k,JSON.stringify(Array.from(runningTools)));}catch(e){}
}
function rtLock(toolName){if(!toolName)return;runningTools.add(toolName);_rtSave();updateToolButtonStates();}
function rtUnlock(toolName){if(!toolName)return;runningTools.delete(toolName);_rtSave();updateToolButtonStates();}
function rtIsLocked(toolName){return runningTools.has(toolName);}
function updateToolButtonStates(){
  Object.keys(toolDefs||{}).forEach(function(toolName){
    var ready=document.getElementById('ready-'+toolName);
    if(!ready)return;
    var btn=ready.querySelector('.btn-run-tool');
    if(!btn)return;
    if(rtIsLocked(toolName)){
      btn.disabled=true;btn.style.opacity='0.5';btn.style.cursor='not-allowed';
      btn.textContent='Running\u2026';
    }else{
      btn.disabled=false;btn.style.opacity='';btn.style.cursor='';
      btn.textContent='Run Analysis';
    }
  });
}

function promptTool(t){
  if(!currentMatter){showToast('Select a matter first');return;}
  if(rtIsLocked(t)){
    showToast(toolDefs[t].title+' is already running on this matter \u2014 please wait');
    return;
  }
  pendingTool=t;
  var cfg=toolDefs[t];
  document.getElementById('toolModalTitle').textContent=cfg.title;
  document.getElementById('toolModalBody').innerHTML=cfg.body()+folderFilterHtml()+docFilterHtml();
  document.getElementById('toolModal').style.display='flex';
}
function getActiveMessagesArea(){
  if(activeTab==='chat')return document.getElementById('messagesArea');
  return document.getElementById('msgs-'+activeTab)||document.getElementById('messagesArea');
}
function showToolResult(toolName){
  var ready=document.getElementById('ready-'+toolName);
  var msgs=document.getElementById('msgs-'+toolName);
  if(ready)ready.style.display='none';
  if(msgs)msgs.style.display='flex';
  return msgs;
}

/* ── TOOL EXECUTION (v3.4: fire-and-poll background processing) ── */
document.getElementById('toolRunBtn').addEventListener('click',async function(){
  if(!pendingTool||!currentMatter)return;
  if(rtIsLocked(pendingTool)){
    showToast(toolDefs[pendingTool].title+' is already running \u2014 please wait');
    closeModal('toolModal');
    return;
  }
  /* v5.5: Lock BEFORE any await so a fast double-click can't slip through. */
  var v55LockedTool=pendingTool;
  rtLock(v55LockedTool);
  var instructions=document.getElementById('toolInstructions')?document.getElementById('toolInstructions').value.trim():'';
  var anchorDocNames=[];
  if(pendingTool==='inconsistency'){document.querySelectorAll('#anchorList input:checked').forEach(function(cb){anchorDocNames.push(cb.value);});}
  var chronologyDateRange='';var chronologyEntities='';var chronologyCorrespondenceFilter=false;
  if(pendingTool==='chronology'){
    var drEl=document.getElementById('chronoDateRange');if(drEl)chronologyDateRange=drEl.value.trim();
    var enEl=document.getElementById('chronoEntities');if(enEl)chronologyEntities=enEl.value.trim();
    var cfEl=document.getElementById('chronoCorresFilter');if(cfEl)chronologyCorrespondenceFilter=cfEl.checked;
  }
  /* v3.4: Collect document exclusions from filter */
  var excludeDocNames=getExcludedDocNames();
  var excludeDocTypes=getExcludedDocTypes();
  /* v5.0: Resolve folder filter selection → list of document names to include.
     Returns null when "All documents" is selected, meaning no include filter. */
  var includeDocNames=resolveIncludeDocNames();
  closeModal('toolModal');
  var toolName=pendingTool;
  var toolLabel=toolDefs[toolName]?toolDefs[toolName].title:toolName;
  switchTab(toolName);
  var msgsArea=showToolResult(toolName);
  var progressWrap=document.getElementById('progressWrap');
  var progressLabel=document.getElementById('progressLabel');
  var progressFill=document.getElementById('progressFill');
  progressWrap.classList.add('on');
  progressLabel.textContent='Submitting '+toolLabel+'\u2026';
  progressFill.style.width='5%';
  var typing=document.createElement('div');typing.className='msg msg-assistant msg-tool';typing.innerHTML='<div class="typing-bubble"><span></span><span></span><span></span></div>';msgsArea.appendChild(typing);msgsArea.scrollTop=msgsArea.scrollHeight;
  try{
    var body={tool:toolName,matterId:currentMatter.id,matterName:currentMatter.name,matterNature:currentMatter.nature||'',matterIssues:currentMatter.issues||'',actingFor:currentMatter.acting_for||'',jurisdiction:jurisdiction,anchorDocNames:anchorDocNames,instructions:instructions,excludeDocNames:excludeDocNames,excludeDocTypes:excludeDocTypes};
    /* v5.0: only send includeDocNames when the folder filter is narrowing */
    if(includeDocNames&&includeDocNames.length>0)body.includeDocNames=includeDocNames;
    if(chronologyDateRange)body.chronologyDateRange=chronologyDateRange;
    if(chronologyEntities)body.chronologyEntities=chronologyEntities;
    if(chronologyCorrespondenceFilter)body.chronologyCorrespondenceFilter=true;
    /* v3.6: Citation source and target parameters */
    if(toolName==='citations'){
      var citSrc=document.getElementById('citationSourceSelect');
      if(citSrc&&citSrc.value)body.citationSource=citSrc.value;
      var citTargets=[];
      document.querySelectorAll('#citationTargetList input:checked').forEach(function(cb){citTargets.push(cb.value);});
      if(citTargets.length>0)body.citationTargets=citTargets;
    }
    /* v3.4: Fire job — returns immediately with jobId */
    var d=await api('/api/tools','POST',body);
    if(!d||!d.jobId)throw new Error('No jobId returned');
    progressLabel.textContent='Processing '+toolLabel+'\u2026 (you can close your laptop \u2014 processing continues in the background)';
    progressFill.style.width='10%';
    /* v4.4: Polling loop extracted into startPollingJob for reuse by resumeInProgressJobs */
    startPollingJob(d.jobId,toolName,toolLabel,instructions,msgsArea,progressWrap,progressLabel,progressFill,typing);
  }catch(e){
    typing.remove();progressWrap.classList.remove('on');progressFill.style.width='0%';
    var errEl2=document.createElement('div');errEl2.style.cssText='text-align:center;font-size:.78rem;color:var(--error);padding:.45rem;';
    errEl2.textContent='\u26A0\uFE0F Tool error: '+e.message;msgsArea.appendChild(errEl2);
    /* v5.5: Job never started \u2014 release the lock. */
    rtUnlock(v55LockedTool);
  }
});

/* ── v4.4: POLLING LOOP (extracted from toolRunBtn handler for reuse) ────── */
/* Starts polling /api/jobs for a single job. Handles status updates, progress
   bar, worker re-firing on paused/synthesising, completion, failure, and the
   60-minute safety stop. Used both by new tool runs and by resumeInProgressJobs
   on matter reload. All v4.2k over-firing protection preserved.
   v4.5c: Condense progress and synth attempt count surfaced in the label. */
function startPollingJob(jobId,toolName,toolLabel,instructions,msgsArea,progressWrap,progressLabel,progressFill,typing){
  var pollCount=0;
  /* v4.2k: Frontend over-firing fix. Track last fire status + time. Only re-fire
     when status has changed since last fire, or more than 180s have passed.
     Without this, every 10s poll fires /api/worker, producing 15-20 parallel
     invocations per condense pause and wasting Anthropic spend on duplicates. */
  var lastFireStatus=null;
  var lastFireTime=0;
  var FIRE_COOLDOWN_MS=180000;
  var pollInterval=setInterval(async function(){
    try{
      pollCount++;
      var j=await api('/api/jobs?id='+jobId);
      if(!j)return;
      /* v4.5c: build attempt suffix once — used in several status labels. */
      var attemptSuffix=(j.synthAttempts&&j.synthAttempts>=2)?' (attempt '+j.synthAttempts+')':'';
      if(j.batchesTotal>0&&j.batchesDone>0){
        var pct=Math.min(10+Math.round((j.batchesDone/j.batchesTotal)*80),90);
        progressFill.style.width=pct+'%';
        progressLabel.textContent='Processing '+toolLabel+'\u2026 batch '+j.batchesDone+' of '+j.batchesTotal;
      }
      if(j.status==='complete'||j.status==='partial'){
        clearInterval(pollInterval);if(typing)typing.remove();
        progressFill.style.width='100%';
        setTimeout(function(){progressWrap.classList.remove('on');progressFill.style.width='0%';},800);
        /* v5.5: Job complete — release the lock. */
        rtUnlock(toolName);
        if(j.result){
          var isProp=toolName==='proposition';
          var costStr=j.usage&&j.usage.costUsd?' \u00B7 $'+j.usage.costUsd.toFixed(4):'';
          if(currentMatter)await loadHistory(currentMatter.id);
          var latestH=matterHistory.find(function(h){return h.tool_name===toolName;});
          var hId=latestH?latestH.id:null;
          appendMsgTo(msgsArea,'assistant',j.result,isProp?'prop':'tool',toolLabel+(instructions?': '+instructions.slice(0,60):''),costStr,toolName,hId);
        }else{
          var noRes=document.createElement('div');noRes.style.cssText='text-align:center;font-size:.78rem;color:var(--text-faint);padding:.45rem;';
          noRes.textContent='Tool completed but returned no result.';msgsArea.appendChild(noRes);
        }
        return;
      }
      if(j.status==='paused'||j.status==='synthesising'){
        /* v4.2e: Worker paused or ready for synthesis — re-fire worker from frontend */
        /* v4.2k: Only fire if status changed since last fire OR cooldown elapsed */
        /* v4.5c: Refined synthesising labels — show condense progress, then
           "Producing final document" once condense is complete. */
        if(j.status==='synthesising'){
          var extractsCount=j.extractsCount||0;
          var condenseDone=j.condenseDone||0;
          var condensedCount=j.condensedCount||0;
          if(extractsCount>0&&condenseDone<extractsCount){
            /* Still in condense phase — show X of Y. condenseDone counts in
               groups of 3 and may briefly equal or exceed extractsCount on the
               final partial group; clamp the display so it never reads "X of X"
               while still working on the last group. */
            var displayDone=Math.min(condensedCount*3,extractsCount);
            progressLabel.textContent='Condensing '+toolLabel+'\u2026 '+displayDone+' of '+extractsCount+attemptSuffix;
            /* Map condense progress between 90% and 95% */
            var condensePct=90+Math.round((displayDone/extractsCount)*5);
            progressFill.style.width=condensePct+'%';
          }else{
            progressLabel.textContent='Producing final '+toolLabel+'\u2026'+attemptSuffix;
            progressFill.style.width='95%';
          }
        }else{
          progressLabel.textContent='Resuming '+toolLabel+'\u2026 batch '+j.batchesDone+' of '+j.batchesTotal+attemptSuffix;
        }
        var nowMs=Date.now();
        var statusChanged=(j.status!==lastFireStatus);
        var cooldownElapsed=(nowMs-lastFireTime>FIRE_COOLDOWN_MS);
        if(statusChanged||cooldownElapsed){
          console.log('v4.2k re-fire worker:',j.status,statusChanged?'(status changed)':'(cooldown elapsed)');
          lastFireStatus=j.status;
          lastFireTime=nowMs;
          fetch('/api/worker?jobId='+jobId,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+localStorage.getItem('token')}}).catch(function(e){console.log('Worker re-fire:',e.message);});
        }
      }
      if(j.status==='failed'){
        clearInterval(pollInterval);if(typing)typing.remove();
        progressWrap.classList.remove('on');progressFill.style.width='0%';
        var errEl=document.createElement('div');errEl.style.cssText='text-align:center;font-size:.78rem;color:var(--error);padding:.45rem;';
        errEl.textContent='\u26A0\uFE0F Tool error: '+(j.error||'Unknown error');msgsArea.appendChild(errEl);
        /* v5.5: Job failed \u2014 release the lock. */
        rtUnlock(toolName);
        return;
      }
      if(pollCount>360){
        clearInterval(pollInterval);if(typing)typing.remove();
        progressWrap.classList.remove('on');progressFill.style.width='0%';
        var toEl=document.createElement('div');toEl.style.cssText='text-align:center;font-size:.78rem;color:var(--warning);padding:.45rem;';
        toEl.textContent='Processing is taking longer than expected. Check History later for results.';msgsArea.appendChild(toEl);
        /* v5.5: Polling gave up — release the lock. */
        rtUnlock(toolName);
      }
    }catch(pollErr){console.log('Poll error:',pollErr.message);}
  },10000);
}

/* ── v4.4: RESUME IN-PROGRESS JOBS ON MATTER LOAD ────────────────────────── */
/* On matter load, query /api/jobs for any jobs in running/paused/synthesising
   state and resume polling for each. Opens the matching tool tab and hooks back
   into the shared progress bar. Called from selectMatter in core.js.
   If multiple jobs are in flight the progress bar shows the last one opened;
   each tool tab still reflects its own result when its job lands. */
async function resumeInProgressJobs(matterId){
  if(!matterId)return;
  /* v5.5: Reload runningTools state for the new matter from sessionStorage,
     then refresh button visuals. The server check below re-adds any jobs
     still actually in flight. */
  _rtLoad();
  updateToolButtonStates();
  try{
    var resp=await api('/api/jobs?matterId='+matterId);
    if(!resp||!resp.jobs||!resp.jobs.length)return;
    var active=resp.jobs.filter(function(j){
      return j.status==='running'||j.status==='paused'||j.status==='synthesising';
    });
    if(!active.length)return;
    console.log('v4.4 resuming '+active.length+' in-progress job(s) for matter '+matterId);
    var progressWrap=document.getElementById('progressWrap');
    var progressLabel=document.getElementById('progressLabel');
    var progressFill=document.getElementById('progressFill');
    active.forEach(function(job){
      var toolName=job.tool_name||job.toolName;
      if(!toolName||!toolDefs[toolName]){
        console.log('v4.4 skipping job '+job.id+' \u2014 unknown tool name:',toolName);
        return;
      }
      /* v5.5: Re-assert the lock for the resumed tool. */
      rtLock(toolName);
      var toolLabel=toolDefs[toolName].title;
      getOrCreateToolTab(toolName);
      var msgsArea=showToolResult(toolName);
      progressWrap.classList.add('on');
      progressLabel.textContent='Resuming '+toolLabel+'\u2026';
      progressFill.style.width='10%';
      var typing=document.createElement('div');
      typing.className='msg msg-assistant msg-tool';
      typing.innerHTML='<div class="typing-bubble"><span></span><span></span><span></span></div>';
      msgsArea.appendChild(typing);msgsArea.scrollTop=msgsArea.scrollHeight;
      startPollingJob(job.id,toolName,toolLabel,'(resumed)',msgsArea,progressWrap,progressLabel,progressFill,typing);
    });
  }catch(e){
    console.log('v4.4 resumeInProgressJobs error:',e.message);
  }
}

/* ── SOURCE PANEL ─────────────────────────────────────────────────────────── */
async function openSourcePanel(docName,contextText,chunkIdx){
  document.getElementById('sourcePanelTitle').textContent=docName;
  var body=document.getElementById('sourcePanelBody');
  body.innerHTML='<div style="color:var(--text-faint);font-size:.88rem;font-style:italic;padding:.5rem 0">Loading passages\u2026</div>';
  document.getElementById('sourcePanel').classList.add('open');
  try{
    var tok=token||localStorage.getItem('elj_token');
    var resp=await fetch('/api/documents?matter_id='+currentMatter.id+'&doc_name='+encodeURIComponent(docName),{headers:{'Authorization':'Bearer '+tok}});
    var d=await resp.json();
    var chunks=d.chunks||[];
    if(!chunks.length){body.innerHTML='<div style="color:var(--text-faint);font-size:.88rem">No passages found for this document.</div>';return;}
    window._sourceChunks=chunks;
    window._sourceChunkIdx=typeof chunkIdx==='number'?Math.min(chunkIdx,chunks.length-1):0;
    renderSourceChunks(docName);
  }catch(e){body.innerHTML='<div style="color:var(--text-faint);font-size:.88rem">Could not load passages: '+esc(e.message)+'</div>';}
}
function renderSourceChunks(docName){
  var body=document.getElementById('sourcePanelBody');
  var chunks=window._sourceChunks||[];
  var idx=window._sourceChunkIdx||0;
  var start=Math.max(0,idx-1);
  var end=Math.min(chunks.length,idx+4);
  var navHtml='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.6rem;padding-bottom:.4rem;border-bottom:1px solid var(--border)">';
  navHtml+='<button style="border:1px solid var(--border);border-radius:4px;padding:2px 10px;cursor:pointer;background:var(--white)" onclick="sourceNav(-5)"'+(start<=0?' disabled':'')+'>◀ Earlier</button>';
  navHtml+='<span style="font-size:.75rem;color:var(--text-faint)">Chunks '+(start+1)+'–'+end+' of '+chunks.length+'</span>';
  navHtml+='<button style="border:1px solid var(--border);border-radius:4px;padding:2px 10px;cursor:pointer;background:var(--white)" onclick="sourceNav(5)"'+(end>=chunks.length?' disabled':'')+'>Later ▶</button>';
  navHtml+='</div>';
  var passagesHtml='';
  for(var i=start;i<end;i++){
    var c=chunks[i];var isTarget=i===idx;
    passagesHtml+='<div class="source-passage" style="margin-bottom:.8rem;padding:.6rem;border-radius:5px;border:1px solid '+(isTarget?'var(--blue-light)':'var(--border)')+';background:'+(isTarget?'var(--blue-faint)':'var(--white)')+'"><div style="font-size:.7rem;font-weight:700;color:var(--text-faint);margin-bottom:.3rem">\u00B6 '+(c.chunk_index!==undefined?c.chunk_index+1:i+1)+'</div><div style="font-size:.84rem;line-height:1.6;white-space:pre-wrap">'+esc(c.content)+'</div></div>';
  }
  body.innerHTML='<div class="source-doc-label" style="font-weight:700;margin-bottom:.5rem">'+esc(docName)+'</div>'+navHtml+passagesHtml;
}
function sourceNav(delta){window._sourceChunkIdx=Math.max(0,Math.min((window._sourceChunks||[]).length-1,(window._sourceChunkIdx||0)+delta));renderSourceChunks(document.getElementById('sourcePanelTitle').textContent);}
function closeSourcePanel(){document.getElementById('sourcePanel').classList.remove('open');}

/* ── FIND REFERENCES ─────────────────────────────────────────────────────── */
async function findReferences(bubble,toolName){
  var editedText=bubble.innerText||bubble.textContent;
  if(!editedText||!currentMatter)return;
  showToast('Finding references for edited text…');
  try{
    var d=await api('/api/analyse','POST',{matterId:currentMatter.id,matterName:currentMatter.name,matterNature:currentMatter.nature||'',matterIssues:currentMatter.issues||'',messages:[{role:'user',content:'For each statement in the following edited text that is NOT already attributed to a source document, search the matter documents and add a source reference if one exists. Return the full text with source references added in the format *(Source: [Document Name])*. If no source exists for a statement, leave it unchanged.\n\nEDITED TEXT:\n'+editedText}],jurisdiction:jurisdiction,queryType:'Factual Analysis',focusAreas:[]});
    if(d&&d.result){appendMsg('assistant',d.result,'tool','References found for edited text');await saveHistory('Find references (edited text)',d.result,toolName||'tool');}
  }catch(e){showToast('Error: '+e.message);}
}

/* ── BUNDLE INDEX ────────────────────────────────────────────────────────── */
async function showBundleIndex(referencedDocs){
  if(!currentMatter)return;
  document.getElementById('bundleModalTitle').textContent='Document Bundle — '+currentMatter.name;
  var body=document.getElementById('bundleModalBody');
  body.innerHTML='<div style="color:var(--text-faint);font-size:.88rem;font-style:italic">Generating bundle index…</div>';
  document.getElementById('bundleModal').style.display='flex';
  try{
    var allDocs=documents.length?documents:(await api('/api/documents?matter_id='+currentMatter.id)).documents||[];
    var docsToList=referencedDocs&&referencedDocs.length?allDocs.filter(function(d){return referencedDocs.some(function(r){return d.name.toLowerCase().indexOf(r.toLowerCase())!==-1||r.toLowerCase().indexOf(d.name.toLowerCase())!==-1;});}):allDocs;
    if(!docsToList.length){body.innerHTML='<div style="color:var(--text-faint);font-size:.88rem">No documents found.</div>';return;}
    var docList=docsToList.map(function(d){return d.name+' ['+d.doc_type+']'+(d.chunk_count?' ('+d.chunk_count+' passages)':'');}).join('\n');
    var d2=await api('/api/analyse','POST',{matterId:currentMatter.id,matterName:currentMatter.name,matterNature:currentMatter.nature||'',matterIssues:currentMatter.issues||'',messages:[{role:'user',content:'Produce a document bundle index for the matter "'+currentMatter.name+'". For each document, provide: 1. A sequential bundle number 2. The document name 3. The document type 4. A one-line description 5. The approximate date if determinable. Sort chronologically. Return as a JSON array with fields: num, name, type, description, date.\n\nDOCUMENTS:\n'+docList}],jurisdiction:jurisdiction,queryType:'Factual Analysis',focusAreas:[]});
    var rows=[];
    try{var raw=d2.result.replace(/```json|```/g,'').trim();var s=raw.indexOf('[');var e2=raw.lastIndexOf(']');rows=JSON.parse(raw.slice(s,e2+1));}
    catch(pe){rows=docsToList.map(function(doc,i){return {num:i+1,name:doc.name,type:doc.doc_type,description:'',date:''};});}
    body.innerHTML='<table class="bundle-table"><thead><tr><th>#</th><th>Document</th><th>Type</th><th>Description</th><th>Date</th></tr></thead><tbody>'+rows.map(function(r){return '<tr><td>'+(r.num||'')+'</td><td>'+esc(r.name||'')+'</td><td>'+esc(r.type||'')+'</td><td>'+esc(r.description||'')+'</td><td>'+esc(r.date||'')+'</td></tr>';}).join('')+'</tbody></table>';
    document.getElementById('bundleDownloadBtn').onclick=function(){var content='# Document Bundle Index\n**Matter:** '+currentMatter.name+'\n**Jurisdiction:** '+jurisdiction+'\n\n'+rows.map(function(r){return r.num+'. **'+r.name+'** ['+r.type+']\n   '+r.description+(r.date?' — '+r.date:'');}).join('\n\n');downloadWord(content,'Bundle Index — '+currentMatter.name);};
  }catch(e2){body.innerHTML='<div style="color:var(--error);font-size:.88rem">Error: '+esc(e2.message)+'</div>';}
}

/* ── TOOL HISTORY BAR ────────────────────────────────────────────────────── */
function getToolHistory(toolName){if(!currentMatter)return[];return matterHistory.filter(function(h){return h.tool_name===toolName;}).slice().reverse();}
function renderToolHistoryBar(toolName,historyId){
  var bar=document.createElement('div');bar.className='tool-history-bar';
  var hist=getToolHistory(toolName);if(!hist.length)return bar;
  var toggle=document.createElement('button');toggle.className='tool-history-toggle';
  var toolLabel=toolDefs[toolName]?toolDefs[toolName].title.replace(/^[^\w]*/,'').split(' ').slice(0,2).join(' '):toolName;
  toggle.textContent='\uD83D\uDCC2 Previous '+hist.length+' run'+(hist.length!==1?'s':'')+' of '+toolLabel;
  var list=document.createElement('div');list.className='tool-history-list';
  hist.forEach(function(h){
    if(h.id===historyId)return;
    var item=document.createElement('div');item.className='tool-hist-item';
    var lbl=document.createElement('div');lbl.className='tool-hist-label';lbl.textContent=h.question.slice(0,70)+(h.question.length>70?'\u2026':'');
    var dt=document.createElement('div');dt.className='tool-hist-date';dt.textContent=new Date(h.created_at).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'2-digit'});
    var actions=document.createElement('div');actions.className='tool-hist-actions';
    var wordBtn=document.createElement('button');wordBtn.className='tool-hist-btn';wordBtn.textContent='\u2B07 Word';
    wordBtn.addEventListener('click',function(e){e.stopPropagation();downloadWord(h.answer,h.question||currentMatter.name);});
    var delBtn=document.createElement('button');delBtn.className='tool-hist-del';delBtn.textContent='\u00D7';delBtn.title='Delete';
    delBtn.addEventListener('click',function(e){e.stopPropagation();if(!confirm('Delete this saved result?'))return;api('/api/history?id='+h.id,'DELETE').then(function(){loadHistory(currentMatter.id);item.remove();showToast('Deleted');}).catch(function(err){showToast('Error: '+err.message);});});
    actions.appendChild(wordBtn);actions.appendChild(delBtn);
    item.appendChild(lbl);item.appendChild(dt);item.appendChild(actions);
    item.addEventListener('click',function(){var area=getActiveMessagesArea();area.innerHTML='';appendMsgTo(area,'assistant',h.answer,'tool',h.question,null,h.tool_name,h.id);list.classList.remove('open');});
    list.appendChild(item);
  });
  toggle.addEventListener('click',function(){list.classList.toggle('open');});
  bar.appendChild(toggle);bar.appendChild(list);
  return bar;
}


/* ── ISSUE BRIEFING ─────────────────────────────────────────────────────── */
var issueBriefingSourceText='';

function parseIssuesFromText(text){
  /* Parse issues from Issue Tracker output. Looks for patterns like:
     ### Issue 1: Description
     ### Issue [N]: Description
     ### [N]. Description  */
  var issues=[];
  var patterns=[
    /###\s*Issue\s*\[?\d+\]?\s*[:.]\s*(.+)/gi,
    /###\s*\d+\.\s*(.+)/gi,
    /###\s*Issue:\s*(.+)/gi,
  ];
  for(var pi=0;pi<patterns.length;pi++){
    var matches=text.matchAll(patterns[pi]);
    for(var m of matches){
      var desc=m[1].trim().replace(/\*\*/g,'');
      if(desc&&issues.indexOf(desc)===-1)issues.push(desc);
    }
    if(issues.length>0)break;
  }
  /* Fallback: look for bold issue descriptions */
  if(issues.length===0){
    var boldMatches=text.matchAll(/\*\*Issue[:\s]+(.+?)\*\*/gi);
    for(var bm of boldMatches){
      var bdesc=bm[1].trim();
      if(bdesc&&issues.indexOf(bdesc)===-1)issues.push(bdesc);
    }
  }
  return issues;
}

function showIssueBriefingModal(issuesText){
  if(!currentMatter){showToast('Select a matter first');return;}
  issueBriefingSourceText=issuesText;
  var issues=parseIssuesFromText(issuesText);
  var list=document.getElementById('issueBriefingList');
  if(issues.length===0){
    list.innerHTML='<div style="padding:.75rem;color:var(--text-faint);font-size:.88rem;font-style:italic">No issues could be parsed from the Issue Tracker output. You can type the issues manually in the instructions box below.</div>';
  }else{
    list.innerHTML=issues.map(function(iss,idx){
      return '<label class="anchor-item"><input type="checkbox" checked value="'+esc(iss)+'"> <span style="font-weight:700;color:var(--navy);margin-right:.3rem">'+(idx+1)+'.</span> '+esc(iss)+'</label>';
    }).join('');
  }
  document.getElementById('issueBriefingInstructions').value='';
  document.getElementById('issueBriefingModal').style.display='flex';
}

document.getElementById('issueBriefingRunBtn').addEventListener('click',function(){
  var selected=[];
  document.querySelectorAll('#issueBriefingList input:checked').forEach(function(cb){selected.push(cb.value);});
  var extraInstructions=document.getElementById('issueBriefingInstructions').value.trim();
  if(selected.length===0&&!extraInstructions){showToast('Select at least one issue or provide instructions');return;}
  closeModal('issueBriefingModal');
  runIssueBriefing(selected,extraInstructions);
});

async function runIssueBriefing(selectedIssues,extraInstructions){
  if(!currentMatter)return;
  /* v5.5: Lock the issueBriefing slot. */
  if(rtIsLocked('issueBriefing')){showToast('Issue Briefing is already running — please wait');return;}
  rtLock('issueBriefing');
  var toolName='issueBriefing';
  var toolLabel='Issue Briefing';
  var instructions=extraInstructions||selectedIssues.join('; ');

  /* Create/switch to the issueBriefing tab */
  getOrCreateToolTab(toolName);
  var msgsArea=showToolResult(toolName);
  var progressWrap=document.getElementById('progressWrap');
  var progressLabel=document.getElementById('progressLabel');
  var progressFill=document.getElementById('progressFill');
  progressWrap.classList.add('on');
  progressLabel.textContent='Submitting '+toolLabel+'\u2026';
  progressFill.style.width='5%';

  var typing=document.createElement('div');typing.className='msg msg-assistant msg-tool';typing.innerHTML='<div class="typing-bubble"><span></span><span></span><span></span></div>';msgsArea.appendChild(typing);msgsArea.scrollTop=msgsArea.scrollHeight;

  try{
    var excludeDocNames=[];
    try{excludeDocNames=getExcludedDocNames();}catch(e){}
    /* v5.0: resolve folder filter → include names. Returns null in "All" mode. */
    var includeDocNames=null;
    try{includeDocNames=resolveIncludeDocNames();}catch(e){}

    var body={
      tool:toolName,
      matterId:currentMatter.id,
      matterName:currentMatter.name,
      matterNature:currentMatter.nature||'',
      matterIssues:currentMatter.issues||'',
      actingFor:currentMatter.acting_for||'',
      jurisdiction:jurisdiction,
      instructions:instructions,
      excludeDocNames:excludeDocNames,
      selectedIssues:selectedIssues,
      issuesText:issueBriefingSourceText.slice(0,15000)
    };
    if(includeDocNames&&includeDocNames.length>0)body.includeDocNames=includeDocNames;

    var d=await api('/api/tools','POST',body);
    if(!d||!d.jobId)throw new Error('No jobId returned');
    progressLabel.textContent='Processing '+toolLabel+'\u2026 (you can close your laptop \u2014 processing continues in the background)';
    progressFill.style.width='10%';

    var jobId=d.jobId;var pollCount=0;
    /* v4.2k: Frontend over-firing fix. See first polling loop for explanation. */
    var lastFireStatus=null;
    var lastFireTime=0;
    var FIRE_COOLDOWN_MS=180000;
    var pollInterval=setInterval(async function(){
      try{
        pollCount++;
        var j=await api('/api/jobs?id='+jobId);
        if(!j)return;
        if(j.batchesTotal>0&&j.batchesDone>0){
          var pct=Math.min(10+Math.round((j.batchesDone/j.batchesTotal)*80),90);
          progressFill.style.width=pct+'%';
          progressLabel.textContent='Processing '+toolLabel+'\u2026 batch '+j.batchesDone+' of '+j.batchesTotal;
        }
        if(j.status==='complete'||j.status==='partial'){
          clearInterval(pollInterval);typing.remove();
          progressFill.style.width='100%';
          setTimeout(function(){progressWrap.classList.remove('on');progressFill.style.width='0%';},800);
          /* v5.5: Job complete (issueBriefing) — release the lock. */
          rtUnlock(toolName);
          if(j.result){
            var costStr=j.usage&&j.usage.costUsd?' \u00B7 $'+j.usage.costUsd.toFixed(4):'';
            await loadHistory(currentMatter.id);
            var latestH=matterHistory.find(function(h){return h.tool_name===toolName;});
            var hId=latestH?latestH.id:null;
            appendMsgTo(msgsArea,'assistant',j.result,'tool',toolLabel+': '+instructions.slice(0,60),costStr,toolName,hId);
          }else{
            var noRes=document.createElement('div');noRes.style.cssText='text-align:center;font-size:.78rem;color:var(--text-faint);padding:.45rem;';
            noRes.textContent='Tool completed but returned no result.';msgsArea.appendChild(noRes);
          }
          return;
        }
        /* v4.2e: Worker paused or ready for synthesis — re-fire worker from frontend */
        /* v4.2k: Only fire if status changed since last fire OR cooldown elapsed */
        if(j.status==='paused'||j.status==='synthesising'){
          if(j.status==='synthesising'){
            progressLabel.textContent='Synthesising '+toolLabel+'\u2026';
            progressFill.style.width='95%';
          }else{
            progressLabel.textContent='Resuming '+toolLabel+'\u2026 batch '+j.batchesDone+' of '+j.batchesTotal;
          }
          var nowMs2=Date.now();
          var statusChanged2=(j.status!==lastFireStatus);
          var cooldownElapsed2=(nowMs2-lastFireTime>FIRE_COOLDOWN_MS);
          if(statusChanged2||cooldownElapsed2){
            console.log('v4.2k re-fire worker:',j.status,statusChanged2?'(status changed)':'(cooldown elapsed)');
            lastFireStatus=j.status;
            lastFireTime=nowMs2;
            fetch('/api/worker?jobId='+jobId,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+localStorage.getItem('token')}}).catch(function(e){console.log('Worker re-fire:',e.message);});
          }
        }
        if(j.status==='failed'){
          clearInterval(pollInterval);typing.remove();
          progressWrap.classList.remove('on');progressFill.style.width='0%';
          var errEl=document.createElement('div');errEl.style.cssText='text-align:center;font-size:.78rem;color:var(--error);padding:.45rem;';
          errEl.textContent='\u26A0\uFE0F Error: '+(j.error||'Unknown error');msgsArea.appendChild(errEl);
          /* v5.5: Job failed (issueBriefing) \u2014 release the lock. */
          rtUnlock(toolName);
          return;
        }
        if(pollCount>360){
          clearInterval(pollInterval);typing.remove();
          progressWrap.classList.remove('on');progressFill.style.width='0%';
          var toEl=document.createElement('div');toEl.style.cssText='text-align:center;font-size:.78rem;color:var(--warning);padding:.45rem;';
          toEl.textContent='Processing is taking longer than expected. Check History later for results.';msgsArea.appendChild(toEl);
          /* v5.5: Polling gave up (issueBriefing) — release the lock. */
          rtUnlock(toolName);
        }
      }catch(pollErr){console.log('Poll error:',pollErr.message);}
    },10000);
  }catch(e){
    typing.remove();progressWrap.classList.remove('on');progressFill.style.width='0%';
    /* v5.5: Job never started \u2014 release the issueBriefing lock. */
    rtUnlock('issueBriefing');
    var errEl2=document.createElement('div');errEl2.style.cssText='text-align:center;font-size:.78rem;color:var(--error);padding:.45rem;';
    errEl2.textContent='\u26A0\uFE0F Error: '+e.message;msgsArea.appendChild(errEl2);
  }
}

