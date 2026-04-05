/* ── LIBRARY ──────────────────────────────────────────────────────────────── */
async function loadLibrary(){
  if(!token)return;
  try{
    var results=await Promise.all([api('/api/library?type=case_types'),api('/api/library?type=subcats'),api('/api/library?type=doc_types'),api('/api/library?type=precedents'),api('/api/library?type=sections')]);
    libraryData.caseTypes=results[0].data||[];
    libraryData.subcats=results[1].data||[];
    libraryData.docTypes=results[2].data||[];
    libraryData.precedents=results[3].data||[];
    libraryData.sections=results[4].data||[];
    libPopulateSearchFilters();
    libFilterSearch();
    libPopulateDraftSelects();
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
  /* Show case type / stage / doc type as metadata text */
  var metaParts=[];
  var ct=libraryData.caseTypes.find(function(c){return c.id===p.case_type_id;});
  if(ct)metaParts.push('Case Type: '+ct.name);
  var subId=p.subcategory_id||p.subcat_id||'';
  var sc=libraryData.subcats.find(function(s){return s.id===subId;});
  if(sc)metaParts.push('Stage: '+sc.name);
  var dt=libraryData.docTypes.find(function(d){return d.id===p.doc_type_id;});
  if(dt)metaParts.push('Doc Type: '+dt.name);
  if(p.jurisdiction)metaParts.push('Jurisdiction: '+p.jurisdiction);
  document.getElementById('libPrecMeta').textContent=metaParts.join(' · ')||'No classification set';
  /* Context */
  document.getElementById('libContextExplanation').value=p.context_relationship||'';
  /* Commentary */
  document.getElementById('libCommentary').value=p.commentary||'';
  document.getElementById('libIsOwnDoc').checked=!!p.is_own_style;
  document.getElementById('libAiInstructions').value=p.ai_instructions||'';
  /* Update search highlight */
  libFilterSearch();
}

function libBoxCaseTypeChanged(){}
function libBoxStageChanged(){}

async function libSavePrecedentChanges(){
  if(!selectedPrecedentId){showToast('No precedent selected');return;}
  try{
    await api('/api/library','POST',{
      action:'update_precedent',
      id:selectedPrecedentId,
      commentary:document.getElementById('libCommentary').value,
      is_own_style:document.getElementById('libIsOwnDoc').checked,
      ai_instructions:document.getElementById('libAiInstructions').value,
      context_relationship:document.getElementById('libContextExplanation').value
    });
    await loadLibrary();showToast('Precedent saved');
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
/* A3: AI auto-fills document name when PDF selected */
async function precUpFileChanged(input){
  if(!input.files||!input.files[0])return;
  var file=input.files[0];
  var nameField=document.getElementById('precUpName');
  /* Only suggest if the name field is empty */
  if(nameField.value.trim())return;
  var hint=document.getElementById('precUpAiHint');
  hint.style.display='';hint.textContent='Reading PDF to suggest a name…';
  try{
    var text=await extractPdfText(file);
    if(!text||text.trim().length<30){hint.style.display='none';return;}
    /* Send first 2000 chars to AI for name suggestion */
    var snippet=text.slice(0,2000);
    var d=await api('/api/analyse','POST',{matterId:'',matterName:'',matterNature:'',matterIssues:'',messages:[{role:'user',content:'You are reading the first pages of a legal document. Extract the most likely document name — this should be the case name (e.g. "Smith v Jones") or the first party name if no case name is found. Return ONLY the suggested name, nothing else. No quotes, no explanation.\n\nTEXT:\n'+snippet}],jurisdiction:jurisdiction,queryType:'Factual Analysis',focusAreas:[]});
    if(d&&d.result){
      var suggested=d.result.trim().replace(/^["']|["']$/g,'').slice(0,120);
      if(suggested&&suggested.length>2){
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
  document.getElementById('quickAddModal').style.display='flex';
  setTimeout(function(){document.getElementById('quickAddName').focus();},100);
}
async function quickAddSave(){
  var name=document.getElementById('quickAddName').value.trim();
  if(!name){showToast('Please enter a name');return;}
  try{
    if(quickAddType==='casetype'){
      await api('/api/library','POST',{action:'create_case_type',name:name,jurisdiction:jurisdiction,subcats:[],docTypes:[]});
    }else if(quickAddType==='subcat'){
      var ctId=document.getElementById('libSearchCaseType')?document.getElementById('libSearchCaseType').value:null;
      if(!ctId){var sel=document.getElementById('libBoxCaseType');if(sel)ctId=sel.value;}
      if(!ctId){var dsel=document.getElementById('draftCaseType');if(dsel)ctId=dsel.value;}
      if(!ctId&&libraryData.caseTypes.length){ctId=libraryData.caseTypes[0].id;}
      if(!ctId){showToast('Add a case type first');return;}
      await api('/api/library','POST',{action:'create_subcat',name:name,case_type_id:ctId});
    }else if(quickAddType==='doctype'){
      var ctId2=document.getElementById('libSearchCaseType')?document.getElementById('libSearchCaseType').value:null;
      if(!ctId2){var sel2=document.getElementById('libBoxCaseType');if(sel2)ctId2=sel2.value;}
      if(!ctId2){var dsel2=document.getElementById('draftCaseType');if(dsel2)ctId2=dsel2.value;}
      if(!ctId2&&libraryData.caseTypes.length){ctId2=libraryData.caseTypes[0].id;}
      if(!ctId2){showToast('Add a case type first');return;}
      await api('/api/library','POST',{action:'create_doc_type',name:name,case_type_id:ctId2});
    }
    closeModal('quickAddModal');
    await loadLibrary();
    /* Re-populate the upload modal dropdowns if it's still open */
    if(document.getElementById('precUploadModal').style.display==='flex'){
      precUpCaseTypeChanged();
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
