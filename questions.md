# Question Pack Specification

This file defines how to author and validate trivia question packs for the two-player game. It is intended to be exported as `agent.md` for other projects.

## Pack structure
- **Format:** JSON object with a `rounds` array of exactly five rounds. Packs may also appear nested inside larger JSON/TXT blobs; only the inner structure matters.
- **Rounds:** Each round contains six questions in an `items` array. The first three become `hostItems` for Daniel, the last three become `guestItems` for Jaime.
- **Total questions:** 30 per pack (6 per round). Empty slots are not allowed.
- **Question shape (lenient):**
  - `question` (string) — or synonyms `prompt`, `text`, `card`.
  - `correct_answer` (string) — or synonyms `answer`, `correct`, `solution`.
  - `distractors` (object) with `easy`, `medium`, `hard` strings **or** any mix of wrong answers in arrays/option lists; the game normalises into three distractors.
  - Optional: `subject`/`category`/`topic`, `difficulty_tier`/`difficulty`/`tier`/`level`, `explanation`/`note`/`comment`, `id`/`uid`.
- **Interludes (optional):** `interludes` can be attached per round (array of short strings).
- **Room codes:** Must **not** be included in packs; they are generated only when a game starts.

## Validation guidance
Key Room accepts the following shapes and normalises them before seeding Firestore:
- Rounds can be an ordered array or an object keyed by round numbers.
- Every round must yield exactly six valid questions; otherwise the pack is rejected.
- Each question needs a non-empty prompt and correct answer. Distractors are auto-derived when missing or duplicated.
- Extra metadata is tolerated and preserved where possible. Pack-level `notes` are kept if present.

## Topic guidance (optional)
Packs do **not** need to fit a single category, but authors can draw inspiration from these topic tiers:

- **Tier 1: The Universal & Broad** — broad academic subjects and fundamentals (Science & Nature: astronomy, forces, periodic table, geology, meteorology, oceans, arithmetic/geometry, botany, human body, genetics; Geography: continents, mountain ranges, longest rivers, capitals, flags, currencies, time zones, deserts; History: ancient civilisations through the digital revolution; Arts & Literature: mythology, art movements, composers, religions, philosophy, genres, Nobel winners, Shakespeare tragedies; Social Science & General Knowledge: government, economics, international organisations, basic legal terms, famous experiments, cultural norms, languages, Greek alphabet, Roman numerals, cooking techniques).
- **Tier 2: Regional & Categorical** — UK & Americas geography (counties of England, US states/capitals, Central America, Panama Canal, River Thames, Amazon, Scottish Highlands, Caribbean islands, London landmarks, Panama geography); Animal kingdom (mammals, birds of prey, reptiles/amphibians, sharks/whales, insects, wild/domestic cats, dogs, British countryside wildlife, neotropics, endangered species, dinosaurs, farm animals, marsupials); UK history & monarchy (Tudor to Windsor, Henry VIII, Victorian inventions, Hastings, Great Fire, Blitz, prime ministers, empire, Gunpowder Plot); Science & technology (hardware basics, internet, mobile history, Apollo, scientists, renewable energy, automotive, aviation, AI, noble gases); Literature (Dickens, Austen, American classics, Romantics, children’s literature).
- **Tier 3: Pop Culture & Entertainment** — music (Beatles, 70s rock, 80s pop/British Invasion, 90s Britpop/boy bands/girl groups, 2000s indie, modern pop divas, one-hit wonders, Eurovision, Bond themes, musical theatre, hip hop, electronic, guitarists); cinema (Oscar Best Picture, Disney classics, Pixar, Spielberg, Hitchcock, Star Wars, MCU, Harry Potter, LOTR, 80s cult films, rom-coms, horror villains, directors, British actors, silent cinema); television (classic US/UK sitcoms, Simpsons, Game of Thrones, Doctor Who, reality TV, US crime dramas, British panel shows, SNL, 90s cartoons).
- **Tier 4: Specific & Niche** — specific history/events (Titanic, moon landing, Panama Canal construction, Profumo affair, suffragettes, US Civil War battles, Soviet dissolution, Magna Carta, 1966 World Cup, Y2K); food & drink (British puddings, French cuisine terms, pasta shapes, spices/herbs, European cheeses, wine regions, cocktails, biscuits, chocolate brands, fast food mascots); sports (Premier League records, World Cup hosts/winners, Wimbledon champions, F1 champions, The Ashes, Olympics, boxing, American sports rules, golf majors, snooker legends); specific science/tech (space missions, Apple history, game consoles, programming languages, cloud types, vitamins/minerals, the human eye, engineering landmarks, measurement units, Nobel Physics).
- **Tier 5: Micro-Niche & Silly** — cats (internet cats, Cats musical, cartoon cats, coat patterns, Hemingway cats, hybrids); specific TV/film trivia (Friends supporting characters, Bond gadgets, GoT deaths, The Office quotes, MCU cameos, Oscar blunders, fictional addresses, Doctor Who villains, Nicolas Cage roles); British quirks (Tube stations, Mornington Crescent, discontinued chocolates, Blue Peter presenters, Shipping Forecast, slang, Highway Code, pantomime traditions, accents); Panama/UK connections (Panama Canal ships, Caribbean pirates, Paddington Bear, tropical fruits); random & playful (collective nouns, phobias, board games, Pokémon, logos, celebrity real names, one-word movie titles, moustaches, palindromes, nursery rhymes, emojis, keyboard shortcuts, ad jingles, paper sizes, NATO alphabet, wedding anniversaries, seven wonders).
