import { XMLParser } from "fast-xml-parser";
import { config } from "./config.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  textNodeName: "text"
});

const inventoryCache = {
  expiresAt: 0,
  cars: null
};

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function compactText(value) {
  return normalizeText(value).replace(/\s+/g, "");
}

function normalizeAd(raw) {
  return {
    id: firstDefined(raw.id, raw.ID, raw.code, raw.codice),
    brand: firstDefined(raw.make, raw.marca, raw.brand),
    model: firstDefined(raw.model, raw.modello),
    version: firstDefined(raw.version, raw.versione, raw.allestimento),
    price: firstDefined(raw.price, raw.prezzo, raw.sell_price),
    mileage: firstDefined(raw.mileage, raw.km, raw.chilometri),
    year: firstDefined(raw.year, raw.anno, raw.immatricolazione, raw.first_registration_date),
    fuel: firstDefined(raw.fuel, raw.alimentazione, raw.fuel_type),
    gearbox: firstDefined(raw.gearbox, raw.cambio),
    color: firstDefined(raw.color, raw.colore),
    powerCv: firstDefined(raw.power_cv, raw.cv, raw.cavalli, raw.hp, raw.horsepower),
    description: firstDefined(raw.description, raw.descrizione, raw.note),
    raw
  };
}

function flattenAds(document) {
  const possibleRoots = [
    document?.data?.ad,
    document?.ads?.ad,
    document?.vehicles?.vehicle,
    document?.annunci?.annuncio,
    document?.xml?.ad
  ];

  for (const root of possibleRoots) {
    const ads = asArray(root);
    if (ads.length) return ads;
  }

  const values = Object.values(document || {});
  for (const value of values) {
    if (value && typeof value === "object") {
      const nested = flattenAds(value);
      if (nested.length) return nested;
    }
  }

  return [];
}

function matchesText(car, terms) {
  if (!terms.length) return true;
  const haystack = normalizeText([
    car.brand,
    car.model,
    car.version,
    car.fuel,
    car.gearbox,
    car.description,
    car.raw?.title
  ]
    .filter(Boolean)
    .join(" "));
  const compactHaystack = compactText(haystack);

  return terms.every((term) => {
    const normalizedTerm = normalizeText(term);
    if (!normalizedTerm) return true;
    return haystack.includes(normalizedTerm) || compactHaystack.includes(compactText(normalizedTerm));
  });
}

function fieldIncludes(value, term) {
  const normalizedValue = normalizeText(value);
  const normalizedTerm = normalizeText(term);
  if (!normalizedTerm) return true;
  return normalizedValue.includes(normalizedTerm) || compactText(normalizedValue).includes(compactText(normalizedTerm));
}

function carMatchesBrand(car, brand) {
  return !brand || fieldIncludes(car.brand, brand);
}

function carMatchesModel(car, model) {
  if (!model) return true;
  return fieldIncludes(car.model, model) || fieldIncludes(car.raw?.title, model);
}

function scoreText(car, terms) {
  if (!terms.length) return 1;
  const haystack = normalizeText([
    car.brand,
    car.model,
    car.version,
    car.fuel,
    car.gearbox,
    car.description,
    car.raw?.title
  ].filter(Boolean).join(" "));
  const compactHaystack = compactText(haystack);

  return terms.reduce((score, term) => {
    const normalizedTerm = normalizeText(term);
    if (!normalizedTerm) return score;
    if (haystack.includes(normalizedTerm) || compactHaystack.includes(compactText(normalizedTerm))) {
      return score + 1;
    }
    return score;
  }, 0);
}

function toNumber(value) {
  if (value === undefined || value === null) return undefined;
  const cleaned = String(value).replace(/[^\d]/g, "");
  return cleaned ? Number(cleaned) : undefined;
}

function cleanYear(value) {
  const text = String(value || "").trim();
  const match = text.match(/\b(19|20)\d{2}\b/);
  return match ? match[0] : text;
}

function cleanSpokenText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function smallItalianNumber(value) {
  const number = Number(value);
  const words = {
    1: "uno",
    2: "due",
    3: "tre",
    4: "quattro",
    5: "cinque",
    6: "sei",
    7: "sette",
    8: "otto",
    9: "nove",
    10: "dieci",
    11: "undici",
    12: "dodici",
    13: "tredici",
    14: "quattordici",
    15: "quindici",
    16: "sedici",
    17: "diciassette",
    18: "diciotto",
    19: "diciannove",
    20: "venti",
    21: "ventuno",
    22: "ventidue",
    23: "ventitre",
    24: "ventiquattro",
    25: "venticinque",
    26: "ventisei",
    27: "ventisette",
    28: "ventotto",
    29: "ventinove",
    30: "trenta",
    31: "trentuno",
    32: "trentadue",
    33: "trentatre",
    34: "trentaquattro",
    35: "trentacinque",
    36: "trentasei",
    37: "trentasette",
    38: "trentotto",
    39: "trentanove",
    100: "cento"
  };
  if (words[number]) return words[number];
  if (number > 30 && number < 100) {
    const tensWords = {
      3: "trenta",
      4: "quaranta",
      5: "cinquanta",
      6: "sessanta",
      7: "settanta",
      8: "ottanta",
      9: "novanta"
    };
    const tens = Math.floor(number / 10);
    const unit = number % 10;
    if (!unit) return tensWords[tens];
    return `${tensWords[tens]} ${words[unit]}`;
  }
  if (number > 100 && number < 200) {
    const rest = number - 100;
    return rest ? `cento ${smallItalianNumber(rest)}` : "cento";
  }
  return String(number);
}

