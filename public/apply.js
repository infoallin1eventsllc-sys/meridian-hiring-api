// Meridian Hire apply page: what a candidate sees when an employer shares a
// job's link. Plain JavaScript, no build step. It reads the job and sends the
// application through the public API (no key), then uploads the résumé and
// project file with the one-time upload token that comes back.
'use strict';

const $ = (id) => document.getElementById(id);
const jobId = new URLSearchParams(location.search).get('job') || '';
let job = null;

// All text goes through textContent: job details are typed in by employers.
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

class ApiError extends Error {
  constructor(status, body) {
    super(body?.detail || `Request failed (${status})`);
    this.status = status;
    this.body = body;
  }
}

async function call(path, { method = 'GET', body, form, token } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(path, { method, headers, body: form ?? (body === undefined ? undefined : JSON.stringify(body)) });
  } catch {
    throw new ApiError(0, { detail: 'The network request failed. Check your connection and try again.' });
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

// The same rules the server checks, so mistakes are explained before sending.
const GH_PROFILE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const GH_REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}(?:\/\S*)?$/;
/** '' when empty, null when it isn't a GitHub link of that kind, else the full link. */
function githubUrl(value, pattern) {
  const rest = value
    .trim()
    .replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, '')
    .replace(/\/+$/, '');
  if (!rest) return '';
  return pattern.test(rest) ? `https://github.com/${rest}` : null;
}
const webLink = (v) => /^https?:\/\/[^\s.]+\.[^\s]+$/i.test(v);
const EMPLOYMENT = {
  full_time: 'Full time',
  part_time: 'Part time',
  contract: 'Contract',
  internship: 'Internship',
  temporary: 'Temporary',
};
const mb = (bytes) => `${bytes / 1024 / 1024} MB`;

function showProblem(title, text) {
  $('loading').hidden = true;
  $('problem-title').textContent = title;
  $('problem-text').textContent = text;
  $('problem').hidden = false;
}

async function loadJob() {
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) {
    return showProblem(
      "This job link isn't complete",
      'Check the link you were sent, or ask the employer for it again.',
    );
  }
  try {
    job = await call(`/v1/public/jobs/${jobId}`);
  } catch (err) {
    if (err.status === 404)
      return showProblem("This job isn't available", 'The link may be wrong, or the job has been taken down.');
    return showProblem("Couldn't load this job", err.message);
  }
  const company = job.company.name.replace(/\s*\(sandbox\)$/i, '');
  document.title = `${job.title} at ${company} · Apply`;
  $('company-name').textContent = company;
  $('job-company').textContent = company;
  $('job-title').textContent = job.title;
  $('job-meta').textContent = [
    job.department,
    job.location,
    job.remote ? 'Remote' : null,
    EMPLOYMENT[job.employment_type],
  ]
    .filter(Boolean)
    .join(' · ');
  if (job.description) {
    $('job-desc').textContent = job.description;
    $('job-desc').hidden = false;
  }
  $('consent-text').textContent = `I agree to share my application with ${company}.`;
  $('demo-note').hidden = !job.company.sandbox;
  $('resume-hint').textContent = `PDF or Word, up to ${mb(limits().resume)}.`;
  $('project-hint').textContent =
    `A ZIP of the code, a PDF or a screenshot, up to ${mb(limits().project)}. Link bigger projects on GitHub.`;
  $('loading').hidden = true;
  $('job').hidden = false;
  if (job.accepting_applications) $('apply-form').hidden = false;
  else {
    $('problem-title').textContent = 'This job has closed';
    $('problem-text').textContent = "It's no longer taking applications.";
    $('problem').hidden = false;
  }
}

// Practice companies keep smaller files, like the rest of the demo.
const limits = () =>
  job.company.sandbox
    ? { resume: 1024 * 1024, project: 2 * 1024 * 1024 }
    : { resume: 4 * 1024 * 1024, project: 4 * 1024 * 1024 };

const FIELD_FOR = {
  'candidate.first_name': 'first_name',
  'candidate.last_name': 'last_name',
  'candidate.email': 'email',
  'candidate.phone': 'phone',
  'candidate.location': 'location',
  'candidate.linkedin_url': 'linkedin_url',
  'candidate.github_url': 'github_url',
  'project.title': 'project_title',
  'project.repo_url': 'project_repo',
  'project.live_url': 'project_live',
  consent: 'consent',
};

function showErrors(form, title, items) {
  for (const el of form.querySelectorAll('[aria-invalid]')) el.removeAttribute('aria-invalid');
  for (const [name] of items) form.elements[name]?.setAttribute('aria-invalid', 'true');
  const box = $('errors');
  box.replaceChildren(
    h('strong', {}, title),
    items.length
      ? h(
          'ul',
          {},
          items.map(([, text]) => h('li', {}, text)),
        )
      : null,
  );
  box.hidden = false;
  (items.length ? form.elements[items[0][0]] : box)?.focus?.();
}

