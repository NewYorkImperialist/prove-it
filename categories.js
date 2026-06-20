/* ============================================================================
 * Prove It! — game content
 * ----------------------------------------------------------------------------
 * This is the ONLY file you edit to add categories & answers. No code changes
 * needed. It's loaded as a plain <script> (works when you just open index.html
 * — no server required).
 *
 * STRUCTURE:  group → categories → items
 *
 *   CATEGORY_GROUPS = {
 *     "GroupName": {                 // a broad group = one checkbox on the lobby
 *       emoji: "🎬",
 *       cats: [                      // specific categories; one is picked per round
 *         { name: "Category shown to the player", items: [ ...answers... ] },
 *       ],
 *     },
 *   }
 *
 * EACH ITEM is one of:
 *   "Canonical Name"                         → no aliases
 *   ["Canonical Name", "alias", "alias2"]    → all accepted, but count as ONE item
 *
 *   • The FIRST entry is the display name shown when the player gets it right.
 *   • Aliases let "cr7" / "ronaldo" / "cristiano ronaldo" all match one player.
 *   • Matching is case-, space-, and accent-insensitive ("mbappe" matches "Mbappé"),
 *     so you usually don't need plain-text aliases for accents.
 *
 * OPTIONAL per-category flag:
 *   • exact: true  → this is a complete, finite list (e.g. US States). On an
 *     over-claim the game may reveal the exact count. Omit it for open-ended
 *     categories (Car Brands, Rappers…) so the cap stays a generic "try again".
 *
 * TO ADD:
 *   • a category  → add a { name, items } object to a group's `cats` array
 *   • a group     → add a new top-level key with { emoji, cats: [...] }
 *   • answers     → add strings/alias-arrays to a category's `items` array
 * ========================================================================== */

