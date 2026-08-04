import { z } from 'zod';

export const agentChatSchema = z.object({
  message: z.string().trim().min(1).max(2000),
});

export type AgentChatInput = z.infer<typeof agentChatSchema>;
