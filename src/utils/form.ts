export function getValue(rows: any[][], key: string): string | null {
  if (!Array.isArray(rows)) return null;
  const found = rows.find(r => r[0] === key);
  return found && found[1] ? String(found[1]).trim() : null;
}

export function getValues(
  rows: any[][],
  key: string | RegExp,
  keyCol = 0,
  valCol = 1,
): string[] {
  if (!Array.isArray(rows)) return [];

  const match = (txt: string) =>
    typeof key === "string"
      ? txt.trim().toLowerCase() === key.trim().toLowerCase()
      : key.test(txt);

  return rows
    .filter(r => match(String(r[keyCol] ?? "")))
    .map(r => String(r[valCol]).trim());
}

const isTrivial = (v: string) => /^(oui|non)$/i.test(v.trim());


export function getValueByColumn(
  rows: any[][],
  searchKey: string,
  findCol = 1,
  valueCol = 2,
): string | null {
  if (!Array.isArray(rows)) return null;
  const found = rows.find(
    r =>
      String(r[findCol] ?? '')
        .trim()
        .toLowerCase() === searchKey.trim().toLowerCase() &&
      !isTrivial(String(r[valueCol] ?? '')),
  );
  return found ? String(found[valueCol]).trim() : null;
}

export function findValueWithText(
  rows: any[][],
  regex: RegExp,
  findCol = 1,
  valueCol = 2,
): string | null {
  if (!Array.isArray(rows)) return null;
  const found = rows.find(
    r => regex.test(String(r[findCol] ?? '')) && !isTrivial(String(r[valueCol] ?? '')),
  );
  return found ? String(found[valueCol]).trim() : null;
}


const normalise = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();


function mapWithDict(raw: string | null, dict: { rx: RegExp; lbl: string }[], def = 'Inconnu'): string {
  if (!raw) return 'Inconnu';
  const txt = normalise(raw);
  const found = dict.find(d => d.rx.test(txt));
  return found ? found.lbl : def;
}

const DICO_PERIODE: Record<string, string> = {
  avant1948: 'Avant 1948',
  '1948-1974': 'Entre 1948 et 1974',
  '1975-1977': 'Entre 1975 et 1977',
  '1978-1982': 'Entre 1978 et 1982',
  '1983-1988': 'Entre 1983 et 1988',
  '1989-2000': 'Entre 1989 et 2000',
  '2001-2005': 'Entre 2001 et 2005',
  '2006-2012': 'Entre 2006 et 2012',
  apres2012: 'Après 2012',
};

const DICO_ENERGIE = [
  { rx: /reseau\s+(de\s+)?(chaleur|chauffage).*urbain?|cpcu/, lbl: 'Gaz ou propane' },
  { rx: /reseau\s+de\s+chaleur/,                               lbl: 'Gaz ou propane' },
  { rx: /gaz|gnl|propane|naturel/,                                 lbl: 'Gaz ou propane' },
  { rx: /fioul|fuel/,                                              lbl: 'Fioul' },
  { rx: /elect|élec|hp\/hc/,                                       lbl: 'Electricité' },
  { rx: /bois|granul|pellet/,                                      lbl: 'Bois' },
  { rx: /installation\s+collective|multi[- ]batiment/,           lbl: 'Gaz ou propane' },
  { rx: /renouvelable/,                                   lbl: 'Gaz ou propane' },
  { rx: /^\d+$/,                                      lbl: 'Gaz ou propane' },
];

