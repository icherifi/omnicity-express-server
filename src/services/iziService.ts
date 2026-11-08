import { iziAuthHeader } from "../utils/env";
const IZI_API_URL     = "https://qr.izi-by-edf.fr/api/socle/qr";

export interface StepResponse {
  nextStep: {
    id: string;
    node: {
      question: {
        label: string;
        type: string;
        choices?: { id: string; label: string }[];
      };
    };
  };
}

export interface StepAnswer {
  answer: number | number[];
}

function izifetch(path: string, init?: RequestInit) {
  return fetch(`${IZI_API_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: iziAuthHeader(),
      ...(init?.headers ?? {}),
    },
  });
}

export async function createIziSession() {
  const resp = await izifetch("/sessions", {
    method: "POST",
    body: JSON.stringify({ slug: "simulation-renovation-energetique" }),
  } as RequestInit);

  if (!resp.ok) {
    throw new Error(`Erreur création session IZI: ${resp.status}`);
  }

  return resp.json();
}

export async function sendStepAnswer(
  stepId: string,
  answer: StepAnswer
): Promise<StepResponse> {
  const resp = await izifetch(`/steps/${stepId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/merge-patch+json",
    },
    body: JSON.stringify(answer),
  } as RequestInit);

  if (!resp.ok) {
    const errorText = await resp.text();
    throw new Error(
      `Erreur lors de l'envoi de la réponse IZI: ${resp.status} - ${errorText}`
    );
  }

  return (await resp.json()) as StepResponse;
}

export async function getSessionResult(sessionId: string) {
  const resp = await izifetch(`/sessions/${sessionId}/result`, {
    method: "GET",
  } as RequestInit);

  if (!resp.ok) {
    throw new Error(`Erreur résumé IZI: ${resp.status}`);
  }

  return resp.json();
} 