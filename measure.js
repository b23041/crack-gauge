/* 균열폭 수동 측정 — OpenCV 불필요, 순수 캔버스
   흐름:
   1) 사진 로드
   2) 동전 지름 두 점 탭 → mm/px 스케일 계산
   3) 균열 가장자리 두 점씩 탭 → 각 지점 폭 측정, 최대폭 기록
   확대(핀치/휠)·이동(드래그)으로 정밀 지정 가능
*/

const COIN_MM = 24.0;

const state = {
  img: null,            // 원본 이미지
  phase: 'load',        // load | coin | crack
  view: { scale: 1, ox: 0, oy: 0 },   // 화면 변환(확대/이동)
  coin: [],             // 동전 두 점 [{x,y}] (이미지 좌표)
  mmPerPx: null,
  pending: [],          // 현재 찍는 중인 균열 두 점
  measures: [],         // 완료된 측정 [{a,b,widthMm}]
};

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

// ---------- 이미지 로드 ----------
const drop = document.getElementById('drop');
const fileinput = document.getElementById('fileinput');
['dragenter','dragover'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.add('over');}));
['dragleave','drop'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.remove('over');}));
drop.addEventListener('drop',e=>{if(e.dataTransfer.files[0])loadFile(e.dataTransfer.files[0]);});
fileinput.addEventListener('change',e=>{if(e.target.files[0])loadFile(e.target.files[0]);});

async function loadFile(file){
  if(!file.type.startsWith('image/')){alert('이미지 파일을 넣어주세요.');return;}
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = ()=>{
    state.img = img;
    URL.revokeObjectURL(url);
    startCoinPhase();
  };
  img.onerror = ()=>alert('이미지를 불러오지 못했습니다.');
  img.src = url;
}

// ---------- 화면 배치 ----------
function fitView(){
  const stage = document.getElementById('stage');
  const availW = stage.clientWidth || document.querySelector('main').clientWidth-28;
  // 캔버스 픽셀 크기 = 이미지 비율 유지, 폭에 맞춤
  const ratio = state.img.height/state.img.width;
  const cw = availW;
  const ch = Math.round(availW*ratio);
  const dpr = window.devicePixelRatio||1;
  canvas.width = cw*dpr; canvas.height = ch*dpr;
  canvas.style.width = cw+'px'; canvas.style.height = ch+'px';
  ctx.setTransform(dpr,0,0,dpr,0,0);
  // 기본 뷰: 이미지가 캔버스 폭에 딱 맞도록
  state.baseScale = cw/state.img.width;
  state.view = { scale:1, ox:0, oy:0 };
  state.cssW = cw; state.cssH = ch;
}

// 이미지 좌표 -> 캔버스(css) 좌표
function toScreen(px,py){
  const s = state.baseScale*state.view.scale;
  return { x: px*s + state.view.ox, y: py*s + state.view.oy };
}
// 캔버스(css) 좌표 -> 이미지 좌표
function toImage(sx,sy){
  const s = state.baseScale*state.view.scale;
  return { x: (sx-state.view.ox)/s, y: (sy-state.view.oy)/s };
}

// ---------- 그리기 ----------
function draw(){
  if(!state.img) return;
  const dpr = window.devicePixelRatio||1;
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,state.cssW,state.cssH);
  const s = state.baseScale*state.view.scale;
  ctx.drawImage(state.img, state.view.ox, state.view.oy,
                state.img.width*s, state.img.height*s);

  // 동전 두 점 + 원
  if(state.coin.length>0){
    ctx.strokeStyle='#2f9bff'; ctx.fillStyle='#2f9bff'; ctx.lineWidth=2;
    for(const p of state.coin){ const q=toScreen(p.x,p.y); dot(q,'#2f9bff'); }
    if(state.coin.length===2){
      const a=toScreen(state.coin[0].x,state.coin[0].y);
      const b=toScreen(state.coin[1].x,state.coin[1].y);
      // 지름선
      ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();
      // 원(지름 기준)
      const cx=(a.x+b.x)/2, cy=(a.y+b.y)/2, r=Math.hypot(a.x-b.x,a.y-b.y)/2;
      ctx.setLineDash([5,4]);ctx.beginPath();ctx.arc(cx,cy,r,0,2*Math.PI);ctx.stroke();ctx.setLineDash([]);
    }
  }
  // 완료된 균열 측정들
  state.measures.forEach((m,i)=>{
    const a=toScreen(m.a.x,m.a.y), b=toScreen(m.b.x,m.b.y);
    const t=Math.min(m.widthMm/(maxWidth()||1),1);
    const col=`rgb(${Math.round(255*t)+80>255?255:Math.round(255*t)+80},${Math.round(120*(1-t))},60)`;
    ctx.strokeStyle='#ff6b3d';ctx.lineWidth=3;
    ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();
    dot(a,'#ff6b3d');dot(b,'#ff6b3d');
    // 번호 라벨
    const mx=(a.x+b.x)/2, my=(a.y+b.y)/2;
    ctx.fillStyle='#ff6b3d';ctx.beginPath();ctx.arc(mx,my-14,9,0,2*Math.PI);ctx.fill();
    ctx.fillStyle='#fff';ctx.font='bold 11px sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';
    ctx.fillText(String(i+1),mx,my-14);ctx.textAlign='left';ctx.textBaseline='alphabetic';
  });
  // 현재 찍는 중인 균열 점
  if(state.pending.length>0){
    const a=toScreen(state.pending[0].x,state.pending[0].y);
    dot(a,'#ffb03d');
  }
}
function dot(q,color){
  ctx.fillStyle=color;ctx.beginPath();ctx.arc(q.x,q.y,5,0,2*Math.PI);ctx.fill();
  ctx.strokeStyle='#fff';ctx.lineWidth=1.5;ctx.stroke();
}
function maxWidth(){ return state.measures.reduce((m,x)=>Math.max(m,x.widthMm),0); }

