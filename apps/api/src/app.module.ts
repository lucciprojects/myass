import { Module } from "@nestjs/common";
import { AgentModule } from "./agent/agent.module.js";
import { DevicesController } from "./devices.controller.js";
import { DevicesService } from "./devices.service.js";
import { OutputService } from "./output.service.js";
import { ProjectsModule } from "./projects/projects.module.js";

@Module({
  imports: [AgentModule, ProjectsModule],
  controllers: [DevicesController],
  providers: [DevicesService, OutputService],
})
export class AppModule {}
