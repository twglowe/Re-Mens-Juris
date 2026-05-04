/* ── DRAFT TAB ────────────────────────────────────────────────────────────── */
/* v5.13b — 1 May 2026
   Major rewrite of matter-switching, autosave, and draft history.
   Changes from v5.11a (Draft Build 1):
   1. draftMatterChanged() now resets editor, dropdowns, picker state and
      reloads previous-drafts list. Previously it only updated the heading.
   2. New onDraftTabActivated() called from core.js's switchMainNav('draft')
      so the Draft tab syncs to currentMatter on every entry.
   3. New "Previous drafts" modal: lists all drafts for current matter,
      newest first, with click-to-load and delete-row buttons.
   4. Autosave now PUTs to existing draft row (was POST every time, which
      created a new row per keystroke debounce — bug fixed).
   5. New currentDraftId / unsavedEdits state. Unsaved edits prompt before
      switching matter.
   6. Generate Draft now creates a new row in drafts table after worker
      completes, so generated drafts persist and appear in Previous drafts.
   7. New Save button (small) for attaching unsaved editor text to a row
      without going through Generate. */

/* v5.13b state. Module-scope so all draft functions share. */
var currentDraftId = null;
var unsavedEdits = false;
var previousDraftsList = [];

/* ── DRAFT TAB (continued) ─────────────────────────────────────────────── */
/* v5.11a (Draft Build 1) — 30 Apr 2026
   1. Jurisdiction is read silently from the selected matter (currentMatter
      or the matter chosen via draftMatterSelect). The global `jurisdiction`
      variable is no longer used by the Draft tab.
   2. draftAISuggestHeading reads up to 5 matter documents (was: 1).
   3. New "Documents to exclude from this draft" picker; unticked matter
      docs flow through to the worker as excludeDocNames.
   4. Tool-history outputs (briefing / issues / chronology / etc.) for the
      current matter are passed into the draft prompt as matterToolHistory.
   5. New "Learn from comparable documents in other matters" checkbox,
      default on. Wired through API as body.learnFromComparable but no
      worker behaviour yet — that arrives in a later build. */

/* draftJur — read jurisdiction from the matter currently selected in the
   Draft tab, falling back to currentMatter, then to the global default.
   The Draft tab does not consult the top-level jurisdiction selector. */
function draftJur(){
  var sel=document.getElementById('draftMatterSelect');
  var id=sel?sel.value:'';
  if(id){
    var m=matters.find(function(x){return x.id===id;});
    if(m&&m.jurisdiction)return m.jurisdiction;
  }
  if(currentMatter&&currentMatter.jurisdiction)return currentMatter.jurisdiction;
  return 'Bermuda';
}

function libPopulateDraftSelects(){
  var ct=document.getElementById('draftCaseType');
  if(!ct)return;
  ct.innerHTML='<option value="">— Select —</option>'+libraryData.caseTypes.map(function(c){return '<option value="'+c.id+'">'+esc(c.name)+'</option>';}).join('');
  document.getElementById('draftStage').innerHTML='<option value="">— Select —</option>';
  document.getElementById('draftDocType').innerHTML='<option value="">— Select —</option>';
  /* Populate matter dropdown */
  var ms=document.getElementById('draftMatterSelect');
  if(ms){
    var val=ms.value;
    ms.innerHTML='<option value="">— Select matter —</option>'+matters.map(function(m){return '<option value="'+m.id+'">'+esc(m.name)+'</option>';}).join('');
    if(val)ms.value=val;
    if(currentMatter&&!val)ms.value=currentMatter.id;
  }
  /* v2.5: Populate precedent case type filter */
  var pct=document.getElementById('draftPrecCaseType');
  if(pct){
    var pval=pct.value;
    pct.innerHTML='<option value="">— Filter by case type —</option>'+libraryData.caseTypes.map(function(c){return '<option value="'+c.id+'">'+esc(c.name)+'</option>';}).join('');
    if(pval)pct.value=pval;
  }
  /* Also update upload modal dropdowns if open */
  var precUpCt=document.getElementById('precUpCaseType');
  if(precUpCt){
    var pucVal=precUpCt.value;
    precUpCt.innerHTML=libraryData.caseTypes.map(function(c){return '<option value="'+c.id+'">'+esc(c.name)+'</option>';}).join('');
    if(pucVal)precUpCt.value=pucVal;
    precUpCaseTypeChanged();
  }
}

function draftMatterChanged(){
  var id=document.getElementById('draftMatterSelect').value;
  if(!id)return;
  var m=matters.find(function(x){return x.id===id;});
  if(!m)return;

  /* v5.13c: update the always-visible matter context labels. */
  var ctxName=document.getElementById('draftMatterContextName');
  if(ctxName)ctxName.textContent=m.name||'(unnamed matter)';
  var lblText=document.getElementById('draftMatterLabelText');
  if(lblText)lblText.textContent=m.name||'(unnamed matter)';

  /* v5.13b: full reset of Draft tab state for the new matter. */

  /* Clear editor */
  var editor=document.getElementById('draftEditor');
  if(editor)editor.innerHTML='';

  /* Reset Library dropdowns */
  var ct=document.getElementById('draftCaseType');
  if(ct)ct.value='';
  var st=document.getElementById('draftStage');
  if(st){st.innerHTML='<option value="">— Select —</option>';}
  var dt=document.getElementById('draftDocType');
  if(dt){dt.innerHTML='<option value="">— Select —</option>';}

  /* Reset doc picker state (used by draftSelectDoc / draftRemoveDoc) */
  draftSelectedDocs={src1:[],src2:[],src3:[],ctx:[],prec:[]};
  draftSelectedPrecedents=[];
  if(typeof renderDraftPickedDocs==='function')renderDraftPickedDocs();
  if(typeof renderDraftPickedPrecedents==='function')renderDraftPickedPrecedents();

  /* Reset main-instructions textarea */
  var mi=document.getElementById('draftMainInstructions');
  if(mi)mi.value='';

  /* Reset heading from matter */
  draftHeading={party1:'',party1Role:'',party2:'',party2Role:'',court:'',caseNo:'',docTitle:''};
  if(m.name){
    var parts=m.name.split(/\s+v\s+/i);
    if(parts.length>=2){
      draftHeading.party1=parts[0].trim().toUpperCase();
      draftHeading.party2=parts[1].replace(/\s*[-—–].*/,'').trim().toUpperCase();
    }
    if(m.acting_for){
      draftHeading.party1Role=m.acting_for;
      var roles={'Plaintiff':'Defendant','Defendant':'Plaintiff','Appellant':'Respondent','Respondent':'Appellant','Petitioner':'Respondent','Applicant':'Respondent'};
      draftHeading.party2Role=roles[m.acting_for]||'';
    }
    if(m.jurisdiction){
      var courts={'Bermuda':'IN THE SUPREME COURT OF BERMUDA','Cayman Islands':'IN THE GRAND COURT OF THE CAYMAN ISLANDS','British Virgin Islands':'IN THE HIGH COURT OF JUSTICE OF THE VIRGIN ISLANDS'};
      draftHeading.court=courts[m.jurisdiction]||'';
    }
  }
  updateActionHeading();

  /* Reset draft-row state */
  currentDraftId=null;
  unsavedEdits=false;

  /* Hide Save button (no unattached editor content yet) */
  var saveBtn=document.getElementById('saveDraftBtn');
  if(saveBtn)saveBtn.style.display='none';

  /* Load matter docs and previous drafts in parallel; AI heading suggestion
     fires after matter docs are ready. */
  loadDraftMatterDocs(id).then(function(){
    draftAISuggestHeading(id);
  });
  loadDraftsForMatter(id);
}

