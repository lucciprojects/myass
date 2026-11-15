import { Module } from "@nestjs/common";
import { AgentModule } from "../agent/agent.module.js";
import { AutosaveService } from "./autosave.service.js";
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
    ProjectsService,
    AutosaveService,
  ],
})
export class ProjectsModule {}
