import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { AgentUnavailableError } from "../agent/control.client.js";
import { ProjectsService } from "./projects.service.js";

const POLL_MS = 750;

/**
 * Keeps working/ in step with the agent without the browser having to ask.
 * One tick is one LOOP state read when nothing changed; a dump only happens
 * for layers whose revision moved. A single in-flight guard means a slow
 * transfer can never stack pollers on top of each other.
 */
@Injectable()
export class AutosaveService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AutosaveService.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly projects: ProjectsService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.tick();
    }, POLL_MS);
    // A poller must not be the reason the process refuses to exit.
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async tick(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;

    try {
      if (!this.projects.isReady()) {
        // Startup restore either ran before the agent was reachable or failed
        // transiently. Retry here rather than waiting for another connect.
        await this.projects.tryRestore();
        return;
      }

      await this.projects.autosave();
    } catch (error) {
      if (error instanceof AgentUnavailableError) {
        this.projects.markOffline();
        return;
      }

      this.logger.warn(
        `auto-save failed: ${error instanceof Error ? error.message : error}`,
      );
    } finally {
      this.running = false;
    }
  }
}
