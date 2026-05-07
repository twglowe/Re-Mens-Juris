/* ── DRAFT TAB ────────────────────────────────────────────────────────────── */
/* v5.16c — 05 May 2026 — Push v5.16c (heading extraction reliability):
   draftAISuggestHeading now calls a dedicated /api/extract_heading endpoint
   instead of /api/analyse. The new endpoint:
   - Pulls first 1\u20132 chunks of every document in the matter (chunk_index 0/1).
   - Regex-prefilters for both a court-name shape AND an action-number shape.
   - Sends only matching chunks (max 5) to Claude with a tight prompt.
   - Validates and normalises before returning.
   This bypasses /api/analyse's keyword-search retrieval, which was
   unreliable for headings because the search prompt's keywords (pleadings,
   court, case, etc.) don't appear in the heading text itself \u2014 the search
   either returned chunks discussing those concepts (not heading text) or
   nothing, falling back to 30 random recent chunks.
   Also doesn't filter on doc_type because Tom flagged that the upload
   labels are unreliable. Court documents are recognised by what's at the
   top of page 1, not by their classification.
   Files changed: public/js/drafting.js (one function), api/extract_heading.js (NEW).
   No DB changes, no markup changes. */

/* v5.16b — 05 May 2026 — Push v5.16b (heading rendering for non-two-party cases):
   1. Shared heading renderer (renderHeadingHtml) used by both the live action
      heading bar and the modal preview. Replaces the two divergent renderers
      that previously gated on (party1 && party2).
   2. Three case shapes handled: BETWEEN two-party (existing), IN THE MATTER OF
      single-party (Cayman ELP / company petitions etc.), and BETWEEN with
      single party. The connector word is chosen by checking docTitle/docType
      and party1Role for "in the matter of" \u2014 if any contains it, the
      connector is IN THE MATTER OF; otherwise BETWEEN.
   3. Layout per Tom's spec: court is bold + uppercase + underlined, sits on
      the LEFT of the top row with caseNo on the RIGHT (capitalised words);
      connector centred; parties centred; doc title between two navy lines.
   4. Heading editor modal (.heading-popup) gets max-height: calc(100vh-2rem)
      + overflow-y:auto so it scrolls when too tall (same fix pattern as
      v5.15c for tool forms).
   5. saveHeading no longer prompts to rename the matter to "A v B" when
      the case is in-the-matter-of \u2014 that prompt was nonsensical for
      single-party cases.
   Files changed: public/js/drafting.js, index.html (CSS only).
   No DB changes, no new API endpoints. Continues v5.16a's draft_doc_titles
   and tab-merge work. */

/* v5.16a — 05 May 2026 — Push v5.16a (Drafting tab merge + heading fixes):
   1. Left-column merge: Sectors 1 (Case Identification) and 2 (Source
      Documents) merged into a tabbed left column (Case + Sources). Sector 3
      (Drafting) unchanged. Tab state persisted in localStorage.draftLastTab.
   2. Heading-stick fix on matter switch (#1): draftMatterChanged now also
      clobbers the contenteditable #draftHeadingText so the visible bar
      always matches draftHeading. generateDraft re-renders before the
      API call as a defensive belt-and-braces.
   3. AI heading suggestion (#2): triggers on every matter switch (no longer
      gated on empty caseNo). Worker pulls only docs whose doc_type matches
      a heading-bearing set (Pleadings, Affidavit, Witness Statement,
      Skeleton Argument, Notice). Suggestion validated before applying.
   4. Doc Title is now a select populated from /api/draft_doc_titles (#3).
      User can add/remove items via + / \u2212. First-load seeds 15 defaults.
      Selected option becomes draftHeading.docTitle and renders centred
      between the navy lines (existing updateActionHeading does this).
   5. Sector 1 dropdown persistence (#4): lazy draft-row creation — the
      first time the user changes Case Type / Stage / Doc Type and there
      is no currentDraftId, a new drafts row is POSTed and currentDraftId
      attached, so subsequent autosave PUTs persist these choices. Worker-
      side use of these IDs is deferred to v5.16b.
   6. Matter Documents list permanently hidden (#5). Exclude picker promoted
      from Sector 3 to the Sources tab. */

/* v5.14a — 04 May 2026
   Adds Clear Draft button (white box, red ✕ icon) next to Save and Generate
   Draft. Button is visible only when the editor has content. On click, after
   confirmation, clears: editor content, action heading (back to "Click to
   set action heading…"), instructions textarea, all three Library dropdowns
   (Case Type / Subcategory / Doc Type), selected source docs and precedents,
   currentDraftId (so next save creates a fresh row), and hides the output
   wrap so the user is back to instructions-input state ready for a new
   draft. Saved drafts in the `drafts` table are NOT deleted — they remain
   accessible via the Previous drafts modal. */

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

/* ═══════════════════════════════════════════════════════════════════════════
   v5.16a — DRAFTING-TAB LEFT-COLUMN TABS
   ───────────────────────────────────────────────────────────────────────────
   The merged left column has two tabs (Case + Sources). Last-used tab
   persists in localStorage so a user who works mostly in Sources doesn't
   have to switch every time they re-open the Drafting workspace.
   ═══════════════════════════════════════════════════════════════════════════ */