/* v5.13b: Sync the Draft tab to currentMatter on tab activation. Called
   from core.js's switchMainNav('draft'). Handles the matter-switch path
   too — if the user switched matter while already on the Draft tab and
   then the dropdown is out of sync with currentMatter, we reconcile.
   Also prompts about unsaved edits before discarding. */
function onDraftTabActivated(){
  var sel=document.getElementById('draftMatterSelect');
  if(!sel)return;
  /* If currentMatter exists and the dropdown is empty or pointing at a
     different matter, sync. */
  var targetId=(typeof currentMatter!=='undefined'&&currentMatter)?currentMatter.id:null;
  var currentVal=sel.value||null;

  /* v5.13c: if no currentMatter, show "select from Matters tab" prompt. */
  if(!targetId){
    var ctxName=document.getElementById('draftMatterContextName');
    if(ctxName)ctxName.textContent='Select a matter from the Matters tab';
    var lblText=document.getElementById('draftMatterLabelText');
    if(lblText)lblText.textContent='(select a matter first)';
    return;
  }

  if(targetId&&targetId!==currentVal){
    /* Unsaved edits guard */
    if(unsavedEdits){
      var targetName=currentMatter.name||'this matter';
      if(!confirm('You have unsaved changes in the current draft. Discard and switch to '+targetName+'?')){
        return;
      }
    }
    sel.value=targetId;
    draftMatterChanged();
    return;
  }
  /* Same matter, but on first entry the editor is still blank; load
     drafts list count so the Previous drafts button shows correct N. */
  if(targetId&&previousDraftsList.length===0){
    loadDraftsForMatter(targetId);
  }
}

/* v5.13b: Fetch all drafts for a matter; populate previousDraftsList and
   update the badge count on the Previous drafts button. */
async function loadDraftsForMatter(matterId){
  if(!matterId)return;
  try{
    var d=await api('/api/drafts?matter_id='+matterId,'GET');
    previousDraftsList=(d&&d.drafts)?d.drafts:[];
    updatePrevDraftsBadge();
  }catch(e){
    console.log('loadDraftsForMatter failed:',e.message);
    previousDraftsList=[];
    updatePrevDraftsBadge();
  }
}

function updatePrevDraftsBadge(){
  var span=document.getElementById('prevDraftsCount');
  if(span)span.textContent=previousDraftsList.length;
}

/* v5.13b: Open the Previous drafts modal. Renders the list from current
   previousDraftsList. Click row to load, click × to delete, click backdrop
   or Esc to close. */
function showPreviousDraftsModal(){
  var modal=document.getElementById('prevDraftsModal');
  if(!modal)return;
  var list=document.getElementById('prevDraftsList');
  if(!list)return;
  if(previousDraftsList.length===0){
    list.innerHTML='<div style="padding:1rem;color:var(--text-faint);font-style:italic;text-align:center">No previous drafts for this matter.</div>';
  }else{
    list.innerHTML=previousDraftsList.map(function(d){
      var dt=d.created_at?new Date(d.created_at):null;
      var dateStr=dt?dt.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})+', '+dt.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}):'Unknown date';
      var dtName='';
      if(d.doc_type_id&&libraryData&&libraryData.docTypes){
        var dtRow=libraryData.docTypes.find(function(x){return x.id===d.doc_type_id;});
        if(dtRow)dtName=dtRow.name;
      }
      var instr=(d.instructions||'').slice(0,80);
      if((d.instructions||'').length>80)instr+='…';
      return '<div class="prev-draft-row" data-id="'+esc(d.id)+'" style="display:flex;gap:.6rem;align-items:flex-start;padding:.6rem;border-bottom:1px solid var(--border);cursor:pointer" onclick="loadDraftIntoEditor(\''+esc(d.id)+'\')">'+
        '<div style="flex:1;min-width:0">'+
          '<div style="font-size:.78rem;color:var(--text-faint)">'+esc(dateStr)+(dtName?' · '+esc(dtName):'')+'</div>'+
          '<div style="font-size:.85rem;margin-top:.2rem;overflow:hidden;text-overflow:ellipsis">'+esc(instr||'(no instructions)')+'</div>'+
        '</div>'+
        '<button onclick="event.stopPropagation();deleteDraftFromList(\''+esc(d.id)+'\')" title="Delete this draft" style="background:none;border:none;font-size:1.1rem;color:var(--text-faint);cursor:pointer;padding:.2rem .4rem">×</button>'+
      '</div>';
    }).join('');
  }
  modal.style.display='flex';
}

function closePreviousDraftsModal(){
  var modal=document.getElementById('prevDraftsModal');
  if(modal)modal.style.display='none';
}

/* v5.13b: Load an existing draft into the editor. Sets currentDraftId so
   subsequent autosave PUTs to the same row. Closes the modal. */
