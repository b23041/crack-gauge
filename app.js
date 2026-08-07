/* 균열폭 측정기 — 브라우저 내 처리 로직
   Python(batch_crack.py)의 알고리즘을 JS로 이식:
   1) 동전 검출(HoughCircles + 경계완결성 필터) → mm/px
   2) black-hat + 적응형 이진화 → 균열 마스크
   3) 거리변환(순수 JS) + 세선화 → 중심선 폭 측정
*/

let cvReady = false;
const results = [];   // {file, status, mmpp, coinR, max, mean, p95, median, n, overlay}

// ---- OpenCV 로드 대기 ----
function onCvReady() {
  cvReady = true;
  const s = document.getElementById('status');
  s.classList.add('ready');
  document.getElementById('statustext').textContent = '준비 완료 — 사진을 올려주세요';
}
if (window.cv && cv.Mat) onCvReady();
else if (window.cv) cv.onRuntimeInitialized = onCvReady;
else window.addEventListener('load', () => {
  const t = setInterval(() => {
    if (window.cv && cv.Mat) { clearInterval(t); onCvReady(); }
  }, 200);
});

// ---- 순수 JS 거리변환 (chamfer 2-pass) ----
function distanceTransform(bin, w, h) {
  const INF = 1e9, d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = bin[i] ? INF : 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (!bin[i]) continue;
    if (x > 0) d[i] = Math.min(d[i], d[i - 1] + 1);
    if (y > 0) d[i] = Math.min(d[i], d[i - w] + 1);
    if (x > 0 && y > 0) d[i] = Math.min(d[i], d[i - w - 1] + 1.414);
    if (x < w - 1 && y > 0) d[i] = Math.min(d[i], d[i - w + 1] + 1.414);
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x; if (!bin[i]) continue;
    if (x < w - 1) d[i] = Math.min(d[i], d[i + 1] + 1);
    if (y < h - 1) d[i] = Math.min(d[i], d[i + w] + 1);
    if (x < w - 1 && y < h - 1) d[i] = Math.min(d[i], d[i + w + 1] + 1.414);
    if (x > 0 && y < h - 1) d[i] = Math.min(d[i], d[i + w - 1] + 1.414);
  }
  return d;
}

// ---- 세선화 (Zhang-Suen) ----
function skeletonize(bin, w, h) {
  const img = Uint8Array.from(bin);
  const P = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? 0 : img[y * w + x];
  let changed = true;
  while (changed) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      const del = [];
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        if (!img[y * w + x]) continue;
        const p2=P(x,y-1),p3=P(x+1,y-1),p4=P(x+1,y),p5=P(x+1,y+1),
              p6=P(x,y+1),p7=P(x-1,y+1),p8=P(x-1,y),p9=P(x-1,y-1);
        const B = p2+p3+p4+p5+p6+p7+p8+p9;
        if (B < 2 || B > 6) continue;
        const seq=[p2,p3,p4,p5,p6,p7,p8,p9,p2];
        let A=0; for (let k=0;k<8;k++) if(seq[k]===0&&seq[k+1]===1) A++;
        if (A !== 1) continue;
        if (step===0){ if(p2*p4*p6!==0)continue; if(p4*p6*p8!==0)continue; }
        else        { if(p2*p4*p8!==0)continue; if(p2*p6*p8!==0)continue; }
        del.push(y * w + x);
      }
      if (del.length){ changed = true; for (const i of del) img[i]=0; }
    }
  }
  return img;
}

