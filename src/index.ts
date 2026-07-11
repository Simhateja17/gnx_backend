import 'dotenv/config';
import { app } from './app';
import { env } from './config/env';

const PORT = env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Globonexo API running on port ${PORT}`);
});
