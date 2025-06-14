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

const isTrivial = (v: string) => /^(oui|non)$/i.test(v.trim()) || /^\d+$/.test(v.trim());


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
  { rx: /réseau\s+de\s+chaleur|cpcu|urbain/, lbl: 'Réseau de chaleur' },
  { rx: /gaz|gnl|propane|naturel/, lbl: 'Gaz ou propane' },
  { rx: /fioul|fuel/, lbl: 'Fioul' },
  { rx: /elect|élec|hp\/hc/, lbl: 'Electricité' },
  { rx: /bois|granul|pellet/, lbl: 'Bois' },
];

const DICO_APPAREIL = [
  { rx: /réseau\s+de\s+chaleur/, lbl: 'Réseau de chaleur urbain' },
  { rx: /chaudiere.*condens/, lbl: 'Chaudière gaz à condensation' },
  { rx: /chaudiere.*(gaz|gnl)/, lbl: 'Chaudière gaz standard' },
  { rx: /chaudiere.*(fioul|fuel)/, lbl: 'Chaudière fioul' },
  { rx: /(pac|pompe à chaleur).*air.?air/, lbl: 'Pompe à chaleur air/air' },
  { rx: /(pac|pompe à chaleur).*air.?eau/, lbl: 'Pompe à chaleur air/eau' },
  { rx: /(pac|pompe à chaleur)/, lbl: 'Autre type de pompe à chaleur' },
  { rx: /joule|effet\s+joule|panneau\s+rayonnant|radiateur.*électrique/, lbl: 'Chaudière électrique' },
  { rx: /convecteur/, lbl: 'Convecteurs électriques' },
  { rx: /chaudiere.*electrique/, lbl: 'Chaudière électrique' },
  { rx: /chaudiere.*bois/, lbl: 'Chaudière bois' },
  { rx: /radiateur.*electrique/, lbl: 'Chaudière électrique' },
];

const DICO_VENTILATION = [
  { rx: /vmc.*double|vmc.*df/, lbl: 'VMC Double flux' },
  { rx: /vmc.*hygro.*(a|b)?/, lbl: 'VMC simple flux hygroréglable' },
  { rx: /vmc.*auto/, lbl: 'VMC simple flux autoréglable' },
  { rx: /vh\b|hybride/, lbl: 'Ventilation hybride' },
  { rx: /entr..es d.?air|vea/, lbl: 'Ventilation par entrées d\'air hautes et basses' },
  { rx: /naturelle|ouverture fenetre|ouverture des fenetres/, lbl: 'Ventilation naturelle' },
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
export const mapVentilationCodeToLabel = (r: string | null) => mapWithDict(r, DICO_VENTILATION, 'Inconnu');
export const mapTypeVitrageToLabel = (r: string | null) => mapWithDict(r, DICO_VITRAGE, 'Inconnu');
export const mapMatMenuiserieToLabel = (r: string | null) => mapWithDict(r, DICO_MENUISERIE, 'Autre / inconnu');

export function mapSystemeEcsToLabel(raw: string | null): string {
  if (!raw) return 'Inconnu';
  const txt = normalise(raw);

  if (/thermodynam|pac.*ecs/.test(txt)) return 'Chauffe-eau thermodynamique';
  if (/solair|cesi|chauffe.?eau.*solaire/.test(txt)) return 'Chauffe-eau solaire thermique';
  if (/(accum|ballon|cumulus).*gaz/.test(txt)) return 'Accumulateur gaz';
  if (/(accum|ballon|cumulus).*elect/.test(txt)) return 'Ballon électrique';
  if (/chauffe.?eau.*gaz|chaudiere.*mixte/.test(txt)) return 'Chauffe-eau gaz';
  if (/chauffage et ecs|individuel|système d'ecs.*homogène/.test(txt)) return 'Chauffe-eau gaz';

  return 'Chauffe-eau gaz';
}

export function inferEnergyFromGenerator(gen: string | null): string | null {
  if (!gen) return null;
  const txt = gen.toLowerCase();
  if (/gaz|gnl|propane|naturel/.test(txt))   return "Gaz ou propane";
  if (/fioul|fuel/.test(txt))                return "Fioul";
  if (/bois|granul|pellet/.test(txt))        return "Bois";
  if (/charbon|lignite|anthracite/.test(txt)) return "Charbon";
  if (/elect|élec|hp\/hc/.test(txt))         return "Electrique";
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
