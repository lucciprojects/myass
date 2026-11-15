import {
  ChainSchema,
  LooperStateSchema,
  OutputStateSchema,
  ProjectListSchema,
  ProjectLoadResultSchema,
  ProjectSummarySchema,
  type Chain,
  type EffectSlot,
  type LooperAction,
  type LooperState,
  type OutputState,
  type ProjectList,
  type ProjectSummary,
} from "@myass/protocol";

/**
 * Shared so the chain and the looper cannot drift apart on where the API is or
 * on how a failure is reported. Every request in the app goes through here.
 */
export const apiUrl =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

/**
 * Every failure mode collapses into one thrown Error, so the status line can
 * name the actual cause: a 400 means the agent cannot see a guitar signal, so
 * it maps to one friendly line; a 503 says the agent answered and refused or
 * is unreachable; and a bare fetch failure means the request never arrived at
 * all (CORS, wrong host, API not running).
 */
export async function describeFailure(
  action: string,
  response: Response,
): Promise<string> {
  if (response.status === 400) {
    return "Guitar signal not found. Please double check your connection.";
  }

  let detail: string;

  try {
    detail = (await response.text()).slice(0, 200);
  } catch {
    detail = "<unreadable body>";
  }

  return `${action}: HTTP ${response.status} ${detail}`;
}

export async function getChain(): Promise<Chain> {
  const response = await fetch(`${apiUrl}/devices/chain`);

  if (!response.ok) {
    throw new Error(await describeFailure("load chain", response));
  }

  return ChainSchema.parse(await response.json());
}

export async function putChain(slots: EffectSlot[]): Promise<Chain> {
  const response = await fetch(`${apiUrl}/devices/chain`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(ChainSchema.parse({ slots })),
  });

  if (!response.ok) {
    throw new Error(await describeFailure("apply chain", response));
  }

  return ChainSchema.parse(await response.json());
}

export async function getLooper(): Promise<LooperState> {
  const response = await fetch(`${apiUrl}/devices/looper`);

  if (!response.ok) {
    throw new Error(await describeFailure("load looper", response));
  }

  return LooperStateSchema.parse(await response.json());
}

/**
 * Returns the state the agent reports after the action rather than a bare ack,
 * so the caller never has to guess what the looper did with it.
 */
export async function postLooper(action: LooperAction): Promise<LooperState> {
  const response = await fetch(`${apiUrl}/devices/looper`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(action),
  });

  if (!response.ok) {
    throw new Error(await describeFailure(`looper ${action.action}`, response));
  }

  return LooperStateSchema.parse(await response.json());
}

export async function getOutput(): Promise<OutputState> {
  const response = await fetch(`${apiUrl}/devices/output`);

  if (!response.ok) {
    throw new Error(await describeFailure("load output", response));
  }

  return OutputStateSchema.parse(await response.json());
}

/**
 * Routes the rig to a specific sink — the amp's USB codec, the built-in
 * speakers, or a connected Bluetooth headset. The route lives in PipeWire, so
 * the API returns the new state rather than a bare ack.
 */
export async function routeOutput(node: string): Promise<OutputState> {
  const response = await fetch(`${apiUrl}/devices/output`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ node }),
  });

  if (!response.ok) {
    throw new Error(await describeFailure("route output", response));
  }

  return OutputStateSchema.parse(await response.json());
}

export async function listProjects(): Promise<ProjectList> {
  const response = await fetch(`${apiUrl}/projects`);

  if (!response.ok) {
    throw new Error(await describeFailure("list projects", response));
  }

  return ProjectListSchema.parse(await response.json());
}

export async function saveAsProject(name: string): Promise<ProjectSummary> {
  const response = await fetch(`${apiUrl}/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });

  if (!response.ok) {
    throw new Error(await describeFailure("save as", response));
  }

  return ProjectSummarySchema.parse(await response.json());
}

export async function saveProject(id: string): Promise<ProjectSummary> {
  const response = await fetch(`${apiUrl}/projects/${encodeURIComponent(id)}/save`, {
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(await describeFailure("save project", response));
  }

  return ProjectSummarySchema.parse(await response.json());
}

export async function loadProject(
  id: string,
): Promise<{ state: LooperState }> {
  const response = await fetch(`${apiUrl}/projects/${encodeURIComponent(id)}/load`, {
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(await describeFailure("load project", response));
  }

  const parsed = ProjectLoadResultSchema.parse(await response.json());

  return { state: parsed.state };
}

export async function renameProject(
  id: string,
  name: string,
): Promise<ProjectSummary> {
  const response = await fetch(`${apiUrl}/projects/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });

  if (!response.ok) {
    throw new Error(await describeFailure("rename project", response));
  }

  return ProjectSummarySchema.parse(await response.json());
}

export async function deleteProject(id: string): Promise<void> {
  const response = await fetch(`${apiUrl}/projects/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });

  if (!response.ok) {
    throw new Error(await describeFailure("delete project", response));
  }
}

export async function importProject(file: File): Promise<ProjectSummary> {
  const response = await fetch(`${apiUrl}/projects/import`, {
    method: "POST",
    headers: { "Content-Type": "application/zip" },
    body: file,
  });

  if (!response.ok) {
    throw new Error(await describeFailure("import project", response));
  }

  const body = (await response.json()) as { project: unknown };

  return ProjectSummarySchema.parse(body.project);
}

export function exportUrl(id: string, kind: "fl" | "bundle"): string {
  return `${apiUrl}/projects/${encodeURIComponent(id)}/export?kind=${kind}`;
}

export async function setTempo(
  bpm: number,
  beatsPerBar: number,
): Promise<LooperState> {
  return postLooper({ action: "tempo", bpm, beats: beatsPerBar });
}

export async function setBars(bars: number): Promise<LooperState> {
  return postLooper({ action: "bars", bars });
}

export async function setClick(
  mode: "off" | "countin" | "countin-record",
): Promise<LooperState> {
  return postLooper({ action: "click", click: mode });
}
