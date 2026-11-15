import { Module } from "@nestjs/common";
import { AgentModule } from "../agent/agent.module.js";
import { AutosaveService } from "./autosave.service.js";
import { BundleService } from "./bundle.service.js";
import { ExportService } from "./export.service.js";
import { OperationQueue } from "./operation-queue.js";
import { ProjectStore } from "./project.store.js";
import { ProjectsController } from "./projects.controller.js";
import { ProjectsService } from "./projects.service.js";

@Module({
  imports: [AgentModule],
  controllers: [ProjectsController],
  providers: [
    // The root is read here rather than injected so the class stays plain and
    // can be constructed directly by the tests.
    { provide: ProjectStore, useFactory: () => new ProjectStore() },
    OperationQueue,
    ProjectsService,
    AutosaveService,
    BundleService,
    ExportService,
  ],
})
export class ProjectsModule {}
