(function(){
  var nav=document.getElementById('nav'), btn=document.getElementById('menuBtn');
  btn.addEventListener('click',function(){var o=nav.classList.toggle('open');btn.setAttribute('aria-expanded',o?'true':'false')});
  // the three groups: a tap or Enter on the button opens one and closes the
  // others; Escape or a click elsewhere closes them all (hover needs no script)
  var grps=[].slice.call(nav.querySelectorAll('.grp'));
  function closeAll(except){grps.forEach(function(g){if(g!==except){g.classList.remove('open');g.querySelector('.grp-btn').setAttribute('aria-expanded','false')}})}
  grps.forEach(function(g){var b=g.querySelector('.grp-btn');b.addEventListener('click',function(e){e.stopPropagation();var o=g.classList.toggle('open');closeAll(g);b.setAttribute('aria-expanded',o?'true':'false')})});
  document.addEventListener('click',function(e){if(!nav.contains(e.target))closeAll()});
  document.addEventListener('keydown',function(e){if(e.key==='Escape'){closeAll();nav.classList.remove('open');btn.setAttribute('aria-expanded','false')}});

  var cb=document.getElementById('copyBtn');
  if(cb)cb.addEventListener('click',function(){
    var t=document.getElementById('mail').textContent;
    function done(){cb.textContent='Copied';setTimeout(function(){cb.textContent='Copy address'},1600)}
    function sel(){var r=document.createRange();r.selectNodeContents(document.getElementById('mail'));var s=getSelection();s.removeAllRanges();s.addRange(r)}
    if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(done,sel)}else sel();
  });

  // live ECG strip: one synthetic PQRST beat at ~72 bpm, drawn the way the app draws it
  var c=document.getElementById('ecg'); if(!c)return; var g=c.getContext('2d');
  var W=c.width,H=c.height, secs=5, fs=130, N=secs*fs, buf=new Float32Array(N), t=0, phase=0, rr=0.83;
  // The strip always moves: a live ECG is the point of the page (Dirk, 2026-10-12);
  // the page's own scrolling still honours reduce-motion in styles.css.
  var reduce=false;
  function beat(x){ // x in seconds since R, returns µV
    var v=0;
    v+= 120*Math.exp(-Math.pow((x+0.20)/0.025,2));      // P
    v+= -140*Math.exp(-Math.pow((x+0.035)/0.009,2));    // Q
    v+= 1050*Math.exp(-Math.pow(x/0.011,2));            // R
    v+= -260*Math.exp(-Math.pow((x-0.035)/0.012,2));    // S
    v+= 230*Math.exp(-Math.pow((x-0.26)/0.055,2));      // T
    return v+(Math.random()-0.5)*24;
  }
  for(var i=0;i<N;i++){buf[i]=beat(phase); phase+=1/fs; if(phase>rr-0.3){phase=-0.3-rr+0.3; rr=0.78+Math.random()*0.1;}}
  var head=0; phase=0.2;
  function grid(){
    g.fillStyle='#151a23';g.fillRect(0,0,W,H);
    g.strokeStyle='rgba(255,255,255,.06)';g.lineWidth=1;g.beginPath();
    var px=W/secs/5; for(var x=0;x<=W;x+=px){g.moveTo(x+.5,0);g.lineTo(x+.5,H)}
    for(var y=0;y<=H;y+=px){g.moveTo(0,y+.5);g.lineTo(W,y+.5)}
    g.stroke();
    g.fillStyle='rgba(154,163,178,.8)';g.font='12px Roboto, sans-serif';
    g.fillText('1000',8,H*0.28);g.fillText('0',8,H*0.63);g.fillText('-1000',8,H*0.95);g.fillText('µV',W-26,16);
  }
  function draw(){
    grid();
    g.strokeStyle='#5fe3c8';g.lineWidth=2;g.lineJoin='round';g.shadowColor='rgba(95,227,200,.35)';g.shadowBlur=6;g.beginPath();
    var mid=H*0.6, sc=H*0.32/1000;
    for(var i=0;i<N;i++){var v=buf[(head+i)%N]; var x=i/N*W, y=mid-v*sc; if(i===0)g.moveTo(x,y);else g.lineTo(x,y)}
    g.stroke(); g.shadowBlur=0;
  }
  // Real time: 130 samples per second of wall clock, whatever the display's
  // refresh rate (a 120 Hz screen used to run the strip twice as fast).
  var last=0, carry=0;
  function tick(now){
    if(!last)last=now; var dt=Math.min((now-last)/1000,0.25); last=now;
    carry+=dt*fs; var n=Math.floor(carry); carry-=n;
    for(var k=0;k<n;k++){ buf[head]=beat(phase); head=(head+1)%N; phase+=1/fs; if(phase>rr-0.3){phase=-(rr-0.3); rr=0.78+Math.random()*0.1;} }
    if(n)draw(); if(!reduce)requestAnimationFrame(tick);
  }
  draw(); if(!reduce)requestAnimationFrame(tick);
  // The recording clock counts like the app's: starts where the picture starts.
  var clk=document.getElementById('rec-clock'); if(clk){ var t0=Date.now()-(2*60+24)*1000;
    setInterval(function(){ var s=Math.floor((Date.now()-t0)/1000), h=Math.floor(s/3600), m=Math.floor(s%3600/60), x=s%60;
      clk.textContent=h+':'+(m<10?'0':'')+m+':'+(x<10?'0':'')+x; },1000); }
})();
