export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: any
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export interface Organization {
  id: string;
  name: string;
  website?: string;
  plan_id: string;
  subscription_status: string;
}

export interface User {
  id: string;
  organization_id: string;
  supabase_uid: string;
  email: string;
  first_name?: string;
  last_name?: string;
  role: string;
}
