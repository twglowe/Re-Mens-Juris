/* ── ENTITY RELATIONSHIP DIAGRAM (v3.6 — Stages 3b-5: pre-gen filters, follow-up chat, history) ── */
var diagramData=null;
var diagramZoom=1;
var diagramPositions={};
var diagramBoxW=160;
var diagramBoxH=54;
var diagramPersonsText='';
var diagramFocusEntities=[];
var diagramActiveFilters=[];
var diagramDrawLines=null; /* globally accessible drawLines reference */
var diagramPreGenFilters=[]; /* filter types selected BEFORE generation */
var diagramFollowUpHistory=[]; /* array of {question, explanation} for Stage 5 */

/* Colour scheme for relationship types — expanded for offshore structures */
var relColours={
  director:'#1d6fa4',shareholder:'#27ae60',indirect_shareholder:'#1e8449',
  ultimate_beneficial_owner:'#145a32',limited_partner:'#7d3c98',general_partner:'#6c3483',
  beneficiary:'#8e44ad',trustee:'#e67e22',protector:'#ca6f1e',enforcer:'#a04000',settlor:'#d4ac0d',
  nominee:'#17a589',registered_agent:'#148f77',
  manager:'#2980b9',officer:'#16a085',creditor:'#c0392b',debtor:'#e74c3c',
  spouse:'#e84393',parent_child:'#d35400',employer:'#2c3e50',subsidiary:'#0984e3',
  advisor:'#6c5ce7',agent:'#00b894',partner:'#b7950b',guarantor:'#e17055',other:'#636e72'
};
var entityColours={person:'#1d6fa4',company:'#27ae60',trust:'#8e44ad',fund:'#e67e22',partnership:'#b7950b',government:'#c0392b',other:'#636e72'};

var NS='http://www.w3.org/2000/svg';

/* Relationship filter categories */
var diagramFilterCategories=[
  {label:'Shareholdings',types:['shareholder','indirect_shareholder','ultimate_beneficial_owner']},
  {label:'Investments',types:['limited_partner','general_partner','partner']},
  {label:'Creditor',types:['creditor']},
  {label:'Debtor',types:['debtor']},
  {label:'Trustees',types:['trustee','protector','enforcer','settlor']},
  {label:'Beneficiary',types:['beneficiary']},
  {label:'Family',types:['spouse','parent_child']},
  {label:'Corporate',types:['director','manager','officer','subsidiary','employer']},
  {label:'Other',types:['nominee','registered_agent','advisor','agent','guarantor','other']}
];

