// /src/lib/placeholders.js
//
// Lightweight placeholder content used when no sealed pack has been uploaded yet.
// Provides deterministic host/guest triplets for each round so the game
// remains playable during development/demo sessions.

function makeItem(question, correct, wrong, subject = "Placeholder") {
  const alt = String(wrong || "").trim() || "Incorrect";
  return {
    subject,
    difficulty_tier: "placeholder",
    question,
    correct_answer: correct,
    distractors: {
      easy: alt,
      medium: alt,
      hard: alt,
    },
  };
}

const PLACEHOLDER_ROUNDS = [
  {
    host: [
      makeItem("In the sentence 'She sang happily', which part of speech is 'happily'?", "Adverb", "Adjective", "Grammar"),
      makeItem("Which planet is known as the Red Planet?", "Mars", "Venus", "Space"),
      makeItem("What is 9 + 6?", "15", "18", "Maths"),
    ],
    guest: [
      makeItem("Which instrument has keys, pedals, and strings?", "Piano", "Flute", "Music"),
      makeItem("What color do you get when you mix blue and yellow?", "Green", "Purple", "Art"),
      makeItem("In fairy tales, who famously wore glass slippers?", "Cinderella", "Snow White", "Stories"),
    ],
  },
  {
    host: [
      makeItem("What gas do plants absorb from the air?", "Carbon dioxide", "Oxygen", "Science"),
      makeItem("Which continent is home to the Amazon rainforest?", "South America", "Africa", "Geography"),
      makeItem("How many days are in a leap year?", "366", "364", "Calendar"),
    ],
    guest: [
      makeItem("Which sport is played at Wimbledon?", "Tennis", "Cricket", "Sport"),
      makeItem("What is the capital city of Japan?", "Tokyo", "Kyoto", "Geography"),
      makeItem("What do bees collect from flowers?", "Nectar", "Pollen", "Nature"),
    ],
  },
  {
    host: [
      makeItem("Which element's chemical symbol is 'Fe'?", "Iron", "Fluorine", "Chemistry"),
      makeItem("Who painted the Mona Lisa?", "Leonardo da Vinci", "Michelangelo", "Art"),
      makeItem("How many sides does a hexagon have?", "6", "8", "Shapes"),
    ],
    guest: [
      makeItem("Which ocean lies on the east coast of the United States?", "Atlantic", "Pacific", "Geography"),
      makeItem("What is the largest mammal on Earth?", "Blue whale", "African elephant", "Animals"),
      makeItem("Which language is primarily spoken in Brazil?", "Portuguese", "Spanish", "Language"),
    ],
  },
  {
    host: [
      makeItem("Which metal is liquid at room temperature?", "Mercury", "Sodium", "Science"),
      makeItem("In computing, what does 'CPU' stand for?", "Central Processing Unit", "Computer Power Unit", "Technology"),
      makeItem("What is the square root of 81?", "9", "8", "Maths"),
    ],
    guest: [
      makeItem("Which author created Sherlock Holmes?", "Arthur Conan Doyle", "Agatha Christie", "Literature"),
      makeItem("Which gas makes up most of the Earth's atmosphere?", "Nitrogen", "Hydrogen", "Science"),
      makeItem("Which country gifted the Statue of Liberty to the USA?", "France", "Canada", "History"),
    ],
  },
  {
    host: [
      makeItem("Which scientist developed the theory of general relativity?", "Albert Einstein", "Isaac Newton", "Science"),
      makeItem("What is the largest internal organ in the human body?", "Liver", "Lungs", "Biology"),
      makeItem("How many keys are on a standard piano?", "88", "72", "Music"),
    ],
    guest: [
      makeItem("Which desert covers much of northern Africa?", "Sahara", "Gobi", "Geography"),
      makeItem("In Greek mythology, who is the god of the sea?", "Poseidon", "Apollo", "Mythology"),
      makeItem("What is the freezing point of water in Celsius?", "0", "-5", "Science"),
    ],
  },
];

const FALLBACK_ITEM = makeItem("Placeholder question", "Correct", "Wrong");

function clone(item) {
  return JSON.parse(JSON.stringify(item || FALLBACK_ITEM));
}

function padItems(list = []) {
  const pool = Array.isArray(list) ? list.slice(0, 3) : [];
  const normalised = pool.map((entry) => clone(entry));
  while (normalised.length < 3) normalised.push(clone(FALLBACK_ITEM));
  return normalised;
}

export function hasUsableItems(list) {
  if (!Array.isArray(list)) return false;
  return list.some((item) => {
    const question = String(item?.question || "").trim();
    return question && question !== "<empty>";
  });
}

export function getPlaceholderItems(role, round) {
  const index = Math.max(0, Math.min(PLACEHOLDER_ROUNDS.length - 1, Number(round) - 1 || 0));
  const entry = PLACEHOLDER_ROUNDS[index] || PLACEHOLDER_ROUNDS[0];
  const items = role === "guest" ? entry.guest : entry.host;
  return padItems(items);
}

export default { getPlaceholderItems, hasUsableItems };
