// Brand Manager Agent — manages brand voice, style, and learning
// Learns from feedback and past content to improve over time

import { BaseAgent } from "../../core/agent";
import { createMessage, type Message, type TaskPayload, type ResultPayload } from "../../core/message";
import { LLM, type LLMMessage } from "../../core/llm";
import type { Memory } from "../../core/memory";

export interface BrandProfile {
  name: string;
  voice: string;           // "professional", "casual", "witty", etc.
  tone: string;            // "authoritative", "friendly", "provocative"
  audience: string;        // "developers", "startup founders", "marketers"
  industry: string;        // "tech", "finance", "health"
  keywords: string[];      // brand-specific keywords to include
  avoidWords: string[];    // words to never use
  examples: string[];      // example content snippets the brand likes
  socialStyle: {
    twitter: string;       // "thread-heavy", "one-liners", "data-driven"
    linkedin: string;      // "thought-leadership", "storytelling", "educational"
    instagram: string;     // "emoji-heavy", "minimal", "visual-first"
  };
  learnings: string[];     // things learned from feedback
}

const DEFAULT_PROFILE: BrandProfile = {
  name: "default",
  voice: "professional yet approachable",
  tone: "authoritative but friendly",
  audience: "general",
  industry: "technology",
  keywords: [],
  avoidWords: [],
  examples: [],
  socialStyle: {
    twitter: "engaging threads with hooks and data",
    linkedin: "thought leadership with insights",
    instagram: "visual-friendly with emojis",
  },
  learnings: [],
};

export class BrandManagerAgent extends BaseAgent {
  private llm: LLM;
  private memory: Memory;

  constructor(llm: LLM, memory: Memory) {
    super({
      name: "brand-manager",
      description: "Manages brand voice, style preferences, and learns from feedback to improve content quality",
      version: "1.0.0",
      capabilities: [
        {
          name: "get-brand-context",
          description: "Get the brand profile and writing guidelines for content generation",
          inputSchema: { brandName: "string?" },
          outputSchema: { profile: "BrandProfile", guidelines: "string" },
        },
        {
          name: "set-brand",
          description: "Set or update brand profile (voice, tone, audience, etc.)",
          inputSchema: { profile: "Partial<BrandProfile>" },
          outputSchema: { saved: "boolean" },
        },
        {
          name: "learn-from-feedback",
          description: "Learn from user feedback on generated content",
          inputSchema: { feedback: "string", contentType: "string?", rating: "number?" },
          outputSchema: { learned: "string" },
        },
        {
          name: "analyze-sample",
          description: "Analyze a content sample to extract brand voice and style",
          inputSchema: { sample: "string" },
          outputSchema: { analysis: "object" },
        },
      ],
    });
    this.llm = llm;
    this.memory = memory;
  }

  async handle(message: Message): Promise<Message> {
    const task = message.payload as TaskPayload;
    const action = task.action;

    if (action === "set-brand") return this.setBrand(message, task);
    if (action === "learn-from-feedback") return this.learnFromFeedback(message, task);
    if (action === "analyze-sample") return this.analyzeSample(message, task);

    // Default: get-brand-context
    return this.getBrandContext(message, task);
  }

  private async getBrandContext(message: Message, task: TaskPayload): Promise<Message> {
    const brandName = task.input.brandName || "default";
    const profile = this.getProfile(brandName);

    // Build guidelines string for other agents to use
    const guidelines = this.buildGuidelines(profile);

    return createMessage(
      this.name,
      message.from,
      "result",
      {
        success: true,
        output: { profile, guidelines },
      } satisfies ResultPayload,
      message.id
    );
  }

  private async setBrand(message: Message, task: TaskPayload): Promise<Message> {
    const brandName = task.input.name || task.input.brandName || "default";
    const existing = this.getProfile(brandName);

    // Merge with existing
    const updated: BrandProfile = {
      ...existing,
      ...task.input,
      socialStyle: { ...existing.socialStyle, ...(task.input.socialStyle || {}) },
      keywords: [...new Set([...(existing.keywords || []), ...(task.input.keywords || [])])],
      avoidWords: [...new Set([...(existing.avoidWords || []), ...(task.input.avoidWords || [])])],
      examples: [...(existing.examples || []), ...(task.input.examples || [])].slice(-10), // keep last 10
      learnings: [...(existing.learnings || []), ...(task.input.learnings || [])],
    };

    await this.memory.set(`brand:${brandName}`, updated, this.name, ["brand", brandName]);

    // Also update shared memory so other agents can access
    await this.memory.set("brand_voice", updated.voice, this.name, ["brand"]);
    await this.memory.set("brand_tone", updated.tone, this.name, ["brand"]);
    await this.memory.set("brand_audience", updated.audience, this.name, ["brand"]);
    await this.memory.set("social_tone", JSON.stringify(updated.socialStyle), this.name, ["brand"]);

    console.log(`🎨 Brand updated: ${brandName}`);

    return createMessage(
      this.name,
      message.from,
      "result",
      { success: true, output: { saved: true, profile: updated } } satisfies ResultPayload,
      message.id
    );
  }