/* Parse entity names from Dramatis Personae markdown text */
function parseDramatisPersonaeNames(text){
  var names=[];
  var lines=text.split('\n');
  for(var i=0;i<lines.length;i++){
    var m=lines[i].match(/^###\s+(.+)/);
    if(m){
      var name=m[1].replace(/\*+/g,'').trim();
      if(name&&name.length>1&&name.length<120)names.push(name);
    }
  }
  return names;
}

/* Create or switch to diagram tab with custom workspace */
function getOrCreateDiagramTab(){
  if(openTabs.indexOf('diagram')!==-1){switchTab('diagram');return false;}
  var tabBar=document.getElementById('tabBar');
  tabBar.style.display='flex';
  var tab=document.createElement('div');
  tab.className='tab';tab.dataset.tab='diagram';
  tab.innerHTML='📈 Diagram<button class="tab-close" title="Close tab">×</button>';
  tab.querySelector('.tab-close').addEventListener('click',function(e){e.stopPropagation();closeTab('diagram');});
  tab.addEventListener('click',function(){switchTab('diagram');});
  tabBar.appendChild(tab);
  /* Create custom workspace — NOT the standard tool-ready template */
  var ws=document.createElement('div');
  ws.className='tool-workspace tab-workspace diagram-workspace';ws.dataset.tool='diagram';
  ws.innerHTML='<div class="diagram-toolbar" id="diagramToolbar" style="display:none"></div>'
    +'<div class="diagram-container" id="diagramContainer"></div>'
    +'<div class="diagram-legend" id="diagramLegend" style="display:none"></div>'
    +'<div class="diagram-chat-area" id="diagramChatArea" style="display:none"></div>';
  document.getElementById('toolWorkspaces').appendChild(ws);
  openTabs.push('diagram');
  switchTab('diagram');
  return true;
}

/* Show the focal entity selection panel — Stage 3b: now includes relationship filter checkboxes */
function showDiagramFocusPanel(personsText){
  diagramPersonsText=personsText;
  diagramFocusEntities=[];
  diagramPreGenFilters=[];
  getOrCreateDiagramTab();
  var container=document.getElementById('diagramContainer');
  var entityNames=parseDramatisPersonaeNames(personsText);
  var optionsHtml='<option value="">— Select entity to add —</option>';
  for(var i=0;i<entityNames.length;i++){
    optionsHtml+='<option value="'+esc(entityNames[i])+'">'+esc(entityNames[i])+'</option>';
  }
  /* Build relationship filter checkboxes — all checked by default */
  var filterHtml='<div class="diagram-focus-filters"><div class="diagram-focus-sub" style="margin-top:.8rem;margin-bottom:.4rem;font-weight:600">Relationship Filters <span style="font-weight:400;color:var(--text-faint)">(uncheck to exclude from diagram)</span></div><div class="diagram-pregen-filters" id="diagramPreGenFilters">';
  for(var fi=0;fi<diagramFilterCategories.length;fi++){
    var cat=diagramFilterCategories[fi];
    filterHtml+='<label class="diagram-filter-cb on" data-pregen-idx="'+fi+'"><input type="checkbox" checked onchange="togglePreGenFilter('+fi+',this)">'+cat.label+'</label>';
  }
  filterHtml+='</div></div>';

  container.innerHTML='<div class="diagram-focus-panel">'
    +'<div class="diagram-focus-title">Entity Relationship Diagram</div>'
    +'<div class="diagram-focus-sub">Optionally select up to three focal entities to centre the diagram on. Only entities connected to the focal entities will be shown. Leave on default to show all.</div>'
    +'<div class="diagram-focus-tags" id="diagramFocusTags"></div>'
    +(entityNames.length?'<select class="diagram-focus-select" id="diagramFocusSelect" onchange="addDiagramFocusEntity(this)">'+optionsHtml+'</select>':'<div style="font-size:.82rem;color:var(--text-faint)">No entities found in Dramatis Personae</div>')
    +filterHtml
    +'<div style="display:flex;gap:.5rem;margin-top:.75rem">'
    +'<button class="btn-run-tool" onclick="runDiagramGeneration()">Generate Diagram</button>'
    +'<button class="btn-secondary" style="padding:.5rem 1rem;font-size:.88rem" onclick="runDiagramGeneration()" id="diagramDefaultBtn">Default (show all)</button>'
    +'</div>'
    +'</div>';
  /* Hide toolbar and chat during selection */
  document.getElementById('diagramToolbar').style.display='none';
  document.getElementById('diagramLegend').style.display='none';
  document.getElementById('diagramChatArea').style.display='none';
}

/* Stage 3b: Toggle pre-generation filter checkbox */
function togglePreGenFilter(catIdx,checkbox){
  var label=checkbox.closest('.diagram-filter-cb');
  if(label)label.classList.toggle('on',checkbox.checked);
}

function addDiagramFocusEntity(select){
  var name=select.value;
  if(!name)return;
  if(diagramFocusEntities.indexOf(name)!==-1){select.value='';return;}
  if(diagramFocusEntities.length>=3){showToast('Maximum 3 focal entities');select.value='';return;}
  diagramFocusEntities.push(name);
  select.value='';
  renderDiagramFocusTags();
}

function removeDiagramFocusEntity(idx){
  diagramFocusEntities.splice(idx,1);
  renderDiagramFocusTags();
}

function renderDiagramFocusTags(){
  var container=document.getElementById('diagramFocusTags');
  if(!container)return;
  if(!diagramFocusEntities.length){container.innerHTML='<div style="font-size:.82rem;color:var(--text-faint);font-style:italic">Default — all entities</div>';return;}
  container.innerHTML=diagramFocusEntities.map(function(name,i){
    return '<span class="diagram-focus-tag">'+esc(name)+'<button onclick="removeDiagramFocusEntity('+i+')" title="Remove">\u00D7</button></span>';
  }).join('');
}

/* Run the diagram generation */
async function runDiagramGeneration(){
  diagramData=null;diagramZoom=1;diagramPositions={};diagramActiveFilters=[];diagramDrawLines=null;
  diagramFollowUpHistory=[];

  /* Stage 3b: Collect pre-generation filter types */
  diagramPreGenFilters=[];
  var preGenChecks=document.querySelectorAll('#diagramPreGenFilters input[type="checkbox"]');
  var allChecked=true;
  preGenChecks.forEach(function(cb){if(!cb.checked)allChecked=false;});
  if(!allChecked){
    /* Collect the types from checked categories only */
    preGenChecks.forEach(function(cb,idx){
      if(cb.checked){
        var cat=diagramFilterCategories[idx];
        for(var t=0;t<cat.types.length;t++){
          if(diagramPreGenFilters.indexOf(cat.types[t])===-1)diagramPreGenFilters.push(cat.types[t]);
        }
      }
    });
  }
  /* If all checked or none unchecked, send empty array (meaning "all types") */

  var container=document.getElementById('diagramContainer');
  container.innerHTML='<div class="diagram-loading"><div class="typing-bubble"><span></span><span></span><span></span></div><div style="font-size:.88rem;font-weight:500">Analysing entity relationships\u2026</div></div>';
  document.getElementById('diagramLegend').style.display='none';
  document.getElementById('diagramToolbar').style.display='none';
  document.getElementById('diagramChatArea').style.display='none';
  try{
    var body={personsText:diagramPersonsText,matterName:currentMatter?currentMatter.name:'',matterId:currentMatter?currentMatter.id:null,jurisdiction:jurisdiction};
    if(diagramFocusEntities.length>0)body.focusEntities=diagramFocusEntities;
    if(diagramPreGenFilters.length>0)body.filterTypes=diagramPreGenFilters;
    var d=await api('/api/diagram','POST',body);
    if(!d||!d.entities||d.entities.length===0){
      container.innerHTML='<div style="padding:2rem;text-align:center;color:var(--text-faint)">No entities found to diagram.</div>';
      return;
    }
    diagramData=d;
    renderDiagramSVG(d);
    buildDiagramToolbar();
    buildDiagramChatArea();
    /* Stage 5: Save to history */
    saveDiagramToHistory();
    if(d.usage&&d.usage.costUsd){showToast('Diagram generated \u2014 $'+d.usage.costUsd.toFixed(4));}
  }catch(e){
    container.innerHTML='<div style="padding:2rem;text-align:center;color:var(--error)">\u26A0\uFE0F Error: '+esc(e.message)+'</div>';
  }
}

/* Build the toolbar with filters and download buttons */
function buildDiagramToolbar(){
  var toolbar=document.getElementById('diagramToolbar');
  toolbar.style.display='flex';
  var html='<span class="diagram-toolbar-title">'+(currentMatter?esc(currentMatter.name)+' \u2014 ':'')+' Entity Diagram'+(diagramFocusEntities.length?' (focus: '+diagramFocusEntities.map(function(n){return esc(n);}).join(', ')+')':'')+'</span>';
  html+='<span class="diagram-toolbar-label">Filter:</span>';
  for(var fi=0;fi<diagramFilterCategories.length;fi++){
    var cat=diagramFilterCategories[fi];
    /* Stage 3b: Initialise post-render checkboxes to match pre-generation selection */
    var isActive=diagramPreGenFilters.length===0||diagramPreGenFilters.some(function(t){return cat.types.indexOf(t)!==-1;});
    html+='<label class="diagram-filter-cb'+(isActive?'':' on')+'" data-filter-idx="'+fi+'"><input type="checkbox"'+(isActive?'':' checked')+' onchange="toggleDiagramFilter('+fi+',this.checked)">'+cat.label+'</label>';
  }
  html+='<span style="width:1px;height:20px;background:var(--border);margin:0 .25rem"></span>';
  html+='<button class="diagram-dl-btn" onclick="downloadDiagramPptx()">\u2B07 PowerPoint</button>';
  html+='<button class="diagram-dl-btn" onclick="downloadDiagramSvg()">\u2B07 SVG</button>';
  html+='<button class="diagram-dl-btn" onclick="showDiagramFocusPanel(diagramPersonsText)" title="Re-generate with different focus">\u21BB Regenerate</button>';
  toolbar.innerHTML=html;
}

/* Toggle a filter category */
function toggleDiagramFilter(catIdx,checked){
  var cat=diagramFilterCategories[catIdx];
  if(checked){
    /* Add these types to active filters */
    for(var i=0;i<cat.types.length;i++){
      if(diagramActiveFilters.indexOf(cat.types[i])===-1)diagramActiveFilters.push(cat.types[i]);
    }
  }else{
    /* Remove these types from active filters */
    diagramActiveFilters=diagramActiveFilters.filter(function(t){return cat.types.indexOf(t)===-1;});
  }
  /* Update checkbox visual state */
  document.querySelectorAll('.diagram-filter-cb').forEach(function(el){
    var idx=parseInt(el.getAttribute('data-filter-idx'));
    var cb=el.querySelector('input');
    el.classList.toggle('on',cb.checked);
  });
  /* Redraw lines with filter */
  if(diagramDrawLines)diagramDrawLines();
}

function renderDiagramSVG(data){
  var entities=data.entities;
  var rels=data.relationships;
  var n=entities.length;
  var boxW=diagramBoxW;var boxH=diagramBoxH;
  var padX=80;var padY=80;
  var rx=Math.max(220,n*38);var ry=Math.max(160,n*28);
  var cx=rx+padX+boxW/2;var cy=ry+padY+boxH/2;
  var svgW=(rx+padX+boxW/2)*2;var svgH=(ry+padY+boxH/2)*2;

  /* Calculate initial positions around ellipse — but preserve existing positions for entities that already have one */
  var newPositions={};
  for(var i=0;i<n;i++){
    var existingPos=diagramPositions[entities[i].id];
    if(!existingPos){
      /* Try matching by name */
      var foundByName=null;
      for(var k in diagramPositions){
        var matchEnt=null;
        /* Look through previous data for name match */
        if(diagramData&&diagramData.entities){
          for(var me=0;me<diagramData.entities.length;me++){
            if(diagramData.entities[me].id===k){matchEnt=diagramData.entities[me];break;}
          }
        }
        if(matchEnt&&matchEnt.name===entities[i].name){foundByName=diagramPositions[k];break;}
      }
      if(foundByName){
        newPositions[entities[i].id]={x:foundByName.x,y:foundByName.y};
      }else{
        var angle=(2*Math.PI*i/n)-(Math.PI/2);
        var ex=cx+rx*Math.cos(angle)-boxW/2;
        var ey=cy+ry*Math.sin(angle)-boxH/2;
        newPositions[entities[i].id]={x:ex,y:ey};
      }
    }else{
      newPositions[entities[i].id]={x:existingPos.x,y:existingPos.y};
    }
  }
  diagramPositions=newPositions;

  /* Create SVG via DOM */
  var svg=document.createElementNS(NS,'svg');
  svg.setAttribute('viewBox','0 0 '+svgW+' '+svgH);
  svg.setAttribute('width',svgW);
  svg.setAttribute('height',svgH);
  svg.style.fontFamily='Source Sans 3,sans-serif';
  svg.style.background='#fff';
  svg.style.cursor='default';

  /* Defs — arrowhead markers */
  var defs=document.createElementNS(NS,'defs');
  var usedTypes={};
  for(var ri=0;ri<rels.length;ri++){usedTypes[rels[ri].type]=true;}
  var typeKeys=Object.keys(usedTypes);
  for(var ti=0;ti<typeKeys.length;ti++){
    var col=relColours[typeKeys[ti]]||relColours.other;
    var marker=document.createElementNS(NS,'marker');
    marker.setAttribute('id','arrow-'+typeKeys[ti]);
    marker.setAttribute('markerWidth','8');marker.setAttribute('markerHeight','6');
    marker.setAttribute('refX','8');marker.setAttribute('refY','3');marker.setAttribute('orient','auto');
    var poly=document.createElementNS(NS,'polygon');
    poly.setAttribute('points','0 0, 8 3, 0 6');poly.setAttribute('fill',col);
    marker.appendChild(poly);defs.appendChild(marker);
  }
  svg.appendChild(defs);

  /* Relationship lines group — drawn first so entities sit on top */
  var linesGroup=document.createElementNS(NS,'g');
  linesGroup.setAttribute('id','diagramLines');
  svg.appendChild(linesGroup);

  /* Draw lines — respects active filters */
  function drawLines(){
    while(linesGroup.firstChild)linesGroup.removeChild(linesGroup.firstChild);
    var hasFilters=diagramActiveFilters.length>0;
    for(var ri2=0;ri2<rels.length;ri2++){
      var rel=rels[ri2];
      /* Filter: if any filters are active, only show matching types */
      if(hasFilters&&diagramActiveFilters.indexOf(rel.type)===-1)continue;
      var sp=diagramPositions[rel.source];var tp=diagramPositions[rel.target];
      if(!sp||!tp)continue;
      var sCx=sp.x+boxW/2;var sCy=sp.y+boxH/2;
      var tCx=tp.x+boxW/2;var tCy=tp.y+boxH/2;
      var col2=relColours[rel.type]||relColours.other;

      var midX2=(sCx+tCx)/2;var midY2=(sCy+tCy)/2;
      var dx2=tCx-sCx;var dy2=tCy-sCy;
      var dist2=Math.sqrt(dx2*dx2+dy2*dy2)||1;
      var offset2=Math.min(40,dist2*0.15);
      var nx2=-dy2/dist2*offset2;var ny2=dx2/dist2*offset2;
      var cpx2=midX2+nx2;var cpy2=midY2+ny2;
      var angle2=Math.atan2(tCy-cpy2,tCx-cpx2);
      var endX2=tCx-Math.cos(angle2)*(boxW/2+4);
      var endY2=tCy-Math.sin(angle2)*(boxH/2+4);

      var path=document.createElementNS(NS,'path');
      path.setAttribute('d','M'+sCx+','+sCy+' Q'+cpx2+','+cpy2+' '+endX2+','+endY2);
      path.setAttribute('fill','none');path.setAttribute('stroke',col2);
      path.setAttribute('stroke-width','2');path.setAttribute('opacity','0.7');
      path.setAttribute('marker-end','url(#arrow-'+rel.type+')');
      linesGroup.appendChild(path);

      var labelX2=(sCx+cpx2*2+endX2)/4;var labelY2=(sCy+cpy2*2+endY2)/4;
      var txt=document.createElementNS(NS,'text');
      txt.setAttribute('x',labelX2);txt.setAttribute('y',labelY2);
      txt.setAttribute('font-size','10');txt.setAttribute('fill',col2);
      txt.setAttribute('text-anchor','middle');txt.setAttribute('font-weight','600');
      txt.textContent=rel.label||rel.type;
      linesGroup.appendChild(txt);
    }
  }
  /* Store globally so filters can call it */
  diagramDrawLines=drawLines;
  drawLines();

  /* Entity groups — draggable */
  for(var ei=0;ei<n;ei++){
    (function(ent,idx){
      var pos=diagramPositions[ent.id];
      var bgCol=entityColours[ent.type]||entityColours.other;
      var lightBg=hexToLight(bgCol);

      var g=document.createElementNS(NS,'g');
      g.setAttribute('transform','translate('+pos.x+','+pos.y+')');
      g.style.cursor='grab';
      g.setAttribute('data-entity-id',ent.id);

      /* Main box */
      var rect=document.createElementNS(NS,'rect');
      rect.setAttribute('x','0');rect.setAttribute('y','0');
      rect.setAttribute('width',boxW);rect.setAttribute('height',boxH);
      rect.setAttribute('rx','6');rect.setAttribute('fill',lightBg);
      rect.setAttribute('stroke',bgCol);rect.setAttribute('stroke-width','2');
      g.appendChild(rect);

      /* Type header bar */
      var hdr=document.createElementNS(NS,'rect');
      hdr.setAttribute('x','0');hdr.setAttribute('y','0');
      hdr.setAttribute('width',boxW);hdr.setAttribute('height','18');
      hdr.setAttribute('rx','6');hdr.setAttribute('fill',bgCol);
      g.appendChild(hdr);
      var hdr2=document.createElementNS(NS,'rect');
      hdr2.setAttribute('x','0');hdr2.setAttribute('y','12');
      hdr2.setAttribute('width',boxW);hdr2.setAttribute('height','6');
      hdr2.setAttribute('fill',bgCol);
      g.appendChild(hdr2);

      /* Type label */
      var typeTxt=document.createElementNS(NS,'text');
      typeTxt.setAttribute('x',boxW/2);typeTxt.setAttribute('y','13');
      typeTxt.setAttribute('font-size','9');typeTxt.setAttribute('fill','#fff');
      typeTxt.setAttribute('text-anchor','middle');typeTxt.setAttribute('font-weight','700');
      typeTxt.style.textTransform='uppercase';typeTxt.style.letterSpacing='0.05em';
      typeTxt.textContent=ent.type;
      g.appendChild(typeTxt);

      /* Entity name */
      var displayName=ent.name.length>22?ent.name.slice(0,20)+'\u2026':ent.name;
      var nameTxt=document.createElementNS(NS,'text');
      nameTxt.setAttribute('x',boxW/2);nameTxt.setAttribute('y','36');
      nameTxt.setAttribute('font-size','12');nameTxt.setAttribute('fill','#0a1e36');
      nameTxt.setAttribute('text-anchor','middle');nameTxt.setAttribute('font-weight','700');
      nameTxt.textContent=displayName;
      g.appendChild(nameTxt);

      /* Tooltip */
      var title=document.createElementNS(NS,'title');
      title.textContent=ent.name+(ent.description?' \u2014 '+ent.description:'');
      g.appendChild(title);

      /* Drag handling — mouse and touch (iPad) */
      var dragging=false;var dragOffX=0;var dragOffY=0;

      function onStart(clientX,clientY){
        dragging=true;
        g.style.cursor='grabbing';
        var ctm=svg.getScreenCTM();
        var svgX=(clientX-ctm.e)/ctm.a;
        var svgY=(clientY-ctm.f)/ctm.d;
        dragOffX=svgX-pos.x;
        dragOffY=svgY-pos.y;
      }
      function onMove(clientX,clientY){
        if(!dragging)return;
        var ctm=svg.getScreenCTM();
        var svgX=(clientX-ctm.e)/ctm.a;
        var svgY=(clientY-ctm.f)/ctm.d;
        pos.x=svgX-dragOffX;
        pos.y=svgY-dragOffY;
        diagramPositions[ent.id]={x:pos.x,y:pos.y};
        g.setAttribute('transform','translate('+pos.x+','+pos.y+')');
        drawLines();
      }
      function onEnd(){
        if(!dragging)return;
        dragging=false;
        g.style.cursor='grab';
      }

      /* Mouse events */
      g.addEventListener('mousedown',function(e){e.preventDefault();onStart(e.clientX,e.clientY);});
      /* Touch events (iPad) */
      g.addEventListener('touchstart',function(e){
        if(e.touches.length===1){e.preventDefault();onStart(e.touches[0].clientX,e.touches[0].clientY);}
      },{passive:false});

      svg.addEventListener('mousemove',function(e){if(dragging){e.preventDefault();onMove(e.clientX,e.clientY);}});
      svg.addEventListener('touchmove',function(e){
        if(dragging&&e.touches.length===1){e.preventDefault();onMove(e.touches[0].clientX,e.touches[0].clientY);}
      },{passive:false});
      svg.addEventListener('mouseup',onEnd);
      svg.addEventListener('mouseleave',onEnd);
      svg.addEventListener('touchend',onEnd);
      svg.addEventListener('touchcancel',onEnd);

      svg.appendChild(g);
    })(entities[ei],ei);
  }

  /* Insert into container */
  var container=document.getElementById('diagramContainer');
  container.innerHTML='<div class="diagram-zoom-controls"><button class="diagram-zoom-btn" onclick="zoomDiagram(1.2)">+</button><button class="diagram-zoom-btn" onclick="zoomDiagram(0.8)">\u2212</button><button class="diagram-zoom-btn" onclick="zoomDiagram(0)">Fit</button></div>';
  container.appendChild(svg);

  /* Build legend */
  var legend=document.getElementById('diagramLegend');
  var legendHtml='<span class="diagram-legend-title">Relationships:</span>';
  for(var lt=0;lt<typeKeys.length;lt++){
    var lCol=relColours[typeKeys[lt]]||relColours.other;
    var lLabel=typeKeys[lt].replace(/_/g,' ');
    lLabel=lLabel.charAt(0).toUpperCase()+lLabel.slice(1);
    legendHtml+='<span class="diagram-legend-item"><span class="diagram-legend-line" style="background:'+lCol+'"></span>'+lLabel+'</span>';
  }
  legendHtml+='<span class="diagram-legend-title" style="margin-left:1rem">Entities:</span>';
  var entityTypesUsed={};
  for(var eu=0;eu<entities.length;eu++){entityTypesUsed[entities[eu].type]=true;}
  var etKeys=Object.keys(entityTypesUsed);
  for(var et=0;et<etKeys.length;et++){
    var eCol=entityColours[etKeys[et]]||entityColours.other;
    var eLabel=etKeys[et].charAt(0).toUpperCase()+etKeys[et].slice(1);
    legendHtml+='<span class="diagram-legend-item"><span style="width:12px;height:12px;border-radius:3px;background:'+eCol+';display:inline-block"></span>'+eLabel+'</span>';
  }
  legend.innerHTML=legendHtml;
  legend.style.display='flex';
}

function hexToLight(hex){
  var r=parseInt(hex.slice(1,3),16);var g=parseInt(hex.slice(3,5),16);var b=parseInt(hex.slice(5,7),16);
  return 'rgb('+ Math.round(r+(255-r)*0.85)+','+Math.round(g+(255-g)*0.85)+','+Math.round(b+(255-b)*0.85)+')';
}

function escXml(t){return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');}

function zoomDiagram(factor){
  var container=document.getElementById('diagramContainer');
  var svg=container.querySelector('svg');
  if(!svg)return;
  if(factor===0){diagramZoom=1;}
  else{diagramZoom*=factor;}
  diagramZoom=Math.max(0.3,Math.min(3,diagramZoom));
  svg.style.transform='scale('+diagramZoom+')';
  svg.style.transformOrigin='top left';
}

/* Legacy generateDiagram — called from persons button, now opens focus panel */
function generateDiagram(personsText){
  showDiagramFocusPanel(personsText);
}

/* ── Stage 4: Follow-up chat area ──────────────────────────────────────── */
function buildDiagramChatArea(){
  var area=document.getElementById('diagramChatArea');
  area.style.display='block';
  area.innerHTML='<div class="diagram-chat-history" id="diagramChatHistory"></div>'
    +'<div class="diagram-chat-input-row">'
    +'<input type="text" id="diagramChatInput" class="f-input" placeholder="Ask about the diagram or give instructions (e.g. Show only entities connected to Company X)" style="flex:1;padding:.55rem .7rem;font-size:.88rem" onkeydown="if(event.key===\'Enter\')sendDiagramChat()">'
    +'<button class="btn-run-tool" style="padding:.55rem 1rem;white-space:nowrap" onclick="sendDiagramChat()">Send</button>'
    +'</div>';
}

async function sendDiagramChat(){
  var input=document.getElementById('diagramChatInput');
  if(!input)return;
  var question=input.value.trim();
  if(!question)return;
  if(!diagramData){showToast('Generate a diagram first');return;}
  input.value='';

  var historyEl=document.getElementById('diagramChatHistory');
  /* Show user message */
  var userMsg=document.createElement('div');
  userMsg.className='diagram-chat-msg diagram-chat-user';
  userMsg.textContent=question;
  historyEl.appendChild(userMsg);

  /* Show typing indicator */
  var typing=document.createElement('div');
  typing.className='diagram-chat-msg diagram-chat-assistant';
  typing.innerHTML='<div class="typing-bubble"><span></span><span></span><span></span></div>';
  historyEl.appendChild(typing);
  historyEl.scrollTop=historyEl.scrollHeight;

  try{
    var body={
      question:question,
      currentEntities:diagramData.entities,
      currentRelationships:diagramData.relationships,
      matterName:currentMatter?currentMatter.name:'',
      jurisdiction:jurisdiction,
      personsText:diagramPersonsText.slice(0,30000)
    };
    var d=await api('/api/diagram-chat','POST',body);
    typing.remove();

    if(!d||!d.entities){
      var errMsg=document.createElement('div');
      errMsg.className='diagram-chat-msg diagram-chat-assistant';
      errMsg.textContent=d&&d.explanation?d.explanation:'No response received.';
      historyEl.appendChild(errMsg);
      historyEl.scrollTop=historyEl.scrollHeight;
      return;
    }

    /* Show explanation */
    var assistantMsg=document.createElement('div');
    assistantMsg.className='diagram-chat-msg diagram-chat-assistant';
    assistantMsg.innerHTML=renderMd(d.explanation||'Diagram updated.');
    historyEl.appendChild(assistantMsg);
    historyEl.scrollTop=historyEl.scrollHeight;

    /* Stage 4: Update diagram — preserve positions for existing entities */
    diagramData={entities:d.entities,relationships:d.relationships};
    diagramActiveFilters=[];
    renderDiagramSVG(diagramData);
    buildDiagramToolbar();

    /* Track follow-up for history */
    diagramFollowUpHistory.push({question:question,explanation:d.explanation||''});

    /* Stage 5: Update history with new state */
    saveDiagramToHistory();

    if(d.usage&&d.usage.costUsd){showToast('Diagram updated \u2014 $'+d.usage.costUsd.toFixed(4));}
  }catch(e){
    typing.remove();
    var errMsg2=document.createElement('div');
    errMsg2.className='diagram-chat-msg diagram-chat-assistant';
    errMsg2.style.color='var(--error)';
    errMsg2.textContent='\u26A0\uFE0F Error: '+e.message;
    historyEl.appendChild(errMsg2);
    historyEl.scrollTop=historyEl.scrollHeight;
  }
}

/* ── Stage 5: History integration ──────────────────────────────────────── */
async function saveDiagramToHistory(){
  if(!currentMatter||!diagramData)return;
  try{
    var histData=JSON.stringify({
      entities:diagramData.entities,
      relationships:diagramData.relationships,
      focusEntities:diagramFocusEntities,
      preGenFilters:diagramPreGenFilters,
      followUpHistory:diagramFollowUpHistory
    });
    var questionLabel='Entity Relationship Diagram'+(diagramFocusEntities.length?' (focus: '+diagramFocusEntities.join(', ')+')':'');
    await saveHistory(questionLabel,histData,'diagram');
  }catch(e){console.log('Diagram history save error:',e.message);}
}

/* Stage 5: Load diagram from history item */
function loadDiagramFromHistory(histItem){
  try{
    var saved=JSON.parse(histItem.answer);
    if(!saved||!saved.entities)return;
    getOrCreateDiagramTab();
    diagramData={entities:saved.entities,relationships:saved.relationships};
    diagramFocusEntities=saved.focusEntities||[];
    diagramPreGenFilters=saved.preGenFilters||[];
    diagramFollowUpHistory=saved.followUpHistory||[];
    diagramPositions={};
    diagramActiveFilters=[];
    diagramZoom=1;
    renderDiagramSVG(diagramData);
    buildDiagramToolbar();
    buildDiagramChatArea();
    /* Restore follow-up history display */
    if(diagramFollowUpHistory.length>0){
      var historyEl=document.getElementById('diagramChatHistory');
      for(var i=0;i<diagramFollowUpHistory.length;i++){
        var item=diagramFollowUpHistory[i];
        var uMsg=document.createElement('div');
        uMsg.className='diagram-chat-msg diagram-chat-user';
        uMsg.textContent=item.question;
        historyEl.appendChild(uMsg);
        var aMsg=document.createElement('div');
        aMsg.className='diagram-chat-msg diagram-chat-assistant';
        aMsg.innerHTML=renderMd(item.explanation);
        historyEl.appendChild(aMsg);
      }
    }
  }catch(e){console.log('Diagram history load error:',e.message);}
}

/* PPTX download — reads from diagramPositions (respects drag edits) */
function downloadDiagramPptx(){
  if(!diagramData)return;
  try{
    var pptx=new PptxGenJS();
    pptx.layout='LAYOUT_WIDE';
    pptx.author='Ex Libris Juris';
    pptx.title='Entity Relationship Diagram'+(currentMatter?' \u2014 '+currentMatter.name:'');

    var entities=diagramData.entities;
    var rels=diagramData.relationships;
    /* Apply active filters to exported relationships */
    var hasFilters=diagramActiveFilters.length>0;
    if(hasFilters){rels=rels.filter(function(r){return diagramActiveFilters.indexOf(r.type)!==-1;});}
    var n=entities.length;
    var boxW=diagramBoxW;var boxH=diagramBoxH;

    /* Slide dimensions: 13.33 x 7.5 inches */
    var slideW=13.33;var slideH=7.5;
    var bW=1.8;var bH=0.65;

    /* Scale SVG positions to PPTX slide coordinates */
    var minX=Infinity;var minY=Infinity;var maxX=-Infinity;var maxY=-Infinity;
    for(var si0=0;si0<n;si0++){
      var p0=diagramPositions[entities[si0].id];
      if(!p0)continue;
      if(p0.x<minX)minX=p0.x;
      if(p0.y<minY)minY=p0.y;
      if(p0.x+boxW>maxX)maxX=p0.x+boxW;
      if(p0.y+boxH>maxY)maxY=p0.y+boxH;
    }
    var svgW2=maxX-minX||1;var svgH2=maxY-minY||1;
    /* Usable area on slide (leave margins for title and legend) */
    var usableX=0.4;var usableY=0.85;var usableW=slideW-0.8;var usableH=slideH-1.6;
    var scaleX=usableW/svgW2;var scaleY=usableH/svgH2;
    var scale=Math.min(scaleX,scaleY,1);/* don't scale up beyond 1 */

    /* Centre the diagram on the slide */
    var scaledW=svgW2*scale;var scaledH=svgH2*scale;
    var offsetX=usableX+(usableW-scaledW)/2;
    var offsetY=usableY+(usableH-scaledH)/2;

    function toPptX(svgX){return offsetX+(svgX-minX)*scale;}
    function toPptY(svgY){return offsetY+(svgY-minY)*scale;}
    var pptBW=boxW*scale;if(pptBW<0.8)pptBW=0.8;
    var pptBH=boxH*scale;if(pptBH<0.4)pptBH=0.4;

    /* Multiple slides if many entities */
    var entitiesPerSlide=30;
    var slideCount=Math.ceil(n/entitiesPerSlide);

    for(var si=0;si<slideCount;si++){
      var slide=pptx.addSlide();
      slide.background={color:'FFFFFF'};

      var titleText=slideCount>1?'Entity Relationships ('+(si+1)+'/'+slideCount+')':'Entity Relationship Diagram';
      slide.addText(titleText,{x:0.3,y:0.15,w:slideW-0.6,h:0.4,fontSize:16,fontFace:'Calibri',bold:true,color:'0f2744'});
      slide.addText(currentMatter?currentMatter.name:'',{x:0.3,y:0.5,w:slideW-0.6,h:0.25,fontSize:10,fontFace:'Calibri',color:'7a9ab4',italic:true});

      var startIdx2=si*entitiesPerSlide;
      var endIdx2=Math.min(startIdx2+entitiesPerSlide,n);
      var sliceEnts=entities.slice(startIdx2,endIdx2);

      /* Build positions for this slice */
      var pptPos={};
      var sliceIds={};
      for(var pi=0;pi<sliceEnts.length;pi++){
        var sp=diagramPositions[sliceEnts[pi].id];
        if(!sp)continue;
        var px=toPptX(sp.x);var py=toPptY(sp.y);
        pptPos[sliceEnts[pi].id]={x:px,y:py,cx:px+pptBW/2,cy:py+pptBH/2};
        sliceIds[sliceEnts[pi].id]=true;
      }

      /* Relationship lines */
      for(var ri3=0;ri3<rels.length;ri3++){
        var rel2=rels[ri3];
        if(!sliceIds[rel2.source]||!sliceIds[rel2.target])continue;
        var s2=pptPos[rel2.source];var t2=pptPos[rel2.target];
        if(!s2||!t2)continue;
        var col3=(relColours[rel2.type]||relColours.other).replace('#','');
        slide.addShape(pptx.ShapeType.line,{
          x:s2.cx,y:s2.cy,
          w:t2.cx-s2.cx,h:t2.cy-s2.cy,
          line:{color:col3,width:1.5,dashType:'solid'},
        });
        var lx=(s2.cx+t2.cx)/2-0.5;var ly=(s2.cy+t2.cy)/2-0.12;
        slide.addText(rel2.label||rel2.type,{x:lx,y:ly,w:1,h:0.2,fontSize:7,fontFace:'Calibri',color:col3,align:'center',bold:true});
      }

      /* Entity boxes */
      for(var ei2=0;ei2<sliceEnts.length;ei2++){
        var ent2=sliceEnts[ei2];
        var p2=pptPos[ent2.id];
        if(!p2)continue;
        var bgCol2=(entityColours[ent2.type]||entityColours.other).replace('#','');
        slide.addShape(pptx.ShapeType.roundRect,{x:p2.x,y:p2.y,w:pptBW,h:pptBH,fill:{color:'F4F9FD'},line:{color:bgCol2,width:1.5},rectRadius:0.08});
        slide.addShape(pptx.ShapeType.rect,{x:p2.x,y:p2.y,w:pptBW,h:0.22,fill:{color:bgCol2},line:{color:bgCol2,width:0},rectRadius:0});
        slide.addText(ent2.type.toUpperCase(),{x:p2.x,y:p2.y,w:pptBW,h:0.22,fontSize:7,fontFace:'Calibri',color:'FFFFFF',align:'center',bold:true,valign:'middle'});
        var dName=ent2.name.length>26?ent2.name.slice(0,24)+'\u2026':ent2.name;
        slide.addText(dName,{x:p2.x+0.05,y:p2.y+0.24,w:pptBW-0.1,h:pptBH-0.26,fontSize:9,fontFace:'Calibri',color:'0a1e36',align:'center',bold:true,valign:'middle',shrinkText:true});
      }

      /* Legend on last slide */
      if(si===slideCount-1){
        var legendY=slideH-0.5;
        var usedTypes2={};
        for(var ut=0;ut<rels.length;ut++){usedTypes2[rels[ut].type]=true;}
        var utKeys=Object.keys(usedTypes2);
        var lxPos=0.3;
        slide.addText('Legend:',{x:lxPos,y:legendY,w:0.5,h:0.25,fontSize:8,fontFace:'Calibri',color:'4a6a84',bold:true});
        lxPos+=0.55;
        for(var li=0;li<utKeys.length;li++){
          var lCol2=(relColours[utKeys[li]]||relColours.other).replace('#','');
          var lLbl=utKeys[li].replace(/_/g,' ');
          lLbl=lLbl.charAt(0).toUpperCase()+lLbl.slice(1);
          slide.addShape(pptx.ShapeType.line,{x:lxPos,y:legendY+0.12,w:0.25,h:0,line:{color:lCol2,width:2}});
          slide.addText(lLbl,{x:lxPos+0.28,y:legendY,w:0.8,h:0.25,fontSize:7,fontFace:'Calibri',color:lCol2,bold:true});
          lxPos+=1.1;
          if(lxPos>slideW-1){lxPos=0.3;legendY+=0.2;}
        }
      }
    }

    var fileName='diagram-'+(currentMatter?currentMatter.name.replace(/[^a-z0-9]/gi,'-').toLowerCase():'matter')+'.pptx';
    pptx.writeFile({fileName:fileName}).then(function(){showToast('Downloaded as PowerPoint');}).catch(function(e){showToast('PPTX error: '+e.message);});
  }catch(e2){showToast('PPTX generation error: '+e2.message);}
}

/* SVG download — generates clean SVG from current positions */
function downloadDiagramSvg(){
  var container=document.getElementById('diagramContainer');
  var svg=container.querySelector('svg');
  if(!svg)return;
  /* Clone and reset transform so export is at 1:1 scale */
  var clone=svg.cloneNode(true);
  clone.style.transform='';
  var svgData=new XMLSerializer().serializeToString(clone);
  var blob=new Blob([svgData],{type:'image/svg+xml'});
  var url=URL.createObjectURL(blob);
  var a=document.createElement('a');a.href=url;
  a.download='diagram-'+(currentMatter?currentMatter.name.replace(/[^a-z0-9]/gi,'-').toLowerCase():'matter')+'.svg';
  a.click();URL.revokeObjectURL(url);
  showToast('Downloaded as SVG');
}

/* ── Stage 5: Override loadHistItem to handle diagram history ─────────── */
var _originalLoadHistItem=typeof loadHistItem==='function'?loadHistItem:null;
function loadHistItem(i){
  var h=matterHistory[i];if(!h)return;
  /* Intercept diagram tool_name — use custom loader */
  if(h.tool_name==='diagram'){
    loadDiagramFromHistory(h);
    if(typeof histOpen!=='undefined'&&histOpen)toggleHistory();
    return;
  }
  /* Fall through to original for all other tools */
  if(_originalLoadHistItem)_originalLoadHistItem(i);
}

/* ── INIT (called here because this is the last script file to load) ─── */
init();