async function loadDraftIntoEditor(draftId){
  if(!draftId)return;
  if(unsavedEdits){
    if(!confirm('You have unsaved changes. Discard and load this draft?')){
      return;
    }
  }
  var d=previousDraftsList.find(function(x){return x.id===draftId;});
  if(!d){showToast('Draft not found');return;}
  /* Populate editor */
  var editor=document.getElementById('draftEditor');
  if(editor)editor.innerHTML=renderMd(d.draft_content||'');
  /* Populate heading */
  if(d.heading_data){
    try{
      var h=typeof d.heading_data==='string'?JSON.parse(d.heading_data):d.heading_data;
      if(h&&typeof h==='object'){
        draftHeading.party1=h.party1||'';
        draftHeading.party1Role=h.party1Role||'';
        draftHeading.party2=h.party2||'';
        draftHeading.party2Role=h.party2Role||'';
        draftHeading.court=h.court||'';
        draftHeading.caseNo=h.caseNo||'';
        draftHeading.docTitle=h.docTitle||'';
        updateActionHeading();
      }
    }catch(pe){console.log('heading_data parse skip:',pe.message);}
  }
  /* Populate Library dropdowns. Case type populates first (which rebuilds
     stage/doctype options), then we set stage and doctype values. */
  if(d.case_type_id){
    var ct=document.getElementById('draftCaseType');
    if(ct){ct.value=d.case_type_id;draftCaseTypeChanged();}
  }
  if(d.subcat_id){
    var st=document.getElementById('draftStage');
    if(st)st.value=d.subcat_id;
  }
  if(d.doc_type_id){
    var dt=document.getElementById('draftDocType');
    if(dt)dt.value=d.doc_type_id;
  }
  /* Populate instructions */
  var mi=document.getElementById('draftMainInstructions');
  if(mi)mi.value=d.instructions||'';
  currentDraftId=draftId;
  unsavedEdits=false;
  var saveBtn=document.getElementById('saveDraftBtn');
  if(saveBtn)saveBtn.style.display='none';
  closePreviousDraftsModal();
}

/* v5.13b: Delete a draft row. If it was the currently-loaded draft, blank
   the editor and clear currentDraftId. */
async function deleteDraftFromList(draftId){
  if(!draftId)return;
  if(!confirm('Delete this draft permanently?'))return;
  try{
    await api('/api/drafts?id='+draftId,'DELETE');
    /* Remove locally */
    previousDraftsList=previousDraftsList.filter(function(d){return d.id!==draftId;});
    updatePrevDraftsBadge();
    /* If this was the loaded draft, blank the editor */
    if(currentDraftId===draftId){
      var editor=document.getElementById('draftEditor');
      if(editor)editor.innerHTML='';
      currentDraftId=null;
      unsavedEdits=false;
    }
    /* Refresh modal if open */
    var modal=document.getElementById('prevDraftsModal');
    if(modal&&modal.style.display!=='none')showPreviousDraftsModal();
    showToast('Draft deleted');
  }catch(e){
    showToast('Delete failed: '+e.message);
  }
}

/* v5.13b: Save unattached editor content as a new draft row. Called by the
   small Save button which is only visible when currentDraftId is null and
   editor has content. */
async function saveCurrentDraft(){
  var matterId=document.getElementById('draftMatterSelect').value;
  if(!matterId){showToast('Select a matter first');return;}
  var editor=document.getElementById('draftEditor');
  var content=editor?editor.innerText||'':'';
  if(!content.trim()){showToast('Nothing to save');return;}
  try{
    var payload={
      matter_id:matterId,
      case_type_id:document.getElementById('draftCaseType').value||null,
      subcat_id:document.getElementById('draftStage').value||null,
      doc_type_id:document.getElementById('draftDocType').value||null,
      heading_data:JSON.stringify(draftHeading),
      instructions:document.getElementById('draftMainInstructions').value||'',
      draft_content:content
    };
    var d=await api('/api/drafts','POST',payload);
    if(d&&d.draft&&d.draft.id){
      currentDraftId=d.draft.id;
      previousDraftsList.unshift(d.draft);
      updatePrevDraftsBadge();
    }
    unsavedEdits=false;
    var saveBtn=document.getElementById('saveDraftBtn');
    if(saveBtn)saveBtn.style.display='none';
    showToast('Saved');
  }catch(e){
    showToast('Save failed: '+e.message);
  }
}

async function loadDraftMatterDocs(matterId){
  try{
    var d=await api('/api/documents?matter_id='+matterId);
    var docs=d&&d.documents?d.documents:[];
    /* Populate Sector 1 doc list */
    var wrap=document.getElementById('draftMatterDocsWrap');
    var list=document.getElementById('draftMatterDocs');
    if(docs.length){
      wrap.style.display='';
      list.innerHTML=docs.map(function(doc){return '<label class="draft-doc-check"><input type="checkbox" value="'+doc.id+'" data-name="'+esc(doc.name)+'"> '+esc(doc.name)+' <span style="font-size:.7rem;color:var(--text-faint)">['+esc(doc.doc_type)+']</span></label>';}).join('');
    }else{wrap.style.display='none';}
    /* Populate Sector 2 doc selects — Instructions, Response, Context */
    var docOpts=docs.map(function(doc){return '<option value="'+doc.id+'">'+esc(doc.name)+' ['+esc(doc.doc_type)+']</option>';}).join('');
    document.getElementById('draftSrcDoc1').innerHTML='<option value="">— Select from matter —</option>'+docOpts;
    document.getElementById('draftSrcDoc2').innerHTML='<option value="">— Select from matter —</option>'+docOpts;
    document.getElementById('draftCtxDoc').innerHTML='<option value="">— Select from matter —</option>'+docOpts;
    /* Background select — matter docs + tool outputs from history */
    var histDocs=[];
    try{var hd=await api('/api/history?matter_id='+matterId);histDocs=(hd&&hd.history?hd.history:[]).filter(function(h){return h.tool_name;});}catch(e){}
    var bgOpts=docs.map(function(doc){return '<option value="doc:'+doc.id+'">📄 '+esc(doc.name)+'</option>';}).join('')
      +histDocs.map(function(h){return '<option value="hist:'+h.id+'">🔧 '+esc(h.tool_name+': '+h.question.slice(0,50))+'</option>';}).join('');
    document.getElementById('draftSrcDoc3').innerHTML='<option value="">— Select doc or tool output —</option>'+bgOpts;
    /* Reset selected docs for new matter */
    draftSelectedDocs={src1:[],src2:[],src3:[],ctx:[]};
    draftSelectedPrecedents=[];
    renderDraftSelectedDocs('src1');renderDraftSelectedDocs('src2');renderDraftSelectedDocs('src3');renderDraftSelectedDocs('ctx');renderDraftSelectedPrecs();
    /* v5.11a: populate "documents to exclude" picker (default: every doc ticked) */
    populateDraftExcludePicker(docs);
  }catch(e){console.error('loadDraftMatterDocs:',e);}
}