const DICO_APPAREIL = [
  { rx: /reseau.*(chaleur|chauffage).*/, lbl: 'Chaudière gaz à condensation' },
  { rx: /installation\s+collective(\s+unique)?(\s+multi[- ]?batiment)?/, lbl: 'Chaudière gaz à condensation' },
  { rx: /chaudiere.*condens/,                  lbl: 'Chaudière gaz à condensation' },
  { rx: /chaudiere.*(gaz|gnl).*basse.*temperature/, lbl: 'Chaudière gaz basse température' },
  { rx: /chaudiere.*(gaz|gnl)/, lbl: 'Chaudière gaz standard' },
  { rx: /radiateur.*gaz/, lbl: 'Radiateurs à gaz' },
  { rx: /chaudiere.*(fioul|fuel).*condens/, lbl: 'Chaudière fioul à condensation' },
  { rx: /chaudiere.*(fioul|fuel).*basse.*temperature/, lbl: 'Chaudière fioul basse température' },
  { rx: /chaudiere.*(fioul|fuel)/, lbl: 'Chaudière fioul standard' },
  { rx: /poele.*fioul/, lbl: 'Poêle au fioul' },
  { rx: /chaudiere.*bois/, lbl: 'Chaudière bois' },
  { rx: /poele.*buches/, lbl: 'Poêle à buches' },
  { rx: /poele.*bois.*bouilleur/, lbl: 'Poêle à bois bouilleur' },
  { rx: /poele.*granules/, lbl: 'Poêle à granulés' },
  { rx: /chaudiere.*granules/, lbl: 'Chaudière à granulés' },
  { rx: /poele.*charbon/, lbl: 'Poêle au charbon' },
  { rx: /(pac|pompe\s+à\s+chaleur).*air.?air/, lbl: 'Pompe à chaleur air/air' },
  { rx: /(pac|pompe\s+a\s+chaleur).*air.?air/, lbl: 'Pompe à chaleur air/air' },
  { rx: /(pac|pompe\s+à\s+chaleur).*air.?eau/, lbl: 'Pompe à chaleur air/eau' },
  { rx: /(pac|pompe\s+a\s+chaleur).*air.?eau/, lbl: 'Pompe à chaleur air/eau' },
  { rx: /(pac|pompe à chaleur)/, lbl: 'Autre type de pompe à chaleur' },
  { rx: /(pac|pompe\s+a\s+chaleur)/, lbl: 'Autre type de pompe à chaleur' },
  { rx: /joule|effet\s+joule|panneau\s+rayonnant/, lbl: 'Panneaux rayonnants' },
  { rx: /radiateur.*électrique/, lbl: 'Convecteurs électriques' },
  { rx: /radiateur.*electrique/, lbl: 'Convecteurs électriques' },
  { rx: /radiateur.*fluide.*caloporteur/, lbl: 'Convecteurs électriques' },
  { rx: /convecteur/, lbl: 'Convecteurs électriques' },
  { rx: /chaudiere.*electrique/, lbl: 'Chaudière électrique' },
  { rx: /plancher.*rayonnant|plafond.*rayonnant/, lbl: 'Plancher ou plafond rayonnant' },
  { rx: /generateur.*mixte.*basse.*temp/, lbl: 'Chaudière gaz basse température' },
  { rx: /generateur.*mixte/, lbl: 'Chaudière gaz standard' },
  { rx: /chauffe.*bain.*gaz|chauffe[- ]eau.*gaz.*instantan/, lbl: 'Chaudière gaz standard' },
  { rx: /chaudiere.*classique/, lbl: 'Chaudière gaz standard' },
];

const DICO_VENTILATION = [
  { rx: /vmc.*double|vmc.*df/, lbl: 'VMC Double flux' },
  { rx: /vmc.*hygro.*(a|b)?/, lbl: 'VMC simple flux hygroréglable' },
  { rx: /vmc.*auto/, lbl: 'VMC simple flux autoréglable' },
  { rx: /vh\b|hybride/, lbl: 'Ventilation hybride' },
  { rx: /entr..es d.?air|vea/, lbl: 'Ventilation par entrées d\'air hautes et basses' },
  { rx: /naturelle|ouverture fenetre|ouverture des fenetres/, lbl: 'Ventilation naturelle' },
  { rx: /ventilation.*conduit.*existant/, lbl: 'VMC simple flux autoréglable' },
];

const DICO_VITRAGE = [
  { rx: /triple|3.?vitrage/, lbl: 'Triple vitrage' },
  { rx: /double|2.?vitrage|4\/16\/4/, lbl: 'Double vitrage récent (moins de 25 ans)' },
  { rx: /simple|1.?vitrage/, lbl: 'Simple vitrage' },
];

const DICO_MENUISERIE = [
  { rx: /\bpvc\b/, lbl: 'PVC' },
  { rx: /alu|minium/, lbl: 'Aluminium' },
  { rx: /bois(?:\s+metal)?|m[ée]tal/,  lbl: "Bois / Bois métal" },
];

export function mapPeriodeConstruction(raw: string | null): string {
  if (!raw) return '';
  const key = normalise(raw).replace(/\s+/g, '');
  if (DICO_PERIODE[key]) return DICO_PERIODE[key];

  const m = raw.match(/(\d{4}).*?(\d{4})/);
  if (m) {
    const [y1, y2] = m.slice(1, 3).map(Number);
    if (!isNaN(y1) && !isNaN(y2) && y1 > 2012 && y2 > 2012) {
      return DICO_PERIODE.apres2012;
    }
    const k = `${m[1]}-${m[2]}`;
    if (DICO_PERIODE[k]) return DICO_PERIODE[k];
    return `Entre ${m[1]} et ${m[2]}`;
  }

  const year = parseInt(raw, 10);
  if (!isNaN(year)) {
    if (year < 1948) return 'Avant 1948';
    if (year <= 1974) return 'Entre 1948 et 1974';
    if (year <= 1977) return 'Entre 1975 et 1977';
    if (year <= 1982) return 'Entre 1978 et 1982';
    if (year <= 1988) return 'Entre 1983 et 1988';
    if (year <= 2000) return 'Entre 1989 et 2000';
    if (year <= 2005) return 'Entre 2001 et 2005';
    if (year <= 2012) return 'Entre 2006 et 2012';
    return 'Après 2012';
  }
  return raw;
}

