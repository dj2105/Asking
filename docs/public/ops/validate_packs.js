#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

function must(c,m){ if(!c) throw new Error(m); }
function hasBlank(s){ return typeof s==="string" && s.includes("___"); }
function isRoom(s){ return /^[A-Z]{3}$/.test(s||""); }

function validateMaths(file){
  const p = JSON.parse(fs.readFileSync(file,"utf8"));
  must(p.version==="jemima-maths-chain-1","Maths: wrong version");
  const m=p.maths||{};
  must(Array.isArray(m.beats)&&m.beats.length===5,"Maths: need 5 beats");
  must(Array.isArray(m.reveals)&&m.reveals.length===5,"Maths: need 5 reveals");
  const totals=m.reveals.filter(r=>r.type==="total").length;
  must(totals===2,"Maths: must have exactly 2 total reveals");
  must(hasBlank(m.question),"Maths: question must include ___");
  must(Number.isInteger(m.answer),"Maths: answer must be integer");
  const r=p.results||{};
  must(typeof r.passage==="string"&&r.passage.trim(),"Results passage missing");
  must(r.finalAnswer&&Number.isInteger(r.finalAnswer.value),"Results finalAnswer integer missing");
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