/* v5.11a: populate the exclude picker. All docs ticked by default; unticked
   docs flow into excludeDocNames at draft time. */
function populateDraftExcludePicker(docs){
  var wrap=document.getElementById('draftExcludeWrap');
  var list=document.getElementById('draftExcludeList');
  if(!wrap||!list)return;
  if(!docs||!docs.length){wrap.style.display='none';return;}
  wrap.style.display='';
  list.innerHTML=docs.map(function(doc){
    return '<label style="display:flex;align-items:center;gap:.4rem;padding:.15rem .25rem;cursor:pointer"><input type="checkbox" class="draft-exclude-cb" data-name="'+esc(doc.name)+'" checked onchange="updateDraftExcludeCounter()" style="margin:0"><span style="flex:1;font-size:.76rem">'+esc(doc.name)+'</span><span style="font-size:.68rem;color:var(--text-faint)">['+esc(doc.doc_type||'Other')+']</span></label>';
  }).join('');
  updateDraftExcludeCounter();
}

function updateDraftExcludeCounter(){
  var counter=document.getElementById('draftExcludeCounter');
  if(!counter)return;
  var boxes=document.querySelectorAll('#draftExcludeList .draft-exclude-cb');
  var total=boxes.length;
  var ticked=0;
  for(var i=0;i<boxes.length;i++){if(boxes[i].checked)ticked++;}
  if(total===0){counter.textContent='';return;}
  counter.textContent='('+ticked+' of '+total+' included)';
}

/* v5.11a: read currently-unticked doc names from the exclude picker.
   Returns array of document names (matches the worker's excludeDocNames
   contract — names not IDs). */
function getDraftExcludeDocNames(){
  var boxes=document.querySelectorAll('#draftExcludeList .draft-exclude-cb');
  var excluded=[];
  for(var i=0;i<boxes.length;i++){
    if(!boxes[i].checked){
      var name=boxes[i].getAttribute('data-name');
      if(name)excluded.push(name);
    }
  }
  return excluded;
}

function draftCaseTypeChanged(){
  var ctId=document.getElementById('draftCaseType').value;
  document.getElementById('draftStage').innerHTML='<option value="">— Select —</option>'+libraryData.subcats.filter(function(s){return s.case_type_id===ctId;}).map(function(s){return '<option value="'+s.id+'">'+esc(s.name)+'</option>';}).join('');
  document.getElementById('draftDocType').innerHTML='<option value="">— Select —</option>'+libraryData.docTypes.filter(function(d){return d.case_type_id===ctId;}).map(function(d){return '<option value="'+d.id+'">'+esc(d.name)+'</option>';}).join('');
  draftAutoSaveChoices();
}
function draftStageChanged(){draftAutoSaveChoices();}

/* v5.13b: Auto-save draft choices. PUT to existing currentDraftId row;
   never spawn new rows. If currentDraftId is null, the user has typed
   into a blank editor without generating or clicking Save — they must
   click Save explicitly to attach the editor to a row. We mark
   unsavedEdits so matter-switch will warn. */
var _draftAutoSaveTimer=null;
function draftAutoSaveChoices(){
  unsavedEdits=true;
  /* Show save button if we have unattached editor content */
  var editor=document.getElementById('draftEditor');
  var hasContent=editor&&(editor.innerText||'').trim().length>0;
  var saveBtn=document.getElementById('saveDraftBtn');
  if(saveBtn){
    if(currentDraftId){
      saveBtn.style.display='none';
    }else if(hasContent){
      saveBtn.style.display='';
    }else{
      saveBtn.style.display='none';
    }
  }
  if(_draftAutoSaveTimer)clearTimeout(_draftAutoSaveTimer);
  _draftAutoSaveTimer=setTimeout(function(){
    if(!currentDraftId)return; /* Don't autosave unattached content */
    var matterId=document.getElementById('draftMatterSelect').value;
    if(!matterId)return;
    var content='';
    var ed=document.getElementById('draftEditor');
    if(ed)content=ed.innerText||'';
    var payload={
      case_type_id:document.getElementById('draftCaseType').value||null,
      subcat_id:document.getElementById('draftStage').value||null,
      doc_type_id:document.getElementById('draftDocType').value||null,
      heading_data:JSON.stringify(draftHeading),
      instructions:document.getElementById('draftMainInstructions').value||'',
      draft_content:content
    };
    api('/api/drafts?id='+currentDraftId,'PUT',payload).then(function(){
      unsavedEdits=false;
    }).catch(function(e){console.log('Draft auto-save:',e.message);});
  },1500);
}

/* When Doc Type changes, update the doc title in the heading if not already set manually */
var draftDocTypeEl=document.getElementById('draftDocType');
if(draftDocTypeEl){draftDocTypeEl.addEventListener('change',function(){
  var dtName=getSelectedDocTypeName();
  if(dtName&&!draftHeading.docTitle){
    draftHeading.docTitle=dtName.toUpperCase();
    updateActionHeading();
  }
  draftAutoSaveChoices();
});}
/* C3: Auto-save when instructions change */
var draftInstrEl=document.getElementById('draftMainInstructions');
if(draftInstrEl){draftInstrEl.addEventListener('input',function(){draftAutoSaveChoices();});}

/* v5.13b: Auto-save when editor content changes. The editor is a
   contenteditable div, so we listen for 'input' the same way. */
var draftEditorEl=document.getElementById('draftEditor');
if(draftEditorEl){draftEditorEl.addEventListener('input',function(){draftAutoSaveChoices();});}

/* v5.13b: Esc closes the Previous drafts modal. */
document.addEventListener('keydown',function(ev){
  if(ev.key==='Escape'){
    var m=document.getElementById('prevDraftsModal');
    if(m&&m.style.display!=='none')closePreviousDraftsModal();
  }
});

