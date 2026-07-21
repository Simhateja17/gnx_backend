import { AzureOpenAI } from 'openai';
import { env } from '../config/env';

// Constructed lazily, not at module load: AzureOpenAI's constructor throws
// synchronously when apiKey is empty, which would crash every request in any
// environment missing this key, since this module gets imported widely
// (campaigns, replies, voice prompts) regardless of whether AI is invoked yet.
let client: AzureOpenAI | null = null;

function getClient(): AzureOpenAI {
  if (!client) {
    client = new AzureOpenAI({
      endpoint: env.AZURE_OPENAI_ENDPOINT,
      apiKey: env.AZURE_OPENAI_API_KEY,
      apiVersion: env.AZURE_OPENAI_API_VERSION,
      deployment: env.AZURE_OPENAI_CHAT_DEPLOYMENT,
    });
  }
  return client;
}

export const openai = new Proxy({} as AzureOpenAI, {
  get(_target, prop) {
    return (getClient() as unknown as Record<string | symbol, unknown>)[prop];
  },
});
