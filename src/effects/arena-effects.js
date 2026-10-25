// Event-only effects. Pooled shard draws, goal shockwave rings, a goal flash
// sphere, delayed firework bursts and layered goal audio — no lights/bloom
// passes are added, so every preset renders the same explosions.
export function createArenaEffects(T, scene, { lightweight = false, audioContext, audioOutput } = {}) {
  const capacity = lightweight ? 96 : 300;
  const geometry = new T.BufferGeometry();
  geometry.setAttribute('position', new T.Float32BufferAttribute([
    0,1,0, -0.6,-0.5,0.5, 0.6,-0.5,0.5,
    0,1,0, 0.6,-0.5,0.5, 0,-0.5,-0.7,
    0,1,0, 0,-0.5,-0.7, -0.6,-0.5,0.5,
    -0.6,-0.5,0.5, 0,-0.5,-0.7, 0.6,-0.5,0.5,
  ], 3));
  const material = new T.MeshBasicMaterial({color: 0xffffff, toneMapped: false});
  const shards = new T.InstancedMesh(geometry, material, capacity);
  shards.name = 'Arena / pooled pickup and goal sparks';
  shards.frustumCulled = false; shards.visible = false; shards.count = 0;
  scene.add(shards);
  const marker = new T.Object3D(), tint = new T.Color();
  const pool = Array.from({length:capacity},()=>({life:0,total:0,x:0,y:0,z:0,vx:0,vy:0,vz:0,size:0,color:0,drag:1}));
  let cursor=0, goalTime=-1, goalPattern=0, goalRingStyle=1, lastPickupSound=-10, noise=null, pending=false;
  // Delayed secondary bursts (firework shells) emitted from update().
  const bursts = [];
  // Goal flash: one reusable additive sphere, animated per goal.
  const flash = new T.Mesh(
    new T.SphereGeometry(1, 20, 14),
    new T.MeshBasicMaterial({color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, blending: T.AdditiveBlending, toneMapped: false}));
  flash.name = 'Arena / goal flash'; flash.visible = false; scene.add(flash);
  const rings = [0,1,2].map(index => {
    const ring = new T.Mesh(new T.RingGeometry(.93,1,lightweight?32:48), new T.MeshBasicMaterial({color:0xffbe52,transparent:true,opacity:0,depthWrite:false,side:T.DoubleSide,toneMapped:false}));
    ring.name = `Arena / goal shockwave ${index}`;
    ring.visible=false;
    if (index === 2) ring.rotation.x = -Math.PI / 2; // ground shockwave
    scene.add(ring); return ring;
  });
  function sound(kind,big=false) {
    try {
      const ctx=audioContext?.(); if (!ctx || ctx.state!=='running') return;
      const now=ctx.currentTime;
      if(kind==='pickup' && now-lastPickupSound<.055) return;
      if(kind==='pickup')lastPickupSound=now;
      const output=audioOutput();
      const tone=(frequency,end,duration,volume,type='sine',delay=0)=>{
        const oscillator=ctx.createOscillator(), gain=ctx.createGain();
        oscillator.type=type; oscillator.frequency.setValueAtTime(frequency,now+delay);
        oscillator.frequency.exponentialRampToValueAtTime(end,now+delay+duration);
        gain.gain.setValueAtTime(.0001,now+delay); gain.gain.exponentialRampToValueAtTime(volume,now+delay+.01);
        gain.gain.exponentialRampToValueAtTime(.0001,now+delay+duration);
        oscillator.connect(gain).connect(output); oscillator.start(now+delay); oscillator.stop(now+delay+duration+.02);
        oscillator.onended=()=>{oscillator.disconnect();gain.disconnect();};
      };
      if(kind==='pickup') {
        tone(big?560:760,big?1280:1100,big?.25:.13,big?.10:.065);
        if(big)tone(840,1680,.23,.055,'sine',.04);
      } else {
        // Layered goal blast: sub boom, mid punch, crackle shells, crowd swell.
        tone(145,35,1.25,.25); tone(78,26,1.6,.22,'sine',.02);
        tone(390,780,.45,.075,'triangle');
        tone(1180,2350,.5,.028,'sawtooth',.05);
        if(!noise){noise=ctx.createBuffer(1,ctx.sampleRate,ctx.sampleRate);const data=noise.getChannelData(0);for(let i=0;i<data.length;i++)data[i]=(Math.random()*2-1)*(1-i/data.length);}
        const source=ctx.createBufferSource(), gain=ctx.createGain(), filter=ctx.createBiquadFilter();
        source.buffer=noise;filter.type='lowpass';filter.frequency.value=1500;
        gain.gain.setValueAtTime(.16,now);gain.gain.exponentialRampToValueAtTime(.0001,now+.9);
        source.connect(filter).connect(gain).connect(output);source.start();
        source.onended=()=>{source.disconnect();filter.disconnect();gain.disconnect();};
        // Firework crackle: short bright noise pops scattered over 1.2 s.
        const crackles=lightweight?5:10;
        for(let i=0;i<crackles;i++){
          const at=now+.12+Math.random()*.95;
          const pop=ctx.createBufferSource(), popGain=ctx.createGain(), popFilter=ctx.createBiquadFilter();
          pop.buffer=noise;popFilter.type='bandpass';popFilter.frequency.value=1600+Math.random()*3200;popFilter.Q.value=2.2;
          const volume=.05+Math.random()*.07;
          popGain.gain.setValueAtTime(.0001,at);popGain.gain.exponentialRampToValueAtTime(volume,at+.012);
          popGain.gain.exponentialRampToValueAtTime(.0001,at+.14);
          pop.connect(popFilter).connect(popGain).connect(output);pop.start(at);
          pop.onended=()=>{pop.disconnect();popFilter.disconnect();popGain.disconnect();};
        }
        // Crowd swell behind everything.
        const crowd=ctx.createBufferSource(), crowdGain=ctx.createGain(), crowdFilter=ctx.createBiquadFilter();
        crowd.buffer=noise;crowdFilter.type='lowpass';crowdFilter.frequency.value=700;
        crowdGain.gain.setValueAtTime(.0001,now+.08);
        crowdGain.gain.exponentialRampToValueAtTime(.05,now+.5);
        crowdGain.gain.exponentialRampToValueAtTime(.0001,now+1.8);
        crowd.connect(crowdFilter).connect(crowdGain).connect(output);crowd.start(now+.08);
        crowd.onended=()=>{crowd.disconnect();crowdFilter.disconnect();crowdGain.disconnect();};
      }
    } catch(error) { /* Audio is optional when the browser has not unlocked it. */ }
  }
  function emit(position,count,big,goal,color,options={}) {
    pending=true;
    const lighter=(color & 0xfefefe) >> 1 | 0x565656;
    for(let i=0;i<count;i++){
      const p=pool[cursor++%capacity], angle=Math.random()*Math.PI*2;
      const speed=goal?options.speedMin??350+Math.random()*(options.speedRange??1100):45+Math.random()*(big?150:80);
      const vertical=goal?(options.vyMin??180)+Math.random()*(options.vyRange??1100):80+Math.random()*170;
      Object.assign(p,{life:goal?1+Math.random()*(options.lifeRange??1):.32+Math.random()*.25,
        x:position.x+(options.spread?(Math.random()-.5)*options.spread:0),
        y:Math.max(6,position.y+(options.spread?(Math.random()-.5)*options.spread*.6:0)),
        z:position.z+(options.spread?(Math.random()-.5)*options.spread:0),
        vx:Math.cos(angle)*speed*(options.axial??1),vy:vertical,vz:Math.sin(angle)*speed*(options.axial??1),
        size:goal?(options.sizeMin??20)+Math.random()*(options.sizeRange??38):big?9:5,
        color:goal?(Math.random()<.22?0xffffff:Math.random()<.2?lighter:color):color,
        drag:options.drag??1});
      p.total=p.life;
    }
  }
  function pickup(position,big,audible=true){emit(position,lightweight?6:10,big,false,0xffd777);if(audible)sound('pickup',big);}
  function scheduleBurst(position,delay,count,color,options) {
    bursts.push({at:delay,position:position.clone(),count,color,options});
  }
  // Goal explosion styles, selected in the garage. Every style is a parameter
  // set over the same pooled shards / rings / flash — no new passes.
  const EXPLOSION_STYLES = {
    classic:   { main:130, shells:7,  fountain:.34, ringScale:1,   ringTime:1,   flash:1,   speed:1,   vy:1,   drag:1,   life:1,   multicolor:false },
    fireworks: { main:60,  shells:14, fountain:.1,  ringScale:.8,  ringTime:1.4, flash:1.1, speed:1,   vy:.9,  drag:.68, life:1.25,multicolor:true },
    fountain:  { main:70,  shells:4,  fountain:1.6, ringScale:1.15,ringTime:.9,  flash:.8,  speed:.55, vy:2.1, drag:.9,  life:1.5, multicolor:false },
    rings:     { main:60,  shells:3,  fountain:.15, ringScale:2.6, ringTime:2.1, flash:1.3, speed:.8,  vy:.8,  drag:1,   life:1.2, multicolor:false },
    nova:      { main:170, shells:5,  fountain:.2,  ringScale:2.2, ringTime:1.6, flash:2.4, speed:1.7, vy:1.4, drag:1,   life:.9,  multicolor:false },
    confetti:  { main:150, shells:2,  fountain:.5,  ringScale:.7,  ringTime:1.8, flash:.5,  speed:.45, vy:1.5, drag:.5,  life:2.4, multicolor:true },
  };
  function goal(position, spec){
    // Accept the legacy plain-color call shape as well as the garage spec.
    const resolved = typeof spec === 'number'
      ? { style: 'classic', primary: spec, secondary: 0xffffff, intensity: 1 }
      : (spec ?? {});
    const cfg = EXPLOSION_STYLES[resolved.style] ?? EXPLOSION_STYLES.classic;
    const primary = resolved.primary ?? 0xffbe52;
    const secondary = resolved.secondary ?? 0xffffff;
    const k = Math.max(.4, Math.min(2.2, Number(resolved.intensity) || 1));
    const palette = cfg.multicolor ? [primary, secondary, 0xffffff, primary] : null;
    const pick = () => palette ? palette[Math.floor(Math.random() * palette.length)] : primary;
    goalPattern = Math.random()<.34?1:Math.random()<.5?2:3;
    goalTime=0;
    goalRingStyle=cfg.ringScale;
    const side=position.z>0?-1:1;
    // Main radial blast at the ball, sized by style and garage intensity.
    emit(position,Math.max(8,Math.round((lightweight?60:cfg.main)*k)),true,true,pick(),
      {speedMin:420*cfg.speed,speedRange:1500*cfg.speed,vyMin:260*cfg.vy,vyRange:1300*cfg.vy,sizeMin:24,sizeRange:52,spread:140,drag:cfg.drag,lifeRange:cfg.life});
    // Firework shells climbing above the goal, bursting in stages.
    const shellCount=Math.max(1,Math.round((lightweight?3:cfg.shells)*Math.sqrt(k)));
    for(let i=0;i<shellCount;i++){
      const apex={x:position.x+(Math.random()-.5)*1600,y:900+Math.random()*1400,z:position.z+side*(300+Math.random()*900)};
      scheduleBurst(new T.Vector3(position.x,position.y,position.z),.28+i*.12,Math.max(4,Math.round((lightweight?8:18)*k)),pick(),
        {speedMin:300*cfg.speed,speedRange:900*cfg.speed,vyMin:60,vyRange:520*cfg.vy,sizeMin:16,sizeRange:34,spread:60,lifeRange:.8*cfg.life,drag:.7});
      scheduleBurst(new T.Vector3(apex.x,apex.y,apex.z),.55+i*.13,Math.max(4,Math.round((lightweight?10:22)*k)),i%2?secondary:primary,
        {speedMin:260*cfg.speed,speedRange:820*cfg.speed,vyMin:-40,vyRange:420*cfg.vy,sizeMin:14,sizeRange:30,spread:40,lifeRange:.9*cfg.life,drag:.65});
    }
    if(Math.random()<cfg.fountain){ // vertical fountain at the mouth
      emit({x:position.x,y:position.y,z:position.z},Math.max(8,Math.round((lightweight?24:60)*cfg.fountain*k)),true,true,secondary,
        {speedMin:60,speedRange:240,vyMin:900*cfg.fountain,vyRange:900*cfg.fountain,sizeMin:18,sizeRange:30,axial:.15,spread:220,drag:cfg.drag});
    }
    rings.forEach((ring,i)=>{ring.position.copy(position);ring.position.z+=side*(-15-i*5);ring.material.color.setHex(i===1?secondary:primary);ring.visible=true;});
    // Flash sphere: instant glow at the goal mouth.
    flash.position.copy(position);flash.material.color.setHex(secondary);flash.scale.setScalar(30*cfg.flash);flash.scale0=30*cfg.flash;flash.material.opacity=.95*Math.min(1,cfg.flash);flash.visible=true;
    sound('goal');
  }
  function update(delta){
    if (!pending && !shards.visible && goalTime < 0 && !bursts.length && !flash.visible) return;
    pending=false;
    // Firework shells due this frame.
    for(let i=bursts.length-1;i>=0;i--){
      const burst=bursts[i];burst.at-=delta;
      if(burst.at<=0){emit(burst.position,burst.count,true,true,burst.color,burst.options);bursts.splice(i,1);}
    }
    let count=0;
    for(const p of pool){
      if(p.life<=0)continue;p.life-=delta;if(p.life<=0)continue;
      const dragFactor=Math.pow(p.drag, delta*60);
      p.x+=p.vx*delta;p.y+=p.vy*delta;p.z+=p.vz*delta;p.vy-=250*delta*p.drag;
      if(p.drag<1){p.vx*=dragFactor;p.vz*=dragFactor;}
      marker.position.set(p.x,Math.max(4,p.y),p.z);marker.rotation.set(p.life*3,p.life*2,p.life);
      marker.scale.setScalar(p.size*Math.min(1,p.life/.25));marker.updateMatrix();
      shards.setMatrixAt(count,marker.matrix);tint.setHex(p.color);shards.setColorAt(count,tint);count++;
    }
    shards.visible=count>0;shards.count=count;
    if(count){shards.instanceMatrix.needsUpdate=true;shards.instanceColor.needsUpdate=true;}
    if(goalTime>=0){
      goalTime+=delta;
      const ringStyle=goalRingStyle??1;
      rings.forEach((ring,i)=>{
        const t=goalTime-i*.13;
        ring.visible=t>0&&t<1.1*ringStyle;
        if(ring.visible){
          ring.scale.setScalar(90+t*(i===2?2600:(i?1550:2200))*ringStyle);
          ring.material.opacity=Math.max(0,(1-t/(1.1*ringStyle))*.65);
        }
      });
      if(flash.visible){
        const t=goalTime;
        flash.scale.setScalar(flash.scale0??30+t*900);
        flash.material.opacity=Math.max(0,.95*(1-t/.4));
        if(t>.4)flash.visible=false;
      }
      if(goalTime>1.3)goalTime=-1;
    }
    if(bursts.length)pending=true;
  }
  function clear(){pending=false;bursts.length=0;for(const p of pool)p.life=0;shards.visible=false;shards.count=0;goalTime=-1;for(const ring of rings)ring.visible=false;flash.visible=false;}
  return {pickup,goal,update,clear,get active(){return pending||shards.visible||goalTime>=0||bursts.length>0||flash.visible;}};
}