/* v5.13b: Click on modal backdrop closes it. */
document.addEventListener('DOMContentLoaded',function(){
  var modal=document.getElementById('prevDraftsModal');
  if(modal){
    modal.addEventListener('click',function(ev){
      if(ev.target===modal)closePreviousDraftsModal();
    });
  }
});
/* Heading Editor */
function openHeadingEditor(){
  document.getElementById('hdCourt').value=draftHeading.court;
  document.getElementById('hdCaseNo').value=draftHeading.caseNo;
  document.getElementById('hdParty1').value=draftHeading.party1;
  document.getElementById('hdParty1Role').value=draftHeading.party1Role;
  document.getElementById('hdParty2').value=draftHeading.party2;
  document.getElementById('hdParty2Role').value=draftHeading.party2Role;
  document.getElementById('hdDocTitle').value=draftHeading.docTitle;
  updateHeadingPreview();
  document.getElementById('headingModal').style.display='flex';
}
function updateHeadingPreview(){
  var court=document.getElementById('hdCourt').value.trim();
  var caseNo=document.getElementById('hdCaseNo').value.trim();
  var p1=document.getElementById('hdParty1').value.trim();
  var p1r=document.getElementById('hdParty1Role').value.trim();
  var p2=document.getElementById('hdParty2').value.trim();
  var p2r=document.getElementById('hdParty2Role').value.trim();
  var title=document.getElementById('hdDocTitle').value.trim();
  var lines=[];
  if(court)lines.push(court);
  if(caseNo)lines.push(caseNo);
  lines.push('');
  lines.push('BETWEEN:');
  lines.push('');
  if(p1)lines.push(p1+(p1r?'          '+p1r:''));
  lines.push('— and —');
  if(p2)lines.push(p2+(p2r?'          '+p2r:''));
  if(title){lines.push('');lines.push('════════════════════════════════');lines.push(title);lines.push('════════════════════════════════');}
  document.getElementById('headingPreview').textContent=lines.join('\n');
}
function saveHeading(){
  draftHeading.court=document.getElementById('hdCourt').value.trim();
  draftHeading.caseNo=document.getElementById('hdCaseNo').value.trim();
  draftHeading.party1=document.getElementById('hdParty1').value.trim();
  draftHeading.party1Role=document.getElementById('hdParty1Role').value.trim();
  draftHeading.party2=document.getElementById('hdParty2').value.trim();
  draftHeading.party2Role=document.getElementById('hdParty2Role').value.trim();
  draftHeading.docTitle=document.getElementById('hdDocTitle').value.trim();
  closeModal('headingModal');
  updateHeadingBtnText();
  showToast('Heading saved');
  /* C2: If party names form a case name, offer to update the matter */
  var matterId=document.getElementById('draftMatterSelect').value;
  if(matterId&&draftHeading.party1&&draftHeading.party2){
    var m=matters.find(function(x){return x.id===matterId;});
    if(m){
      var newName=draftHeading.party1+' v '+draftHeading.party2;
      if(newName!==m.name&&confirm('Update the matter name to "'+newName+'"?')){
        api('/api/matters?id='+matterId,'PATCH',{name:newName}).then(function(){loadMatters();showToast('Matter name updated');}).catch(function(e){showToast('Error: '+e.message);});
      }
    }
  }
}
function updateActionHeading(){
  var btn=document.getElementById('draftHeadingBtn');
  var inlineHeading=document.getElementById('draftHeadingText');
  if(draftHeading.party1&&draftHeading.party2){
    btn.textContent=draftHeading.party1+' v '+draftHeading.party2;
    /* Build formatted heading HTML for the action heading area */
    var html='<div style="text-align:center;font-family:\'Libre Baskerville\',serif;line-height:1.7">';
    if(draftHeading.court)html+='<div style="font-size:.88rem;font-weight:700">'+esc(draftHeading.court)+'</div>';
    if(draftHeading.caseNo)html+='<div style="font-size:.85rem">'+esc(draftHeading.caseNo)+'</div>';
    html+='<div style="margin:.4rem 0;font-size:.85rem">BETWEEN:</div>';
    html+='<div style="font-size:.9rem;font-weight:700">'+esc(draftHeading.party1)+(draftHeading.party1Role?'<span style="font-weight:400;margin-left:2rem">'+esc(draftHeading.party1Role)+'</span>':'')+'</div>';
    html+='<div style="font-size:.82rem;margin:.2rem 0">— and —</div>';
    html+='<div style="font-size:.9rem;font-weight:700">'+esc(draftHeading.party2)+(draftHeading.party2Role?'<span style="font-weight:400;margin-left:2rem">'+esc(draftHeading.party2Role)+'</span>':'')+'</div>';
    /* Doc title in CAPS between bold bars */
    var docTitle=draftHeading.docTitle||getSelectedDocTypeName();
    if(docTitle){
      html+='<div style="margin:.6rem auto .2rem;width:80%;border-top:3px solid var(--navy)"></div>';
      html+='<div style="font-size:1rem;font-weight:700;letter-spacing:.08em">'+esc(docTitle.toUpperCase())+'</div>';
      html+='<div style="margin:.2rem auto .4rem;width:80%;border-top:3px solid var(--navy)"></div>';
    }
    html+='</div>';
    if(inlineHeading){inlineHeading.innerHTML=html;}
  }else{
    btn.textContent='Click to set heading…';
    if(inlineHeading)inlineHeading.textContent='Click to set action heading…';
  }
}
/* Alias for backward compatibility */
function updateHeadingBtnText(){updateActionHeading();}

function getSelectedDocTypeName(){
  var dtSel=document.getElementById('draftDocType');
  if(dtSel&&dtSel.value&&dtSel.selectedIndex>0)return dtSel.options[dtSel.selectedIndex].text;
  return '';
}

/* v5.11a: collect the most-recent analysis-tool result for each tool in
   the current matter's history. Returns array of {tool_name, question, answer}.
   Excludes 'draft' (worker already pulls past drafts separately) and
   'diagram' (not useful as text context). Truncates each answer so we
   stay inside the prompt budget. */
function collectMatterToolHistory(){
  if(!Array.isArray(matterHistory)||matterHistory.length===0)return [];
  var SKIP={draft:1,diagram:1};
  var TRUNC=4000;
  var seen={};
  var out=[];
  /* matterHistory is in chronological order; walk newest-first. */
  for(var i=matterHistory.length-1;i>=0;i--){
    var h=matterHistory[i];
    if(!h||!h.tool_name||SKIP[h.tool_name])continue;
    if(seen[h.tool_name])continue;
    seen[h.tool_name]=1;
    var ans=h.answer||'';
    if(ans.length>TRUNC)ans=ans.slice(0,TRUNC)+'\n\n[…truncated for context budget…]';
    out.push({tool_name:h.tool_name,question:(h.question||'').slice(0,300),answer:ans});
  }
  return out;
}

