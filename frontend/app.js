const service="github.com/run-bigpig/dsh-desktop/internal/desktop.RecoveryService.";
const isUpdateView=new URLSearchParams(window.location.search).get("view")==="update";
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
let splashActive=!isUpdateView;
let actionPending=false;

async function call(method,...args){if(!window.wails?.Call)throw new Error("Wails 本地接口尚未就绪");return window.wails.Call.ByName(service+method,...args)}

function render(state){
  if(isUpdateView){renderUpdate(state);return}
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
  root.style.setProperty("--logo-brightness",(.9+ratio*.16).toFixed(4));
  root.style.setProperty("--logo-glow",(.44+ratio*.44).toFixed(4));
  root.style.setProperty("--ambient-opacity",(.3+ratio*.18).toFixed(4));
}

async function refresh(){
  if(!splashActive&&!isUpdateView)return;
  try{
    const state=await call("GetState");
    if(splashActive||isUpdateView)render(state);
  }catch{}
}

function formatBytes(value){
  const size=Number(value)||0;
  if(size>=1073741824)return `${(size/1073741824).toFixed(2)} GiB`;
  if(size>=1048576)return `${(size/1048576).toFixed(1)} MiB`;
  if(size>=1024)return `${(size/1024).toFixed(1)} KiB`;
  return `${size} B`;
}

function renderUpdate(state){
  const status=state.desktopUpdate||{phase:"idle",message:"准备检查更新"};
  const update=state.availableUpdate;
  const phase=status.phase||"idle";
  const labels={idle:"准备就绪",checking:"正在检查",current:"已是最新",available:"发现更新",downloading:"正在下载",verifying:"正在校验",installing:"准备安装",cancelled:"已取消",failed:"更新失败"};
  const headings={idle:"检查 StarWeave 更新",checking:"正在检查更新",current:"你使用的是最新版本",available:`StarWeave ${update?.version||"新版本"} 已发布`,downloading:"正在下载安装包",verifying:"正在验证安装包",installing:"即将安装并重启",cancelled:"下载已取消",failed:"更新未完成"};
  document.body.dataset.updatePhase=phase;
  $("updateStatus").textContent=labels[phase]||"软件更新";
  $("updateHeading").textContent=headings[phase]||"软件更新";
  const sizeSuffix=phase==="available"&&update?.size?` · 安装包 ${formatBytes(update.size)}`:"";
  $("updateMessage").textContent=(status.message||"")+sizeSuffix;
  $("currentVersion").textContent=state.desktopVersion||"—";
  $("availableVersion").textContent=update?.version||"—";

  const notes=String(update?.releaseNotes||"").trim();
  $("releaseNotes").hidden=!notes;
  $("releaseNotesText").textContent=notes;

  const total=Number(status.total||update?.size||0);
  const downloaded=Number(status.downloaded||0);
  const progress=total>0?Math.max(0,Math.min(100,Number(status.progress)||Math.floor(downloaded*100/total))):0;
  const showProgress=["downloading","verifying","installing"].includes(phase);
  const progressPanel=$("downloadProgress");
  progressPanel.hidden=!showProgress;
  const track=progressPanel.querySelector(".progress-track");
  track.classList.toggle("indeterminate",showProgress&&total<=0);
  track.setAttribute("aria-valuenow",String(progress));
  $("downloadBar").style.width=`${progress}%`;
  $("downloadPercent").textContent=total>0?`${progress}%`:"…";
  $("downloadDetail").textContent=total>0?`${formatBytes(downloaded)} / ${formatBytes(total)}`:"正在接收数据";
  $("downloadSpeed").textContent=status.bytesPerSecond>0?`${formatBytes(status.bytesPerSecond)}/s`:phase==="verifying"?"SHA-256":"—";

  const busy=["checking","downloading","verifying","installing"].includes(phase);
  $("closeUpdate").hidden=busy;
  $("cancelUpdate").hidden=!status.canCancel;
  $("checkUpdate").hidden=!["idle","current"].includes(phase);
  $("retryUpdate").hidden=!status.canRetry;
  $("installUpdate").hidden=phase!=="available";
  for(const button of document.querySelectorAll(".update-actions button"))button.disabled=actionPending;
}

async function invokeAction(method){
  if(actionPending)return;
  actionPending=true;
  try{await call(method)}finally{actionPending=false;refresh()}
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
window.addEventListener("DOMContentLoaded",()=>{
  document.body.dataset.view=isUpdateView?"update":"boot";
  if(isUpdateView){
    $("closeUpdate").addEventListener("click",()=>invokeAction("CloseUpdateWindow"));
    $("cancelUpdate").addEventListener("click",()=>invokeAction("CancelDesktopUpdate"));
    $("checkUpdate").addEventListener("click",()=>invokeAction("CheckForUpdates"));
    $("installUpdate").addEventListener("click",()=>invokeAction("InstallDesktopUpdate"));
    $("retryUpdate").addEventListener("click",async()=>{
      let state;
      try{state=await call("GetState")}catch{}
      return invokeAction(state?.availableUpdate?"InstallDesktopUpdate":"CheckForUpdates");
    });
    setTimeout(refresh,80);
    setInterval(refresh,150);
    return;
  }
  animateProgress();
  setTimeout(refresh,120);
  setInterval(refresh,200);
});
