import * as THREE from "./vendor/three.module.min.js";

const canvas=document.getElementById("particleField");
const isUpdateView=new URLSearchParams(window.location.search).get("view")==="update";

if(canvas&&!isUpdateView){
  try{
    createParticleField(canvas);
  }catch{
    canvas.hidden=true;
  }
}

function createParticleField(canvas){
  const reduceMotion=window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const renderer=new THREE.WebGLRenderer({canvas,alpha:true,antialias:false,powerPreference:"high-performance"});
  renderer.setClearColor(0x000000,0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,1.6));

  const scene=new THREE.Scene();
  const camera=new THREE.PerspectiveCamera(48,1,.1,100);
  camera.position.z=16;

  const random=seededRandom(0x53574156);
  const compact=window.innerWidth<700;
  const dust=createDust(compact?520:760,random);
  const streams=createStreams(compact?240:360,random);
  const orbit=createOrbit(compact?120:180,random);
  scene.add(dust.points,streams.points,orbit.points);

  let progress=.06;
  let targetProgress=.06;
  let phase="idle";
  let active=true;
  let elapsed=0;
  let previousTime=performance.now();

  function resize(){
    const width=Math.max(1,canvas.clientWidth);
    const height=Math.max(1,canvas.clientHeight);
    renderer.setSize(width,height,false);
    camera.aspect=width/height;
    camera.updateProjectionMatrix();
    if(reduceMotion)draw(performance.now());
  }

  function draw(now){
    const delta=Math.min(Math.max((now-previousTime)/1000,0),.05);
    previousTime=now;
    if(!reduceMotion)elapsed+=delta;
    progress+=(targetProgress-progress)*Math.min(1,delta*3.2);

    const ready=phase==="ready";
    const fieldEnergy=.62+progress*.38;
    dust.points.rotation.z=elapsed*.012;
    dust.points.rotation.y=Math.sin(elapsed*.09)*.035;
    dust.material.uniforms.uOpacity.value=ready?.34:.58+progress*.12;

    updateStreams(streams,elapsed,progress,ready);
    streams.material.uniforms.uOpacity.value=ready?.16:.78;
    streams.points.rotation.z=-elapsed*.025;

    orbit.points.rotation.z=elapsed*(.08+progress*.07);
    orbit.points.rotation.x=.9+Math.sin(elapsed*.18)*.08;
    orbit.material.uniforms.uOpacity.value=(ready?.22:.48)*fieldEnergy;
    orbit.material.uniforms.uPulse.value=.84+Math.sin(elapsed*1.7)*.16;

    camera.position.x=Math.sin(elapsed*.12)*.12;
    camera.position.y=Math.cos(elapsed*.1)*.08;
    renderer.render(scene,camera);
  }

  function start(){
    if(!active||document.hidden||reduceMotion)return;
    previousTime=performance.now();
    renderer.setAnimationLoop(draw);
  }

  function stop(){
    renderer.setAnimationLoop(null);
  }

  const resizeObserver=new ResizeObserver(resize);
  resizeObserver.observe(canvas);
  resize();

  window.starweaveParticles={
    setProgress(value){
      targetProgress=Math.max(0,Math.min(1,Number(value)||0));
      if(reduceMotion)draw(performance.now());
    },
    setPhase(value){
      phase=String(value||"idle");
      if(reduceMotion)draw(performance.now());
    },
    setActive(value){
      active=Boolean(value);
      if(active)start();else stop();
    }
  };

  document.addEventListener("visibilitychange",()=>{
    if(document.hidden)stop();else start();
  });
  canvas.addEventListener("webglcontextlost",stop);

  if(reduceMotion)draw(performance.now());else start();
}

function createDust(count,random){
  const positions=new Float32Array(count*3);
  const colors=new Float32Array(count*3);
  const sizes=new Float32Array(count);
  const alphas=new Float32Array(count);
  const cyan=new THREE.Color(0x71efff);
  const blue=new THREE.Color(0x5b82ff);
  const violet=new THREE.Color(0xb58cff);
  const color=new THREE.Color();

  for(let index=0;index<count;index++){
    const offset=index*3;
    const depth=random()*12-7;
    positions[offset]=(random()*2-1)*14;
    positions[offset+1]=(random()*2-1)*8;
    positions[offset+2]=depth;
    const mix=random();
    color.copy(mix<.62?cyan:mix<.88?blue:violet).multiplyScalar(.7+random()*.45);
    color.toArray(colors,offset);
    sizes[index]=.38+random()*1.15+(random()>.965?1.25:0);
    alphas[index]=.18+random()*.58;
  }

  const geometry=makeGeometry(positions,colors,sizes,alphas);
  const material=makeMaterial();
  return {points:new THREE.Points(geometry,material),material};
}