/* Generate Draft */
/* v3.4: generateDraft uses fire-and-poll background processing */
async function generateDraft(){
  var matterId=document.getElementById('draftMatterSelect').value;
  if(!matterId){showToast('Select a matter first');return;}
  var instructions=document.getElementById('draftMainInstructions').value.trim();
  if(!instructions){showToast('Please enter drafting instructions');return;}
  var ctId=document.getElementById('draftCaseType').value;
  var dtId=document.getElementById('draftDocType').value;
  var stId=document.getElementById('draftStage').value;
  document.getElementById('draftGenerateBtn').disabled=true;
  var prog=document.getElementById('draftProgressMsg');prog.style.display='';prog.textContent='Submitting draft request\u2026';
  try{
    var body={matterId:matterId,tool:'draft',instructions:instructions,jurisdiction:draftJur(),actingFor:'',courtHeading:draftHeading};
    if(ctId)body.caseTypeId=ctId;
    if(dtId)body.docTypeId=dtId;
    if(stId)body.subcatId=stId;
    var m=matters.find(function(x){return x.id===matterId;});
    if(m){body.actingFor=m.acting_for||'';body.matterName=m.name;body.matterNature=m.nature||'';body.matterIssues=m.issues||'';}
    if(draftSelectedPrecedents.length>0){
      var ctName='';var ct=libraryData.caseTypes.find(function(c){return c.id===ctId;});if(ct)ctName=ct.name;
      var stName='';var st=libraryData.subcats.find(function(s){return s.id===stId;});if(st)stName=st.name;
      var dtName='';var dt=libraryData.docTypes.find(function(d){return d.id===dtId;});if(dt)dtName=dt.name;
      body.libraryContext={selectedPrecedentIds:draftSelectedPrecedents.map(function(p){return p.id;}),caseTypeName:ctName,subcategoryName:stName,docTypeName:dtName};
    }
    /* v5.11a: untick = exclude. Worker already supports excludeDocNames. */
    var excluded=getDraftExcludeDocNames();
    if(excluded.length>0)body.excludeDocNames=excluded;
    /* v5.11a: pass most-recent analysis-tool result for each tool from this
       matter's history into the prompt as background context. */
    body.matterToolHistory=collectMatterToolHistory();
    /* v5.11a: comparable-document hunt flag. Wired through; worker reads but
       does not yet act on it (Build 3). */
    var lcCb=document.getElementById('draftLearnComparable');
    body.learnFromComparable=lcCb?!!lcCb.checked:true;
    var d=await api('/api/tools','POST',body);
    if(!d||!d.jobId)throw new Error('No jobId returned');
    prog.textContent='Generating draft\u2026 (processing in background, you can navigate away)';
    var jobId=d.jobId;var pollCount=0;
    var draftPoll=setInterval(async function(){
      try{
        pollCount++;
        var j=await api('/api/jobs?id='+jobId);
        if(!j)return;
        if(j.batchesTotal>0&&j.batchesDone>0){prog.textContent='Generating draft\u2026 batch '+j.batchesDone+' of '+j.batchesTotal;}
        if(j.status==='complete'||j.status==='partial'){
          clearInterval(draftPoll);
          document.getElementById('draftGenerateBtn').disabled=false;prog.style.display='none';
          var resultText=j.result||'';
          document.getElementById('draftInstructionsBody').style.display='none';
          var outputWrap=document.getElementById('draftOutputWrap');outputWrap.classList.remove('hidden');
          var editor=document.getElementById('draftEditor');editor.innerHTML=renderMd(resultText);editor.focus();
          /* v5.13b: persist as a new draft row so it appears in
             Previous drafts and subsequent edits autosave to it. */
          try{
            var savePayload={
              matter_id:matterId,
              case_type_id:ctId||null,
              subcat_id:stId||null,
              doc_type_id:dtId||null,
              heading_data:JSON.stringify(draftHeading),
              instructions:instructions,
              draft_content:resultText
            };
            api('/api/drafts','POST',savePayload).then(function(saved){
              if(saved&&saved.draft&&saved.draft.id){
                currentDraftId=saved.draft.id;
                previousDraftsList.unshift(saved.draft);
                updatePrevDraftsBadge();
                unsavedEdits=false;
                var sb=document.getElementById('saveDraftBtn');
                if(sb)sb.style.display='none';
              }
            }).catch(function(se){console.log('Persist generated draft failed:',se.message);});
          }catch(persErr){console.log('Persist guard:',persErr.message);}
          return;
        }
        if(j.status==='failed'){
          clearInterval(draftPoll);
          document.getElementById('draftGenerateBtn').disabled=false;prog.style.display='none';
          showToast('Draft error: '+(j.error||'Unknown error'));return;
        }
        if(pollCount>360){
          clearInterval(draftPoll);
          document.getElementById('draftGenerateBtn').disabled=false;
          prog.textContent='Draft is taking longer than expected. Check History later.';
        }
      }catch(pollErr){console.log('Draft poll error:',pollErr.message);}
    },10000);
  }catch(e){document.getElementById('draftGenerateBtn').disabled=false;prog.style.display='none';showToast('Draft error: '+e.message);}
}

