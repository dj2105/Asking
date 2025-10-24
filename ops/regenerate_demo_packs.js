const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function isoNow() {
  return new Date().toISOString();
}

function withIntegrity(data) {
  const { integrity, ...rest } = data;
  const canonical = JSON.stringify(rest);
  const checksum = crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
  return {
    ...rest,
    integrity: {
      checksum,
      verified: true,
    },
  };
}

function writePack(filename, data) {
  const finalData = withIntegrity(data);
  const outPath = path.join(__dirname, '..', 'packs', 'out', filename);
  fs.writeFileSync(outPath, JSON.stringify(finalData, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${filename}`);
}

function mathsPack(code, overrides = {}) {
  const generatedAt = overrides.generatedAt || isoNow();
  return {
    version: 'jemima-maths-1',
    meta: {
      roomCode: code,
      generatedAt,
      hostUid: 'demo-host',
      guestUid: 'demo-guest',
    },
    maths: overrides.maths,
  };
}

function questionsPack(code, overrides = {}) {
  const generatedAt = overrides.generatedAt || isoNow();
  return {
    version: 'jemima-questionpack-1',
    meta: {
      roomCode: code,
      generatedAt,
      hostUid: 'demo-host',
      guestUid: 'demo-guest',
    },
    rounds: overrides.rounds,
  };
}

function buildPacks() {
  const packs = [];

  packs.push({
    filename: 'DOI-maths.json',
    data: mathsPack('DOI', {
      generatedAt: '2025-01-12T12:00:00.000Z',
      maths: {
        location: 'Rooftop herb garden',
        beats: [
          'I clipped eight sprigs of rosemary for tonight\'s stew before guests arrived.',
          'Two neighbours came up early, so I doubled the bundle to share the aroma.',
          'Before dinner I gifted five sprigs so they could season their roasts.',
          'Finally I hung one sprig to dry for tomorrow\'s roast.',
        ],
        questions: [
          'How many rosemary sprigs are left for cooking? ___',
          'What was the largest number of sprigs I held at once? ___',
        ],
        answers: [
          10,
          16,
        ],
      },
    }),
  });

  packs.push({
    filename: 'DOI-questions.json',
    data: questionsPack('DOI', {
      generatedAt: '2025-01-12T12:00:00.000Z',
      rounds: [
        {
          round: 1,
          hostItems: [
            {
              subject: 'astronomy',
              difficulty_tier: 'pub',
              question: 'Which planet sports the storm called the Great Red Spot?',
              correct_answer: 'Jupiter',
              distractors: {
                easy: 'Mars',
                medium: 'Saturn',
                hard: 'Neptune',
              },
            },
            {
              subject: 'music',
              difficulty_tier: 'pub',
              question: 'Which Beatle wrote the song “Here Comes the Sun”?',
              correct_answer: 'George Harrison',
              distractors: {
                easy: 'John Lennon',
                medium: 'Paul McCartney',
                hard: 'Ringo Starr',
              },
            },
            {
              subject: 'geography',
              difficulty_tier: 'pub',
              question: 'Which river flows through the city of Budapest?',
              correct_answer: 'The Danube',
              distractors: {
                easy: 'The Rhine',
                medium: 'The Vistula',
                hard: 'The Dniester',
              },
            },
          ],
          guestItems: [
            {
              subject: 'film',
              difficulty_tier: 'pub',
              question: 'Who directed the movie “Jurassic Park”?',
              correct_answer: 'Steven Spielberg',
              distractors: {
                easy: 'George Lucas',
                medium: 'James Cameron',
                hard: 'Ridley Scott',
              },
            },
            {
              subject: 'literature',
              difficulty_tier: 'pub',
              question: 'Which novel opens with the line “Call me Ishmael”?',
              correct_answer: 'Moby-Dick',
              distractors: {
                easy: 'Treasure Island',
                medium: 'Twenty Thousand Leagues Under the Sea',
                hard: 'The Old Man and the Sea',
              },
            },
            {
              subject: 'games',
              difficulty_tier: 'pub',
              question: 'Which board game tasks players with building rail routes across maps?',
              correct_answer: 'Ticket to Ride',
              distractors: {
                easy: 'Monopoly',
                medium: 'Power Grid',
                hard: 'Railways of the World',
              },
            },
          ],
        },
        {
          round: 2,
          hostItems: [
            {
              subject: 'history',
              difficulty_tier: 'pub',
              question: 'Which empire built the city of Machu Picchu?',
              correct_answer: 'The Inca Empire',
              distractors: {
                easy: 'The Aztec Empire',
                medium: 'The Maya Civilization',
                hard: 'The Chavín Culture',
              },
            },
            {
              subject: 'technology',
              difficulty_tier: 'pub',
              question: 'What does the “CPU” in computing stand for?',
              correct_answer: 'Central Processing Unit',
              distractors: {
                easy: 'Computer Power Unit',
                medium: 'Core Processing Utility',
                hard: 'Central Program Unit',
              },
            },
            {
              subject: 'art',
              difficulty_tier: 'pub',
              question: 'Which painter is famous for the work “Girl with a Pearl Earring”?',
              correct_answer: 'Johannes Vermeer',
              distractors: {
                easy: 'Claude Monet',
                medium: 'Jan van Eyck',
                hard: 'Frans Hals',
              },
            },
          ],
          guestItems: [
            {
              subject: 'nature',
              difficulty_tier: 'pub',
              question: 'What is the term for animals active during twilight?',
              correct_answer: 'Crepuscular',
              distractors: {
                easy: 'Nocturnal',
                medium: 'Diurnal',
                hard: 'Matutinal',
              },
            },
            {
              subject: 'sports',
              difficulty_tier: 'pub',
              question: 'In tennis, what is the term for a score of zero?',
              correct_answer: 'Love',
              distractors: {
                easy: 'Blank',
                medium: 'Nil',
                hard: 'Scratch',
              },
            },
            {
              subject: 'television',
              difficulty_tier: 'pub',
              question: 'Which series features the fictional paper company Dunder Mifflin?',
              correct_answer: 'The Office (U.S.)',
              distractors: {
                easy: 'Parks and Recreation',
                medium: 'Brooklyn Nine-Nine',
                hard: '30 Rock',
              },
            },
          ],
        },
        {
          round: 3,
          hostItems: [
            {
              subject: 'science',
              difficulty_tier: 'enthusiast',
              question: 'Which element is named after the planet Uranus?',
              correct_answer: 'Uranium',
              distractors: {
                easy: 'Neptunium',
                medium: 'Plutonium',
                hard: 'Cerium',
              },
            },
            {
              subject: 'culinary',
              difficulty_tier: 'pub',
              question: 'Which Italian cheese is traditionally shaved over Caesar salad?',
              correct_answer: 'Parmigiano-Reggiano',
              distractors: {
                easy: 'Mozzarella',
                medium: 'Grana Padano',
                hard: 'Pecorino Romano',
              },
            },
            {
              subject: 'travel',
              difficulty_tier: 'pub',
              question: 'Which city is served by Hartsfield-Jackson International Airport?',
              correct_answer: 'Atlanta',
              distractors: {
                easy: 'Chicago',
                medium: 'Dallas',
                hard: 'Charlotte',
              },
            },
          ],
          guestItems: [
            {
              subject: 'mythology',
              difficulty_tier: 'pub',
              question: 'Which Greek hero slew the Minotaur?',
              correct_answer: 'Theseus',
              distractors: {
                easy: 'Hercules',
                medium: 'Perseus',
                hard: 'Bellerophon',
              },
            },
            {
              subject: 'design',
              difficulty_tier: 'pub',
              question: 'What colour is associated with the Pantone number 17-5104 “Ultimate Gray”?',
              correct_answer: 'Gray',
              distractors: {
                easy: 'Blue',
                medium: 'Charcoal',
                hard: 'Silver',
              },
            },
            {
              subject: 'theatre',
              difficulty_tier: 'enthusiast',
              question: 'Which playwright created “The Curious Incident of the Dog in the Night-Time”?',
              correct_answer: 'Simon Stephens',
              distractors: {
                easy: 'Patrick Ness',
                medium: 'Nick Stafford',
                hard: 'Lee Hall',
              },
            },
          ],
        },
        {
          round: 4,
          hostItems: [
            {
              subject: 'language',
              difficulty_tier: 'pub',
              question: 'Which language gave English the word “bungalow”?',
              correct_answer: 'Hindi',
              distractors: {
                easy: 'Malay',
                medium: 'Gujarati',
                hard: 'Urdu',
              },
            },
            {
              subject: 'fashion',
              difficulty_tier: 'pub',
              question: 'Which designer is synonymous with the wrap dress?',
              correct_answer: 'Diane von Fürstenberg',
              distractors: {
                easy: 'Donatella Versace',
                medium: 'Stella McCartney',
                hard: 'Carolina Herrera',
              },
            },
            {
              subject: 'spaceflight',
              difficulty_tier: 'enthusiast',
              question: 'Which mission carried the first reusable Space Shuttle orbiter?',
              correct_answer: 'STS-1',
              distractors: {
                easy: 'Apollo 11',
                medium: 'STS-41-B',
                hard: 'STS-5',
              },
            },
          ],
          guestItems: [
            {
              subject: 'architecture',
              difficulty_tier: 'pub',
              question: 'Which architect designed the Guggenheim Museum in Bilbao?',
              correct_answer: 'Frank Gehry',
              distractors: {
                easy: 'I. M. Pei',
                medium: 'Zaha Hadid',
                hard: 'Santiago Calatrava',
              },
            },
            {
              subject: 'comics',
              difficulty_tier: 'pub',
              question: 'What is the civilian name of Black Panther?',
              correct_answer: 'T’Challa',
              distractors: {
                easy: 'M’Baku',
                medium: 'Shuri',
                hard: 'N\'Jadaka',
              },
            },
            {
              subject: 'science',
              difficulty_tier: 'enthusiast',
              question: 'Which scientist gave us the three laws of planetary motion?',
              correct_answer: 'Johannes Kepler',
              distractors: {
                easy: 'Isaac Newton',
                medium: 'Galileo Galilei',
                hard: 'Tycho Brahe',
              },
            },
          ],
        },
        {
          round: 5,
          hostItems: [
            {
              subject: 'television',
              difficulty_tier: 'pub',
              question: 'Which cooking competition crowns the “Star Baker”?',
              correct_answer: 'The Great British Bake Off',
              distractors: {
                easy: 'Top Chef',
                medium: 'MasterChef',
                hard: 'The Final Table',
              },
            },
            {
              subject: 'literature',
              difficulty_tier: 'enthusiast',
              question: 'Who penned the Discworld novel “Guards! Guards!”?',
              correct_answer: 'Terry Pratchett',
              distractors: {
                easy: 'Douglas Adams',
                medium: 'Neil Gaiman',
                hard: 'Jasper Fforde',
              },
            },
            {
              subject: 'geography',
              difficulty_tier: 'pub',
              question: 'Which African country is nicknamed the “Rainbow Nation”?',
              correct_answer: 'South Africa',
              distractors: {
                easy: 'Kenya',
                medium: 'Namibia',
                hard: 'Botswana',
              },
            },
          ],
          guestItems: [
            {
              subject: 'history',
              difficulty_tier: 'enthusiast',
              question: 'Which treaty ended World War I between Germany and the Allies?',
              correct_answer: 'Treaty of Versailles',
              distractors: {
                easy: 'Treaty of Paris',
                medium: 'Treaty of Trianon',
                hard: 'Treaty of Brest-Litovsk',
              },
            },
            {
              subject: 'music',
              difficulty_tier: 'pub',
              question: 'Which singer released the album “Future Nostalgia”?',
              correct_answer: 'Dua Lipa',
              distractors: {
                easy: 'Lorde',
                medium: 'Charli XCX',
                hard: 'Caroline Polachek',
              },
            },
            {
              subject: 'science',
              difficulty_tier: 'specialist',
              question: 'Which particle carries the strong nuclear force between quarks?',
              correct_answer: 'Gluon',
              distractors: {
                easy: 'Photon',
                medium: 'W boson',
                hard: 'Higgs boson',
              },
            },
          ],
        },
      ],
    }),
  });

  packs.push({
    filename: 'FKH-maths.json',
    data: mathsPack('FKH', {
      generatedAt: '2025-01-15T09:30:00.000Z',
      maths: {
        location: 'Community pottery studio',
        beats: [
          'I stacked eight clay blocks on the studio table before class.',
          'A kiln delivery rolled in four more blocks to add to the stack.',
          'Midway through, we recycled five blocks into slip for glazing.',
          'Before locking up I shaped two new blocks from the leftover scraps.',
        ],
        questions: [
          'How many clay blocks remain for tomorrow\'s class? ___',
          'What was the highest number of clay blocks on the table today? ___',
        ],
        answers: [
          9,
          12,
        ],
      },
    }),
  });

  packs.push({
    filename: 'FKH-questions.json',
    data: questionsPack('FKH', {
      generatedAt: '2025-01-15T09:30:00.000Z',
      rounds: [
        {
          round: 1,
          hostItems: [
            {
              subject: 'space',
              difficulty_tier: 'pub',
              question: 'Which planet completes an orbit of the Sun in about 88 Earth days?',
              correct_answer: 'Mercury',
              distractors: {
                easy: 'Venus',
                medium: 'Mars',
                hard: 'Ceres',
              },
            },
            {
              subject: 'film',
              difficulty_tier: 'pub',
              question: 'Which actor voiced Woody in “Toy Story”?',
              correct_answer: 'Tom Hanks',
              distractors: {
                easy: 'Tim Allen',
                medium: 'Billy Crystal',
                hard: 'John Goodman',
              },
            },
            {
              subject: 'food',
              difficulty_tier: 'pub',
              question: 'Which spice gives paella its golden colour?',
              correct_answer: 'Saffron',
              distractors: {
                easy: 'Turmeric',
                medium: 'Paprika',
                hard: 'Annatto',
              },
            },
          ],
          guestItems: [
            {
              subject: 'literature',
              difficulty_tier: 'pub',
              question: 'Who wrote the novel “Beloved”?',
              correct_answer: 'Toni Morrison',
              distractors: {
                easy: 'Alice Walker',
                medium: 'Maya Angelou',
                hard: 'Zora Neale Hurston',
              },
            },
            {
              subject: 'science',
              difficulty_tier: 'enthusiast',
              question: 'What is the chemical symbol for tungsten?',
              correct_answer: 'W',
              distractors: {
                easy: 'Tu',
                medium: 'Tg',
                hard: 'Ta',
              },
            },
            {
              subject: 'geography',
              difficulty_tier: 'pub',
              question: 'Which African lake feeds the Nile River?',
              correct_answer: 'Lake Victoria',
              distractors: {
                easy: 'Lake Tanganyika',
                medium: 'Lake Albert',
                hard: 'Lake Turkana',
              },
            },
          ],
        },
        {
          round: 2,
          hostItems: [
            {
              subject: 'mythology',
              difficulty_tier: 'pub',
              question: 'Which Norse god wields the hammer Mjölnir?',
              correct_answer: 'Thor',
              distractors: {
                easy: 'Odin',
                medium: 'Freyr',
                hard: 'Heimdall',
              },
            },
            {
              subject: 'music',
              difficulty_tier: 'pub',
              question: 'Which duo recorded the album “Random Access Memories”?',
              correct_answer: 'Daft Punk',
              distractors: {
                easy: 'Justice',
                medium: 'Chromeo',
                hard: 'Air',
              },
            },
            {
              subject: 'technology',
              difficulty_tier: 'pub',
              question: 'What does the acronym “URL” stand for?',
              correct_answer: 'Uniform Resource Locator',
              distractors: {
                easy: 'Universal Reference Link',
                medium: 'Unified Resource List',
                hard: 'Universal Resource Locator',
              },
            },
          ],
          guestItems: [
            {
              subject: 'history',
              difficulty_tier: 'pub',
              question: 'Which city hosted the first modern Olympic Games in 1896?',
              correct_answer: 'Athens',
              distractors: {
                easy: 'Paris',
                medium: 'Rome',
                hard: 'St. Louis',
              },
            },
            {
              subject: 'architecture',
              difficulty_tier: 'pub',
              question: 'Which structure is also known as the “Gherkin” in London?',
              correct_answer: '30 St Mary Axe',
              distractors: {
                easy: 'The Shard',
                medium: 'Canary Wharf Tower',
                hard: 'City Hall',
              },
            },
            {
              subject: 'sports',
              difficulty_tier: 'pub',
              question: 'How many players start on the ice for one ice hockey team?',
              correct_answer: 'Six',
              distractors: {
                easy: 'Five',
                medium: 'Seven',
                hard: 'Eight',
              },
            },
          ],
        },
        {
          round: 3,
          hostItems: [
            {
              subject: 'science',
              difficulty_tier: 'enthusiast',
              question: 'Which scientist proposed the uncertainty principle?',
              correct_answer: 'Werner Heisenberg',
              distractors: {
                easy: 'Albert Einstein',
                medium: 'Niels Bohr',
                hard: 'Erwin Schrödinger',
              },
            },
            {
              subject: 'games',
              difficulty_tier: 'pub',
              question: 'Which classic arcade game features ghosts named Blinky, Pinky, Inky, and Clyde?',
              correct_answer: 'Pac-Man',
              distractors: {
                easy: 'Space Invaders',
                medium: 'Ms. Pac-Man',
                hard: 'Dig Dug',
              },
            },
            {
              subject: 'fashion',
              difficulty_tier: 'pub',
              question: 'Which footwear brand popularised Air cushioning?',
              correct_answer: 'Nike',
              distractors: {
                easy: 'Adidas',
                medium: 'Reebok',
                hard: 'New Balance',
              },
            },
          ],
          guestItems: [
            {
              subject: 'film',
              difficulty_tier: 'enthusiast',
              question: 'Which cinematographer is known for “Blade Runner 2049”?',
              correct_answer: 'Roger Deakins',
              distractors: {
                easy: 'Emmanuel Lubezki',
                medium: 'Greig Fraser',
                hard: 'Janusz Kamiński',
              },
            },
            {
              subject: 'food',
              difficulty_tier: 'pub',
              question: 'Which fermented drink is traditionally made with tea, sugar, and SCOBY?',
              correct_answer: 'Kombucha',
              distractors: {
                easy: 'Kvass',
                medium: 'Kefir',
                hard: 'Jun',
              },
            },
            {
              subject: 'literature',
              difficulty_tier: 'enthusiast',
              question: 'Which poet wrote “Do not go gentle into that good night”?',
              correct_answer: 'Dylan Thomas',
              distractors: {
                easy: 'W. B. Yeats',
                medium: 'Philip Larkin',
                hard: 'Seamus Heaney',
              },
            },
          ],
        },
        {
          round: 4,
          hostItems: [
            {
              subject: 'geography',
              difficulty_tier: 'pub',
              question: 'Which desert covers much of northern Africa?',
              correct_answer: 'The Sahara Desert',
              distractors: {
                easy: 'The Kalahari Desert',
                medium: 'The Arabian Desert',
                hard: 'The Nubian Desert',
              },
            },
            {
              subject: 'technology',
              difficulty_tier: 'enthusiast',
              question: 'Which company created the open-source browser engine Chromium?',
              correct_answer: 'Google',
              distractors: {
                easy: 'Mozilla',
                medium: 'Apple',
                hard: 'Opera Software',
              },
            },
            {
              subject: 'culture',
              difficulty_tier: 'pub',
              question: 'Which Japanese garment wraps left side over right for daily wear?',
              correct_answer: 'Kimono',
              distractors: {
                easy: 'Yukata',
                medium: 'Hakama',
                hard: 'Haori',
              },
            },
          ],
          guestItems: [
            {
              subject: 'science',
              difficulty_tier: 'specialist',
              question: 'Which scientist isolated the electron charge via the oil-drop experiment?',
              correct_answer: 'Robert Millikan',
              distractors: {
                easy: 'J. J. Thomson',
                medium: 'Ernest Rutherford',
                hard: 'Luis Alvarez',
              },
            },
            {
              subject: 'television',
              difficulty_tier: 'pub',
              question: 'Which show features the fictional town of Pawnee, Indiana?',
              correct_answer: 'Parks and Recreation',
              distractors: {
                easy: 'Schitt\'s Creek',
                medium: 'Community',
                hard: '30 Rock',
              },
            },
            {
              subject: 'space',
              difficulty_tier: 'enthusiast',
              question: 'Which NASA rover landed on Mars in 2012?',
              correct_answer: 'Curiosity',
              distractors: {
                easy: 'Opportunity',
                medium: 'Spirit',
                hard: 'Perseverance',
              },
            },
          ],
        },
        {
          round: 5,
          hostItems: [
            {
              subject: 'music',
              difficulty_tier: 'enthusiast',
              question: 'Which composer created the “Enigma Variations”?',
              correct_answer: 'Edward Elgar',
              distractors: {
                easy: 'Benjamin Britten',
                medium: 'Ralph Vaughan Williams',
                hard: 'Gustav Holst',
              },
            },
            {
              subject: 'history',
              difficulty_tier: 'pub',
              question: 'Which ship carried the Pilgrims to North America in 1620?',
              correct_answer: 'Mayflower',
              distractors: {
                easy: 'Santa María',
                medium: 'Endeavour',
                hard: 'Discovery',
              },
            },
            {
              subject: 'science',
              difficulty_tier: 'pub',
              question: 'Which vitamin is primarily produced when skin is exposed to sunlight?',
              correct_answer: 'Vitamin D',
              distractors: {
                easy: 'Vitamin C',
                medium: 'Vitamin B12',
                hard: 'Vitamin K',
              },
            },
          ],
          guestItems: [
            {
              subject: 'games',
              difficulty_tier: 'pub',
              question: 'Which tabletop role-playing game uses a twenty-sided die for most checks?',
              correct_answer: 'Dungeons & Dragons',
              distractors: {
                easy: 'Pathfinder',
                medium: 'Shadowrun',
                hard: 'Call of Cthulhu',
              },
            },
            {
              subject: 'geography',
              difficulty_tier: 'enthusiast',
              question: 'Which mountain range forms the spine of Italy?',
              correct_answer: 'The Apennines',
              distractors: {
                easy: 'The Alps',
                medium: 'The Pyrenees',
                hard: 'The Dinaric Alps',
              },
            },
            {
              subject: 'film',
              difficulty_tier: 'enthusiast',
              question: 'Who composed the iconic two-note motif for “Jaws”?',
              correct_answer: 'John Williams',
              distractors: {
                easy: 'Hans Zimmer',
                medium: 'James Horner',
                hard: 'Alan Silvestri',
              },
            },
          ],
        },
      ],
    }),
  });

  packs.push({
    filename: 'HBR-maths.json',
    data: mathsPack('HBR', {
      generatedAt: '2025-01-20T18:45:00.000Z',
      maths: {
        location: 'Seaside lighthouse kitchen',
        beats: [
          'I polished six brass lanterns before the evening tour arrived.',
          'A scout troop showed up, so I brought six more lanterns up from storage.',
          'After the storm warning, I loaned seven lanterns to the harbour master.',
          'Before bed I set aside three lanterns for overnight watch duty.',
        ],
        questions: [
          'How many lanterns stay with me overnight? ___',
          'What was the highest number of lanterns in my care this evening? ___',
        ],
        answers: [
          2,
          12,
        ],
      },
    }),
  });

  packs.push({
    filename: 'HBR-questions.json',
    data: questionsPack('HBR', {
      generatedAt: '2025-01-20T18:45:00.000Z',
      rounds: [
        {
          round: 1,
          hostItems: [
            {
              subject: 'science',
              difficulty_tier: 'pub',
              question: 'Which gas makes up most of Earth\'s atmosphere?',
              correct_answer: 'Nitrogen',
              distractors: {
                easy: 'Oxygen',
                medium: 'Carbon dioxide',
                hard: 'Argon',
              },
            },
            {
              subject: 'film',
              difficulty_tier: 'pub',
              question: 'Which director won the Oscar for “The Shape of Water”?',
              correct_answer: 'Guillermo del Toro',
              distractors: {
                easy: 'Alejandro González Iñárritu',
                medium: 'Alfonso Cuarón',
                hard: 'Denis Villeneuve',
              },
            },
            {
              subject: 'music',
              difficulty_tier: 'pub',
              question: 'Which pop star released the single “Levitating”?',
              correct_answer: 'Dua Lipa',
              distractors: {
                easy: 'Ariana Grande',
                medium: 'Kylie Minogue',
                hard: 'Sigrid',
              },
            },
          ],
          guestItems: [
            {
              subject: 'history',
              difficulty_tier: 'pub',
              question: 'Who was the first president of South Africa elected after apartheid?',
              correct_answer: 'Nelson Mandela',
              distractors: {
                easy: 'Thabo Mbeki',
                medium: 'Jacob Zuma',
                hard: 'Cyril Ramaphosa',
              },
            },
            {
              subject: 'geography',
              difficulty_tier: 'pub',
              question: 'Which sea separates Saudi Arabia and Africa?',
              correct_answer: 'The Red Sea',
              distractors: {
                easy: 'The Arabian Sea',
                medium: 'The Persian Gulf',
                hard: 'The Gulf of Aden',
              },
            },
            {
              subject: 'technology',
              difficulty_tier: 'pub',
              question: 'Which company created the Swift programming language?',
              correct_answer: 'Apple',
              distractors: {
                easy: 'Microsoft',
                medium: 'Google',
                hard: 'Adobe',
              },
            },
          ],
        },
        {
          round: 2,
          hostItems: [
            {
              subject: 'nature',
              difficulty_tier: 'pub',
              question: 'What is a young swan called?',
              correct_answer: 'Cygnet',
              distractors: {
                easy: 'Gosling',
                medium: 'Signet',
                hard: 'Squab',
              },
            },
            {
              subject: 'literature',
              difficulty_tier: 'enthusiast',
              question: 'Which author created the detective Hercule Poirot?',
              correct_answer: 'Agatha Christie',
              distractors: {
                easy: 'Dorothy L. Sayers',
                medium: 'Ngaio Marsh',
                hard: 'Margery Allingham',
              },
            },
            {
              subject: 'sports',
              difficulty_tier: 'pub',
              question: 'Which sport awards the Stanley Cup?',
              correct_answer: 'Ice hockey',
              distractors: {
                easy: 'Basketball',
                medium: 'Baseball',
                hard: 'Lacrosse',
              },
            },
          ],
          guestItems: [
            {
              subject: 'film',
              difficulty_tier: 'enthusiast',
              question: 'Which cinematographer is famed for his work on “Inception”?',
              correct_answer: 'Wally Pfister',
              distractors: {
                easy: 'Hoyte van Hoytema',
                medium: 'Linus Sandgren',
                hard: 'Claudio Miranda',
              },
            },
            {
              subject: 'science',
              difficulty_tier: 'enthusiast',
              question: 'Which branch of physics studies the behaviour of very low temperatures?',
              correct_answer: 'Cryogenics',
              distractors: {
                easy: 'Thermodynamics',
                medium: 'Cryonics',
                hard: 'Low-temperature plasma physics',
              },
            },
            {
              subject: 'music',
              difficulty_tier: 'pub',
              question: 'Which composer wrote the “Moonlight Sonata”?',
              correct_answer: 'Ludwig van Beethoven',
              distractors: {
                easy: 'Franz Schubert',
                medium: 'Frédéric Chopin',
                hard: 'Robert Schumann',
              },
            },
          ],
        },
        {
          round: 3,
          hostItems: [
            {
              subject: 'technology',
              difficulty_tier: 'enthusiast',
              question: 'Which protocol secures websites with the “https” prefix?',
              correct_answer: 'TLS (Transport Layer Security)',
              distractors: {
                easy: 'SSL (Secure Socket Layer)',
                medium: 'SSH (Secure Shell)',
                hard: 'IPsec (Internet Protocol Security)',
              },
            },
            {
              subject: 'geography',
              difficulty_tier: 'enthusiast',
              question: 'Which mountain is the highest peak in South America?',
              correct_answer: 'Aconcagua',
              distractors: {
                easy: 'Mount Fitz Roy',
                medium: 'Ojos del Salado',
                hard: 'Huáscarán',
              },
            },
            {
              subject: 'culture',
              difficulty_tier: 'pub',
              question: 'Which holiday celebrates the end of Ramadan?',
              correct_answer: 'Eid al-Fitr',
              distractors: {
                easy: 'Eid al-Adha',
                medium: 'Ramadan',
                hard: 'Nowruz',
              },
            },
          ],
          guestItems: [
            {
              subject: 'history',
              difficulty_tier: 'enthusiast',
              question: 'Which queen led the defeat of the Spanish Armada in 1588?',
              correct_answer: 'Elizabeth I',
              distractors: {
                easy: 'Mary I',
                medium: 'Catherine de\' Medici',
                hard: 'Anne of Denmark',
              },
            },
            {
              subject: 'science',
              difficulty_tier: 'specialist',
              question: 'Which particle physicist proposed the existence of the Higgs boson?',
              correct_answer: 'Peter Higgs',
              distractors: {
                easy: 'Murray Gell-Mann',
                medium: 'Sheldon Glashow',
                hard: 'Leon Lederman',
              },
            },
            {
              subject: 'television',
              difficulty_tier: 'pub',
              question: 'Which series features the character David Rose?',
              correct_answer: 'Schitt\'s Creek',
              distractors: {
                easy: 'Arrested Development',
                medium: 'Grace and Frankie',
                hard: 'Kim\'s Convenience',
              },
            },
          ],
        },
        {
          round: 4,
          hostItems: [
            {
              subject: 'science',
              difficulty_tier: 'enthusiast',
              question: 'Which scientist developed the theory of general relativity?',
              correct_answer: 'Albert Einstein',
              distractors: {
                easy: 'Max Planck',
                medium: 'Hendrik Lorentz',
                hard: 'Hermann Minkowski',
              },
            },
            {
              subject: 'games',
              difficulty_tier: 'pub',
              question: 'Which video game series stars the adventurer Lara Croft?',
              correct_answer: 'Tomb Raider',
              distractors: {
                easy: 'Uncharted',
                medium: 'Prince of Persia',
                hard: 'Mirror\'s Edge',
              },
            },
            {
              subject: 'food',
              difficulty_tier: 'pub',
              question: 'Which grain is traditionally used to brew sake?',
              correct_answer: 'Rice',
              distractors: {
                easy: 'Barley',
                medium: 'Millet',
                hard: 'Sorghum',
              },
            },
          ],
          guestItems: [
            {
              subject: 'literature',
              difficulty_tier: 'enthusiast',
              question: 'Which poet wrote “Because I could not stop for Death”?',
              correct_answer: 'Emily Dickinson',
              distractors: {
                easy: 'Sylvia Plath',
                medium: 'Anne Sexton',
                hard: 'Christina Rossetti',
              },
            },
            {
              subject: 'fashion',
              difficulty_tier: 'pub',
              question: 'Which designer introduced the “New Look” in 1947?',
              correct_answer: 'Christian Dior',
              distractors: {
                easy: 'Coco Chanel',
                medium: 'Balenciaga',
                hard: 'Givenchy',
              },
            },
            {
              subject: 'space',
              difficulty_tier: 'enthusiast',
              question: 'Which telescope launched in 2021 to succeed Hubble?',
              correct_answer: 'James Webb Space Telescope',
              distractors: {
                easy: 'Spitzer Space Telescope',
                medium: 'Chandra X-ray Observatory',
                hard: 'Kepler Space Telescope',
              },
            },
          ],
        },
        {
          round: 5,
          hostItems: [
            {
              subject: 'music',
              difficulty_tier: 'enthusiast',
              question: 'Which composer wrote the opera “The Magic Flute”?',
              correct_answer: 'Wolfgang Amadeus Mozart',
              distractors: {
                easy: 'Gioachino Rossini',
                medium: 'Joseph Haydn',
                hard: 'Christoph Willibald Gluck',
              },
            },
            {
              subject: 'technology',
              difficulty_tier: 'pub',
              question: 'Which company first released the Walkman portable cassette player?',
              correct_answer: 'Sony',
              distractors: {
                easy: 'Panasonic',
                medium: 'Philips',
                hard: 'JVC',
              },
            },
            {
              subject: 'history',
              difficulty_tier: 'enthusiast',
              question: 'Which treaty created the European Union in 1993?',
              correct_answer: 'Maastricht Treaty',
              distractors: {
                easy: 'Lisbon Treaty',
                medium: 'Schengen Agreement',
                hard: 'Treaty of Rome',
              },
            },
          ],
          guestItems: [
            {
              subject: 'science',
              difficulty_tier: 'specialist',
              question: 'Which law in electromagnetism states that the line integral of magnetic field around a closed loop equals the enclosed current?',
              correct_answer: 'Ampère\'s circuital law',
              distractors: {
                easy: 'Gauss\'s law',
                medium: 'Faraday\'s law of induction',
                hard: 'Biot–Savart law',
              },
            },
            {
              subject: 'film',
              difficulty_tier: 'enthusiast',
              question: 'Which actor portrayed Jack in “The Nightmare Before Christmas”?',
              correct_answer: 'Chris Sarandon (singing by Danny Elfman)',
              distractors: {
                easy: 'Johnny Depp',
                medium: 'Danny Elfman',
                hard: 'Catherine O\'Hara',
              },
            },
            {
              subject: 'culture',
              difficulty_tier: 'pub',
              question: 'Which festival is known as the Festival of Lights in India?',
              correct_answer: 'Diwali',
              distractors: {
                easy: 'Holi',
                medium: 'Navratri',
                hard: 'Vaisakhi',
              },
            },
          ],
        },
      ],
    }),
  });

  return packs;
}

if (require.main === module) {
  const packs = buildPacks();
  for (const pack of packs) {
    writePack(pack.filename, pack.data);
  }
}
