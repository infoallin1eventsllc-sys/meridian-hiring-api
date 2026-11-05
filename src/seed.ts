import { randomUUID } from 'node:crypto';
import { sha256Hex } from './crypto.js';
import type { Sql } from './db.js';
import type { StageName } from './schemas.js';
import type { Storage } from './storage.js';

// Sample data for sandboxes. Every person here is made up and every email
// uses example.com, which is reserved for documentation.

const JOBS = [
  { key: 'design', title: 'Senior Product Designer', department: 'Design', location: 'Houston, TX', remote: false },
  {
    key: 'backend',
    title: 'Backend Engineer (TypeScript)',
    department: 'Engineering',
    location: 'United States',
    remote: true,
  },
  { key: 'coord', title: 'Recruiting Coordinator', department: 'People', location: 'Houston, TX', remote: false },
  { key: 'ae', title: 'Account Executive', department: 'Sales', location: 'Dallas, TX', remote: false },
] as const;

const CLOSED_JOB = { title: 'Data Analyst Intern (Summer)', department: 'Operations', location: 'Austin, TX' };

const PEOPLE: [first: string, last: string, location: string, source: string][] = [
  ['Jordan', 'Avery', 'Austin, TX', 'referral'],
  ['Priya', 'Raman', 'Houston, TX', 'linkedin'],
  ['Marcus', 'Bell', 'Sugar Land, TX', 'careers_page'],
  ['Elena', 'Ortiz', 'San Antonio, TX', 'linkedin'],
  ['Sam', 'Whitfield', 'Remote', 'careers_page'],
  ['Aisha', 'Coleman', 'Houston, TX', 'referral'],
  ['Diego', 'Marín', 'Dallas, TX', 'job_board'],
  ['Hannah', 'Kim', 'Seattle, WA', 'linkedin'],
  ['Theo', 'Nakamura', 'Denver, CO', 'careers_page'],
  ['Grace', 'Adeyemi', 'Atlanta, GA', 'referral'],
  ['Luis', 'Fernández', 'Houston, TX', 'job_board'],
  ['Maya', 'Goldberg', 'Chicago, IL', 'linkedin'],
  ['Omar', 'Haddad', 'Katy, TX', 'careers_page'],
  ['Chloe', 'Dubois', 'Remote', 'agency'],
  ['Isaiah', 'Brooks', 'The Woodlands, TX', 'referral'],
  ['Nina', 'Petrova', 'Austin, TX', 'linkedin'],
  ['Kofi', 'Mensah', 'Houston, TX', 'job_board'],
  ['Rosa', 'Delgado', 'El Paso, TX', 'careers_page'],
  ['Ben', 'Carter', 'Fort Worth, TX', 'agency'],
  ['Leah', 'Sullivan', 'Remote', 'linkedin'],
];

// [person index, job key, path through the pipeline]
const APPLICATIONS: [number, (typeof JOBS)[number]['key'], StageName[]][] = [
  [0, 'design', ['applied', 'screen', 'interview', 'offer']],
  [1, 'design', ['applied', 'screen', 'interview']],
  [2, 'design', ['applied']],
  [3, 'design', ['applied', 'screen', 'rejected']],
  [4, 'design', ['applied', 'screen']],
  [5, 'backend', ['applied', 'screen', 'interview', 'offer', 'hired']],
  [6, 'backend', ['applied', 'screen', 'interview']],
  [7, 'backend', ['applied', 'screen', 'interview']],
  [8, 'backend', ['applied']],
  [9, 'backend', ['applied', 'rejected']],
  [10, 'backend', ['applied', 'screen']],
  [11, 'coord', ['applied', 'screen', 'interview', 'offer']],
  [12, 'coord', ['applied']],
  [13, 'coord', ['applied', 'screen']],
  [14, 'ae', ['applied', 'screen', 'interview']],
  [15, 'ae', ['applied']],
  [16, 'ae', ['applied', 'screen', 'rejected']],
  [17, 'ae', ['applied']],
  [18, 'ae', ['applied', 'screen']],
  [19, 'design', ['applied']],
  [0, 'backend', ['applied', 'rejected']],
];

const NOTES: Partial<Record<StageName, string>> = {
  screen: 'Phone screen booked.',
  interview: 'Moving to panel interview.',
  offer: 'Offer drafted, sent for approval.',
  hired: 'Offer accepted. Start date confirmed.',
  rejected: 'Not the right fit for this role right now.',
};

/** A tiny but valid one-page PDF, so sandboxes have real files to download. */
export function samplePdf(lines: string[]): Uint8Array {
  const esc = (s: string) => s.replace(/[^\x20-\x7e]/g, '?').replace(/[\\()]/g, (ch) => `\\${ch}`);
  const text = lines.map((l, i) => `BT /F1 ${i === 0 ? 20 : 12} Tf 72 ${720 - i * 26} Td (${esc(l)}) Tj ET`).join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}