const CATEGORY_GROUPS = {
  Sports: { emoji: "⚽", cats: [
    { name: "Football (Soccer) Players", items: [
      ["Lionel Messi","messi","leo messi"], ["Cristiano Ronaldo","ronaldo","cristiano ronaldo","cr7"], "Neymar",
      ["Kylian Mbappé","mbappe","kylian mbappe"], ["Erling Haaland","haaland","erling haaland"], "Benzema",
      ["Luka Modrić","modric"], ["Kevin De Bruyne","de bruyne","kevin de bruyne"], "Lewandowski",
      ["Mohamed Salah","salah","mo salah"], ["Harry Kane","kane","harry kane"], ["Luis Suárez","suarez"],
      "Griezmann", "Pogba", ["Sergio Ramos","ramos","sergio ramos"], "Iniesta", "Xavi", "Zidane", "Ronaldinho",
      ["Pelé","pele"], "Maradona", "Beckham", "Rooney", "Henry", "Drogba", ["Kaká","kaka"], ["Vinícius","vinicius"],
      "Bellingham", ["Heung-min Son","son","heung-min son"], "Kroos", "Busquets",
      ["Thomas Müller","muller","thomas muller"], "Sterling", "Mahrez", "Dybala",
    ]},
    { name: "NBA Players", items: [
      ["LeBron James","lebron","lebron james"], ["Stephen Curry","curry","stephen curry","steph curry"],
      ["Kevin Durant","durant","kevin durant"], "Giannis", ["Nikola Jokić","jokic","nikola jokic"], "Embiid",
      ["Luka Dončić","luka","luka doncic"], ["Kawhi Leonard","kawhi","kawhi leonard"], ["James Harden","harden","james harden"],
      "Westbrook", ["Jayson Tatum","tatum","jayson tatum"], ["Kyrie Irving","kyrie","kyrie irving"],
      ["Damian Lillard","lillard","damian lillard"], "Anthony Davis", ["Kobe Bryant","kobe","kobe bryant"],
      ["Michael Jordan","jordan","michael jordan"], "Shaq", ["Tim Duncan","duncan","tim duncan"],
      ["Dirk Nowitzki","dirk","dirk nowitzki"], ["Dwyane Wade","wade","dwyane wade"], "Paul George", "Chris Paul",
      ["Devin Booker","booker","devin booker"], "Ja Morant", "Zion",
    ]},
  ]},
  Geography: { emoji: "🌍", cats: [
    { name: "Countries in Europe", items: [
      "France","Germany","Spain","Italy","Portugal",
      ["United Kingdom","uk","united kingdom","britain","great britain","england","scotland","wales"],
      "Ireland","Netherlands","Belgium","Switzerland","Austria","Poland","Sweden","Norway","Finland","Denmark","Iceland",
      "Greece","Turkey","Russia","Ukraine","Belarus", ["Czechia","czechia","czech republic"], "Slovakia","Hungary",
      "Romania","Bulgaria","Croatia","Serbia","Slovenia", ["Bosnia and Herzegovina","bosnia and herzegovina","bosnia"],
      "Montenegro", ["North Macedonia","north macedonia","macedonia"], "Kosovo","Albania","Estonia","Latvia","Lithuania",
      "Luxembourg","Malta","Cyprus","Moldova","Andorra","Liechtenstein","Monaco","San Marino",
      ["Vatican City","vatican city","vatican"],
    ]},
    { name: "US State Capitals", exact: true, items: [
      "Sacramento","Austin","Albany","Tallahassee","Springfield","Columbus","Atlanta","Denver","Boston","Phoenix",
      "Nashville","Raleigh","Madison","Lansing", ["Saint Paul","saint paul","st paul"], "Jefferson City",
      "Oklahoma City","Salt Lake City","Carson City","Boise","Helena","Cheyenne","Bismarck","Pierre","Topeka",
      "Lincoln","Des Moines","Indianapolis","Frankfort","Montgomery","Jackson","Baton Rouge","Little Rock",
      "Richmond","Annapolis","Dover","Trenton","Harrisburg","Hartford","Providence","Augusta","Concord",
      "Montpelier","Olympia","Salem","Honolulu","Juneau","Santa Fe","Columbia","Charleston",
    ]},
    { name: "US States", exact: true, items: [
      "Alabama","Alaska","Arizona","Arkansas","California","Colorado","Connecticut","Delaware","Florida","Georgia",
      "Hawaii","Idaho","Illinois","Indiana","Iowa","Kansas","Kentucky","Louisiana","Maine","Maryland",
      "Massachusetts","Michigan","Minnesota","Mississippi","Missouri","Montana","Nebraska","Nevada","New Hampshire",
      "New Jersey","New Mexico","New York","North Carolina","North Dakota","Ohio","Oklahoma","Oregon","Pennsylvania",
      "Rhode Island","South Carolina","South Dakota","Tennessee","Texas","Utah","Vermont","Virginia","Washington",
      "West Virginia","Wisconsin","Wyoming",
    ]},
    { name: "World Capitals", items: [
      ["Kabul","kabul"], ["Tirana","tirana"], ["Algiers","algiers"], ["Andorra la Vella","andorra la vella"], "Luanda",
      ["Saint John's","saint john's","st john's","st. john's"], "Buenos Aires", "Yerevan", "Canberra", "Vienna", "Baku",
      "Nassau", "Manama", ["Dhaka","dhaka","dacca"], "Bridgetown", "Minsk", "Brussels", "Belmopan",
      ["Porto-Novo","porto-novo","porto novo","cotonou"], "Thimphu", ["Sucre","sucre","la paz"], "Sarajevo", "Gaborone",
      "Brasília", "Bandar Seri Begawan", "Sofia", "Ouagadougou", ["Gitega","gitega","bujumbura"], "Praia", "Phnom Penh",
      "Yaoundé", "Ottawa", "Bangui", ["N'Djamena","n'djamena","ndjamena"], "Santiago", ["Beijing","beijing","peking"],
      "Bogotá", "Moroni", "Brazzaville", "Kinshasa", "San José", ["Yamoussoukro","yamoussoukro","abidjan"], "Zagreb",
      "Havana", "Nicosia", "Prague", "Copenhagen", ["Djibouti","djibouti","djibouti city"], "Roseau", "Santo Domingo",
      "Quito", "Cairo", "San Salvador", "Malabo", "Asmara", "Tallinn", ["Mbabane","mbabane","lobamba"], "Addis Ababa",
      "Suva", "Helsinki", "Paris", "Libreville", "Banjul", "Tbilisi", "Berlin", "Accra", "Athens",
      ["Saint George's","saint george's","st george's","st. george's"], "Guatemala City", "Conakry", "Bissau",
      "Georgetown", ["Port-au-Prince","port-au-prince","port au prince"], "Tegucigalpa", "Budapest",
      "Reykjavík", ["New Delhi","new delhi","delhi"], ["Jakarta","jakarta","nusantara"], "Tehran", "Baghdad", "Dublin",
      "Jerusalem", "Rome", "Kingston", "Tokyo", "Amman", ["Astana","astana","nur-sultan","nur sultan","akmola"], "Nairobi",
      ["Tarawa","tarawa","south tarawa"], "Pyongyang", "Seoul", "Pristina", "Kuwait City", ["Bishkek","bishkek","frunze"],
      "Vientiane", "Riga", "Beirut", "Maseru", "Monrovia", "Tripoli", "Vaduz", "Vilnius",
      ["Luxembourg","luxembourg","luxembourg city"], "Antananarivo", "Lilongwe", ["Kuala Lumpur","kuala lumpur","putrajaya"],
      "Malé", "Bamako", "Valletta", "Majuro", "Nouakchott", "Port Louis", "Mexico City", "Palikir",
      ["Chișinău","chisinau","kishinev"], "Monaco", ["Ulaanbaatar","ulaanbaatar","ulan bator"], "Podgorica", "Rabat",
      "Maputo", ["Naypyidaw","naypyidaw","nay pyi taw","naypyitaw"], "Windhoek", "Yaren", "Kathmandu", "Amsterdam",
      "Wellington", "Managua", "Niamey", "Abuja", "Skopje", "Oslo", "Muscat", "Islamabad", "Ngerulmud", "Panama City",
      "Port Moresby", "Asunción", "Lima", "Manila", "Warsaw", "Lisbon", "Doha", "Bucharest", "Moscow", "Kigali",
      "Basseterre", "Castries", "Kingstown", "Apia", ["San Marino","san marino","city of san marino"], "São Tomé",
      "Riyadh", "Dakar", "Belgrade", "Victoria", "Freetown", "Singapore", "Bratislava", "Ljubljana", "Honiara", "Mogadishu",
      ["Pretoria","pretoria","cape town","bloemfontein"], "Juba", "Madrid",
      ["Sri Jayawardenepura Kotte","sri jayawardenepura kotte","colombo","kotte"], "Khartoum", "Paramaribo", "Stockholm",
      ["Bern","bern","berne"], "Damascus", "Dushanbe", ["Dodoma","dodoma","dar es salaam"], "Bangkok", "Dili", "Lomé",
      ["Nuku'alofa","nuku'alofa","nukualofa"], ["Port of Spain","port of spain","port-of-spain"], "Tunis", "Ankara",
      "Ashgabat", "Funafuti", "Kampala", ["Kyiv","kyiv","kiev"], "Abu Dhabi", "London",
      ["Washington, D.C.","washington","washington dc","washington d.c."], "Montevideo", "Tashkent", "Port Vila",
      ["Vatican City","vatican city","vatican"], "Caracas", "Hanoi", ["Sanaa","sanaa","sana'a"], "Lusaka", "Harare",
    ]},
    { name: "Countries in Asia", items: [
      "China","India","Japan","South Korea","North Korea","Vietnam","Thailand","Cambodia","Laos","Myanmar","Malaysia",
      "Singapore","Indonesia","Philippines","Mongolia","Kazakhstan","Uzbekistan","Turkmenistan","Kyrgyzstan","Tajikistan",
      "Afghanistan","Pakistan","Bangladesh","Sri Lanka","Nepal","Bhutan","Iran","Iraq","Saudi Arabia","Yemen","Oman",
      ["United Arab Emirates","uae","united arab emirates"], "Qatar","Bahrain","Kuwait","Jordan","Israel","Lebanon",
      "Syria","Turkey","Georgia","Armenia","Azerbaijan","Brunei","Taiwan","Maldives",
    ]},
    { name: "Countries in Africa", exact: true, items: [
      "Algeria","Angola","Benin","Botswana","Burkina Faso","Burundi", ["Cabo Verde","cabo verde","cape verde"],
      "Cameroon", ["Central African Republic","central african republic","car"], "Chad","Comoros",
      ["Republic of the Congo","republic of the congo","congo-brazzaville","congo brazzaville"],
      ["DR Congo","dr congo","democratic republic of the congo","drc","congo-kinshasa","congo kinshasa"],
      ["Côte d'Ivoire","cote d'ivoire","cote divoire","ivory coast"], "Djibouti","Egypt","Equatorial Guinea","Eritrea",
      ["Eswatini","eswatini","swaziland"], "Ethiopia","Gabon", ["The Gambia","the gambia","gambia"], "Ghana","Guinea",
      ["Guinea-Bissau","guinea-bissau","guinea bissau"], "Kenya","Lesotho","Liberia","Libya","Madagascar","Malawi","Mali",
      "Mauritania","Mauritius","Morocco","Mozambique","Namibia","Niger","Nigeria","Rwanda",
      ["São Tomé and Príncipe","sao tome and principe","sao tome"], "Senegal","Seychelles","Sierra Leone","Somalia",
      "South Africa","South Sudan","Sudan","Tanzania","Togo","Tunisia","Uganda","Zambia","Zimbabwe",
    ]},
    { name: "Countries in South America", exact: true, items: [
      "Brazil","Argentina","Chile","Peru","Colombia","Venezuela","Ecuador","Bolivia","Paraguay","Uruguay","Guyana","Suriname",
    ]},
    { name: "Natural Disasters", items: [
      "Earthquake","Tsunami","Hurricane","Tornado","Flood", ["Wildfire","wildfire","forest fire"],
      ["Volcanic Eruption","volcanic eruption","volcano","eruption"], "Drought","Blizzard","Landslide","Avalanche",
      "Mudslide","Cyclone","Typhoon","Hailstorm","Sinkhole","Heatwave","Thunderstorm", ["Tropical Storm","tropical storm"],
      "Famine", ["Sandstorm","sandstorm","dust storm"], "Ice Storm","Storm Surge","Lightning Strike",
    ]},
    { name: "Major Rivers", items: [
      "Nile", ["Amazon","amazon","amazon river"], ["Yangtze","yangtze","yangtze river"],
      ["Mississippi","mississippi","mississippi river"], "Danube","Volga","Ganges","Mekong","Congo","Rhine","Niger",
      "Yellow River", ["Yenisei","yenisei","yenisey"], "Ob", ["Paraná","parana"], "Amur","Lena","Murray","Indus",
      "Brahmaputra","Euphrates","Tigris","Zambezi","Colorado","Rio Grande","Seine","Thames","Tiber","Po","Yukon",
    ]},
    { name: "Famous Mountains", items: [
      ["Mount Everest","everest","mount everest"], "K2","Kangchenjunga", ["Kilimanjaro","kilimanjaro","mount kilimanjaro"],
      "Mont Blanc","Matterhorn", ["Denali","denali","mount mckinley"], ["Fuji","fuji","mount fuji","mt fuji"],
      "Aconcagua","Annapurna","Nanga Parbat","Eiger","Mount Rainier","Mount Etna","Mount Vesuvius","Mount Olympus",
      "Mount Elbrus","Mount Kosciuszko","Pikes Peak","Mount Whitney","Table Mountain","Half Dome","Ben Nevis","Mount Cook",
      "Mount Logan",
    ]},
    { name: "Deserts", items: [
      "Sahara","Gobi","Kalahari","Mojave","Atacama", ["Arabian Desert","arabian desert","arabian"], "Sonoran","Namib",
      "Thar","Patagonian Desert", ["Great Victoria Desert","great victoria desert","great victoria"],
      "Great Sandy Desert","Karakum","Kyzylkum","Taklamakan","Chihuahuan","Syrian Desert","Death Valley",
      "Antarctic Desert","Arctic Desert",
    ]},
    { name: "Seas and Oceans", items: [
      ["Pacific Ocean","pacific ocean","pacific"], ["Atlantic Ocean","atlantic ocean","atlantic"],
      ["Indian Ocean","indian ocean","indian"], ["Arctic Ocean","arctic ocean","arctic"],
      ["Southern Ocean","southern ocean","antarctic ocean"], ["Mediterranean Sea","mediterranean sea","mediterranean"],
      ["Caribbean Sea","caribbean sea","caribbean"], ["Red Sea","red sea"], ["Black Sea","black sea"],
      ["Baltic Sea","baltic sea","baltic"], ["Caspian Sea","caspian sea","caspian"], ["North Sea","north sea"],
      ["Arabian Sea","arabian sea"], ["South China Sea","south china sea"], ["East China Sea","east china sea"],
      ["Yellow Sea","yellow sea"], ["Sea of Japan","sea of japan"], ["Bering Sea","bering sea"], ["Coral Sea","coral sea"],
      ["Tasman Sea","tasman sea"], ["Sea of Okhotsk","sea of okhotsk"], ["Andaman Sea","andaman sea"],
      ["Adriatic Sea","adriatic sea","adriatic"], ["Aegean Sea","aegean sea","aegean"], ["Sargasso Sea","sargasso sea"],
    ]},
    { name: "Countries in Oceania", exact: true, items: [
      "Australia","New Zealand","Papua New Guinea","Fiji","Solomon Islands","Vanuatu","Samoa","Tonga","Kiribati",
      ["Micronesia","micronesia","federated states of micronesia","fsm"], ["Marshall Islands","marshall islands","marshalls"],
      "Palau","Nauru","Tuvalu",
    ]},
  ]},
  History: { emoji: "🏛️", cats: [
    { name: "US Presidents", items: [
      ["George Washington","george washington","washington"], ["John Adams","john adams","adams"],
      ["Thomas Jefferson","thomas jefferson","jefferson"], ["James Madison","james madison","madison"],
      ["James Monroe","james monroe","monroe"], ["Andrew Jackson","andrew jackson","jackson"],
      ["Abraham Lincoln","abraham lincoln","lincoln"], ["Ulysses S. Grant","ulysses s grant","ulysses grant","grant"],
      ["Theodore Roosevelt","theodore roosevelt","teddy roosevelt"],
      ["Franklin D. Roosevelt","franklin d roosevelt","franklin roosevelt","fdr"], ["Harry Truman","harry truman","truman"],
      ["Dwight Eisenhower","dwight eisenhower","eisenhower"], ["John F. Kennedy","john f kennedy","jfk","kennedy"],
      ["Lyndon B. Johnson","lyndon johnson","lbj"], ["Richard Nixon","richard nixon","nixon"],
      ["Gerald Ford","gerald ford","ford"], ["Jimmy Carter","jimmy carter","carter"],
      ["Ronald Reagan","ronald reagan","reagan"], ["George H. W. Bush","george h w bush","george bush sr"],
      ["Bill Clinton","bill clinton","clinton"], ["George W. Bush","george w bush","dubya"],
      ["Barack Obama","barack obama","obama"], ["Donald Trump","donald trump","trump"], ["Joe Biden","joe biden","biden"],
      ["Woodrow Wilson","woodrow wilson","wilson"], ["William Taft","william taft","taft"],
      ["Herbert Hoover","herbert hoover","hoover"], ["Calvin Coolidge","calvin coolidge","coolidge"],
      ["James Polk","james polk","polk"], ["William McKinley","william mckinley","mckinley"],
    ]},
    { name: "Wars in History", items: [
      ["World War I","world war i","world war 1","wwi","ww1","first world war"],
      ["World War II","world war ii","world war 2","wwii","ww2","second world war"],
      ["American Civil War","american civil war","civil war"],
      ["American Revolution","american revolution","revolutionary war"], "Cold War",
      ["Vietnam War","vietnam war","vietnam"], ["Korean War","korean war","korea"], "Gulf War", "War of 1812",
      "Napoleonic Wars", "Crimean War", ["Hundred Years' War","hundred years war","hundred years' war"],
      ["Thirty Years' War","thirty years war","thirty years' war"], ["Seven Years' War","seven years war"],
      "Spanish Civil War", "Boer War", "Iraq War", "Falklands War",
      ["Russo-Japanese War","russo-japanese war"], "Peloponnesian War",
    ]},
    { name: "Ancient Civilizations", items: [
      ["Roman Empire","roman empire","rome","romans","roman"], ["Ancient Greece","ancient greece","greece","greek","greeks"],
      ["Ancient Egypt","ancient egypt","egypt","egyptian","egyptians"], ["Mesopotamia","mesopotamia","mesopotamian"],
      ["Persian Empire","persian empire","persia","persian"], ["Maya","maya","mayan","mayans"], ["Aztec","aztec","aztecs"],
      ["Inca","inca","incan","incas"], ["Babylon","babylon","babylonian"], ["Sumer","sumer","sumerian","sumerians"],
      ["Assyria","assyria","assyrian"], ["Phoenicia","phoenicia","phoenician"],
      ["Byzantine Empire","byzantine empire","byzantine","byzantium"],
      ["Ottoman Empire","ottoman empire","ottoman","ottomans"], ["Mongol Empire","mongol empire","mongol","mongols"],
      ["Vikings","vikings","viking","norse"], ["Celts","celts","celtic"], ["Carthage","carthage","carthaginian"],
      ["Minoans","minoans","minoan"], ["Olmec","olmec","olmecs"], ["Hittites","hittites","hittite"],
    ]},
    { name: "Historical Figures", items: [
      ["Napoleon","napoleon","napoleon bonaparte"], ["Julius Caesar","julius caesar","caesar"], "Cleopatra",
      ["Alexander the Great","alexander the great"], ["Genghis Khan","genghis khan"],
      ["Abraham Lincoln","abraham lincoln","lincoln"], "George Washington", ["Winston Churchill","winston churchill","churchill"],
      ["Gandhi","gandhi","mahatma gandhi"], ["Martin Luther King Jr.","martin luther king","mlk"],
      ["Albert Einstein","albert einstein","einstein"], ["Isaac Newton","isaac newton","newton"], "Galileo",
      ["Leonardo da Vinci","leonardo da vinci","da vinci"], "Michelangelo",
      ["Christopher Columbus","christopher columbus","columbus"], ["Joan of Arc","joan of arc"], "Queen Victoria",
      ["Henry VIII","henry viii","henry the 8th"], "Marco Polo", "Confucius", "Aristotle", "Plato", "Socrates",
      ["William Shakespeare","william shakespeare","shakespeare"], ["Nelson Mandela","nelson mandela","mandela"],
      ["Benjamin Franklin","benjamin franklin","ben franklin"], ["Thomas Edison","thomas edison","edison"],
      ["Nikola Tesla","nikola tesla","tesla"], ["Charles Darwin","charles darwin","darwin"], "Marie Curie",
      ["Adolf Hitler","adolf hitler","hitler"], ["Joseph Stalin","joseph stalin","stalin"], ["Mao Zedong","mao zedong","mao"],
      ["Karl Marx","karl marx","marx"],
    ]},
    { name: "Famous Explorers", items: [
      ["Christopher Columbus","christopher columbus","columbus"], ["Ferdinand Magellan","ferdinand magellan","magellan"],
      ["Marco Polo","marco polo"], ["Vasco da Gama","vasco da gama","da gama"],
      ["James Cook","james cook","captain cook","cook"], ["Amerigo Vespucci","amerigo vespucci","vespucci"],
      ["Hernán Cortés","hernan cortes","cortes"], ["Francisco Pizarro","francisco pizarro","pizarro"],
      ["Leif Erikson","leif erikson","leif ericson"], ["Zheng He","zheng he"],
      ["Roald Amundsen","roald amundsen","amundsen"], ["Ernest Shackleton","ernest shackleton","shackleton"],
      ["Henry Hudson","henry hudson","hudson"], ["John Cabot","john cabot","cabot"],
      ["Bartolomeu Dias","bartolomeu dias","dias"], ["Francis Drake","francis drake","sir francis drake","drake"],
      ["Juan Ponce de León","ponce de leon"], ["Hernando de Soto","hernando de soto","de soto"],
      ["Jacques Cartier","jacques cartier","cartier"], ["David Livingstone","david livingstone","livingstone"],
      ["Ibn Battuta","ibn battuta"], ["Edmund Hillary","edmund hillary","hillary"],
      ["Tenzing Norgay","tenzing norgay","tenzing"], ["Lewis and Clark","lewis and clark"], ["Robert Peary","robert peary","peary"],
    ]},
    { name: "Famous Battles", items: [
      ["Hastings","hastings","battle of hastings"], ["Waterloo","waterloo","battle of waterloo"],
      ["Gettysburg","gettysburg","battle of gettysburg"], ["Stalingrad","stalingrad","battle of stalingrad"],
      ["D-Day","d-day","dday","normandy","battle of normandy"], ["Thermopylae","thermopylae","battle of thermopylae"],
      ["Agincourt","agincourt","battle of agincourt"], ["Battle of the Bulge","battle of the bulge","the bulge"],
      ["Midway","midway","battle of midway"], ["Trafalgar","trafalgar","battle of trafalgar"],
      ["Bunker Hill","bunker hill","battle of bunker hill"], ["Marathon","marathon","battle of marathon"],
      ["Battle of Britain","battle of britain"], ["Pearl Harbor","pearl harbor","pearl harbour"],
      ["The Somme","somme","battle of the somme"], ["Verdun","verdun","battle of verdun"],
      ["Antietam","antietam","battle of antietam"], ["Saratoga","saratoga","battle of saratoga"],
      ["Little Bighorn","little bighorn","battle of little bighorn","little big horn"],
      ["Yorktown","yorktown","battle of yorktown"], ["Cannae","cannae","battle of cannae"],
      ["Bannockburn","bannockburn","battle of bannockburn"],
    ]},
  ]},
  Entertainment: { emoji: "🎬", cats: [
    { name: "Disney / Pixar Movies", items: [
      "Frozen","Moana","Tangled","Encanto","Coco","Up", ["WALL-E","wall-e","wall e"], "Cars","Brave","Ratatouille",
      "Aladdin","Mulan","Cinderella","Bambi","Dumbo","Tarzan","Hercules","Pocahontas","Zootopia",
      ["The Lion King","lion king","the lion king"], "Toy Story","Finding Nemo","Monsters Inc","Inside Out","Luca",
      "Soul","Onward", ["The Incredibles","the incredibles","incredibles"], "Beauty and the Beast",
      ["The Little Mermaid","the little mermaid","little mermaid"], "Snow White","Sleeping Beauty","Peter Pan",
      "Pinocchio","Frozen 2","Big Hero 6",
    ]},
    { name: "Marvel Superheroes", items: [
      "Iron Man","Captain America","Thor","Hulk","Black Widow","Hawkeye", ["Spider-Man","spider-man","spiderman"],
      "Doctor Strange","Black Panther","Scarlet Witch","Vision", ["Ant-Man","ant-man","ant man"], "Wasp",
      ["Star-Lord","star-lord","star lord"], "Gamora","Groot","Rocket","Drax","Falcon","Winter Soldier",
      "Captain Marvel","Wolverine","Deadpool","Storm","Cyclops","Jean Grey","Magneto","Professor X","Daredevil",
      "Punisher","Loki","Nick Fury","War Machine","Quicksilver","Nebula","Mantis","Shang-Chi","Moon Knight",
    ]},
    { name: "Popular Movies", items: [
      "Titanic","Avatar","The Godfather","Jaws","Inception","Jurassic Park","Forrest Gump","Gladiator","Rocky",
      "Terminator", ["The Matrix","matrix","the matrix"], "Shrek", ["The Avengers","avengers","the avengers"],
      "Joker","Parasite","Pulp Fiction","Goodfellas","Casablanca","Interstellar","Dunkirk","La La Land","Whiplash",
      "Get Out", ["Star Wars","star wars"], "Top Gun","Grease","Ghostbusters","Alien","Predator","Die Hard",
      "Home Alone","Elf","Frozen","Toy Story","Avengers Endgame","Black Panther","Up","Coco","Moana","Gravity",
    ]},
    { name: "Star Wars Characters", items: [
      ["Luke Skywalker","luke","luke skywalker"], ["Darth Vader","vader","darth vader"],
      ["Princess Leia","leia","princess leia"], ["Han Solo","han","han solo"], ["Chewbacca","chewie","chewbacca"],
      "Yoda", ["Obi-Wan Kenobi","obi-wan","obi wan","obi-wan kenobi","kenobi"], ["R2-D2","r2-d2","r2d2"],
      ["C-3PO","c-3po","c3po"], ["Emperor Palpatine","palpatine","emperor palpatine"],
      ["Anakin Skywalker","anakin","anakin skywalker"], "Padmé", ["Qui-Gon Jinn","qui-gon","qui gon","qui-gon jinn"],
      "Mace Windu","Jar Jar Binks","Boba Fett","Jango Fett", ["Lando Calrissian","lando","lando calrissian"],
      "Rey","Finn", ["Poe Dameron","poe","poe dameron"], ["Kylo Ren","kylo","kylo ren"], ["BB-8","bb-8","bb8"],
      ["The Mandalorian","mando","the mandalorian","din djarin"], ["Grogu","grogu","baby yoda"],
      ["Ahsoka Tano","ahsoka","ahsoka tano"], "Count Dooku","General Grievous", ["Darth Maul","maul","darth maul"],
      ["Jabba the Hutt","jabba","jabba the hutt"],
    ]},
  ]},
  Food: { emoji: "🍕", cats: [
    { name: "Pizza Toppings", items: [
      "Pepperoni","Cheese", ["Mushroom","mushroom","mushrooms"], ["Onion","onion","onions"], "Sausage","Bacon",
      "Ham","Pineapple", ["Olives","olives","olive"], ["Peppers","peppers","green peppers","bell peppers"],
      ["Jalapeño","jalapeno","jalapenos","jalapeño"], "Spinach", ["Tomato","tomato","tomatoes"], "Basil","Anchovies",
      "Chicken","Beef","Garlic","Feta","Mozzarella","Prosciutto","Arugula","Corn","Artichoke","Pesto","Salami",
    ]},
    { name: "Fruits", items: [
      "Apple","Banana","Orange", ["Grape","grape","grapes"], "Strawberry","Blueberry","Raspberry","Blackberry",
      "Mango","Pineapple","Watermelon","Melon","Cantaloupe","Kiwi","Peach","Pear","Plum", ["Cherry","cherry","cherries"],
      "Lemon","Lime","Grapefruit","Pomegranate","Papaya","Guava","Apricot","Fig","Date","Coconut","Avocado",
      "Passion Fruit","Dragon Fruit","Lychee","Cranberry","Gooseberry","Nectarine","Tangerine","Clementine","Persimmon",
    ]},
    { name: "Vegetables", items: [
      "Carrot","Broccoli","Spinach","Lettuce","Kale","Cabbage","Cauliflower","Potato","Sweet Potato","Tomato",
      "Cucumber","Onion","Garlic", ["Bell Pepper","bell pepper","pepper"], "Celery","Asparagus","Zucchini","Eggplant",
      "Mushroom","Corn","Peas","Green Beans", ["Beet","beet","beets"], "Radish","Turnip","Brussels Sprouts","Artichoke",
      "Leek","Okra","Pumpkin","Squash","Parsnip","Arugula", ["Swiss Chard","chard","swiss chard"], "Bok Choy",
      "Fennel", ["Green Onion","green onion","scallion"], "Shallot",
    ]},
  ]},
  Animals: { emoji: "🐾", cats: [
    { name: "Wild Animals", items: [
      "Lion","Tiger","Elephant","Giraffe","Zebra", ["Rhinoceros","rhino","rhinoceros"],
      ["Hippopotamus","hippo","hippopotamus"], "Leopard","Cheetah","Gorilla","Chimpanzee","Monkey","Kangaroo","Koala",
      "Panda","Bear","Polar Bear","Wolf","Fox","Deer","Moose","Bison","Antelope","Hyena","Jaguar","Crocodile",
      "Alligator","Snake","Python","Cobra","Eagle","Hawk","Owl","Penguin","Ostrich","Flamingo","Peacock","Sloth",
      "Meerkat","Otter","Beaver","Raccoon","Hedgehog","Camel",
    ]},
    { name: "Dog Breeds", items: [
      "Labrador", ["Golden Retriever","golden retriever","golden"], "Poodle","Bulldog","Beagle",
      ["German Shepherd","german shepherd"], "Rottweiler","Dachshund","Chihuahua", ["Siberian Husky","husky","siberian husky"],
      "Boxer","Pug","Corgi","Dalmatian","Doberman","Great Dane", ["Shih Tzu","shih tzu"], "Pomeranian",
      ["Border Collie","border collie","collie"], "Australian Shepherd","Cocker Spaniel","Mastiff","Akita","Samoyed",
      "Bernese Mountain Dog","Chow Chow","Bichon Frise","St Bernard","Greyhound", ["Jack Russell","jack russell"],
      ["Pit Bull","pit bull","pitbull"], "Schnauzer","Maltese","Shiba Inu","Basset Hound","Vizsla","Weimaraner","Whippet",
    ]},
  ]},
  Music: { emoji: "🎵", cats: [
    { name: "Rappers", items: [
      "Drake", ["Kendrick Lamar","kendrick","kendrick lamar"], ["Kanye West","kanye","kanye west","ye"], "Eminem",
      ["Jay-Z","jay-z","jay z"], "Lil Wayne","Nicki Minaj","Travis Scott", ["J. Cole","j cole","j. cole"],
      "Post Malone","Cardi B","21 Savage","Future","Tyler the Creator", ["Snoop Dogg","snoop","snoop dogg"],
      ["Dr. Dre","dr dre","dr. dre","dre"], "50 Cent","Nas", ["Notorious B.I.G.","biggie","notorious big","biggie smalls"],
      ["Tupac","tupac","2pac"], "Ice Cube","Megan Thee Stallion","Doja Cat", ["A$AP Rocky","asap rocky","a$ap rocky"],
      "Lil Baby","DaBaby","Gunna","Metro Boomin","Childish Gambino","Mac Miller","Logic","Big Sean","Wiz Khalifa",
      "Ludacris","Busta Rhymes","Rick Ross", ["Juice WRLD","juice wrld"],"Lil Uzi Vert",
    ]},
    { name: "Pop Stars", items: [
      "Taylor Swift", ["Beyoncé","beyonce"], "Ariana Grande","Billie Eilish","Dua Lipa","Ed Sheeran","Justin Bieber",
      "Bruno Mars","Lady Gaga","Adele","Rihanna","Katy Perry", ["The Weeknd","the weeknd","weeknd"], "Harry Styles",
      "Olivia Rodrigo","Sabrina Carpenter","Miley Cyrus","Selena Gomez","Shawn Mendes","Sam Smith","Sia",
      ["Pink","pink","p!nk"], "Charlie Puth","Demi Lovato","Lizzo","Halsey","Camila Cabello","John Legend",
      "Michael Jackson","Madonna","Whitney Houston","Mariah Carey","Elton John","Justin Timberlake",
      "Christina Aguilera","Britney Spears",
    ]},
  ]},
  Brands: { emoji: "🏷️", cats: [
    { name: "Car Brands", items: [
      "Toyota","Honda","Ford", ["Chevrolet","chevrolet","chevy"], "BMW",
      ["Mercedes-Benz","mercedes","mercedes-benz","mercedes benz"], "Audi", ["Volkswagen","volkswagen","vw"], "Nissan",
      "Hyundai","Kia","Mazda","Subaru","Lexus","Jeep","Dodge","Chrysler","Ram","GMC","Buick","Cadillac","Tesla",
      "Porsche","Ferrari","Lamborghini","Maserati","Bentley", ["Rolls-Royce","rolls royce","rolls-royce"],
      "Aston Martin","Jaguar","Land Rover","Volvo","Mini","Fiat","Alfa Romeo","Mitsubishi","Acura","Infiniti",
      "Lincoln","Bugatti","McLaren","Peugeot","Renault",
    ]},
    { name: "Tech Companies", items: [
      "Apple","Google","Microsoft","Amazon", ["Meta","meta","facebook"], "Netflix","Tesla","Nvidia","Intel","AMD",
      "Samsung","Sony","IBM","Oracle","Adobe","Salesforce","Spotify","Uber","Airbnb", ["Twitter","twitter","x"],
      "Snapchat","TikTok","Dell","HP","Lenovo","Cisco","Qualcomm","PayPal","Zoom","Dropbox","Reddit","Pinterest",
      "LinkedIn","eBay","Shopify","Slack","Twitch","YouTube","Instagram","WhatsApp",
    ]},
  ]},
};