// ---------- 단계 전환 ----------
function setStep(active){
  for(const [id,ph] of [['step1','load'],['step2','coin'],['step3','crack']]){
    const el=document.getElementById(id);
    el.classList.remove('active','done');
  }
  document.getElementById('step1').classList.add(state.img?'done':'active');
  if(state.img){
    document.getElementById('step2').classList.add(active==='coin'?'active':(state.mmPerPx?'done':''));
  }
  if(state.mmPerPx){
    document.getElementById('step3').classList.add(active==='crack'?'active':'');
  }
}
function setHint(html){
  const h=document.getElementById('hint');
  h.style.display='flex';
  document.getElementById('hinttext').innerHTML=html;
}
function startCoinPhase(){
  state.phase='coin'; state.coin=[]; state.mmPerPx=null; state.measures=[]; state.pending=[];
  document.getElementById('drop').style.display='none';
  document.getElementById('stage').classList.add('on');
  document.getElementById('toolbar').style.display='flex';
  document.getElementById('note').style.display='block';
  fitView(); draw(); setStep('coin');
  setHint('<b>동전 지름</b>을 지정하세요 — 100원 동전의 <b>양 끝 두 점</b>을 탭하세요. (확대하면 더 정확합니다)');
  updateButtons();
}
function startCrackPhase(){
  state.phase='crack';
  setStep('crack');
  setHint('<b>균열폭 측정</b> — 균열의 <b>양쪽 가장자리 두 점</b>을 탭하세요. 여러 지점을 반복 측정할 수 있습니다.');
  document.getElementById('measurements').classList.add('on');
  updateButtons();
}

// ---------- 포인터 입력 (탭 vs 드래그/핀치 구분) ----------
let pointers = new Map();
let pinchStart = null;
let dragStart = null;
let moved = false;

canvas.addEventListener('pointerdown', e=>{
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, {x:e.clientX,y:e.clientY});
  moved=false;
  if(pointers.size===1){
    const r=canvas.getBoundingClientRect();
    dragStart={sx:e.clientX-r.left, sy:e.clientY-r.top, ox:state.view.ox, oy:state.view.oy};
  } else if(pointers.size===2){
    const pts=[...pointers.values()];
    pinchStart={
      dist:Math.hypot(pts[0].x-pts[1].x,pts[0].y-pts[1].y),
      scale:state.view.scale,
      cx:(pts[0].x+pts[1].x)/2, cy:(pts[0].y+pts[1].y)/2,
      ox:state.view.ox, oy:state.view.oy
    };
  }
});

