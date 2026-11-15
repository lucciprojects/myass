import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  ProjectIdSchema,
  ProjectListSchema,
  ProjectLoadResultSchema,
  ProjectNameSchema,
  ProjectSummarySchema,
} from "@myass/protocol";
import { AgentUnavailableError } from "../agent/control.client.js";
import { InvalidProjectError } from "./manifest.js";
import { ProjectNotFoundError } from "./project.store.js";
import { ProjectsService } from "./projects.service.js";
import { InvalidWavError } from "./wav.js";

@Controller("projects")
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  async list() {
    return ProjectListSchema.parse(await this.projects.list());
  }

  // SAVE AS: a new named project copied from the working session.
  @Post()
  async create(@Body() body: unknown) {
    const { name } = this.parseName(body);

    return ProjectSummarySchema.parse(
      await this.call(() => this.projects.saveAs(name)),
    );
  }

  @Post(":id/save")
  async save(@Param("id") id: string) {
    return ProjectSummarySchema.parse(
      await this.call(() => this.projects.save(this.projectId(id))),
    );
  }

  @Post(":id/load")
  async load(@Param("id") id: string) {
    return ProjectLoadResultSchema.parse(
      await this.call(() => this.projects.load(this.projectId(id))),
    );
  }

  @Patch(":id")
  async rename(@Param("id") id: string, @Body() body: unknown) {
    const { name } = this.parseName(body);

    return ProjectSummarySchema.parse(
      await this.call(() => this.projects.rename(this.projectId(id), name)),
    );
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(@Param("id") id: string): Promise<void> {
    await this.call(() => this.projects.remove(this.projectId(id)));
  }

  private parseName(body: unknown): { name: string } {
    const parsed = ProjectNameSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues);
    }

    return parsed.data;
  }

  private projectId(raw: string): string {
    if (!ProjectIdSchema.safeParse(raw).success) {
      // Refuse before the store ever joins the string onto a path.
      throw new NotFoundException(`no project ${raw}`);
    }

    return raw;
  }

  private async call<T>(task: () => Promise<T>): Promise<T> {
    try {
      return await task();
    } catch (error) {
      if (error instanceof InvalidWavError || error instanceof InvalidProjectError) {
        throw new BadRequestException(error.message);
      }

      if (error instanceof ProjectNotFoundError) {
        throw new NotFoundException(error.message);
      }

      if (error instanceof AgentUnavailableError) {
        throw new ServiceUnavailableException(error.message);
      }

      throw error;
    }
  }
}
