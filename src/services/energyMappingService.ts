import {
  getValue,
  getValues,
  getValueByColumn,
  findValueWithText,
  mapPeriodeConstruction,
  mapTypeEnergie,
  mapTypeAppareilChauffage,
  isIleDeFrance,
  mapOccupancyStatusToLabel,
  mapTypeVitrageToLabel,
  mapMatMenuiserieToLabel,
  mapVentilationCodeToLabel,
  mapSystemeEcsToLabel,
  mapFiscalIncomeToInterval,
  inferEnergyFromGenerator,
} from "../utils/form";

import { DpeData } from "./dpeService";
import { DpeFormattedData } from "../types/dpe.types";
import { askOpenAIForFields } from "./openaiService";

function findAny(rows: any[][], regexes: RegExp[], col = 1, valCol = 2): string | null {
  for (const rx of regexes) {
    const v = findValueWithText(rows, rx, col, valCol);
    if (v) return v;
  }
  return null;
}

export async function mapDpeToFormData(dpe: DpeData): Promise<DpeFormattedData> {
  const { logement, administratif, rapport } = dpe;
  const codePostal = getValue(administratif, "code_postal_brut") ?? "";
  const surfaceRaw = getValue(logement, "surface_habitable_logement");
  const surfaceHabitable = surfaceRaw ? String(Math.round(parseFloat(surfaceRaw))) : "";
  const surfaceForForm = surfaceHabitable && parseFloat(surfaceHabitable) < 35 ? "35" : surfaceHabitable;
  let nbNiveaux = "";
  let nbNiveauxRaw: string | null | undefined = getValue(logement, "nombre_niveau_logement");

  if (!nbNiveauxRaw) {
    const alt = findAny(rapport, [/nombre\s+de\s+niveaux.*logement/i, /nombre\s+niveau\s+logement/i]);
    if (alt) nbNiveauxRaw = alt;
  }

  if (nbNiveauxRaw) {
    const match = String(nbNiveauxRaw).match(/\d+/);
    if (match) {
      const n = parseInt(match[0], 10);
      if (!isNaN(n)) nbNiveaux = String(Math.min(4, Math.max(1, n)));
    }
  }

  if (!nbNiveaux) nbNiveaux = "1";

  let periodeRaw =
    getValue(logement, "annee_construction") ?? getValue(logement, "periode_construction");
  if (!periodeRaw) {
    periodeRaw =
      findValueWithText(rapport, /année\s+de\s+construction/i) ??
      findAny(rapport, [/\d{4}\s*[–-]\s*\d{4}/], 2, 2);
    if (periodeRaw?.includes(":")) periodeRaw = periodeRaw.split(":").pop()?.trim() || null;
  }

  if (periodeRaw && !/\d{4}/.test(periodeRaw)) periodeRaw = null;
  if (!periodeRaw) periodeRaw = "Entre 1948 et 1974";

  // Libellé du générateur (appareil de chauffage)
  let generatorDeviceRaw = getValueByColumn(rapport, "type générateur") ?? getValueByColumn(rapport, "générateur type");

  // Recherche alternative si valeur vide ou décrivant un ballon électrique (ECS)
  if (!generatorDeviceRaw || /ballon.*electrique/.test(generatorDeviceRaw.toLowerCase())) {
    const altGen = findAny(rapport, [
      /radiateur.*fluide.*caloporteur/i,
      /radiateur.*électrique/i,
      /radiateur.*élec/i,
      /convecteur/i,
      /panneau.*rayonnant/i,
      /effet\s+joule/i,
    ]);
    if (altGen) generatorDeviceRaw = altGen;
  }

  // Source d'énergie du chauffage
  let energySourceHeatingRaw = inferEnergyFromGenerator(generatorDeviceRaw);

  if (!energySourceHeatingRaw) {
    energySourceHeatingRaw = getValueByColumn(rapport, "energie utilisée", 1, 2);

    if (energySourceHeatingRaw) {
      const energyRowIndex = rapport.findIndex((r) => r[1]?.toLowerCase() === "energie utilisée");
      const prev = rapport
        .slice(Math.max(0, energyRowIndex - 4), energyRowIndex)
        .some((r) => /installation.+chauffage|type g[ée]n[ée]rateur/.test(String(r[1] ?? "").toLowerCase()));
      if (!prev) energySourceHeatingRaw = null;
    }
  }

  let typeVentilationRaw =
    findAny(rapport, [/ventilation/i, /vmc/i, /vh\b/i]) ?? findAny(rapport, [/ventilation/i], 2, 2) ?? "";
  let typeVitrageRaw = getValueByColumn(rapport, "type de vitrage") ?? findAny(rapport, [/vitrage/i]) ?? "";
  let matMenuiserieRaw = findAny(rapport, [/menuiserie/i]) ?? findAny(rapport, [/menuiserie/i], 2, 2) ?? "";
  let systemeEcsRaw = getValueByColumn(rapport, "type production ecs") ?? findAny(rapport, [/ballon|ecs|chauffe/i]);

  if (!/[sd]imple|double|triple/i.test(typeVitrageRaw)) {
    typeVitrageRaw =
      findAny(rapport, [
        /simple\s*vitrage/i,
        /double\s*vitrage/i,
        /triple\s*vitrage/i,
        /simplevitrage/i,
        /doublevitrage/i,
        /triplevitrage/i,
      ]) ?? typeVitrageRaw;
  }
  if (/toute\s+menuiserie/i.test(matMenuiserieRaw ?? "")) {
    matMenuiserieRaw = findAny(rapport, [/pvc/i, /alu|minium/i, /bois/i]) ?? matMenuiserieRaw;
  }
  if (!systemeEcsRaw) {
    systemeEcsRaw = findAny(rapport, [/chauffe[- ]eau/i, /thermodynam/i]);
  }

  // Si la menuiserie est vide, essayer de l'inférer depuis le libellé vitrage
  if (!matMenuiserieRaw && typeVitrageRaw) {
    const tv = typeVitrageRaw.toLowerCase();
    if (/pvc/.test(tv)) matMenuiserieRaw = "pvc";
    else if (/bois/.test(tv)) matMenuiserieRaw = "bois";
    else if (/alu|minium/.test(tv)) matMenuiserieRaw = "aluminium";
  }

  const unknownMap: Record<string, string | null> = {
    generatorDeviceRaw,
    energySourceHeatingRaw,
    typeVentilationRaw,
    typeVitrageRaw,
    matMenuiserieRaw,
    systemeEcsRaw,
  };
  const missing = Object.entries(unknownMap)
    .filter(([, v]) => !v || /inconnu/i.test(v ?? ""))
    .map(([k]) => k);
  if (missing.length) {
    const snippet = dpe.rapport.join("\n");
    const ai = await askOpenAIForFields(snippet, missing);
    missing.forEach((k) => {
      if (ai[k]) unknownMap[k] = ai[k];
    });

    ({
      generatorDeviceRaw,
      energySourceHeatingRaw,
      typeVentilationRaw,
      typeVitrageRaw,
      matMenuiserieRaw,
      systemeEcsRaw,
    } = unknownMap as any);
  }

  // Correction de la source d'énergie finale basée sur le type d'appareil (après l'IA)
  if (energySourceHeatingRaw && generatorDeviceRaw) {
    const generatorLower = generatorDeviceRaw.toLowerCase();
    const energyLower = energySourceHeatingRaw.toLowerCase();

    // Priorité au type d'appareil pour déterminer la source d'énergie
    const inferredEnergy = inferEnergyFromGenerator(generatorDeviceRaw);

    if (inferredEnergy) {
      // Si l'inférence depuis l'appareil donne un résultat clair, on l'utilise
      energySourceHeatingRaw = inferredEnergy;
    } else {
      // Sinon, on applique des règles de correction
      if (/pompe.*chaleur|pac|electrique|radiateur.*electrique|convecteur/i.test(generatorLower)) {
        if (!/electrique/i.test(energyLower)) {
          energySourceHeatingRaw = "Electrique";
        }
      } else if (/chaudiere.*fioul|chaudiere.*gaz|fioul|gaz/i.test(generatorLower)) {
        if (/electrique/i.test(energyLower)) {
          energySourceHeatingRaw = energyLower.includes("fioul") ? "Fioul" : "Gaz";
        }
      }
    }
  }

  const formData: DpeFormattedData = {
    "L'année de construction du logement": [mapPeriodeConstruction(periodeRaw)],
    "La maison est-elle mitoyenne ?": ["Non"],
    "Le nombre de niveaux habités": [nbNiveaux],
    "Le type d'appareil de votre chauffage principal": [
      mapTypeAppareilChauffage(generatorDeviceRaw),
    ],
    "Le type de toiture": ["Combles perdus"],
    "Possédez-vous un second type de chauffage ?": ["Non"],
    "Quel appareil produit votre eau chaude sanitaire ?": [
      mapSystemeEcsToLabel(systemeEcsRaw),
    ],
    "Quel est le matériau de vos fenêtres ?": [mapMatMenuiserieToLabel(matMenuiserieRaw)],
    "Quel est le type de ventilation ?": [mapVentilationCodeToLabel(typeVentilationRaw)],
    "Quel est votre type de planchers bas ?": ["Cave ou sous-sol"],
    "Quelle est la source d'énergie de chauffage principale ?": [
      mapTypeEnergie(energySourceHeatingRaw),
    ],
    "Sa forme": ["Rectangulaire compacte"],
    "Sa surface habitable (m²)": surfaceForForm,
    "Vous habitez": [isIleDeFrance(codePostal)],
    "Avez-vous déjà effectué des travaux d'isolation de vos murs ?": ["Je ne sais pas"],
    "Avez-vous déjà effectué des travaux d'isolation de votre toiture ?": ["Je ne sais pas"],
    "Avez-vous déjà effectué des travaux d'isolation de vos planchers bas ?": ["Je ne sais pas"],
    "Code Postal": codePostal,
    "Comment est le vitrage de vos fenêtres ?": [mapTypeVitrageToLabel(typeVitrageRaw)],
  };

  return formData;
}

