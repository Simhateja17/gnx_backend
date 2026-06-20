import { AzureOpenAI } from 'openai';
import { env } from '../config/env';

export const openai = new AzureOpenAI({
  endpoint: env.AZURE_OPENAI_ENDPOINT,
  apiKey: env.AZURE_OPENAI_API_KEY,
  apiVersion: env.AZURE_OPENAI_API_VERSION,
  deployment: env.AZURE_OPENAI_CHAT_DEPLOYMENT,
});
