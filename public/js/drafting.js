/* ── DRAFT TAB ────────────────────────────────────────────────────────────── */
/* v5.13b — 01 May 2026
   Draft tab matter-switching fix + Previous Drafts UI.
   1. draftMatterChanged now actually resets state on matter switch
      (editor, dropdowns, selected docs/precedents, currentDraftId).
   2. New onDraftTabActivated() called from core.js switchMainNav('draft')
      to sync the Draft tab to currentMatter on every tab activation.
   3. New Previous Drafts modal listing all drafts for the current matter
      with load/delete actions.
   4. Auto-save bug fixed: was POST-on-every-keystroke creating duplicate
      rows; now PUTs to currentDraftId if attached, or no-ops if not.
   5. Generate Draft now creates a new row in `drafts` and attaches the
      editor to currentDraftId so subsequent edits PUT in place.
   6. Save button (small, only shown when editor has content but no
      currentDraftId) lets user attach an unattached editor to a row.
   7. Unsaved-edits flag warns before discarding manual edits on matter
      switch. */

/* v5.13b: shared draft-row state. currentDraftId is the row in the
   `drafts` table that the editor is currently attached to. unsavedEdits
   tracks whether the editor has been manually modified since the last
   successful PUT or load. previousDraftsList caches the list for the
   modal. */
var currentDraftId = null;
var unsavedEdits = false;
var previousDraftsList = [];

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
  var sel=document.getElementById('draftMatterSelect');
  var id=sel?sel.value:'';
  if(!id)return;
  var m=matters.find(function(x){return x.id===id;});
  if(!m)return;
  /* v5.13b: reset all draft state on matter switch. The unsaved-edits
     check happens in onDraftTabActivated before we get here, so by the
     time draftMatterChanged runs, any discard has been confirmed. */
  currentDraftId=null;
  unsavedEdits=false;
  /* Clear editor */
  var editor=document.getElementById('draftEditor');
  if(editor)editor.innerHTML='';
  /* Hide output wrap (which contains the editor) and show instructions body */
  var outputWrap=document.getElementById('draftOutputWrap');
  if(outputWrap)outputWrap.classList.add('hidden');
  var instrBody=document.getElementById('draftInstructionsBody');
  if(instrBody)instrBody.style.display='';
  /* Clear instructions textarea */
  var instr=document.getElementById('draftMainInstructions');
  if(instr)instr.value='';
  /* Reset Library dropdowns */
  var ct=document.getElementById('draftCaseType');if(ct)ct.value='';
  var stEl=document.getElementById('draftStage');
  if(stEl)stEl.innerHTML='<option value="">— Select —</option>';
  var dt=document.getElementById('draftDocType');
  if(dt)dt.innerHTML='<option value="">— Select —</option>';
  /* Clear selected docs and precedents */
  draftSelectedDocs={src1:[],src2:[],src3:[],ctx:[],prec:[]};
  draftSelectedPrecedents=[];
  if(typeof renderDraftSelectedDocs==='function')renderDraftSelectedDocs();
  if(typeof renderDraftSelectedPrecedents==='function')renderDraftSelectedPrecedents();
  /* Reset draftHeading from new matter */
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
  /* Hide the Save button (only shown when editor has unattached content) */
  var saveBtn=document.getElementById('saveDraftBtn');
  if(saveBtn)saveBtn.style.display='none';
  /* Load matter docs and previous drafts list */
  loadDraftMatterDocs(id).then(function(){
    draftAISuggestHeading(id);
  });
  loadDraftsForMatter(id);
}

/* v5.13b: tab-activation hook called from core.js switchMainNav('draft').
   Syncs the Draft tab to currentMatter, with an unsaved-edits guard. */
function onDraftTabActivated(){
  var sel=document.getElementById('draftMatterSelect');
  if(!sel)return;
  var targetId=(typeof currentMatter!=='undefined'&&currentMatter)?currentMatter.id:'';
  var currentId=sel.value;
  /* If neither side has a value, nothing to do. */
  if(!targetId&&!currentId)return;
  /* If the select is already in sync with currentMatter, just refresh
     the previous-drafts list count and exit. */
  if(targetId&&currentId===targetId){
    loadDraftsForMatter(targetId);
    return;
  }
  /* Mismatch — we need to switch the Draft tab to currentMatter. Check
     for unsaved edits first. */
  if(unsavedEdits){
    var newName=targetId?(matters.find(function(x){return x.id===targetId;})||{}).name||'the new matter':'the new matter';
    if(!confirm('You have unsaved changes in the draft editor. Discard them and switch to '+newName+'?')){
      /* User cancelled. Restore the dropdown to the value it currently
         points at and stop. */
      return;
    }
  }
  /* Apply the switch. */
  if(targetId)sel.value=targetId;
  draftMatterChanged();
}

