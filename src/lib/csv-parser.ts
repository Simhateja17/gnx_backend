type Row = Record<string, string>;

const FIELD_MAP: Record<string, string> = {
  'first_name': 'firstName', 'firstname': 'firstName', 'first name': 'firstName', 'first': 'firstName',
  'last_name': 'lastName', 'lastname': 'lastName', 'last name': 'lastName', 'last': 'lastName',
  'name': 'name', 'full_name': 'name', 'fullname': 'name', 'full name': 'name', 'contact name': 'name',
  'email': 'email', 'e-mail': 'email', 'email_address': 'email', 'email address': 'email', 'work email': 'email',
  'company': 'company', 'organization': 'company', 'company_name': 'company', 'company name': 'company', 'org': 'company',
  'title': 'title', 'job_title': 'title', 'job title': 'title', 'position': 'title', 'role': 'title',
  'phone': 'phone', 'phone_number': 'phone', 'phone number': 'phone', 'mobile': 'phone', 'telephone': 'phone',
  'location': 'location', 'city': 'location', 'address': 'location', 'region': 'location',
  'linkedin': 'linkedinUrl', 'linkedin_url': 'linkedinUrl', 'linkedin url': 'linkedinUrl', 'linkedin profile': 'linkedinUrl',
};

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
  }
  fields.push(current.trim());
  return fields;
}

export function parseCsv(content: string): { headers: string[]; rows: Row[] } {
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim());
  if (lines.length === 0) return { headers: [], rows: [] };

  const headers = parseCsvLine(lines[0]);
  const rows: Row[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    if (values.every(v => !v)) continue;
    const row: Row = {};
    headers.forEach((h, idx) => {
      if (idx < values.length) row[h] = values[idx];
    });
    rows.push(row);
  }

  return { headers, rows };
}

export function mapHeaders(headers: string[]): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const header of headers) {
    const normalized = header.toLowerCase().trim();
    if (FIELD_MAP[normalized]) {
      mapping[header] = FIELD_MAP[normalized];
    }
  }
  return mapping;
}

export function mapRow(row: Row, columnMapping: Record<string, string>): Record<string, string> {
  const mapped: Record<string, string> = {};
  for (const [csvCol, leadField] of Object.entries(columnMapping)) {
    if (row[csvCol] !== undefined && row[csvCol] !== '') {
      mapped[leadField] = row[csvCol];
    }
  }
  return mapped;
}

export type CsvParseResult = ReturnType<typeof parseCsv>;
