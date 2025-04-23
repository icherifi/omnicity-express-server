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

export function mapPeriodeConstruction(periode: string | null): string {
  const periodes: Record<string, string> = {
    "avant 1948": "Avant 1948",
    "1948-1974": "Entre 1948 et 1974",
    "1975-1977": "Entre 1975 et 1977",
    "1978-1988": "Entre 1978 et 1988",
    "1989-2000": "Entre 1989 et 2000",
    "2001-2012": "Entre 2001 et 2012",
    "2013-2021": "Entre 2013 et 2021",
    "après 2021": "Après 2021"
  };
  if (!periode) return "";
  return periodes[periode] || periode;
}
  
export function mapTypeEnergie(typeEnergie: string | null): string {
  if (!typeEnergie) return "";
  if (typeEnergie.includes("gaz")) return "Gaz ou propane";
  if (typeEnergie.includes("fioul")) return "Fioul";
  if (typeEnergie.includes("électricité")) return "Electricité";
  if (typeEnergie.includes("électrique")) return "Electricité";
  if (typeEnergie.includes("bois")) return "Bois";
  if (typeEnergie.includes("urbain") || typeEnergie.includes("réseau")) return "Gaz ou propane"; 
  return typeEnergie; 
}
  
export function mapTypeAppareilChauffage(typeEnergie: string | null): string {
  if (!typeEnergie) return "";
  if (typeEnergie.includes("gaz")) return "Chaudière gaz standard";
  if (typeEnergie.includes("fioul")) return "Chaudière fioul";
  if (typeEnergie.includes("électricité")) return "Chaudière électrique";
  if (typeEnergie.includes("électrique")) return "Chaudière électrique";
  if (typeEnergie.includes("bois")) return "Chaudière bois";
  if (typeEnergie.includes("urbain") || typeEnergie.includes("réseau")) return "Chaudière gaz standard";
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
  switch (vitrage.toLowerCase()) {
    case "simple vitrage":
    return "Simple vitrage";
    //case "double vitrage ancien":
    //return "Double vitrage ancien (plus de 25 ans)";
    case "double vitrage":
    return "Double vitrage récent (moins de 25 ans)";
    case "triple vitrage":
    return "Triple vitrage";
    default:
    return "Inconnu";
  }
}

export function mapMatMenuiserieToLabel(material: string): string {
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

// TODO: Vérifier les codes de ventilation

export function mapVentilationCodeToLabel(ventilationCode: string): string {
  const code = ventilationCode.toLowerCase();
  if (code.includes("ouverture des fenêtres")) return "Ventilation naturelle";
  if (code.includes("vea")) return "Ventilation par entrées d'air hautes et basses";
  if (code.includes("vmc sfa")) return "VMC simple flux autoréglable";
  if (code.includes("vmc sf hygro a") || code.includes("vmc sf hygro b")) return "VMC simple flux hygroréglable";
  if (code.includes("vmc df hygro") || code.includes("vmc df")) return "VMC Double flux";
  if (code.includes("vh")) return "Ventilation hybride";
  return "Inconnu";
}

export function mapSystemeEcsToLabel(ecs: string): string {
  const system = ecs.toLowerCase();
  if (system.includes("accumulation")) {
    if (system.includes("électrique")) return "Ballon électrique";
    if (system.includes("gaz")) return "Accumulateur gaz";
  }
  if (system.includes("chauffe-eau gaz")) return "Chauffe-eau gaz";
  if (system.includes("solaire")) return "Chauffe-eau solaire thermique";
  if (system.includes("thermodynamique")) return "Chauffe-eau thermodynamique";
  if (system.includes("chaudière") || system.includes("chauffage")) return "Mon système de chauffage"; // Assumes ECS is linked to heating system
  return "Inconnu";
}

export function mapFiscalIncomeToInterval(income: string, choices: any[] = []): string {
  console.log("income", income);
  console.log("choices", choices);
  const numericIncome = parseFloat(income);
  if (isNaN(numericIncome)) return choices[0]?.label;

  const sortedChoices = [...choices].sort((a, b) => a.position - b.position);

  const intervals = sortedChoices.map(choice => {
    const label = choice.label;
    const cleanLabel = label.replace(/\s+/g, '').replace('€', '');
    
    if (label.startsWith("<")) {
      const max = parseFloat(cleanLabel.match(/\d+/)[0]);
      return { max, label };
    } else if (label.startsWith(">")) {
      const min = parseFloat(cleanLabel.match(/\d+/)[0]);
      return { min, label };
    } else {
      const [min, max] = cleanLabel.match(/\d+/g).map(Number);
      return { min, max, label };
    }
  });

  for (const interval of intervals) {
    if (interval.min === undefined && numericIncome < interval.max) {
      return interval.label;
    } else if (interval.max === undefined && numericIncome > interval.min) {
      return interval.label;
    } else if (interval.min !== undefined && interval.max !== undefined && 
               numericIncome >= interval.min && numericIncome <= interval.max) {
      return interval.label;
    }
  }

  return sortedChoices[sortedChoices.length - 1]?.label;
}