// ---- 원 피팅 (Kasa 최소제곱) ----
function solve3(A, b) {
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < 3; c++) {
    let piv = c;
    for (let r = c+1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    if (Math.abs(M[c][c]) < 1e-9) return null;
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k];
    }
  }
  return [M[0][3]/M[0][0], M[1][3]/M[1][1], M[2][3]/M[2][2]];
}
function fitCircle(pts) {
  let Sxx=0,Sxy=0,Syy=0,Sx=0,Sy=0,Sxz=0,Syz=0,Sz=0;
  const n = pts.length;
  for (const [x, y] of pts) {
    const z = x*x + y*y;
    Sxx+=x*x; Sxy+=x*y; Syy+=y*y; Sx+=x; Sy+=y; Sxz+=x*z; Syz+=y*z; Sz+=z;
  }
  const sol = solve3([[Sxx,Sxy,Sx],[Sxy,Syy,Sy],[Sx,Sy,n]], [Sxz,Syz,Sz]);
  if (!sol) return null;
  const cx = sol[0]/2, cy = sol[1]/2;
  const r2 = sol[2] + cx*cx + cy*cy;
  if (r2 <= 0) return null;
  return { cx, cy, r: Math.sqrt(r2) };
}
// RANSAC으로 이상점(손가락 경계, 배경 엣지 등) 제거 후 피팅
// 반복 후 인라이어 재피팅(refine)을 2회 더 해 난수 의존성을 줄이고 안정적으로 수렴시킨다.
function fitCircleRANSAC(pts, iters = 400, thresh = 2.0) {
  if (pts.length < 10) return null;
  let bestInliers = null, bestCount = 0;
  let seed = 12345;
  const rnd = () => { seed = (seed*1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const n = pts.length;
  for (let it = 0; it < iters; it++) {
    const i1 = (rnd()*n)|0, i2 = (rnd()*n)|0, i3 = (rnd()*n)|0;
    if (i1===i2 || i2===i3 || i1===i3) continue;
    const m = fitCircle([pts[i1], pts[i2], pts[i3]]);
    if (!m || !isFinite(m.r) || m.r <= 0) continue;
    let inl = [];
    for (const p of pts) {
      const d = Math.abs(Math.hypot(p[0]-m.cx, p[1]-m.cy) - m.r);
      if (d < thresh) inl.push(p);
    }
    if (inl.length > bestCount) { bestCount = inl.length; bestInliers = inl; }
  }
  if (!bestInliers || bestInliers.length < 10) return null;
  // refine: 인라이어로 재피팅 후 인라이어를 다시 모아 재피팅 (2회)
  let model = fitCircle(bestInliers);
  for (let iter = 0; iter < 2 && model; iter++) {
    const inl = [];
    for (const p of pts) {
      const d = Math.abs(Math.hypot(p[0]-model.cx, p[1]-model.cy) - model.r);
      if (d < thresh) inl.push(p);
    }
    if (inl.length < 10) break;
    model = fitCircle(inl);
  }
  return model;
}

// ---- 동전 검출 (Hough 시드 + RANSAC 정밀 피팅) → {cx,cy,r,mmpp} ----
// 실제 사진에서 동전은 조명 탓에 색/밝기가 배경과 비슷할 수 있다.
// 색 분리 대신 '원형 테두리(엣지)'를 직접 찾는다.
//   1) Hough로 원 후보들의 대략적 위치·크기(seed)를 얻고
//   2) 각 seed 주변의 엣지점을 방사형으로 모아 RANSAC 원 피팅으로 정밀화
//   3) 둘레에 실제 엣지가 가장 많은(=진짜 원인) 후보를 채택
// 손가락으로 일부가 가려져도 보이는 테두리 엣지만으로 원이 복원된다.
function detectCoin(src, coinMM) {
  const w = src.cols, h = src.rows;
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  const blurred = new cv.Mat();
  cv.medianBlur(gray, blurred, 5);

  // 1) Hough 원 검출 (여러 후보)
  const circles = new cv.Mat();
  cv.HoughCircles(blurred, circles, cv.HOUGH_GRADIENT, 1,
    Math.round(w * 0.15),          // 최소 원 간격
    100, 40,                        // param1(Canny 상한), param2(누적 임계)
    Math.round(w * 0.03),           // minRadius
    Math.round(w * 0.12));          // maxRadius

  // 엣지 맵 (RANSAC용)
  const edges = new cv.Mat();
  cv.Canny(gray, edges, 50, 150);
  const ed = edges.data;

  let best = null, bestInliers = -1;

  for (let i = 0; i < circles.cols; i++) {
    const sx = circles.data32F[i*3], sy = circles.data32F[i*3+1], sr = circles.data32F[i*3+2];

    // 2) seed 주변 엣지점을 방사형으로 수집
    const pts = [];
    const RAYS = 720;
    for (let k = 0; k < RAYS; k++) {
      const th = 2*Math.PI*k/RAYS, ct = Math.cos(th), st = Math.sin(th);
      for (let rad = sr*0.7; rad < sr*1.3; rad += 0.5) {
        const ex = Math.round(sx + rad*ct), ey = Math.round(sy + rad*st);
        if (ex < 0 || ey < 0 || ex >= w || ey >= h) break;
        if (ed[ey*w+ex] > 0) { pts.push([ex, ey]); break; }
      }
    }
    if (pts.length < 20) continue;

    // 3) RANSAC 정밀 피팅 (refine 포함, 안정적 수렴)
    const fit = fitCircleRANSAC(pts, 400, 2.0);
    if (!fit || !isFinite(fit.r) || fit.r < w*0.02 || fit.r > w*0.2) continue;

    // 피팅된 원 둘레에 실제 엣지가 얼마나 있는지 = 신뢰도
    let hit = 0; const N = 180;
    for (let k = 0; k < N; k++) {
      const th = 2*Math.PI*k/N;
      const ex = Math.round(fit.cx + fit.r*Math.cos(th));
      const ey = Math.round(fit.cy + fit.r*Math.sin(th));
      let found = false;
      for (let dx=-2; dx<=2 && !found; dx++) for (let dy=-2; dy<=2; dy++) {
        const xx = ex+dx, yy = ey+dy;
        if (xx>=0&&yy>=0&&xx<w&&yy<h && ed[yy*w+xx]>0) { found = true; break; }
      }
      if (found) hit++;
    }
    if (hit > bestInliers) { bestInliers = hit; best = fit; }
  }

  gray.delete(); blurred.delete(); circles.delete(); edges.delete();
  if (!best) return null;
  return { cx: best.cx, cy: best.cy, r: best.r, mmpp: coinMM / (2*best.r) };
}

// ---- 균열 마스크 만들기 ----
function crackMask(src, coin, minArea) {
  window.__cmStage = 'gray';
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  // bilateralFilter는 OpenCV.js에서 in-place(입출력 동일 Mat)가 금지됨 → 별도 출력 Mat 사용
  window.__cmStage = 'bilateral';
  const denoised = new cv.Mat();
  cv.bilateralFilter(gray, denoised, 7, 50, 50, cv.BORDER_DEFAULT);
  window.__cmStage = 'blackhat';
  const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(25,25));
  const bh = new cv.Mat();
  cv.morphologyEx(denoised, bh, cv.MORPH_BLACKHAT, kernel);
  window.__cmStage = 'threshold';
  const bin = new cv.Mat();
  cv.adaptiveThreshold(bh, bin, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 25, -8);

  // 동전 영역 제외
  if (coin) cv.circle(bin, new cv.Point(coin.cx, coin.cy), Math.round(coin.r*1.3),
                      new cv.Scalar(0), -1);

  // 면적 필터 — labels(CV_32S)는 연속 메모리이므로 typed array로 안전하게 접근
  window.__cmStage = 'connectedComponents';
  const labels = new cv.Mat(), stats = new cv.Mat(), cents = new cv.Mat();
  const n = cv.connectedComponentsWithStats(bin, labels, stats, cents, 8);
  const statsData = stats.data32S;   // n행 x 5열 (CC_STAT_*)
  const keep = new Uint8Array(n);
  for (let i = 1; i < n; i++)
    keep[i] = statsData[i*5 + cv.CC_STAT_AREA] >= minArea ? 1 : 0;
  window.__cmStage = 'fillClean';
  const clean = cv.Mat.zeros(bin.rows, bin.cols, cv.CV_8U);
  const lblData = labels.data32S;    // rows*cols int32, 연속
  const clData = clean.data;         // rows*cols uint8, 연속
  const total = bin.rows * bin.cols;
  for (let p = 0; p < total; p++) {
    const lab = lblData[p];
    if (lab > 0 && keep[lab]) clData[p] = 255;
  }
  window.__cmStage = 'close';
  const ck = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5,5));
  cv.morphologyEx(clean, clean, cv.MORPH_CLOSE, ck);

  gray.delete(); denoised.delete(); bh.delete(); kernel.delete(); bin.delete();
  labels.delete(); stats.delete(); cents.delete(); ck.delete();
  return clean; // 호출측에서 delete
}

