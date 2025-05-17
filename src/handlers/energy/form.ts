import { Request, Response } from "express";

export async function createSession(req: Request, res: Response) {
    const slug = "simulation-renovation-energetique";
  
    const resp = await fetch("https://qr.izi-by-edf.fr/api/socle/qr/sessions", {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        Authorization: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9eyJzdWIiOiJUZXN0IiwibmFtZSI6IlFSIFNlcnZpY2UiLCJpYXQiOjE1MTYyMzkyMzR9JngCUr2KcZHQ-AYl6esoTdE-t-cv6RfxvmbCBwaAItA"
      },
      body: JSON.stringify({ slug })
    });
    if (!resp.ok) {
      console.error(`Erreur création session: ${resp.status}`);
      return res.status(500).json({ error: `Erreur création session: ${resp.status}` });
    }
    
    const data = await resp.json();
    return res.json(data);
  }
  
export async function sendStepAnswer(req: Request, res: Response) {
  const { stepId, answer } = req.body;

  if (!stepId || !answer) {
    return res.status(400).json({ error: "stepId et answer sont requis" });
  }

  const resp = await fetch(`https://qr.izi-by-edf.fr/api/socle/qr/steps/${stepId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/merge-patch+json",
      Authorization:
        "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9eyJzdWIiOiJUZXN0IiwibmFtZSI6IlFSIFNlcnZpY2UiLCJpYXQiOjE1MTYyMzkyMzR9JngCUr2KcZHQ-AYl6esoTdE-t-cv6RfxvmbCBwaAItA",
    },
    body: JSON.stringify({ answer }),
  });
  if (!resp.ok) return res.status(500).json({ error: "Erreur sendStepAnswer " + resp.statusText });

  const data = await resp.json();
  return res.status(200).json(data);
}
  
export async function getQuizSummary(req: Request, res: Response) {
  const { sessionId } = req.params;
  const resp = await fetch(`https://qr.izi-by-edf.fr/api/socle/qr/sessions/${sessionId}/result`, {
    headers: {
      Authorization:
        "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9eyJzdWIiOiJUZXN0IiwibmFtZSI6IlFSIFNlcnZpY2UiLCJpYXQiOjE1MTYyMzkyMzR9JngCUr2KcZHQ-AYl6esoTdE-t-cv6RfxvmbCBwaAItA",
    },
  });
  if (!resp.ok) return res.status(500).json({ error: "Erreur getQuizSummary " + resp.statusText });

  const data = await resp.json();
  return res.status(200).json(data);
}

export async function getQuizResults(req: Request, res: Response) {
  const { responses } = req.body;
  
  try {
    const response = await fetch(
      "https://api.irenov.izi-by-edf.fr/api/session",
      {
        method: "POST",
        headers: {
          accept: "application/json, text/plain",
          "accept-language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
          "content-type": "application/json",
          priority: "u=1, i",
          "sec-ch-ua":
          '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-platform": '"Windows"',
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "cross-site",
          Referer: "https://www.izi-by-edf-renov.fr/",
          "Referrer-Policy": "strict-origin-when-cross-origin",
        },
        body: JSON.stringify(responses),
      }
    );

    if (!response.ok) throw new Error(response.statusText);

    const data = await response.json();
    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: "Erreur getQuizResults " + error });
  }
}