function spokenModelText(value) {
  const text = cleanSpokenText(value);
  const digitWords = {
    1: "uno",
    2: "due",
    3: "tre",
    4: "quattro",
    5: "cinque",
    6: "sei",
    7: "sette",
    8: "otto",
    9: "nove"
  };
  return text
    .replace(/\b([AQX])\s*([1-9])\b/gi, (_, letter, digit) => `${letter.toUpperCase()} ${digitWords[digit]}`)
    .replace(/\bGLA\b/gi, "G L A")
    .replace(/\bGLB\b/gi, "G L B")
    .replace(/\bGLC\b/gi, "G L C")
    .replace(/\bGLE\b/gi, "G L E")
    .replace(/\bGLS\b/gi, "G L S")
    .replace(/\s+/g, " ")
    .trim();
}

function spokenMileage(value) {
  const km = toNumber(value);
  if (!km) return "";
  const thousands = Math.max(1, Math.floor(km / 1000));
  return `Circa ${smallItalianNumber(thousands)} mila chilometri`;
}

function spokenPrice(value) {
  const price = toNumber(value);
  if (!price) return "";
  const thousands = Math.floor(price / 1000);
  const rest = price % 1000;
  if (rest === 0) return `${thousands} mila euro`;
  return `${thousands} mila ${rest} euro`;
}

function spokenPower(value) {
  const power = toNumber(value);
  return power ? `${power} cavalli` : "";
}

function publicCar(car) {
  const brand = cleanSpokenText(car.brand);
  const model = spokenModelText(car.model);
  const year = cleanYear(car.year);
  const mileageText = spokenMileage(car.mileage);
  const priceText = spokenPrice(car.price);
  const color = cleanSpokenText(car.color);
  const gearbox = cleanSpokenText(car.gearbox);
  const fuel = cleanSpokenText(car.fuel);
  const powerText = spokenPower(car.powerCv);
  const spokenLine = [
    [brand, model].filter(Boolean).join(" "),
    year ? `Anno ${year}` : "",
    mileageText,
    priceText ? `Prezzo ${priceText}` : ""
  ].filter(Boolean).join(". ");
  const shortDetailLine = [
    year ? `Anno ${year}` : "",
    mileageText,
    priceText ? `Prezzo ${priceText}` : ""
  ].filter(Boolean).join(". ");
  const detailLine = [
    spokenLine,
    color ? `Colore ${color}` : "",
    gearbox ? `Cambio ${gearbox}` : "",
    fuel ? `Carburante ${fuel}` : "",
    powerText ? `Potenza ${powerText}` : ""
  ].filter(Boolean).join(". ");
  const intro = model || [brand, model].filter(Boolean).join(" ") || "questa auto";

  return {
    intro,
    spokenLine,
    shortDetailLine,
    detailLine
  };
}

export async function fetchInventory() {
  if (inventoryCache.cars && Date.now() < inventoryCache.expiresAt) {
    return inventoryCache.cars;
  }

  const url = new URL("https://motori.multigestionale.com/api/");
  url.searchParams.set("cc", config.multigestionale.userApi);
  url.searchParams.set("engine", config.multigestionale.engine);
  url.searchParams.set("show", "all");
  url.searchParams.set("showads", "1");

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`MultiGestionale error: ${response.status}`);
  }

  const xml = await response.text();
  const trimmed = xml.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const json = JSON.parse(trimmed);
    inventoryCache.cars = asArray(json).map(normalizeAd);
    inventoryCache.expiresAt = Date.now() + 3 * 60 * 1000;
    return inventoryCache.cars;
  }

  const document = parser.parse(trimmed);
  inventoryCache.cars = flattenAds(document).map(normalizeAd);
  inventoryCache.expiresAt = Date.now() + 3 * 60 * 1000;
  return inventoryCache.cars;
}

function filterInventory(cars, filters = {}) {
  const brand = filters.brand;
  const model = filters.model;
  const terms = [
    filters.bodyType,
    filters.fuel,
    filters.gearbox,
    filters.keyword
  ].filter(Boolean);

  const maxBudget = toNumber(filters.maxBudget);
  const maxMileage = toNumber(filters.maxMileage);
  const minYear = toNumber(filters.minYear);

  const filtered = cars
    .filter((car) => carMatchesBrand(car, brand))
    .filter((car) => carMatchesModel(car, model))
    .filter((car) => matchesText(car, terms))
    .filter((car) => !maxBudget || !toNumber(car.price) || toNumber(car.price) <= maxBudget)
    .filter((car) => !maxMileage || !toNumber(car.mileage) || toNumber(car.mileage) <= maxMileage)
    .filter((car) => !minYear || !toNumber(car.year) || toNumber(car.year) >= minYear);

  if (brand || model) return filtered;

  const relaxed = filtered.length ? filtered : cars
    .map((car) => ({ car, score: scoreText(car, terms) }))
    .filter((item) => item.score > 0)
    .filter((item) => !maxBudget || !toNumber(item.car.price) || toNumber(item.car.price) <= maxBudget)
    .filter((item) => !maxMileage || !toNumber(item.car.mileage) || toNumber(item.car.mileage) <= maxMileage)
    .filter((item) => !minYear || !toNumber(item.car.year) || toNumber(item.car.year) >= minYear)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.car);

  return relaxed;
}

export async function searchInventoryDetailed(filters = {}, limit = 5) {
  const cars = await fetchInventory();
  const matches = filterInventory(cars, filters);
  return {
    results: matches.slice(0, limit).map(publicCar),
    count: matches.length,
    totalAvailable: cars.length
  };
}

export async function searchInventory(filters = {}) {
  const detailed = await searchInventoryDetailed(filters);
  return detailed.results;
}
