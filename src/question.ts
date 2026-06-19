import { z } from "zod";

export type Question = {
  id: string;
  question: string;
  defaultAnswer: string;
  options?: string[];
  askedAt: number;
  askedDuringTurn?: string;
  status: "open" | "pending-delivery" | "closed";
  userAnswer?: string;
  deviated?: boolean;
  closureReason?: "default-accepted" | "deviation-delivered" | "dismissed";
};

export const QuestionSchema: z.ZodType<Question> = z.object({
  id: z.string(),
  question: z.string(),
  defaultAnswer: z.string(),
  options: z.array(z.string()).optional(),
  askedAt: z.number(),
  askedDuringTurn: z.string().optional(),
  status: z.enum(["open", "pending-delivery", "closed"]),
  userAnswer: z.string().optional(),
  deviated: z.boolean().optional(),
  closureReason: z
    .enum(["default-accepted", "deviation-delivered", "dismissed"])
    .optional(),
});

export const QuestionArraySchema = z.array(QuestionSchema);

export function newQuestion(input: {
  question: string;
  defaultAnswer: string;
  options?: string[];
  askedDuringTurn?: string;
}): Question {
  return {
    id: crypto.randomUUID(),
    question: input.question,
    defaultAnswer: input.defaultAnswer,
    options: input.options,
    askedAt: Date.now(),
    askedDuringTurn: input.askedDuringTurn,
    status: "open",
  };
}
