import { z } from "zod";
import { defineTool } from "./definition.js";

export type AskUserInput = {
  question: string;
  reason?: string;
  choices?: string[];
};

export async function askUser(input: AskUserInput) {
  const choices = input.choices?.map((choice) => choice.trim()).filter(Boolean) ?? [];

  return {
    ok: true,
    needsUserInput: true,
    question: input.question.trim(),
    reason: input.reason?.trim() || null,
    choices
  };
}

export const askUserTool = defineTool<AskUserInput>({
  name: "ask_user",
  title: "Ask User",
  description:
    "Ask the human user for missing information required to proceed. Use only when a safe default or cached device/tool data is not enough.",
  inputSchema: {
    question: z.string().min(1).describe("One clear question to ask the user."),
    reason: z.string().optional().describe("Brief reason this information is needed."),
    choices: z
      .array(z.string().min(1))
      .max(8)
      .optional()
      .describe("Optional short answer choices to show the user.")
  },
  handler: askUser
});
