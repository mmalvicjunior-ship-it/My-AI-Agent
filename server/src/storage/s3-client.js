// Minimal S3-compatible client using only Node built-ins (no AWS SDK).
// Neon Object Storage exposes an S3 endpoint and works with path-style keys.
// Only the small operation set needed by the workspace file driver is included.
// Keys passed to this module are project-relative; the configured prefix is
// applied once, here, for both the real S3 client and the in-memory stand-in.

import crypto from 'node:crypto';

function hmac(key, value) {
  return crypto.createHmac('sha256', key).update(value).digest();
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function amzDate(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

/** AWS SigV4 requires RFC 3986 encoding (encodeURIComponent leaves !'()* alone). */
function encodeRfc3986(value) {
  return encodeURIComponent(String(value))
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodeKey(key) {
  return String(key).split('/').map((segment) => encodeRfc3986(segment)).join('/');
}

/** Sorted, RFC 3986 canonical query string used both in the URL and signature. */
function canonicalQuery(query) {
  return Object.entries(query)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([name, value]) => [encodeRfc3986(name), encodeRfc3986(value)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
}

function normalizedPrefix(config) {
  return String(config?.workspaceS3Prefix || '').replace(/^\/+|\/+$/g, '');
}

/** AWS Signature V4 authorization header for a single request. */
function authorization({ method, url, headers, payloadHash, config, date }) {
  const scopeDate = amzDate(date).slice(0, 8);
  const scope = `${scopeDate}/${config.workspaceS3Region || 'auto'}/s3/aws4_request`;
  const host = url.host;
  const headerNames = Object.keys(headers).map((name) => name.toLowerCase()).sort();
  const canonicalHeaders = headerNames
    .map((name) => `${name}:${String(headers[name] ?? '').trim()}\n`)
    .join('');
  const signedHeaders = headerNames.join(';');
  const canonicalRequest = [
    method.toUpperCase(),
    url.pathname,
    url.search.replace(/^\?/, ''),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate(date),
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${config.workspaceS3SecretKey}`, scopeDate), config.workspaceS3Region || 'auto'), 's3'),
    'aws4_request',
  );
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${config.workspaceS3AccessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

export function createS3Client(config) {
  const endpoint = String(config.workspaceS3Endpoint || '').replace(/\/+$/, '');
  const bucket = String(config.workspaceS3Bucket || '');
  const prefix = normalizedPrefix(config);
  if (!endpoint || !bucket || !config.workspaceS3AccessKey || !config.workspaceS3SecretKey) {
    throw new Error('S3 workspace storage requires endpoint, bucket, access key and secret key.');
  }

  const fullKey = (key) => [prefix, String(key).replace(/^\/+/, '')].filter(Boolean).join('/');

  async function signedFetch(url, method, options = {}) {
    const { body = '', headers = {}, query = {}, expectStatus = [] } = options;
    url.search = canonicalQuery(query);
    const payloadHash = sha256Hex(body);
    const date = new Date();
    const signedHeaders = {
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate(date),
      ...headers,
    };
    const response = await fetch(url, {
      method,
      headers: {
        ...signedHeaders,
        Authorization: authorization({ method, url, headers: signedHeaders, payloadHash, config, date }),
      },
      body: method === 'GET' || method === 'HEAD' ? undefined : body,
    });
    const allowed = [200, 204, ...expectStatus];
    if (!allowed.includes(response.status)) {
      const error = new Error(`S3 ${method} failed with HTTP ${response.status}.`);
      error.status = response.status === 404 ? 404 : 500;
      error.code = response.status === 404 ? 'ENOENT' : 'S3_ERROR';
      throw error;
    }
    return response;
  }

  function objectUrl(key) {
    return new URL(`${endpoint}/${encodeURIComponent(bucket)}/${encodeKey(fullKey(key))}`);
  }

  function bucketUrl() {
    return new URL(`${endpoint}/${encodeURIComponent(bucket)}`);
  }

  async function request(method, key, options = {}) {
    return signedFetch(objectUrl(key), method, options);
  }

  return {
    async get(key) {
      const response = await request('GET', key);
      return response.text();
    },
    async put(key, content, { exclusive = false } = {}) {
      const headers = { 'content-type': 'text/plain; charset=utf-8' };
      if (exclusive) headers['if-none-match'] = '*';
      const response = await request('PUT', key, { body: content, headers, expectStatus: [412] });
      if (response.status === 412) {
        const error = new Error('Object already exists.');
        error.code = 'EEXIST';
        throw error;
      }
    },
    async head(key) {
      try {
        const response = await request('HEAD', key);
        return {
          exists: true,
          size: Number(response.headers.get('content-length') || 0),
        };
      } catch (error) {
        if (error.code === 'ENOENT') return { exists: false };
        throw error;
      }
    },
    async delete(key) {
      await request('DELETE', key);
    },
    async list(key, { recursive = false } = {}) {
      // S3 ListObjectsV2 uses a query prefix, not a path prefix. The base is
      // also needed to turn returned keys back into workspace-relative names.
      const base = fullKey(key).replace(/\/?$/, '/');
      const entries = [];
      const prefixes = [];
      const seenTokens = new Set();
      let continuationToken = '';
      do {
        const query = { 'list-type': '2', 'max-keys': '1000', prefix: base };
        if (!recursive) query.delimiter = '/';
        if (continuationToken) query['continuation-token'] = continuationToken;
        const response = await signedFetch(bucketUrl(), 'GET', { query });
        const page = parseListXml(await response.text(), base);
        entries.push(...page.entries);
        for (const prefixName of page.prefixes) {
          if (!prefixes.includes(prefixName)) prefixes.push(prefixName);
        }
        continuationToken = page.truncated ? page.nextContinuationToken : '';
        if (continuationToken && seenTokens.has(continuationToken)) {
          throw new Error('S3 listing repeated a continuation token.');
        }
        if (continuationToken) seenTokens.add(continuationToken);
        if (page.truncated && !continuationToken) {
          throw new Error('S3 listing was truncated without a continuation token.');
        }
      } while (continuationToken);
      return { entries, prefixes };
    },
    async copy(fromKey, toKey) {
      const source = `/${encodeURIComponent(bucket)}/${encodeKey(fullKey(fromKey))}`;
      await request('PUT', toKey, { headers: { 'x-amz-copy-source': source } });
    },
  };
}

function decodeXml(value) {
  return String(value ?? '')
    // Numeric entities first; named &amp; last so "&amp;lt;" stays "&lt;".
    .replace(/&#x([0-9a-f]+);/gi, (_all, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_all, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Parses the small subset of ListObjectsV2 XML the driver needs. */
function parseListXml(xml, base) {
  const entries = [];
  const prefixes = [];
  const commonPrefix = /<CommonPrefixes>\s*<Prefix>([\s\S]*?)<\/Prefix>\s*<\/CommonPrefixes>/g;
  let match;
  while ((match = commonPrefix.exec(xml))) {
    const value = decodeXml(match[1]);
    const name = value.slice(base.length).replace(/\/$/, '');
    if (name) prefixes.push(name);
  }
  const contents = /<Contents>([\s\S]*?)<\/Contents>/g;
  while ((match = contents.exec(xml))) {
    const block = match[1];
    const keyMatch = /<Key>([\s\S]*?)<\/Key>/.exec(block);
    const sizeMatch = /<Size>([\s\S]*?)<\/Size>/.exec(block);
    if (!keyMatch) continue;
    const key = decodeXml(keyMatch[1]);
    const name = key.slice(base.length);
    if (!name || name.endsWith('/')) continue;
    entries.push({ name, size: Number(sizeMatch?.[1] || 0) });
  }
  const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml);
  const tokenMatch = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml);
  return {
    entries,
    prefixes,
    truncated,
    nextContinuationToken: tokenMatch ? decodeXml(tokenMatch[1]) : '',
  };
}

/** In-memory S3 stand-in used by local tests. No network, no cloud resources. */
export function createMemoryObjectStore(config = {}) {
  const prefix = normalizedPrefix(config);
  const fullKey = (key) => [prefix, String(key).replace(/^\/+/, '')].filter(Boolean).join('/');
  const objects = new Map();
  let nextPutFailure = null;
  return {
    failNextPut(message = 'Injected object storage failure.') {
      nextPutFailure = message;
    },
    async get(key) {
      const objectKey = fullKey(key);
      if (!objects.has(objectKey)) {
        const error = new Error('Object not found.');
        error.code = 'ENOENT';
        throw error;
      }
      return objects.get(objectKey);
    },
    async put(key, content, { exclusive = false } = {}) {
      if (nextPutFailure) {
        const message = nextPutFailure;
        nextPutFailure = null;
        const error = new Error(message);
        error.code = 'STORAGE_FAILURE';
        error.status = 503;
        throw error;
      }
      const objectKey = fullKey(key);
      if (exclusive && objects.has(objectKey)) {
        const error = new Error('Object already exists.');
        error.code = 'EEXIST';
        throw error;
      }
      objects.set(objectKey, content);
    },
    async head(key) {
      const objectKey = fullKey(key);
      return objects.has(objectKey)
        ? { exists: true, size: Buffer.byteLength(objects.get(objectKey), 'utf8') }
        : { exists: false };
    },
    async delete(key) {
      // S3 DELETE is idempotent; a missing key is still a successful delete.
      const objectKey = fullKey(key);
      objects.delete(objectKey);
    },
    async list(key, { recursive = false } = {}) {
      const base = fullKey(key).replace(/\/?$/, '/');
      const entries = [];
      const prefixes = new Set();
      for (const [objectKey, content] of objects) {
        if (!objectKey.startsWith(base)) continue;
        const rest = objectKey.slice(base.length);
        if (!rest) continue;
        if (!recursive && rest.includes('/')) {
          prefixes.add(rest.split('/')[0]);
        } else {
          entries.push({ name: rest, size: Buffer.byteLength(content, 'utf8') });
        }
      }
      return { entries, prefixes: [...prefixes], truncated: false, nextContinuationToken: '' };
    },
    async copy(fromKey, toKey) {
      const sourceKey = fullKey(fromKey);
      const destinationKey = fullKey(toKey);
      if (!objects.has(sourceKey)) {
        const error = new Error('Object not found.');
        error.code = 'ENOENT';
        throw error;
      }
      objects.set(destinationKey, objects.get(sourceKey));
    },
  };
}