// ---- 한 장 처리 ----
async function processImage(file, coinMM, minArea) {
  const res = { file: file.name, status:'', mmpp:null, coinR:null,
                max:null, mean:null, p95:null, median:null, n:null, overlay:null };
  const bitmap = await createImageBitmap(file);
  // 너무 크면 축소 (성능/메모리) — OpenCV.js 메모리 한계를 고려해 1000px로 제한
  const MAXW = 1000;
  const scale = bitmap.width > MAXW ? MAXW / bitmap.width : 1;
  const cw = Math.round(bitmap.width*scale), ch = Math.round(bitmap.height*scale);
  const cvs = document.getElementById('work');
  cvs.width = cw; cvs.height = ch;
  const ctx = cvs.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, cw, ch);
  bitmap.close && bitmap.close();

  const src = cv.imread(cvs);
  let stage = 'start';
  try {
    stage = 'detectCoin';
    const coin = detectCoin(src, coinMM);
    if (!coin) { res.status = '동전 미검출'; src.delete(); return res; }
    res.mmpp = +coin.mmpp.toFixed(5);
    res.coinR = Math.round(coin.r);

    stage = 'crackMask';
    const clean = crackMask(src, coin, minArea);
    const w = clean.cols, h = clean.rows;
    stage = 'readMask';
    const cleanData = clean.data;
    const bin = new Uint8Array(w*h);
    for (let i=0; i<w*h; i++) bin[i] = cleanData[i] ? 1 : 0;

    let any=false; for(let i=0;i<w*h;i++) if(bin[i]){any=true;break;}
    if (!any){ res.status='균열 미검출'; clean.delete(); src.delete(); return res; }

    stage = 'distanceTransform';
    const dist = distanceTransform(bin, w, h);
    stage = 'skeletonize';
    const skel = skeletonize(bin, w, h);

    const widths = [];
    const pts = [];
    for (let i=0;i<w*h;i++) if (skel[i]) {
      const wpx = dist[i]*2, wmm = wpx*coin.mmpp;
      widths.push(wmm); pts.push(i);
    }
    if (!widths.length){ res.status='중심선 없음'; clean.delete(); src.delete(); return res; }

    stage = 'stats';
    widths.sort((a,b)=>a-b);
    const max = widths[widths.length-1];
    const mean = widths.reduce((s,v)=>s+v,0)/widths.length;
    const median = widths[Math.floor(widths.length/2)];
    const p95 = widths[Math.floor(widths.length*0.95)];
    res.status='정상';
    res.max=+max.toFixed(3); res.mean=+mean.toFixed(3);
    res.p95=+p95.toFixed(3); res.median=+median.toFixed(3); res.n=widths.length;

    stage = 'overlay';
    // (getImageData/putImageData는 일부 이미지 소스에서 보안 예외가 나므로 피한다)
    let maxIdx = pts[0], maxW = 0;
    for (let k = 0; k < pts.length; k++) {
      const i = pts[k], x = i % w, y = (i/w)|0;
      const wmm = dist[i]*2*coin.mmpp, t = Math.min(wmm/max, 1);
      ctx.fillStyle = `rgb(${Math.round(255*t)},${Math.round(255*(1-t))},0)`;
      ctx.fillRect(x, y, 1, 1);
      if (wmm > maxW) { maxW = wmm; maxIdx = i; }
    }

    // 복원된 동전 원(점선) + 중심 십자
    ctx.strokeStyle = '#2f9bff'; ctx.lineWidth = 2; ctx.setLineDash([6,4]);
    ctx.beginPath(); ctx.arc(coin.cx, coin.cy, coin.r, 0, 2*Math.PI); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(coin.cx-6, coin.cy); ctx.lineTo(coin.cx+6, coin.cy);
    ctx.moveTo(coin.cx, coin.cy-6); ctx.lineTo(coin.cx, coin.cy+6); ctx.stroke();

    // 최대폭 지점 표시
    const mx = maxIdx%w, my = (maxIdx/w)|0;
    ctx.strokeStyle = '#ff3b30'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(mx, my, 9, 0, 2*Math.PI); ctx.stroke();
    ctx.fillStyle = '#ff3b30'; ctx.font = 'bold 15px sans-serif';
    ctx.fillText('max '+max.toFixed(2)+'mm', Math.max(mx-40,4), Math.max(my-14,16));

    try {
      res.overlay = cvs.toDataURL('image/jpeg', 0.8);
    } catch (e) {
      res.overlay = null;  // 오버레이 생성 실패해도 측정값은 유지
    }

    clean.delete();
  } catch(e){
    console.error(e);
    const detail = stage === 'crackMask' ? (stage + '/' + (window.__cmStage||'?')) : stage;
    res.status = '오류@' + detail + ': ' + (e && e.message ? e.message : e);
  }
  src.delete();
  return res;
}

