// Social Writer Agent — converts blog content into platform-specific posts
// One blog → tweet thread + LinkedIn post + Instagram caption + Facebook post

import { BaseAgent } from "../../core/agent";
import { createMessage, type Message, type TaskPayload, type ResultPayload } from "../../core/message";
import { LLM, type LLMMessage } from "../../core/llm";
import type { Memory } from "../../core/memory";

export interface SocialOutput {
  twitter: { thread: string[]; hashtags: string[] };
  linkedin: { post: string; hashtags: string[] };
  instagram: { caption: string; hashtags: string[] };
  facebook: { post: string };
}

export class SocialWriterAgent extends BaseAgent {
  private llm: LLM;
  private memory: Memory;

  constructor(llm: LLM, memory: Memory) {
    super({
      name: "social-writer",
      description: "Converts blog content into optimized posts for Twitter, LinkedIn, Instagram, and Facebook",
      version: "1.0.0",
      capabilities: [
        {
          name: "blog-to-social",
          description: "Convert a blog post into platform-specific social media content",
          inputSchema: { content: "string", title: "string?", platforms: "string[]?" },
          outputSchema: { twitter: "object", linkedin: "object", instagram: "object", facebook: "object" },
        },
        {
          name: "write-thread",
          description: "Write a Twitter/X thread from content",
          inputSchema: { content: "string", maxTweets: "number?" },
          outputSchema: { thread: "string[]", hashtags: "string[]" },
        },
        {
          name: "write-linkedin",
          description: "Write a LinkedIn post from content",
          inputSchema: { content: "string" },
          outputSchema: { post: "string", hashtags: "string[]" },
        },
        {
          name: "write-instagram",
          description: "Write an Instagram caption from content",
          inputSchema: { content: "string" },
          outputSchema: { caption: "string", hashtags: "string[]" },
        },
      ],
    });
    this.llm = llm;
    this.memory = memory;
  }

  async handle(message: Message): Promise<Message> {
    const task = message.payload as TaskPayload;
    const action = task.action || "blog-to-social";

    // Get brand guidelines (injected by orchestrator) or fall back to memory
    const brandGuidelines = task.input._brandGuidelines || "";
    const brandVoice = this.memory.get("brand_voice") || "";
    const tonePrefs = this.memory.get("social_tone") || "";
    const voiceContext = brandGuidelines
      ? `\n${brandGuidelines}`
      : (brandVoice || tonePrefs ? `\nBrand voice: ${brandVoice}\nSocial tone: ${tonePrefs}` : "");

    if (action === "write-thread") {
      return this.writeThread(message, task, voiceContext);
    }
    if (action === "write-linkedin") {
      return this.writeLinkedIn(message, task, voiceContext);
    }
    if (action === "write-instagram") {
      return this.writeInstagram(message, task, voiceContext);
    }

    // Default: blog-to-social — generate ALL platforms at once
    return this.blogToSocial(message, task, voiceContext);
  }

  private async blogToSocial(message: Message, task: TaskPayload, voiceContext: string): Promise<Message> {
    const content = task.input.content || "";
    const title = task.input.title || "";

    const messages: LLMMessage[] = [
      {
        role: "system",
        content: `You are a social media content expert. Convert blog content into platform-specific posts.
${voiceContext}

Generate content for ALL platforms in this EXACT JSON format (no markdown, no backticks):

{
  "twitter": {
    "thread": ["tweet 1 (max 280 chars)", "tweet 2", "tweet 3", "..."],
    "hashtags": ["hashtag1", "hashtag2"]
  },
  "linkedin": {
    "post": "full linkedin post (1000-1500 chars, professional tone, use line breaks and emojis)",
    "hashtags": ["hashtag1", "hashtag2"]
  },
  "instagram": {
    "caption": "engaging caption (max 2200 chars, conversational, emoji-rich)",
    "hashtags": ["hashtag1", "hashtag2", "up to 30"]
  },
  "facebook": {
    "post": "engaging facebook post (300-500 chars, conversational, shareable)"
  }
}

RULES:
- Twitter: thread of 4-8 tweets, first tweet is the hook, last is CTA. Each tweet MUST be ≤280 chars.
- LinkedIn: professional but not boring. Use line breaks. Start with a hook. Include insights/stats.
- Instagram: visual-friendly caption. Use emojis. End with CTA. Separate hashtags.
- Facebook: conversational, shareable. Ask a question or make a bold statement.
- Each platform should feel NATIVE — not copy-pasted from the blog.
- Pull the most interesting stats, quotes, and insights from the blog.

Return ONLY valid JSON.`,
      },
      {
        role: "user",
        content: `Convert this blog into social media posts:\n\nTitle: ${title}\n\n${content}`,
      },
    ];

    const response = await this.llm.chat(messages);

    let socialContent: SocialOutput;
    try {
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("No JSON found");
      socialContent = JSON.parse(jsonMatch[0]);
    } catch {
      // Fallback: return raw content
      return createMessage(
        this.name,
        message.from,
        "error",
        { code: "PARSE_ERROR", message: "Failed to parse social content. Raw response available.", retryable: true },
        message.id
      );
    }

    // Validate twitter thread tweet lengths
    if (socialContent.twitter?.thread) {
      socialContent.twitter.thread = socialContent.twitter.thread.map((tweet) =>
        tweet.length > 280 ? tweet.substring(0, 277) + "..." : tweet
      );
    }

    return createMessage(
      this.name,
      message.from,
      "result",
      {
        success: true,
        output: socialContent,
      } satisfies ResultPayload,
      message.id
    );
  }

