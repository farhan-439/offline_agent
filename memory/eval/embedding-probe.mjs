const docs = [
 "Maya · health: Knee surgery at Mercy Hospital this Friday",
 "Me · promise: Water Maya's tomato plants every evening; spare key under the blue pot",
 "Priya · family: Maya's daughter driving down from Boston to stay with her",
 "Me · medication: Lisinopril raised from 5 mg to 10 mg, once every morning",
 "Me · health: Avoid potassium supplements and grapefruit juice",
 "Dr. Patel · plan: Follow-up appointment December 3, bring blood pressure log",
 "Sam · plan: Coming for lunch Sunday around noon with Lily",
 "Lily · health: Allergic to peanuts, no peanut cookies",
];
const qs = [ // paraphrases with little or no word overlap
 ["Who is having an operation soon?",0],
 ["Did anyone need help with their garden?",1],
 ["Is someone visiting my neighbour from out of town?",2],
 ["What did the doctor change about my pills?",3],
 ["Which foods or drinks should I stay away from?",4],
 ["When do I go back to the clinic?",5],
 ["Who is coming over this weekend?",6],
 ["What can't the kids eat?",7],
 ["How much of my heart medicine do I take now?",3],
 ["Where did Maya hide her house key?",1],
];
const url = process.argv[2];
async function emb(texts){ const r = await fetch(url+'/v1/embeddings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({input:texts,model:'x'})}); const j=await r.json(); if(!j.data) throw new Error(JSON.stringify(j).slice(0,300)); return j.data.map(d=>d.embedding);}
const cos=(a,b)=>{let d=0,x=0,y=0;for(let i=0;i<a.length;i++){d+=a[i]*b[i];x+=a[i]*a[i];y+=b[i]*b[i]}return d/Math.sqrt(x*y)};
const words=s=>new Set(s.toLowerCase().match(/[a-z0-9]+/g).filter(w=>w.length>2&&!['the','and','who','what','did','with','their','from','for','this','soon','any','can','how','now','where','her','his','which','should','stay','away','over','much','take','going'].includes(w)));
function score(name, rank){ let top1=0,mrr=0; for(const [q,i] of qs){ const order=rank(q); const r=order.indexOf(i)+1; if(r===1)top1++; mrr+=1/r; } console.log(`${name.padEnd(22)} top-1 ${top1}/${qs.length}   MRR ${(mrr/qs.length).toFixed(2)}`); }
score('keyword overlap', q=>{const w=words(q); return docs.map((d,i)=>[i,[...words(d)].filter(x=>w.has(x)).length]).sort((a,b)=>b[1]-a[1]).map(x=>x[0]);});
const t0=Date.now(); const D=await emb(docs); const Q=await emb(qs.map(q=>q[0])); const ms=Date.now()-t0;
console.log('dim', D[0].length, `${ms} ms for ${docs.length+qs.length} texts`);
score('Bonsai embeddings', q=>{const v=Q[qs.findIndex(x=>x[0]===q)]; return docs.map((d,i)=>[i,cos(v,D[i])]).sort((a,b)=>b[1]-a[1]).map(x=>x[0]);});
const sims=D.flatMap((a,i)=>D.slice(i+1).map(b=>cos(a,b))); console.log('avg doc-doc cosine', (sims.reduce((s,x)=>s+x,0)/sims.length).toFixed(3), '(near 1.0 = everything looks alike)');
