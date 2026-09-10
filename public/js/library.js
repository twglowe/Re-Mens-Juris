/* v5.50 — 30 Aug 2026: the Case Type / Procedural Stage / Document Type
   dropdowns are back in the precedent panel. They were dropped when the
   panel was rebuilt, leaving libBoxCaseTypeChanged/libBoxStageChanged as
   empty stubs and libSavePrecedentChanges sending no classification at
   all — so a precedent's Case Type was fixed at upload and could never be
   changed. api/library.js already accepts case_type_id, subcat_id and
   doc_type_id on update_precedent; no backend change needed. */
/* ── LIBRARY ──────────────────────────────────────────────────────────────── */
/* v5.38 — 02 Jul 2026: quickAddSave — when Quick Add is used from the
   Draft tab, the Draft tab's Case Type takes priority for attaching a new
   stage/doc type (previously the Library tab's search filter silently
   won), and the new item is selected in the relevant Draft dropdown after
   saving. Companion change: drafting.js libPopulateDraftSelects preserves
   selections across library reloads. */
/* v5.12b: matter-document index indicator state machine. Lives at the top of
   the Library left panel above the Precedent search. The whole thing is
   driven by the status returned by GET /api/index-library?action=status,
   which gives us {total, indexed_relevant, indexed_not_relevant, failed,
   unindexed, failures}.

   Five visible states, mapped from the status fields:
     A — total > 0 AND no fingerprints at all                  (cold)
     B — _indexingInProgress flag set client-side              (running)
     C — unindexed > 0 AND some fingerprints exist             (caught up + new)
     D — unindexed === 0 AND failed === 0 AND total > 0        (fully indexed)
     E — failed > 0                                            (has failures)

   v5.12b changes:
     - Status response splits "fingerprinted" into indexed_relevant +
       indexed_not_relevant. Both still count as "indexed" toward the user.
     - Failed-row list gains per-row Retry and "Mark not relevant" links.
     - When a user marks a document not relevant, it moves out of the
       failed bucket into indexed_not_relevant, the warning clears, and
       the AI hunt (Build 3) ignores rows where is_relevant=false.

   Polling: while state B is active, poll every 4 seconds. */

var _libIndexState = { total: 0, indexed_relevant: 0, indexed_not_relevant: 0, failed: 0, unindexed: 0, failures: [] };
var _libIndexInProgress = false;
var _libIndexPollTimer = null;
var _libIndexFailuresExpanded = false;
var _libIndexBusyDocId = null; /* doc id currently being retried/marked, if any */

async function libIndexLoadStatus(){
  if(!token)return null;
  try{
    var resp=await api('/api/index-library?action=status');
    if(resp&&resp.status){
      _libIndexState=resp.status;
      libIndexRender();
      return resp.status;
    }
  }catch(e){
    console.error('libIndexLoadStatus error:',e);
  }
  return null;
}

function libIndexRender(){
  var wrap=document.getElementById('libIndexIndicator');
  if(!wrap)return;
  var s=_libIndexState;
  /* "indexed" from the user's perspective = relevant + not_relevant */
  var indexed=(s.indexed_relevant||0)+(s.indexed_not_relevant||0);
  var html='';

  if(_libIndexInProgress){
    /* State B — in progress */
    var done=indexed+s.failed;
    var pct=s.total>0?Math.round((done/s.total)*100):0;
    html='<div class="lib-index-block lib-index-info">'
      +'<div class="lib-index-row"><span class="lib-index-title">Matter document index</span><span class="lib-index-count">'+done+' of '+s.total+'</span></div>'
      +'<div class="lib-index-progress"><div class="lib-index-progress-fill" style="width:'+pct+'%"></div></div>'
      +'<div class="lib-index-explain">Indexing\u2026 You can keep using the app. This window updates every few seconds.</div>'
      +'</div>';
  }else if(s.total===0){
    wrap.innerHTML='';
    wrap.style.display='none';
    return;
  }else if(s.failed>0){
    /* State E — has failures */
    var detailHtml='';
    if(_libIndexFailuresExpanded&&s.failures&&s.failures.length){
      var items=s.failures.map(function(f){
        var busy=(_libIndexBusyDocId===f.document_id);
        var actions=busy
          ?'<span class="lib-index-fail-busy">working\u2026</span>'
          :('<button class="lib-index-fail-btn" onclick="libIndexRetryOne(\''+f.document_id+'\')">Retry</button>'
            +'<button class="lib-index-fail-btn lib-index-fail-btn-grey" onclick="libIndexMarkNotRelevant(\''+f.document_id+'\')">Mark not relevant</button>');
        return '<div class="lib-index-fail-item">'
          +'<div class="lib-index-fail-name">'+esc(f.document_name||'(unknown)')+'</div>'
          +'<div class="lib-index-fail-reason">'+esc(f.reason||'Unknown reason.')+'</div>'
          +'<div class="lib-index-fail-matter">Matter: '+esc(f.matter_name||'(unknown)')+'</div>'
          +'<div class="lib-index-fail-actions">'+actions+'</div>'
          +'</div>';
      }).join('');
      detailHtml='<div class="lib-index-fail-list">'+items+'</div>';
    }
    var unindexedPlusFailed=s.failed+s.unindexed;
    var btnLabel=s.unindexed>0?('Index '+unindexedPlusFailed+' documents'):('Retry '+s.failed+' failed');
    html='<div class="lib-index-block lib-index-warning">'
      +'<div class="lib-index-row"><span class="lib-index-title">Matter document index</span><span class="lib-index-count">'+indexed+' indexed \u00b7 '+s.failed+' failed</span></div>'
      +detailHtml
      +'<div class="lib-index-actions">'
      +'<button class="lib-index-btn-primary" onclick="libIndexStart('+(s.unindexed>0?'false':'true')+')">'+btnLabel+'</button>'
      +'<button class="lib-index-btn-link" onclick="libIndexToggleFailures()">'+(_libIndexFailuresExpanded?'Hide details':'Show details')+'</button>'
      +'</div>'
      +'</div>';
  }else if(s.unindexed===0){
    /* State D — fully indexed (relevant + not_relevant both count) */
    var notRelSuffix=s.indexed_not_relevant>0?(' <span class="lib-index-notrel">('+s.indexed_not_relevant+' marked not relevant)</span>'):'';
    html='<div class="lib-index-block lib-index-quiet">'
      +'<div class="lib-index-row"><span class="lib-index-title">Matter document index</span><span class="lib-index-count lib-index-success-text">All '+s.total+' indexed'+notRelSuffix+'</span></div>'
      +'</div>';
  }else if(indexed===0){
    /* State A — cold start */
    html='<div class="lib-index-block lib-index-info">'
      +'<div class="lib-index-row"><span class="lib-index-title">Matter document index</span><span class="lib-index-count">0 of '+s.total+'</span></div>'
      +'<div class="lib-index-explain">Indexing your matter documents lets the AI find structural precedents from your own work when drafting.</div>'
      +'<button class="lib-index-btn-primary" onclick="libIndexStart(false)">Index '+s.total+' documents</button>'
      +'</div>';
  }else{
    /* State C — caught up with new docs */
    html='<div class="lib-index-block lib-index-quiet">'
      +'<div class="lib-index-row"><span class="lib-index-title">Matter document index</span><span class="lib-index-count">'+indexed+' of '+s.total+'</span></div>'
      +'<button class="lib-index-btn-secondary" onclick="libIndexStart(false)">Index '+s.unindexed+' new document'+(s.unindexed===1?'':'s')+'</button>'
      +'</div>';
  }
  wrap.innerHTML=html;
  wrap.style.display='block';
}

function libIndexToggleFailures(){
  _libIndexFailuresExpanded=!_libIndexFailuresExpanded;
  libIndexRender();
}

async function libIndexStart(retryFailed){
  if(_libIndexInProgress)return;
  _libIndexInProgress=true;
  _libIndexFailuresExpanded=false;
  libIndexRender();
  if(_libIndexPollTimer)clearInterval(_libIndexPollTimer);
  _libIndexPollTimer=setInterval(libIndexLoadStatus,4000);
  try{
    var endpoint='/api/index-library';
    var body={action:retryFailed?'retry':'index'};
    if(retryFailed)body.retryFailed=true;
    await api(endpoint,'POST',body);
  }catch(e){
    console.error('libIndexStart error:',e);
    showToast('Indexing error: '+e.message);
  }finally{
    _libIndexInProgress=false;
    if(_libIndexPollTimer){clearInterval(_libIndexPollTimer);_libIndexPollTimer=null;}
    await libIndexLoadStatus();
  }
}

/* v5.12b: per-row Retry — try a single failed document again. */
async function libIndexRetryOne(documentId){
  if(_libIndexBusyDocId)return;
  _libIndexBusyDocId=documentId;
  libIndexRender();
  try{
    var resp=await api('/api/index-library','POST',{action:'retry_one',documentId:documentId});
    if(resp&&resp.ok){
      showToast('Retried successfully');
    }else{
      showToast('Still failed: '+((resp&&resp.reason)||'try again later'));
    }
  }catch(e){
    showToast('Retry error: '+e.message);
  }finally{
    _libIndexBusyDocId=null;
    await libIndexLoadStatus();
  }
}

/* v5.12b: per-row Mark not relevant — flip the row to indexed-but-not-
   relevant so the AI hunt ignores it and the count reconciles. */
async function libIndexMarkNotRelevant(documentId){
  if(_libIndexBusyDocId)return;
  if(!confirm('Mark this document as not relevant for AI drafting?\n\nIt will still appear in your matter, but the AI will not consider it as a precedent when drafting from other matters. You can change your mind later by re-uploading the document.'))return;
  _libIndexBusyDocId=documentId;
  libIndexRender();
  try{
    var resp=await api('/api/index-library','POST',{action:'mark_not_relevant',documentId:documentId});
    if(resp&&resp.ok){
      showToast('Marked not relevant');
    }else{
      showToast('Could not mark: '+((resp&&resp.error)||'unknown error'));
    }
  }catch(e){
    showToast('Error: '+e.message);
  }finally{
    _libIndexBusyDocId=null;
    await libIndexLoadStatus();
  }
}