  private async writeThread(message: Message, task: TaskPayload, voiceContext: string): Promise<Message> {
    const maxTweets = task.input.maxTweets || 8;

    const messages: LLMMessage[] = [
      {
        role: "system",
        content: `You are a Twitter/X thread expert. Write viral threads that get engagement.
${voiceContext}

RULES:
- ${maxTweets} tweets maximum
- Each tweet MUST be ≤280 characters
- First tweet = hook (make people stop scrolling)
- Use numbers, insights, hot takes
- Last tweet = CTA (follow, retweet, bookmark)
- Add 🧵 to first tweet
- NO hashtags in tweets, list them separately

Return ONLY valid JSON:
{
  "thread": ["tweet1", "tweet2", "..."],
  "hashtags": ["tag1", "tag2"]
}`,
      },
      {
        role: "user",
        content: `Write a thread about:\n\n${task.input.content}`,
      },
    ];

    const response = await this.llm.chat(messages);
    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    const result = jsonMatch ? JSON.parse(jsonMatch[0]) : { thread: [response.content], hashtags: [] };

    return createMessage(this.name, message.from, "result", {
      success: true,
      output: result,
    } satisfies ResultPayload, message.id);
  }

  private async writeLinkedIn(message: Message, task: TaskPayload, voiceContext: string): Promise<Message> {
    const messages: LLMMessage[] = [
      {
        role: "system",
        content: `You are a LinkedIn content expert. Write posts that get professional engagement.
${voiceContext}

RULES:
- Start with a bold hook (first 2 lines are crucial — that's what shows before "see more")
- Use short paragraphs and line breaks
- Include insights, stats, or lessons
- Professional but human tone
- End with a question or CTA
- 1000-1500 characters

Return ONLY valid JSON:
{
  "post": "the full post",
  "hashtags": ["tag1", "tag2"]
}`,
      },
      {
        role: "user",
        content: `Write a LinkedIn post about:\n\n${task.input.content}`,
      },
    ];

    const response = await this.llm.chat(messages);
    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    const result = jsonMatch ? JSON.parse(jsonMatch[0]) : { post: response.content, hashtags: [] };

    return createMessage(this.name, message.from, "result", {
      success: true,
      output: result,
    } satisfies ResultPayload, message.id);
  }

  private async writeInstagram(message: Message, task: TaskPayload, voiceContext: string): Promise<Message> {
    const messages: LLMMessage[] = [
      {
        role: "system",
        content: `You are an Instagram content expert. Write captions that drive engagement.
${voiceContext}

RULES:
- First line = hook (most important)
- Conversational, emoji-rich tone
- Include a CTA (save this, share with a friend, comment below)
- Max 2200 characters
- Up to 30 hashtags (separate from caption)
- Include line breaks for readability

Return ONLY valid JSON:
{
  "caption": "the caption",
  "hashtags": ["tag1", "tag2"]
}`,
      },
      {
        role: "user",
        content: `Write an Instagram caption about:\n\n${task.input.content}`,
      },
    ];

    const response = await this.llm.chat(messages);
    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    const result = jsonMatch ? JSON.parse(jsonMatch[0]) : { caption: response.content, hashtags: [] };

    return createMessage(this.name, message.from, "result", {
      success: true,
      output: result,
    } satisfies ResultPayload, message.id);
  }
}