/* Draft rich text commands */
function draftInsertText(){
  var text=prompt('Paste text to insert:');
  if(!text)return;
  document.getElementById('draftEditor').focus();
  document.execCommand('insertHTML',false,esc(text).replace(/\n/g,'<br>'));
}
function draftInsertAI(){
  var instruction=prompt('AI instruction (what should the AI add or change?):');
  if(!instruction)return;
  showToast('AI insert — processing…');
  /* Send the current draft + instruction to the API */
  var editor=document.getElementById('draftEditor');
  var currentContent=editor.innerText||editor.textContent;
  var matterId=document.getElementById('draftMatterSelect').value;
  api('/api/analyse','POST',{matterId:matterId,matterName:'',matterNature:'',matterIssues:'',messages:[{role:'user',content:'You are editing a legal draft document. Current draft text:\n\n'+currentContent+'\n\nInstruction: '+instruction+'\n\nReturn the complete updated document incorporating the instruction.'}],jurisdiction:draftJur(),queryType:'Document Drafting',focusAreas:[]}).then(function(d){
    if(d&&d.result){editor.innerHTML=renderMd(d.result);showToast('AI insert applied');}
  }).catch(function(e){showToast('AI error: '+e.message);});
}
function draftDownloadWord(){
  var editor=document.getElementById('draftEditor');
  var content=editor.innerText||editor.textContent;
  downloadWord(content,'Draft — '+(draftHeading.docTitle||'document'));
}
/* ── v2.5: AI HEADING SUGGESTION (C1) ────────────────────────────────────── */
async function draftAISuggestHeading(matterId){
  /* Only suggest if heading is still basic (from matter name parsing) */
  if(draftHeading.caseNo)return;/* Already has detail */
  try{
    var d=await api('/api/analyse','POST',{
      matterId:matterId,
      matterName:currentMatter?currentMatter.name:'',
      matterNature:'',matterIssues:'',
      messages:[{role:'user',content:'Look across the matter documents and extract the case heading information. Look first at pleadings (writ, claim form, statement of claim, defence, petition, notice of appeal) and any case-management orders, since these usually carry the most accurate court name, case/cause number, and party titles. If those are not present, look at any covering letters, indexes, or correspondence headers. Return ONLY a JSON object with these fields (use empty string if not found): court, caseNo, party1, party1Role, party2, party2Role, docTitle. For example: {"court":"IN THE SUPREME COURT OF BERMUDA","caseNo":"Civil Jurisdiction 2024 No. 123","party1":"SMITH","party1Role":"Plaintiff","party2":"JONES LIMITED","party2Role":"Defendant","docTitle":"SKELETON ARGUMENT"}. Return ONLY the JSON, no other text.'}],
      jurisdiction:draftJur(),
      queryType:'Factual Analysis',
      focusAreas:[]
    });
    if(d&&d.result){
      try{
        var raw=d.result.replace(/```json|```/g,'').trim();
        var s=raw.indexOf('{');var e=raw.lastIndexOf('}');
        if(s>=0&&e>s){
          var h=JSON.parse(raw.slice(s,e+1));
          if(h.court&&!draftHeading.court)draftHeading.court=h.court;
          if(h.caseNo)draftHeading.caseNo=h.caseNo;
          if(h.party1)draftHeading.party1=h.party1.toUpperCase();
          if(h.party1Role)draftHeading.party1Role=h.party1Role;
          if(h.party2)draftHeading.party2=h.party2.toUpperCase();
          if(h.party2Role)draftHeading.party2Role=h.party2Role;
          if(h.docTitle)draftHeading.docTitle=h.docTitle.toUpperCase();
          updateActionHeading();
          showToast('Heading suggested from documents — click to edit');
        }
      }catch(pe){console.log('AI heading parse error:',pe);}
    }
  }catch(e){console.log('AI heading suggestion skipped:',e.message);}
}

/* ── v2.5: UPLOAD PRECEDENT MODAL DELETE (A4) ───────────────────────────── */
function precModalDelete(type){
  if(type==='casetype'){
    var sel=document.getElementById('precUpCaseType');
    if(!sel||!sel.value){showToast('Select a case type first');return;}
    var name=sel.options[sel.selectedIndex].text;
    if(!confirm('Delete case type "'+name+'" and all its stages, doc types, and precedents?'))return;
    api('/api/library','DELETE',{action:'delete_case_type',id:sel.value}).then(function(){loadLibrary();precUpCaseTypeChanged();showToast('Deleted: '+name);}).catch(function(e){showToast('Error: '+e.message);});
  }else if(type==='subcat'){
    var sel2=document.getElementById('precUpStage');
    if(!sel2||!sel2.value){showToast('Select a stage first');return;}
    var name2=sel2.options[sel2.selectedIndex].text;
    if(!confirm('Delete stage "'+name2+'"?'))return;
    api('/api/library','DELETE',{action:'delete_subcat',id:sel2.value}).then(function(){loadLibrary();precUpCaseTypeChanged();showToast('Deleted: '+name2);}).catch(function(e){showToast('Error: '+e.message);});
  }else if(type==='doctype'){
    var sel3=document.getElementById('precUpDocType');
    if(!sel3||!sel3.value){showToast('Select a doc type first');return;}
    var name3=sel3.options[sel3.selectedIndex].text;
    if(!confirm('Delete doc type "'+name3+'"?'))return;
    api('/api/library','DELETE',{action:'delete_doc_type',id:sel3.value}).then(function(){loadLibrary();precUpCaseTypeChanged();showToast('Deleted: '+name3);}).catch(function(e){showToast('Error: '+e.message);});
  }
}

/* ── v2.5: DRAFT LEFT COLUMN DELETE (C4) ─────────────────────────────────── */
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

/* ── v2.5: DRAFT IN-PLACE UPLOAD & DOC SELECTION (C6/C7/C8) ─────────────── */
var draftSelectedDocs={src1:[],src2:[],src3:[],ctx:[],prec:[]};
var draftSelectedPrecedents=[];

function draftSelectDoc(selectId,boxKey){
  var sel=document.getElementById(selectId);
  if(!sel||!sel.value)return;
  var rawVal=sel.value;
  var docName=sel.options[sel.selectedIndex].text;
  /* Determine type from value prefix */
  var docType='doc';
  var docId=rawVal;
  if(rawVal.indexOf('hist:')===0){docType='hist';docId=rawVal.slice(5);}
  else if(rawVal.indexOf('doc:')===0){docType='doc';docId=rawVal.slice(4);}
  if(draftSelectedDocs[boxKey].some(function(d){return d.id===docId&&d.rawVal===rawVal;}))return;
  draftSelectedDocs[boxKey].push({id:docId,rawVal:rawVal,name:docName.replace(/^📄 |^🔧 /,''),type:docType});
  sel.value='';
  renderDraftSelectedDocs(boxKey);
}

function draftRemoveSelectedDoc(boxKey,idx){
  draftSelectedDocs[boxKey].splice(idx,1);
  renderDraftSelectedDocs(boxKey);
}

