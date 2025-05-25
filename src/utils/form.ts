export function getValue(rows: any[], key: string): string | null {
  if (!Array.isArray(rows)) return null;
  const found = rows.find((r) => r[0] === key);
  return found && found[1] ? found[1].toString() : null;
}

export function getValues(rows: any[], key: string): string[] {
  if (!Array.isArray(rows)) return [];
  return rows.filter((r) => r[0] === key).map((r) => String(r[1]));
}

export function getValueByColumn(
  rows: any[][],
  searchKey: string,
  findCol: number,
  valueCol: number
): string | null {
  if (!Array.isArray(rows)) return null;
  const found = rows.find((row) => {
    const cell = row[findCol];
    if (!cell) return false;
    return cell.toString().trim().toLowerCase() === searchKey.trim().toLowerCase();
  });

  if (!found) {
    return null;
  }

  const val = found[valueCol];
  return val ? val.toString().trim() : null;
}

// TODO: Vérifier signification des codes.

export function mapPeriodeConstruction(periode: string | null): string {
  if (!periode) return "";

  const libelles: Record<string, string> = {
    "avant 1948": "Avant 1948",
    "1948-1974": "Entre 1948 et 1974",
    "1975-1977": "Entre 1975 et 1977",
    "1978-1988": "Entre 1978 et 1988",
    "1989-2000": "Entre 1989 et 2000",
    "2001-2012": "Entre 2001 et 2012",
    "2013-2021": "Entre 2013 et 2021",
    "après 2021": "Après 2021",
  };

  if (libelles[periode]) {
    return libelles[periode];
  }

  // Gestion du code numérique (enum_periode_construction_id) 
  const enumMap: Record<string, string> = {
    "1": "Avant 1948",
    "2": "Entre 1948 et 1974",
    "3": "Entre 1975 et 1977",
    "4": "Entre 1978 et 1988",
    "5": "Entre 1989 et 2000",
    "6": "Entre 2001 et 2012",
    "7": "Entre 2013 et 2021",
    "8": "Après 2021",
  };

  return enumMap[periode] || periode;
}
  
export function mapTypeEnergie(typeEnergie: string | null): string {
  if (!typeEnergie) return "";

  const str = typeEnergie.toLowerCase();

  // Cas texte libre
  if (str.includes("gaz")) return "Gaz";
  if (str.includes("fioul")) return "Fioul";
  if (str.includes("électricité") || str.includes("électrique")) return "Electricité";
  if (str.includes("bois")) return "Bois";
  if (str.includes("urbain") || str.includes("réseau")) return "Gaz";

  // Cas code numérique (enum_type_energie_id ou enum_type_generateur_ch_id)
  const codeMap: Record<string, string> = {
    // Codes énergie (enum_type_energie_id)
    "1": "Electricité",
    "2": "Gaz",
    "3": "Fioul",
    "4": "Bois",
    // Codes générateur gaz courants
    "90": "Gaz",
    "91": "Gaz",
    "92": "Gaz",
    "94": "Gaz",
    "95": "Gaz",
    // Codes générateur fioul
    "52": "Fioul",
    "60": "Electricité",
    "99": "Electricité",
    // Codes générateur bois / biomasse
    "46": "Bois",
    "48": "Bois",
    "70": "Bois",
    "71": "Bois",
    "72": "Bois",
    "73": "Bois",
    "74": "Bois",
  };

  if (codeMap[typeEnergie]) return codeMap[typeEnergie];

  return typeEnergie;
}
  
export function mapTypeAppareilChauffage(typeEnergie: string | null): string {
  if (!typeEnergie) return "";

  const str = typeEnergie.toLowerCase();

  if (str.includes("gaz")) return "Chaudière gaz standard";
  if (str.includes("fioul")) return "Chaudière fioul";
  if (str.includes("électricité") || str.includes("électrique")) return "Chaudière électrique";
  if (str.includes("bois") || str.includes("granulé") || str.includes("granules")) return "Chaudière bois";
  if (str.includes("urbain") || str.includes("réseau")) return "Chaudière gaz standard";
  if (str.includes("condensation")) return "Chaudière gaz standard";

  // Cas code numérique (enum_type_generateur_ch_id)
  const genMap: Record<string, string> = {
    // Gaz – valeurs communes
    "90": "Chaudière gaz standard",
    "91": "Chaudière gaz standard",
    "92": "Chaudière gaz standard",
    "94": "Chaudière gaz standard",
    "95": "Chaudière gaz standard", // condensation
    // Fioul
    "52": "Chaudière fioul",
    "53": "Chaudière fioul",
    // Électrique
    "60": "Chaudière électrique",
    "99": "Chaudière électrique",
    "2": "Chaudière électrique",
    // Bois / biomasse
    "46": "Chaudière bois",
    "47": "Chaudière bois",
    "48": "Chaudière bois",
    "70": "Chaudière bois",
    "71": "Chaudière bois",
    "72": "Chaudière bois",
    "73": "Chaudière bois",
    "74": "Chaudière bois",
  };

  if (genMap[typeEnergie]) return genMap[typeEnergie];

  return typeEnergie;
}

export function isIleDeFrance(codePostal: string): string {
  return codePostal.startsWith('75') || codePostal.startsWith('77') ||
  codePostal.startsWith('78') || codePostal.startsWith('91') ||
  codePostal.startsWith('92') || codePostal.startsWith('93') || 
  codePostal.startsWith('94') || codePostal.startsWith('95') 
  ? "En Ile de France" : "Hors Ile de France";
}

