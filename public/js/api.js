export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message || code || 'Request failed');
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function api(method, path, body) {
  const init = { method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch('/api' + path, init);
  } catch {
    throw new ApiError(0, 'NETWORK', 'Network error. Check your connection and try again.');
  }
  if (res.status === 204) return null;
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const e = (data && data.error) || {};
    throw new ApiError(res.status, e.code || 'ERROR', e.message || `Request failed (${res.status})`, e.details);
  }
  return data;
}

export const get = (path) => api('GET', path);
export const post = (path, body) => api('POST', path, body === undefined ? {} : body);
export const put = (path, body) => api('PUT', path, body);
