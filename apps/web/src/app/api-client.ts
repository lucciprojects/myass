import {
  ChainSchema,
  LooperStateSchema,
  OutputStateSchema,
  type Chain,
  type EffectSlot,
  type LooperAction,
  type LooperState,
  type OutputState,
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
