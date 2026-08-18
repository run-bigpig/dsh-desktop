const service="github.com/deepseek-ai/deepseek-harness-desktop/internal/desktop.RecoveryService.";
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
  $("progressBar").style.width=`${Math.max(2,visibleProgress)}%`;
  $("progressFish").style.left=`${Math.max(2,visibleProgress)}%`;
  requestAnimationFrame(animateProgress);
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
  const bar=$("progressBar");
  const fish=$("progressFish");
  bar.style.transition="none";
  fish.style.transition="none";
  bar.style.width="6%";
  fish.style.left="6%";
  $("progressText").textContent="正在唤醒桌面核心 · 06%";
  void bar.offsetWidth;
  bar.style.transition="";
  fish.style.transition="";
}
window.parkSplash=()=>{splashActive=false;resetSplash()};
window.activateSplash=()=>{splashActive=true;resetSplash();refresh()};
window.finishSplash=()=>document.body.classList.add("handoff");
window.addEventListener("DOMContentLoaded",()=>{animateProgress();setTimeout(refresh,120);setInterval(refresh,200)});
