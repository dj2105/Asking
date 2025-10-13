// /src/views/Final.js
import { ensureAuth, db } from "../lib/firebase.js";
import { doc, onSnapshot, getDoc } from "firebase/firestore";

export default function Final(){
  const el=document.createElement('section'); el.className='wrap';
  const $=(s)=>el.querySelector(s);

  const role=(localStorage.getItem('playerRole')||'guest').toLowerCase();
  const code=(localStorage.getItem('lastGameCode')||'').toUpperCase();

  function sum(a){ return (a||[]).reduce((x,y)=>x+(Number(y)||0),0); }

  function render(seed, H, G){
    // compute (same as your previous logic, simplified output headings)
    const getRound=(isHost,r)=> (isHost? seed.rounds[r-1]?.hostQ : seed.rounds[r-1]?.guestQ) || [];
    const actual=(isHost,doc)=>{
      const per=[]; for(let r=1;r<=5;r++){ const qs=getRound(isHost,r), ans=(doc?.answers||{})[`r${r}`];
        let c=0; if(Array.isArray(qs)&&ans){ for(const [i,q] of qs.entries()){ const id=q.id||`q${i+1}`; const mine=ans[id]; if(mine && mine===q.correct) c++; } }
        per.push(c);
      } return { per, total: sum(per) };
    };
    const hostA=actual(true,H), guestA=actual(false,G);
    const hostM=Number.isInteger(H?.mathsScore)?H.mathsScore:0;
    const guestM=Number.isInteger(G?.mathsScore)?G.mathsScore:0;

    const totalH=hostA.total+hostM, totalG=guestA.total+guestM;
    const win = totalH>totalG ? 'Daniel' : totalG>totalH ? 'Jaime' : 'Tie';

    $('#summary').innerHTML=`
      <h2>Final</h2>
      <section class="panel">
        <h3>${win==='Tie'?'TIE':win+' WINS'}</h3>
        <p class="status">Daniel ${totalH} · Jaime ${totalG}</p>
      </section>
    `;
  }

  el.innerHTML=`
    <div id="summary"><h2>Final</h2><section class="panel"><p class="status">Loading…</p></section></div>
  `;

  (async()=>{
    await ensureAuth();
    const roomRef=doc(db,'rooms',code);
    onSnapshot(roomRef, async (snap)=>{
      if(!snap.exists()) return;
      const data=snap.data()||{};
      if(data.state!=='final'){ $('#summary').innerHTML='<section class="panel"><p class="status">Waiting…</p></section>'; return; }
      const seed=data.seed || (await getDoc(roomRef).then(s=>s.data()?.seed).catch(()=>null));
      const [H,G]=await Promise.all([ getDoc(doc(db,'rooms',code,'players','host')), getDoc(doc(db,'rooms',code,'players','guest')) ]);
      render(seed, H.exists()?H.data():{}, G.exists()?G.data():{});
    });
  })();

  return el;
}