/* v5.13b: load all drafts for a matter and update the badge count. */
async function loadDraftsForMatter(matterId){
  if(!matterId){previousDraftsList=[];updatePrevDraftsBadge();return;}
  try{
    var d=await api('/api/drafts?matter_id='+matterId);
    previousDraftsList=(d&&d.drafts)?d.drafts:[];
  }catch(e){
    console.log('loadDraftsForMatter:',e.message);
    previousDraftsList=[];
  }
  updatePrevDraftsBadge();
}

function updatePrevDraftsBadge(){
  var span=document.getElementById('prevDraftsCount');
  if(span)span.textContent=previousDraftsList.length;
}

/* v5.13b: render and open the Previous Drafts modal. */
function showPreviousDraftsModal(){
  var matterId=document.getElementById('draftMatterSelect').value;
  if(!matterId){showToast('Select a matter first');return;}
  var modal=document.getElementById('prevDraftsModal');
  var list=document.getElementById('prevDraftsList');
  if(!modal||!list)return;
  if(previousDraftsList.length===0){
    list.innerHTML='<div style="font-size:.85rem;color:var(--text-faint);font-style:italic;padding:1rem 0">No previous drafts for this matter yet.</div>';
  }else{
    var html='';
    for(var i=0;i<previousDraftsList.length;i++){
      var dr=previousDraftsList[i];
      var when=dr.created_at?new Date(dr.created_at).toLocaleString('en-GB',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}):'';
      var dtName='';
      if(dr.doc_type_id&&typeof libraryData!=='undefined'&&libraryData.docTypes){
        var dtRow=libraryData.docTypes.find(function(x){return x.id===dr.doc_type_id;});
        if(dtRow)dtName=dtRow.name;
      }
      var instrPreview=(dr.instructions||'').slice(0,80);
      if((dr.instructions||'').length>80)instrPreview+='\u2026';
      html+='<div class="prev-draft-row" style="display:flex;align-items:flex-start;gap:.5rem;padding:.6rem;border-bottom:1px solid var(--border);cursor:pointer" onclick="loadDraftIntoEditor(\''+dr.id+'\')">';
      html+='<div style="flex:1;min-width:0">';
      html+='<div style="font-size:.78rem;color:var(--text-faint)">'+esc(when)+(dtName?' \u00b7 '+esc(dtName):'')+'</div>';
      html+='<div style="font-size:.85rem;color:var(--text);margin-top:.15rem">'+esc(instrPreview||'(no instructions saved)')+'</div>';
      html+='</div>';
      html+='<button onclick="event.stopPropagation();deleteDraftFromList(\''+dr.id+'\')" style="background:none;border:none;font-size:1.05rem;cursor:pointer;color:var(--text-faint);padding:0 .3rem" title="Delete this draft">\u00d7</button>';
      html+='</div>';
    }
    list.innerHTML=html;
  }
  modal.style.display='flex';
}

function closePreviousDraftsModal(){
  var modal=document.getElementById('prevDraftsModal');
  if(modal)modal.style.display='none';
}

/* v5.13b: load a previously-saved draft into the editor. Handles the
   unsaved-edits guard before discarding current editor content. */
async function loadDraftIntoEditor(draftId){
  if(unsavedEdits){
    if(!confirm('You have unsaved changes in the editor. Discard them and load this previous draft?')){
      return;
    }
  }
  var dr=previousDraftsList.find(function(x){return x.id===draftId;});
  if(!dr){showToast('Draft not found');return;}
  /* Reveal the output wrapper (which contains the editor) */
  document.getElementById('draftInstructionsBody').style.display='none';
  document.getElementById('draftOutputWrap').classList.remove('hidden');
  var editor=document.getElementById('draftEditor');
  if(editor){editor.innerHTML=dr.draft_content||'';}
  /* Restore heading if present */
  if(dr.heading_data){
    try{
      var h=typeof dr.heading_data==='string'?JSON.parse(dr.heading_data):dr.heading_data;
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
    }catch(pe){console.log('heading parse:',pe.message);}
  }
  /* Restore instructions */
  var instr=document.getElementById('draftMainInstructions');
  if(instr)instr.value=dr.instructions||'';
  /* Restore Library dropdowns */
  var ct=document.getElementById('draftCaseType');
  if(ct&&dr.case_type_id){ct.value=dr.case_type_id;draftCaseTypeChanged();
    var stEl=document.getElementById('draftStage');
    if(stEl&&dr.subcat_id)stEl.value=dr.subcat_id;
    var dt=document.getElementById('draftDocType');
    if(dt&&dr.doc_type_id)dt.value=dr.doc_type_id;
  }
  currentDraftId=draftId;
  unsavedEdits=false;
  /* Hide save button — we're now attached to a row */
  var saveBtn=document.getElementById('saveDraftBtn');
  if(saveBtn)saveBtn.style.display='none';
  closePreviousDraftsModal();
}

