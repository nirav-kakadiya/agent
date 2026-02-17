// Writer Agent — writes content (blogs, posts, articles)

import { BaseAgent } from "../../core/agent";
import { createMessage, type Message, type TaskPayload, type ResultPayload } from "../../core/message";
import { LLM, type LLMMessage } from "../../core/llm";
import type { Memory } from "../../core/memory";

export class WriterAgent extends BaseAgent {
  private llm: LLM;
  private memory: Memory;

  constructor(llm: LLM, memory: Memory) {
    super({
      name: "writer",
      description: "Writes content — blog posts, social media posts, articles",
      version: "1.0.0",
      capabilities: [
        {
          name: "write-blog",
          description: "Write a blog post from research or a topic",
          inputSchema: { topic: "string", research: "string?", tone: "string?", wordCount: "number?" },
          outputSchema: { title: "string", content: "string", summary: "string" },
        },
        {
          name: "write-social",
          description: "Write social media posts (tweet, LinkedIn, etc.)",
          inputSchema: { content: "string", platform: "string" },
          outputSchema: { post: "string" },
        },
      ],
    });
    this.llm = llm;
    this.memory = memory;
  }

  async handle(message: Message): Promise<Message> {
    const task = message.payload as TaskPayload;

    // Check for brand guidelines (injected by orchestrator) or fall back to memory
    const brandGuidelines = task.input._brandGuidelines || "";
    const brandVoice = this.memory.get("brand_voice") || "professional yet approachable";
    const pastLearnings = this.memory.byAgent(this.name).slice(-5);
    const contextFromMemory = pastLearnings.length
      ? `\nPast learnings:\n${pastLearnings.map((e) => `- ${e.key}: ${e.value}`).join("\n")}`
      : "";

    const action = task.action || "write-blog";

    if (action === "write-social") {
      return this.writeSocial(message, task);
    }

    const messages: LLMMessage[] = [
      {
        role: "system",
        content: `You are an expert content writer. Write engaging, well-structured content.

${brandGuidelines || `Brand voice: ${brandVoice}`}
${contextFromMemory}

Guidelines:
- Write a compelling title
- Use clear structure with headers
- Include an engaging introduction
- Provide actionable insights
- End with a strong conclusion
- Target word count: ${task.input.wordCount || 1500}

Output format:
# [Title]

[Full blog post content with markdown formatting]

---
Summary: [2-3 sentence summary]`,
      },
      {
        role: "user",
        content: `Write a blog post about: ${task.input.topic || "the given topic"}

${task.input.research ? `Research findings to use:\n${task.input.research}` : ""}
${task.input.tone ? `Tone: ${task.input.tone}` : ""}`,
      },
    ];

    const response = await this.llm.chat(messages);

    // Extract title from response
    const titleMatch = response.content.match(/^#\s+(.+)$/m);
    const title = titleMatch?.[1] || task.input.topic || "Untitled";

    return createMessage(
      this.name,
      message.from,
      "result",
      {
        success: true,
        output: {
          title,
          content: response.content,
          summary: response.content.match(/Summary:\s*(.+)/)?.[1] || "",
        },
      } satisfies ResultPayload,
      message.id
    );
  }

  private async writeSocial(message: Message, task: TaskPayload): Promise<Message> {
    const platform = task.input.platform || "twitter";
    const maxLength = platform === "twitter" ? 280 : 3000;

    const messages: LLMMessage[] = [
      {
        role: "system",
        content: `Write a ${platform} post. Max ${maxLength} characters. Make it engaging and shareable. Include relevant hashtags.`,
      },
      {
        role: "user",
        content: `Create a ${platform} post about:\n${task.input.content || task.input.topic}`,
      },
    ];

    const response = await this.llm.chat(messages);

    return createMessage(
      this.name,
      message.from,
      "result",
      { success: true, output: { post: response.content, platform } } satisfies ResultPayload,
      message.id
    );
  }
}
