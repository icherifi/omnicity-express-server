import { Request, Response } from 'express';
import readXlsxFile from 'read-excel-file/node';

interface DpeData {
    administratif?: any[];
    logement?: any[];
    logement_sortie?: any[];
    rapport?: any[];
    lexique?: any[];
}


function transformDpeData(data: DpeData) {

    //logement_sortie => cout, 

    const findValue = (sheet: any[] | undefined, key: string) => {
      if (!sheet) return undefined;
      const row = sheet.find((r) => r[0] === key);
      return row ? row[1] : undefined;
    };
  
    const adresseBien = findValue(data.administratif, "adresse_brut");
    const codePostal = findValue(data.administratif, "code_postal_brut");
    const dateEtablissementDpe = findValue(data.administratif, "date_etablissement_dpe");
    const dateExpirationDpe = findValue(data.administratif, "date_expiration_dpe");
  
    const periodeConstruction = findValue(data.logement, "periode_construction");
    const surfaceHabitable = findValue(data.logement, "surface_habitable");
    const nombreNiveauLogement = findValue(data.logement, "nombre_niveau_logement");
    const typeEnergie = findValue(data.logement, "type_energie");
    const typologieLogement = findValue(data.logement, "typologie_logement");
  
    const etiquetteEnergetique = findValue(data.logement_sortie, "classe_bilan_dpe");
    const etiquetteGes = findValue(data.logement_sortie, "classe_emission_ges");
  
    return {
      adresseBien,
      codePostal,
      dateDpe: dateEtablissementDpe,
      dateExpirationDpe,
      periodeConstruction,
      surfaceHabitable,
      nombreNiveauLogement,
      typeEnergie,
      typologie: typologieLogement,
      etiquetteEnergetique,
      etiquetteGes,
      rapport: data.rapport ?? [],
      lexique: data.lexique ?? [],
    };
}

export const getDpeData = async (req: Request, res: Response) => {
    try {
        const { dpeNumber } = req.params;

        if (!dpeNumber) {
            return res.status(400).json({ error: 'Le numéro de DPE est requis' });
        }

        const resp = await fetch(`https://observatoire-dpe-audit.ademe.fr/pub/dpe/${dpeNumber}/xml-excel`, {
            method: "GET",
        });

        if (!resp.ok) {
            throw new Error('Erreur lors de la récupération du DPE');
        }

        const buffer = Buffer.from(await resp.arrayBuffer());
        const sheets = ['administratif', 'logement', 'logement_sortie', 'rapport', 'lexique'];
        const data: DpeData = {};

        for (const sheet of sheets) {
            try {
                const rows = await readXlsxFile(buffer, { sheet });
                data[sheet as keyof DpeData] = rows;
            } catch (error) {
                console.warn(`Erreur lors de la lecture de la feuille ${sheet}:`, error);
            }
        }

        return res.json(data);
    } catch (error) {
        console.error('Erreur:', error);
        return res.status(500).json({ error: 'Erreur lors de la récupération du DPE' });
    }
};
