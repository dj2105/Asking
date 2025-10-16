const pack = {
  version: "jemima-pack-1",
  meta: {
    roomCode: "PREVIEW",
    hostUid: "daniel-001",
    guestUid: "jaime-001",
    generatedAt: "2024-07-01T12:00:00Z",
  },
  rounds: [
    {
      round: 1,
      interlude: "Jemima braids liquorice whips into a cat’s cradle.",
      difficultyFocus: "pub",
      distractorServing: "medium",
      hostItems: [],
      guestItems: [],
    },
    {
      round: 2,
      interlude: "She times a kettle’s whistle to match a cricket over.",
      difficultyFocus: "enthusiast",
      distractorServing: "easy",
      hostItems: [],
      guestItems: [],
    },
    {
      round: 3,
      interlude: "She flips through atlases hunting for secret pen pals.",
      difficultyFocus: "enthusiast",
      distractorServing: "hard",
      hostItems: [],
      guestItems: [],
    },
    {
      round: 4,
      interlude: "She tunes a theremin to mimic foghorn harmonies.",
      difficultyFocus: "specialist",
      distractorServing: "easy",
      hostItems: [],
      guestItems: [],
    },
    {
      round: 5,
      interlude: "She charts comet tails with glitter and baking paper.",
      difficultyFocus: "specialist",
      distractorServing: "medium",
      hostItems: [],
      guestItems: [],
    },
  ],
};

const knowledgeLevels = [
  { value: "certain", label: "Definitely know" },
  { value: "think", label: "Think I know" },
  { value: "fifty", label: "50/50 but question is ok" },
  { value: "clueless", label: "Haven’t got a clue but question is ok" },
  { value: "hate", label: "Hate this question" },
];