/* v5.13b: delete a draft from the list. */
async function deleteDraftFromList(draftId){
  if(!confirm('Delete this draft permanently? This cannot be undone.'))return;
  try{
    await api('/api/drafts?id='+draftId,'DELETE');
    /* If the deleted draft was the currently-loaded one, blank the editor. */
    if(currentDraftId===draftId){
      currentDraftId=null;
      unsavedEdits=false;
      var editor=document.getElementById('draftEditor');
      if(editor)editor.innerHTML='';
      document.getElementById('draftOutputWrap').classList.add('hidden');
      document.getElementById('draftInstructionsBody').style.display='';
    }
    /* Refresh list */
    var matterId=document.getElementById('draftMatterSelect').value;
    if(matterId)await loadDraftsForMatter(matterId);
    /* Re-render the modal if it's still open */
    var modal=document.getElementById('prevDraftsModal');
    if(modal&&modal.style.display!=='none')showPreviousDraftsModal();
    showToast('Draft deleted');
  }catch(e){
    showToast('Delete failed: '+e.message);
  }
}

/* v5.13b: save unattached editor content as a new draft row. Only
   reachable via the small Save button which is hidden when
   currentDraftId is already set. */
async function saveCurrentDraft(){
  var matterId=document.getElementById('draftMatterSelect').value;
  if(!matterId){showToast('Select a matter first');return;}
  var editor=document.getElementById('draftEditor');
  var content=editor?editor.innerHTML:'';
  if(!content||!content.trim()){showToast('Nothing to save');return;}
  var ctId=document.getElementById('draftCaseType').value;
  var dtId=document.getElementById('draftDocType').value;
  var stId=document.getElementById('draftStage').value;
  var instructions=document.getElementById('draftMainInstructions').value||'';
  try{
    var d=await api('/api/drafts?matter_id='+matterId,'POST',{
      matter_id:matterId,
      case_type_id:ctId||null,
      subcat_id:stId||null,
      doc_type_id:dtId||null,
      heading_data:draftHeading,
      instructions:instructions,
      draft_content:content,
      conversation:[]
    });
    if(d&&d.draft&&d.draft.id){
      currentDraftId=d.draft.id;
      unsavedEdits=false;
      var saveBtn=document.getElementById('saveDraftBtn');
      if(saveBtn)saveBtn.style.display='none';
      await loadDraftsForMatter(matterId);
      showToast('Draft saved');
    }
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

/* C3: Auto-save draft left column choices to drafts table.
   v5.13b: was POST on every keystroke, creating duplicate rows. Now
   PUTs to currentDraftId when the editor is attached to a row. When
   unattached, no-op — the user can use the Save button to attach. */
var _draftAutoSaveTimer=null;
function draftAutoSaveChoices(){
  if(_draftAutoSaveTimer)clearTimeout(_draftAutoSaveTimer);
  _draftAutoSaveTimer=setTimeout(function(){
    var matterId=document.getElementById('draftMatterSelect').value;
    if(!matterId)return;
    /* v5.13b: nothing to save unless we're attached to a row. */
    if(!currentDraftId){
      /* Show the Save button if there's editor content the user might
         want to keep. */
      var editor=document.getElementById('draftEditor');
      var hasContent=editor&&editor.innerHTML&&editor.innerHTML.trim().length>0;
      var saveBtn=document.getElementById('saveDraftBtn');
      if(saveBtn)saveBtn.style.display=hasContent?'':'none';
      return;
    }
    var editorEl=document.getElementById('draftEditor');
    var updates={
      case_type_id:document.getElementById('draftCaseType').value||null,
      subcat_id:document.getElementById('draftStage').value||null,
      doc_type_id:document.getElementById('draftDocType').value||null,
      heading_data:draftHeading,
      instructions:document.getElementById('draftMainInstructions').value||'',
      draft_content:editorEl?editorEl.innerHTML:''
    };
    api('/api/drafts?id='+currentDraftId,'PUT',updates).then(function(){
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
if(draftInstrEl){draftInstrEl.addEventListener('input',function(){unsavedEdits=true;draftAutoSaveChoices();});}
/* v5.13b: track manual editor edits and trigger autosave (PUT path). */
var draftEditorEl=document.getElementById('draftEditor');
if(draftEditorEl){draftEditorEl.addEventListener('input',function(){unsavedEdits=true;draftAutoSaveChoices();});}
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
          /* v5.13b: persist a new draft row in the `drafts` table and
             attach the editor to it via currentDraftId. Subsequent
             manual edits will PUT to this same row (no duplicate rows). */
          (async function(){
            try{
              var savePayload={
                matter_id:matterId,
                case_type_id:ctId||null,
                subcat_id:stId||null,
                doc_type_id:dtId||null,
                heading_data:draftHeading,
                instructions:instructions,
                draft_content:editor.innerHTML,
                conversation:[]
              };
              var sd=await api('/api/drafts?matter_id='+matterId,'POST',savePayload);
              if(sd&&sd.draft&&sd.draft.id){
                currentDraftId=sd.draft.id;
                unsavedEdits=false;
                var saveBtn=document.getElementById('saveDraftBtn');
                if(saveBtn)saveBtn.style.display='none';
                /* Refresh the previous-drafts list and badge */
                await loadDraftsForMatter(matterId);
              }
            }catch(saveErr){console.log('Draft post-generate save failed:',saveErr.message);}
          })();
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
