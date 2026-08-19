const service="github.com/run-bigpig/dsh-desktop/internal/desktop.RecoveryService.";
const phases={
  idle:{text:"正在唤醒桌面核心",progress:8},
  starting:{text:"正在启动 Harness",progress:68},
  checking:{text:"正在检查桌面更新",progress:82},
  building:{text:"正在构建运行时",progress:72},
  downloading:{text:"正在下载桌面更新",progress:88},
  installing:{text:"正在准备桌面升级",progress:94},
  pending:{text:"更新已准备完成",progress:96},
  activating:{text:"正在切换内置运行时",progress:58},
  recovering:{text:"正在恢复运行环境",progress:44},
  failed:{text:"Harness 未能启动",progress:100},
  ready:{text:"Harness 已就绪",progress:100}
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
  paintAbsorption(visibleProgress);
  requestAnimationFrame(animateProgress);
}

function paintAbsorption(progress){
  const ratio=Math.max(0,Math.min(1,progress/100));
  const root=document.documentElement;
  root.style.setProperty("--water-scale",(1.16-ratio*.9).toFixed(4));
  root.style.setProperty("--water-opacity",Math.max(.025,1-ratio*.975).toFixed(4));
  root.style.setProperty("--ring-scale",Math.max(.18,.98-ratio*.8).toFixed(4));
  root.style.setProperty("--bubble-opacity",Math.max(0,.76-ratio*.8).toFixed(4));
  root.style.setProperty("--fish-scale",(.78+ratio*.72).toFixed(4));
  root.style.setProperty("--fish-brightness",Math.max(.035,1-ratio*.965).toFixed(4));
  root.style.setProperty("--fish-glow",Math.max(.08,.78-ratio*.7).toFixed(4));
  root.style.setProperty("--ambient-opacity",Math.max(.035,.42-ratio*.385).toFixed(4));
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
  paintAbsorption(6);
  $("progressText").textContent="正在唤醒桌面核心 · 06%";
  void document.body.offsetWidth;
  document.body.classList.remove("instant");
}
window.parkSplash=()=>{splashActive=false;resetSplash()};
window.activateSplash=()=>{splashActive=true;resetSplash();refresh()};
window.finishSplash=()=>document.body.classList.add("handoff");
window.addEventListener("DOMContentLoaded",()=>{animateProgress();setTimeout(refresh,120);setInterval(refresh,200)});
