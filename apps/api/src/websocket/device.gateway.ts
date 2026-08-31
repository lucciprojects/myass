import { Injectable } from "@nestjs/common";
import WebSocket from "ws";

@Injectable()
export class DeviceGateway {
  private readonly clients = new Set<WebSocket>();

  addClient(client: WebSocket) {
    this.clients.add(client);
    client.on("close", () => this.clients.delete(client));
  }

  broadcast(message: unknown) {
    const payload = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }
}