var DLC_TAB_LS_KEY='draftLastTab';
function dlcSwitchTab(which){
  var caseTab=document.getElementById('dlcTabCase');
  var srcTab=document.getElementById('dlcTabSources');
  var casePane=document.getElementById('dlcPaneCase');
  var srcPane=document.getElementById('dlcPaneSources');
  if(!caseTab||!srcTab||!casePane||!srcPane)return;
  var isCase=(which==='case');
  caseTab.classList.toggle('active',isCase);
  caseTab.setAttribute('aria-selected',isCase?'true':'false');
  srcTab.classList.toggle('active',!isCase);
  srcTab.setAttribute('aria-selected',isCase?'false':'true');
  casePane.classList.toggle('hidden',!isCase);
  srcPane.classList.toggle('hidden',isCase);
  try{localStorage.setItem(DLC_TAB_LS_KEY,which);}catch(e){}
}
/* Apply remembered tab on first activation. Default to 'case' if none. */
function dlcApplyRememberedTab(){
  var saved=null;
  try{saved=localStorage.getItem(DLC_TAB_LS_KEY);}catch(e){}
  dlcSwitchTab(saved==='sources'?'sources':'case');
}

/* ═══════════════════════════════════════════════════════════════════════════
   v5.16a — DOC-TITLE LIST (heading editor select)
   ───────────────────────────────────────────────────────────────────────────
   Loaded from /api/draft_doc_titles on heading-modal open and cached for
   the session. add/remove operations roundtrip to the API and then
   re-render the select.
   ═══════════════════════════════════════════════════════════════════════════ */
var draftDocTitlesCache=null;/* {id, name}[] | null */

async function loadDocTitles(){
  try{
    var d=await api('/api/draft_doc_titles');
    draftDocTitlesCache=(d&&Array.isArray(d.titles))?d.titles:[];
  }catch(e){
    console.log('loadDocTitles:',e.message);
    draftDocTitlesCache=draftDocTitlesCache||[];
  }
  renderDocTitleSelect();
}

function renderDocTitleSelect(){
  var sel=document.getElementById('hdDocTitleSelect');
  var hidden=document.getElementById('hdDocTitle');
  if(!sel)return;
  var current=hidden?hidden.value:'';
  var html='<option value="">— Select doc title —</option>';
  if(draftDocTitlesCache&&draftDocTitlesCache.length){
    for(var i=0;i<draftDocTitlesCache.length;i++){
      var t=draftDocTitlesCache[i];
      var name=t.name||'';
      var selAttr=(name===current)?' selected':'';
      html+='<option value="'+esc(name)+'" data-id="'+esc(t.id)+'"'+selAttr+'>'+esc(name)+'</option>';
    }
  }
  sel.innerHTML=html;
}

function hdDocTitleSelectChanged(){
  var sel=document.getElementById('hdDocTitleSelect');
  var hidden=document.getElementById('hdDocTitle');
  if(!sel||!hidden)return;
  hidden.value=sel.value;
  if(typeof updateHeadingPreview==='function')updateHeadingPreview();
}

async function hdDocTitleAdd(){
  var name=prompt('Add doc title (e.g. NOTICE OF MOTION):');
  if(!name)return;
  name=name.trim();
  if(!name)return;
  if(name.length>120){showToast('Title too long (max 120 chars)');return;}
  try{
    var d=await api('/api/draft_doc_titles','POST',{name:name});
    if(d&&d.title){
      if(!Array.isArray(draftDocTitlesCache))draftDocTitlesCache=[];
      draftDocTitlesCache.push(d.title);
      renderDocTitleSelect();
      /* Auto-select the freshly-added title for convenience. */
      var sel=document.getElementById('hdDocTitleSelect');
      if(sel)sel.value=d.title.name;
      hdDocTitleSelectChanged();
      showToast('Added: '+d.title.name);
    }
  }catch(e){
    if(e&&e.message&&e.message.indexOf('already exists')!==-1){showToast('That title already exists');}
    else{showToast('Add failed: '+e.message);}
  }
}

async function hdDocTitleRemove(){
  var sel=document.getElementById('hdDocTitleSelect');
  if(!sel||!sel.value){showToast('Select a doc title first');return;}
  var name=sel.value;
  var opt=sel.options[sel.selectedIndex];
  var id=opt?opt.getAttribute('data-id'):'';
  if(!id){showToast('Cannot delete this option');return;}
  if(!confirm('Delete "'+name+'" from your doc title list?'))return;
  try{
    await api('/api/draft_doc_titles?id='+id,'DELETE');
    if(Array.isArray(draftDocTitlesCache)){
      draftDocTitlesCache=draftDocTitlesCache.filter(function(t){return t.id!==id;});
    }
    /* If the deleted title was the selected one, blank the hidden value. */
    var hidden=document.getElementById('hdDocTitle');
    if(hidden&&hidden.value===name)hidden.value='';
    renderDocTitleSelect();
    if(typeof updateHeadingPreview==='function')updateHeadingPreview();
    showToast('Deleted: '+name);
  }catch(e){showToast('Delete failed: '+e.message);}
}

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
  /* v5.16a (Issue #1 fix): clobber the visible heading bar BEFORE rebuilding
     it from draftHeading. The bar is contenteditable, so a manual edit can
     leave residue that doesn't survive matter switch in draftHeading but DOES
     survive in #draftHeadingText.innerHTML. Reset to empty here, then let
     updateActionHeading() rebuild it from the freshly-derived draftHeading. */
  var headingTextEl=document.getElementById('draftHeadingText');
  if(headingTextEl)headingTextEl.innerHTML='';
  updateActionHeading();
  /* Hide the Save button (only shown when editor has unattached content) */
  var saveBtn=document.getElementById('saveDraftBtn');
  if(saveBtn)saveBtn.style.display='none';
  /* v5.14a: hide Clear Draft button — editor was just cleared by matter switch */
  var clearBtn=document.getElementById('clearDraftBtn');
  if(clearBtn)clearBtn.style.display='none';
  /* Load matter docs and previous drafts list */
  loadDraftMatterDocs(id).then(function(){
    draftAISuggestHeading(id);
  });
  loadDraftsForMatter(id);
}

