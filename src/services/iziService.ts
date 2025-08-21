const IZI_API_URL     = "https://qr.izi-by-edf.fr/api/socle/qr";
const IZI_AUTH_TOKEN  = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9eyJzdWIiOiJUZXN0IiwibmFtZSI6IlFSIFNlcnZpY2UiLCJpYXQiOjE1MTYyMzkyMzR9JngCUr2KcZHQ-AYl6esoTdE-t-cv6RfxvmbCBwaAItA";

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

function assertTokenPresent() {
  if (!IZI_AUTH_TOKEN) {
    throw new Error(
      "IZI_AUTH_TOKEN is not set – please provide it as an environment variable"
    );
  }
}

function izifetch(path: string, init?: RequestInit) {
  assertTokenPresent();
  return fetch(`${IZI_API_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: IZI_AUTH_TOKEN,
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