async function loadLibrary(){
  if(!token)return;
  try{
    var results=await Promise.all([api('/api/library?type=case_types'),api('/api/library?type=subcats'),api('/api/library?type=doc_types'),api('/api/library?type=precedents'),api('/api/library?type=sections'),api('/api/library?type=legislation'),api('/api/library?type=case_law_subjects'),api('/api/library?type=case_law')]);
    libraryData.caseTypes=results[0].data||[];
    libraryData.subcats=results[1].data||[];
    libraryData.docTypes=results[2].data||[];
    libraryData.precedents=results[3].data||[];
    libraryData.sections=results[4].data||[];
    libraryData.legislation=results[5].data||[];
    /* v5.56 Push B: case law subjects and entries */
    libraryData.caseLawSubjects=results[6].data||[];
    libraryData.caseLaw=results[7].data||[];
    legRender();
    clRender();
    /* v5.59 Push C: the Draft tab's case law box reads libraryData too. */
    if(typeof draftClRender==='function')draftClRender();
    libPopulateSearchFilters();
    libFilterSearch();
    libPopulateDraftSelects();
    /* v5.12a: refresh the matter-document index status indicator */
    libIndexLoadStatus();
  }catch(e){console.error('Library load error:',e);}
}

function libPopulateSearchFilters(){
  var ct=document.getElementById('libSearchCaseType');
  var st=document.getElementById('libSearchStage');
  var dt=document.getElementById('libSearchDocType');
  if(!ct)return;
  var prevCt=ct.value,prevSt=st.value,prevDt=dt.value;
  ct.innerHTML='<option value="">All case types</option>'+libraryData.caseTypes.map(function(c){return '<option value="'+c.id+'">'+esc(c.name)+'</option>';}).join('');
  st.innerHTML='<option value="">All stages</option>'+libraryData.subcats.map(function(s){return '<option value="'+s.id+'">'+esc(s.name)+'</option>';}).join('');
  dt.innerHTML='<option value="">All doc types</option>'+libraryData.docTypes.map(function(d){return '<option value="'+d.id+'">'+esc(d.name)+'</option>';}).join('');
  if(prevCt)ct.value=prevCt;
  if(prevSt)st.value=prevSt;
  if(prevDt)dt.value=prevDt;
}

function libFilterSearch(){
  var container=document.getElementById('libSearchResults');
  if(!container)return;
  var q=(document.getElementById('libSearchInput')?document.getElementById('libSearchInput').value:'').toLowerCase();
  var fct=document.getElementById('libSearchCaseType')?document.getElementById('libSearchCaseType').value:'';
  var fst=document.getElementById('libSearchStage')?document.getElementById('libSearchStage').value:'';
  var fdt=document.getElementById('libSearchDocType')?document.getElementById('libSearchDocType').value:'';
  var filtered=libraryData.precedents.filter(function(p){
    if(q&&p.name.toLowerCase().indexOf(q)===-1)return false;
    if(fct&&p.case_type_id!==fct)return false;
    if(fst&&p.subcategory_id!==fst&&p.subcat_id!==fst)return false;
    if(fdt&&p.doc_type_id!==fdt)return false;
    return true;
  });
  if(!filtered.length){container.innerHTML='<div class="empty-state" style="padding:1rem">No matching precedents.</div>';return;}
  container.innerHTML=filtered.map(function(p){
    var ctName='';var ct=libraryData.caseTypes.find(function(c){return c.id===p.case_type_id;});if(ct)ctName=ct.name;
    return '<div class="lib-search-item'+(selectedPrecedentId===p.id?' active':'')+'" onclick="libSelectPrecedent(\''+p.id+'\')">'
      +'<div>'+esc(p.name)+'</div>'
      +'<div class="lib-search-item-meta">'+(ctName?esc(ctName):'')+(p.jurisdiction?' · '+esc(p.jurisdiction):'')+'</div>'
      +'</div>';
  }).join('');
}

function libSelectPrecedent(id){
  selectedPrecedentId=id;
  var p=libraryData.precedents.find(function(x){return x.id===id;});
  if(!p)return;
  /* Show the panel */
  document.getElementById('libLandingState').style.display='none';
  var wrap=document.getElementById('libBoxesWrap');wrap.style.display='flex';
  document.getElementById('libSelectedDocName').textContent=p.name;
  /* v5.50: Case Type / Stage / Doc Type moved out of this read-only line and
     into the editable Classification box below. Jurisdiction stays here. */
  document.getElementById('libPrecMeta').textContent=p.jurisdiction?('Jurisdiction: '+p.jurisdiction):'';
  libPopulateClassification(p);
  /* Context */
  document.getElementById('libContextExplanation').value=p.context_relationship||'';
  /* v5.65: show the matter this precedent came from, so it can be set or
     corrected on an entry uploaded before the field existed. */
  libPopulateMatterSelect('libSourceMatter',p.source_matter_id||'');
  /* v5.66: the editable name. */
  var nameBox=document.getElementById('libPrecName');
  if(nameBox)nameBox.value=p.name||'';
  var nameHint=document.getElementById('libPrecNameHint');
  if(nameHint)nameHint.style.display='none';
  /* Commentary */
  document.getElementById('libCommentary').value=p.commentary||'';
  document.getElementById('libIsOwnDoc').checked=!!p.is_own_style;
  document.getElementById('libAiInstructions').value=p.ai_instructions||'';
  /* Update search highlight */
  libFilterSearch();
}

/* v5.50: fill the Classification dropdowns from the selected precedent. A
   leading blank option means an unrecognised or missing case_type_id shows as
   "— Select —" rather than silently reading as the first case type. */
function libPopulateClassification(p){
  var ctSel=document.getElementById('libBoxCaseType');
  if(!ctSel)return;
  ctSel.innerHTML='<option value="">— Select —</option>'+libraryData.caseTypes.map(function(c){return '<option value="'+c.id+'">'+esc(c.name)+'</option>';}).join('');
  ctSel.value=p.case_type_id||'';
  libBoxCaseTypeChanged();
  var stSel=document.getElementById('libBoxStage');
  var subId=p.subcategory_id||p.subcat_id||'';
  if(stSel)stSel.value=subId||'';
  var dtSel=document.getElementById('libBoxDocType');
  if(dtSel)dtSel.value=p.doc_type_id||'';
}
/* v5.50: repopulate Stage and Doc Type for the chosen Case Type. Was an empty
   stub while the dropdowns did not exist. */
function libBoxCaseTypeChanged(){
  var ctSel=document.getElementById('libBoxCaseType');
  if(!ctSel)return;
  var ctId=ctSel.value;
  var stSel=document.getElementById('libBoxStage');
  var dtSel=document.getElementById('libBoxDocType');
  if(stSel)stSel.innerHTML='<option value="">— None —</option>'+libraryData.subcats.filter(function(s){return s.case_type_id===ctId;}).map(function(s){return '<option value="'+s.id+'">'+esc(s.name)+'</option>';}).join('');
  if(dtSel)dtSel.innerHTML='<option value="">— None —</option>'+libraryData.docTypes.filter(function(d){return d.case_type_id===ctId;}).map(function(d){return '<option value="'+d.id+'">'+esc(d.name)+'</option>';}).join('');
}
function libBoxStageChanged(){}

async function libSavePrecedentChanges(){
  if(!selectedPrecedentId){showToast('No precedent selected');return;}
  /* v5.50: classification travels with the save again. */
  var ctSel=document.getElementById('libBoxCaseType');
  var stSel=document.getElementById('libBoxStage');
  var dtSel=document.getElementById('libBoxDocType');
  if(ctSel&&!ctSel.value){showToast('Select a Case Type before saving');return;}
  try{
    /* v5.66: renaming gets the same challenge as naming — the Precedent
       Library holds templates, and a matter name makes one unfindable. */
    var newName=(document.getElementById('libPrecName')||{}).value||'';
    newName=newName.trim();
    if(!newName){showToast('Give the precedent a name');return;}
    var nameClash=libMatchingMatterName(newName);
    if(nameClash&&!confirm('"'+newName+'" looks like your matter "'+nameClash+'".\n\nThe Precedent Library holds reusable templates. Which matter this came from is recorded separately, so the name is free to describe the document — "Skeleton Argument — unfair prejudice" rather than the case.\n\nSave it under this name anyway?'))return;
    var payload={
      action:'update_precedent',
      id:selectedPrecedentId,
      name:newName,
      commentary:document.getElementById('libCommentary').value,
      is_own_style:document.getElementById('libIsOwnDoc').checked,
      ai_instructions:document.getElementById('libAiInstructions').value,
      context_relationship:document.getElementById('libContextExplanation').value,
      /* v5.65: '' means "no matter"; the server stores null. */
      source_matter_id:(document.getElementById('libSourceMatter')||{}).value||null
    };
    if(ctSel){
      payload.case_type_id=ctSel.value;
      payload.subcat_id=(stSel&&stSel.value)?stSel.value:null;
      payload.doc_type_id=(dtSel&&dtSel.value)?dtSel.value:null;
    }
    await api('/api/library','POST',payload);
    await loadLibrary();
    var keep=selectedPrecedentId;
    if(keep)libSelectPrecedent(keep);
    showToast('Precedent saved');
  }catch(e){showToast('Error: '+e.message);}
}