const questionBank = [
  {
    id: "R1-H1",
    round: 1,
    role: "host",
    position: 1,
    subject: "Everyday Science",
    difficulty_tier: "pub",
    length_class: "short",
    question: "Which gas makes fizzy drinks sparkle?",
    correct_answer: "Carbon dioxide",
    distractors: {
      easy: { text: "Helium", error_tag: "wrong_usage", plausibility_score: 1 },
      medium: { text: "Oxygen", error_tag: "confused_reaction", plausibility_score: 2 },
      hard: { text: "Nitrogen", error_tag: "partial_truth", plausibility_score: 3 },
    },
    featuredDistractor: "medium",
    provenance_hint: "Carbonated soft drinks chemistry",
  },
  {
    id: "R1-H2",
    round: 1,
    role: "host",
    position: 2,
    subject: "British & Irish Landmarks",
    difficulty_tier: "pub",
    length_class: "medium",
    question: "Which London bridge completed in 1894 uses twin bascules so tall-masted ships on the Thames can pass between Tower Hamlets and Southwark, and today still lifts hundreds of times each year for river traffic?",
    correct_answer: "Tower Bridge",
    distractors: {
      easy: { text: "London Bridge", error_tag: "wrong_structure", plausibility_score: 1 },
      medium: { text: "Blackfriars Bridge", error_tag: "wrong_location", plausibility_score: 2 },
      hard: { text: "Albert Bridge", error_tag: "near_miss_design", plausibility_score: 3 },
    },
    featuredDistractor: "medium",
    provenance_hint: "Tower Bridge bascule design",
  },
  {
    id: "R1-H3",
    round: 1,
    role: "host",
    position: 3,
    subject: "World Capitals",
    difficulty_tier: "pub",
    length_class: "long",
    question: "Which city became Kazakhstan’s capital in December 1997 when President Nursultan Nazarbayev moved the government from Almaty to a purpose-built centre on the Ishim River, later renamed Nur-Sultan before reverting to its original name in 2022?",
    correct_answer: "Astana",
    distractors: {
      easy: { text: "Almaty", error_tag: "former_capital", plausibility_score: 1 },
      medium: { text: "Karaganda", error_tag: "industrial_centre", plausibility_score: 2 },
      hard: { text: "Shymkent", error_tag: "regional_metropolis", plausibility_score: 3 },
    },
    featuredDistractor: "medium",
    provenance_hint: "Kazakhstan capital move 1997",
  },
  {
    id: "R1-G1",
    round: 1,
    role: "guest",
    position: 1,
    subject: "Famous Inventions",
    difficulty_tier: "pub",
    length_class: "short",
    question: "Who created the World Wide Web at CERN in 1989?",
    correct_answer: "Tim Berners-Lee",
    distractors: {
      easy: { text: "Bill Gates", error_tag: "popular_tech_leader", plausibility_score: 1 },
      medium: { text: "Vint Cerf", error_tag: "internet_pioneer", plausibility_score: 2 },
      hard: { text: "Marc Andreessen", error_tag: "browser_innovator", plausibility_score: 3 },
    },
    featuredDistractor: "medium",
    provenance_hint: "CERN invention 1989",
  },
  {
    id: "R1-G2",
    round: 1,
    role: "guest",
    position: 2,
    subject: "Languages of the World",
    difficulty_tier: "pub",
    length_class: "medium",
    question: "Which language with roughly 75 million native speakers is official in Bangladesh, co-official in India’s West Bengal state, and celebrated worldwide each 21 February on International Mother Language Day?",
    correct_answer: "Bangla (Bengali)",
    distractors: {
      easy: { text: "Urdu", error_tag: "different_state_language", plausibility_score: 1 },
      medium: { text: "Hindi", error_tag: "major_indic_language", plausibility_score: 2 },
      hard: { text: "Nepali", error_tag: "regional_confusion", plausibility_score: 3 },
    },
    featuredDistractor: "medium",
    provenance_hint: "Bangladesh state language",
  },
  {
    id: "R1-G3",
    round: 1,
    role: "guest",
    position: 3,
    subject: "Weather & Climate",
    difficulty_tier: "pub",
    length_class: "long",
    question: "What is the name of the warm Atlantic current that rises from the Gulf of Mexico, sweeps past Newfoundland, threads northeast toward Norway, and keeps western Europe’s climate milder than other regions on the same latitude?",
    correct_answer: "Gulf Stream",
    distractors: {
      easy: { text: "Canary Current", error_tag: "cold_current", plausibility_score: 1 },
      medium: { text: "North Atlantic Drift", error_tag: "regional_component", plausibility_score: 2 },
      hard: { text: "Brazil Current", error_tag: "wrong_ocean", plausibility_score: 3 },
    },
    featuredDistractor: "medium",
    provenance_hint: "Atlantic circulation",
  },
  {
    id: "R2-H1",
    round: 2,
    role: "host",
    position: 1,
    subject: "Space & Astronomy",
    difficulty_tier: "enthusiast",
    length_class: "short",
    question: "Which dwarf planet orbits within the asteroid belt between Mars and Jupiter?",
    correct_answer: "Ceres",
    distractors: {
      easy: { text: "Pluto", error_tag: "wrong_orbit", plausibility_score: 1 },
      medium: { text: "Vesta", error_tag: "asteroid_confusion", plausibility_score: 2 },
      hard: { text: "Haumea", error_tag: "outer_solar_system", plausibility_score: 3 },
    },
    featuredDistractor: "easy",
    provenance_hint: "Dwarf planet classification",
  },
  {
    id: "R2-H2",
    round: 2,
    role: "host",
    position: 2,
    subject: "Human Body",
    difficulty_tier: "enthusiast",
    length_class: "medium",
    question: "Which cranial nerve, numbered VII, controls most facial expressions, carries taste from the anterior two-thirds of the tongue, and supplies parasympathetic fibres to the lacrimal and salivary glands?",
    correct_answer: "Facial nerve",
    distractors: {
      easy: { text: "Trigeminal nerve", error_tag: "sensory_focus", plausibility_score: 1 },
      medium: { text: "Glossopharyngeal nerve", error_tag: "adjacent_function", plausibility_score: 2 },
      hard: { text: "Accessory nerve", error_tag: "motor_function_confusion", plausibility_score: 3 },
    },
    featuredDistractor: "easy",
    provenance_hint: "Cranial nerve VII role",
  },
  {
    id: "R2-H3",
    round: 2,
    role: "host",
    position: 3,
    subject: "Numbers & Measures",
    difficulty_tier: "enthusiast",
    length_class: "long",
    question: "In UK cookery, how many millilitres are in one imperial pint as fixed by the Weights and Measures Act 1824, a figure still used for draught beer and milk bottles and about 20 percent larger than the US liquid pint?",
    correct_answer: "568 ml",
    distractors: {
      easy: { text: "500 ml", error_tag: "rounded_estimate", plausibility_score: 1 },
      medium: { text: "473 ml", error_tag: "us_pint_value", plausibility_score: 2 },
      hard: { text: "600 ml", error_tag: "overcompensation", plausibility_score: 3 },
    },
    featuredDistractor: "easy",
    provenance_hint: "Imperial pint volume",
  },
  {
    id: "R2-G1",
    round: 2,
    role: "guest",
    position: 1,
    subject: "The Internet & Technology",
    difficulty_tier: "enthusiast",
    length_class: "short",
    question: "Which secure protocol succeeded SSL 3.0 for most encrypted web traffic on port 443?",
    correct_answer: "Transport Layer Security (TLS)",
    distractors: {
      easy: { text: "Hypertext Transfer Protocol (HTTP)", error_tag: "unencrypted_protocol", plausibility_score: 1 },
      medium: { text: "Secure Shell (SSH)", error_tag: "different_port", plausibility_score: 2 },
      hard: { text: "IPsec", error_tag: "network_layer_focus", plausibility_score: 3 },
    },
    featuredDistractor: "easy",
    provenance_hint: "Web security standards",
  },
  {
    id: "R2-G2",
    round: 2,
    role: "guest",
    position: 2,
    subject: "Ancient Civilisations",
    difficulty_tier: "enthusiast",
    length_class: "medium",
    question: "Which ancient city on Crete was the ceremonial centre of the Minoan civilisation, home to frescoed storerooms and bull-leaping courts, and the palace linked to the mythic Labyrinth?",
    correct_answer: "Knossos",
    distractors: {
      easy: { text: "Sparta", error_tag: "wrong_region", plausibility_score: 1 },
      medium: { text: "Phaistos", error_tag: "secondary_minoan_site", plausibility_score: 2 },
      hard: { text: "Mycenae", error_tag: "mainland_confusion", plausibility_score: 3 },
    },
    featuredDistractor: "easy",
    provenance_hint: "Minoan palace complex",
  },
  {
    id: "R2-G3",
    round: 2,
    role: "guest",
    position: 3,
    subject: "British Monarchs",
    difficulty_tier: "enthusiast",
    length_class: "long",
    question: "Which English monarch issued the 1559 Act of Uniformity, restored the Elizabethan Prayer Book, re-established the Church of England’s Protestant settlement, and ruled for 45 years after succeeding her half-sister Mary I?",
    correct_answer: "Elizabeth I",
    distractors: {
      easy: { text: "Mary I", error_tag: "predecessor", plausibility_score: 1 },
      medium: { text: "Edward VI", error_tag: "earlier_protestant", plausibility_score: 2 },
      hard: { text: "James I", error_tag: "successor_confusion", plausibility_score: 3 },
    },
    featuredDistractor: "easy",
    provenance_hint: "Elizabethan religious settlement",
  },
  {
    id: "R3-H1",
    round: 3,
    role: "host",
    position: 1,
    subject: "Irish History",
    difficulty_tier: "enthusiast",
    length_class: "short",
    question: "Which treaty signed in London on 6 December 1921 established the Irish Free State as a dominion?",
    correct_answer: "Anglo-Irish Treaty",
    distractors: {
      easy: { text: "Treaty of Limerick", error_tag: "wrong_century", plausibility_score: 1 },
      medium: { text: "Sunningdale Agreement", error_tag: "1970s_power_sharing", plausibility_score: 2 },
      hard: { text: "Treaty of Amiens", error_tag: "different_conflict", plausibility_score: 3 },
    },
    featuredDistractor: "hard",
    provenance_hint: "Irish Free State origins",
  },
  {
    id: "R3-H2",
    round: 3,
    role: "host",
    position: 2,
    subject: "World Wars",
    difficulty_tier: "enthusiast",
    length_class: "medium",
    question: "Which May 1942 naval battle in the Coral Sea stopped Japan’s advance toward Port Moresby, cost both sides an aircraft carrier, and marked the first engagement fought entirely by opposing carrier air groups?",
    correct_answer: "Battle of the Coral Sea",
    distractors: {
      easy: { text: "Battle of Midway", error_tag: "different_month", plausibility_score: 1 },
      medium: { text: "Battle of the Bismarck Sea", error_tag: "1943_engagement", plausibility_score: 2 },
      hard: { text: "Battle of Guadalcanal", error_tag: "campaign_confusion", plausibility_score: 3 },
    },
    featuredDistractor: "hard",
    provenance_hint: "Pacific theatre 1942",
  },
  {
    id: "R3-H3",
    round: 3,
    role: "host",
    position: 3,
    subject: "The Tudors",
    difficulty_tier: "enthusiast",
    length_class: "long",
    question: "Which 1534 statute passed under Henry VIII declared him Supreme Head of the Church of England, severed papal authority, required loyalty oaths, and paved the way for the sweeping Dissolution of the Monasteries?",
    correct_answer: "Act of Supremacy",
    distractors: {
      easy: { text: "Act of Union", error_tag: "1707_legislation", plausibility_score: 1 },
      medium: { text: "Six Articles", error_tag: "later_tudor_doctrine", plausibility_score: 2 },
      hard: { text: "Act of Succession", error_tag: "related_but_wrong", plausibility_score: 3 },
    },
    featuredDistractor: "hard",
    provenance_hint: "English Reformation laws",
  },
  {
    id: "R3-G1",
    round: 3,
    role: "guest",
    position: 1,
    subject: "20th-Century Milestones",
    difficulty_tier: "enthusiast",
    length_class: "short",
    question: "Which 1957 Soviet satellite became the first human-made object to orbit Earth?",
    correct_answer: "Sputnik 1",
    distractors: {
      easy: { text: "Luna 2", error_tag: "later_mission", plausibility_score: 1 },
      medium: { text: "Explorer 1", error_tag: "US_response", plausibility_score: 2 },
      hard: { text: "Vostok 1", error_tag: "crewed_flight", plausibility_score: 3 },
    },
    featuredDistractor: "hard",
    provenance_hint: "Space race firsts",
  },
  {
    id: "R3-G2",
    round: 3,
    role: "guest",
    position: 2,
    subject: "Rebellions & Revolutions",
    difficulty_tier: "enthusiast",
    length_class: "medium",
    question: "Which July 1830 uprising in Paris toppled King Charles X, raised the tricolour on the Hôtel de Ville, and replaced him with Louis-Philippe under a constitutional charter?",
    correct_answer: "July Revolution",
    distractors: {
      easy: { text: "French Revolution", error_tag: "wrong_year", plausibility_score: 1 },
      medium: { text: "June Rebellion", error_tag: "1832_event", plausibility_score: 2 },
      hard: { text: "Paris Commune", error_tag: "1871_confusion", plausibility_score: 3 },
    },
    featuredDistractor: "hard",
    provenance_hint: "Bourbon Restoration fall",
  },
  {
    id: "R3-G3",
    round: 3,
    role: "guest",
    position: 3,
    subject: "Famous Explorers",
    difficulty_tier: "enthusiast",
    length_class: "long",
    question: "Which Norwegian explorer led the 1910–1912 expedition that first reached the South Pole using skis and dog teams, set up the Framheim base on the Ross Ice Shelf, and arrived 34 days before Robert Falcon Scott’s party?",
    correct_answer: "Roald Amundsen",
    distractors: {
      easy: { text: "Robert Falcon Scott", error_tag: "runner_up", plausibility_score: 1 },
      medium: { text: "Ernest Shackleton", error_tag: "other_antarctic_leader", plausibility_score: 2 },
      hard: { text: "Fridtjof Nansen", error_tag: "earlier_arctic_explorer", plausibility_score: 3 },
    },
    featuredDistractor: "hard",
    provenance_hint: "South Pole race",
  },
  {
    id: "R4-H1",
    round: 4,
    role: "host",
    position: 1,
    subject: "Great Inventions of the Industrial Age",
    difficulty_tier: "specialist",
    length_class: "short",
    question: "Which Scottish engineer patented the 1828 hot-blast furnace process that drastically cut coke use in ironmaking?",
    correct_answer: "James Beaumont Neilson",
    distractors: {
      easy: { text: "Henry Bessemer", error_tag: "different_process", plausibility_score: 1 },
      medium: { text: "Abraham Darby", error_tag: "earlier_smelting_pioneer", plausibility_score: 2 },
      hard: { text: "James Nasmyth", error_tag: "industrial_innovator", plausibility_score: 3 },
    },
    featuredDistractor: "easy",
    provenance_hint: "Hot-blast patent 1828",
  },
  {
    id: "R4-H2",
    round: 4,
    role: "host",
    position: 2,
    subject: "Modern Politics",
    difficulty_tier: "specialist",
    length_class: "medium",
    question: "Which body created by the 1998 Good Friday Agreement coordinates cross-border policy between the Republic of Ireland and Northern Ireland through themed ministerial councils and joint secretariats?",
    correct_answer: "North/South Ministerial Council",
    distractors: {
      easy: { text: "British-Irish Council", error_tag: "wider_membership", plausibility_score: 1 },
      medium: { text: "British-Irish Intergovernmental Conference", error_tag: "different_forum", plausibility_score: 2 },
      hard: { text: "Joint Ministerial Committee", error_tag: "devolved_uk_body", plausibility_score: 3 },
    },
    featuredDistractor: "easy",
    provenance_hint: "Good Friday Agreement institutions",
  },
  {
    id: "R4-H3",
    round: 4,
    role: "host",
    position: 3,
    subject: "European Cities",
    difficulty_tier: "specialist",
    length_class: "long",
    question: "Which French city became the seat of the Council of Europe in 1949, hosts the Parliamentary Assembly, and houses the European Court of Human Rights in the glass-fronted Palais de l’Europe complex beside the River Ill?",
    correct_answer: "Strasbourg",
    distractors: {
      easy: { text: "Brussels", error_tag: "eu_institution_mixup", plausibility_score: 1 },
      medium: { text: "Luxembourg City", error_tag: "eu_judicial_confusion", plausibility_score: 2 },
      hard: { text: "The Hague", error_tag: "international_court_city", plausibility_score: 3 },
    },
    featuredDistractor: "easy",
    provenance_hint: "Council of Europe seat",
  },
  {
    id: "R4-G1",
    round: 4,
    role: "guest",
    position: 1,
    subject: "Mountains & Rivers",
    difficulty_tier: "specialist",
    length_class: "short",
    question: "Which Himalayan river carves the Kali Gandaki Gorge between Dhaulagiri and Annapurna?",
    correct_answer: "Kali Gandaki River",
    distractors: {
      easy: { text: "Yarlung Tsangpo", error_tag: "different_valley", plausibility_score: 1 },
      medium: { text: "Indus River", error_tag: "regional_misplacement", plausibility_score: 2 },
      hard: { text: "Sun Kosi", error_tag: "neighbouring_tributary", plausibility_score: 3 },
    },
    featuredDistractor: "easy",
    provenance_hint: "Himalayan gorge geography",
  },
  {
    id: "R4-G2",
    round: 4,
    role: "guest",
    position: 2,
    subject: "National Flags",
    difficulty_tier: "specialist",
    length_class: "medium",
    question: "Which nation adopted a flag in 1915 featuring a green pentagram centred on a red field to symbolise the Seal of Solomon and the unity of the Alaouite dynasty?",
    correct_answer: "Morocco",
    distractors: {
      easy: { text: "Tunisia", error_tag: "crescent_confusion", plausibility_score: 1 },
      medium: { text: "Ethiopia", error_tag: "different_star_design", plausibility_score: 2 },
      hard: { text: "Algeria", error_tag: "similar_colours", plausibility_score: 3 },
    },
    featuredDistractor: "easy",
    provenance_hint: "Maghreb vexillology",
  },
  {
    id: "R4-G3",
    round: 4,
    role: "guest",
    position: 3,
    subject: "Islands & Archipelagos",
    difficulty_tier: "specialist",
    length_class: "long",
    question: "Which archipelago north of mainland Scotland includes Scapa Flow, served as the Royal Navy Grand Fleet base in World War I, guards relics of the Italian Chapel, and preserves Neolithic sites such as Skara Brae?",
    correct_answer: "Orkney Islands",
    distractors: {
      easy: { text: "Shetland Islands", error_tag: "neighbouring_group", plausibility_score: 1 },
      medium: { text: "Hebrides", error_tag: "different_archipelago", plausibility_score: 2 },
      hard: { text: "Faroe Islands", error_tag: "north_atlantic_confusion", plausibility_score: 3 },
    },
    featuredDistractor: "easy",
    provenance_hint: "Orkney wartime role",
  },
  {
    id: "R5-H1",
    round: 5,
    role: "host",
    position: 1,
    subject: "UNESCO Sites",
    difficulty_tier: "specialist",
    length_class: "short",
    question: "Which Cambodian temple complex added to UNESCO’s World Heritage List in 1992 was built under Suryavarman II as a state temple for Vishnu?",
    correct_answer: "Angkor Wat",
    distractors: {
      easy: { text: "Borobudur", error_tag: "different_country", plausibility_score: 1 },
      medium: { text: "Preah Vihear", error_tag: "different_khmer_site", plausibility_score: 2 },
      hard: { text: "Bayon", error_tag: "later_temple", plausibility_score: 3 },
    },
    featuredDistractor: "medium",
    provenance_hint: "Angkor Wat UNESCO 1992",
  },
  {
    id: "R5-H2",
    round: 5,
    role: "host",
    position: 2,
    subject: "Deserts & Oceans",
    difficulty_tier: "specialist",
    length_class: "medium",
    question: "Which cold Asian desert spans parts of Mongolia and northern China because it lies in the rain shadow of the Altai Mountains, with winter temperatures that plunge below −30 °C?",
    correct_answer: "Gobi Desert",
    distractors: {
      easy: { text: "Taklamakan Desert", error_tag: "different_basin", plausibility_score: 1 },
      medium: { text: "Karakum Desert", error_tag: "central_asia_confusion", plausibility_score: 2 },
      hard: { text: "Atacama Desert", error_tag: "opposite_hemisphere", plausibility_score: 3 },
    },
    featuredDistractor: "medium",
    provenance_hint: "Gobi desert climate",
  },
  {
    id: "R5-H3",
    round: 5,
    role: "host",
    position: 3,
    subject: "Airports & Airlines",
    difficulty_tier: "specialist",
    length_class: "long",
    question: "Which airport with IATA code DOH opened the Hamad International terminal in 2014 to replace the old Doha International Airport as Qatar Airways’ main hub, with a single terminal designed by HOK and ADP?",
    correct_answer: "Hamad International Airport",
    distractors: {
      easy: { text: "Dubai International Airport", error_tag: "regional_hub_confusion", plausibility_score: 1 },
      medium: { text: "Abu Dhabi International Airport", error_tag: "nearby_capital", plausibility_score: 2 },
      hard: { text: "King Khalid International Airport", error_tag: "regional_capital_mixup", plausibility_score: 3 },
    },
    featuredDistractor: "medium",
    provenance_hint: "Doha airport move 2014",
  },
  {
    id: "R5-G1",
    round: 5,
    role: "guest",
    position: 1,
    subject: "Trains & Journeys",
    difficulty_tier: "specialist",
    length_class: "short",
    question: "Which shinkansen line opened in 1964 to connect Tokyo with Osaka in time for the Summer Olympics?",
    correct_answer: "Tokaido Shinkansen",
    distractors: {
      easy: { text: "Sanyo Shinkansen", error_tag: "later_extension", plausibility_score: 1 },
      medium: { text: "Hokkaido Shinkansen", error_tag: "different_region", plausibility_score: 2 },
      hard: { text: "Tohoku Shinkansen", error_tag: "northern_route", plausibility_score: 3 },
    },
    featuredDistractor: "medium",
    provenance_hint: "Japan bullet train launch",
  },
  {
    id: "R5-G2",
    round: 5,
    role: "guest",
    position: 2,
    subject: "Countries by Cuisine",
    difficulty_tier: "specialist",
    length_class: "medium",
    question: "Which country’s national dish feijoada combines pork, black beans, farofa, orange slices, and collard greens, and is traditionally served on Saturdays with rice and kale?",
    correct_answer: "Brazil",
    distractors: {
      easy: { text: "Portugal", error_tag: "colonial_link_confusion", plausibility_score: 1 },
      medium: { text: "Argentina", error_tag: "regional_cuisine_mixup", plausibility_score: 2 },
      hard: { text: "Mozambique", error_tag: "lusophone_link", plausibility_score: 3 },
    },
    featuredDistractor: "medium",
    provenance_hint: "Feijoada national dish",
  },
  {
    id: "R5-G3",
    round: 5,
    role: "guest",
    position: 3,
    subject: "Odd Place Names",
    difficulty_tier: "specialist",
    length_class: "long",
    question: "Which Welsh village famous for its 58-letter name translates roughly to ‘St Mary’s Church in the hollow of the white hazel near the swift whirlpool and St Tysilio’s red cave’ and sits on Anglesey’s Menai Strait?",
    correct_answer: "Llanfairpwllgwyngyllgogerychwyrndrobwllllantysiliogogogoch",
    distractors: {
      easy: { text: "Betws-y-Coed", error_tag: "tourist_town_confusion", plausibility_score: 1 },
      medium: { text: "Machynlleth", error_tag: "historic_market_town", plausibility_score: 2 },
      hard: { text: "Pontypridd", error_tag: "wrong_region", plausibility_score: 3 },
    },
    featuredDistractor: "medium",
    provenance_hint: "Anglesey long place name",
  },
];

