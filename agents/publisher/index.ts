// Publisher Agent — publishes content to platforms (WordPress, Twitter, etc.)
// Uses self-built integrations from the integrations/ folder
// Always saves locally + publishes to requested platforms

import { BaseAgent } from "../../core/agent";
import { createMessage, type Message, type TaskPayload, type ResultPayload } from "../../core/message";
import { Executor } from "../../core/executor";
import { readdir, readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";

interface Integration {
  name: string;
  description: string;
  code: string;
  requirements: { name: string; description: string; type: string; required: boolean }[];
}

export class PublisherAgent extends BaseAgent {
  private executor: Executor;
  private integrationsDir: string;
  private outputDir: string;
  private integrations: Map<string, Integration> = new Map();

  constructor(executor: Executor, integrationsDir: string, outputDir: string) {
    super({
      name: "publisher",
      description: "Publishes content to platforms and saves locally",
      version: "2.0.0",
      capabilities: [
        {
          name: "publish",
          description: "Publish content to one or more platforms (wordpress, twitter, linkedin, local-file)",
          inputSchema: { platform: "string|string[]", content: "string", title: "string?", summary: "string?" },
          outputSchema: { results: "object[]" },
        },
        {
          name: "list-platforms",
          description: "List available publishing platforms",
          inputSchema: {},
          outputSchema: { platforms: "string[]" },
        },
      ],
    });
    this.executor = executor;
    this.integrationsDir = integrationsDir;
    this.outputDir = outputDir;
  }

  async init() {
    await mkdir(this.outputDir, { recursive: true });
    await this.loadIntegrations();
  }

  private async loadIntegrations() {
    try {
      const files = await readdir(this.integrationsDir);
      for (const file of files) {
        if (file.endsWith(".json")) {
          const content = await readFile(join(this.integrationsDir, file), "utf-8");
          const integration: Integration = JSON.parse(content);
          this.integrations.set(integration.name, integration);
        }
      }
      if (this.integrations.size > 0) {
        console.log(`📤 Publisher: ${this.integrations.size} integrations (${Array.from(this.integrations.keys()).join(", ")})`);
      }
    } catch {}
  }

  async handle(message: Message): Promise<Message> {
    const task = message.payload as TaskPayload;

    if (task.action === "list-platforms") {
      return createMessage(
        this.name,
        message.from,
        "result",
        {
          success: true,
          output: {
            platforms: Array.from(this.integrations.keys()),
            descriptions: Array.from(this.integrations.values()).map((i) => ({
              name: i.name,
              description: i.description,
            })),
          },
        } satisfies ResultPayload,
        message.id
      );
    }

    // Determine platforms to publish to
    let platforms: string[] = [];
    if (task.input.platform) {
      platforms = Array.isArray(task.input.platform) ? task.input.platform : [task.input.platform];
    }

    // Always save locally first
    const results: any[] = [];
    const localResult = await this.saveLocally(task.input);
    results.push({ platform: "local-file", ...localResult });

    // Publish to each requested platform
    for (const platform of platforms) {
      const p = platform.toLowerCase();
      if (p === "local-file" || p === "local") continue; // already saved

      const integration = this.integrations.get(p);
      if (!integration) {
        results.push({
          platform: p,
          success: false,
          error: `No integration for "${p}". Available: ${Array.from(this.integrations.keys()).join(", ")}`,
          needsBuild: p,
        });
        continue;
      }

      // Check if credentials are available
      const missingCreds = integration.requirements
        .filter((r) => r.required && !this.executor.getCredential(r.name))
        .map((r) => r.name);

      if (missingCreds.length > 0) {
        results.push({
          platform: p,
          success: false,
          error: `Missing credentials: ${missingCreds.join(", ")}. Set them as environment variables.`,
          missingCredentials: missingCreds,
        });
        continue;
      }

      // Execute the integration
      try {
        const execResult = await this.executor.run(integration.code, {
          action: "publish",
          title: task.input.title,
          content: task.input.content,
          summary: task.input.summary,
          ...task.input,
        });

        results.push({
          platform: p,
          success: execResult.success,
          data: execResult.output,
          error: execResult.error,
        });
      } catch (err: any) {
        results.push({
          platform: p,
          success: false,
          error: err.message,
        });
      }
    }

    // Check if any platform needs building
    const needsBuild = results.find((r) => r.needsBuild);

    return createMessage(
      this.name,
      message.from,
      needsBuild ? "error" : "result",
      needsBuild
        ? {
            code: "INTEGRATION_NOT_FOUND",
            message: `Missing integration: ${needsBuild.needsBuild}`,
            needsBuild: needsBuild.needsBuild,
            partialResults: results,
            retryable: false,
          }
        : {
            success: true,
            output: {
              results,
              publishedTo: results.filter((r) => r.success).map((r) => r.platform),
              failedOn: results.filter((r) => !r.success).map((r) => `${r.platform}: ${r.error}`),
            },
          } satisfies ResultPayload,
      message.id
    );
  }

  // Always save content locally as markdown
  private async saveLocally(input: any): Promise<{ success: boolean; path?: string; error?: string }> {
    try {
      const title = input.title || "Untitled";
      const content = input.content || "";
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const date = new Date().toISOString().split("T")[0];
      const filename = `${date}-${slug}.md`;
      const filePath = join(this.outputDir, filename);

      const markdown = `---
title: "${title}"
date: ${new Date().toISOString()}
status: published
---

${content}
`;

      await writeFile(filePath, markdown);
      console.log(`💾 Saved locally: ${filename}`);
      return { success: true, path: filePath };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async reload() {
    this.integrations.clear();
    await this.loadIntegrations();
  }
}
