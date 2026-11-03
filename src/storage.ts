// Résumé files live in a private Supabase Storage bucket. Nothing is public:
// downloads go through short-lived signed links.

export interface Storage {
  put(path: string, body: Uint8Array, contentType: string): Promise<void>;
  signedUrl(path: string, expiresInSeconds: number): Promise<string>;
  remove(paths: string[]): Promise<void>;
}

export class SupabaseStorage implements Storage {
  constructor(
    private readonly url: string,
    private readonly serviceKey: string,
    private readonly bucket: string,
  ) {}

  // New-style secret keys (sb_secret_…) go in the apikey header only; legacy
  // service_role keys are JWTs and also go in Authorization.
  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const auth: Record<string, string> = this.serviceKey.startsWith('sb_')
      ? { apikey: this.serviceKey }
      : { apikey: this.serviceKey, Authorization: `Bearer ${this.serviceKey}` };
    return { ...auth, ...extra };
  }

  private objectUrl(path: string) {
    return `${this.url}/storage/v1/object/${this.bucket}/${path.split('/').map(encodeURIComponent).join('/')}`;
  }

  async put(path: string, body: Uint8Array, contentType: string) {
    const res = await fetch(this.objectUrl(path), {
      method: 'POST',
      headers: this.headers({ 'Content-Type': contentType, 'x-upsert': 'false' }),
      body: body as unknown as BodyInit,
    });
    if (!res.ok) throw new Error(`Storage upload failed (${res.status}): ${await res.text()}`);
  }

  async signedUrl(path: string, expiresInSeconds: number) {
    const res = await fetch(
      `${this.url}/storage/v1/object/sign/${this.bucket}/${path.split('/').map(encodeURIComponent).join('/')}`,
      {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ expiresIn: expiresInSeconds }),
      },
    );
    if (!res.ok) throw new Error(`Storage signing failed (${res.status}): ${await res.text()}`);
    const { signedURL } = (await res.json()) as { signedURL: string };
    return `${this.url}/storage/v1${signedURL}`;
  }

  async remove(paths: string[]) {
    if (paths.length === 0) return;
    const res = await fetch(`${this.url}/storage/v1/object/${this.bucket}`, {
      method: 'DELETE',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ prefixes: paths }),
    });
    if (!res.ok) throw new Error(`Storage delete failed (${res.status}): ${await res.text()}`);
  }
}

/** In-memory storage for tests and local development without Supabase. */
export class MemoryStorage implements Storage {
  readonly files = new Map<string, { body: Uint8Array; contentType: string }>();

  constructor(private readonly baseUrl = 'http://localhost:8787') {}

  async put(path: string, body: Uint8Array, contentType: string) {
    if (this.files.has(path)) throw new Error('Object already exists');
    this.files.set(path, { body, contentType });
  }

  async signedUrl(path: string, expiresInSeconds: number) {
    if (!this.files.has(path)) throw new Error('Object not found');
    const expires = Math.floor(Date.now() / 1000) + expiresInSeconds;
    return `${this.baseUrl}/_local-storage/${encodeURIComponent(path)}?expires=${expires}`;
  }

  async remove(paths: string[]) {
    for (const p of paths) this.files.delete(p);
  }
}
