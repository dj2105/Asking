#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

function must(c,m){ if(!c) throw new Error(m); }
function hasBlank(s){ return typeof s==="string" && s.includes("___"); }
function isRoom(s){ return /^[A-Z]{3}$/.test(s||""); }

function validateMaths(file){
  const p = JSON.parse(fs.readFileSync(file,"utf8"));
  must(p.version==="jemima-maths-chain-2","Maths: wrong version");
  const m=p.maths||{};
  must(Array.isArray(m.clues)&&m.clues.length===5,"Maths: need 5 clues");
  m.clues.forEach((clue,idx)=>{
    must(typeof clue==="string"&&clue.trim(),`Maths clue ${idx+1} missing`);
  });
  must(Array.isArray(m.reveals)&&m.reveals.length===5,"Maths: need 5 reveals");
  m.reveals.forEach((reveal,idx)=>{
    if(typeof reveal==="string"){
      must(reveal.trim(),`Maths reveal ${idx+1} empty`);
    }else if(typeof reveal==="object"&&reveal!==null){
      const txt=reveal.prompt||reveal.text||reveal.value||"";
      must(typeof txt==="string"&&txt.trim(),`Maths reveal ${idx+1} missing text`);
    }else{
      must(false,`Maths reveal ${idx+1} invalid`);
    }
  });
  must(typeof m.question==="string"&&m.question.trim(),"Maths question missing");
  must(Number.isInteger(m.answer),"Maths answer must be integer");
  must(isRoom(p.meta?.roomCode),"Maths: meta.roomCode invalid");
}

function validateQuestions(file){
  const p = JSON.parse(fs.readFileSync(file,"utf8"));
  must(p.version==="jemima-questions-1","Questions: wrong version");
  must(isRoom(p.meta?.roomCode),"Questions: meta.roomCode invalid");
  const rounds=p.rounds||{};
  for(let n=1;n<=5;n++){
    const r=rounds[String(n)];
    must(r,`Questions: missing round ${n}`);
    for(const side of ["hostItems","guestItems"]){
      must(Array.isArray(r[side])&&r[side].length===3,`Round ${n}: need 3 ${side}`);
      for(const it of r[side]){
        must(typeof it.prompt==="string"&&it.prompt.trim(),"Prompt missing");
        must(Array.isArray(it.options)&&it.options.length===2,"Need 2 options");
        must(it.correct==="A"||it.correct==="B","correct must be A or B");
      }
    }
  }
}

const dir = process.argv[2] || "./packs/out";
const files = fs.readdirSync(dir).map(f=>path.join(dir,f));
const maths = files.find(f=>/-maths\.json$/i.test(f));
const qs = files.find(f=>/-questions\.json$/i.test(f));
must(maths&&qs,"Expected both <ROOM>-maths.json and <ROOM>-questions.json in "+dir);
validateMaths(maths); validateQuestions(qs);
console.log("✅ OK:", path.basename(maths),"and",path.basename(qs));

