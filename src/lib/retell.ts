import Retell from 'retell-sdk';
import { env } from '../config/env';

export const retell = new Retell({ apiKey: env.RETELL_API_KEY });