/** Reads and checks the form. Returns { errors } or { application, resume, projectFile }. */
function read(form) {
  const v = (name) => form.elements[name].value.trim();
  const errors = [];
  if (!v('first_name')) errors.push(['first_name', 'Enter your first name.']);
  if (!v('last_name')) errors.push(['last_name', 'Enter your last name.']);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v('email')))
    errors.push(['email', 'Enter a valid email address, like name@example.com.']);
  if (v('phone') && !/^[+()\d\s.-]{7,40}$/.test(v('phone')))
    errors.push(['phone', 'Use digits, spaces and + ( ) - . in the phone number.']);
  const resume = form.elements.resume.files?.[0];
  if (!resume) errors.push(['resume', 'Attach your résumé (PDF or Word).']);
  else if (resume.size > limits().resume) errors.push(['resume', `Your résumé is over ${mb(limits().resume)}.`]);
  if (v('linkedin_url') && !webLink(v('linkedin_url')))
    errors.push(['linkedin_url', 'Use your full LinkedIn link, starting with https://.']);
  const github = githubUrl(v('github_url'), GH_PROFILE);
  if (github === null) errors.push(['github_url', 'Use your GitHub profile link, like github.com/username.']);

  const projectFile = form.elements.project_file.files?.[0];
  const repo = githubUrl(v('project_repo'), GH_REPO);
  const anyProject =
    v('project_title') || v('project_repo') || v('project_live') || v('project_description') || projectFile;
  if (anyProject) {
    if (!v('project_title')) errors.push(['project_title', 'Give your project a name.']);
    if (repo === null)
      errors.push(['project_repo', 'Use the GitHub link of the repository, like github.com/username/project.']);
    if (v('project_live') && !webLink(v('project_live')))
      errors.push(['project_live', 'Use a full web link for the live project, starting with https://.']);
    if (!repo && !v('project_live') && !projectFile)
      errors.push(['project_repo', 'Add a GitHub link, a live link or a file for your project.']);
    if (projectFile && projectFile.size > limits().project)
      errors.push([
        'project_file',
        `The project file is over ${mb(limits().project)}. Link the code on GitHub instead.`,
      ]);
  }
  if (!form.elements.consent.checked) errors.push(['consent', 'Tick the box to agree to share your application.']);
  if (errors.length) return { errors };

  const optional = (key, value) => (value ? { [key]: value } : {});
  return {
    application: {
      candidate: {
        first_name: v('first_name'),
        last_name: v('last_name'),
        email: v('email'),
        ...optional('phone', v('phone')),
        ...optional('location', v('location')),
        ...optional('linkedin_url', v('linkedin_url')),
        ...optional('github_url', github),
      },
      ...(anyProject
        ? {
            project: {
              title: v('project_title'),
              ...optional('repo_url', repo),
              ...optional('live_url', v('project_live')),
              ...optional('description', v('project_description')),
            },
          }
        : {}),
      ...optional('message', v('message')),
      consent: true,
    },
    resume,
    projectFile,
  };
}

async function upload(path, file, token) {
  const form = new FormData();
  form.append('file', file);
  return call(path, { method: 'POST', form, token });
}

async function submit(e) {
  e.preventDefault();
  const form = e.currentTarget;
  $('errors').hidden = true;
  const input = read(form);
  if (input.errors) return showErrors(form, 'Please fix these before sending:', input.errors);

  const button = $('submit');
  const status = $('status');
  button.disabled = true;
  button.textContent = 'Sending…';
  status.textContent = 'Sending your application…';
  let receipt;
  try {
    receipt = await call(`/v1/public/jobs/${jobId}/applications`, { method: 'POST', body: input.application });
  } catch (err) {
    button.disabled = false;
    button.textContent = 'Send application';
    status.textContent = '';
    const list = (err.body?.errors || []).map((x) => [FIELD_FOR[x.path] || '', x.message]);
    return showErrors(form, err.message, err.status === 422 ? list : []);
  }

  // The application is in. Files follow; if one fails, say so without undoing the rest.
  const sent = [`Your details, for ${receipt.job_title}`];
  const missed = [];
  if (input.application.candidate.github_url) sent.push('Your GitHub profile');
  status.textContent = 'Uploading your résumé…';
  try {
    await upload('/v1/public/uploads/resume', input.resume, receipt.upload_token);
    sent.push(`Your résumé (${input.resume.name})`);
  } catch (err) {
    missed.push(`Your résumé didn't upload: ${err.message}`);
  }
  if (input.application.project) {
    sent.push(`Your project, ${input.application.project.title}`);
    if (input.projectFile && receipt.project_id) {
      status.textContent = 'Uploading your project file…';
      try {
        await upload('/v1/public/uploads/project-file', input.projectFile, receipt.upload_token);
        sent.push(`The project file (${input.projectFile.name})`);
      } catch (err) {
        missed.push(`The project file didn't upload: ${err.message}`);
      }
    }
  }

  form.hidden = true;
  $('done-title').textContent = missed.length ? 'Application sent, with a problem' : 'Application sent';
  $('done-text').textContent =
    `${receipt.company_name.replace(/\s*\(sandbox\)$/i, '')} has your application for ${receipt.job_title}.` +
    (missed.length ? ' One part did not go through; you can email it to the employer.' : '');
  $('done-list').replaceChildren(
    ...sent.map((s) => h('li', { class: 'ok' }, s)),
    ...missed.map((s) => h('li', { class: 'bad' }, s)),
  );
  $('done-demo').hidden = !job.company.sandbox;
  $('done').hidden = false;
  $('done').focus();
  window.scrollTo({ top: 0 });
}

$('apply-form').addEventListener('submit', submit);
loadJob();