// ---- UI 배선 ----
const drop = document.getElementById('drop');
const fileinput = document.getElementById('fileinput');
['dragenter','dragover'].forEach(ev=>drop.addEventListener(ev,e=>{
  e.preventDefault(); drop.classList.add('over');}));
['dragleave','drop'].forEach(ev=>drop.addEventListener(ev,e=>{
  e.preventDefault(); drop.classList.remove('over');}));
drop.addEventListener('drop', e=>{ handleFiles(e.dataTransfer.files); });
fileinput.addEventListener('change', e=>{ handleFiles(e.target.files); });

async function handleFiles(fileList){
  if (!cvReady){ alert('측정 엔진을 아직 불러오는 중입니다. 잠시 후 다시 시도하세요.'); return; }
  const files = [...fileList].filter(f=>f.type.startsWith('image/'));
  if (!files.length) return;
  const coinMM = parseFloat(document.getElementById('coinmm').value)||24.0;
  const minArea = parseInt(document.getElementById('minarea').value)||80;

  const prog = document.getElementById('progress');
  const bar = document.getElementById('progbar');
  const ptext = document.getElementById('progtext');
  prog.classList.add('on');

  for (let i=0;i<files.length;i++){
    ptext.textContent = `처리 중 ${i+1} / ${files.length} — ${files[i].name}`;
    bar.style.width = ((i)/files.length*100)+'%';
    await new Promise(r=>setTimeout(r,20)); // UI 갱신 틈
    const res = await processImage(files[i], coinMM, minArea);
    results.push(res);
    renderResults();
  }
  bar.style.width='100%';
  ptext.textContent = `완료 — 총 ${files.length}장 처리`;
  setTimeout(()=>prog.classList.remove('on'), 1500);
}

