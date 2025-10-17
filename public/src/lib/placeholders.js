// /src/lib/placeholders.js
//
// Local fallback questions used when no sealed pack has been uploaded.
// Provides deterministic, themed items for both roles across five rounds.

const clone = (value) => JSON.parse(JSON.stringify(value));

const makeItem = (subject, difficulty_tier, question, correct_answer, distractors) => ({
  subject,
  difficulty_tier,
  question,
  correct_answer,
  distractors,
});

const ROUND_FALLBACKS = {
  1: {
    host: [
      makeItem(
        "Architecture",
        "pub",
        "Which city is home to the cathedral known as La Sagrada Família?",
        "Barcelona",
        { easy: "Madrid", medium: "Valencia", hard: "Seville" }
      ),
      makeItem(
        "Botany",
        "pub",
        "Which gas do plants primarily absorb during photosynthesis?",
        "Carbon dioxide",
        { easy: "Nitrogen", medium: "Oxygen", hard: "Helium" }
      ),
      makeItem(
        "Modern Music",
        "pub",
        "Which British singer released the album ‘25’ in 2015?",
        "Adele",
        { easy: "Ed Sheeran", medium: "Jess Glynne", hard: "Florence Welch" }
      ),
    ],
    guest: [
      makeItem(
        "Irish Geography",
        "pub",
        "Which river flows through the centre of Dublin?",
        "River Liffey",
        { easy: "River Clyde", medium: "River Boyne", hard: "River Lee" }
      ),
      makeItem(
        "Astronomy",
        "pub",
        "Which planet hosts the Great Red Spot storm?",
        "Jupiter",
        { easy: "Mercury", medium: "Saturn", hard: "Neptune" }
      ),
      makeItem(
        "Culinary Traditions",
        "pub",
        "Which herb is essential in classic pesto Genovese?",
        "Basil",
        { easy: "Coriander", medium: "Parsley", hard: "Oregano" }
      ),
    ],
  },
  2: {
    host: [
      makeItem(
        "Physics",
        "enthusiast",
        "Which law states that current is proportional to voltage in a conductor?",
        "Ohm’s law",
        { easy: "Hooke’s law", medium: "Faraday’s law", hard: "Gauss’s law" }
      ),
      makeItem(
        "British History",
        "enthusiast",
        "Which Tudor monarch founded the Church of England?",
        "Henry VIII",
        { easy: "Elizabeth I", medium: "Mary I", hard: "Edward VI" }
      ),
      makeItem(
        "African Geography",
        "enthusiast",
        "Which African lake feeds the Nile via the White Nile?",
        "Lake Victoria",
        { easy: "Lake Tanganyika", medium: "Lake Malawi", hard: "Lake Albert" }
      ),
    ],
    guest: [
      makeItem(
        "Chemistry",
        "enthusiast",
        "What is the chemical symbol for the element tungsten?",
        "W",
        { easy: "Tu", medium: "Tg", hard: "Ta" }
      ),
      makeItem(
        "Art History",
        "enthusiast",
        "Which artist painted ‘Starry Night Over the Rhône’?",
        "Vincent van Gogh",
        { easy: "Claude Monet", medium: "Paul Gauguin", hard: "Henri Rousseau" }
      ),
      makeItem(
        "European History",
        "enthusiast",
        "Which treaty ended the Thirty Years’ War in 1648?",
        "Treaty of Westphalia",
        { easy: "Treaty of Versailles", medium: "Treaty of Utrecht", hard: "Peace of Augsburg" }
      ),
    ],
  },
  3: {
    host: [
      makeItem(
        "Astronomy",
        "specialist",
        "What is the closest star system to the Sun?",
        "Alpha Centauri",
        { easy: "Betelgeuse", medium: "Sirius", hard: "Barnard’s Star" }
      ),
      makeItem(
        "Mathematics",
        "specialist",
        "Which conjecture claims every even integer greater than two is the sum of two primes?",
        "Goldbach’s conjecture",
        { easy: "Fermat’s Last Theorem", medium: "Riemann Hypothesis", hard: "Twin Prime Conjecture" }
      ),
      makeItem(
        "Cell Biology",
        "specialist",
        "Which enzyme unwinds DNA during replication?",
        "Helicase",
        { easy: "Amylase", medium: "DNA polymerase", hard: "DNA ligase" }
      ),
    ],
    guest: [
      makeItem(
        "Literature",
        "specialist",
        "Which poet wrote ‘The Waste Land’?",
        "T. S. Eliot",
        { easy: "W. B. Yeats", medium: "Ezra Pound", hard: "Philip Larkin" }
      ),
      makeItem(
        "Geology",
        "specialist",
        "Which scale replaced the Richter scale for measuring large earthquake magnitudes?",
        "Moment magnitude scale",
        { easy: "Saffir–Simpson scale", medium: "Mercalli intensity scale", hard: "Richter scale" }
      ),
      makeItem(
        "Music Theory",
        "specialist",
        "What term describes a change of key within a composition?",
        "Modulation",
        { easy: "Syncopation", medium: "Cadence", hard: "Hemiola" }
      ),
    ],
  },
  4: {
    host: [
      makeItem(
        "Particle Physics",
        "specialist",
        "Which particle mediates the strong nuclear force in quantum chromodynamics?",
        "Gluon",
        { easy: "Photon", medium: "W boson", hard: "Z boson" }
      ),
      makeItem(
        "History of Science",
        "specialist",
        "Who authored ‘De revolutionibus orbium coelestium’?",
        "Nicolaus Copernicus",
        { easy: "Galileo Galilei", medium: "Johannes Kepler", hard: "Tycho Brahe" }
      ),
      makeItem(
        "Computer Science",
        "specialist",
        "Which algorithm is widely used to find single-source shortest paths on graphs without negative edges?",
        "Dijkstra’s algorithm",
        { easy: "Quicksort", medium: "Kruskal’s algorithm", hard: "Prim’s algorithm" }
      ),
    ],
    guest: [
      makeItem(
        "Physiology",
        "specialist",
        "Which hormone is produced by the pancreas to lower blood glucose levels?",
        "Insulin",
        { easy: "Adrenaline", medium: "Glucagon", hard: "Cortisol" }
      ),
      makeItem(
        "Astronomy",
        "specialist",
        "What term describes a star that briefly brightens because of surface hydrogen fusion on a white dwarf?",
        "Nova",
        { easy: "Quasar", medium: "Supernova", hard: "Pulsar" }
      ),
      makeItem(
        "Political History",
        "specialist",
        "Which 1641 document challenged Charles I with a list of parliamentary grievances?",
        "Grand Remonstrance",
        { easy: "Bill of Rights", medium: "Petition of Right", hard: "Instrument of Government" }
      ),
    ],
  },
  5: {
    host: [
      makeItem(
        "Quantum Mechanics",
        "specialist",
        "Which principle limits simultaneous precision of position and momentum measurements?",
        "Heisenberg uncertainty principle",
        { easy: "Pauli exclusion principle", medium: "Equivalence principle", hard: "Noether’s theorem" }
      ),
      makeItem(
        "Number Theory",
        "specialist",
        "What is the analytic continuation of the Riemann zeta function at −1?",
        "−1/12",
        { easy: "0", medium: "1/6", hard: "−1/2" }
      ),
      makeItem(
        "Linguistics",
        "specialist",
        "Which language family does Basque belong to?",
        "Language isolate",
        { easy: "Romance", medium: "Celtic", hard: "Uralic" }
      ),
    ],
    guest: [
      makeItem(
        "Economics",
        "specialist",
        "Which economist popularised the term ‘creative destruction’?",
        "Joseph Schumpeter",
        { easy: "Adam Smith", medium: "John Maynard Keynes", hard: "Friedrich Hayek" }
      ),
      makeItem(
        "Art Movements",
        "specialist",
        "Which movement published the 1938 manifesto ‘Towards a Free Revolutionary Art’?",
        "Surrealism",
        { easy: "Impressionism", medium: "Constructivism", hard: "Dadaism" }
      ),
      makeItem(
        "Spaceflight",
        "specialist",
        "What was the first crewed mission to land on the Moon?",
        "Apollo 11",
        { easy: "Apollo 8", medium: "Apollo 12", hard: "Soyuz 1" }
      ),
    ],
  },
};

const DEFAULT_TRIPLET = ROUND_FALLBACKS[1].host;

function ensureTriplet(list = DEFAULT_TRIPLET) {
  const items = Array.isArray(list) && list.length ? list : DEFAULT_TRIPLET;
  const out = [];
  for (let i = 0; i < 3; i += 1) {
    out.push(clone(items[i % items.length]));
  }
  return out;
}

export function getFallbackItemsForRound(round, role) {
  const key = Number.isFinite(Number(round)) ? Number(round) : 1;
  const entry = ROUND_FALLBACKS[key] || ROUND_FALLBACKS[1];
  const triplet = role === "guest" ? entry.guest : entry.host;
  return ensureTriplet(triplet);
}

export default { getFallbackItemsForRound };