export function extractDpeMetrics(data: DpeData) {
  const logementRows = data.logement ?? [];
  const logementSortieRows = data.logement_sortie ?? [];

  const wallSurfaces: number[] = [];
  logementRows.forEach((r, i) => {
    if (r[0] === "enum_materiaux_structure_mur_id") {
      for (let j = i - 1; j >= Math.max(0, i - 10); j--) {
        if (logementRows[j][0] === "surface_paroi_opaque") {
          wallSurfaces.push(Number(logementRows[j][1]));
          break;
        }
      }
    }
  });
  const totalWallSurface = wallSurfaces.reduce((s, n) => s + n, 0);

  const baySurfaces = getValues(logementRows, "surface_totale_baie").map(Number);
  const nbBays =
    getValues(logementRows, "nb_baie")
      .map(Number)
      .reduce((s, n) => s + n, 0);
  const totalBaySurface = baySurfaces.reduce((s, n) => s + n, 0);

  const gv = (k: string) => getValueByColumn(logementSortieRows, k, 1, 2);

  const ventilatedSurface = Number(
    getValue(logementRows, "surface_ventile") || gv("surface_ventile") || 0
  );

  const doorSurfaces = getValues(logementRows, "surface_porte", 0, 1).map(Number);
  const totalDoorSurface = doorSurfaces.reduce((s, n) => s + n, 0);

  const gvAny = (k: string) => {
    const row = logementSortieRows.find(
      (r) => String(r[1] ?? "").trim().toLowerCase() === k.trim().toLowerCase()
    );
    return row ? String(row[2]).trim() : null;
  };

  const costsRaw = {
    heating: gvAny("cout_ch"),
    ecs: gvAny("cout_ecs"),
    lighting: gvAny("cout_eclairage"),
    aux: gvAny("cout_total_auxiliaire"),
    total: gvAny("cout_5_usages"),
  };

  const costs = Object.fromEntries(
    Object.entries(costsRaw).map(([k, v]) => [k, v === null ? null : v])
  );

  const consoAfter =
    gvAny("conso_5_usages_apres_travaux") ||
    getValueByColumn(data.rapport, "conso_5_usages_apres_travaux", 1, 2);
  const gesAfter =
    gvAny("emission_ges_5_usages_apres_travaux") ||
    getValueByColumn(data.rapport, "emission_ges_5_usages_apres_travaux", 1, 2);

  const consoBeforeM2 = gv("ep_conso_5_usages_m2");
  const gesBeforeM2 = gv("emission_ges_5_usages_m2");

  return {
    wallSurfaces,
    totalWallSurface,
    baySurfaces,
    totalBaySurface,
    nbBays,
    ventilatedSurface,
    heatingNeed: Number(gv("besoin_ch")),
    heatLossRate: Number(gv("deperdition_enveloppe")),
    doorSurface: totalDoorSurface,

    costs,

    conso: {
      conso5UsagesAvantTravaux: consoBeforeM2,
      emissionGes5UsagesAvantTravaux: gesBeforeM2,
    },

    travaux: {
      conso5UsagesApresTravaux: consoAfter,
      emissionGes5UsagesApresTravaux: gesAfter,
    },
  };
} 