function badge(status){
  if (status==='정상') return '<span class="badge ok">정상</span>';
  if (status.includes('미검출')||status.includes('없음'))
    return `<span class="badge err">${status}</span>`;
  return `<span class="badge warn">${status}</span>`;
}

function renderResults(){
  if (!results.length) return;
  document.getElementById('results').classList.add('on');
  const tb = document.getElementById('tbody');
  tb.innerHTML = results.map((r,i)=>{
    const cls = r.status==='정상' ? '' : (r.status.includes('미검출')?'err':'warn');
    const cell = v => v==null ? '<span style="color:#b0bac4">–</span>' : `<span class="num">${v}</span>`;
    const view = r.overlay
      ? `<button class="rowbtn" onclick="showOverlay(${i})">보기</button>` : '–';
    return `<tr class="${cls}">
      <td class="num">${i+1}</td>
      <td>${r.file}</td>
      <td>${badge(r.status)}</td>
      <td class="maxw num">${r.max==null?'–':r.max}</td>
      <td>${cell(r.mean)}</td><td>${cell(r.p95)}</td><td>${cell(r.median)}</td>
      <td>${cell(r.mmpp)}</td><td>${view}</td></tr>`;
  }).join('');

  // 요약 카드 (정상 건만)
  const ok = results.filter(r=>r.status==='정상');
  const sum = document.getElementById('summary');
  if (ok.length){
    const gmax = Math.max(...ok.map(r=>r.max));
    const amean = ok.reduce((s,r)=>s+r.mean,0)/ok.length;
    sum.innerHTML = `
      <div class="card hero"><div class="lbl">전체 최대 균열폭</div>
        <div class="val num">${gmax.toFixed(2)}<small> mm</small></div></div>
      <div class="card"><div class="lbl">평균폭의 평균</div>
        <div class="val num">${amean.toFixed(2)}<small> mm</small></div></div>
      <div class="card"><div class="lbl">측정 성공</div>
        <div class="val num">${ok.length}<small> / ${results.length}장</small></div></div>`;
  }
}

window.showOverlay = function(i){
  const r = results[i];
  document.getElementById('modalimg').src = r.overlay;
  document.getElementById('modalcap').textContent =
    `${r.file} — 파란 원: 검출된 동전 / 빨강↔초록: 균열폭 / 빨간 원: 최대폭 지점`;
  document.getElementById('modal').classList.add('on');
};
document.getElementById('modalclose').onclick =
  ()=>document.getElementById('modal').classList.remove('on');
document.getElementById('modal').onclick = e=>{
  if (e.target.id==='modal') e.target.classList.remove('on');
};

// CSV 내보내기
document.getElementById('csvbtn').onclick = ()=>{
  const head = ['No','파일명','상태','스케일(mm/px)','동전반경(px)',
                '최대폭(mm)','평균폭(mm)','95%폭(mm)','중앙폭(mm)','측정점수'];
  const rows = results.map((r,i)=>[i+1,r.file,r.status,r.mmpp??'',r.coinR??'',
    r.max??'',r.mean??'',r.p95??'',r.median??'',r.n??'']);
  const csv = '\uFEFF'+[head,...rows].map(row=>
    row.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `균열폭_측정_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
};

document.getElementById('clearbtn').onclick = ()=>{
  results.length = 0;
  document.getElementById('tbody').innerHTML='';
  document.getElementById('summary').innerHTML='';
  document.getElementById('results').classList.remove('on');
};
