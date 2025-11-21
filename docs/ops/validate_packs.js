#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

function must(c,m){ if(!c) throw new Error(m); }
function hasBlank(s){ return typeof s==="string" && s.includes("___"); }
function isRoom(s){ return /^[A-Z]{3}$/.test(s||""); }

function validateMaths(file){
  const p = JSON.parse(fs.readFileSync(file,"utf8"));
  must(p.version==="jemima-maths-timeline-1","Maths: wrong version");
  const games = Array.isArray(p.games)&&p.games.length ? p.games : [p.maths||{}];
  must(games.length>0,"Maths: missing maths content");
  games.forEach((m,gameIdx)=>{
    must(Array.isArray(m.events)&&m.events.length===5,`Maths game ${gameIdx+1}: need 5 events`);
    let last=0; let total=0;
    m.events.forEach((evt,idx)=>{
      must(evt&&typeof evt==="object",`Maths game ${gameIdx+1}: event ${idx+1} missing`);
      must(typeof evt.prompt==="string"&&evt.prompt.trim(),`Maths game ${gameIdx+1}: event ${idx+1} prompt missing`);
      must(Number.isInteger(evt.year)&&evt.year>=1&&evt.year<=2025,`Maths game ${gameIdx+1}: event ${idx+1} year invalid`);
      must(idx===0||evt.year>last,`Maths game ${gameIdx+1}: events must be chronological`);
      last=evt.year; total+=evt.year;
    });
    must(!m.total||m.total===total,`Maths game ${gameIdx+1}: total must match summed years`);
    must(typeof m.question==="string"&&m.question.trim(),`Maths game ${gameIdx+1}: question missing`);
    if(m.scoring){
      must(Number.isInteger(m.scoring.targetTotal||total),`Maths game ${gameIdx+1}: scoring targetTotal missing`);
    }
  });
  must(isRoom(p.meta?.roomCode),"Maths: meta.roomCode invalid");
}

function validateQuestions(file){
  const p = JSON.parse(fs.readFileSync(file,"utf8"));
  must(["jemima-questionpack-1","jemima-questions-1"].includes(p.version),"Questions: wrong version");
  must(isRoom(p.meta?.roomCode),"Questions: meta.roomCode invalid");
  const roundsRaw = Array.isArray(p.rounds) ? p.rounds : Object.values(p.rounds||{});
  must(roundsRaw.length===5,"Questions: need 5 rounds");
  roundsRaw.forEach((r,idx)=>{
    must(r,`Questions: missing round ${idx+1}`);
    for(const side of ["hostItems","guestItems"]){
      must(Array.isArray(r[side])&&r[side].length===3,`Round ${idx+1}: need 3 ${side}`);
      for(const it of r[side]){
        const isAB = typeof it.prompt==="string"&&Array.isArray(it.options);
        const isQAPack = typeof it.question==="string"&&it.question.trim()&&it.distractors;
        must(isAB||isQAPack,"Question item shape invalid");
        if(isAB){
          must(it.prompt.trim(),"Prompt missing");
          must(it.options.length===2,"Need 2 options");
          must(it.correct==="A"||it.correct==="B","correct must be A or B");
        }else{
          must(typeof it.correct_answer==="string"&&it.correct_answer.trim(),"Correct answer missing");
          const d=it.distractors||{};
          must(d.easy&&d.medium&&d.hard,"Distractors missing");
        }
      }
    }
  });
}

const dir = process.argv[2] || "./packs/out";
const files = fs.readdirSync(dir).map(f=>path.join(dir,f));
const maths = files.find(f=>/-maths\.json$/i.test(f));
const qs = files.find(f=>/-questions\.json$/i.test(f));
must(maths&&qs,"Expected both <ROOM>-maths.json and <ROOM>-questions.json in "+dir);
validateMaths(maths); validateQuestions(qs);
console.log("✅ OK:", path.basename(maths),"and",path.basename(qs));

