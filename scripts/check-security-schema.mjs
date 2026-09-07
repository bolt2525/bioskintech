import { neon } from '@neondatabase/serverless';

const url = process.env.NEON_DATABASE_URL || process.env.POSTGRES_URL;
if (!url) { console.error('No DB URL found'); process.exit(1); }

const parsed = new URL(url);
const sql = neon(url);
const tables = await sql`
  SELECT c.table_name, c.column_name, c.data_type, c.udt_name,
         cls.relrowsecurity AS rls_enabled,
         cls.relforcerowsecurity AS rls_forced
  FROM information_schema.columns c
  JOIN pg_class cls ON cls.relname = c.table_name
  WHERE c.table_schema = 'public'
    AND c.table_name IN ('external_finance_records','clinical_photos','patients','financial_records')
  ORDER BY c.table_name, c.ordinal_position
`;
const policies = await sql`
  SELECT tablename, policyname, cmd, roles, qual, with_check
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN ('external_finance_records','clinical_photos','patients')
  ORDER BY tablename, policyname
`;

console.log(`Connected host: ${parsed.hostname}`);
console.table(tables);
console.table(policies);