canvas.addEventListener('pointermove', e=>{
  if(!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
  const r=canvas.getBoundingClientRect();
  if(pointers.size===2 && pinchStart){
    const pts=[...pointers.values()];
    const d=Math.hypot(pts[0].x-pts[1].x,pts[0].y-pts[1].y);
    const ns=Math.max(1,Math.min(8, pinchStart.scale*(d/pinchStart.dist)));
    // 핀치 중심 고정 확대
    const cxCanvas=pinchStart.cx-r.left, cyCanvas=pinchStart.cy-r.top;
    const k=ns/pinchStart.scale;
    state.view.scale=ns;
    state.view.ox = cxCanvas - (cxCanvas-pinchStart.ox)*k;
    state.view.oy = cyCanvas - (cyCanvas-pinchStart.oy)*k;
    moved=true; draw();
  } else if(pointers.size===1 && dragStart){
    const sx=e.clientX-r.left, sy=e.clientY-r.top;
    const dx=sx-dragStart.sx, dy=sy-dragStart.sy;
    if(Math.abs(dx)>4||Math.abs(dy)>4) moved=true;
    state.view.ox=dragStart.ox+dx; state.view.oy=dragStart.oy+dy;
    draw();
  }
});

canvas.addEventListener('pointerup', e=>{
  const r=canvas.getBoundingClientRect();
  const sx=e.clientX-r.left, sy=e.clientY-r.top;
  const wasSingle = pointers.size===1;
  pointers.delete(e.pointerId);
  if(pointers.size===0){
    pinchStart=null;
    if(wasSingle && !moved){ handleTap(sx,sy); }
    dragStart=null;
  } else if(pointers.size===1){
    // 핀치 해제 후 남은 손가락으로 드래그 시작점 갱신
    const p=[...pointers.values()][0];
    dragStart={sx:p.x-r.left, sy:p.y-r.top, ox:state.view.ox, oy:state.view.oy};
    pinchStart=null;
  }
});

// 마우스 휠 확대(PC)
canvas.addEventListener('wheel', e=>{
  e.preventDefault();
  const r=canvas.getBoundingClientRect();
  const cx=e.clientX-r.left, cy=e.clientY-r.top;
  const factor=e.deltaY<0?1.15:1/1.15;
  const ns=Math.max(1,Math.min(8,state.view.scale*factor));
  const k=ns/state.view.scale;
  state.view.ox = cx-(cx-state.view.ox)*k;
  state.view.oy = cy-(cy-state.view.oy)*k;
  state.view.scale=ns; draw();
},{passive:false});

// ---------- 탭 처리 ----------
function handleTap(sx,sy){
  const p=toImage(sx,sy);
  // 이미지 밖이면 무시
  if(p.x<0||p.y<0||p.x>state.img.width||p.y>state.img.height) return;
  if(state.phase==='coin'){
    if(state.coin.length<2){
      state.coin.push(p);
      if(state.coin.length===2) computeScale();
    }
  } else if(state.phase==='crack'){
    state.pending.push(p);
    if(state.pending.length===2){
      const a=state.pending[0], b=state.pending[1];
      const px=Math.hypot(a.x-b.x,a.y-b.y);
      const widthMm=px*state.mmPerPx;
      state.measures.push({a,b,widthMm});
      state.pending=[];
      renderMeasures();
    }
  }
  draw(); updateButtons();
}

function computeScale(){
  const a=state.coin[0], b=state.coin[1];
  const px=Math.hypot(a.x-b.x,a.y-b.y);
  if(px<5){ alert('두 점이 너무 가깝습니다. 동전 지름을 다시 지정하세요.'); state.coin=[]; draw(); return; }
  state.mmPerPx = COIN_MM/px;
  const sb=document.getElementById('scalebar');
  sb.classList.add('on');
  sb.innerHTML=`동전 지름 <b class="num">${px.toFixed(1)}px</b> = 24mm &nbsp;→&nbsp; 스케일 <b class="num">${state.mmPerPx.toFixed(4)} mm/px</b>`;
  startCrackPhase();
}

// ---------- 측정 결과 렌더 ----------
function renderMeasures(){
  const list=document.getElementById('mlist');
  const mw=maxWidth();
  list.innerHTML = state.measures.map((m,i)=>{
    const big = m.widthMm===mw && state.measures.length>1;
    return `<div class="mrow">
      <span class="idx">${i+1}</span>
      <span class="w ${big?'big':''} num">${m.widthMm.toFixed(2)} mm${big?' · 최대':''}</span>
      <button class="del" onclick="delMeasure(${i})">×</button>
    </div>`;
  }).join('') || '<div class="mrow" style="color:#8b96a1">아직 측정 없음 — 균열 양쪽을 탭하세요</div>';

  const sum=document.getElementById('summary');
  if(state.measures.length){
    const avg=state.measures.reduce((s,m)=>s+m.widthMm,0)/state.measures.length;
    sum.innerHTML=`
      <div class="card"><div class="lbl">최대 균열폭</div>
        <div class="val num">${mw.toFixed(2)}<small> mm</small></div></div>
      <div class="card light"><div class="lbl">측정 지점</div>
        <div class="val num">${state.measures.length}<small> 곳</small></div></div>`;
  } else sum.innerHTML='';
}
window.delMeasure=function(i){ state.measures.splice(i,1); renderMeasures(); draw(); };

// ---------- 버튼 ----------
function updateButtons(){
  document.getElementById('undoBtn').disabled =
    !(state.pending.length>0 || state.measures.length>0 || (state.phase==='coin'&&state.coin.length>0));
}
document.getElementById('undoBtn').onclick=()=>{
  if(state.phase==='coin'){ state.coin.pop(); }
  else if(state.pending.length>0){ state.pending.pop(); }
  else if(state.measures.length>0){ state.measures.pop(); renderMeasures(); }
  draw(); updateButtons();
};
document.getElementById('redoCoinBtn').onclick=()=>{
  document.getElementById('scalebar').classList.remove('on');
  document.getElementById('measurements').classList.remove('on');
  startCoinPhase();
};
document.getElementById('resetBtn').onclick=()=>{
  state.img=null; state.coin=[]; state.mmPerPx=null; state.measures=[]; state.pending=[];
  document.getElementById('stage').classList.remove('on');
  document.getElementById('toolbar').style.display='none';
  document.getElementById('scalebar').classList.remove('on');
  document.getElementById('measurements').classList.remove('on');
  document.getElementById('hint').style.display='none';
  document.getElementById('note').style.display='none';
  document.getElementById('drop').style.display='block';
  fileinput.value='';
  setStep('load');
};

window.addEventListener('resize', ()=>{ if(state.img){ fitView(); draw(); } });
