import { XMLParser } from "fast-xml-parser";
import { config } from "./config.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  textNodeName: "text"
});

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
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
  const haystack = [
    car.brand,
    car.model,
    car.version,
    car.fuel,
    car.gearbox,
    car.description
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return terms.every((term) => haystack.includes(term.toLowerCase()));
}

function toNumber(value) {
  if (value === undefined || value === null) return undefined;
  const cleaned = String(value).replace(/[^\d]/g, "");
  return cleaned ? Number(cleaned) : undefined;
}

export async function fetchInventory() {
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
    return asArray(json).map(normalizeAd);
  }

  const document = parser.parse(trimmed);
  return flattenAds(document).map(normalizeAd);
}

export async function searchInventory(filters = {}) {
  const cars = await fetchInventory();
  const terms = [
    filters.brand,
    filters.model,
    filters.bodyType,
    filters.fuel,
    filters.gearbox,
    filters.keyword
  ].filter(Boolean);

  const maxBudget = toNumber(filters.maxBudget);
  const maxMileage = toNumber(filters.maxMileage);
  const minYear = toNumber(filters.minYear);

  return cars
    .filter((car) => matchesText(car, terms))
    .filter((car) => !maxBudget || !toNumber(car.price) || toNumber(car.price) <= maxBudget)
    .filter((car) => !maxMileage || !toNumber(car.mileage) || toNumber(car.mileage) <= maxMileage)
    .filter((car) => !minYear || !toNumber(car.year) || toNumber(car.year) >= minYear)
    .slice(0, 6);
}
