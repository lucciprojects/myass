"use client";

import { useQuery } from "@tanstack/react-query";
import { effectDefinitions } from "@myass/effects";

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

async function getDevices() {
  const response = await fetch(`${apiUrl}/devices`);
  if (!response.ok) throw new Error("Failed to load devices");
  return response.json() as Promise<
    Array<{
      id: string;
      name: string;
      status: "online" | "offline";
      firmwareVersion: string;
    }>
  >;
}

export default function Home() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["devices"],
    queryFn: getDevices,
  });

  return (
    <main style={{ maxWidth: 1200, margin: "0 auto", padding: 32 }}>
      <header style={{ marginBottom: 32 }}>
        <div style={{ fontSize: 13, opacity: 0.55, letterSpacing: 2 }}>
          MIKE&apos;S YODELLING AUDIAL STRING SYNTHESIZER
        </div>
        <h1 style={{ fontSize: 48, margin: "8px 0" }}>MYASS</h1>
        <p style={{ opacity: 0.65 }}>
          Programmable guitar effects, controlled from anywhere.
        </p>
      </header>

      <section style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
        <div style={{ border: "1px solid #27272a", borderRadius: 16, padding: 20 }}>
          <div style={{ opacity: 0.6, fontSize: 12 }}>DEVICE</div>
          {isLoading && <p>Connecting…</p>}
          {error && <p>API unavailable.</p>}
          {data?.map((device) => (
            <div key={device.id}>
              <h2>{device.name}</h2>
              <p>
                <span style={{ color: device.status === "online" ? "#4ade80" : "#71717a" }}>
                  ●
                </span>{" "}
                {device.status}
              </p>
              <small style={{ opacity: 0.55 }}>
                Firmware {device.firmwareVersion}
              </small>
            </div>
          ))}
        </div>

        <div style={{ border: "1px solid #27272a", borderRadius: 16, padding: 20 }}>
          <div style={{ opacity: 0.6, fontSize: 12 }}>EFFECT LIBRARY</div>
          {effectDefinitions.map((effect) => (
            <div key={effect.type} style={{ padding: "12px 0", borderBottom: "1px solid #18181b" }}>
              <strong>{effect.name}</strong>
              <div style={{ opacity: 0.55, fontSize: 13 }}>{effect.description}</div>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
