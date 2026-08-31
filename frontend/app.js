const service="github.com/run-bigpig/dsh-desktop/internal/desktop.RecoveryService.";
const phases={
  idle:{text:"星织启动中",progress:8},
  starting:{text:"星织启动中",progress:68},
  checking:{text:"星织启动中",progress:82},
  building:{text:"星织启动中",progress:72},
  downloading:{text:"星织启动中",progress:88},
  installing:{text:"星织启动中",progress:94},
  pending:{text:"星织启动中",progress:96},
  activating:{text:"星织启动中",progress:58},
  recovering:{text:"星织启动中",progress:44},
  failed:{text:"星织启动失败",progress:100},
  ready:{text:"星织已就绪",progress:100}
};

const $=id=>document.getElementById(id);
let visibleProgress=6;
let targetProgress=8;
let currentPhase="idle";
let splashActive=true;

async function call(method,...args){if(!window.wails?.Call)throw new Error("Wails 本地接口尚未就绪");return window.wails.Call.ByName(service+method,...args)}

function render(state){
  const nextPhase=state.phase||"idle";
  currentPhase=nextPhase;
  const meta=phases[currentPhase]||phases.idle;
  targetProgress=Math.max(targetProgress,meta.progress);
  document.body.dataset.phase=currentPhase;
}

function animateProgress(){
  if(!splashActive){requestAnimationFrame(animateProgress);return}
  const remaining=targetProgress-visibleProgress;
  if(Math.abs(remaining)>.05)visibleProgress+=remaining*(currentPhase==="ready"?.14:.035);
  else if(currentPhase==="starting"&&visibleProgress<72)visibleProgress+=.006;
  const value=Math.max(0,Math.min(100,Math.round(visibleProgress)));
  const meta=phases[currentPhase]||phases.idle;
  $("progressText").textContent=`${meta.text} · ${String(value).padStart(2,"0")}%`;
  paintConvergence(visibleProgress);
  requestAnimationFrame(animateProgress);
}

function paintConvergence(progress){
  const ratio=Math.max(0,Math.min(1,progress/100));
  const root=document.documentElement;
  root.style.setProperty("--field-scale",(1.08-ratio*.26).toFixed(4));
  root.style.setProperty("--stream-opacity",(.38+ratio*.38).toFixed(4));
  root.style.setProperty("--stream-scale",Math.max(.58,1.04-ratio*.46).toFixed(4));
  root.style.setProperty("--orbit-scale",Math.max(.72,1.06-ratio*.34).toFixed(4));
  root.style.setProperty("--logo-scale",(.8+ratio*.2).toFixed(4));
  root.style.setProperty("--logo-brightness",(.9+ratio*.16).toFixed(4));
  root.style.setProperty("--logo-glow",(.44+ratio*.44).toFixed(4));
  root.style.setProperty("--ambient-opacity",(.3+ratio*.18).toFixed(4));
}

async function refresh(){
  if(!splashActive)return;
  try{
    const state=await call("GetState");
    if(splashActive)render(state);
  }catch{}
}

function resetSplash(){
  visibleProgress=6;
  targetProgress=8;
  currentPhase="idle";
  document.body.dataset.phase="idle";
  document.body.classList.remove("handoff");
  document.body.classList.add("instant");
  paintConvergence(6);
  $("progressText").textContent="星织启动中 · 06%";
  void document.body.offsetWidth;
  document.body.classList.remove("instant");
}
window.parkSplash=()=>{splashActive=false;resetSplash()};
window.activateSplash=()=>{splashActive=true;resetSplash();refresh()};
window.finishSplash=()=>document.body.classList.add("handoff");
window.addEventListener("DOMContentLoaded",()=>{animateProgress();setTimeout(refresh,120);setInterval(refresh,200)});