export function mapOccupancyStatusToLabel(status: string): string {
  switch (status) {
    case "primaryOwner":
      return "Propriétaire résidence principale";
    case "secondaryOwner":
      return "Propriétaire résidence secondaire";
    case "ownerTenant":
      return "Propriétaire bailleur";
    case "tenant":
      return "Locataire";
    default:
      return "Inconnu";
  }
}

export function mapTypeVitrageToLabel(vitrage: string): string {
  // Cas code numérique (enum_type_vitrage_id)
  const codeMap: Record<string, string> = {
    "1": "Simple vitrage",
    "2": "Double vitrage récent (moins de 25 ans)",
    "3": "Triple vitrage"
  };

  if (codeMap[vitrage]) {
    return codeMap[vitrage];
  }

  // Cas texte libre
  switch (vitrage.toLowerCase()) {
    case "simple vitrage":
      return "Simple vitrage";
    case "double vitrage":
      return "Double vitrage récent (moins de 25 ans)";
    case "triple vitrage":
      return "Triple vitrage";
    default:
      return "Inconnu";
  }
}

export function mapMatMenuiserieToLabel(material: string): string {
  // Gestion code numérique (enum_type_materiaux_menuiserie_id)
  const codeMap: Record<string, string> = {
    "5": "PVC",          
    "1": "Bois / Bois métal",
    "2": "Bois / Bois métal",
    "3": "Aluminium",
    "4": "Aluminium",   
  };

  if (codeMap[material]) return codeMap[material];

  switch (material.toLowerCase()) {
    case "bois":
    case "bois métal":
      return "Bois / Bois métal";
    case "pvc":
      return "PVC";
    case "aluminium":
      return "Aluminium";
    default:
      return "Inconnu";
  }
}

export function mapVentilationCodeToLabel(ventilationCode: string): string {
  const code = ventilationCode.toLowerCase();

  // Codes numériques (enum_type_ventilation_id)
  const codeMap: Record<string, string> = {
    "15": "VMC simple flux hygroréglable", // VMC SF Hygro B ou A
    "14": "VMC simple flux autoréglable",
    "16": "VMC Double flux",
    "1": "Ventilation naturelle", // ouverture fenêtres
  };
  if (codeMap[code]) return codeMap[code];

  if (code.includes("ouverture des fenêtres")) return "Ventilation naturelle";
  if (code.includes("vea")) return "Ventilation par entrées d'air hautes et basses";
  if (code.includes("vmc sfa")) return "VMC simple flux autoréglable";
  if (code.includes("vmc sf hygro a") || code.includes("vmc sf hygro b")) return "VMC simple flux hygroréglable";
  if (code.includes("vmc df hygro") || code.includes("vmc df")) return "VMC Double flux";
  if (code.includes("vh")) return "Ventilation hybride";
  if (code.includes("entrées d'air hautes et basses")) return "Ventilation par entrées d'air hautes et basses";
  return "Inconnu";
}

export function mapSystemeEcsToLabel(ecs: string): string {
  const system = ecs.toLowerCase();

  // Codes numériques (enum_type_generateur_ecs_id)
  const codeMap: Record<string, string> = {
    // Ballons électriques
    "69": "Ballon électrique",
    "70": "Ballon électrique",
    "71": "Ballon électrique",
    // Chauffe-eau gaz
    "50": "Chauffe-eau gaz",
    "55": "Chauffe-eau gaz",
    // Chauffe-eau solaire / thermodynamique
    "80": "Chauffe-eau solaire thermique",
    "81": "Chauffe-eau solaire thermique",
    "90": "Chauffe-eau thermodynamique",
  };
  if (codeMap[ecs]) return codeMap[ecs];

  if (system.includes("accumulation")) {
    if (system.includes("électrique") || system.includes("electrique")) return "Ballon électrique";
    if (system.includes("gaz")) return "Accumulateur gaz";
  }
  if (system.includes("ballon") && (system.includes("électrique") || system.includes("electrique"))) return "Ballon électrique";
  if (system.includes("chauffe-eau gaz") || (system.includes("chauffe") && system.includes("gaz"))) return "Chauffe-eau gaz";
  if (system.includes("solaire")) return "Chauffe-eau solaire thermique";
  if (system.includes("thermodynamique")) return "Chauffe-eau thermodynamique";
  if (system.includes("gaz")) return "Chauffe-eau gaz";
  if (system.includes("chaudière") || system.includes("chauffage")) return "Mon système de chauffage"; // ECS via chauffage
  return "Ballon électrique";
}

export function mapFiscalIncomeToInterval(
  income: string,
  choices: { id: string; label: string; position?: number }[] = []
): string {
  if (!choices.length) return income
  const numeric = parseFloat(income)
  if (isNaN(numeric)) return choices[0]?.label ?? ""
  const sorted = [...choices].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
  const intervals = sorted.map(ch => {
    const clean = ch.label.replace(/\s+/g, "").replace("€", "")
    if (ch.label.startsWith("<")) {
      return { max: parseFloat(clean.match(/\d+/)?.[0] || "0"), label: ch.label }
    } else if (ch.label.startsWith(">")) {
      return { min: parseFloat(clean.match(/\d+/)?.[0] || "0"), label: ch.label }
    } else {
      const [min, max] = clean.match(/\d+/g)?.map(Number) ?? []
      return { min, max, label: ch.label }
    }
  })
  for (const i of intervals) {
    if (i.min == null && numeric < (i.max ?? 0)) return i.label
    if (i.max == null && numeric > (i.min ?? 0)) return i.label
    if (i.min != null && i.max != null && numeric >= i.min && numeric <= i.max) return i.label
  }
  return sorted[sorted.length - 1]?.label ?? ""
}