/* v5.13b: tab-activation hook called from core.js switchMainNav('draft').
   Syncs the Draft tab to currentMatter, with an unsaved-edits guard.
   v5.16e Push A: after the matter-sync block, attempt to reattach a
   poll loop to any in-flight draft job stashed by tools.js
   resumeInProgressJobs. Safe no-op if no stash. */
function onDraftTabActivated(){
  /* v5.16a: apply remembered left-column tab on every activation. */
  if(typeof dlcApplyRememberedTab==='function')dlcApplyRememberedTab();
  var sel=document.getElementById('draftMatterSelect');
  if(!sel){
    if(typeof attachDraftPoll==='function')attachDraftPoll();
    return;
  }
  var targetId=(typeof currentMatter!=='undefined'&&currentMatter)?currentMatter.id:'';
  var currentId=sel.value;
  /* If neither side has a value, nothing to do. */
  if(!targetId&&!currentId){
    if(typeof attachDraftPoll==='function')attachDraftPoll();
    return;
  }
  /* If the select is already in sync with currentMatter, just refresh
     the previous-drafts list count and exit. */
  if(targetId&&currentId===targetId){
    loadDraftsForMatter(targetId);
    if(typeof attachDraftPoll==='function')attachDraftPoll();
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
  if(typeof attachDraftPoll==='function')attachDraftPoll();
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
  /* v5.14a: show Clear Draft button — editor now has loaded content */
  updateClearDraftBtnVisibility();
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

/* v5.14a: small helper to update visibility of the Clear Draft button.
   Visible whenever the editor has any content, regardless of whether it
   is attached to a draft row. Called from autosave timer, post-Generate
   Draft, on editor input, on draft load, and on matter switch. */
function updateClearDraftBtnVisibility(){
  var editor=document.getElementById('draftEditor');
  var hasContent=editor&&editor.innerHTML&&editor.innerHTML.trim().length>0;
  var clearBtn=document.getElementById('clearDraftBtn');
  if(clearBtn)clearBtn.style.display=hasContent?'':'none';
}

var _draftAutoSaveTimer=null;
/* v5.16a: in-flight guard — prevents two concurrent lazy-create POSTs if a
   user clicks two dropdowns within the same debounce window before the
   first POST returns. */
var _draftLazyCreateInFlight=false;

function draftAutoSaveChoices(){
  if(_draftAutoSaveTimer)clearTimeout(_draftAutoSaveTimer);
  _draftAutoSaveTimer=setTimeout(function(){
    /* v5.14a: keep Clear Draft button in sync with editor content. */
    updateClearDraftBtnVisibility();
    var matterId=document.getElementById('draftMatterSelect').value;
    if(!matterId)return;
    var editorEl=document.getElementById('draftEditor');
    var ctVal=document.getElementById('draftCaseType').value||null;
    var stVal=document.getElementById('draftStage').value||null;
    var dtVal=document.getElementById('draftDocType').value||null;
    var instrVal=document.getElementById('draftMainInstructions').value||'';
    var contentVal=editorEl?editorEl.innerHTML:'';
    var hasAnyData=!!(ctVal||stVal||dtVal||instrVal.trim()||(contentVal&&contentVal.trim()));

    /* v5.16a (Issue #4 fix): lazy draft-row creation. If the user has
       picked any dropdown / typed any instruction but there is no
       currentDraftId yet, create an empty draft row now so the choices
       persist (and the row carries case_type_id / subcat_id / doc_type_id
       once we PUT below). Without this, dropdown picks evaporate on
       matter switch. */
    if(!currentDraftId&&hasAnyData&&!_draftLazyCreateInFlight){
      _draftLazyCreateInFlight=true;
      api('/api/drafts?matter_id='+matterId,'POST',{
        matter_id:matterId,
        case_type_id:ctVal,
        subcat_id:stVal,
        doc_type_id:dtVal,
        heading_data:draftHeading,
        instructions:instrVal,
        draft_content:contentVal,
        conversation:[]
      }).then(function(d){
        _draftLazyCreateInFlight=false;
        if(d&&d.draft&&d.draft.id){
          currentDraftId=d.draft.id;
          unsavedEdits=false;
          var saveBtn=document.getElementById('saveDraftBtn');
          if(saveBtn)saveBtn.style.display='none';
          loadDraftsForMatter(matterId);
        }
      }).catch(function(e){
        _draftLazyCreateInFlight=false;
        console.log('Lazy draft-row create failed:',e.message);
      });
      return;
    }

    /* v5.13b: nothing to save unless we're attached to a row. */
    if(!currentDraftId){
      /* Show the Save button if there's editor content the user might
         want to keep. */
      var hasContent=editorEl&&editorEl.innerHTML&&editorEl.innerHTML.trim().length>0;
      var saveBtn=document.getElementById('saveDraftBtn');
      if(saveBtn)saveBtn.style.display=hasContent?'':'none';
      return;
    }
    var updates={
      case_type_id:ctVal,
      subcat_id:stVal,
      doc_type_id:dtVal,
      heading_data:draftHeading,
      instructions:instrVal,
      draft_content:contentVal
    };
    api('/api/drafts?id='+currentDraftId,'PUT',updates).then(function(){
      unsavedEdits=false;
    }).catch(function(e){console.log('Draft auto-save:',e.message);});
  },1500);
}

/* v5.14a: clearDraftEditor — Clear Draft button handler.
   Empties the editor, resets action heading to default, clears
   instructions, resets Library dropdowns, drops selected source docs and
   precedents, sets currentDraftId to null so the next save creates a
   fresh row, and hides the output wrap so the user is back to the
   instructions-input state. Saved drafts in the `drafts` table are NOT
   deleted — only the on-screen editor state is cleared. */
function clearDraftEditor(){
  if(!confirm('Clear draft from editor?\n\nSaved drafts remain accessible via Previous drafts.'))return;
  /* Empty the editor */
  var editor=document.getElementById('draftEditor');
  if(editor)editor.innerHTML='';
  /* Hide the output wrap and show the instructions body again */
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
  /* Clear selected source docs and precedents */
  if(typeof draftSelectedDocs!=='undefined')draftSelectedDocs={src1:[],src2:[],src3:[],ctx:[],prec:[]};
  if(typeof draftSelectedPrecedents!=='undefined')draftSelectedPrecedents=[];
  if(typeof renderDraftSelectedDocs==='function')renderDraftSelectedDocs();
  if(typeof renderDraftSelectedPrecedents==='function')renderDraftSelectedPrecedents();
  /* Reset action heading to default state */
  draftHeading={party1:'',party1Role:'',party2:'',party2Role:'',court:'',caseNo:'',docTitle:''};
  var headingText=document.getElementById('draftHeadingText');
  if(headingText)headingText.textContent='Click to set action heading…';
  if(typeof updateActionHeading==='function')updateActionHeading();
  /* Detach from saved row — next save creates a fresh row */
  currentDraftId=null;
  unsavedEdits=false;
  /* Hide Save and Clear buttons */
  var saveBtn=document.getElementById('saveDraftBtn');
  if(saveBtn)saveBtn.style.display='none';
  var clearBtn=document.getElementById('clearDraftBtn');
  if(clearBtn)clearBtn.style.display='none';
  if(typeof showToast==='function')showToast('Draft cleared');
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
  document.getElementById('hdDocTitle').value=draftHeading.docTitle||'';
  /* v5.16a: load doc-titles list (cached after first load) and render the
     select with the current value pre-selected. The select is the
     user-facing control; the hidden #hdDocTitle is the source-of-truth
     value read by saveHeading() and updateHeadingPreview(). */
  if(draftDocTitlesCache===null){
    loadDocTitles();/* fire-and-forget — renderDocTitleSelect runs when it returns */
  }else{
    renderDocTitleSelect();
  }
  /* If the current docTitle isn't in the list yet, tack it onto the select
     so the user sees it as the selected option (won't get lost). */
  setTimeout(function(){
    var sel=document.getElementById('hdDocTitleSelect');
    if(!sel)return;
    var current=draftHeading.docTitle||'';
    if(current){
      var found=false;
      for(var i=0;i<sel.options.length;i++){
        if(sel.options[i].value===current){found=true;break;}
      }
      if(!found){
        var opt=document.createElement('option');
        opt.value=current;opt.textContent=current+' (not in list)';
        sel.appendChild(opt);
      }
      sel.value=current;
    }else{
      sel.value='';
    }
  },50);
  updateHeadingPreview();
  document.getElementById('headingModal').style.display='flex';
}
/* ═══════════════════════════════════════════════════════════════════════════
   v5.16b — SHARED HEADING RENDERER
   ───────────────────────────────────────────────────────────────────────────
   Used by both the action heading bar (above the editor) and the heading
   preview inside the modal. Handles three case shapes:
   - "BETWEEN" two-party: party1 + party2 both present.
   - "IN THE MATTER OF" single-party: docTitle starts with "IN THE MATTER OF"
     OR party1Role contains "in the matter of".
   - Single-party "BETWEEN": party1 present, party2 absent, no IN THE
     MATTER OF signal \u2014 still rendered, just without the party2 row.
   Layout per Tom's spec: court left + caseNo right on the top row;
   connector word centred (BETWEEN or IN THE MATTER OF); parties centred;
   doc title centred between two navy lines.
   ═══════════════════════════════════════════════════════════════════════════ */
function _hdgIsInTheMatter(headingObj){
  /* Decide between BETWEEN and IN THE MATTER OF based on docTitle/docType.
     Per Tom's spec: 'Always look at the docTitle/docType \u2014 if it includes
     IN THE MATTER OF, use that connector; otherwise BETWEEN.' */
  var dt=(headingObj&&headingObj.docTitle)?headingObj.docTitle:'';
  if(/in the matter of/i.test(dt))return true;
  /* Fallback: also check the selected Doc Type from Sector 1 (Case tab),
     in case the user hasn't set a docTitle explicitly yet. */
  var dtSel=document.getElementById('draftDocType');
  if(dtSel&&dtSel.value&&dtSel.selectedIndex>0){
    var dtName=dtSel.options[dtSel.selectedIndex].text||'';
    if(/in the matter of/i.test(dtName))return true;
  }
  /* And party1Role \u2014 if the AI suggestion put 'In the Matter of' there. */
  var p1r=(headingObj&&headingObj.party1Role)?headingObj.party1Role:'';
  if(/in the matter of/i.test(p1r))return true;
  return false;
}

function renderHeadingHtml(headingObj){
  if(!headingObj)return '';
  var court=(headingObj.court||'').trim();
  var caseNo=(headingObj.caseNo||'').trim();
  var p1=(headingObj.party1||'').trim();
  var p1r=(headingObj.party1Role||'').trim();
  var p2=(headingObj.party2||'').trim();
  var p2r=(headingObj.party2Role||'').trim();
  var docTitle=(headingObj.docTitle||'').trim();
  /* If absolutely nothing is set, return empty so callers can fall back to
     placeholder text. */
  if(!court&&!caseNo&&!p1&&!p2&&!docTitle)return '';

  var inMatter=_hdgIsInTheMatter(headingObj);

  var html='<div style="font-family:\'Libre Baskerville\',serif;line-height:1.7;color:var(--navy)">';

  /* Top row: court left, caseNo right. Use flex so they sit on a single
     conceptual row even when court has multiple lines. */
  if(court||caseNo){
    html+='<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;margin-bottom:.5rem">';
    if(court){
      /* Court is bold + uppercase + underlined per Tom's spec. White-space:pre-line
         lets multi-line court names (e.g. with FINANCIAL SERVICES DIVISION on a
         second line) render with line breaks if the AI returned them that way. */
      html+='<div style="font-size:.88rem;font-weight:700;text-transform:uppercase;text-decoration:underline;text-align:left;white-space:pre-line">'+esc(court)+'</div>';
    }else{
      html+='<div></div>';
    }
    if(caseNo){
      html+='<div style="font-size:.85rem;text-align:right;white-space:nowrap">'+esc(caseNo)+'</div>';
    }
    html+='</div>';
  }

  /* Connector + parties block, centred. */
  if(p1||p2){
    html+='<div style="text-align:center">';
    if(inMatter){
      html+='<div style="font-size:.85rem;font-weight:700;letter-spacing:.04em;margin:.4rem 0 .2rem">IN THE MATTER OF</div>';
      if(p1)html+='<div style="font-size:.92rem;font-weight:700">'+esc(p1)+'</div>';
      if(p2){
        html+='<div style="font-size:.82rem;margin:.2rem 0">\u2014 and \u2014</div>';
        html+='<div style="font-size:.92rem;font-weight:700">'+esc(p2)+'</div>';
      }
    }else{
      html+='<div style="font-size:.85rem;font-weight:700;letter-spacing:.04em;margin:.4rem 0 .2rem">BETWEEN:</div>';
      if(p1){
        html+='<div style="font-size:.92rem;font-weight:700">'+esc(p1);
        if(p1r)html+='<span style="font-weight:400;margin-left:2rem">'+esc(p1r)+'</span>';
        html+='</div>';
      }
      if(p2){
        html+='<div style="font-size:.82rem;margin:.2rem 0">\u2014 and \u2014</div>';
        html+='<div style="font-size:.92rem;font-weight:700">'+esc(p2);
        if(p2r)html+='<span style="font-weight:400;margin-left:2rem">'+esc(p2r)+'</span>';
        html+='</div>';
      }
    }
    html+='</div>';
  }

  /* Doc title centred between two navy lines. */
  var displayDocTitle=docTitle||getSelectedDocTypeName();
  if(displayDocTitle){
    html+='<div style="text-align:center">';
    html+='<div style="margin:.6rem auto .2rem;width:80%;border-top:3px solid var(--navy)"></div>';
    html+='<div style="font-size:1rem;font-weight:700;letter-spacing:.08em">'+esc(displayDocTitle.toUpperCase())+'</div>';
    html+='<div style="margin:.2rem auto .4rem;width:80%;border-top:3px solid var(--navy)"></div>';
    html+='</div>';
  }

  html+='</div>';
  return html;
}

function updateHeadingPreview(){
  /* v5.16b: build a temporary heading object from the modal inputs and
     render with the shared renderer. */
  var temp={
    court:document.getElementById('hdCourt').value.trim(),
    caseNo:document.getElementById('hdCaseNo').value.trim(),
    party1:document.getElementById('hdParty1').value.trim(),
    party1Role:document.getElementById('hdParty1Role').value.trim(),
    party2:document.getElementById('hdParty2').value.trim(),
    party2Role:document.getElementById('hdParty2Role').value.trim(),
    docTitle:document.getElementById('hdDocTitle').value.trim()
  };
  var html=renderHeadingHtml(temp);
  var preview=document.getElementById('headingPreview');
  if(preview){
    preview.innerHTML=html||'<div style="text-align:center;color:var(--text-faint);font-style:italic;font-size:.85rem;padding-top:1rem">Preview will appear here as you fill in the fields.</div>';
  }
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
  /* C2: If party names form a case name, offer to update the matter.
     v5.16b: only prompt for two-party BETWEEN cases \u2014 'A v B' isn't a
     sensible matter name for an in-the-matter-of single-party case. */
  var matterId=document.getElementById('draftMatterSelect').value;
  if(matterId&&draftHeading.party1&&draftHeading.party2&&!_hdgIsInTheMatter(draftHeading)){
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
  /* v5.16b: shared renderer. The old version required both party1 AND
     party2 to render anything; now we render whatever's present. The
     button label still summarises briefly. */
  var btn=document.getElementById('draftHeadingBtn');
  var inlineHeading=document.getElementById('draftHeadingText');
  var p1=draftHeading.party1||'';
  var p2=draftHeading.party2||'';
  var hasAnything=!!(p1||p2||draftHeading.court||draftHeading.caseNo||draftHeading.docTitle);

  /* Button label: "P1 v P2" for two-party, "P1" alone for single, otherwise placeholder. */
  if(p1&&p2&&!_hdgIsInTheMatter(draftHeading)){
    btn.textContent=p1+' v '+p2;
  }else if(p1){
    btn.textContent=p1;
  }else if(draftHeading.court){
    btn.textContent='[heading set]';
  }else{
    btn.textContent='Click to set heading\u2026';
  }

  if(inlineHeading){
    if(hasAnything){
      var html=renderHeadingHtml(draftHeading);
      inlineHeading.innerHTML=html||'Click to set action heading\u2026';
    }else{
      inlineHeading.textContent='Click to set action heading\u2026';
    }
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
/* v5.16e Push A: shared poll-body for both fresh and resumed draft jobs.
   Runs the 10-second poll loop, renders the result into the editor on
   completion, and persists a new drafts row. Behaviour for both call sites
   is now guaranteed identical because they share this function.
   ctxSource='generate' for a freshly-submitted job, 'resume' for a job
   reattached on tab activation; only used in toast/log strings.
   v5.17 Push C: signature gains draftRowId. The drafts row is now created
   server-side at job-start by api/tools.js v5.17 (or by the worker on
   completion of an older job); the client no longer POSTs a new row on
   completion. Instead, we refresh the previous-drafts list and use the
   refreshed data to attach currentDraftId. draftRowId can be null for
   jobs created before v5.17 deploys \u2014 in that case the refresh still
   finds the row (worker creates it via the legacy path) but we don't
   pre-attach currentDraftId here. */
function _runDraftPoll(jobId,matterId,ctId,stId,dtId,instructions,prog,ctxSource,draftRowId){
  var pollCount=0;
  var draftPoll=setInterval(async function(){
    try{
      pollCount++;
      var j=await api('/api/jobs?id='+jobId);
      if(!j)return;
      if(j.batchesTotal>0&&j.batchesDone>0){prog.textContent='Generating draft\u2026 batch '+j.batchesDone+' of '+j.batchesTotal;}
      if(j.status==='complete'||j.status==='partial'){
        clearInterval(draftPoll);
        document.getElementById('draftGenerateBtn').disabled=false;prog.style.display='none';
        /* v5.16e: clear the in-flight stash so a later tab activation
           doesn't try to reattach to a now-finished job. */
        if(window._inflightDraftJob&&window._inflightDraftJob.jobId===jobId)window._inflightDraftJob=null;
        var resultText=j.result||'';
        document.getElementById('draftInstructionsBody').style.display='none';
        var outputWrap=document.getElementById('draftOutputWrap');outputWrap.classList.remove('hidden');
        var editor=document.getElementById('draftEditor');editor.innerHTML=renderMd(resultText);editor.focus();
        /* v5.14a: show Clear Draft button as soon as the editor has content */
        updateClearDraftBtnVisibility();
        /* v5.13b: persist a new draft row in the `drafts` table and
           attach the editor to it via currentDraftId. Subsequent
           manual edits will PUT to this same row (no duplicate rows).
           v5.17 Push C: client-side save REMOVED. The worker now writes
           draft_content to a drafts row created at job-start by
           api/tools.js v5.17 (or, for older jobs without draftRowId,
           the legacy server path that doesn't yet exist \u2014 those
           jobs lose persistence and the user sees an empty drafts list,
           but they're a one-time deployment-window concern, expected to
           be rare). Instead of POSTing a new row, we refresh the
           previous-drafts list (which now includes the worker-saved
           row) and attach currentDraftId from the row whose id matches
           draftRowId. Diagnostic console.log is part of the safety net
           agreed with Tom: if the refresh doesn't find the row, the log
           makes it visible. */
        (async function(){
          try{
            await loadDraftsForMatter(matterId);
            if(draftRowId){
              currentDraftId=draftRowId;
              unsavedEdits=false;
              var saveBtn=document.getElementById('saveDraftBtn');
              if(saveBtn)saveBtn.style.display='none';
              console.log('v5.17 draft row '+draftRowId+' attached as currentDraftId; '+ctxSource+' completion');
            } else {
              /* No draftRowId means this job was created before v5.17 deploys.
                 The worker has no row to update, so no drafts row exists for
                 this generation. Don't attach currentDraftId; user can copy
                 the editor content out manually if needed. */
              console.log('v5.17 '+ctxSource+' completion with no draftRowId (legacy job) \u2014 no drafts row attached');
            }
          }catch(refreshErr){console.log('Draft post-'+ctxSource+' refresh failed:',refreshErr.message);}
        })();
        return;
      }
      if(j.status==='failed'){
        clearInterval(draftPoll);
        document.getElementById('draftGenerateBtn').disabled=false;prog.style.display='none';
        if(window._inflightDraftJob&&window._inflightDraftJob.jobId===jobId)window._inflightDraftJob=null;
        showToast('Draft error: '+(j.error||'Unknown error'));return;
      }
      if(pollCount>360){
        clearInterval(draftPoll);
        document.getElementById('draftGenerateBtn').disabled=false;
        prog.textContent='Draft is taking longer than expected. Check History later.';
        if(window._inflightDraftJob&&window._inflightDraftJob.jobId===jobId)window._inflightDraftJob=null;
      }
    }catch(pollErr){console.log('Draft poll error:',pollErr.message);}
  },10000);
}

/* v5.16e Push A: reattach a poll loop to an in-flight draft job that was
   stashed by tools.js resumeInProgressJobs. Called from onDraftTabActivated.
   Reads the job's parameters from /api/jobs?id= so we render with the same
   case-type/stage/doc-type/instructions the worker is using.
   Guarded so it can only run once per stashed job: we null the stash before
   starting the poll, and the poll's completion handler also nulls it.
   If the matter the user is currently viewing on the Drafting tab differs
   from the in-flight job's matter, we do NOT reattach silently \u2014 the
   user would see a draft from a different matter appear in the editor.
   Instead we show a hint in the progress message and leave the stash alone
   so a later tab activation on the right matter can pick it up. */
async function attachDraftPoll(){
  if(!window._inflightDraftJob)return;
  var stash=window._inflightDraftJob;
  var draftMatterId=document.getElementById('draftMatterSelect').value;
  if(stash.matterId&&draftMatterId&&stash.matterId!==draftMatterId){
    console.log('v5.16e in-flight draft is for matter '+stash.matterId+' but Drafting tab is on '+draftMatterId+' \u2014 not reattaching');
    return;
  }
  /* Pull the job's parameters so the eventual save uses the right ids. */
  var j;try{j=await api('/api/jobs?id='+stash.jobId);}catch(e){console.log('attachDraftPoll fetch failed:',e.message);return;}
  if(!j||j.status==='complete'||j.status==='partial'||j.status==='failed'){
    /* Already finished or not findable \u2014 clear the stash and bail. */
    window._inflightDraftJob=null;
    return;
  }
  var p=j.parameters||{};
  var matterId=stash.matterId||j.matter_id||draftMatterId;
  var ctId=p.caseTypeId||'';
  var stId=p.subcatId||'';
  var dtId=p.docTypeId||'';
  var instructions=j.instructions||'';
  /* v5.17 Push C: pull draftRowId from job parameters so on completion the
     refresh can attach currentDraftId to the row the worker is updating.
     Null/missing for jobs created before v5.17 \u2014 those follow the
     legacy "no drafts row attached" branch in _runDraftPoll. */
  var draftRowId=p.draftRowId||null;
  /* Clear the stash NOW so a second activation doesn't double-attach. */
  window._inflightDraftJob=null;
  /* Surface the resume in the UI. */
  document.getElementById('draftGenerateBtn').disabled=true;
  var prog=document.getElementById('draftProgressMsg');
  if(prog){prog.style.display='';prog.textContent='Resuming in-flight draft generation\u2026';}
  console.log('v5.16e attachDraftPoll: reattaching to job '+stash.jobId+' on matter '+matterId+(draftRowId?' (drafts row '+draftRowId+')':' (legacy, no drafts row)'));
  _runDraftPoll(stash.jobId,matterId,ctId,stId,dtId,instructions,prog,'resume',draftRowId);
}

/* v3.4: generateDraft uses fire-and-poll background processing.
   v5.16e Push A: poll body extracted to _runDraftPoll so the resume path
   uses the same code. */
async function generateDraft(){
  var matterId=document.getElementById('draftMatterSelect').value;
  if(!matterId){showToast('Select a matter first');return;}
  var instructions=document.getElementById('draftMainInstructions').value.trim();
  if(!instructions){showToast('Please enter drafting instructions');return;}
  /* v5.16f Push B: duplicate-job guard. Before kicking off a new draft job,
     check the server for any in-flight draft job on this matter. The check
     is server-side (not just window._inflightDraftJob) because that stash
     only knows about jobs this tab has seen. A job submitted in another
     tab, or one that survived a tab close, will only show up in /api/jobs.
     Statuses we treat as "in flight": pending, running, paused, synthesising.
     v5.16g (06 May): /api/jobs returns toolName (camelCase), not tool_name.
     Confirmed by console inspection: Object.keys returned
     id,toolName,status,batchesTotal,batchesDone,createdAt,startedAt,
     completedAt,instructions. The earlier guard's ||jj.toolName check should
     have matched but didn't, suggesting Safari served cached drafting.js
     for the test. This version logs whether the guard ran so cache misses
     are visible in the console. */
  try{
    var inflight=await api('/api/jobs?matterId='+matterId);
    var draftJobs=(inflight&&inflight.jobs)?inflight.jobs.filter(function(jj){return jj.toolName==='draft';}):[];
    var existing=draftJobs.find(function(jj){
      return jj.status==='pending'||jj.status==='running'||jj.status==='paused'||jj.status==='synthesising';
    });
    console.log('v5.16g guard: '+draftJobs.length+' draft jobs total, '+(existing?'1 in-flight ('+existing.status+')':'0 in-flight')+' for matter '+matterId);
    if(existing){
      showToast('A draft is already being generated for this matter \u2014 please wait for it to finish');
      /* If we don't already have a poll attached, stash and attach so the
         result lands in the editor instead of being lost. */
      if(!window._inflightDraftJob){
        window._inflightDraftJob={jobId:existing.id,matterId:matterId};
        if(typeof attachDraftPoll==='function')attachDraftPoll();
      }
      return;
    }
  }catch(guardErr){
    /* Server unreachable \u2014 fall through and let the normal error path
       surface anything that goes wrong. The guard is defensive, not a hard
       gate. */
    console.log('Draft duplicate-job guard skipped:',guardErr.message);
  }
  var ctId=document.getElementById('draftCaseType').value;
  var dtId=document.getElementById('draftDocType').value;
  var stId=document.getElementById('draftStage').value;
  /* v5.16a (Issue #1 belt-and-braces): re-render the action heading from
     draftHeading immediately before the API call, so what's sent (the
     courtHeading body field, which is exactly draftHeading) matches what
     the user sees. Cheap and idempotent. */
  if(typeof updateActionHeading==='function')updateActionHeading();
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
    /* v5.17 Push C: api/tools.js v5.17 now returns draftRowId for draft
       jobs \u2014 the id of the drafts row created at job-start. We pass
       it into _runDraftPoll so on completion currentDraftId attaches
       to the worker-updated row. Null if the deployed api/tools.js is
       still older than v5.17 \u2014 _runDraftPoll handles that gracefully. */
    var freshDraftRowId=d.draftRowId||null;
    if(freshDraftRowId){
      currentDraftId=freshDraftRowId;
      console.log('v5.17 generateDraft: drafts row '+freshDraftRowId+' pre-created server-side, attached as currentDraftId');
    }
    prog.textContent='Generating draft\u2026 (processing in background, you can navigate away)';
    /* v5.16e: stash this fresh job too, so reload-then-tab-activation
       reattaches without losing the draft. The poll completion handler
       clears the stash. */
    window._inflightDraftJob={jobId:d.jobId,matterId:matterId};
    _runDraftPoll(d.jobId,matterId,ctId,stId,dtId,instructions,prog,'generate',freshDraftRowId);
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
/* ── v5.16a: AI HEADING SUGGESTION (rewritten for reliability) ───────────
   Changes from v2.5:
   1. No longer guarded on draftHeading.caseNo — runs on every matter switch.
   2. Race-condition safe: ignores the response if the user has switched
      matter while the request was in flight (compares matterId against
      the live select value at apply-time).
   3. Validation: rejects suggestions that don't have at least a court +
      one of (caseNo, party1). Garbage in, no toast, no mutation.
   4. Doesn't blindly OR over existing fields anymore — the matter-name
      parsing in draftMatterChanged is the baseline; the AI suggestion
      OVERWRITES the baseline only when validation passes, and only for
      the current matter. */
async function draftAISuggestHeading(matterId){
  if(!matterId)return;
  /* v5.16c: dedicated endpoint /api/extract_heading replaces /api/analyse for
     this call. The new endpoint pulls first 1\u20132 chunks per document, regex-
     prefilters for court+action-number, and sends only matching chunks to
     Claude. Faster, deterministic, and doesn't depend on doc_type labels. */
  var requestMatterId=matterId;
  try{
    var d=await api('/api/extract_heading','POST',{matterId:matterId});
    /* Race-condition guard: if the user has switched matter while we were
       waiting, drop the response on the floor. */
    var sel=document.getElementById('draftMatterSelect');
    var liveId=sel?sel.value:'';
    if(liveId!==requestMatterId){
      console.log('AI heading suggestion: matter changed while in flight, ignoring');
      return;
    }
    /* Endpoint returns either {heading: {...}} on success or
       {heading: null, reason: '...'} when no court doc was found / validation
       failed. We just leave the baseline untouched in the null case. */
    if(!d||!d.heading){
      var why=(d&&d.reason)?d.reason:'no_heading';
      console.log('AI heading suggestion: '+why+' \u2014 leaving baseline');
      return;
    }
    var h=d.heading;
    /* Endpoint already validates and normalises (uppercase parties, trimmed,
       court + caseNo|party1 guaranteed) so we apply directly. */
    if(h.court)draftHeading.court=h.court;
    if(h.caseNo)draftHeading.caseNo=h.caseNo;
    if(h.party1)draftHeading.party1=h.party1;
    if(h.party1Role)draftHeading.party1Role=h.party1Role;
    if(h.party2)draftHeading.party2=h.party2;
    if(h.party2Role)draftHeading.party2Role=h.party2Role;
    if(h.docTitle)draftHeading.docTitle=h.docTitle;
    updateActionHeading();
    showToast('Heading suggested from documents \u2014 click to edit');
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