function libNewPrecedent(){
  if(!libraryData.caseTypes.length){showToast('Add a Case Type first');return;}
  /* Populate the upload modal dropdowns */
  var ctSel=document.getElementById('precUpCaseType');
  ctSel.innerHTML=libraryData.caseTypes.map(function(c){return '<option value="'+c.id+'">'+esc(c.name)+'</option>';}).join('');
  /* Pre-select from search filter if set */
  var searchCt=document.getElementById('libSearchCaseType');
  if(searchCt&&searchCt.value)ctSel.value=searchCt.value;
  precUpCaseTypeChanged();
  document.getElementById('precUpName').value='';
  document.getElementById('precUpFile').value='';
  /* v5.65: default to the matter in hand — that is nearly always where a
     precedent being filed has just come from. */
  libPopulateMatterSelect('precUpSourceMatter',(typeof currentMatter!=='undefined'&&currentMatter)?currentMatter.id:'');
  document.getElementById('precUpProgress').style.display='none';
  document.getElementById('precUpSaveBtn').disabled=false;
  document.getElementById('precUpSaveBtn').style.display='';
  document.getElementById('precUpSaveCommentaryBtn').style.display='none';
  document.getElementById('precUpSkipBtn').style.display='none';
  document.getElementById('precUpCommentaryStep').style.display='none';
  document.getElementById('precUpAiHint').style.display='none';
  precUpLastId=null;
  document.getElementById('precUploadModal').style.display='flex';
  setTimeout(function(){document.getElementById('precUpName').focus();},100);
}
function precUpCaseTypeChanged(){
  var ctId=document.getElementById('precUpCaseType').value;
  var stSel=document.getElementById('precUpStage');
  var dtSel=document.getElementById('precUpDocType');
  stSel.innerHTML='<option value="">— None —</option>'+libraryData.subcats.filter(function(s){return s.case_type_id===ctId;}).map(function(s){return '<option value="'+s.id+'">'+esc(s.name)+'</option>';}).join('');
  dtSel.innerHTML='<option value="">— None —</option>'+libraryData.docTypes.filter(function(d){return d.case_type_id===ctId;}).map(function(d){return '<option value="'+d.id+'">'+esc(d.name)+'</option>';}).join('');
}
if(document.getElementById('precUpCaseType')){document.getElementById('precUpCaseType').addEventListener('change',precUpCaseTypeChanged);}
var precUpLastId=null;
async function precUploadSave(){
  var name=document.getElementById('precUpName').value.trim();
  var ctId=document.getElementById('precUpCaseType').value;
  var file=document.getElementById('precUpFile').files[0];
  if(!name){showToast('Please enter a document name');return;}
  /* v5.65: a hand-typed matter name gets the same challenge as a suggested
     one — a warning rather than a block, since a template may legitimately
     share a word with a matter. */
  var clash=libMatchingMatterName(name);
  if(clash&&!confirm('"'+name+'" looks like your matter "'+clash+'".\n\nThe Precedent Library holds reusable templates, not documents from one case. A name like "Skeleton Argument — unfair prejudice" will be findable later; a matter name will not.\n\nSave it under this name anyway?'))return;
  if(!ctId){showToast('Please select a case type');return;}
  if(!file){showToast('Please select a PDF file');return;}
  var btn=document.getElementById('precUpSaveBtn');
  btn.disabled=true;btn.textContent='Uploading…';
  document.getElementById('precUpProgress').style.display='';
  try{
    var fd=new FormData();
    fd.append('action','create_precedent');
    fd.append('name',name);
    fd.append('case_type_id',ctId);
    fd.append('subcategory_id',document.getElementById('precUpStage').value||'');
    fd.append('doc_type_id',document.getElementById('precUpDocType').value||'');
    fd.append('jurisdiction',document.getElementById('precUpJur').value||'');
    fd.append('description','');
    var srcSel=document.getElementById('precUpSourceMatter');
    fd.append('source_matter_id',(srcSel&&srcSel.value)||'');
    fd.append('file',file);
    var tok=token||localStorage.getItem('elj_token');
    var r=await fetch('/api/library',{method:'POST',headers:{'Authorization':'Bearer '+tok},body:fd});
    if(!r.ok){var errData=await r.json();throw new Error(errData.error||'Upload failed');}
    var result=await r.json();
    precUpLastId=result.id||null;
    await loadLibrary();
    /* A5: Show commentary step instead of closing modal */
    document.getElementById('precUpProgress').style.display='none';
    document.getElementById('precUpCommentaryStep').style.display='';
    document.getElementById('precUpSaveBtn').style.display='none';
    document.getElementById('precUpSaveCommentaryBtn').style.display='';
    document.getElementById('precUpSkipBtn').style.display='';
    document.getElementById('precUpCommentary').value='';
    document.getElementById('precUpAiInstr').value='';
    document.getElementById('precUpIsOwn').checked=false;
    document.getElementById('precUpCommentary').focus();
  }catch(e){showToast('Error: '+e.message);document.getElementById('precUpProgress').style.display='none';}
  finally{btn.disabled=false;btn.textContent='Upload';}
}
/* A5: Save commentary after upload */
async function precUpSaveCommentary(){
  if(!precUpLastId){closePrecUpModal();return;}
  try{
    await api('/api/library','POST',{
      action:'update_precedent',
      id:precUpLastId,
      commentary:document.getElementById('precUpCommentary').value,
      ai_instructions:document.getElementById('precUpAiInstr').value,
      is_own_style:document.getElementById('precUpIsOwn').checked
    });
    showToast('Commentary saved');
  }catch(e){showToast('Error saving commentary: '+e.message);}
  closePrecUpModal();
}
function closePrecUpModal(){
  precUpLastId=null;
  closeModal('precUploadModal');
}
/* v5.65: fill a matter select. Used by the upload modal and by the precedent
   panel, so an entry uploaded before the field existed can be linked now. */
function libPopulateMatterSelect(id,selectedId){
  var sel=document.getElementById(id);
  if(!sel)return;
  var list=(typeof matters!=='undefined'&&matters)?matters.slice():[];
  list.sort(function(a,b){return libNameSort(a.name,b.name);});
  sel.innerHTML='<option value="">— None —</option>'
    +list.map(function(m){return '<option value="'+m.id+'">'+esc(m.name)+'</option>';}).join('');
  if(selectedId)sel.value=selectedId;
}

/* v5.66: one prompt, used both when a file is chosen at upload and when
   renaming an entry already in the library, so the two cannot drift apart. */
var PREC_NAME_PROMPT='You are reading the first pages of a legal document that is being filed as a REUSABLE PRECEDENT — a template to draft from in other matters.\n\nSuggest a generic name describing WHAT KIND of document it is and WHAT IT IS ABOUT. For example: "Skeleton Argument — unfair prejudice petition", "Winding-up Petition — insolvency", "First Affidavit — freezing injunction application".\n\nNEVER use party names, case names, company names or matter names. A name like "Smith v Jones", "Tianrui" or "Re ABC Ltd" is wrong: those identify one case, and this document must be findable as a template for any case.\n\nReturn ONLY the suggested name, nothing else. No quotes, no explanation.\n\nTEXT:\n';

/* v5.66: propose a template name for a precedent already in the library, by
   reading back the chunks stored at upload. Same prompt as the upload path,
   so the two agree on what a good precedent name looks like. The user is
   never renamed behind their back — the suggestion lands in the box for them
   to accept, edit, or ignore, and nothing is saved until Save Changes. */