export const mapTypeEnergie = (r: string | null) => mapWithDict(r, DICO_ENERGIE, 'Autre / inconnu');
export const mapTypeAppareilChauffage = (r: string | null) => mapWithDict(r, DICO_APPAREIL, 'Autre / inconnu');
export const mapVentilationCodeToLabel = (r: string | null) => {
  if (!r || !r.trim()) return 'Ventilation naturelle';
  return mapWithDict(r, DICO_VENTILATION, 'Ventilation naturelle');
};
export const mapTypeVitrageToLabel = (r: string | null) => {
  const lbl = mapWithDict(r, DICO_VITRAGE, 'Double vitrage récent (moins de 25 ans)');
  return lbl === 'Simple vitrage' ? 'Double vitrage récent (moins de 25 ans)' : lbl;
};
export const mapMatMenuiserieToLabel = (r: string | null) => mapWithDict(r, DICO_MENUISERIE, 'PVC');

export function mapSystemeEcsToLabel(raw: string | null): string {
  if (!raw) return 'Inconnu';
  const txt = normalise(raw);

  // Prioriser les types spécifiques de générateurs
  if (/^\d+(\.\d+)?$/.test(txt)) return 'Ballon électrique'; // valeur numérique seule (souvent volume)
  if (/ballon.*electrique|accumulation.*electrique|electrique.*ballon/.test(txt)) return 'Ballon électrique';
  if (/thermodynam|pac.*ecs/.test(txt)) return 'Chauffe-eau thermodynamique';
  if (/solair|cesi|chauffe.?eau.*solaire/.test(txt)) return 'Chauffe-eau solaire thermique';
  if (/chauffage.*ecs/.test(txt)) return 'Chauffe-eau gaz';
  if (/(accum|ballon|cumulus).*gaz/.test(txt)) return 'Accumulateur gaz';
  if (/(accum|ballon|cumulus).*elect/.test(txt)) return 'Ballon électrique';
  if (/chauffe.?eau.*gaz|chaudiere.*mixte/.test(txt)) return 'Chauffe-eau gaz';
  // Patterns génériques en dernier
  if (/chauffage et ecs|mon système de chauffage/.test(txt)) return 'Mon système de chauffage';
  if (/individuel|système d'ecs.*homogène/.test(txt)) return 'Ballon électrique'; // Par défaut pour les systèmes individuels

  return 'Chauffe-eau gaz';
}

export function inferEnergyFromGenerator(gen: string | null): string | null {
  if (!gen) return null;
  const txt = gen.toLowerCase();
  
  // Pompes à chaleur (toujours électriques)
  if (/pompe.*chaleur|pac|pompe.*air|pompe.*eau/i.test(txt)) return "Electrique";
  
  // Appareils électriques
  if (/elect|élec|hp\/hc|radiateur.*electrique|convecteur|panneau.*rayonnant|effet.*joule/i.test(txt)) return "Electrique";
  
  // Appareils à gaz
  if (/gaz|gnl|propane|naturel|chaudiere.*gaz/i.test(txt)) return "Gaz ou propane";
  
  // Appareils à fioul
  if (/fioul|fuel|chaudiere.*fioul/i.test(txt)) return "Fioul";
  
  // Appareils à bois
  if (/bois|granul|pellet|poele.*bois/i.test(txt)) return "Bois";
  
  // Appareils à charbon
  if (/charbon|lignite|anthracite/i.test(txt)) return "Charbon";
  
  return null;
}

export function isIleDeFrance(cp: string): string {
  return /^(75|77|78|91|92|93|94|95)/.test(cp) ? 'En Ile de France' : 'Hors Ile de France';
}

export function mapOccupancyStatusToLabel(status: string): string {
  switch (status) {
    case 'primaryOwner':
      return 'Propriétaire résidence principale';
    case 'secondaryOwner':
      return 'Propriétaire résidence secondaire';
    case 'ownerTenant':
      return 'Propriétaire bailleur';
    case 'tenant':
      return 'Locataire';
    default:
      return 'Inconnu';
  }
}

export function mapFiscalIncomeToInterval(
  income: string,
  choices: { id: string; label: string; position?: number }[] = [],
): string {
  if (!choices.length) return income;
  const numeric = parseFloat(income);
  if (isNaN(numeric)) return choices[0]?.label ?? '';
  const sorted = [...choices].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  for (const c of sorted) {
    const nums = c.label.match(/\d+/g)?.map(Number) ?? [];
    if (c.label.startsWith('<') && numeric < nums[0]) return c.label;
    if (c.label.startsWith('>') && numeric > nums[0]) return c.label;
    if (nums.length === 2 && numeric >= nums[0] && numeric <= nums[1]) return c.label;
  }
  return sorted[sorted.length - 1].label;
}
