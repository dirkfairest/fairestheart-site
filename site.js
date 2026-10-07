(function(){
  var nav=document.getElementById('nav'), btn=document.getElementById('menuBtn');
  btn.addEventListener('click',function(){var o=nav.classList.toggle('open');btn.setAttribute('aria-expanded',o?'true':'false')});

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
  var reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
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
  function tick(){
    for(var k=0;k<2;k++){ buf[head]=beat(phase); head=(head+1)%N; phase+=1/fs; if(phase>rr-0.3){phase=-(rr-0.3); rr=0.78+Math.random()*0.1;} }
    draw(); if(!reduce)requestAnimationFrame(tick);
  }
  draw(); if(!reduce)requestAnimationFrame(tick);
})();