for (const item of questionBank) {
  const round = pack.rounds.find((r) => r.round === item.round);
  if (!round) continue;
  const bucket = item.role === "host" ? round.hostItems : round.guestItems;
  bucket.push(item);
}

for (const round of pack.rounds) {
  round.hostItems.sort((a, b) => a.position - b.position);
  round.guestItems.sort((a, b) => a.position - b.position);
}

const questionIndex = new Map(questionBank.map((item) => [item.id, item]));

function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleWithSeed(array, seed) {
  const out = array.slice();
  const rng = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function buildOptionList(item) {
  const base = [
    { value: "correct", text: item.correct_answer, isCorrect: true, difficulty: "correct" },
    ...Object.entries(item.distractors).map(([key, detail]) => ({
      value: key,
      text: detail.text,
      isCorrect: false,
      difficulty: key,
    })),
  ];
  const seed = item.id.split("").reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return shuffleWithSeed(base, seed);
}

function createQuestionBlock(item, indexWithinRound) {
  const wrapper = document.createElement("section");
  wrapper.className = "question-block";

  const heading = document.createElement("div");
  heading.className = "question-heading mono small";
  heading.textContent = `${indexWithinRound}. ${item.subject} · ${item.length_class} · ${item.difficulty_tier}`;
  wrapper.appendChild(heading);

  const questionText = document.createElement("p");
  questionText.className = "q";
  questionText.textContent = item.question;
  wrapper.appendChild(questionText);

  const optionFieldset = document.createElement("fieldset");
  optionFieldset.className = "option-set";
  optionFieldset.dataset.questionId = item.id;
  optionFieldset.dataset.correctValue = "correct";

  const options = buildOptionList(item);
  options.forEach((option, optionIndex) => {
    const optionId = `${item.id}-opt-${optionIndex}`;
    const label = document.createElement("label");
    label.className = "option-row";

    const input = document.createElement("input");
    input.type = "radio";
    input.name = `answer-${item.id}`;
    input.value = option.value;
    input.id = optionId;
    input.dataset.optionText = option.text;

    const marker = document.createElement("span");
    marker.className = "option-text";
    marker.textContent = option.text;

    label.appendChild(input);
    label.appendChild(marker);
    optionFieldset.appendChild(label);
  });

  wrapper.appendChild(optionFieldset);

  const featured = document.createElement("p");
  featured.className = "featured-note mono small";
  featured.textContent = `Featured distractor for live play: ${item.featuredDistractor}`;
  wrapper.appendChild(featured);

  const knowledgeFieldset = document.createElement("fieldset");
  knowledgeFieldset.className = "knowledge-set";

  const knowledgeLegend = document.createElement("legend");
  knowledgeLegend.className = "mono small";
  knowledgeLegend.textContent = "How sure were you?";
  knowledgeFieldset.appendChild(knowledgeLegend);

  knowledgeLevels.forEach((level, levelIndex) => {
    const levelId = `${item.id}-feel-${levelIndex}`;
    const label = document.createElement("label");
    label.className = "option-row knowledge";

    const input = document.createElement("input");
    input.type = "radio";
    input.name = `knowledge-${item.id}`;
    input.value = level.value;
    input.id = levelId;
    input.dataset.label = level.label;

    const text = document.createElement("span");
    text.className = "option-text";
    text.textContent = level.label;

    label.appendChild(input);
    label.appendChild(text);
    knowledgeFieldset.appendChild(label);
  });

  wrapper.appendChild(knowledgeFieldset);

  const commentLabel = document.createElement("label");
  commentLabel.className = "mono small";
  commentLabel.setAttribute("for", `comment-${item.id}`);
  commentLabel.textContent = "Your comment";
  wrapper.appendChild(commentLabel);

  const commentBox = document.createElement("textarea");
  commentBox.className = "input comment-box";
  commentBox.name = `comment-${item.id}`;
  commentBox.id = `comment-${item.id}`;
  commentBox.rows = 3;
  commentBox.placeholder = "Note tweaks, pacing thoughts, or wild applause.";
  wrapper.appendChild(commentBox);

  return wrapper;
}

function renderPack(packData) {
  const app = document.getElementById("app");
  const view = document.createElement("div");
  view.className = "view";

  const title = document.createElement("h1");
  title.className = "title";
  title.textContent = "Pack review — Host & Guest preview";
  view.appendChild(title);

  const meta = document.createElement("p");
  meta.className = "mono small";
  meta.textContent = `Room ${packData.meta.roomCode} · Generated ${new Date(packData.meta.generatedAt).toLocaleString("en-GB", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" })} · Difficulty ramp R1 easy → R2/3 medium → R4/5 hard.`;
  view.appendChild(meta);

  packData.rounds.forEach((round) => {
    const card = document.createElement("div");
    card.className = "card round-card";

    const roundTitle = document.createElement("h2");
    roundTitle.className = "round-title";
    roundTitle.textContent = `Round ${round.round} · ${round.difficultyFocus.toUpperCase()} focus`;
    card.appendChild(roundTitle);

    const interlude = document.createElement("p");
    interlude.className = "mono small";
    interlude.textContent = `Interlude: ${round.interlude}`;
    card.appendChild(interlude);

    const hostHeading = document.createElement("h3");
    hostHeading.className = "role-heading";
    hostHeading.textContent = "Host questions";
    card.appendChild(hostHeading);

    round.hostItems.forEach((item, idx) => {
      const block = createQuestionBlock(item, idx + 1);
      block.dataset.role = "host";
      block.dataset.round = round.round;
      card.appendChild(block);
    });

    const guestHeading = document.createElement("h3");
    guestHeading.className = "role-heading";
    guestHeading.textContent = "Guest questions";
    card.appendChild(guestHeading);

    round.guestItems.forEach((item, idx) => {
      const block = createQuestionBlock(item, idx + 1);
      block.dataset.role = "guest";
      block.dataset.round = round.round;
      card.appendChild(block);
    });

    view.appendChild(card);
  });

  const totalQuestions = questionBank.length;

  const scoreCard = document.createElement("div");
  scoreCard.className = "card score-card";

  const scoreTitle = document.createElement("h2");
  scoreTitle.className = "round-title";
  scoreTitle.textContent = "Mark & export";
  scoreCard.appendChild(scoreTitle);

  const scoreButton = document.createElement("button");
  scoreButton.className = "btn throb-soft";
  scoreButton.type = "button";
  scoreButton.textContent = "Reveal score & summary";
  scoreCard.appendChild(scoreButton);

  const scoreOutput = document.createElement("p");
  scoreOutput.className = "mono small score-output";
  scoreOutput.textContent = "Score will appear here once you mark yourself.";
  scoreCard.appendChild(scoreOutput);

  const summaryArea = document.createElement("textarea");
  summaryArea.className = "input summary-output";
  summaryArea.rows = 14;
  summaryArea.readOnly = true;
  summaryArea.placeholder = "Summary will appear here ready to copy.";
  scoreCard.appendChild(summaryArea);

  const copyButton = document.createElement("button");
  copyButton.className = "btn outline";
  copyButton.type = "button";
  copyButton.textContent = "Copy summary";
  copyButton.disabled = true;
  scoreCard.appendChild(copyButton);

  view.appendChild(scoreCard);
  app.appendChild(view);

  scoreButton.addEventListener("click", () => {
    const questionSets = Array.from(view.querySelectorAll("fieldset.option-set"));
    let correctCount = 0;
    let unanswered = 0;
    const lines = [];

    questionSets.forEach((fieldset) => {
      const questionId = fieldset.dataset.questionId;
      const item = questionIndex.get(questionId);
      if (!item) return;

      const answerInputs = Array.from(fieldset.querySelectorAll("input[type=radio]"));
      const selected = answerInputs.find((input) => input.checked);
      const selectedValue = selected ? selected.value : null;
      const selectedText = selected ? selected.dataset.optionText : "No answer selected";
      const isCorrect = selectedValue === "correct";
      if (isCorrect) correctCount += 1;
      if (!selected) unanswered += 1;

      const knowledgeInputs = Array.from(view.querySelectorAll(`input[name="knowledge-${questionId}"]`));
      const knowledgeSelected = knowledgeInputs.find((input) => input.checked);
      const knowledgeLabel = knowledgeSelected ? knowledgeSelected.dataset.label : "Not marked";

      const commentArea = view.querySelector(`textarea[name="comment-${questionId}"]`);
      const commentText = commentArea ? commentArea.value.trim() : "";

      lines.push(
        [
          `Round ${item.round} · ${item.role === "host" ? "Host" : "Guest"} · ${item.subject}`,
          `Question: ${item.question}`,
          `Your answer: ${selectedText}`,
          `Correct answer: ${item.correct_answer}`,
          `Result: ${isCorrect ? "Correct" : "Incorrect"}`,
          `Knowledge rating: ${knowledgeLabel}`,
          `Comment: ${commentText || "(none)"}`,
        ].join("\n")
      );
    });

    const scoreLine = `Score: ${correctCount} / ${totalQuestions}${unanswered ? ` (Unanswered: ${unanswered})` : ""}`;
    scoreOutput.textContent = scoreLine;
    summaryArea.value = `${scoreLine}\n\n${lines.join("\n\n")}`;
    copyButton.disabled = summaryArea.value.length === 0;
  });

  copyButton.addEventListener("click", async () => {
    if (!summaryArea.value) return;
    try {
      await navigator.clipboard.writeText(summaryArea.value);
      const original = copyButton.textContent;
      copyButton.textContent = "Copied!";
      copyButton.disabled = true;
      setTimeout(() => {
        copyButton.textContent = original;
        copyButton.disabled = false;
      }, 1400);
    } catch (_) {
      copyButton.textContent = "Copy failed";
      setTimeout(() => {
        copyButton.textContent = "Copy summary";
      }, 1600);
    }
  });
}

renderPack(pack);