/**
 * Fills a company with jobs, candidates and applications spread over the last
 * three weeks. Runs as the schema owner so it can backdate history.
 */
export async function seedCompany(sql: Sql, storage: Storage, companyId: string) {
  const day = 24 * 3600 * 1000;
  const now = Date.now();
  const uploads: { path: string; body: Uint8Array }[] = [];

  await sql.begin(async (tx) => {
    await tx`select set_config('app.actor', 'system:seed', true)`;
    const jobIds: Record<string, string> = {};
    for (const [i, job] of JOBS.entries()) {
      const [row] = await tx`
        insert into hire.jobs (company_id, title, department, location, remote, description, created_at, updated_at)
        values (${companyId}, ${job.title}, ${job.department}, ${job.location}, ${job.remote},
                ${`We're hiring a ${job.title} to join our ${job.department} team.`},
                ${new Date(now - (30 - i) * day)}, ${new Date(now - (30 - i) * day)})
        returning id`;
      jobIds[job.key] = row!.id;
    }
    await tx`
      insert into hire.jobs (company_id, title, department, location, status, created_at, updated_at)
      values (${companyId}, ${CLOSED_JOB.title}, ${CLOSED_JOB.department}, ${CLOSED_JOB.location}, 'closed',
              ${new Date(now - 60 * day)}, ${new Date(now - 40 * day)})`;

    const candidateIds: string[] = [];
    for (const [i, [first, last, location, source]] of PEOPLE.entries()) {
      const email =
        `${first}.${last}`
          .normalize('NFD')
          .replace(/[^\w.]/g, '')
          .toLowerCase() + '@example.com';
      const created = new Date(now - (21 - i) * day);
      const [row] = await tx`
        insert into hire.candidates (company_id, first_name, last_name, email, phone, location, source, created_at, updated_at)
        values (${companyId}, ${first}, ${last}, ${email}, ${`+1 713 555 01${String(i).padStart(2, '0')}`},
                ${location}, ${source}, ${created}, ${created})
        returning id`;
      candidateIds.push(row!.id);
      if (i < 6) {
        const path = `${companyId}/${row!.id}/${randomUUID()}.pdf`;
        const body = samplePdf([
          `${first} ${last}`,
          `${location}  |  ${email}`,
          '',
          'Sample resume for the Meridian Hire sandbox.',
          'All details are fictional.',
        ]);
        uploads.push({ path, body });
        await tx`
          insert into hire.resumes (company_id, candidate_id, storage_path, file_name, content_type, size_bytes, sha256, created_at)
          values (${companyId}, ${row!.id}, ${path}, ${`${first}-${last}-resume.pdf`}, 'application/pdf',
                  ${body.byteLength}, ${sha256Hex(body)}, ${created})`;
      }
    }

    for (const [n, [person, jobKey, path]] of APPLICATIONS.entries()) {
      const start = now - (20 - (n % 14)) * day;
      await tx`select set_config('app.stage_note', '', true)`;
      const [app] = await tx`
        insert into hire.applications (company_id, job_id, candidate_id, created_at, updated_at, stage_changed_at)
        values (${companyId}, ${jobIds[jobKey]!}, ${candidateIds[person]!}, ${new Date(start)}, ${new Date(start)}, ${new Date(start)})
        returning id`;
      for (const stage of path.slice(1)) {
        await tx`select set_config('app.stage_note', ${NOTES[stage] ?? ''}, true)`;
        await tx`
          update hire.applications
          set stage = ${stage}, rejection_reason = ${stage === 'rejected' ? 'Went with a candidate with more industry experience.' : null}
          where id = ${app!.id}`;
      }
      // Spread the history out so the timeline reads like real weeks of work.
      await tx`
        with h as (
          select id, row_number() over (order by id) - 1 as step from hire.stage_history where application_id = ${app!.id}
        )
        update hire.stage_history s set changed_at = ${new Date(start)}::timestamptz + h.step * interval '2 days 3 hours'
        from h where s.id = h.id`;
      await tx`
        update hire.applications a set stage_changed_at = (select max(changed_at) from hire.stage_history where application_id = a.id),
          updated_at = (select max(changed_at) from hire.stage_history where application_id = a.id)
        where a.id = ${app!.id}`;
    }
    // A sample person should exist before their first application.
    await tx`
      update hire.candidates c
      set created_at = least(c.created_at, a.first_applied - interval '1 day'),
          updated_at = least(c.updated_at, a.first_applied - interval '1 day')
      from (select candidate_id, min(created_at) as first_applied from hire.applications
            where company_id = ${companyId} group by candidate_id) a
      where c.id = a.candidate_id`;
    await tx`
      update hire.resumes r set created_at = c.created_at
      from hire.candidates c where c.id = r.candidate_id and r.company_id = ${companyId}`;
    // Seeding is not news: drop any webhook events it produced.
    await tx`delete from hire.webhook_deliveries where company_id = ${companyId}`;
  });

  await Promise.all(uploads.map((u) => storage.put(u.path, u.body, 'application/pdf')));
}