function renderDraftSelectedDocs(boxKey){
  var containerIds={src1:'draftSelectedSrc1',src2:'draftSelectedSrc2',src3:'draftSelectedSrc3',ctx:'draftSelectedCtx',prec:'draftSelectedPrecs'};
  var container=document.getElementById(containerIds[boxKey]);
  if(!container)return;
  if(!draftSelectedDocs[boxKey]||!draftSelectedDocs[boxKey].length){container.innerHTML='';return;}
  container.innerHTML=draftSelectedDocs[boxKey].map(function(d,i){
    var icon=d.type==='upload'?'📤 ':d.type==='hist'?'🔧 ':'📄 ';
    return '<div class="draft-sel-item"><span title="'+esc(d.name)+'">'+icon+esc(d.name)+'</span><button class="draft-sel-del" onclick="draftRemoveSelectedDoc(\''+boxKey+'\','+i+')" title="Remove">×</button></div>';
  }).join('');
}

/* v4.5: Rewritten — dispatches .pdf/.docx via extractors, unwraps page array,
   rejects legacy .doc, fixes v3.2 page-array bug */
async function draftUploadInPlace(input,boxKey){
  var file=input.files[0];
  if(!file)return;
  var matterId=document.getElementById('draftMatterSelect').value;
  if(!matterId){showToast('Select a matter first');input.value='';return;}
  var lowerName=file.name.toLowerCase();
  var isDocx=lowerName.endsWith('.docx');
  var isPdf=lowerName.endsWith('.pdf');
  if(lowerName.endsWith('.doc')&&!isDocx){showToast(file.name+': legacy .doc format is not supported. Please save as .docx first.');input.value='';return;}
  if(!isPdf&&!isDocx){showToast('Please select a PDF or Word (.docx) document');input.value='';return;}
  showToast('Uploading '+file.name+'…');
  try{
    var pages=isDocx?await extractDocxText(file):await extractPdfText(file);
    var text=pages.map(function(p){return p.text;}).join('\n\n');
    if(!text||text.trim().length<50){showToast('No readable text in '+file.name+(isPdf?'. Try OCR at ilovepdf.com first.':'. The document may be empty or corrupted.'));input.value='';return;}
    var docType='Other';
    var d=await api('/api/upload','POST',{matterId:matterId,fileName:file.name,textContent:text,docType:docType});
    if(d){
      showToast('✓ '+file.name+' uploaded — '+(d.chunks||0)+' passages indexed');
      draftSelectedDocs[boxKey].push({id:d.id||'uploaded',rawVal:d.id||'uploaded',name:file.name.replace(/\.(pdf|docx?)$/i,''),type:'upload'});
      renderDraftSelectedDocs(boxKey);
      await loadDraftMatterDocs(matterId);
      await loadDocuments(matterId);
      await loadMatters();
    }
  }catch(e){showToast('Upload error: '+e.message);}
  input.value='';
}

/* ── v2.5: PRECEDENT REFERENCE PICKER (C11) ──────────────────────────────── */
function draftPrecCaseTypeChanged(){
  var ctId=document.getElementById('draftPrecCaseType').value;
  var list=document.getElementById('draftPrecList');
  if(!ctId){list.innerHTML='<div style="font-size:.78rem;color:var(--text-faint);font-style:italic;padding:.3rem">Select a case type to see precedents.</div>';return;}
  var filtered=libraryData.precedents.filter(function(p){return p.case_type_id===ctId;});
  if(!filtered.length){list.innerHTML='<div style="font-size:.78rem;color:var(--text-faint);font-style:italic;padding:.3rem">No precedents for this case type.</div>';return;}
  list.innerHTML=filtered.map(function(p){
    var checked=draftSelectedPrecedents.some(function(sp){return sp.id===p.id;});
    return '<label class="draft-doc-check"><input type="checkbox" value="'+p.id+'" data-name="'+esc(p.name)+'"'+(checked?' checked':'')+' onchange="draftTogglePrecedent(this)"> '+esc(p.name)+'</label>';
  }).join('');
}

function draftTogglePrecedent(cb){
  var id=cb.value;
  var name=cb.getAttribute('data-name');
  if(cb.checked){
    if(!draftSelectedPrecedents.some(function(p){return p.id===id;})){
      draftSelectedPrecedents.push({id:id,name:name});
    }
  }else{
    draftSelectedPrecedents=draftSelectedPrecedents.filter(function(p){return p.id!==id;});
  }
  renderDraftSelectedPrecs();
}

function draftRemovePrecedent(idx){
  draftSelectedPrecedents.splice(idx,1);
  renderDraftSelectedPrecs();
  draftPrecCaseTypeChanged();
}

function renderDraftSelectedPrecs(){
  var container=document.getElementById('draftSelectedPrecs');
  if(!container)return;
  if(!draftSelectedPrecedents.length){container.innerHTML='';return;}
  container.innerHTML=draftSelectedPrecedents.map(function(p,i){
    return '<div class="draft-sel-item"><span title="'+esc(p.name)+'">📚 '+esc(p.name)+'</span><button class="draft-sel-del" onclick="draftRemovePrecedent('+i+')" title="Remove">×</button></div>';
  }).join('');
}

/* ── v2.5: CAPS TOGGLE (C13) ────────────────────────────────────────────── */
function draftToggleCaps(){
  var sel=window.getSelection();
  if(!sel||sel.rangeCount===0||sel.isCollapsed)return;
  var text=sel.toString();
  var upper=text.toUpperCase();
  var replacement=(text===upper)?text.toLowerCase():upper;
  document.execCommand('insertText',false,replacement);
}

/* Draft dialogue (further instructions) */
async function draftDialogueSend(){
  var input=document.getElementById('draftDialogueInput');
  var text=input.value.trim();if(!text)return;
  input.value='';
  var editor=document.getElementById('draftEditor');
  var currentContent=editor.innerText||editor.textContent;
  var matterId=document.getElementById('draftMatterSelect').value;
  showToast('Updating draft…');
  try{
    var d=await api('/api/analyse','POST',{matterId:matterId,matterName:'',matterNature:'',matterIssues:'',messages:[{role:'user',content:'You are editing a legal draft document. Current draft:\n\n'+currentContent+'\n\nFurther instruction: '+text+'\n\nReturn the complete updated document.'}],jurisdiction:draftJur(),queryType:'Document Drafting',focusAreas:[]});
    if(d&&d.result){editor.innerHTML=renderMd(d.result);showToast('Draft updated');}
  }catch(e){showToast('Error: '+e.message);}
}