  private async learnFromFeedback(message: Message, task: TaskPayload): Promise<Message> {
    const feedback = task.input.feedback;
    const contentType = task.input.contentType || "general";
    const rating = task.input.rating; // 1-5

    // Use LLM to extract actionable learning from feedback
    const messages: LLMMessage[] = [
      {
        role: "system",
        content: `You are a brand learning system. Extract actionable writing rules from user feedback.

Convert feedback into specific, reusable rules. Examples:
- "Too formal" → "Use conversational tone, contractions, and shorter sentences"
- "Not enough data" → "Include at least 3 statistics or data points per blog post"
- "Love the humor" → "Continue using light humor and analogies"

Return ONLY valid JSON:
{
  "learning": "the specific actionable rule",
  "applies_to": "blog|social|twitter|linkedin|instagram|all",
  "priority": "high|medium|low"
}`,
      },
      {
        role: "user",
        content: `Feedback on ${contentType} content${rating ? ` (rating: ${rating}/5)` : ''}:\n"${feedback}"`,
      },
    ];

    const response = await this.llm.chat(messages);

    let learning;
    try {
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      learning = jsonMatch ? JSON.parse(jsonMatch[0]) : { learning: feedback, applies_to: "all", priority: "medium" };
    } catch {
      learning = { learning: feedback, applies_to: "all", priority: "medium" };
    }

    // Save to brand profile
    const profile = this.getProfile("default");
    profile.learnings.push(`[${learning.applies_to}] ${learning.learning}`);

    // Keep last 20 learnings
    if (profile.learnings.length > 20) {
      profile.learnings = profile.learnings.slice(-20);
    }

    await this.memory.set("brand:default", profile, this.name, ["brand", "learning"]);
    await this.memory.set(
      `feedback:${Date.now()}`,
      { feedback, learning: learning.learning, contentType, rating },
      this.name,
      ["feedback", contentType]
    );

    console.log(`🧠 Learned: ${learning.learning}`);

    return createMessage(
      this.name,
      message.from,
      "result",
      { success: true, output: { learned: learning.learning, appliesTo: learning.applies_to } } satisfies ResultPayload,
      message.id
    );
  }

  private async analyzeSample(message: Message, task: TaskPayload): Promise<Message> {
    const sample = task.input.sample;

    const messages: LLMMessage[] = [
      {
        role: "system",
        content: `Analyze this content sample and extract the brand voice, tone, and style.

Return ONLY valid JSON:
{
  "voice": "description of writing voice",
  "tone": "description of tone",
  "audience": "who this is written for",
  "characteristics": ["list", "of", "key", "characteristics"],
  "vocabulary_level": "simple|moderate|advanced",
  "sentence_length": "short|medium|long|mixed",
  "use_of_humor": "none|light|heavy",
  "use_of_data": "none|light|heavy",
  "use_of_emojis": "none|light|heavy",
  "recommended_voice": "a concise brand voice description to use as a writing guideline"
}`,
      },
      {
        role: "user",
        content: `Analyze this content:\n\n${sample}`,
      },
    ];

    const response = await this.llm.chat(messages);

    let analysis;
    try {
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      analysis = jsonMatch ? JSON.parse(jsonMatch[0]) : { error: "Could not parse" };
    } catch {
      analysis = { raw: response.content };
    }

    return createMessage(
      this.name,
      message.from,
      "result",
      { success: true, output: { analysis } } satisfies ResultPayload,
      message.id
    );
  }

  // Get brand profile from memory
  private getProfile(name: string): BrandProfile {
    const stored = this.memory.get(`brand:${name}`);
    if (stored) return { ...DEFAULT_PROFILE, ...stored };
    return { ...DEFAULT_PROFILE, name };
  }

  // Build guidelines string for other agents
  private buildGuidelines(profile: BrandProfile): string {
    let g = `## Brand Writing Guidelines\n\n`;
    g += `**Voice:** ${profile.voice}\n`;
    g += `**Tone:** ${profile.tone}\n`;
    g += `**Target Audience:** ${profile.audience}\n`;
    g += `**Industry:** ${profile.industry}\n`;

    if (profile.keywords.length) {
      g += `**Include these keywords when relevant:** ${profile.keywords.join(", ")}\n`;
    }
    if (profile.avoidWords.length) {
      g += `**NEVER use these words:** ${profile.avoidWords.join(", ")}\n`;
    }
    if (profile.examples.length) {
      g += `\n**Content examples the brand likes:**\n`;
      profile.examples.forEach((e, i) => { g += `${i + 1}. "${e.substring(0, 200)}..."\n`; });
    }
    if (profile.learnings.length) {
      g += `\n**Learned preferences (from past feedback):**\n`;
      profile.learnings.forEach((l) => { g += `- ${l}\n`; });
    }

    g += `\n**Social Media Style:**\n`;
    g += `- Twitter: ${profile.socialStyle.twitter}\n`;
    g += `- LinkedIn: ${profile.socialStyle.linkedin}\n`;
    g += `- Instagram: ${profile.socialStyle.instagram}\n`;

    return g;
  }
}
