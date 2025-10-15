import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const responsesPath = resolve('docs/playtest-responses.csv');
const packPath = resolve('docs/test-pack-refresh.json');

const csv = readFileSync(responsesPath, 'utf8').trim();
const lines = csv.split('\n');
const header = lines.shift().split(',');

const pack = JSON.parse(readFileSync(packPath, 'utf8'));
const itemsById = new Map(pack.items.map((item) => [item.id, item]));

const tierStats = new Map();
const questionStats = new Map();

const ensureTier = (tier) => {
  if (!tierStats.has(tier)) {
    tierStats.set(tier, {
      attempts: 0,
      correct: 0,
      totalTime: 0,
      totalConfidence: 0,
      incorrectByDistractor: new Map()
    });
  }
  return tierStats.get(tier);
};

const ensureQuestion = (id) => {
  if (!questionStats.has(id)) {
    questionStats.set(id, {
      attempts: 0,
      correct: 0,
      incorrect: 0,
      distractorHits: new Map()
    });
  }
  return questionStats.get(id);
};

for (const line of lines) {
  if (!line.trim()) continue;
  const values = line.split(',');
  if (values.length !== header.length) {
    throw new Error(`Malformed row: ${line}`);
  }
  const record = Object.fromEntries(header.map((key, index) => [key, values[index]]));
  const item = itemsById.get(record.questionId);
  if (!item) {
    console.warn(`Unknown question id ${record.questionId}`);
    continue;
  }
  const tier = item.difficulty_tier;
  const stats = ensureTier(tier);
  const qStats = ensureQuestion(item.id);

  const timeTaken = Number.parseInt(record.timeTakenSeconds, 10);
  const confidence = Number.parseInt(record.confidence, 10);
  const normalisedAnswer = record.answerChoice.trim();
  const isCorrect = normalisedAnswer === item.correct_answer;

  stats.attempts += 1;
  stats.totalTime += timeTaken;
  stats.totalConfidence += confidence;

  qStats.attempts += 1;

  if (isCorrect) {
    stats.correct += 1;
    qStats.correct += 1;
  } else {
    stats.incorrectByDistractor.set(
      normalisedAnswer,
      (stats.incorrectByDistractor.get(normalisedAnswer) ?? 0) + 1
    );
    qStats.incorrect += 1;
    qStats.distractorHits.set(
      normalisedAnswer,
      (qStats.distractorHits.get(normalisedAnswer) ?? 0) + 1
    );
  }
}

const round = (value, places = 2) =>
  Number.parseFloat(value.toFixed(places));

console.log('Tier summary');
for (const [tier, stats] of tierStats.entries()) {
  const accuracy = stats.attempts ? stats.correct / stats.attempts : 0;
  const avgTime = stats.attempts ? stats.totalTime / stats.attempts : 0;
  const avgConfidence = stats.attempts ? stats.totalConfidence / stats.attempts : 0;
  console.log(`- ${tier}: accuracy=${round(accuracy * 100)}%, avgTime=${round(avgTime)}s, avgConfidence=${round(avgConfidence, 1)}`);
  if (stats.incorrectByDistractor.size) {
    console.log('  Common distractors:');
    for (const [option, count] of stats.incorrectByDistractor.entries()) {
      console.log(`    • ${option}: ${count}`);
    }
  }
}

console.log('\nQuestion-level breakdown');
for (const [id, stats] of questionStats.entries()) {
  const accuracy = stats.attempts ? stats.correct / stats.attempts : 0;
  console.log(`- ${id}: attempts=${stats.attempts}, accuracy=${round(accuracy * 100)}%`);
  if (stats.distractorHits.size) {
    console.log('  Distractor hits:');
    for (const [option, count] of stats.distractorHits.entries()) {
      console.log(`    • ${option}: ${count}`);
    }
  }
}