function createStreams(count,random){
  const positions=new Float32Array(count*3);
  const colors=new Float32Array(count*3);
  const sizes=new Float32Array(count);
  const alphas=new Float32Array(count);
  const metadata=new Float32Array(count*5);
  const cyan=new THREE.Color(0x89f6ff);
  const blue=new THREE.Color(0x4f8cff);
  const violet=new THREE.Color(0xa978ff);
  const gold=new THREE.Color(0xffd589);
  const color=new THREE.Color();

  for(let index=0;index<count;index++){
    const offset=index*3;
    const meta=index*5;
    metadata[meta]=random()*Math.PI*2;
    metadata[meta+1]=6+random()*8.5;
    metadata[meta+2]=.055+random()*.07;
    metadata[meta+3]=random();
    metadata[meta+4]=random()*4-2;
    const mix=random();
    color.copy(mix<.54?cyan:mix<.79?blue:mix<.95?violet:gold);
    color.toArray(colors,offset);
    sizes[index]=.72+random()*1.65;
    alphas[index]=0;
  }

  const geometry=makeGeometry(positions,colors,sizes,alphas);
  const material=makeMaterial();
  return {points:new THREE.Points(geometry,material),material,positions,alphas,metadata,count};
}

function updateStreams(streams,time,progress,ready){
  const {positions,alphas,metadata,count}=streams;
  const pull=.8+progress*.13;
  const turns=3.6+progress*2.7;

  for(let index=0;index<count;index++){
    const offset=index*3;
    const meta=index*5;
    const cycle=fract(metadata[meta+3]+time*metadata[meta+2]);
    const inward=Math.pow(cycle,.72);
    const radius=metadata[meta+1]*(1-inward*pull);
    const direction=index%2===0?1:-1;
    const angle=metadata[meta]+direction*inward*turns+time*.035*direction;
    positions[offset]=Math.cos(angle)*radius;
    positions[offset+1]=Math.sin(angle)*radius*.58;
    positions[offset+2]=metadata[meta+4]-inward*1.8+Math.sin(angle*2.2)*.42;
    const edgeFade=Math.min(1,cycle/.11,(1-cycle)/.1);
    alphas[index]=Math.max(0,edgeFade)*(.38+inward*.62)*(ready?.38:1);
  }

  streams.points.geometry.attributes.position.needsUpdate=true;
  streams.points.geometry.attributes.aAlpha.needsUpdate=true;
}

function createOrbit(count,random){
  const positions=new Float32Array(count*3);
  const colors=new Float32Array(count*3);
  const sizes=new Float32Array(count);
  const alphas=new Float32Array(count);
  const cyan=new THREE.Color(0x5eeaff);
  const violet=new THREE.Color(0x8b6cff);
  const gold=new THREE.Color(0xffd07a);
  const color=new THREE.Color();

  for(let index=0;index<count;index++){
    const offset=index*3;
    const angle=index/count*Math.PI*2+random()*.06;
    const radius=3.15+(random()-.5)*.3;
    positions[offset]=Math.cos(angle)*radius;
    positions[offset+1]=Math.sin(angle)*radius;
    positions[offset+2]=(random()-.5)*.32;
    color.copy(index%17===0?gold:index%3===0?violet:cyan).toArray(colors,offset);
    sizes[index]=.55+random()*.85;
    alphas[index]=.3+random()*.62;
  }

  const geometry=makeGeometry(positions,colors,sizes,alphas);
  const material=makeMaterial();
  return {points:new THREE.Points(geometry,material),material};
}

function makeGeometry(positions,colors,sizes,alphas){
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute("position",new THREE.BufferAttribute(positions,3));
  geometry.setAttribute("aColor",new THREE.BufferAttribute(colors,3));
  geometry.setAttribute("aSize",new THREE.BufferAttribute(sizes,1));
  geometry.setAttribute("aAlpha",new THREE.BufferAttribute(alphas,1));
  return geometry;
}

function makeMaterial(){
  return new THREE.ShaderMaterial({
    uniforms:{
      uOpacity:{value:1},
      uPixelRatio:{value:Math.min(window.devicePixelRatio||1,1.6)},
      uPulse:{value:1}
    },
    vertexShader:`
      attribute float aSize;
      attribute float aAlpha;
      attribute vec3 aColor;
      varying vec3 vColor;
      varying float vAlpha;
      uniform float uPixelRatio;
      uniform float uPulse;
      void main(){
        vColor=aColor;
        vAlpha=aAlpha;
        vec4 viewPosition=modelViewMatrix*vec4(position,1.0);
        gl_Position=projectionMatrix*viewPosition;
        gl_PointSize=aSize*uPixelRatio*uPulse*(54.0/-viewPosition.z);
      }
    `,
    fragmentShader:`
      varying vec3 vColor;
      varying float vAlpha;
      uniform float uOpacity;
      void main(){
        float distanceToCenter=length(gl_PointCoord-vec2(.5))*2.0;
        if(distanceToCenter>1.0)discard;
        float glow=1.0-smoothstep(.05,1.0,distanceToCenter);
        float core=pow(glow,3.0);
        gl_FragColor=vec4(vColor*(.82+core*1.6),glow*vAlpha*uOpacity);
      }
    `,
    transparent:true,
    vertexColors:true,
    blending:THREE.AdditiveBlending,
    depthWrite:false,
    depthTest:false,
    toneMapped:false
  });
}

function seededRandom(seed){
  let value=seed>>>0;
  return ()=>{
    value=(Math.imul(value,1664525)+1013904223)>>>0;
    return value/4294967296;
  };
}

function fract(value){return value-Math.floor(value)}
