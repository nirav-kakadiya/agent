// Orchestrator Agent — THE manager
// Routes tasks to the right agents via the message bus
// Doesn't do work itself — delegates everything

import { BaseAgent } from "../../core/agent";
import { createMessage, type Message, type TaskPayload, type ResultPayload } from "../../core/message";
import { MessageBus } from "../../core/bus";
import { LLM, type LLMMessage } from "../../core/llm";
import type { Memory } from "../../core/memory";

export class OrchestratorAgent extends BaseAgent {
  private llm: LLM;
  private bus: MessageBus;
  private memory: Memory;

  constructor(llm: LLM, bus: MessageBus, memory: Memory) {
    super({
      name: "orchestrator",
      description: "Plans and coordinates tasks across all agents",
      version: "1.0.0",
      capabilities: [
        {
          name: "orchestrate",
          description: "Break down a request and coordinate agents to complete it",
          inputSchema: { request: "string" },
          outputSchema: { result: "string", steps: "object[]" },
        },
      ],
    });
    this.llm = llm;
    this.bus = bus;
    this.memory = memory;
  }

  async handle(message: Message): Promise<Message> {
    const request = message.payload?.input?.request || message.payload?.request || JSON.stringify(message.payload);
    console.log(`\n🎯 Orchestrating: ${request}\n`);

    // Step 1: Plan — ask LLM what agents to use in what order
    const plan = await this.createPlan(request);
    console.log(`📋 Plan:\n${JSON.stringify(plan, null, 2)}\n`);

    // Step 2: Execute plan step by step
    const results: any[] = [];
    let previousOutput: any = null;

    for (const step of plan.steps) {
      console.log(`\n▶️  Step ${step.order}: ${step.agent} → ${step.action}`);

      // Merge previous step output into current step input
      const input = { ...step.input };
      if (previousOutput) {
        // Pass relevant data from previous step
        if (previousOutput.findings) input.research = previousOutput.findings;
        if (previousOutput.content) input.content = previousOutput.content;
        if (previousOutput.editedContent) input.content = previousOutput.editedContent;
        if (previousOutput.optimizedContent) input.content = previousOutput.optimizedContent;
        if (previousOutput.title && !input.title) input.title = previousOutput.title;
        if (previousOutput.post) input.content = previousOutput.post;
        if (previousOutput.summary) input.summary = previousOutput.summary;
      }

      // Extract title from content if not set
      if (!input.title && input.content) {
        const titleMatch = input.content.match(/^#\s+(.+)$/m);
        if (titleMatch) input.title = titleMatch[1];
      }

      // Send task to the agent via the bus
      const taskMsg = createMessage(
        this.name,
        step.agent,
        "task",
        { action: step.action, input, context: step.context || {} } satisfies TaskPayload
      );

      const response = await this.bus.send(taskMsg);

      if (response.type === "error") {
        // Check if we need to build an integration
        const errorPayload = response.payload;
        if (errorPayload.needsBuild) {
          console.log(`🔧 Need to build integration: ${errorPayload.needsBuild}`);
          const buildResult = await this.buildIntegration(errorPayload.needsBuild);
          if (buildResult) {
            // Retry the step
            const retryResponse = await this.bus.send(taskMsg);
            if (retryResponse.type !== "error") {
              previousOutput = retryResponse.payload?.output;
              results.push({ step: step.order, agent: step.agent, output: previousOutput });
              continue;
            }
          }
          results.push({ step: step.order, agent: step.agent, error: errorPayload.message });
          continue;
        }
        results.push({ step: step.order, agent: step.agent, error: errorPayload.message });
        console.log(`❌ Step failed: ${errorPayload.message}`);
        continue;
      }

      previousOutput = response.payload?.output;
      results.push({ step: step.order, agent: step.agent, output: previousOutput });
      console.log(`✅ Step ${step.order} complete`);
    }

    // Save execution to memory
    await this.memory.set(
      `task_${Date.now()}`,
      { request, steps: plan.steps.length, success: true },
      this.name,
      ["task", "completed"]
    );

    // Compile final result
    const finalOutput = previousOutput;
    const summary = results
      .map((r) => `Step ${r.step} (${r.agent}): ${r.error ? "❌ " + r.error : "✅"}`)
      .join("\n");

    return createMessage(
      this.name,
      message.from,
      "result",
      {
        success: true,
        output: {
          finalContent: finalOutput?.content || finalOutput?.editedContent || finalOutput,
          title: finalOutput?.title,
          summary,
          steps: results,
        },
      } satisfies ResultPayload,
      message.id
    );
  }

  // Ask LLM to create a plan
  private async createPlan(request: string): Promise<{ steps: PlanStep[] }> {
    const agents = this.bus.describeAll();
    const memories = this.memory.summary();

    const messages: LLMMessage[] = [
      {
        role: "system",
        content: `You are a task planner. Break down the user's request into steps, assigning each step to an available agent.

Available agents:
${agents}

Agent memories:
${memories}

Respond with ONLY valid JSON (no markdown):
{
  "steps": [
    {
      "order": 1,
      "agent": "agent-name",
      "action": "capability-name",
      "input": { "key": "value" },
      "description": "what this step does"
    }
  ]
}

RULES:
- Use ONLY agents that exist (listed above)
- Each step's output feeds into the next step automatically
- For content tasks, typical flow: researcher → writer → editor → publisher
- If publishing is requested but no platform specified, skip publisher
- Keep it simple — minimum steps needed`,
      },
      { role: "user", content: request },
    ];

    const response = await this.llm.chat(messages);

    try {
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("No JSON found");
      return JSON.parse(jsonMatch[0]);
    } catch {
      // Fallback: simple research + write plan
      return {
        steps: [
          { order: 1, agent: "researcher", action: "research", input: { topic: request, depth: "quick" }, description: "Research the topic" },
          { order: 2, agent: "writer", action: "write-blog", input: { topic: request }, description: "Write the content" },
          { order: 3, agent: "editor", action: "edit", input: {}, description: "Edit and improve" },
        ],
      };
    }
  }

  // Build a missing integration via the skill-builder agent
  private async buildIntegration(service: string): Promise<boolean> {
    const buildMsg = createMessage(
      this.name,
      "skill-builder",
      "task",
      { action: "build-integration", input: { service } } satisfies TaskPayload
    );

    const result = await this.bus.send(buildMsg);

    if (result.type === "result" && result.payload?.success) {
      // Reload publisher integrations
      const publisher = this.bus.getAgent("publisher") as any;
      if (publisher?.reload) await publisher.reload();
      return true;
    }
    return false;
  }
}

interface PlanStep {
  order: number;
  agent: string;
  action: string;
  input: Record<string, any>;
  description?: string;
  context?: Record<string, any>;
}
