import { parseStringPromise } from "xml2js";

export interface DpeData {
  logement: any[][];
  logement_sortie: any[][];
  administratif: any[][];
  rapport: any[][];
  [k: string]: any[][];
}

const ADEME_API_URL = "https://prd-x-ademe-externe-api.de-c1.eu1.cloudhub.io/api/v1/pub/dpe";

const ADEME_CLIENT_ID = process.env.ADEME_CLIENT_ID ?? "f15319ce605e407581242b71425bbcb6";
const ADEME_CLIENT_SECRET =
  process.env.ADEME_CLIENT_SECRET ?? "4d97b25a303b412eB968C26Aef30D933";

export async function fetchDpeXml(dpeNumber: string): Promise<string> {
  const url = `${ADEME_API_URL}/${dpeNumber}/xml`;
  const resp = await fetch(url, {
    headers: {
      client_id: ADEME_CLIENT_ID,
      client_secret: ADEME_CLIENT_SECRET,
      "Content-Type": "application/json",
    },
  });

  if (!resp.ok) {
    throw new Error(`Erreur DPE ${resp.status}: ${resp.statusText}`);
  }

  return resp.text();
}

export function flattenObjectToRows(
  obj: any,
  rows: any[][],
  addEmptyFirstCol = false
) {
  if (!obj) return;
  if (
    typeof obj === "object" &&
    obj !== null &&
    "description" in obj &&
    "valeur" in obj
  ) {
    rows.push(
      addEmptyFirstCol
        ? ["", (obj as any).description, (obj as any).valeur]
        : [(obj as any).description, (obj as any).valeur]
    );
    return;
  }

  Object.entries(obj).forEach(([key, val]) => {
    if (val === null || val === undefined) return;
    if (typeof val === "object") {
      flattenObjectToRows(val, rows, addEmptyFirstCol);
    } else {
      rows.push(
        addEmptyFirstCol ? ["", key, String(val)] : [key, String(val)]
      );
    }
  });
}

export async function parseDpeXmlToRows(xmlText: string): Promise<DpeData> {
  const parsedXml = await parseStringPromise(xmlText, {
    explicitArray: false,
    mergeAttrs: true,
  });

  const dpeData: DpeData = {
    logement: [],
    logement_sortie: [],
    administratif: [],
    rapport: [],
  };

  const root = parsedXml?.dpe ?? parsedXml;

  ("administratif logement".split(" ")).forEach((sheet) => {
    const section = root[sheet];
    if (section) {
      flattenObjectToRows(section, dpeData[sheet]);
    }
  });

  flattenObjectToRows(root.logement?.sortie, dpeData.logement_sortie, true);

  const rapportRows: any[][] = [];
  const maybeSections = [
    root.logement?.descriptif_simplifie_collection,
    root.logement?.fiche_technique_collection,
    root.descriptif_simplifie_collection,
    root.fiche_technique_collection,
    root.logement?.ventilation_collection,
    root.logement?.installation_chauffage_collection,
    root.logement?.installation_ecs_collection,
    root.descriptif_travaux,
  ];

  maybeSections.forEach((sec) => flattenObjectToRows(sec, rapportRows, true));
  dpeData.rapport = rapportRows;

  return dpeData;
}

export async function getDpeData(dpeNumber: string): Promise<{
  dpeData: DpeData;
  rootXml: any;
}> {
  const xmlText = await fetchDpeXml(dpeNumber);
  const parsedRows = await parseDpeXmlToRows(xmlText);

  const parsedXml = await parseStringPromise(xmlText, {
    explicitArray: false,
    mergeAttrs: true,
  });
  const root = parsedXml?.dpe ?? parsedXml;

  return {
    dpeData: parsedRows,
    rootXml: root,
  };
} 