async function libSuggestPrecedentName(){
  if(!selectedPrecedentId){showToast('Select a precedent first');return;}
  var hint=document.getElementById('libPrecNameHint');
  var btn=document.getElementById('libPrecNameSuggest');
  var nameBox=document.getElementById('libPrecName');
  if(!hint||!nameBox)return;
  hint.style.display='';hint.style.color='var(--blue)';
  hint.textContent='Reading the document…';
  if(btn)btn.disabled=true;
  try{
    var ch=await api('/api/library?type=prec_chunks&prec_id='+encodeURIComponent(selectedPrecedentId));
    var chunks=(ch&&ch.data)||[];
    if(!chunks.length){
      hint.style.color='var(--text-faint)';
      hint.textContent='No stored text for this precedent — type a name instead.';
      return;
    }
    var snippet=chunks.map(function(c){return c.content;}).join('\n\n').slice(0,2000);
    var d=await api('/api/analyse','POST',{matterId:'',matterName:'',matterNature:'',matterIssues:'',messages:[{role:'user',content:PREC_NAME_PROMPT+snippet}],jurisdiction:jurisdiction,queryType:'Factual Analysis',focusAreas:[]});
    var suggested=(d&&d.result)?d.result.trim().replace(/^["']|["']$/g,'').slice(0,120):'';
    var clash=libMatchingMatterName(suggested);
    if(clash){
      hint.style.color='var(--error)';
      hint.textContent='Suggestion discarded — it named the matter "'+clash+'". Type a name describing the document.';
    }else if(suggested&&suggested.length>2){
      nameBox.value=suggested;
      hint.style.color='var(--success)';
      hint.textContent='Suggested — edit if needed, then Save Changes.';
    }else{
      hint.style.color='var(--text-faint)';
      hint.textContent='No suggestion came back — type a name instead.';
    }
  }catch(e){
    hint.style.color='var(--error)';
    hint.textContent='Could not suggest a name: '+e.message;
  }finally{
    if(btn)btn.disabled=false;
  }
}

/* ── v5.65: keep matter names out of the Precedent Library ─────────────────
   The library holds reusable templates. A precedent named after the matter
   it came from is findable only by someone who remembers that matter, and it
   reads as case law sitting among the templates.

   Returns the matter name a proposed precedent name collides with, or ''.
   Matching ignores case and punctuation and allows either to contain the
   other, so "Tianrui" catches the matter "Tianrui v China Shanshui" and
   vice versa. Short names are ignored — a two-letter matter would match
   almost anything. */
function libNormaliseName(s){
  return String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'');
}
function libMatchingMatterName(name){
  var n=libNormaliseName(name);
  if(n.length<4)return '';
  var list=(typeof matters!=='undefined'&&matters)?matters:[];
  for(var i=0;i<list.length;i++){
    var m=libNormaliseName(list[i].name);
    if(m.length<4)continue;
    if(n.indexOf(m)!==-1||m.indexOf(n)!==-1)return list[i].name;
  }
  return '';
}

/* A3: AI auto-fills document name when PDF or Word file selected */
/* v4.5: Rewritten — unwraps page array (fixes v3.2 bug), adds .docx routing */
async function precUpFileChanged(input){
  if(!input.files||!input.files[0])return;
  var file=input.files[0];
  var nameField=document.getElementById('precUpName');
  /* Only suggest if the name field is empty */
  if(nameField.value.trim())return;
  var hint=document.getElementById('precUpAiHint');
  hint.style.display='';hint.textContent='Reading document to suggest a name…';
  try{
    var lowerName=file.name.toLowerCase();
    var isDocx=lowerName.endsWith('.docx');
    var isPdf=lowerName.endsWith('.pdf');
    if(!isPdf&&!isDocx){hint.style.display='none';return;}
    /* v4.5: Unwrap page array from extractors. Both return [{page,text},...] */
    var pages=isDocx?await extractDocxText(file):await extractPdfText(file);
    var text=pages.map(function(p){return p.text;}).join('\n\n');
    if(!text||text.trim().length<30){hint.style.display='none';return;}
    /* Send first 2000 chars to AI for name suggestion */
    var snippet=text.slice(0,2000);
    /* v5.65: this used to ask for "the case name (e.g. Smith v Jones) or the
       first party name", which is how matter-named entries — Tianrui,
       Thalassa, 51 Jobs Appeal — ended up in the Precedent Library. A
       precedent is a reusable template: what matters is the kind of document
       it is and what it is about, never whose case it came from. */
    var d=await api('/api/analyse','POST',{matterId:'',matterName:'',matterNature:'',matterIssues:'',messages:[{role:'user',content:PREC_NAME_PROMPT+snippet}],jurisdiction:jurisdiction,queryType:'Factual Analysis',focusAreas:[]});
    if(d&&d.result){
      var suggested=d.result.trim().replace(/^["']|["']$/g,'').slice(0,120);
      /* Belt and braces: the prompt says not to use a case name, but a
         suggestion that matches one of this user's matters is refused
         outright rather than offered for the user to accept by reflex. */
      var clash=libMatchingMatterName(suggested);
      if(clash){
        hint.textContent='Suggestion discarded — it named the matter "'+clash+'". Give this precedent a generic name, e.g. "Skeleton Argument — unfair prejudice".';
        hint.style.color='var(--error)';
      }else if(suggested&&suggested.length>2){
        nameField.value=suggested;
        hint.textContent='Suggested: '+suggested+' (edit if needed)';
        hint.style.color='var(--success)';
      }else{hint.style.display='none';}
    }else{hint.style.display='none';}
  }catch(e){hint.style.display='none';console.log('AI name suggestion error:',e.message);}
}
async function libCreatePrecedent(name){
  try{
    var ctId=libraryData.caseTypes[0].id;
    await api('/api/library','POST',{action:'create_precedent',name:name,case_type_id:ctId,jurisdiction:jurisdiction});
    await loadLibrary();showToast('Precedent created — select it to edit details');
  }catch(e){showToast('Error: '+e.message);}
}

function libUploadContext(){showToast('Context document upload — coming soon');}
function libTagContext(){showToast('Tag existing document as context — coming soon');}

/* Delete from Library left column dropdowns */
function libDeleteFromDropdown(type){
  if(type==='casetype'){
    var sel=document.getElementById('libSearchCaseType');
    if(!sel||!sel.value){showToast('Select a case type from the dropdown first');return;}
    var name=sel.options[sel.selectedIndex].text;
    if(!confirm('Delete case type "'+name+'" and all its stages, doc types, and precedents?'))return;
    api('/api/library','DELETE',{action:'delete_case_type',id:sel.value}).then(function(){loadLibrary();showToast('Deleted: '+name);}).catch(function(e){showToast('Error: '+e.message);});
  }else if(type==='subcat'){
    var sel2=document.getElementById('libSearchStage');
    if(!sel2||!sel2.value){showToast('Select a stage from the dropdown first');return;}
    var name2=sel2.options[sel2.selectedIndex].text;
    if(!confirm('Delete stage "'+name2+'"?'))return;
    api('/api/library','DELETE',{action:'delete_subcat',id:sel2.value}).then(function(){loadLibrary();showToast('Deleted: '+name2);}).catch(function(e){showToast('Error: '+e.message);});
  }else if(type==='doctype'){
    var sel3=document.getElementById('libSearchDocType');
    if(!sel3||!sel3.value){showToast('Select a doc type from the dropdown first');return;}
    var name3=sel3.options[sel3.selectedIndex].text;
    if(!confirm('Delete doc type "'+name3+'"?'))return;
    api('/api/library','DELETE',{action:'delete_doc_type',id:sel3.value}).then(function(){loadLibrary();showToast('Deleted: '+name3);}).catch(function(e){showToast('Error: '+e.message);});
  }
}

function libDeleteSelected(type){
  if(type==='casetype'){
    var sel=document.getElementById('libBoxCaseType');
    if(!sel||!sel.value){showToast('Select a case type first');return;}
    if(!confirm('Delete this case type and all its sub-categories, document types, precedents and sections?'))return;
    api('/api/library','DELETE',{action:'delete_case_type',id:sel.value}).then(function(){loadLibrary();showToast('Deleted');}).catch(function(e){showToast('Error: '+e.message);});
  }else if(type==='subcat'){
    var sel2=document.getElementById('libBoxStage');
    if(!sel2||!sel2.value){showToast('Select a stage first');return;}
    if(!confirm('Delete this procedural stage?'))return;
    api('/api/library','DELETE',{action:'delete_subcat',id:sel2.value}).then(function(){loadLibrary();showToast('Deleted');}).catch(function(e){showToast('Error: '+e.message);});
  }else if(type==='doctype'){
    var sel3=document.getElementById('libBoxDocType');
    if(!sel3||!sel3.value){showToast('Select a doc type first');return;}
    if(!confirm('Delete this document type?'))return;
    api('/api/library','DELETE',{action:'delete_doc_type',id:sel3.value}).then(function(){loadLibrary();showToast('Deleted');}).catch(function(e){showToast('Error: '+e.message);});
  }
}

/* Quick Add modal — used from Library boxes and Draft selectors */
function libQuickAdd(type){
  quickAddType=type;
  var titles={casetype:'Add Case Type',subcat:'Add Procedural Stage',doctype:'Add Document Type'};
  document.getElementById('quickAddTitle').textContent=titles[type]||'Add';
  document.getElementById('quickAddName').value='';
  /* v5.39: explicit case-type attachment for stages and doc types —
     pre-filled from the Draft tab when visible, else the Library tab. */
  var wrap=document.getElementById('quickAddCtWrap');
  var ctSel=document.getElementById('quickAddCaseType');
  if(wrap&&ctSel){
    if((type==='subcat'||type==='doctype')&&libraryData.caseTypes.length){
      ctSel.innerHTML=libraryData.caseTypes.map(function(c){return '<option value="'+c.id+'">'+esc(c.name)+'</option>';}).join('');
      var pre=null;
      var dcp=document.getElementById('draftCentrePanel');
      if(dcp&&dcp.style.display!=='none'){var dsel=document.getElementById('draftCaseType');if(dsel&&dsel.value)pre=dsel.value;}
      if(!pre){var f=document.getElementById('libSearchCaseType');if(f&&f.value)pre=f.value;}
      if(!pre){var b=document.getElementById('libBoxCaseType');if(b&&b.value)pre=b.value;}
      if(pre)ctSel.value=pre;
      wrap.style.display='';
    }else{
      wrap.style.display='none';
    }
  }
  document.getElementById('quickAddModal').style.display='flex';
  setTimeout(function(){document.getElementById('quickAddName').focus();},100);
}
/* v5.38: when Quick Add is used from the Draft tab, the Draft tab's Case
   Type must win — previously a leftover selection in the Library tab's
   search filter or box silently claimed the new stage/doc type. */
function _quickAddDraftCt(){
  var dcp=document.getElementById('draftCentrePanel');
  if(!dcp||dcp.style.display==='none')return null;
  var dsel=document.getElementById('draftCaseType');
  return (dsel&&dsel.value)?dsel.value:null;
}
async function quickAddSave(){
  var name=document.getElementById('quickAddName').value.trim();
  if(!name){showToast('Please enter a name');return;}
  var usedCt=null;
  try{
    if(quickAddType==='casetype'){
      await api('/api/library','POST',{action:'create_case_type',name:name,jurisdiction:jurisdiction,subcats:[],docTypes:[]});
    }else if(quickAddType==='subcat'){
      /* v5.39: attachment is explicit — the modal's own dropdown decides. */
      var mSel=document.getElementById('quickAddCaseType');
      var ctId=(mSel&&mSel.value)?mSel.value:_quickAddDraftCt();
      if(!ctId){showToast('Add a case type first');return;}
      usedCt=ctId;
      await api('/api/library','POST',{action:'create_subcat',name:name,case_type_id:ctId});
    }else if(quickAddType==='doctype'){
      var mSel2=document.getElementById('quickAddCaseType');
      var ctId2=(mSel2&&mSel2.value)?mSel2.value:_quickAddDraftCt();
      if(!ctId2){showToast('Add a case type first');return;}
      usedCt=ctId2;
      await api('/api/library','POST',{action:'create_doc_type',name:name,case_type_id:ctId2});
    }
    closeModal('quickAddModal');
    await loadLibrary();
    /* Re-populate the upload modal dropdowns if it's still open */
    if(document.getElementById('precUploadModal').style.display==='flex'){
      precUpCaseTypeChanged();
    }
    /* v5.38: if added from the Draft tab, select the new item there.
       libPopulateDraftSelects (run by loadLibrary) now preserves the
       Case Type and repopulates Stage/Doc Type, so the new option exists;
       find it by name within the case type it was attached to. */
    if(document.getElementById('draftCentrePanel')&&document.getElementById('draftCentrePanel').style.display!=='none'){
      if(quickAddType==='casetype'){
        var nc=libraryData.caseTypes.find(function(c){return c.name===name;});
        var cs=document.getElementById('draftCaseType');
        if(nc&&cs){cs.value=nc.id;if(typeof draftCaseTypeChanged==='function')draftCaseTypeChanged();}
      }else if(quickAddType==='subcat'&&usedCt){
        var nsc=libraryData.subcats.find(function(x){return x.case_type_id===usedCt&&x.name===name;});
        var ss=document.getElementById('draftStage');
        if(nsc&&ss)ss.value=nsc.id;
      }else if(quickAddType==='doctype'&&usedCt){
        var nd=libraryData.docTypes.find(function(x){return x.case_type_id===usedCt&&x.name===name;});
        var ds=document.getElementById('draftDocType');
        if(nd&&ds){
          ds.value=nd.id;
          /* v5.39: mirror the change listener — pull Case Type + Stage along. */
          if(typeof draftDocTypeAutoCase==='function')draftDocTypeAutoCase(nd.id);
        }
      }
    }
    showToast('Added: '+name);
  }catch(e){showToast('Error: '+e.message);}
}

/* Delete from the precUpload modal dropdowns */
function precModalDelete(type){
  if(type==='casetype'){
    var sel=document.getElementById('precUpCaseType');
    if(!sel||!sel.value){showToast('Select a case type from the dropdown first');return;}
    var name=sel.options[sel.selectedIndex].text;
    if(!confirm('Delete case type "'+name+'" and all its stages, doc types, and precedents?'))return;
    api('/api/library','DELETE',{action:'delete_case_type',id:sel.value}).then(function(){loadLibrary().then(function(){precUpCaseTypeChanged();});showToast('Deleted: '+name);}).catch(function(e){showToast('Error: '+e.message);});
  }else if(type==='subcat'){
    var sel2=document.getElementById('precUpStage');
    if(!sel2||!sel2.value){showToast('Select a stage from the dropdown first');return;}
    var name2=sel2.options[sel2.selectedIndex].text;
    if(!confirm('Delete stage "'+name2+'"?'))return;
    api('/api/library','DELETE',{action:'delete_subcat',id:sel2.value}).then(function(){loadLibrary().then(function(){precUpCaseTypeChanged();});showToast('Deleted: '+name2);}).catch(function(e){showToast('Error: '+e.message);});
  }else if(type==='doctype'){
    var sel3=document.getElementById('precUpDocType');
    if(!sel3||!sel3.value){showToast('Select a doc type from the dropdown first');return;}
    var name3=sel3.options[sel3.selectedIndex].text;
    if(!confirm('Delete doc type "'+name3+'"?'))return;
    api('/api/library','DELETE',{action:'delete_doc_type',id:sel3.value}).then(function(){loadLibrary().then(function(){precUpCaseTypeChanged();});showToast('Deleted: '+name3);}).catch(function(e){showToast('Error: '+e.message);});
  }
}

/* Delete from Draft tab select dropdowns */
function draftDeleteFromSelect(type){
  if(type==='casetype'){
    var sel=document.getElementById('draftCaseType');
    if(!sel||!sel.value){showToast('Select a case type first');return;}
    var name=sel.options[sel.selectedIndex].text;
    if(!confirm('Delete case type "'+name+'" and all its stages, doc types, and precedents?'))return;
    api('/api/library','DELETE',{action:'delete_case_type',id:sel.value}).then(function(){loadLibrary();showToast('Deleted: '+name);}).catch(function(e){showToast('Error: '+e.message);});
  }else if(type==='subcat'){
    var sel2=document.getElementById('draftStage');
    if(!sel2||!sel2.value){showToast('Select a stage first');return;}
    var name2=sel2.options[sel2.selectedIndex].text;
    if(!confirm('Delete stage "'+name2+'"?'))return;
    api('/api/library','DELETE',{action:'delete_subcat',id:sel2.value}).then(function(){loadLibrary();showToast('Deleted: '+name2);}).catch(function(e){showToast('Error: '+e.message);});
  }else if(type==='doctype'){
    var sel3=document.getElementById('draftDocType');
    if(!sel3||!sel3.value){showToast('Select a doc type first');return;}
    var name3=sel3.options[sel3.selectedIndex].text;
    if(!confirm('Delete doc type "'+name3+'"?'))return;
    api('/api/library','DELETE',{action:'delete_doc_type',id:sel3.value}).then(function(){loadLibrary();showToast('Deleted: '+name3);}).catch(function(e){showToast('Error: '+e.message);});
  }
}


/* ══ v5.58: LIBRARY SECTION COLLAPSE ═════════════════════════════════════
   Legislation and Case Law behave identically, so they share one toggle.
   Both start shut: the Precedent Library above them is the panel's main
   business, and two open sections leave it almost nothing.

   Expanded, a section splits the leftover height with whatever else is
   open (flex:1 1 0%) and keeps a 160px floor so a short screen still
   shows something usable; its body scrolls inside it. An earlier
   percentage max-height plus flex-shrink:0 clipped the Upload button off
   the foot of the panel. Collapsed, a section is just its header.

   Section state lives here rather than in the DOM so a loadLibrary()
   refresh — after an upload or a delete — leaves open sections open. */
var libSectionExpanded={leg:false,cl:false};

function libSectionToggle(prefix){
  var open=!libSectionExpanded[prefix];
  libSectionExpanded[prefix]=open;
  var sect=document.getElementById(prefix+'Section');
  var body=document.getElementById(prefix+'Body');
  var caret=document.getElementById(prefix+'Caret');
  if(body)body.style.display=open?'':'none';
  if(caret)caret.textContent=open?'▾':'▸';
  if(sect){
    sect.style.flex=open?'1 1 0%':'0 0 auto';
    sect.style.minHeight=open?'160px':'0';
  }
}

/* The header carries the count so both sections can be read shut. */
function libSectionCount(prefix,label,n){
  var heading=document.getElementById(prefix+'Heading');
  if(heading)heading.textContent=label+' ('+n+')';
}

/* Alphabetical, case-insensitive, and stable enough for a list of names:
   "abbott" sorts next to "Abbott", not after "Zurich". */
function libNameSort(a,b){
  return String(a||'').localeCompare(String(b||''),undefined,{sensitivity:'base'});
}

/* ══ v5.40 Push A: LEGISLATION LIBRARY ═══════════════════════════════════
   Acts are extracted in the browser (full text) and stored chunked on the
   server. Text extraction reuses the matter-document extractors. */
var legPendingText=null;
async function legFileChanged(input){
  legPendingText=null;
  var st=document.getElementById('legUpStatus');
  if(!input.files||!input.files[0])return;
  var file=input.files[0];
  var lower=file.name.toLowerCase();
  var isPdf=lower.endsWith('.pdf'),isDocx=lower.endsWith('.docx');
  if(!isPdf&&!isDocx){st.style.display='';st.textContent='PDF or DOCX only.';return;}
  st.style.display='';st.textContent='Reading document\u2026';
  try{
    var pages=isDocx?await extractDocxText(file):await extractPdfText(file);
    var text=pages.map(function(p){return p.text;}).join('\n\n');
    if(!text||text.trim().length<200){st.textContent='No readable text \u2014 if this is a scanned PDF, OCR it first.';return;}
    legPendingText=text;
    st.textContent='Read '+text.length.toLocaleString()+' characters.';
    var nameField=document.getElementById('legUpName');
    if(!nameField.value.trim()){
      nameField.value=file.name.replace(/\.(pdf|docx)$/i,'').replace(/[_-]+/g,' ').trim();
    }
  }catch(e){st.textContent='Read error: '+e.message;}
}
async function legUpload(){
  var jur=document.getElementById('legUpJur').value;
  var name=document.getElementById('legUpName').value.trim();
  var fileInput=document.getElementById('legUpFile');
  var st=document.getElementById('legUpStatus');
  if(!name){showToast('Enter the act name');return;}
  if(!legPendingText){showToast('Choose a file first');return;}
  st.style.display='';st.textContent='Uploading\u2026';
  try{
    await api('/api/library','POST',{action:'create_legislation',jurisdiction:jur,act_name:name,file_name:fileInput.files[0]?fileInput.files[0].name:null,text:legPendingText});
    legPendingText=null;fileInput.value='';document.getElementById('legUpName').value='';
    st.style.display='none';
    showToast('Legislation stored');
    await loadLibrary();
  }catch(e){st.textContent='Upload error: '+e.message;}
}
async function legDelete(id,name){
  if(!confirm('Delete "'+name+'" from the legislation library?'))return;
  try{
    await api('/api/library','DELETE',{action:'delete_legislation',id:id});
    showToast('Deleted');
    await loadLibrary();
  }catch(e){showToast('Error: '+e.message);}
}
function legRender(){
  var acts=libraryData.legislation||[];
  /* v5.58: the count shows on the header, so it reads while shut. */
  libSectionCount('leg','Legislation',acts.length);
  var wrap=document.getElementById('legList');
  if(!wrap)return;
  if(!acts.length){wrap.innerHTML='<div style="font-size:.78rem;color:var(--text-faint);padding:.3rem .1rem">No legislation uploaded yet.</div>';return;}
  var byJur={};
  acts.forEach(function(a){(byJur[a.jurisdiction]=byJur[a.jurisdiction]||[]).push(a);});
  /* v5.58: sort here rather than trusting the order the rows arrive in.
     The API does order by act_name, but that is Postgres collation on the
     server's locale; sorting client-side makes it explicit and
     case-insensitive, and survives any change to that query. */
  Object.keys(byJur).forEach(function(j){
    byJur[j].sort(function(a,b){return libNameSort(a.act_name,b.act_name);});
  });
  wrap.innerHTML=Object.keys(byJur).sort(libNameSort).map(function(j){
    return '<div style="font-size:.72rem;font-weight:700;color:var(--text-mid);margin:.35rem 0 .15rem;text-transform:uppercase;letter-spacing:.03em">'+esc(j)+'</div>'
      +byJur[j].map(function(a){
        return '<div style="display:flex;align-items:center;gap:.35rem;padding:.22rem .1rem;font-size:.82rem;border-bottom:1px solid var(--border)">'
          +'<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(a.act_name)+'">'+esc(a.act_name)+'</span>'
          +'<span style="font-size:.7rem;color:var(--text-faint);flex-shrink:0">'+(a.char_count?Math.round(a.char_count/1000)+'k':'')+'</span>'
          +'<button class="lib-box-btn del" style="flex-shrink:0;padding:.1rem .4rem;font-size:.78rem" title="Delete" onclick="legDelete(\''+a.id+'\',\''+esc(a.act_name).replace(/'/g,'')+'\')">\u2212</button>'
          +'</div>';
      }).join('');
  }).join('');
}


/* ══ v5.56 Push B: CASE LAW & TEXTBOOK LIBRARY ═══════════════════════════
   Same shape as Push A's legislation library: the file is read in the
   BROWSER (full text — the server-side PDF extractor truncates at 4096
   tokens) and posted as JSON to /api/library, which chunks it into
   case_law_chunks.

   Live schema — these are the real column names, do not invent others:
     case_law_subjects (id, user_id, name, created_at)  UNIQUE(user_id,name)
     case_law_docs     (id, user_id, doc_type, name, citation, jurisdiction,
                        subject_id, sub_tags text[], commentary,
                        source_document_id, source_matter_id, char_count,
                        created_at)
     case_law_chunks   (id, case_law_id, user_id, chunk_index, content)

   Dual-link: when "also add to the current matter" is ticked the same
   extracted text is first POSTed to /api/upload as a matter document (doc
   type "Case Law"), so the matter tools can search it, and the returned
   documentId is kept on the library row as source_document_id.

   Both stages are batched — see clRunUpload. A textbook's text is far
   larger than Vercel will accept in one body, so the pages are packed into
   ~1 MB batches and posted in order, and a failure part-way leaves a Retry
   link that resumes from the batch that failed.

   The whole block is collapsed by default. Expanded it takes room from the
   precedent results above it, so it stays shut until it is wanted. */
var CL_UNCLASSIFIED='Unclassified';  /* group label for entries with no subject */
var clPendingText=null;
var clPendingPages=null;   /* [{page,text}] — kept for batched upload */
var clPendingFile=null;    /* {name,size} — the File itself is not held */

/* v5.57: ~1 MB of raw text per POST — the same ceiling, and the same
   reasoning, as the matter uploader (v5.2a): JSON escaping expands the
   body well past the raw character count, and Vercel's gateway rejects
   anything over 4.5 MB. A full textbook is many times that, so both the
   matter copy and the library entry go up in batches. */
var CL_BATCH_TARGET_BYTES=1*1024*1024;

/* Set when a batch fails, so the Retry link can resume from exactly that
   point rather than re-sending what already landed:
   {stage, batchIndex, documentId, caseLawId, meta}. Cleared on success. */
var clResume=null;


/* Attribute-safe: matches the legislation list's approach — apostrophes are
   dropped so they cannot break out of the inline onclick string. Only the
   confirm() message is affected; the stored name keeps its punctuation. */
function clAttr(s){return esc(String(s||'')).replace(/'/g,'');}

async function clFileChanged(input){
  clPendingText=null;clPendingPages=null;clPendingFile=null;clResume=null;
  clSegments=null;clSetResume=null;clRenderSegments();
  var st=document.getElementById('clUpStatus');
  if(!input.files||!input.files[0])return;
  var file=input.files[0];
  var lower=file.name.toLowerCase();
  var isPdf=lower.endsWith('.pdf'),isDocx=lower.endsWith('.docx');
  if(!isPdf&&!isDocx){st.style.display='';st.textContent='PDF or DOCX only.';return;}
  st.style.display='';st.textContent='Reading document…';
  try{
    var pages=isDocx?await extractDocxText(file):await extractPdfText(file);
    var text=pages.map(function(p){return p.text;}).join('\n\n');
    if(!text||text.trim().length<200){st.textContent='No readable text — if this is a scanned PDF, OCR it first.';return;}
    clPendingText=text;
    clPendingPages=pages;
    clPendingFile={name:file.name,size:file.size};
    /* Say up front how many POSTs this will take — a textbook runs to
       dozens, and a silent five-minute upload looks like a hang. */
    var batchCount=packPagesIntoBatches(pages,CL_BATCH_TARGET_BYTES).length;
    st.textContent='Read '+text.length.toLocaleString()+' characters'
      +(batchCount>1?' — will upload in '+batchCount+' batches.':'.');
    var nameField=document.getElementById('clUpName');
    if(nameField&&!nameField.value.trim()){
      nameField.value=file.name.replace(/\.(pdf|docx)$/i,'').replace(/[_-]+/g,' ').trim();
    }
    /* v5.62 Push D: does this file hold more than one judgment? */
    clSegments=await clDetectSegments(pages);
    clRenderSegments();
    if(clSegments){
      st.textContent='Read '+text.length.toLocaleString()+' characters — '
        +clSegments.length+' authorities found.';
    }
  }catch(e){st.textContent='Read error: '+e.message;}
}

async function clSubjectAdd(){
  var name=prompt('New subject (e.g. Trusts, Insolvency, Company Law):');
  if(!name||!name.trim())return;
  try{
    var d=await api('/api/library','POST',{action:'create_case_law_subject',name:name.trim()});
    await loadLibrary();
    var sel=document.getElementById('clUpSubject');
    if(sel&&d&&d.id)sel.value=d.id;
    showToast(d&&d.existed?'Subject already exists':'Subject added: '+name.trim());
  }catch(e){showToast('Error: '+e.message);}
}

async function clSubjectDelete(){
  var sel=document.getElementById('clUpSubject');
  if(!sel||!sel.value){showToast('Select a subject first');return;}
  var name=sel.options[sel.selectedIndex].text;
  if(!confirm('Delete subject "'+name+'"? Entries filed under it are kept and shown as Unclassified.'))return;
  try{
    await api('/api/library','DELETE',{action:'delete_case_law_subject',id:sel.value});
    sel.value='';
    showToast('Deleted: '+name);
    await loadLibrary();
  }catch(e){showToast('Error: '+e.message);}
}

function clSetStatus(html){
  var st=document.getElementById('clUpStatus');
  if(!st)return;
  st.style.display='';
  st.innerHTML=html;
}

function clFail(stage,batchIndex,documentId,caseLawId,meta,err,batchTotal){
  clResume={stage:stage,batchIndex:batchIndex,documentId:documentId,caseLawId:caseLawId,meta:meta};
  var where=stage==='matter'
    ? 'adding to '+esc(meta.matterName)
    : 'storing in the library';
  var partial='';
  if(stage==='library'&&documentId){
    partial='<div style="color:var(--text-faint)">The matter copy is already in — only the library entry is outstanding.</div>';
  }else if(stage==='matter'&&batchIndex>0){
    /* Say what is sitting in the matter half-finished. The retry completes
       it; abandoning it leaves a partial document to delete by hand. */
    partial='<div style="color:var(--text-faint)">Part of the document is already in the matter. Retrying finishes it; otherwise remove it from the matter by hand.</div>';
  }
  clSetStatus('<div style="color:var(--error)">Failed while '+where
    +' (batch '+(batchIndex+1)+' of '+batchTotal+'): '+esc(err.message)+'</div>'
    +partial
    +'<div><a href="#" onclick="event.preventDefault();clRetryUpload()" style="color:var(--blue);font-weight:700">Retry from batch '+(batchIndex+1)+'</a></div>');
}

async function clRetryUpload(){
  if(!clResume){showToast('Nothing to retry');return;}
  if(!clPendingPages&&!(clResume.meta&&clResume.meta.pages)){showToast('The file was cleared — choose it again');clResume=null;return;}
  var r=clResume;
  await clRunUpload(r.meta,r);
}

/* Runs the upload through its two stages — the matter copy first, then the
   library entry — resuming from `resume` when one is supplied.

   The matter copy goes first deliberately: the other order would leave a
   library entry pointing at a matter document that was never created.

   Note the chunker's 150-character overlap does not carry across a batch
   boundary, so a handful of chunk joins in a batched upload are clean
   cuts. /api/upload has the same property. */
async function clRunUpload(meta,resume){
  /* v5.62: pages come from meta when the caller has them — one judgment's
     worth on the multi-case path — and fall back to the whole file. */
  var pages=meta.pages||clPendingPages;
  var batches=packPagesIntoBatches(pages,CL_BATCH_TARGET_BYTES);
  var total=batches.length;
  var totalChars=pages.reduce(function(n,p){return n+((p.text||'').length);},0);
  var stage=resume?resume.stage:(meta.wantsLink?'matter':'library');
  var from=resume?resume.batchIndex:0;
  var documentId=resume?resume.documentId:null;
  var caseLawId=resume?resume.caseLawId:null;
  clResume=null;

  function progress(what,i){
    clSetStatus(esc(what)+(total>1?' — batch '+(i+1)+' of '+total:'')+'…');
  }

  if(stage==='matter'){
    for(var bi=from;bi<total;bi++){
      progress('Adding to '+meta.matterName,bi);
      var upBody={matterId:meta.matterId,fileName:meta.fileName,pageTexts:batches[bi],
        docType:'Case Law',fileSize:meta.fileSize||0};
      /* Single-batch uploads send no batch fields — that is the server's
         original happy path, untouched. */
      if(total>1){
        upBody.batchIndex=bi;
        upBody.batchTotal=total;
        if(bi>0&&documentId)upBody.documentId=documentId;
      }
      try{
        var up=await api('/api/upload','POST',upBody);
        if(bi===0&&up&&up.documentId)documentId=up.documentId;
      }catch(e){
        clFail('matter',bi,documentId,null,meta,e,total);
        return false;
      }
    }
    stage='library';
    from=0;
  }

  for(var li=from;li<total;li++){
    progress('Storing in the library',li);
    var libBody={
      action:'create_case_law',
      doc_type:meta.docType,
      name:meta.name,
      citation:meta.citation,
      jurisdiction:meta.jurisdiction,
      subject_id:meta.subjectId||null,
      sub_tags:meta.subTags,
      /* v5.64: send the pages, not just their text, so each chunk records the
         page it came from and the draft can cite a pinpoint. */
      pageTexts:batches[li],
      total_char_count:totalChars
    };
    if(li===0){
      libBody.source_matter_id=meta.wantsLink?meta.matterId:null;
      libBody.source_document_id=documentId;
    }
    if(total>1){
      libBody.batch_index=li;
      libBody.batch_total=total;
      if(li>0&&caseLawId)libBody.case_law_id=caseLawId;
    }
    try{
      var d=await api('/api/library','POST',libBody);
      if(li===0&&d&&d.id)caseLawId=d.id;
    }catch(e){
      clFail('library',li,documentId,caseLawId,meta,e,total);
      return false;
    }
  }

  /* On the multi-case path the caller owns the form and the next case, so
     stop here and let it decide. */
  if(meta.partOfSet)return true;

  /* Success — clear the form only now, so a failure leaves everything in
     place for the Retry link. */
  clPendingText=null;clPendingPages=null;clPendingFile=null;clResume=null;
  var fileInput=document.getElementById('clUpFile');
  if(fileInput)fileInput.value='';
  document.getElementById('clUpName').value='';
  document.getElementById('clUpCitation').value='';
  document.getElementById('clUpTags').value='';
  var linkBox=document.getElementById('clUpMatterLink');
  if(linkBox)linkBox.checked=false;
  var st=document.getElementById('clUpStatus');
  if(st)st.style.display='none';
  showToast(meta.wantsLink
    ? 'Stored in the library and added to '+meta.matterName
    : 'Stored in the library');
  if(meta.wantsLink&&currentMatter&&currentMatter.id===meta.matterId){
    await loadDocuments(meta.matterId);
    await loadMatters();
  }
  await loadLibrary();
  return true;
}

async function clUpload(){
  var nameField=document.getElementById('clUpName');
  var name=nameField.value.trim();
  if(!name){showToast('Enter the case or textbook name');return;}
  if(!clPendingText||!clPendingPages){showToast('Choose a file first');return;}
  var linkBox=document.getElementById('clUpMatterLink');
  var wantsLink=!!(linkBox&&linkBox.checked);
  if(wantsLink&&!currentMatter){showToast('No matter open — open one first, or untick the dual-link box');return;}
  var meta={
    docType:document.getElementById('clUpDocType').value,
    name:name,
    citation:document.getElementById('clUpCitation').value.trim(),
    jurisdiction:document.getElementById('clUpJur').value,
    subjectId:document.getElementById('clUpSubject').value,
    subTags:document.getElementById('clUpTags').value,
    fileName:(clPendingFile&&clPendingFile.name)||(name+'.pdf'),
    fileSize:(clPendingFile&&clPendingFile.size)||0,
    wantsLink:wantsLink,
    matterId:wantsLink?currentMatter.id:null,
    matterName:wantsLink?currentMatter.name:''
  };
  await clRunUpload(meta,null);
}

async function clDelete(id,name){
  if(!confirm('Delete "'+name+'" from the case law library? Any copy in a matter is left alone.'))return;
  try{
    await api('/api/library','DELETE',{action:'delete_case_law',id:id});
    showToast('Deleted');
    await loadLibrary();
  }catch(e){showToast('Error: '+e.message);}
}

function clRenderSubjects(){
  var sel=document.getElementById('clUpSubject');
  if(!sel)return;
  var prev=sel.value;
  sel.innerHTML='<option value="">— Subject —</option>'
    +(libraryData.caseLawSubjects||[]).map(function(s){
      return '<option value="'+s.id+'">'+esc(s.name)+'</option>';
    }).join('');
  if(prev)sel.value=prev;
}

/* switchMainNav('library') calls loadLibrary() on every activation, so the
   dual-link label is re-read from currentMatter each time the tab is opened
   and cannot go stale. */
function clRenderMatterLink(){
  var label=document.getElementById('clUpMatterLabel');
  var box=document.getElementById('clUpMatterLink');
  if(!label)return;
  if(currentMatter){
    label.textContent='Also add to '+currentMatter.name;
    label.style.color='var(--text-mid)';
    if(box)box.disabled=false;
  }else{
    label.textContent='Also add to the current matter — none open';
    label.style.color='var(--text-faint)';
    if(box){box.checked=false;box.disabled=true;}
  }
}

function clRow(d){
  var meta=[];
  if(d.citation)meta.push(esc(d.citation));
  if(d.jurisdiction)meta.push(esc(d.jurisdiction));
  if(d.char_count)meta.push(Math.round(d.char_count/1000)+'k');
  var tags=(d.sub_tags||[]).filter(Boolean);
  return '<div style="padding:.25rem .1rem;border-bottom:1px solid var(--border)">'
    +'<div style="display:flex;align-items:center;gap:.35rem">'
      +'<span style="flex-shrink:0;font-size:.62rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--text-faint)">'+(d.doc_type==='textbook'?'Text':'Case')+'</span>'
      +'<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.82rem" title="'+esc(d.name)+'">'+esc(d.name)+'</span>'
      +(d.source_document_id?'<span title="Also held in a matter" style="flex-shrink:0;font-size:.72rem;color:var(--blue)">⧉</span>':'')
      +'<button class="lib-box-btn del" style="flex-shrink:0;padding:.1rem .4rem;font-size:.78rem" title="Delete" onclick="clDelete(\''+d.id+'\',\''+clAttr(d.name)+'\')">−</button>'
    +'</div>'
    +(meta.length?'<div style="font-size:.7rem;color:var(--text-faint);padding-left:2.1rem">'+meta.join(' · ')+'</div>':'')
    +(tags.length?'<div style="font-size:.7rem;color:var(--text-mid);padding-left:2.1rem">'+tags.map(function(t){return esc(t);}).join(', ')+'</div>':'')
    +'</div>';
}

function clRender(){
  clRenderSubjects();
  clRenderMatterLink();
  var docs=libraryData.caseLaw||[];
  /* v5.58: the count shows on the header, so it reads while shut. */
  libSectionCount('cl','Case Law & Texts',docs.length);
  var wrap=document.getElementById('clList');
  if(!wrap)return;
  if(!docs.length){
    wrap.innerHTML='<div style="font-size:.78rem;color:var(--text-faint);padding:.3rem .1rem">No case law or textbooks uploaded yet.</div>';
    return;
  }
  var subjectNames={};
  (libraryData.caseLawSubjects||[]).forEach(function(s){subjectNames[s.id]=s.name;});
  var bySubject={};
  docs.forEach(function(d){
    /* Anything with no subject — never tagged, or tagged with a subject
       since deleted, since subject_id is ON DELETE SET NULL. */
    var key=subjectNames[d.subject_id]||CL_UNCLASSIFIED;
    (bySubject[key]=bySubject[key]||[]).push(d);
  });
  /* v5.58: subjects A-Z with Unclassified pinned last, and entries A-Z
     within each subject. */
  Object.keys(bySubject).forEach(function(k){
    bySubject[k].sort(function(a,b){return libNameSort(a.name,b.name);});
  });
  var keys=Object.keys(bySubject).sort(function(a,b){
    if(a===CL_UNCLASSIFIED)return 1;
    if(b===CL_UNCLASSIFIED)return -1;
    return libNameSort(a,b);
  });
  wrap.innerHTML=keys.map(function(sub){
    return '<div style="font-size:.72rem;font-weight:700;color:var(--text-mid);margin:.35rem 0 .15rem;text-transform:uppercase;letter-spacing:.03em">'+esc(sub)+'</div>'
      +bySubject[sub].map(clRow).join('');
  }).join('');
}


/* ══ v5.62 Push D: A FILE HOLDING SEVERAL JUDGMENTS ═══════════════════════
   A bundle of authorities arrives as one PDF. Stored whole it becomes one
   library entry with one name — and the drafting prompt tells the model to
   cite each authority by the name in its heading, so passages from the third
   judgment would be cited under the first judgment's name. Confidently, and
   wrongly.

   So after reading a file we look for judgment boundaries
   (clSplitPages, public/js/case_law_split.js), ask the server to name each
   segment from its opening, and show the user what was found. They edit
   anything wrong, untick anything that is not wanted, and choose whether to
   store separate entries or fall back to one.

   Nothing is stored until they choose. Detection finding nothing leaves the
   ordinary single-entry path exactly as it was. */
var clSegments=null;      /* [{index,pages,charCount,name,citation,jurisdiction,keep}] */
var clSetResume=null;     /* {caseIndex, meta} — which case to restart at */

function clSegmentsPanel(){return document.getElementById('clSegments');}

async function clDetectSegments(pages){
  var segs=(typeof clSplitPages==='function')?clSplitPages(pages):[];
  if(!segs||segs.length<2)return null;
  var st=document.getElementById('clUpStatus');
  st.style.display='';
  st.textContent='Looks like '+segs.length+' judgments — reading their headings…';
  var named=[];
  try{
    var d=await api('/api/library','POST',{
      action:'name_case_law_segments',
      segments:segs.map(function(sg){return {index:sg.index,excerpt:sg.excerpt};})
    });
    named=(d&&d.segments)||[];
  }catch(e){
    /* Naming is a convenience. Fall through with blanks for the user to fill. */
    console.log('clDetectSegments naming failed:',e.message);
  }
  var byIndex={};
  named.forEach(function(n){byIndex[n.index]=n;});
  return segs.map(function(sg){
    var n=byIndex[sg.index]||{};
    return {
      index:sg.index,pages:sg.pages,charCount:sg.charCount,
      name:n.name||'',citation:n.citation||'',jurisdiction:n.jurisdiction||'',
      keep:true
    };
  });
}

function clRenderSegments(){
  var wrap=clSegmentsPanel();
  if(!wrap)return;
  if(!clSegments||!clSegments.length){wrap.style.display='none';wrap.innerHTML='';return;}
  wrap.style.display='';
  var kept=clSegments.filter(function(s){return s.keep;}).length;
  wrap.innerHTML=
    '<div style="font-size:.75rem;font-weight:700;color:var(--text-mid);margin-bottom:.25rem">'
      +'This file looks like '+clSegments.length+' separate authorities</div>'
    +'<div style="font-size:.7rem;color:var(--text-faint);margin-bottom:.35rem">'
      +'Check the names — they were read from each heading. Untick anything you do not want stored.</div>'
    +clSegments.map(function(sg,i){
      return '<div style="border:1px solid var(--border);border-radius:5px;padding:.3rem;margin-bottom:.25rem">'
        +'<label class="draft-doc-check" style="padding:0;margin-bottom:.2rem">'
          +'<input type="checkbox"'+(sg.keep?' checked':'')+' onchange="clSegmentToggle('+i+',this.checked)"> '
          +'<span style="font-size:.72rem;color:var(--text-faint)">'+Math.round(sg.charCount/1000)+'k characters</span>'
        +'</label>'
        +'<input class="lib-search-input" style="margin-bottom:.2rem;font-size:.78rem" placeholder="Case or work name" '
          +'value="'+esc(sg.name)+'" oninput="clSegmentEdit('+i+',\'name\',this.value)">'
        +'<input class="lib-search-input" style="margin-bottom:0;font-size:.78rem" placeholder="Citation" '
          +'value="'+esc(sg.citation)+'" oninput="clSegmentEdit('+i+',\'citation\',this.value)">'
        +'</div>';
    }).join('')
    +'<button class="btn-primary" style="width:100%;padding:.35rem;font-size:.82rem;margin-bottom:.25rem" onclick="clUploadSet()">'
      +'Store '+kept+' separate '+(kept===1?'entry':'entries')+'</button>'
    +'<button class="lib-box-btn" style="width:100%;padding:.3rem;font-size:.78rem" onclick="clUploadAsOne()">'
      +'No — store the file as one entry</button>';
}

function clSegmentToggle(i,on){
  if(!clSegments||!clSegments[i])return;
  clSegments[i].keep=!!on;
  clRenderSegments();
}

function clSegmentEdit(i,field,value){
  if(!clSegments||!clSegments[i])return;
  clSegments[i][field]=value;
}

/* Dismiss the panel and upload the whole file as one entry, exactly as the
   single-case path always has. */
function clUploadAsOne(){
  clSegments=null;
  clRenderSegments();
  clUpload();
}

/* Store each ticked segment as its own library entry, in order. The shared
   fields — doc type, subject, sub-tags, jurisdiction, dual-link — come from
   the form and apply to all of them; name and citation are per case. */
async function clUploadSet(resume){
  var chosen=(clSegments||[]).filter(function(s){return s.keep;});
  if(!chosen.length){showToast('Nothing ticked');return;}
  var missing=chosen.filter(function(s){return !s.name.trim();});
  if(missing.length){showToast('Give every ticked authority a name');return;}

  var linkBox=document.getElementById('clUpMatterLink');
  var wantsLink=!!(linkBox&&linkBox.checked);
  if(wantsLink&&!currentMatter){showToast('No matter open — open one first, or untick the dual-link box');return;}

  var docType=document.getElementById('clUpDocType').value;
  var jur=document.getElementById('clUpJur').value;
  var subjectId=document.getElementById('clUpSubject').value;
  var subTags=document.getElementById('clUpTags').value;
  var baseName=(clPendingFile&&clPendingFile.name)||'authorities.pdf';
  var startAt=(resume&&typeof resume.caseIndex==='number')?resume.caseIndex:0;
  var st=document.getElementById('clUpStatus');

  for(var i=startAt;i<chosen.length;i++){
    var sg=chosen[i];
    st.style.display='';
    st.textContent='Storing '+(i+1)+' of '+chosen.length+': '+sg.name+'…';
    var meta={
      docType:docType,
      name:sg.name.trim(),
      citation:sg.citation.trim(),
      jurisdiction:sg.jurisdiction.trim()||jur,
      subjectId:subjectId,
      subTags:subTags,
      /* One file, several entries: each carries the file name so they can be
         traced back to the bundle they came from. */
      fileName:baseName,
      fileSize:(clPendingFile&&clPendingFile.size)||0,
      wantsLink:wantsLink,
      matterId:wantsLink?currentMatter.id:null,
      matterName:wantsLink?currentMatter.name:'',
      pages:sg.pages,
      partOfSet:true
    };
    var ok=await clRunUpload(meta,null);
    if(!ok){
      /* clFail has already written what went wrong and a Retry link for the
         batch. Record which case to restart at so the set can carry on. */
      clSetResume={caseIndex:i};
      st.innerHTML=st.innerHTML
        +'<div style="color:var(--text-faint)">Stored '+i+' of '+chosen.length
        +'. <a href="#" onclick="event.preventDefault();clRetrySet()" style="color:var(--blue);font-weight:700">Retry from '+esc(sg.name)+'</a></div>';
      return;
    }
  }

  clSegments=null;clSetResume=null;clRenderSegments();
  clPendingText=null;clPendingPages=null;clPendingFile=null;
  var fileInput=document.getElementById('clUpFile');
  if(fileInput)fileInput.value='';
  document.getElementById('clUpName').value='';
  document.getElementById('clUpCitation').value='';
  document.getElementById('clUpTags').value='';
  if(linkBox)linkBox.checked=false;
  st.style.display='none';
  showToast('Stored '+chosen.length+' authorities'+(wantsLink?' and added them to '+currentMatter.name:''));
  if(wantsLink&&currentMatter){
    await loadDocuments(currentMatter.id);
    await loadMatters();
  }
  await loadLibrary();
}

async function clRetrySet(){
  if(!clSetResume){showToast('Nothing to retry');return;}
  var at=clSetResume.caseIndex;
  clSetResume=null;clResume=null;
  await clUploadSet({caseIndex:at});
}


/* ══ v5.67: BULK TIDY FOR MATTER-NAMED PRECEDENTS ═════════════════════════
   Renaming these one at a time is a chore, and the reason they need renaming
   at all is a prompt that has since been fixed — so this is a one-off clear
   up rather than a permanent workflow. It finds every precedent whose name
   matches one of the user's matters, proposes a template name for each from
   the text stored at upload, and links it to that matter in the same save.

   Nothing is renamed without being seen: suggestions land in editable boxes,
   rows can be unticked, and Apply is a separate press. */
var libTidyRows=[];

function libTidyOpen(){
  libTidyRows=(libraryData.precedents||[])
    .map(function(p){
      var matter=libMatchingMatterName(p.name);
      /* v5.68: action is what happens on Apply — rename it, delete it, or
         leave it alone. Rename is the default: deleting is the one choice
         here that cannot be undone. */
      return matter?{id:p.id,original:p.name,proposed:'',matter:matter,action:'rename',note:''}:null;
    })
    .filter(Boolean)
    .sort(function(a,b){return libNameSort(a.original,b.original);});

  /* Flag same-named entries — this library has duplicate uploads, and a
     rename is a good moment to notice them. */
  var seen={};
  libTidyRows.forEach(function(r){
    var k=libNormaliseName(r.original);
    seen[k]=(seen[k]||0)+1;
  });
  libTidyRows.forEach(function(r){
    if(seen[libNormaliseName(r.original)]>1)r.note='duplicate name';
  });

  libTidyRender();
  document.getElementById('libTidyModal').style.display='flex';
}

function libTidyRender(){
  var wrap=document.getElementById('libTidyList');
  if(!wrap)return;
  if(!libTidyRows.length){
    wrap.innerHTML='<div style="font-size:.85rem;color:var(--text-faint);padding:.6rem">No precedent is named after one of your matters. Nothing to tidy.</div>';
    return;
  }
  wrap.innerHTML=libTidyRows.map(function(r,i){
    var deleting=r.action==='delete';
    return '<div style="border:1px solid '+(deleting?'var(--error)':'var(--border)')+';border-radius:6px;padding:.45rem;margin-bottom:.4rem">'
      +'<div style="display:flex;align-items:center;gap:.4rem;margin-bottom:.3rem">'
        +'<span style="flex:1;font-weight:600'+(deleting?';text-decoration:line-through;color:var(--text-faint)':'')+'">'+esc(r.original)+'</span>'
        +'<span style="font-size:.72rem;color:var(--text-faint);flex-shrink:0">from '+esc(r.matter)+'</span>'
        +(r.note?'<span style="font-size:.72rem;color:var(--error);flex-shrink:0">'+esc(r.note)+'</span>':'')
        +'<select class="lib-select" style="flex-shrink:0;width:auto;font-size:.78rem;padding:.2rem .35rem" onchange="libTidySetAction('+i+',this.value)">'
          +'<option value="rename"'+(r.action==='rename'?' selected':'')+'>Rename</option>'
          +'<option value="delete"'+(deleting?' selected':'')+'>Delete</option>'
          +'<option value="leave"'+(r.action==='leave'?' selected':'')+'>Leave alone</option>'
        +'</select>'
      +'</div>'
      +(r.action==='rename'
        ? '<input class="lib-search-input" style="margin-bottom:0;font-size:.82rem" placeholder="New name — e.g. Skeleton Argument — unfair prejudice" '
            +'value="'+esc(r.proposed)+'" oninput="libTidyEdit('+i+',this.value)">'
        : '<div style="font-size:.75rem;color:var(--text-faint)">'
            +(deleting?'Will be deleted, with its stored text. This cannot be undone.':'Left as it is.')
          +'</div>')
      +'</div>';
  }).join('');
}

function libTidySetAction(i,v){
  if(!libTidyRows[i])return;
  libTidyRows[i].action=(v==='delete'||v==='leave')?v:'rename';
  libTidyRender();
}
function libTidyEdit(i,v){ if(libTidyRows[i]){libTidyRows[i].proposed=v;} }

function libTidyStatus(text,colour){
  var el=document.getElementById('libTidyStatus');
  if(!el)return;
  el.style.display='';
  el.style.color=colour||'var(--blue)';
  el.textContent=text;
}

/* Read each precedent's stored text back and ask for a template name. Run in
   sequence rather than at once: this is a handful of documents, and a burst
   of parallel calls to the analyse endpoint buys nothing. */
async function libTidySuggestAll(){
  var todo=libTidyRows.filter(function(r){return r.action==='rename'&&!r.proposed.trim();});
  if(!todo.length){libTidyStatus('Nothing to suggest — every row being renamed already has a name.','var(--text-faint)');return;}
  var btn=document.getElementById('libTidySuggestBtn');
  if(btn)btn.disabled=true;
  var done=0,failed=0;
  for(var i=0;i<todo.length;i++){
    var r=todo[i];
    libTidyStatus('Reading '+(i+1)+' of '+todo.length+': '+r.original+'…');
    try{
      var ch=await api('/api/library?type=prec_chunks&prec_id='+encodeURIComponent(r.id));
      var chunks=(ch&&ch.data)||[];
      if(!chunks.length){r.note='no stored text — type a name';failed++;continue;}
      var snippet=chunks.map(function(c){return c.content;}).join('\n\n').slice(0,2000);
      var d=await api('/api/analyse','POST',{matterId:'',matterName:'',matterNature:'',matterIssues:'',messages:[{role:'user',content:PREC_NAME_PROMPT+snippet}],jurisdiction:jurisdiction,queryType:'Factual Analysis',focusAreas:[]});
      var suggested=(d&&d.result)?d.result.trim().replace(/^["']|["']$/g,'').slice(0,120):'';
      if(libMatchingMatterName(suggested)){r.note='suggestion named the matter — type a name';failed++;continue;}
      if(suggested&&suggested.length>2){r.proposed=suggested;done++;}
      else{r.note='no suggestion — type a name';failed++;}
    }catch(e){
      r.note='could not read: '+e.message;failed++;
    }
    libTidyRender();
  }
  if(btn)btn.disabled=false;
  libTidyStatus('Suggested '+done+' of '+todo.length
    +(failed?' — '+failed+(failed===1?' needs':' need')+' a name typed in.':'. Check them, then Apply.'),
    failed?'var(--error)':'var(--success)');
}

/* Apply what each row was set to: rename it with its source matter, delete it
   outright, or leave it. Deleting is confirmed once, by name, because it takes
   the stored text with it and cannot be undone. */
async function libTidyApply(){
  var renames=libTidyRows.filter(function(r){return r.action==='rename'&&r.proposed.trim();});
  var deletes=libTidyRows.filter(function(r){return r.action==='delete';});
  if(!renames.length&&!deletes.length){
    libTidyStatus('Nothing to apply — set a row to Rename and give it a name, or to Delete.','var(--error)');
    return;
  }
  var stillNamed=renames.filter(function(r){return libMatchingMatterName(r.proposed);});
  if(stillNamed.length&&!confirm(stillNamed.length+' of these still carry a matter name. Save them anyway?'))return;
  if(deletes.length){
    var names=deletes.map(function(r){return '  • '+r.original;}).join('\n');
    if(!confirm('Delete '+deletes.length+' precedent'+(deletes.length===1?'':'s')+' and the text stored with '
      +(deletes.length===1?'it':'them')+'?\n\n'+names+'\n\nThis cannot be undone. The documents themselves are untouched — you can upload them again.'))return;
  }

  var btn=document.getElementById('libTidyApplyBtn');
  if(btn)btn.disabled=true;
  var renamed=0,removed=0;

  function stop(r,e){
    libTidyStatus('Stopped at "'+r.original+'": '+e.message
      +'. '+renamed+' renamed, '+removed+' deleted.','var(--error)');
    if(btn)btn.disabled=false;
  }

  for(var i=0;i<renames.length;i++){
    var r=renames[i];
    libTidyStatus('Renaming '+(i+1)+' of '+renames.length+'…');
    try{
      var matterId='';
      var list=(typeof matters!=='undefined'&&matters)?matters:[];
      for(var j=0;j<list.length;j++){ if(list[j].name===r.matter){matterId=list[j].id;break;} }
      await api('/api/library','POST',{
        action:'update_precedent',
        id:r.id,
        name:r.proposed.trim(),
        source_matter_id:matterId||null
      });
      renamed++;
    }catch(e){ stop(r,e); await loadLibrary(); return; }
  }

  for(var k=0;k<deletes.length;k++){
    var d=deletes[k];
    libTidyStatus('Deleting '+(k+1)+' of '+deletes.length+'…');
    try{
      /* The server deletes precedent_chunks before the row, so nothing is
         left behind to go on feeding the drafting prompt. */
      await api('/api/library','DELETE',{action:'delete_precedent',id:d.id});
      removed++;
    }catch(e){ stop(d,e); await loadLibrary(); return; }
  }

  if(btn)btn.disabled=false;
  var said=[];
  if(renamed)said.push('Renamed '+renamed);
  if(removed)said.push('deleted '+removed);
  libTidyStatus(said.join(', ')+'.','var(--success)');
  await loadLibrary();
  libTidyOpen();
}
