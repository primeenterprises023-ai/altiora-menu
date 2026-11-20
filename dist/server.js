// @bun
// server/src/app.ts
import { randomUUID as randomUUID2 } from "crypto";

// server/src/lib/crypto.ts
import { createHash, randomBytes, timingSafeEqual } from "crypto";
function randomToken(bytes = 16) {
  return randomBytes(bytes).toString("base64url");
}
function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}
function temporaryPassword() {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const limit = 256 - 256 % alphabet.length;
  let out = "";
  while (out.length < 14) {
    for (const b of randomBytes(32)) {
      if (b < limit && out.length < 14)
        out += alphabet[b % alphabet.length];
    }
  }
  return `${out.slice(0, 4)}-${out.slice(4, 9)}-${out.slice(9)}`;
}

// server/src/auth/sessions.ts
var SESSION_COOKIE_PLAIN = "altiora_sid";
var SESSION_COOKIE_SECURE = "__Host-altiora_sid";
var TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
var cookieName = (cfg) => cfg.cookieSecure ? SESSION_COOKIE_SECURE : SESSION_COOKIE_PLAIN;
async function createSession(db, cfg, p) {
  const token = randomToken(32);
  const idleSec = cfg.sessionIdleHours * 3600;
  const maxSec = cfg.sessionMaxDays * 86400;
  await db.system(async (tx) => {
    await tx`
      INSERT INTO sessions (user_id, restaurant_id, token_hash, expires_at, absolute_expires_at, ip, user_agent)
      VALUES (${p.userId}, ${p.restaurantId}, ${sha256Hex(token)},
              now() + make_interval(secs => ${idleSec}),
              now() + make_interval(secs => ${maxSec}),
              ${p.ip}, ${(p.userAgent ?? "").slice(0, 300) || null})`;
  });
  return { token, maxAgeSec: maxSec };
}
async function loadAuth(db, cfg, token) {
  if (!TOKEN_RE.test(token))
    return null;
  const idleSec = cfg.sessionIdleHours * 3600;
  return db.system(async (tx) => {
    const [s] = await tx`
      SELECT s.id, s.user_id, s.restaurant_id, (now() - s.last_seen_at) > interval '60 seconds' AS stale,
             u.email, u.name, u.is_platform_admin, u.active AS user_active, u.must_change_password,
             m.role AS member_role, m.active AS member_active,
             r.name AS restaurant_name, r.slug AS restaurant_slug, r.status AS restaurant_status
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      LEFT JOIN restaurant_members m ON m.user_id = s.user_id AND m.restaurant_id = s.restaurant_id
      LEFT JOIN restaurants r ON r.id = s.restaurant_id
      WHERE s.token_hash = ${sha256Hex(token)} AND s.revoked_at IS NULL
        AND s.expires_at > now() AND s.absolute_expires_at > now()`;
    if (!s || !s.user_active)
      return null;
    let role;
    if (s.is_platform_admin)
      role = "platform";
    else {
      if (!s.member_role || !s.member_active || !s.restaurant_id)
        return null;
      role = s.member_role;
    }
    if (s.stale) {
      await tx`
        UPDATE sessions SET last_seen_at = now(),
               expires_at = LEAST(now() + make_interval(secs => ${idleSec}), absolute_expires_at)
        WHERE id = ${s.id}`;
    }
    return {
      sessionId: s.id,
      userId: s.user_id,
      email: s.email,
      name: s.name,
      role,
      mustChangePassword: s.must_change_password,
      restaurantId: s.is_platform_admin ? null : s.restaurant_id,
      restaurantName: s.is_platform_admin ? null : s.restaurant_name,
      restaurantSlug: s.is_platform_admin ? null : s.restaurant_slug,
      restaurantStatus: s.is_platform_admin ? null : s.restaurant_status
    };
  });
}
async function revokeSession(db, sessionId) {
  await db.system(async (tx) => {
    await tx`UPDATE sessions SET revoked_at = now() WHERE id = ${sessionId} AND revoked_at IS NULL`;
  });
}
async function revokeOtherSessions(db, userId, keepSessionId) {
  await db.system(async (tx) => {
    await tx`UPDATE sessions SET revoked_at = now() WHERE user_id = ${userId} AND id <> ${keepSessionId} AND revoked_at IS NULL`;
  });
}
async function revokeSessionsOfUser(db, userId) {
  await db.system(async (tx) => {
    await tx`UPDATE sessions SET revoked_at = now() WHERE user_id = ${userId} AND revoked_at IS NULL`;
  });
}
async function purgeExpiredSessions(db) {
  return db.system(async (tx) => {
    const rows = await tx`
      DELETE FROM sessions
      WHERE absolute_expires_at < now() - interval '1 day' OR expires_at < now() - interval '1 day' OR revoked_at < now() - interval '1 day'
      RETURNING id`;
    return rows.length;
  });
}

// server/src/lib/errors.ts
class HttpError extends Error {
  status;
  code;
  details;
  headers;
  constructor(status, code, message, details, headers) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.headers = headers;
    this.name = "HttpError";
  }
}
var badRequest = (message, details, code = "BAD_REQUEST") => new HttpError(400, code, message, details);
var unauthorized = (message = "\xC9 necess\xE1rio iniciar sess\xE3o.", code = "UNAUTHENTICATED") => new HttpError(401, code, message);
var forbidden = (message = "N\xE3o tem permiss\xE3o para esta opera\xE7\xE3o.", code = "FORBIDDEN") => new HttpError(403, code, message);
var notFound = (message = "N\xE3o encontrado.", code = "NOT_FOUND") => new HttpError(404, code, message);
var conflict = (message, code = "CONFLICT", details) => new HttpError(409, code, message, details);
var unprocessable = (message, code = "UNPROCESSABLE", details) => new HttpError(422, code, message, details);
var tooMany = (message, retryAfterSec, code = "RATE_LIMITED") => new HttpError(429, code, message, undefined, { "retry-after": String(Math.max(1, Math.ceil(retryAfterSec))) });

// server/src/http/body.ts
var MAX_JSON_BYTES = 64 * 1024;
function concat(chunks, total) {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
async function readBytesBody(req, maxBytes) {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes)
    throw new HttpError(413, "PAYLOAD_TOO_LARGE", "O ficheiro \xE9 demasiado grande.");
  if (!req.body)
    throw new HttpError(400, "EMPTY_BODY", "N\xE3o foi enviado nenhum ficheiro.");
  const reader = req.body.getReader();
  const chunks = [];
  let total = 0;
  for (;; ) {
    const { done, value } = await reader.read();
    if (done)
      break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {
        return;
      });
      throw new HttpError(413, "PAYLOAD_TOO_LARGE", "O ficheiro \xE9 demasiado grande.");
    }
    chunks.push(value);
  }
  if (total === 0)
    throw new HttpError(400, "EMPTY_BODY", "N\xE3o foi enviado nenhum ficheiro.");
  return concat(chunks, total);
}
async function readJsonBody(req, maxBytes = MAX_JSON_BYTES) {
  const contentType = (req.headers.get("content-type") ?? "").trim();
  if (!/^application\/json\s*(;.*)?$/i.test(contentType)) {
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "O pedido deve ser enviado em JSON (Content-Type: application/json).");
  }
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    throw new HttpError(413, "PAYLOAD_TOO_LARGE", "O pedido \xE9 demasiado grande.");
  }
  if (!req.body)
    throw new HttpError(400, "INVALID_JSON", "O corpo do pedido est\xE1 vazio.");
  const reader = req.body.getReader();
  const chunks = [];
  let total = 0;
  for (;; ) {
    const { done, value } = await reader.read();
    if (done)
      break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {
        return;
      });
      throw new HttpError(413, "PAYLOAD_TOO_LARGE", "O pedido \xE9 demasiado grande.");
    }
    chunks.push(value);
  }
  if (total === 0)
    throw new HttpError(400, "INVALID_JSON", "O corpo do pedido est\xE1 vazio.");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(concat(chunks, total));
  } catch {
    throw new HttpError(400, "INVALID_JSON", "O corpo do pedido n\xE3o \xE9 texto UTF-8 v\xE1lido.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "INVALID_JSON", "O corpo do pedido n\xE3o \xE9 JSON v\xE1lido.");
  }
}

// server/src/http/client-ip.ts
var IP_CHARS = /^[0-9a-fA-F:.]{2,45}$/;
function clientIp(req, socketIp, hops) {
  const fallback = socketIp && IP_CHARS.test(socketIp) ? socketIp : "unknown";
  if (hops <= 0)
    return fallback;
  const header = req.headers.get("x-forwarded-for");
  if (!header)
    return fallback;
  const parts = header.split(",").map((s) => s.trim()).filter(Boolean);
  const candidate = parts[parts.length - hops] ?? parts[0];
  return candidate && IP_CHARS.test(candidate) ? candidate : fallback;
}

// server/src/http/cookies.ts
function parseCookies(header) {
  const out = {};
  if (!header)
    return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 1)
      continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (!(name in out))
      out[name] = value;
  }
  return out;
}
function serializeCookie(name, value, opts) {
  const parts = [`${name}=${value}`, "Path=/"];
  if (opts.maxAgeSec !== undefined)
    parts.push(`Max-Age=${Math.max(0, Math.floor(opts.maxAgeSec))}`);
  if (opts.httpOnly !== false)
    parts.push("HttpOnly");
  if (opts.secure)
    parts.push("Secure");
  parts.push(`SameSite=${opts.sameSite ?? "Lax"}`);
  return parts.join("; ");
}

// ../../../opt/npm-tools/node_modules/zod/v3/helpers/util.js
var util;
(function(util) {
  util.assertEqual = (_) => {};
  function assertIs(_arg) {}
  util.assertIs = assertIs;
  function assertNever(_x) {
    throw new Error;
  }
  util.assertNever = assertNever;
  util.arrayToEnum = (items) => {
    const obj = {};
    for (const item of items) {
      obj[item] = item;
    }
    return obj;
  };
  util.getValidEnumValues = (obj) => {
    const validKeys = util.objectKeys(obj).filter((k) => typeof obj[obj[k]] !== "number");
    const filtered = {};
    for (const k of validKeys) {
      filtered[k] = obj[k];
    }
    return util.objectValues(filtered);
  };
  util.objectValues = (obj) => {
    return util.objectKeys(obj).map(function(e) {
      return obj[e];
    });
  };
  util.objectKeys = typeof Object.keys === "function" ? (obj) => Object.keys(obj) : (object) => {
    const keys = [];
    for (const key in object) {
      if (Object.prototype.hasOwnProperty.call(object, key)) {
        keys.push(key);
      }
    }
    return keys;
  };
  util.find = (arr, checker) => {
    for (const item of arr) {
      if (checker(item))
        return item;
    }
    return;
  };
  util.isInteger = typeof Number.isInteger === "function" ? (val) => Number.isInteger(val) : (val) => typeof val === "number" && Number.isFinite(val) && Math.floor(val) === val;
  function joinValues(array, separator = " | ") {
    return array.map((val) => typeof val === "string" ? `'${val}'` : val).join(separator);
  }
  util.joinValues = joinValues;
  util.jsonStringifyReplacer = (_, value) => {
    if (typeof value === "bigint") {
      return value.toString();
    }
    return value;
  };
})(util || (util = {}));
var objectUtil;
(function(objectUtil) {
  objectUtil.mergeShapes = (first, second) => {
    return {
      ...first,
      ...second
    };
  };
})(objectUtil || (objectUtil = {}));
var ZodParsedType = util.arrayToEnum([
  "string",
  "nan",
  "number",
  "integer",
  "float",
  "boolean",
  "date",
  "bigint",
  "symbol",
  "function",
  "undefined",
  "null",
  "array",
  "object",
  "unknown",
  "promise",
  "void",
  "never",
  "map",
  "set"
]);
var getParsedType = (data) => {
  const t = typeof data;
  switch (t) {
    case "undefined":
      return ZodParsedType.undefined;
    case "string":
      return ZodParsedType.string;
    case "number":
      return Number.isNaN(data) ? ZodParsedType.nan : ZodParsedType.number;
    case "boolean":
      return ZodParsedType.boolean;
    case "function":
      return ZodParsedType.function;
    case "bigint":
      return ZodParsedType.bigint;
    case "symbol":
      return ZodParsedType.symbol;
    case "object":
      if (Array.isArray(data)) {
        return ZodParsedType.array;
      }
      if (data === null) {
        return ZodParsedType.null;
      }
      if (data.then && typeof data.then === "function" && data.catch && typeof data.catch === "function") {
        return ZodParsedType.promise;
      }
      if (typeof Map !== "undefined" && data instanceof Map) {
        return ZodParsedType.map;
      }
      if (typeof Set !== "undefined" && data instanceof Set) {
        return ZodParsedType.set;
      }
      if (typeof Date !== "undefined" && data instanceof Date) {
        return ZodParsedType.date;
      }
      return ZodParsedType.object;
    default:
      return ZodParsedType.unknown;
  }
};

// ../../../opt/npm-tools/node_modules/zod/v3/ZodError.js
var ZodIssueCode = util.arrayToEnum([
  "invalid_type",
  "invalid_literal",
  "custom",
  "invalid_union",
  "invalid_union_discriminator",
  "invalid_enum_value",
  "unrecognized_keys",
  "invalid_arguments",
  "invalid_return_type",
  "invalid_date",
  "invalid_string",
  "too_small",
  "too_big",
  "invalid_intersection_types",
  "not_multiple_of",
  "not_finite"
]);
class ZodError extends Error {
  get errors() {
    return this.issues;
  }
  constructor(issues) {
    super();
    this.issues = [];
    this.addIssue = (sub) => {
      this.issues = [...this.issues, sub];
    };
    this.addIssues = (subs = []) => {
      this.issues = [...this.issues, ...subs];
    };
    const actualProto = new.target.prototype;
    if (Object.setPrototypeOf) {
      Object.setPrototypeOf(this, actualProto);
    } else {
      this.__proto__ = actualProto;
    }
    this.name = "ZodError";
    this.issues = issues;
  }
  format(_mapper) {
    const mapper = _mapper || function(issue) {
      return issue.message;
    };
    const fieldErrors = { _errors: [] };
    const processError = (error) => {
      for (const issue of error.issues) {
        if (issue.code === "invalid_union") {
          issue.unionErrors.map(processError);
        } else if (issue.code === "invalid_return_type") {
          processError(issue.returnTypeError);
        } else if (issue.code === "invalid_arguments") {
          processError(issue.argumentsError);
        } else if (issue.path.length === 0) {
          fieldErrors._errors.push(mapper(issue));
        } else {
          let curr = fieldErrors;
          let i = 0;
          while (i < issue.path.length) {
            const el = issue.path[i];
            const terminal = i === issue.path.length - 1;
            if (!terminal) {
              curr[el] = curr[el] || { _errors: [] };
            } else {
              curr[el] = curr[el] || { _errors: [] };
              curr[el]._errors.push(mapper(issue));
            }
            curr = curr[el];
            i++;
          }
        }
      }
    };
    processError(this);
    return fieldErrors;
  }
  static assert(value) {
    if (!(value instanceof ZodError)) {
      throw new Error(`Not a ZodError: ${value}`);
    }
  }
  toString() {
    return this.message;
  }
  get message() {
    return JSON.stringify(this.issues, util.jsonStringifyReplacer, 2);
  }
  get isEmpty() {
    return this.issues.length === 0;
  }
  flatten(mapper = (issue) => issue.message) {
    const fieldErrors = {};
    const formErrors = [];
    for (const sub of this.issues) {
      if (sub.path.length > 0) {
        const firstEl = sub.path[0];
        fieldErrors[firstEl] = fieldErrors[firstEl] || [];
        fieldErrors[firstEl].push(mapper(sub));
      } else {
        formErrors.push(mapper(sub));
      }
    }
    return { formErrors, fieldErrors };
  }
  get formErrors() {
    return this.flatten();
  }
}
ZodError.create = (issues) => {
  const error = new ZodError(issues);
  return error;
};

// ../../../opt/npm-tools/node_modules/zod/v3/locales/en.js
var errorMap = (issue, _ctx) => {
  let message;
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      if (issue.received === ZodParsedType.undefined) {
        message = "Required";
      } else {
        message = `Expected ${issue.expected}, received ${issue.received}`;
      }
      break;
    case ZodIssueCode.invalid_literal:
      message = `Invalid literal value, expected ${JSON.stringify(issue.expected, util.jsonStringifyReplacer)}`;
      break;
    case ZodIssueCode.unrecognized_keys:
      message = `Unrecognized key(s) in object: ${util.joinValues(issue.keys, ", ")}`;
      break;
    case ZodIssueCode.invalid_union:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_union_discriminator:
      message = `Invalid discriminator value. Expected ${util.joinValues(issue.options)}`;
      break;
    case ZodIssueCode.invalid_enum_value:
      message = `Invalid enum value. Expected ${util.joinValues(issue.options)}, received '${issue.received}'`;
      break;
    case ZodIssueCode.invalid_arguments:
      message = `Invalid function arguments`;
      break;
    case ZodIssueCode.invalid_return_type:
      message = `Invalid function return type`;
      break;
    case ZodIssueCode.invalid_date:
      message = `Invalid date`;
      break;
    case ZodIssueCode.invalid_string:
      if (typeof issue.validation === "object") {
        if ("includes" in issue.validation) {
          message = `Invalid input: must include "${issue.validation.includes}"`;
          if (typeof issue.validation.position === "number") {
            message = `${message} at one or more positions greater than or equal to ${issue.validation.position}`;
          }
        } else if ("startsWith" in issue.validation) {
          message = `Invalid input: must start with "${issue.validation.startsWith}"`;
        } else if ("endsWith" in issue.validation) {
          message = `Invalid input: must end with "${issue.validation.endsWith}"`;
        } else {
          util.assertNever(issue.validation);
        }
      } else if (issue.validation !== "regex") {
        message = `Invalid ${issue.validation}`;
      } else {
        message = "Invalid";
      }
      break;
    case ZodIssueCode.too_small:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `more than`} ${issue.minimum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `over`} ${issue.minimum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "bigint")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${new Date(Number(issue.minimum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.too_big:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `less than`} ${issue.maximum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `under`} ${issue.maximum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "bigint")
        message = `BigInt must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly` : issue.inclusive ? `smaller than or equal to` : `smaller than`} ${new Date(Number(issue.maximum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.custom:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_intersection_types:
      message = `Intersection results could not be merged`;
      break;
    case ZodIssueCode.not_multiple_of:
      message = `Number must be a multiple of ${issue.multipleOf}`;
      break;
    case ZodIssueCode.not_finite:
      message = "Number must be finite";
      break;
    default:
      message = _ctx.defaultError;
      util.assertNever(issue);
  }
  return { message };
};
var en_default = errorMap;

// ../../../opt/npm-tools/node_modules/zod/v3/errors.js
var overrideErrorMap = en_default;
function setErrorMap(map) {
  overrideErrorMap = map;
}
function getErrorMap() {
  return overrideErrorMap;
}

// ../../../opt/npm-tools/node_modules/zod/v3/helpers/parseUtil.js
var makeIssue = (params) => {
  const { data, path, errorMaps, issueData } = params;
  const fullPath = [...path, ...issueData.path || []];
  const fullIssue = {
    ...issueData,
    path: fullPath
  };
  if (issueData.message !== undefined) {
    return {
      ...issueData,
      path: fullPath,
      message: issueData.message
    };
  }
  let errorMessage = "";
  const maps = errorMaps.filter((m) => !!m).slice().reverse();
  for (const map of maps) {
    errorMessage = map(fullIssue, { data, defaultError: errorMessage }).message;
  }
  return {
    ...issueData,
    path: fullPath,
    message: errorMessage
  };
};
function addIssueToContext(ctx, issueData) {
  const overrideMap = getErrorMap();
  const issue = makeIssue({
    issueData,
    data: ctx.data,
    path: ctx.path,
    errorMaps: [
      ctx.common.contextualErrorMap,
      ctx.schemaErrorMap,
      overrideMap,
      overrideMap === en_default ? undefined : en_default
    ].filter((x) => !!x)
  });
  ctx.common.issues.push(issue);
}

class ParseStatus {
  constructor() {
    this.value = "valid";
  }
  dirty() {
    if (this.value === "valid")
      this.value = "dirty";
  }
  abort() {
    if (this.value !== "aborted")
      this.value = "aborted";
  }
  static mergeArray(status, results) {
    const arrayValue = [];
    for (const s of results) {
      if (s.status === "aborted")
        return INVALID;
      if (s.status === "dirty")
        status.dirty();
      arrayValue.push(s.value);
    }
    return { status: status.value, value: arrayValue };
  }
  static async mergeObjectAsync(status, pairs) {
    const syncPairs = [];
    for (const pair of pairs) {
      const key = await pair.key;
      const value = await pair.value;
      syncPairs.push({
        key,
        value
      });
    }
    return ParseStatus.mergeObjectSync(status, syncPairs);
  }
  static mergeObjectSync(status, pairs) {
    const finalObject = {};
    for (const pair of pairs) {
      const { key, value } = pair;
      if (key.status === "aborted")
        return INVALID;
      if (value.status === "aborted")
        return INVALID;
      if (key.status === "dirty")
        status.dirty();
      if (value.status === "dirty")
        status.dirty();
      if (key.value !== "__proto__" && (typeof value.value !== "undefined" || pair.alwaysSet)) {
        finalObject[key.value] = value.value;
      }
    }
    return { status: status.value, value: finalObject };
  }
}
var INVALID = Object.freeze({
  status: "aborted"
});
var DIRTY = (value) => ({ status: "dirty", value });
var OK = (value) => ({ status: "valid", value });
var isAborted = (x) => x.status === "aborted";
var isDirty = (x) => x.status === "dirty";
var isValid = (x) => x.status === "valid";
var isAsync = (x) => typeof Promise !== "undefined" && x instanceof Promise;

// ../../../opt/npm-tools/node_modules/zod/v3/helpers/errorUtil.js
var errorUtil;
(function(errorUtil) {
  errorUtil.errToObj = (message) => typeof message === "string" ? { message } : message || {};
  errorUtil.toString = (message) => typeof message === "string" ? message : message?.message;
})(errorUtil || (errorUtil = {}));

// ../../../opt/npm-tools/node_modules/zod/v3/types.js
class ParseInputLazyPath {
  constructor(parent, value, path, key) {
    this._cachedPath = [];
    this.parent = parent;
    this.data = value;
    this._path = path;
    this._key = key;
  }
  get path() {
    if (!this._cachedPath.length) {
      if (Array.isArray(this._key)) {
        this._cachedPath.push(...this._path, ...this._key);
      } else {
        this._cachedPath.push(...this._path, this._key);
      }
    }
    return this._cachedPath;
  }
}
var handleResult = (ctx, result) => {
  if (isValid(result)) {
    return { success: true, data: result.value };
  } else {
    if (!ctx.common.issues.length) {
      throw new Error("Validation failed but no issues detected.");
    }
    return {
      success: false,
      get error() {
        if (this._error)
          return this._error;
        const error = new ZodError(ctx.common.issues);
        this._error = error;
        return this._error;
      }
    };
  }
};
function processCreateParams(params) {
  if (!params)
    return {};
  const { errorMap, invalid_type_error, required_error, description } = params;
  if (errorMap && (invalid_type_error || required_error)) {
    throw new Error(`Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`);
  }
  if (errorMap)
    return { errorMap, description };
  const customMap = (iss, ctx) => {
    const { message } = params;
    if (iss.code === "invalid_enum_value") {
      return { message: message ?? ctx.defaultError };
    }
    if (typeof ctx.data === "undefined") {
      return { message: message ?? required_error ?? ctx.defaultError };
    }
    if (iss.code !== "invalid_type")
      return { message: ctx.defaultError };
    return { message: message ?? invalid_type_error ?? ctx.defaultError };
  };
  return { errorMap: customMap, description };
}

class ZodType {
  get description() {
    return this._def.description;
  }
  _getType(input) {
    return getParsedType(input.data);
  }
  _getOrReturnCtx(input, ctx) {
    return ctx || {
      common: input.parent.common,
      data: input.data,
      parsedType: getParsedType(input.data),
      schemaErrorMap: this._def.errorMap,
      path: input.path,
      parent: input.parent
    };
  }
  _processInputParams(input) {
    return {
      status: new ParseStatus,
      ctx: {
        common: input.parent.common,
        data: input.data,
        parsedType: getParsedType(input.data),
        schemaErrorMap: this._def.errorMap,
        path: input.path,
        parent: input.parent
      }
    };
  }
  _parseSync(input) {
    const result = this._parse(input);
    if (isAsync(result)) {
      throw new Error("Synchronous parse encountered promise.");
    }
    return result;
  }
  _parseAsync(input) {
    const result = this._parse(input);
    return Promise.resolve(result);
  }
  parse(data, params) {
    const result = this.safeParse(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  safeParse(data, params) {
    const ctx = {
      common: {
        issues: [],
        async: params?.async ?? false,
        contextualErrorMap: params?.errorMap
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const result = this._parseSync({ data, path: ctx.path, parent: ctx });
    return handleResult(ctx, result);
  }
  "~validate"(data) {
    const ctx = {
      common: {
        issues: [],
        async: !!this["~standard"].async
      },
      path: [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    if (!this["~standard"].async) {
      try {
        const result = this._parseSync({ data, path: [], parent: ctx });
        return isValid(result) ? {
          value: result.value
        } : {
          issues: ctx.common.issues
        };
      } catch (err) {
        if (err?.message?.toLowerCase()?.includes("encountered")) {
          this["~standard"].async = true;
        }
        ctx.common = {
          issues: [],
          async: true
        };
      }
    }
    return this._parseAsync({ data, path: [], parent: ctx }).then((result) => isValid(result) ? {
      value: result.value
    } : {
      issues: ctx.common.issues
    });
  }
  async parseAsync(data, params) {
    const result = await this.safeParseAsync(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  async safeParseAsync(data, params) {
    const ctx = {
      common: {
        issues: [],
        contextualErrorMap: params?.errorMap,
        async: true
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const maybeAsyncResult = this._parse({ data, path: ctx.path, parent: ctx });
    const result = await (isAsync(maybeAsyncResult) ? maybeAsyncResult : Promise.resolve(maybeAsyncResult));
    return handleResult(ctx, result);
  }
  refine(check, message) {
    const getIssueProperties = (val) => {
      if (typeof message === "string" || typeof message === "undefined") {
        return { message };
      } else if (typeof message === "function") {
        return message(val);
      } else {
        return message;
      }
    };
    return this._refinement((val, ctx) => {
      const result = check(val);
      const setError = () => ctx.addIssue({
        code: ZodIssueCode.custom,
        ...getIssueProperties(val)
      });
      if (typeof Promise !== "undefined" && result instanceof Promise) {
        return result.then((data) => {
          if (!data) {
            setError();
            return false;
          } else {
            return true;
          }
        });
      }
      if (!result) {
        setError();
        return false;
      } else {
        return true;
      }
    });
  }
  refinement(check, refinementData) {
    return this._refinement((val, ctx) => {
      if (!check(val)) {
        ctx.addIssue(typeof refinementData === "function" ? refinementData(val, ctx) : refinementData);
        return false;
      } else {
        return true;
      }
    });
  }
  _refinement(refinement) {
    return new ZodEffects({
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "refinement", refinement }
    });
  }
  superRefine(refinement) {
    return this._refinement(refinement);
  }
  constructor(def) {
    this.spa = this.safeParseAsync;
    this._def = def;
    this.parse = this.parse.bind(this);
    this.safeParse = this.safeParse.bind(this);
    this.parseAsync = this.parseAsync.bind(this);
    this.safeParseAsync = this.safeParseAsync.bind(this);
    this.spa = this.spa.bind(this);
    this.refine = this.refine.bind(this);
    this.refinement = this.refinement.bind(this);
    this.superRefine = this.superRefine.bind(this);
    this.optional = this.optional.bind(this);
    this.nullable = this.nullable.bind(this);
    this.nullish = this.nullish.bind(this);
    this.array = this.array.bind(this);
    this.promise = this.promise.bind(this);
    this.or = this.or.bind(this);
    this.and = this.and.bind(this);
    this.transform = this.transform.bind(this);
    this.brand = this.brand.bind(this);
    this.default = this.default.bind(this);
    this.catch = this.catch.bind(this);
    this.describe = this.describe.bind(this);
    this.pipe = this.pipe.bind(this);
    this.readonly = this.readonly.bind(this);
    this.isNullable = this.isNullable.bind(this);
    this.isOptional = this.isOptional.bind(this);
    this["~standard"] = {
      version: 1,
      vendor: "zod",
      validate: (data) => this["~validate"](data)
    };
  }
  optional() {
    return ZodOptional.create(this, this._def);
  }
  nullable() {
    return ZodNullable.create(this, this._def);
  }
  nullish() {
    return this.nullable().optional();
  }
  array() {
    return ZodArray.create(this);
  }
  promise() {
    return ZodPromise.create(this, this._def);
  }
  or(option) {
    return ZodUnion.create([this, option], this._def);
  }
  and(incoming) {
    return ZodIntersection.create(this, incoming, this._def);
  }
  transform(transform) {
    return new ZodEffects({
      ...processCreateParams(this._def),
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "transform", transform }
    });
  }
  default(def) {
    const defaultValueFunc = typeof def === "function" ? def : () => def;
    return new ZodDefault({
      ...processCreateParams(this._def),
      innerType: this,
      defaultValue: defaultValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodDefault
    });
  }
  brand() {
    return new ZodBranded({
      typeName: ZodFirstPartyTypeKind.ZodBranded,
      type: this,
      ...processCreateParams(this._def)
    });
  }
  catch(def) {
    const catchValueFunc = typeof def === "function" ? def : () => def;
    return new ZodCatch({
      ...processCreateParams(this._def),
      innerType: this,
      catchValue: catchValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodCatch
    });
  }
  describe(description) {
    const This = this.constructor;
    return new This({
      ...this._def,
      description
    });
  }
  pipe(target) {
    return ZodPipeline.create(this, target);
  }
  readonly() {
    return ZodReadonly.create(this);
  }
  isOptional() {
    return this.safeParse(undefined).success;
  }
  isNullable() {
    return this.safeParse(null).success;
  }
}
var cuidRegex = /^c[^\s-]{8,}$/i;
var cuid2Regex = /^[0-9a-z]+$/;
var ulidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
var uuidRegex = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
var nanoidRegex = /^[a-z0-9_-]{21}$/i;
var jwtRegex = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/;
var durationRegex = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
var emailRegex = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;
var _emojiRegex = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
var emojiRegex;
var ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var ipv4CidrRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/(3[0-2]|[12]?[0-9])$/;
var ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
var ipv6CidrRegex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var base64Regex = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;
var base64urlRegex = /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/;
var dateRegexSource = `((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))`;
var dateRegex = new RegExp(`^${dateRegexSource}$`);
function timeRegexSource(args) {
  let secondsRegexSource = `[0-5]\\d`;
  if (args.precision) {
    secondsRegexSource = `${secondsRegexSource}\\.\\d{${args.precision}}`;
  } else if (args.precision == null) {
    secondsRegexSource = `${secondsRegexSource}(\\.\\d+)?`;
  }
  const secondsQuantifier = args.precision ? "+" : "?";
  return `([01]\\d|2[0-3]):[0-5]\\d(:${secondsRegexSource})${secondsQuantifier}`;
}
function timeRegex(args) {
  return new RegExp(`^${timeRegexSource(args)}$`);
}
function datetimeRegex(args) {
  let regex = `${dateRegexSource}T${timeRegexSource(args)}`;
  const opts = [];
  opts.push(args.local ? `Z?` : `Z`);
  if (args.offset)
    opts.push(`([+-]\\d{2}:?\\d{2})`);
  regex = `${regex}(${opts.join("|")})`;
  return new RegExp(`^${regex}$`);
}
function isValidIP(ip, version) {
  if ((version === "v4" || !version) && ipv4Regex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6Regex.test(ip)) {
    return true;
  }
  return false;
}
function isValidJWT(jwt, alg) {
  if (!jwtRegex.test(jwt))
    return false;
  try {
    const [header] = jwt.split(".");
    if (!header)
      return false;
    const base64 = header.replace(/-/g, "+").replace(/_/g, "/").padEnd(header.length + (4 - header.length % 4) % 4, "=");
    const decoded = JSON.parse(atob(base64));
    if (typeof decoded !== "object" || decoded === null)
      return false;
    if ("typ" in decoded && decoded?.typ !== "JWT")
      return false;
    if (!decoded.alg)
      return false;
    if (alg && decoded.alg !== alg)
      return false;
    return true;
  } catch {
    return false;
  }
}
function isValidCidr(ip, version) {
  if ((version === "v4" || !version) && ipv4CidrRegex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6CidrRegex.test(ip)) {
    return true;
  }
  return false;
}

class ZodString extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = String(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.string) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.string,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const status = new ParseStatus;
    let ctx = undefined;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.length < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.length > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "length") {
        const tooBig = input.data.length > check.value;
        const tooSmall = input.data.length < check.value;
        if (tooBig || tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          if (tooBig) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_big,
              maximum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          } else if (tooSmall) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_small,
              minimum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          }
          status.dirty();
        }
      } else if (check.kind === "email") {
        if (!emailRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "email",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "emoji") {
        if (!emojiRegex) {
          emojiRegex = new RegExp(_emojiRegex, "u");
        }
        if (!emojiRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "emoji",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "uuid") {
        if (!uuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "uuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "nanoid") {
        if (!nanoidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "nanoid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid") {
        if (!cuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid2") {
        if (!cuid2Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid2",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ulid") {
        if (!ulidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ulid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "url") {
        try {
          new URL(input.data);
        } catch {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "regex") {
        check.regex.lastIndex = 0;
        const testResult = check.regex.test(input.data);
        if (!testResult) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "regex",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "trim") {
        input.data = input.data.trim();
      } else if (check.kind === "includes") {
        if (!input.data.includes(check.value, check.position)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { includes: check.value, position: check.position },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "toLowerCase") {
        input.data = input.data.toLowerCase();
      } else if (check.kind === "toUpperCase") {
        input.data = input.data.toUpperCase();
      } else if (check.kind === "startsWith") {
        if (!input.data.startsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { startsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "endsWith") {
        if (!input.data.endsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { endsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "datetime") {
        const regex = datetimeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "datetime",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "date") {
        const regex = dateRegex;
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "date",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "time") {
        const regex = timeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "time",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "duration") {
        if (!durationRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "duration",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ip") {
        if (!isValidIP(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ip",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "jwt") {
        if (!isValidJWT(input.data, check.alg)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "jwt",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cidr") {
        if (!isValidCidr(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cidr",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64") {
        if (!base64Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64url") {
        if (!base64urlRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _regex(regex, validation, message) {
    return this.refinement((data) => regex.test(data), {
      validation,
      code: ZodIssueCode.invalid_string,
      ...errorUtil.errToObj(message)
    });
  }
  _addCheck(check) {
    return new ZodString({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  email(message) {
    return this._addCheck({ kind: "email", ...errorUtil.errToObj(message) });
  }
  url(message) {
    return this._addCheck({ kind: "url", ...errorUtil.errToObj(message) });
  }
  emoji(message) {
    return this._addCheck({ kind: "emoji", ...errorUtil.errToObj(message) });
  }
  uuid(message) {
    return this._addCheck({ kind: "uuid", ...errorUtil.errToObj(message) });
  }
  nanoid(message) {
    return this._addCheck({ kind: "nanoid", ...errorUtil.errToObj(message) });
  }
  cuid(message) {
    return this._addCheck({ kind: "cuid", ...errorUtil.errToObj(message) });
  }
  cuid2(message) {
    return this._addCheck({ kind: "cuid2", ...errorUtil.errToObj(message) });
  }
  ulid(message) {
    return this._addCheck({ kind: "ulid", ...errorUtil.errToObj(message) });
  }
  base64(message) {
    return this._addCheck({ kind: "base64", ...errorUtil.errToObj(message) });
  }
  base64url(message) {
    return this._addCheck({
      kind: "base64url",
      ...errorUtil.errToObj(message)
    });
  }
  jwt(options) {
    return this._addCheck({ kind: "jwt", ...errorUtil.errToObj(options) });
  }
  ip(options) {
    return this._addCheck({ kind: "ip", ...errorUtil.errToObj(options) });
  }
  cidr(options) {
    return this._addCheck({ kind: "cidr", ...errorUtil.errToObj(options) });
  }
  datetime(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "datetime",
        precision: null,
        offset: false,
        local: false,
        message: options
      });
    }
    return this._addCheck({
      kind: "datetime",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      offset: options?.offset ?? false,
      local: options?.local ?? false,
      ...errorUtil.errToObj(options?.message)
    });
  }
  date(message) {
    return this._addCheck({ kind: "date", message });
  }
  time(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "time",
        precision: null,
        message: options
      });
    }
    return this._addCheck({
      kind: "time",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      ...errorUtil.errToObj(options?.message)
    });
  }
  duration(message) {
    return this._addCheck({ kind: "duration", ...errorUtil.errToObj(message) });
  }
  regex(regex, message) {
    return this._addCheck({
      kind: "regex",
      regex,
      ...errorUtil.errToObj(message)
    });
  }
  includes(value, options) {
    return this._addCheck({
      kind: "includes",
      value,
      position: options?.position,
      ...errorUtil.errToObj(options?.message)
    });
  }
  startsWith(value, message) {
    return this._addCheck({
      kind: "startsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  endsWith(value, message) {
    return this._addCheck({
      kind: "endsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  min(minLength, message) {
    return this._addCheck({
      kind: "min",
      value: minLength,
      ...errorUtil.errToObj(message)
    });
  }
  max(maxLength, message) {
    return this._addCheck({
      kind: "max",
      value: maxLength,
      ...errorUtil.errToObj(message)
    });
  }
  length(len, message) {
    return this._addCheck({
      kind: "length",
      value: len,
      ...errorUtil.errToObj(message)
    });
  }
  nonempty(message) {
    return this.min(1, errorUtil.errToObj(message));
  }
  trim() {
    return new ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "trim" }]
    });
  }
  toLowerCase() {
    return new ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toLowerCase" }]
    });
  }
  toUpperCase() {
    return new ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toUpperCase" }]
    });
  }
  get isDatetime() {
    return !!this._def.checks.find((ch) => ch.kind === "datetime");
  }
  get isDate() {
    return !!this._def.checks.find((ch) => ch.kind === "date");
  }
  get isTime() {
    return !!this._def.checks.find((ch) => ch.kind === "time");
  }
  get isDuration() {
    return !!this._def.checks.find((ch) => ch.kind === "duration");
  }
  get isEmail() {
    return !!this._def.checks.find((ch) => ch.kind === "email");
  }
  get isURL() {
    return !!this._def.checks.find((ch) => ch.kind === "url");
  }
  get isEmoji() {
    return !!this._def.checks.find((ch) => ch.kind === "emoji");
  }
  get isUUID() {
    return !!this._def.checks.find((ch) => ch.kind === "uuid");
  }
  get isNANOID() {
    return !!this._def.checks.find((ch) => ch.kind === "nanoid");
  }
  get isCUID() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid");
  }
  get isCUID2() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid2");
  }
  get isULID() {
    return !!this._def.checks.find((ch) => ch.kind === "ulid");
  }
  get isIP() {
    return !!this._def.checks.find((ch) => ch.kind === "ip");
  }
  get isCIDR() {
    return !!this._def.checks.find((ch) => ch.kind === "cidr");
  }
  get isBase64() {
    return !!this._def.checks.find((ch) => ch.kind === "base64");
  }
  get isBase64url() {
    return !!this._def.checks.find((ch) => ch.kind === "base64url");
  }
  get minLength() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxLength() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
}
ZodString.create = (params) => {
  return new ZodString({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodString,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};
function floatSafeRemainder(val, step) {
  const valDecCount = (val.toString().split(".")[1] || "").length;
  const stepDecCount = (step.toString().split(".")[1] || "").length;
  const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
  const valInt = Number.parseInt(val.toFixed(decCount).replace(".", ""));
  const stepInt = Number.parseInt(step.toFixed(decCount).replace(".", ""));
  return valInt % stepInt / 10 ** decCount;
}

class ZodNumber extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
    this.step = this.multipleOf;
  }
  _parse(input) {
    if (this._def.coerce) {
      input.data = Number(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.number) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.number,
        received: ctx.parsedType
      });
      return INVALID;
    }
    let ctx = undefined;
    const status = new ParseStatus;
    for (const check of this._def.checks) {
      if (check.kind === "int") {
        if (!util.isInteger(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: "integer",
            received: "float",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (floatSafeRemainder(input.data, check.value) !== 0) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "finite") {
        if (!Number.isFinite(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_finite,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new ZodNumber({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new ZodNumber({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  int(message) {
    return this._addCheck({
      kind: "int",
      message: errorUtil.toString(message)
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  finite(message) {
    return this._addCheck({
      kind: "finite",
      message: errorUtil.toString(message)
    });
  }
  safe(message) {
    return this._addCheck({
      kind: "min",
      inclusive: true,
      value: Number.MIN_SAFE_INTEGER,
      message: errorUtil.toString(message)
    })._addCheck({
      kind: "max",
      inclusive: true,
      value: Number.MAX_SAFE_INTEGER,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
  get isInt() {
    return !!this._def.checks.find((ch) => ch.kind === "int" || ch.kind === "multipleOf" && util.isInteger(ch.value));
  }
  get isFinite() {
    let max = null;
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "finite" || ch.kind === "int" || ch.kind === "multipleOf") {
        return true;
      } else if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      } else if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return Number.isFinite(min) && Number.isFinite(max);
  }
}
ZodNumber.create = (params) => {
  return new ZodNumber({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodNumber,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};

class ZodBigInt extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
  }
  _parse(input) {
    if (this._def.coerce) {
      try {
        input.data = BigInt(input.data);
      } catch {
        return this._getInvalidInput(input);
      }
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.bigint) {
      return this._getInvalidInput(input);
    }
    let ctx = undefined;
    const status = new ParseStatus;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            type: "bigint",
            minimum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            type: "bigint",
            maximum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (input.data % check.value !== BigInt(0)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _getInvalidInput(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.bigint,
      received: ctx.parsedType
    });
    return INVALID;
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new ZodBigInt({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new ZodBigInt({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
}
ZodBigInt.create = (params) => {
  return new ZodBigInt({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodBigInt,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};

class ZodBoolean extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = Boolean(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.boolean) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.boolean,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
}
ZodBoolean.create = (params) => {
  return new ZodBoolean({
    typeName: ZodFirstPartyTypeKind.ZodBoolean,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};

class ZodDate extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = new Date(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.date) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.date,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (Number.isNaN(input.data.getTime())) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_date
      });
      return INVALID;
    }
    const status = new ParseStatus;
    let ctx = undefined;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.getTime() < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            message: check.message,
            inclusive: true,
            exact: false,
            minimum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.getTime() > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            message: check.message,
            inclusive: true,
            exact: false,
            maximum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return {
      status: status.value,
      value: new Date(input.data.getTime())
    };
  }
  _addCheck(check) {
    return new ZodDate({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  min(minDate, message) {
    return this._addCheck({
      kind: "min",
      value: minDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  max(maxDate, message) {
    return this._addCheck({
      kind: "max",
      value: maxDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  get minDate() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min != null ? new Date(min) : null;
  }
  get maxDate() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max != null ? new Date(max) : null;
  }
}
ZodDate.create = (params) => {
  return new ZodDate({
    checks: [],
    coerce: params?.coerce || false,
    typeName: ZodFirstPartyTypeKind.ZodDate,
    ...processCreateParams(params)
  });
};

class ZodSymbol extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.symbol) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.symbol,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
}
ZodSymbol.create = (params) => {
  return new ZodSymbol({
    typeName: ZodFirstPartyTypeKind.ZodSymbol,
    ...processCreateParams(params)
  });
};

class ZodUndefined extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.undefined,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
}
ZodUndefined.create = (params) => {
  return new ZodUndefined({
    typeName: ZodFirstPartyTypeKind.ZodUndefined,
    ...processCreateParams(params)
  });
};

class ZodNull extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.null) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.null,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
}
ZodNull.create = (params) => {
  return new ZodNull({
    typeName: ZodFirstPartyTypeKind.ZodNull,
    ...processCreateParams(params)
  });
};

class ZodAny extends ZodType {
  constructor() {
    super(...arguments);
    this._any = true;
  }
  _parse(input) {
    return OK(input.data);
  }
}
ZodAny.create = (params) => {
  return new ZodAny({
    typeName: ZodFirstPartyTypeKind.ZodAny,
    ...processCreateParams(params)
  });
};

class ZodUnknown extends ZodType {
  constructor() {
    super(...arguments);
    this._unknown = true;
  }
  _parse(input) {
    return OK(input.data);
  }
}
ZodUnknown.create = (params) => {
  return new ZodUnknown({
    typeName: ZodFirstPartyTypeKind.ZodUnknown,
    ...processCreateParams(params)
  });
};

class ZodNever extends ZodType {
  _parse(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.never,
      received: ctx.parsedType
    });
    return INVALID;
  }
}
ZodNever.create = (params) => {
  return new ZodNever({
    typeName: ZodFirstPartyTypeKind.ZodNever,
    ...processCreateParams(params)
  });
};

class ZodVoid extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.void,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
}
ZodVoid.create = (params) => {
  return new ZodVoid({
    typeName: ZodFirstPartyTypeKind.ZodVoid,
    ...processCreateParams(params)
  });
};

class ZodArray extends ZodType {
  _parse(input) {
    const { ctx, status } = this._processInputParams(input);
    const def = this._def;
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (def.exactLength !== null) {
      const tooBig = ctx.data.length > def.exactLength.value;
      const tooSmall = ctx.data.length < def.exactLength.value;
      if (tooBig || tooSmall) {
        addIssueToContext(ctx, {
          code: tooBig ? ZodIssueCode.too_big : ZodIssueCode.too_small,
          minimum: tooSmall ? def.exactLength.value : undefined,
          maximum: tooBig ? def.exactLength.value : undefined,
          type: "array",
          inclusive: true,
          exact: true,
          message: def.exactLength.message
        });
        status.dirty();
      }
    }
    if (def.minLength !== null) {
      if (ctx.data.length < def.minLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.minLength.message
        });
        status.dirty();
      }
    }
    if (def.maxLength !== null) {
      if (ctx.data.length > def.maxLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.maxLength.message
        });
        status.dirty();
      }
    }
    if (ctx.common.async) {
      return Promise.all([...ctx.data].map((item, i) => {
        return def.type._parseAsync(new ParseInputLazyPath(ctx, item, ctx.path, i));
      })).then((result) => {
        return ParseStatus.mergeArray(status, result);
      });
    }
    const result = [...ctx.data].map((item, i) => {
      return def.type._parseSync(new ParseInputLazyPath(ctx, item, ctx.path, i));
    });
    return ParseStatus.mergeArray(status, result);
  }
  get element() {
    return this._def.type;
  }
  min(minLength, message) {
    return new ZodArray({
      ...this._def,
      minLength: { value: minLength, message: errorUtil.toString(message) }
    });
  }
  max(maxLength, message) {
    return new ZodArray({
      ...this._def,
      maxLength: { value: maxLength, message: errorUtil.toString(message) }
    });
  }
  length(len, message) {
    return new ZodArray({
      ...this._def,
      exactLength: { value: len, message: errorUtil.toString(message) }
    });
  }
  nonempty(message) {
    return this.min(1, message);
  }
}
ZodArray.create = (schema, params) => {
  return new ZodArray({
    type: schema,
    minLength: null,
    maxLength: null,
    exactLength: null,
    typeName: ZodFirstPartyTypeKind.ZodArray,
    ...processCreateParams(params)
  });
};
function deepPartialify(schema) {
  if (schema instanceof ZodObject) {
    const newShape = {};
    for (const key in schema.shape) {
      const fieldSchema = schema.shape[key];
      newShape[key] = ZodOptional.create(deepPartialify(fieldSchema));
    }
    return new ZodObject({
      ...schema._def,
      shape: () => newShape
    });
  } else if (schema instanceof ZodArray) {
    return new ZodArray({
      ...schema._def,
      type: deepPartialify(schema.element)
    });
  } else if (schema instanceof ZodOptional) {
    return ZodOptional.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodNullable) {
    return ZodNullable.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodTuple) {
    return ZodTuple.create(schema.items.map((item) => deepPartialify(item)));
  } else {
    return schema;
  }
}

class ZodObject extends ZodType {
  constructor() {
    super(...arguments);
    this._cached = null;
    this.nonstrict = this.passthrough;
    this.augment = this.extend;
  }
  _getCached() {
    if (this._cached !== null)
      return this._cached;
    const shape = this._def.shape();
    const keys = util.objectKeys(shape);
    this._cached = { shape, keys };
    return this._cached;
  }
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.object) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const { status, ctx } = this._processInputParams(input);
    const { shape, keys: shapeKeys } = this._getCached();
    const extraKeys = [];
    if (!(this._def.catchall instanceof ZodNever && this._def.unknownKeys === "strip")) {
      for (const key in ctx.data) {
        if (!shapeKeys.includes(key)) {
          extraKeys.push(key);
        }
      }
    }
    const pairs = [];
    for (const key of shapeKeys) {
      const keyValidator = shape[key];
      const value = ctx.data[key];
      pairs.push({
        key: { status: "valid", value: key },
        value: keyValidator._parse(new ParseInputLazyPath(ctx, value, ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (this._def.catchall instanceof ZodNever) {
      const unknownKeys = this._def.unknownKeys;
      if (unknownKeys === "passthrough") {
        for (const key of extraKeys) {
          pairs.push({
            key: { status: "valid", value: key },
            value: { status: "valid", value: ctx.data[key] }
          });
        }
      } else if (unknownKeys === "strict") {
        if (extraKeys.length > 0) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.unrecognized_keys,
            keys: extraKeys
          });
          status.dirty();
        }
      } else if (unknownKeys === "strip") {} else {
        throw new Error(`Internal ZodObject error: invalid unknownKeys value.`);
      }
    } else {
      const catchall = this._def.catchall;
      for (const key of extraKeys) {
        const value = ctx.data[key];
        pairs.push({
          key: { status: "valid", value: key },
          value: catchall._parse(new ParseInputLazyPath(ctx, value, ctx.path, key)),
          alwaysSet: key in ctx.data
        });
      }
    }
    if (ctx.common.async) {
      return Promise.resolve().then(async () => {
        const syncPairs = [];
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          syncPairs.push({
            key,
            value,
            alwaysSet: pair.alwaysSet
          });
        }
        return syncPairs;
      }).then((syncPairs) => {
        return ParseStatus.mergeObjectSync(status, syncPairs);
      });
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get shape() {
    return this._def.shape();
  }
  strict(message) {
    errorUtil.errToObj;
    return new ZodObject({
      ...this._def,
      unknownKeys: "strict",
      ...message !== undefined ? {
        errorMap: (issue, ctx) => {
          const defaultError = this._def.errorMap?.(issue, ctx).message ?? ctx.defaultError;
          if (issue.code === "unrecognized_keys")
            return {
              message: errorUtil.errToObj(message).message ?? defaultError
            };
          return {
            message: defaultError
          };
        }
      } : {}
    });
  }
  strip() {
    return new ZodObject({
      ...this._def,
      unknownKeys: "strip"
    });
  }
  passthrough() {
    return new ZodObject({
      ...this._def,
      unknownKeys: "passthrough"
    });
  }
  extend(augmentation) {
    return new ZodObject({
      ...this._def,
      shape: () => ({
        ...this._def.shape(),
        ...augmentation
      })
    });
  }
  merge(merging) {
    const merged = new ZodObject({
      unknownKeys: merging._def.unknownKeys,
      catchall: merging._def.catchall,
      shape: () => ({
        ...this._def.shape(),
        ...merging._def.shape()
      }),
      typeName: ZodFirstPartyTypeKind.ZodObject
    });
    return merged;
  }
  setKey(key, schema) {
    return this.augment({ [key]: schema });
  }
  catchall(index) {
    return new ZodObject({
      ...this._def,
      catchall: index
    });
  }
  pick(mask) {
    const shape = {};
    for (const key of util.objectKeys(mask)) {
      if (mask[key] && this.shape[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  omit(mask) {
    const shape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (!mask[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  deepPartial() {
    return deepPartialify(this);
  }
  partial(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      const fieldSchema = this.shape[key];
      if (mask && !mask[key]) {
        newShape[key] = fieldSchema;
      } else {
        newShape[key] = fieldSchema.optional();
      }
    }
    return new ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  required(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (mask && !mask[key]) {
        newShape[key] = this.shape[key];
      } else {
        const fieldSchema = this.shape[key];
        let newField = fieldSchema;
        while (newField instanceof ZodOptional) {
          newField = newField._def.innerType;
        }
        newShape[key] = newField;
      }
    }
    return new ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  keyof() {
    return createZodEnum(util.objectKeys(this.shape));
  }
}
ZodObject.create = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.strictCreate = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strict",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.lazycreate = (shape, params) => {
  return new ZodObject({
    shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};

class ZodUnion extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const options = this._def.options;
    function handleResults(results) {
      for (const result of results) {
        if (result.result.status === "valid") {
          return result.result;
        }
      }
      for (const result of results) {
        if (result.result.status === "dirty") {
          ctx.common.issues.push(...result.ctx.common.issues);
          return result.result;
        }
      }
      const unionErrors = results.map((result) => new ZodError(result.ctx.common.issues));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return Promise.all(options.map(async (option) => {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        return {
          result: await option._parseAsync({
            data: ctx.data,
            path: ctx.path,
            parent: childCtx
          }),
          ctx: childCtx
        };
      })).then(handleResults);
    } else {
      let dirty = undefined;
      const issues = [];
      for (const option of options) {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        const result = option._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: childCtx
        });
        if (result.status === "valid") {
          return result;
        } else if (result.status === "dirty" && !dirty) {
          dirty = { result, ctx: childCtx };
        }
        if (childCtx.common.issues.length) {
          issues.push(childCtx.common.issues);
        }
      }
      if (dirty) {
        ctx.common.issues.push(...dirty.ctx.common.issues);
        return dirty.result;
      }
      const unionErrors = issues.map((issues) => new ZodError(issues));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
  }
  get options() {
    return this._def.options;
  }
}
ZodUnion.create = (types, params) => {
  return new ZodUnion({
    options: types,
    typeName: ZodFirstPartyTypeKind.ZodUnion,
    ...processCreateParams(params)
  });
};
var getDiscriminator = (type) => {
  if (type instanceof ZodLazy) {
    return getDiscriminator(type.schema);
  } else if (type instanceof ZodEffects) {
    return getDiscriminator(type.innerType());
  } else if (type instanceof ZodLiteral) {
    return [type.value];
  } else if (type instanceof ZodEnum) {
    return type.options;
  } else if (type instanceof ZodNativeEnum) {
    return util.objectValues(type.enum);
  } else if (type instanceof ZodDefault) {
    return getDiscriminator(type._def.innerType);
  } else if (type instanceof ZodUndefined) {
    return [undefined];
  } else if (type instanceof ZodNull) {
    return [null];
  } else if (type instanceof ZodOptional) {
    return [undefined, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodNullable) {
    return [null, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodBranded) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodReadonly) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodCatch) {
    return getDiscriminator(type._def.innerType);
  } else {
    return [];
  }
};

class ZodDiscriminatedUnion extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const discriminator = this.discriminator;
    const discriminatorValue = ctx.data[discriminator];
    const option = this.optionsMap.get(discriminatorValue);
    if (!option) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union_discriminator,
        options: Array.from(this.optionsMap.keys()),
        path: [discriminator]
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return option._parseAsync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    } else {
      return option._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    }
  }
  get discriminator() {
    return this._def.discriminator;
  }
  get options() {
    return this._def.options;
  }
  get optionsMap() {
    return this._def.optionsMap;
  }
  static create(discriminator, options, params) {
    const optionsMap = new Map;
    for (const type of options) {
      const discriminatorValues = getDiscriminator(type.shape[discriminator]);
      if (!discriminatorValues.length) {
        throw new Error(`A discriminator value for key \`${discriminator}\` could not be extracted from all schema options`);
      }
      for (const value of discriminatorValues) {
        if (optionsMap.has(value)) {
          throw new Error(`Discriminator property ${String(discriminator)} has duplicate value ${String(value)}`);
        }
        optionsMap.set(value, type);
      }
    }
    return new ZodDiscriminatedUnion({
      typeName: ZodFirstPartyTypeKind.ZodDiscriminatedUnion,
      discriminator,
      options,
      optionsMap,
      ...processCreateParams(params)
    });
  }
}
function mergeValues(a, b) {
  const aType = getParsedType(a);
  const bType = getParsedType(b);
  if (a === b) {
    return { valid: true, data: a };
  } else if (aType === ZodParsedType.object && bType === ZodParsedType.object) {
    const bKeys = util.objectKeys(b);
    const sharedKeys = util.objectKeys(a).filter((key) => bKeys.indexOf(key) !== -1);
    const newObj = { ...a, ...b };
    for (const key of sharedKeys) {
      const sharedValue = mergeValues(a[key], b[key]);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newObj[key] = sharedValue.data;
    }
    return { valid: true, data: newObj };
  } else if (aType === ZodParsedType.array && bType === ZodParsedType.array) {
    if (a.length !== b.length) {
      return { valid: false };
    }
    const newArray = [];
    for (let index = 0;index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues(itemA, itemB);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newArray.push(sharedValue.data);
    }
    return { valid: true, data: newArray };
  } else if (aType === ZodParsedType.date && bType === ZodParsedType.date && +a === +b) {
    return { valid: true, data: a };
  } else {
    return { valid: false };
  }
}

class ZodIntersection extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const handleParsed = (parsedLeft, parsedRight) => {
      if (isAborted(parsedLeft) || isAborted(parsedRight)) {
        return INVALID;
      }
      const merged = mergeValues(parsedLeft.value, parsedRight.value);
      if (!merged.valid) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_intersection_types
        });
        return INVALID;
      }
      if (isDirty(parsedLeft) || isDirty(parsedRight)) {
        status.dirty();
      }
      return { status: status.value, value: merged.data };
    };
    if (ctx.common.async) {
      return Promise.all([
        this._def.left._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        }),
        this._def.right._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        })
      ]).then(([left, right]) => handleParsed(left, right));
    } else {
      return handleParsed(this._def.left._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }), this._def.right._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }));
    }
  }
}
ZodIntersection.create = (left, right, params) => {
  return new ZodIntersection({
    left,
    right,
    typeName: ZodFirstPartyTypeKind.ZodIntersection,
    ...processCreateParams(params)
  });
};

class ZodTuple extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (ctx.data.length < this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_small,
        minimum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      return INVALID;
    }
    const rest = this._def.rest;
    if (!rest && ctx.data.length > this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_big,
        maximum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      status.dirty();
    }
    const items = [...ctx.data].map((item, itemIndex) => {
      const schema = this._def.items[itemIndex] || this._def.rest;
      if (!schema)
        return null;
      return schema._parse(new ParseInputLazyPath(ctx, item, ctx.path, itemIndex));
    }).filter((x) => !!x);
    if (ctx.common.async) {
      return Promise.all(items).then((results) => {
        return ParseStatus.mergeArray(status, results);
      });
    } else {
      return ParseStatus.mergeArray(status, items);
    }
  }
  get items() {
    return this._def.items;
  }
  rest(rest) {
    return new ZodTuple({
      ...this._def,
      rest
    });
  }
}
ZodTuple.create = (schemas, params) => {
  if (!Array.isArray(schemas)) {
    throw new Error("You must pass an array of schemas to z.tuple([ ... ])");
  }
  return new ZodTuple({
    items: schemas,
    typeName: ZodFirstPartyTypeKind.ZodTuple,
    rest: null,
    ...processCreateParams(params)
  });
};

class ZodRecord extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const pairs = [];
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    for (const key in ctx.data) {
      pairs.push({
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, key)),
        value: valueType._parse(new ParseInputLazyPath(ctx, ctx.data[key], ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (ctx.common.async) {
      return ParseStatus.mergeObjectAsync(status, pairs);
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get element() {
    return this._def.valueType;
  }
  static create(first, second, third) {
    if (second instanceof ZodType) {
      return new ZodRecord({
        keyType: first,
        valueType: second,
        typeName: ZodFirstPartyTypeKind.ZodRecord,
        ...processCreateParams(third)
      });
    }
    return new ZodRecord({
      keyType: ZodString.create(),
      valueType: first,
      typeName: ZodFirstPartyTypeKind.ZodRecord,
      ...processCreateParams(second)
    });
  }
}

class ZodMap extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.map) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.map,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    const pairs = [...ctx.data.entries()].map(([key, value], index) => {
      return {
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, [index, "key"])),
        value: valueType._parse(new ParseInputLazyPath(ctx, value, ctx.path, [index, "value"]))
      };
    });
    if (ctx.common.async) {
      const finalMap = new Map;
      return Promise.resolve().then(async () => {
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          if (key.status === "aborted" || value.status === "aborted") {
            return INVALID;
          }
          if (key.status === "dirty" || value.status === "dirty") {
            status.dirty();
          }
          finalMap.set(key.value, value.value);
        }
        return { status: status.value, value: finalMap };
      });
    } else {
      const finalMap = new Map;
      for (const pair of pairs) {
        const key = pair.key;
        const value = pair.value;
        if (key.status === "aborted" || value.status === "aborted") {
          return INVALID;
        }
        if (key.status === "dirty" || value.status === "dirty") {
          status.dirty();
        }
        finalMap.set(key.value, value.value);
      }
      return { status: status.value, value: finalMap };
    }
  }
}
ZodMap.create = (keyType, valueType, params) => {
  return new ZodMap({
    valueType,
    keyType,
    typeName: ZodFirstPartyTypeKind.ZodMap,
    ...processCreateParams(params)
  });
};

class ZodSet extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.set) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.set,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const def = this._def;
    if (def.minSize !== null) {
      if (ctx.data.size < def.minSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.minSize.message
        });
        status.dirty();
      }
    }
    if (def.maxSize !== null) {
      if (ctx.data.size > def.maxSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.maxSize.message
        });
        status.dirty();
      }
    }
    const valueType = this._def.valueType;
    function finalizeSet(elements) {
      const parsedSet = new Set;
      for (const element of elements) {
        if (element.status === "aborted")
          return INVALID;
        if (element.status === "dirty")
          status.dirty();
        parsedSet.add(element.value);
      }
      return { status: status.value, value: parsedSet };
    }
    const elements = [...ctx.data.values()].map((item, i) => valueType._parse(new ParseInputLazyPath(ctx, item, ctx.path, i)));
    if (ctx.common.async) {
      return Promise.all(elements).then((elements) => finalizeSet(elements));
    } else {
      return finalizeSet(elements);
    }
  }
  min(minSize, message) {
    return new ZodSet({
      ...this._def,
      minSize: { value: minSize, message: errorUtil.toString(message) }
    });
  }
  max(maxSize, message) {
    return new ZodSet({
      ...this._def,
      maxSize: { value: maxSize, message: errorUtil.toString(message) }
    });
  }
  size(size, message) {
    return this.min(size, message).max(size, message);
  }
  nonempty(message) {
    return this.min(1, message);
  }
}
ZodSet.create = (valueType, params) => {
  return new ZodSet({
    valueType,
    minSize: null,
    maxSize: null,
    typeName: ZodFirstPartyTypeKind.ZodSet,
    ...processCreateParams(params)
  });
};

class ZodFunction extends ZodType {
  constructor() {
    super(...arguments);
    this.validate = this.implement;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.function) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.function,
        received: ctx.parsedType
      });
      return INVALID;
    }
    function makeArgsIssue(args, error) {
      return makeIssue({
        data: args,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_arguments,
          argumentsError: error
        }
      });
    }
    function makeReturnsIssue(returns, error) {
      return makeIssue({
        data: returns,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_return_type,
          returnTypeError: error
        }
      });
    }
    const params = { errorMap: ctx.common.contextualErrorMap };
    const fn = ctx.data;
    if (this._def.returns instanceof ZodPromise) {
      const me = this;
      return OK(async function(...args) {
        const error = new ZodError([]);
        const parsedArgs = await me._def.args.parseAsync(args, params).catch((e) => {
          error.addIssue(makeArgsIssue(args, e));
          throw error;
        });
        const result = await Reflect.apply(fn, this, parsedArgs);
        const parsedReturns = await me._def.returns._def.type.parseAsync(result, params).catch((e) => {
          error.addIssue(makeReturnsIssue(result, e));
          throw error;
        });
        return parsedReturns;
      });
    } else {
      const me = this;
      return OK(function(...args) {
        const parsedArgs = me._def.args.safeParse(args, params);
        if (!parsedArgs.success) {
          throw new ZodError([makeArgsIssue(args, parsedArgs.error)]);
        }
        const result = Reflect.apply(fn, this, parsedArgs.data);
        const parsedReturns = me._def.returns.safeParse(result, params);
        if (!parsedReturns.success) {
          throw new ZodError([makeReturnsIssue(result, parsedReturns.error)]);
        }
        return parsedReturns.data;
      });
    }
  }
  parameters() {
    return this._def.args;
  }
  returnType() {
    return this._def.returns;
  }
  args(...items) {
    return new ZodFunction({
      ...this._def,
      args: ZodTuple.create(items).rest(ZodUnknown.create())
    });
  }
  returns(returnType) {
    return new ZodFunction({
      ...this._def,
      returns: returnType
    });
  }
  implement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  strictImplement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  static create(args, returns, params) {
    return new ZodFunction({
      args: args ? args : ZodTuple.create([]).rest(ZodUnknown.create()),
      returns: returns || ZodUnknown.create(),
      typeName: ZodFirstPartyTypeKind.ZodFunction,
      ...processCreateParams(params)
    });
  }
}

class ZodLazy extends ZodType {
  get schema() {
    return this._def.getter();
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const lazySchema = this._def.getter();
    return lazySchema._parse({ data: ctx.data, path: ctx.path, parent: ctx });
  }
}
ZodLazy.create = (getter, params) => {
  return new ZodLazy({
    getter,
    typeName: ZodFirstPartyTypeKind.ZodLazy,
    ...processCreateParams(params)
  });
};

class ZodLiteral extends ZodType {
  _parse(input) {
    if (input.data !== this._def.value) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_literal,
        expected: this._def.value
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
  get value() {
    return this._def.value;
  }
}
ZodLiteral.create = (value, params) => {
  return new ZodLiteral({
    value,
    typeName: ZodFirstPartyTypeKind.ZodLiteral,
    ...processCreateParams(params)
  });
};
function createZodEnum(values, params) {
  return new ZodEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodEnum,
    ...processCreateParams(params)
  });
}

class ZodEnum extends ZodType {
  _parse(input) {
    if (typeof input.data !== "string") {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(this._def.values);
    }
    if (!this._cache.has(input.data)) {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get options() {
    return this._def.values;
  }
  get enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Values() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  extract(values, newDef = this._def) {
    return ZodEnum.create(values, {
      ...this._def,
      ...newDef
    });
  }
  exclude(values, newDef = this._def) {
    return ZodEnum.create(this.options.filter((opt) => !values.includes(opt)), {
      ...this._def,
      ...newDef
    });
  }
}
ZodEnum.create = createZodEnum;

class ZodNativeEnum extends ZodType {
  _parse(input) {
    const nativeEnumValues = util.getValidEnumValues(this._def.values);
    const ctx = this._getOrReturnCtx(input);
    if (ctx.parsedType !== ZodParsedType.string && ctx.parsedType !== ZodParsedType.number) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(util.getValidEnumValues(this._def.values));
    }
    if (!this._cache.has(input.data)) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get enum() {
    return this._def.values;
  }
}
ZodNativeEnum.create = (values, params) => {
  return new ZodNativeEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodNativeEnum,
    ...processCreateParams(params)
  });
};

class ZodPromise extends ZodType {
  unwrap() {
    return this._def.type;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.promise && ctx.common.async === false) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.promise,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const promisified = ctx.parsedType === ZodParsedType.promise ? ctx.data : Promise.resolve(ctx.data);
    return OK(promisified.then((data) => {
      return this._def.type.parseAsync(data, {
        path: ctx.path,
        errorMap: ctx.common.contextualErrorMap
      });
    }));
  }
}
ZodPromise.create = (schema, params) => {
  return new ZodPromise({
    type: schema,
    typeName: ZodFirstPartyTypeKind.ZodPromise,
    ...processCreateParams(params)
  });
};

class ZodEffects extends ZodType {
  innerType() {
    return this._def.schema;
  }
  sourceType() {
    return this._def.schema._def.typeName === ZodFirstPartyTypeKind.ZodEffects ? this._def.schema.sourceType() : this._def.schema;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const effect = this._def.effect || null;
    const checkCtx = {
      addIssue: (arg) => {
        addIssueToContext(ctx, arg);
        if (arg.fatal) {
          status.abort();
        } else {
          status.dirty();
        }
      },
      get path() {
        return ctx.path;
      }
    };
    checkCtx.addIssue = checkCtx.addIssue.bind(checkCtx);
    if (effect.type === "preprocess") {
      const processed = effect.transform(ctx.data, checkCtx);
      if (ctx.common.async) {
        return Promise.resolve(processed).then(async (processed) => {
          if (status.value === "aborted")
            return INVALID;
          const result = await this._def.schema._parseAsync({
            data: processed,
            path: ctx.path,
            parent: ctx
          });
          if (result.status === "aborted")
            return INVALID;
          if (result.status === "dirty")
            return DIRTY(result.value);
          if (status.value === "dirty")
            return DIRTY(result.value);
          return result;
        });
      } else {
        if (status.value === "aborted")
          return INVALID;
        const result = this._def.schema._parseSync({
          data: processed,
          path: ctx.path,
          parent: ctx
        });
        if (result.status === "aborted")
          return INVALID;
        if (result.status === "dirty")
          return DIRTY(result.value);
        if (status.value === "dirty")
          return DIRTY(result.value);
        return result;
      }
    }
    if (effect.type === "refinement") {
      const executeRefinement = (acc) => {
        const result = effect.refinement(acc, checkCtx);
        if (ctx.common.async) {
          return Promise.resolve(result);
        }
        if (result instanceof Promise) {
          throw new Error("Async refinement encountered during synchronous parse operation. Use .parseAsync instead.");
        }
        return acc;
      };
      if (ctx.common.async === false) {
        const inner = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inner.status === "aborted")
          return INVALID;
        if (inner.status === "dirty")
          status.dirty();
        executeRefinement(inner.value);
        return { status: status.value, value: inner.value };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((inner) => {
          if (inner.status === "aborted")
            return INVALID;
          if (inner.status === "dirty")
            status.dirty();
          return executeRefinement(inner.value).then(() => {
            return { status: status.value, value: inner.value };
          });
        });
      }
    }
    if (effect.type === "transform") {
      if (ctx.common.async === false) {
        const base = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (!isValid(base))
          return INVALID;
        const result = effect.transform(base.value, checkCtx);
        if (result instanceof Promise) {
          throw new Error(`Asynchronous transform encountered during synchronous parse operation. Use .parseAsync instead.`);
        }
        return { status: status.value, value: result };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((base) => {
          if (!isValid(base))
            return INVALID;
          return Promise.resolve(effect.transform(base.value, checkCtx)).then((result) => ({
            status: status.value,
            value: result
          }));
        });
      }
    }
    util.assertNever(effect);
  }
}
ZodEffects.create = (schema, effect, params) => {
  return new ZodEffects({
    schema,
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    effect,
    ...processCreateParams(params)
  });
};
ZodEffects.createWithPreprocess = (preprocess, schema, params) => {
  return new ZodEffects({
    schema,
    effect: { type: "preprocess", transform: preprocess },
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    ...processCreateParams(params)
  });
};
class ZodOptional extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.undefined) {
      return OK(undefined);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
}
ZodOptional.create = (type, params) => {
  return new ZodOptional({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodOptional,
    ...processCreateParams(params)
  });
};

class ZodNullable extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.null) {
      return OK(null);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
}
ZodNullable.create = (type, params) => {
  return new ZodNullable({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodNullable,
    ...processCreateParams(params)
  });
};

class ZodDefault extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    let data = ctx.data;
    if (ctx.parsedType === ZodParsedType.undefined) {
      data = this._def.defaultValue();
    }
    return this._def.innerType._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  removeDefault() {
    return this._def.innerType;
  }
}
ZodDefault.create = (type, params) => {
  return new ZodDefault({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodDefault,
    defaultValue: typeof params.default === "function" ? params.default : () => params.default,
    ...processCreateParams(params)
  });
};

class ZodCatch extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const newCtx = {
      ...ctx,
      common: {
        ...ctx.common,
        issues: []
      }
    };
    const result = this._def.innerType._parse({
      data: newCtx.data,
      path: newCtx.path,
      parent: {
        ...newCtx
      }
    });
    if (isAsync(result)) {
      return result.then((result) => {
        return {
          status: "valid",
          value: result.status === "valid" ? result.value : this._def.catchValue({
            get error() {
              return new ZodError(newCtx.common.issues);
            },
            input: newCtx.data
          })
        };
      });
    } else {
      return {
        status: "valid",
        value: result.status === "valid" ? result.value : this._def.catchValue({
          get error() {
            return new ZodError(newCtx.common.issues);
          },
          input: newCtx.data
        })
      };
    }
  }
  removeCatch() {
    return this._def.innerType;
  }
}
ZodCatch.create = (type, params) => {
  return new ZodCatch({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodCatch,
    catchValue: typeof params.catch === "function" ? params.catch : () => params.catch,
    ...processCreateParams(params)
  });
};

class ZodNaN extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.nan) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.nan,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
}
ZodNaN.create = (params) => {
  return new ZodNaN({
    typeName: ZodFirstPartyTypeKind.ZodNaN,
    ...processCreateParams(params)
  });
};
var BRAND = Symbol("zod_brand");

class ZodBranded extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const data = ctx.data;
    return this._def.type._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  unwrap() {
    return this._def.type;
  }
}

class ZodPipeline extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.common.async) {
      const handleAsync = async () => {
        const inResult = await this._def.in._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inResult.status === "aborted")
          return INVALID;
        if (inResult.status === "dirty") {
          status.dirty();
          return DIRTY(inResult.value);
        } else {
          return this._def.out._parseAsync({
            data: inResult.value,
            path: ctx.path,
            parent: ctx
          });
        }
      };
      return handleAsync();
    } else {
      const inResult = this._def.in._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
      if (inResult.status === "aborted")
        return INVALID;
      if (inResult.status === "dirty") {
        status.dirty();
        return {
          status: "dirty",
          value: inResult.value
        };
      } else {
        return this._def.out._parseSync({
          data: inResult.value,
          path: ctx.path,
          parent: ctx
        });
      }
    }
  }
  static create(a, b) {
    return new ZodPipeline({
      in: a,
      out: b,
      typeName: ZodFirstPartyTypeKind.ZodPipeline
    });
  }
}

class ZodReadonly extends ZodType {
  _parse(input) {
    const result = this._def.innerType._parse(input);
    const freeze = (data) => {
      if (isValid(data)) {
        data.value = Object.freeze(data.value);
      }
      return data;
    };
    return isAsync(result) ? result.then((data) => freeze(data)) : freeze(result);
  }
  unwrap() {
    return this._def.innerType;
  }
}
ZodReadonly.create = (type, params) => {
  return new ZodReadonly({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodReadonly,
    ...processCreateParams(params)
  });
};
var late = {
  object: ZodObject.lazycreate
};
var ZodFirstPartyTypeKind;
(function(ZodFirstPartyTypeKind) {
  ZodFirstPartyTypeKind["ZodString"] = "ZodString";
  ZodFirstPartyTypeKind["ZodNumber"] = "ZodNumber";
  ZodFirstPartyTypeKind["ZodNaN"] = "ZodNaN";
  ZodFirstPartyTypeKind["ZodBigInt"] = "ZodBigInt";
  ZodFirstPartyTypeKind["ZodBoolean"] = "ZodBoolean";
  ZodFirstPartyTypeKind["ZodDate"] = "ZodDate";
  ZodFirstPartyTypeKind["ZodSymbol"] = "ZodSymbol";
  ZodFirstPartyTypeKind["ZodUndefined"] = "ZodUndefined";
  ZodFirstPartyTypeKind["ZodNull"] = "ZodNull";
  ZodFirstPartyTypeKind["ZodAny"] = "ZodAny";
  ZodFirstPartyTypeKind["ZodUnknown"] = "ZodUnknown";
  ZodFirstPartyTypeKind["ZodNever"] = "ZodNever";
  ZodFirstPartyTypeKind["ZodVoid"] = "ZodVoid";
  ZodFirstPartyTypeKind["ZodArray"] = "ZodArray";
  ZodFirstPartyTypeKind["ZodObject"] = "ZodObject";
  ZodFirstPartyTypeKind["ZodUnion"] = "ZodUnion";
  ZodFirstPartyTypeKind["ZodDiscriminatedUnion"] = "ZodDiscriminatedUnion";
  ZodFirstPartyTypeKind["ZodIntersection"] = "ZodIntersection";
  ZodFirstPartyTypeKind["ZodTuple"] = "ZodTuple";
  ZodFirstPartyTypeKind["ZodRecord"] = "ZodRecord";
  ZodFirstPartyTypeKind["ZodMap"] = "ZodMap";
  ZodFirstPartyTypeKind["ZodSet"] = "ZodSet";
  ZodFirstPartyTypeKind["ZodFunction"] = "ZodFunction";
  ZodFirstPartyTypeKind["ZodLazy"] = "ZodLazy";
  ZodFirstPartyTypeKind["ZodLiteral"] = "ZodLiteral";
  ZodFirstPartyTypeKind["ZodEnum"] = "ZodEnum";
  ZodFirstPartyTypeKind["ZodEffects"] = "ZodEffects";
  ZodFirstPartyTypeKind["ZodNativeEnum"] = "ZodNativeEnum";
  ZodFirstPartyTypeKind["ZodOptional"] = "ZodOptional";
  ZodFirstPartyTypeKind["ZodNullable"] = "ZodNullable";
  ZodFirstPartyTypeKind["ZodDefault"] = "ZodDefault";
  ZodFirstPartyTypeKind["ZodCatch"] = "ZodCatch";
  ZodFirstPartyTypeKind["ZodPromise"] = "ZodPromise";
  ZodFirstPartyTypeKind["ZodBranded"] = "ZodBranded";
  ZodFirstPartyTypeKind["ZodPipeline"] = "ZodPipeline";
  ZodFirstPartyTypeKind["ZodReadonly"] = "ZodReadonly";
})(ZodFirstPartyTypeKind || (ZodFirstPartyTypeKind = {}));
var stringType = ZodString.create;
var numberType = ZodNumber.create;
var nanType = ZodNaN.create;
var bigIntType = ZodBigInt.create;
var booleanType = ZodBoolean.create;
var dateType = ZodDate.create;
var symbolType = ZodSymbol.create;
var undefinedType = ZodUndefined.create;
var nullType = ZodNull.create;
var anyType = ZodAny.create;
var unknownType = ZodUnknown.create;
var neverType = ZodNever.create;
var voidType = ZodVoid.create;
var arrayType = ZodArray.create;
var objectType = ZodObject.create;
var strictObjectType = ZodObject.strictCreate;
var unionType = ZodUnion.create;
var discriminatedUnionType = ZodDiscriminatedUnion.create;
var intersectionType = ZodIntersection.create;
var tupleType = ZodTuple.create;
var recordType = ZodRecord.create;
var mapType = ZodMap.create;
var setType = ZodSet.create;
var functionType = ZodFunction.create;
var lazyType = ZodLazy.create;
var literalType = ZodLiteral.create;
var enumType = ZodEnum.create;
var nativeEnumType = ZodNativeEnum.create;
var promiseType = ZodPromise.create;
var effectsType = ZodEffects.create;
var optionalType = ZodOptional.create;
var nullableType = ZodNullable.create;
var preprocessType = ZodEffects.createWithPreprocess;
var pipelineType = ZodPipeline.create;
var coerce = {
  string: (arg) => ZodString.create({ ...arg, coerce: true }),
  number: (arg) => ZodNumber.create({ ...arg, coerce: true }),
  boolean: (arg) => ZodBoolean.create({
    ...arg,
    coerce: true
  }),
  bigint: (arg) => ZodBigInt.create({ ...arg, coerce: true }),
  date: (arg) => ZodDate.create({ ...arg, coerce: true })
};
var NEVER = INVALID;
// server/src/db/client.ts
var {SQL } = globalThis.Bun;
var ROLE_SQL = {
  public: "altiora_public",
  kitchen: "altiora_kitchen",
  waiter: "altiora_waiter",
  manager: "altiora_manager",
  platform: "altiora_platform"
};
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var CODE_RE = /^[A-Za-z0-9_-]{16,64}$/;
var SETTINGS = {
  restaurantId: { name: "app.restaurant_id", check: (v) => UUID_RE.test(v) },
  userId: { name: "app.user_id", check: (v) => UUID_RE.test(v) },
  tableId: { name: "app.table_id", check: (v) => UUID_RE.test(v) },
  tableSessionId: { name: "app.table_session_id", check: (v) => UUID_RE.test(v) },
  publicCode: { name: "app.public_code", check: (v) => CODE_RE.test(v) },
  reason: { name: "app.reason", check: (v) => v.length <= 300 }
};
function wrap(raw, role) {
  const tx = (strings, ...values) => raw(strings, ...values);
  tx.unsafe = (query, params) => raw.unsafe(query, params);
  tx.setContext = async (patch) => {
    const names = [];
    const values = [];
    for (const key of Object.keys(SETTINGS)) {
      if (!(key in patch))
        continue;
      const v = patch[key];
      const text = v === null || v === undefined ? "" : String(v);
      if (text !== "" && !SETTINGS[key].check(text))
        throw new Error(`Contexto inv\xE1lido: ${key}`);
      names.push(SETTINGS[key].name);
      values.push(text);
    }
    if (!names.length)
      return;
    const sql = "SELECT " + names.map((n, i) => `set_config('${n}', $${i + 1}, true)`).join(", ");
    await raw.unsafe(sql, values);
  };
  Object.defineProperty(tx, "role", { value: role, enumerable: true });
  return tx;
}
var RETRYABLE_SQLSTATE = new Set(["40001", "40P01"]);
var MAX_RETRIES = 3;

class Database {
  sql;
  timeoutMs;
  constructor(url, opts = {}) {
    this.timeoutMs = opts.statementTimeoutMs ?? 1e4;
    const options = { url, max: opts.max ?? 10, idleTimeout: 30, connectionTimeout: 15, maxLifetime: 1800 };
    if (opts.ssl === "require")
      options.tls = true;
    if (opts.ssl === "disable")
      options.tls = false;
    if (opts.prepare === false)
      options.prepare = false;
    this.sql = new SQL(options);
  }
  async retrying(run) {
    for (let attempt = 0;; attempt++) {
      try {
        return await run();
      } catch (err) {
        const code = pgCode(err);
        if (code && RETRYABLE_SQLSTATE.has(code) && attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, 15 + Math.random() * 45 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
  }
  async system(fn) {
    return this.retrying(() => this.sql.begin(async (raw) => {
      await raw.unsafe(`SET LOCAL search_path TO altiora, pg_temp; SET LOCAL statement_timeout = ${this.timeoutMs}`);
      return fn(wrap(raw, "system"));
    }));
  }
  async as(ctx, fn) {
    const role = ROLE_SQL[ctx.role];
    if (!role)
      throw new Error(`Perfil desconhecido: ${String(ctx.role)}`);
    return this.retrying(() => this.sql.begin(async (raw) => {
      await raw.unsafe(`SET LOCAL search_path TO altiora, pg_temp; SET LOCAL ROLE ${role}; SET LOCAL statement_timeout = ${this.timeoutMs}`);
      const tx = wrap(raw, ctx.role);
      const { role: _ignored, ...patch } = ctx;
      await tx.setContext(patch);
      await raw.unsafe(`SELECT set_config('app.role', $1, true)`, [ctx.role]);
      return fn(tx);
    }));
  }
  lastPingError = null;
  async ping() {
    try {
      await this.sql.unsafe("SELECT 1");
      this.lastPingError = null;
      return true;
    } catch (err) {
      this.lastPingError = describeDbFailure(err);
      return false;
    }
  }
  async selfTest() {
    const problems = [];
    try {
      await this.system(async (tx) => {
        const tables = await tx`
          SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'altiora' AND c.relkind = 'r'`;
        if (tables.length < 14)
          problems.push("Faltam tabelas do esquema altiora (as migra\xE7\xF5es foram aplicadas?).");
        for (const t of tables)
          if (!t.relrowsecurity)
            problems.push(`RLS desligado na tabela ${t.relname}.`);
      });
      for (const role of Object.keys(ROLE_SQL)) {
        await this.as({ role }, async (tx) => {
          const [r] = await tx`
            SELECT current_user::text AS u,
                   (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) AS bypass`;
          if (r?.u !== ROLE_SQL[role])
            problems.push(`A mudan\xE7a para o perfil ${ROLE_SQL[role]} n\xE3o funcionou.`);
          if (r?.bypass)
            problems.push(`O perfil ${ROLE_SQL[role]} ignora o RLS.`);
        });
      }
      const denied = await this.as({ role: "manager" }, (tx) => tx`SELECT 1 FROM users LIMIT 1`).then(() => false, () => true);
      if (!denied)
        problems.push("O perfil do gerente consegue ler a tabela de utilizadores.");
    } catch (err) {
      problems.push(`N\xE3o foi poss\xEDvel verificar a base de dados: ${err.message}`);
    }
    return { ok: problems.length === 0, problems };
  }
  async close() {
    await this.sql.close();
  }
}
function describeDbFailure(err) {
  const e = err;
  const code = e && typeof e.code === "string" ? e.code : "";
  let message = e && typeof e.message === "string" ? e.message : String(err);
  message = message.replace(/(postgres(?:ql)?:\/\/[^:\s/@]*:)[^@\s]*@/gi, "$1***@").replace(/\s+/g, " ").trim();
  return (code ? `${code}: ` : "") + message.slice(0, 240);
}
function pgCode(err) {
  const e = err;
  return e && typeof e.errno === "string" && /^[0-9A-Z]{5}$/.test(e.errno) ? e.errno : null;
}
function pgConstraint(err) {
  const e = err;
  return e && typeof e.constraint === "string" ? e.constraint : null;
}
async function lockIdempotencyKey(tx, restaurantId, key) {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${restaurantId}::text || ':' || ${key}::text, 0))`;
}
async function lockTableOrdering(tx, tableId) {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${tableId}::text, 1))`;
}
var num = (v) => v === null || v === undefined ? 0 : Number(v);
var iso = (v) => v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();

// server/src/lib/zod-pt.ts
var TYPES = {
  string: "texto",
  number: "n\xFAmero",
  integer: "n\xFAmero inteiro",
  boolean: "verdadeiro/falso",
  array: "lista",
  object: "objeto",
  date: "data"
};
var ptErrorMap = (issue, ctx) => {
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      if (issue.received === "undefined" || issue.received === "null")
        return { message: "Campo obrigat\xF3rio." };
      return { message: `Valor inv\xE1lido: era esperado ${TYPES[issue.expected] ?? issue.expected}.` };
    case ZodIssueCode.too_small:
      if (issue.type === "string")
        return { message: issue.minimum === 1 ? "Campo obrigat\xF3rio." : `Tem de ter pelo menos ${issue.minimum} caracteres.` };
      if (issue.type === "array")
        return { message: `Indique pelo menos ${issue.minimum} elemento(s).` };
      return { message: `O valor m\xEDnimo \xE9 ${issue.minimum}.` };
    case ZodIssueCode.too_big:
      if (issue.type === "string")
        return { message: `Pode ter no m\xE1ximo ${issue.maximum} caracteres.` };
      if (issue.type === "array")
        return { message: `Indique no m\xE1ximo ${issue.maximum} elemento(s).` };
      return { message: `O valor m\xE1ximo \xE9 ${issue.maximum}.` };
    case ZodIssueCode.invalid_string:
      if (issue.validation === "email")
        return { message: "E-mail inv\xE1lido." };
      if (issue.validation === "uuid")
        return { message: "Identificador inv\xE1lido." };
      if (issue.validation === "url")
        return { message: "Endere\xE7o inv\xE1lido." };
      return { message: "Formato inv\xE1lido." };
    case ZodIssueCode.invalid_enum_value:
      return { message: `Valor inv\xE1lido. Op\xE7\xF5es: ${issue.options.join(", ")}.` };
    case ZodIssueCode.unrecognized_keys:
      return { message: `Campos n\xE3o permitidos: ${issue.keys.join(", ")}.` };
    case ZodIssueCode.invalid_union:
      return { message: "Valor inv\xE1lido." };
    default:
      return { message: ctx.defaultError };
  }
};
var installed = false;
function installZodPt() {
  if (installed)
    return;
  setErrorMap(ptErrorMap);
  installed = true;
}
function zodDetails(err) {
  return err.issues.slice(0, 20).map((i) => ({ field: i.path.join(".") || "(corpo)", message: i.message }));
}

// server/src/http/errors-map.ts
var CONSTRAINT_MESSAGES = {
  restaurant_tables_number_uq: "J\xE1 existe uma mesa com este n\xFAmero.",
  categories_name_uq: "J\xE1 existe uma categoria com este nome.",
  users_email_uq: "J\xE1 existe uma conta com este e-mail.",
  restaurants_slug_uq: "Este endere\xE7o (slug) j\xE1 est\xE1 em uso.",
  restaurant_members_uq: "Esta pessoa j\xE1 faz parte da equipa.",
  orders_idem_uq: "Este pedido j\xE1 foi enviado."
};
function mapError(err) {
  if (err instanceof HttpError)
    return { error: err, serverFault: err.status >= 500 };
  if (err instanceof ZodError) {
    return { error: new HttpError(400, "VALIDATION_ERROR", "Dados inv\xE1lidos.", zodDetails(err)), serverFault: false };
  }
  const code = pgCode(err);
  if (code) {
    const constraint = pgConstraint(err);
    switch (code) {
      case "AL001":
        return { error: new HttpError(409, "INVALID_TRANSITION", "Esta altera\xE7\xE3o de estado n\xE3o \xE9 permitida."), serverFault: false };
      case "AL002":
        return { error: new HttpError(422, "REASON_REQUIRED", "Indique o motivo desta altera\xE7\xE3o."), serverFault: false };
      case "AL003":
        return { error: new HttpError(409, "ORDER_IMMUTABLE", "Os dados de um pedido n\xE3o podem ser alterados."), serverFault: false };
      case "AL004":
        return { error: new HttpError(404, "RESTAURANT_NOT_FOUND", "Restaurante n\xE3o encontrado."), serverFault: false };
      case "AL005":
        return { error: new HttpError(422, "INVALID_TIMEZONE", "Fuso hor\xE1rio inv\xE1lido (exemplo: Africa/Luanda)."), serverFault: false };
      case "AL006":
        return { error: new HttpError(404, "TABLE_NOT_FOUND", "Mesa n\xE3o encontrada."), serverFault: false };
      case "23505":
        return {
          error: new HttpError(409, "DUPLICATE", constraint && CONSTRAINT_MESSAGES[constraint] || "J\xE1 existe um registo com estes dados."),
          serverFault: false
        };
      case "23503":
        return { error: new HttpError(409, "REFERENCE_CONFLICT", "Esta opera\xE7\xE3o n\xE3o \xE9 poss\xEDvel porque existem dados associados."), serverFault: false };
      case "23514":
      case "23502":
      case "22001":
      case "22003":
        return { error: new HttpError(422, "INVALID_DATA", "Os dados indicados n\xE3o s\xE3o v\xE1lidos."), serverFault: false };
      case "22P02":
      case "22007":
      case "22008":
      case "22021":
        return { error: new HttpError(400, "BAD_REQUEST", "Pedido inv\xE1lido."), serverFault: false };
      case "42501":
        return { error: new HttpError(403, "FORBIDDEN", "N\xE3o tem permiss\xE3o para esta opera\xE7\xE3o."), serverFault: true };
      case "57014":
        return { error: new HttpError(503, "DB_TIMEOUT", "O servidor est\xE1 ocupado. Tente novamente dentro de instantes.", undefined, { "retry-after": "3" }), serverFault: true };
      case "40001":
      case "40P01":
        return { error: new HttpError(503, "DB_CONFLICT", "Opera\xE7\xE3o em conflito. Tente novamente.", undefined, { "retry-after": "1" }), serverFault: false };
      default:
        break;
    }
  }
  const e = err;
  const sysCode = e && typeof e.code === "string" ? e.code : "";
  if (!code && (sysCode.startsWith("ERR_POSTGRES_") || ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EPIPE"].includes(sysCode))) {
    return { error: new HttpError(503, "DB_UNAVAILABLE", "O servi\xE7o est\xE1 temporariamente indispon\xEDvel. Tente novamente dentro de instantes.", undefined, { "retry-after": "5" }), serverFault: true };
  }
  return { error: new HttpError(500, "INTERNAL_ERROR", "Ocorreu um erro inesperado. Tente novamente."), serverFault: true };
}

// server/src/http/router.ts
class Router {
  routes = [];
  add(spec) {
    const keys = [];
    const pattern = spec.path.split("/").map((seg) => {
      if (seg.startsWith(":")) {
        keys.push(seg.slice(1));
        return "([^/]+)";
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }).join("/");
    this.routes.push({ spec, regex: new RegExp(`^${pattern}/?$`), keys });
  }
  addAll(specs) {
    for (const s of specs)
      this.add(s);
  }
  match(method, pathname) {
    const effective = method === "HEAD" ? "GET" : method;
    const allow = new Set;
    for (const r of this.routes) {
      const m = r.regex.exec(pathname);
      if (!m)
        continue;
      if (r.spec.method === effective) {
        const params = {};
        r.keys.forEach((k, i) => {
          try {
            params[k] = decodeURIComponent(m[i + 1]);
          } catch {
            params[k] = m[i + 1];
          }
        });
        return { kind: "ok", route: r.spec, params };
      }
      allow.add(r.spec.method);
    }
    return allow.size ? { kind: "method", allow: [...allow] } : { kind: "none" };
  }
  list() {
    return this.routes.map((r) => r.spec);
  }
}

// server/src/http/security.ts
var HTML_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' blob: data:",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'"
].join("; ");
var API_CSP = "default-src 'none'; frame-ancestors 'none'";
function applySecurityHeaders(res, opts) {
  const h = res.headers;
  const setDefault = (k, v) => {
    if (!h.has(k))
      h.set(k, v);
  };
  setDefault("x-content-type-options", "nosniff");
  setDefault("referrer-policy", "no-referrer");
  setDefault("x-frame-options", opts.isApi ? "DENY" : "SAMEORIGIN");
  setDefault("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  setDefault("cross-origin-opener-policy", "same-origin");
  setDefault("cross-origin-resource-policy", "same-origin");
  setDefault("content-security-policy", opts.isApi ? API_CSP : HTML_CSP);
  if (opts.isProd)
    setDefault("strict-transport-security", "max-age=31536000; includeSubDomains");
}
function buildOriginPolicy(publicBaseUrl, extra) {
  return { allowed: new Set([publicBaseUrl, ...extra]) };
}
function hostOf(origin) {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}
function isAllowedOrigin(origin, requestUrl, policy) {
  if (policy.allowed.has(origin))
    return true;
  return hostOf(origin) === requestUrl.host;
}
function assertSameOrigin(req, requestUrl, policy) {
  const origin = req.headers.get("origin");
  if (origin) {
    if (!isAllowedOrigin(origin, requestUrl, policy))
      throw forbidden("Origem do pedido n\xE3o autorizada.", "ORIGIN_NOT_ALLOWED");
    return;
  }
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none")
    throw forbidden("Origem do pedido n\xE3o autorizada.", "ORIGIN_NOT_ALLOWED");
}
var CORS_METHODS = "GET, POST, PATCH, PUT, DELETE, OPTIONS";
var CORS_HEADERS = "Content-Type, Idempotency-Key";
function corsHeaders(req, requestUrl, policy) {
  const origin = req.headers.get("origin");
  if (!origin || !policy.allowed.has(origin) || hostOf(origin) === requestUrl.host)
    return null;
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    vary: "Origin"
  };
}
function preflightResponse(req, requestUrl, policy) {
  const cors = corsHeaders(req, requestUrl, policy);
  if (!cors)
    return new Response(null, { status: 204 });
  return new Response(null, {
    status: 204,
    headers: {
      ...cors,
      "access-control-allow-methods": CORS_METHODS,
      "access-control-allow-headers": CORS_HEADERS,
      "access-control-max-age": "600"
    }
  });
}

// server/src/http/static.ts
import { readFile, stat } from "fs/promises";
import { extname, join, normalize, resolve, sep } from "path";
var TYPES2 = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8"
};
var cache = new Map;
async function readOptional(path) {
  try {
    return new Uint8Array(await readFile(path));
  } catch {
    return;
  }
}
async function load(path) {
  let st;
  try {
    st = await stat(path);
  } catch {
    return null;
  }
  if (!st.isFile())
    return null;
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === st.mtimeMs)
    return hit;
  const entry = {
    mtimeMs: st.mtimeMs,
    body: new Uint8Array(await readFile(path)),
    br: await readOptional(path + ".br"),
    gz: await readOptional(path + ".gz")
  };
  if (cache.size > 500)
    cache.clear();
  cache.set(path, entry);
  return entry;
}
function cacheControl(rel) {
  if (rel.startsWith("/assets/"))
    return "public, max-age=31536000, immutable";
  if (rel === "/index.html")
    return "no-cache";
  return "public, max-age=3600";
}
async function serveStatic(req, url, webDir) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("M\xE9todo n\xE3o permitido", { status: 405, headers: { allow: "GET, HEAD" } });
  }
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return new Response("Pedido inv\xE1lido", { status: 400 });
  }
  if (pathname.includes("\x00"))
    return new Response("Pedido inv\xE1lido", { status: 400 });
  const root = resolve(webDir);
  const rel = normalize(pathname).replace(/\\/g, "/");
  let target = resolve(join(root, rel));
  if (target !== root && !target.startsWith(root + sep))
    return new Response("N\xE3o encontrado", { status: 404 });
  let relPath = rel === "/" ? "/index.html" : rel;
  let entry = await load(target === root ? join(root, "index.html") : target);
  if (!entry) {
    if (extname(rel) !== "")
      return new Response("N\xE3o encontrado", { status: 404 });
    relPath = "/index.html";
    target = join(root, "index.html");
    entry = await load(target);
    if (!entry)
      return new Response("A aplica\xE7\xE3o web ainda n\xE3o foi constru\xEDda (execute: bun run build).", { status: 503 });
  }
  const ext = extname(relPath === "/index.html" ? "x.html" : target);
  const headers = {
    "content-type": TYPES2[ext] ?? "application/octet-stream",
    "cache-control": cacheControl(relPath),
    vary: "Accept-Encoding"
  };
  const accept = req.headers.get("accept-encoding") ?? "";
  let body = entry.body;
  if (entry.br && /\bbr\b/.test(accept)) {
    body = entry.br;
    headers["content-encoding"] = "br";
  } else if (entry.gz && /\bgzip\b/.test(accept)) {
    body = entry.gz;
    headers["content-encoding"] = "gzip";
  }
  headers["content-length"] = String(body.byteLength);
  return new Response(req.method === "HEAD" ? null : body, { status: 200, headers });
}

// shared/allergens.ts
var ALLERGENS = [
  { code: "gluten", label: "Gl\xFAten" },
  { code: "crustaceos", label: "Crust\xE1ceos" },
  { code: "ovos", label: "Ovos" },
  { code: "peixe", label: "Peixe" },
  { code: "amendoim", label: "Amendoim" },
  { code: "soja", label: "Soja" },
  { code: "leite", label: "Leite" },
  { code: "frutos_casca_rija", label: "Frutos de casca rija" },
  { code: "aipo", label: "Aipo" },
  { code: "mostarda", label: "Mostarda" },
  { code: "sesamo", label: "S\xE9samo" },
  { code: "sulfitos", label: "Sulfitos" },
  { code: "tremoco", label: "Tremo\xE7o" },
  { code: "moluscos", label: "Moluscos" }
];
var ALLERGEN_CODES = ALLERGENS.map((a) => a.code);
var allergenLabel = (code) => ALLERGENS.find((a) => a.code === code)?.label ?? code;

// shared/hours.ts
var WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
var TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
var isTime = (v) => typeof v === "string" && TIME.test(v);
function parseHours(value) {
  const out = {};
  if (!value || typeof value !== "object")
    return out;
  for (const day of WEEKDAYS) {
    const raw = value[day];
    if (!Array.isArray(raw))
      continue;
    const ranges = [];
    for (const r of raw.slice(0, 3)) {
      if (Array.isArray(r) && isTime(r[0]) && isTime(r[1]) && r[0] !== r[1])
        ranges.push([r[0], r[1]]);
    }
    if (ranges.length)
      out[day] = ranges;
  }
  return out;
}

// shared/plans.ts
var FEATURE_KEYS = [
  "menu",
  "qr_codes",
  "basic_products",
  "orders",
  "whatsapp_orders",
  "tables",
  "stats",
  "advanced_branding",
  "exclusive_branding",
  "model_3d",
  "ar",
  "advanced_management"
];
var FEATURES = {
  menu: { key: "menu", label: "Card\xE1pio digital interativo", description: "Menu com categorias, fotografias, pesquisa instant\xE2nea e filtros." },
  qr_codes: { key: "qr_codes", label: "QR Code do restaurante em PDF", description: "QR Code personalizado, pronto para imprimir em PDF." },
  basic_products: { key: "basic_products", label: "Gest\xE3o de produtos", description: "Criar, editar, ativar e desativar pratos, categorias e pre\xE7os." },
  orders: { key: "orders", label: "Pedidos digitais", description: "O cliente pede pelo telem\xF3vel e a cozinha e os empregados recebem em tempo real." },
  whatsapp_orders: { key: "whatsapp_orders", label: "Pedidos por WhatsApp", description: "O cliente envia o pedido j\xE1 escrito para o WhatsApp do restaurante." },
  tables: { key: "tables", label: "Gest\xE3o de mesas", description: "Um QR Code por mesa, que identifica a mesa em cada pedido." },
  stats: { key: "stats", label: "Estat\xEDsticas", description: "Vendas, produtos mais vendidos e relat\xF3rios por per\xEDodo." },
  advanced_branding: { key: "advanced_branding", label: "Personaliza\xE7\xE3o avan\xE7ada", description: "Cor e tema (claro ou escuro) do restaurante." },
  exclusive_branding: { key: "exclusive_branding", label: "Personaliza\xE7\xE3o exclusiva", description: "Menu sem a marca Altiora e escolha do estilo de letra do restaurante." },
  model_3d: { key: "model_3d", label: "Pratos em 3D", description: "Modelos 3D que o cliente roda e amplia com o dedo." },
  ar: { key: "ar", label: "Realidade aumentada", description: "O cliente v\xEA o prato na sua mesa atrav\xE9s do telem\xF3vel (aparelhos compat\xEDveis)." },
  advanced_management: { key: "advanced_management", label: "Gest\xE3o avan\xE7ada", description: "Exporta\xE7\xE3o de relat\xF3rios em CSV e registo de atividade da equipa." }
};
var isFeatureKey = (v) => typeof v === "string" && FEATURE_KEYS.includes(v);
var STARTER = ["menu", "qr_codes", "basic_products"];
var PRO = [...STARTER, "orders", "whatsapp_orders", "tables", "stats", "advanced_branding"];
var PREMIUM = [...PRO, "exclusive_branding", "model_3d", "ar", "advanced_management"];
var DEFAULT_PLANS = [
  { code: "starter", name: "Starter", tagline: "O card\xE1pio digital do seu restaurante, com QR Code.", display_order: 1, highlighted: false, features: STARTER },
  { code: "pro", name: "Pro", tagline: "Pedidos digitais, mesas e estat\xEDsticas.", display_order: 2, highlighted: true, features: PRO },
  { code: "premium", name: "Premium", tagline: "Pratos em 3D, realidade aumentada e personaliza\xE7\xE3o exclusiva.", display_order: 3, highlighted: false, features: PREMIUM }
];
var CURRENCIES = ["AOA", "USD", "EUR", "BRL", "MZN", "CVE", "ZAR", "GBP"];

// shared/payments.ts
var PAYMENT_METHODS = ["dinheiro", "terminal", "transferencia", "outro"];
var METHOD_LABEL = {
  dinheiro: "Dinheiro",
  terminal: "Terminal de pagamento",
  transferencia: "Transfer\xEAncia",
  outro: "Outro"
};
function summarizePayments(totalCents, payments) {
  let paid = 0;
  let refunded = 0;
  let exempt = false;
  for (const p of payments) {
    if (p.status === "pago")
      paid += p.amount_cents;
    else if (p.status === "reembolsado")
      refunded += p.amount_cents;
    else if (p.status === "isento")
      exempt = true;
  }
  if (exempt)
    return { state: "isento", paid_cents: paid, due_cents: 0 };
  const due = Math.max(totalCents - paid, 0);
  let state;
  if (totalCents > 0 && paid >= totalCents)
    state = "pago";
  else if (paid > 0)
    state = "parcial";
  else if (refunded > 0)
    state = "reembolsado";
  else
    state = "pendente";
  return { state, paid_cents: paid, due_cents: due };
}

// shared/status.ts
var ORDER_STATUSES = ["novo", "em_preparacao", "pronto", "entregue", "cancelado"];
var ACTIVE_STATUSES = ["novo", "em_preparacao", "pronto"];
var STATUS_LABEL = {
  novo: "Novo",
  em_preparacao: "Em prepara\xE7\xE3o",
  pronto: "Pronto",
  entregue: "Entregue",
  cancelado: "Cancelado"
};
function isOrderStatus(v) {
  return typeof v === "string" && ORDER_STATUSES.includes(v);
}
var CORRECTIONS = [
  ["em_preparacao", "novo"],
  ["pronto", "em_preparacao"],
  ["entregue", "pronto"],
  ["cancelado", "novo"]
];
function canTransition(role, from, to) {
  if (from === to)
    return false;
  if (role === "system")
    return true;
  if ((role === "kitchen" || role === "manager") && from === "novo" && to === "em_preparacao")
    return true;
  if ((role === "kitchen" || role === "manager") && from === "em_preparacao" && to === "pronto")
    return true;
  if ((role === "waiter" || role === "manager") && from === "pronto" && to === "entregue")
    return true;
  if (role === "manager" && to === "cancelado" && (from === "novo" || from === "em_preparacao" || from === "pronto"))
    return true;
  if (role === "manager" && CORRECTIONS.some(([f, t]) => f === from && t === to))
    return true;
  return false;
}
function transitionNeedsReason(from, to) {
  return to === "cancelado" || CORRECTIONS.some(([f, t]) => f === from && t === to);
}

// shared/schemas.ts
var uuid = stringType().uuid();
var noNul = (s) => !s.includes("\x00");
var NUL_MESSAGE = "O texto cont\xE9m caracteres inv\xE1lidos.";
var text = (max, min = 1) => stringType().trim().min(min).max(max).refine(noNul, NUL_MESSAGE);
var optionalText = (max) => stringType().trim().max(max).refine(noNul, NUL_MESSAGE).nullish().transform((v) => v ? v : null);
var urlOrPath = stringType().trim().max(500).regex(/^(https:\/\/[^\s\u0000]+|\/[^\s/\u0000][^\s\u0000]*)$/, "Use um endere\xE7o que comece por https://");
var optionalUrl = unionType([urlOrPath, literalType(""), nullType()]).optional().transform((v) => v ? v : null);
var assetPath = unionType([stringType().trim().regex(/^\/a\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "Ficheiro inv\xE1lido."), literalType(""), nullType()]).optional().transform((v) => v ? v : null);
var ingredients = arrayType(text(60)).max(30, "No m\xE1ximo 30 ingredientes.").transform((list) => Array.from(new Set(list.map((s) => s.trim()))));
var allergens = arrayType(stringType()).max(14).refine((list) => list.every((c) => ALLERGEN_CODES.includes(c)), "Alerg\xE9nio desconhecido.").transform((list) => Array.from(new Set(list)));
var phoneDigits = unionType([stringType().trim().max(40), nullType()]).optional().transform((v, ctx) => {
  if (!v)
    return null;
  const digits = v.replace(/[\s().+-]/g, "");
  if (!/^[0-9]{8,15}$/.test(digits)) {
    ctx.addIssue({ code: ZodIssueCode.custom, message: "Escreva o n\xFAmero com o indicativo do pa\xEDs, por exemplo +244 923 000 000." });
    return NEVER;
  }
  return digits;
});
var optionalEmail = unionType([stringType().trim().toLowerCase().email().max(160), literalType(""), nullType()]).optional().transform((v) => v ? v : null);
var httpsUrl = unionType([stringType().trim().max(500).regex(/^https:\/\/[^\s\u0000]+$/, "Use um endere\xE7o que comece por https://"), literalType(""), nullType()]).optional().transform((v) => v ? v : null);
var timeRange = tupleType([stringType().refine(isTime, "Hora inv\xE1lida."), stringType().refine(isTime, "Hora inv\xE1lida.")]).refine(([a, b]) => a !== b, "A hora de abertura e a de fecho n\xE3o podem ser iguais.");
var openingHours = objectType(Object.fromEntries(WEEKDAYS.map((d) => [d, arrayType(timeRange).max(3).optional()]))).strict();
var atLeastOne = (schema) => schema.refine((o) => Object.keys(o).length > 0, { message: "Indique pelo menos um campo a alterar." });
var LoginInput = objectType({
  email: stringType().trim().toLowerCase().email().max(254),
  password: stringType().min(1).max(200)
}).strict();
var ChangePasswordInput = objectType({
  current_password: stringType().min(1).max(200),
  new_password: stringType().min(1).max(200)
}).strict();
var SwitchRestaurantInput = objectType({ restaurant_id: uuid }).strict();
var OrderItemInput = objectType({
  menu_item_id: uuid,
  quantity: numberType().int().min(1).max(20),
  notes: optionalText(300),
  options: arrayType(objectType({ option_id: uuid, quantity: numberType().int().min(1).max(10).default(1) }).strict()).max(15).default([])
}).strict();
var orderLines = arrayType(OrderItemInput).min(1).max(40).refine((items) => items.reduce((n, i) => n + i.quantity, 0) <= 100, { message: "Um pedido pode ter no m\xE1ximo 100 unidades." });
var CreateOrderInput = objectType({ items: orderLines, notes: optionalText(500) }).strict();
var StaffCreateOrderInput = objectType({ table_id: uuid, items: orderLines, notes: optionalText(500) }).strict();
var OrderStatusInput = objectType({
  to: enumType(ORDER_STATUSES),
  from: enumType(ORDER_STATUSES).optional(),
  reason: stringType().trim().min(3).max(300).refine(noNul, NUL_MESSAGE).optional()
}).strict();
var TableCreateInput = objectType({ table_number: numberType().int().min(1).max(9999), label: optionalText(60) }).strict();
var TableUpdateInput = atLeastOne(objectType({ label: optionalText(60), active: booleanType() }).partial().strict());
var price = numberType().int().min(0).max(100000000000);
var CategoryInput = objectType({ name: text(80), display_order: numberType().int().min(0).max(1e5).default(0), active: booleanType().default(true) }).strict();
var CategoryUpdateInput = atLeastOne(objectType({ name: text(80), display_order: numberType().int().min(0).max(1e5), active: booleanType() }).partial().strict());
var MenuItemInput = objectType({
  category_id: uuid,
  name: text(120),
  description: optionalText(600),
  image_url: optionalUrl,
  thumb_url: optionalUrl,
  model_url: assetPath,
  ingredients: ingredients.default([]),
  allergens: allergens.default([]),
  price_cents: price,
  available: booleanType().default(true),
  active: booleanType().default(true),
  display_order: numberType().int().min(0).max(1e5).default(0)
}).strict();
var MenuItemUpdateInput = atLeastOne(objectType({
  category_id: uuid,
  name: text(120),
  description: optionalText(600),
  image_url: optionalUrl,
  thumb_url: optionalUrl,
  model_url: assetPath,
  ingredients,
  allergens,
  price_cents: price,
  available: booleanType(),
  active: booleanType(),
  display_order: numberType().int().min(0).max(1e5)
}).partial().strict());
var AvailabilityInput = objectType({ available: booleanType() }).strict();
var OptionInput = objectType({
  name: text(80),
  price_delta_cents: price.default(0),
  kind: enumType(["extra", "size"]).default("extra"),
  active: booleanType().default(true),
  display_order: numberType().int().min(0).max(1e5).default(0)
}).strict();
var OptionUpdateInput = atLeastOne(objectType({ name: text(80), price_delta_cents: price, kind: enumType(["extra", "size"]), active: booleanType(), display_order: numberType().int().min(0).max(1e5) }).partial().strict());
var RestaurantUpdateInput = atLeastOne(objectType({
  name: text(120, 2),
  description: optionalText(500),
  logo_url: optionalUrl,
  cover_url: optionalUrl,
  accent_color: unionType([stringType().regex(/^#[0-9a-fA-F]{6}$/, "Use uma cor no formato #RRGGBB."), literalType(""), nullType()]).transform((v) => v ? v : null),
  address: optionalText(200),
  phone: optionalText(40),
  email: optionalEmail,
  whatsapp: phoneDigits,
  maps_url: httpsUrl,
  opening_hours: openingHours,
  theme: enumType(["dark", "light"]),
  font: enumType(["serif", "sans"]),
  timezone: text(60),
  service_fee_bps: numberType().int().min(0).max(3000),
  accepting_orders: booleanType()
}).partial().strict());
var PaymentCreateInput = objectType({
  method: enumType(PAYMENT_METHODS),
  status: enumType(["pago", "isento"]).default("pago"),
  amount_cents: numberType().int().min(1).max(100000000000).optional(),
  reference: optionalText(100)
}).strict();
var PaymentUpdateInput = objectType({ status: enumType(["reembolsado", "anulado"]), reason: text(300, 3) }).strict();
var StaffCreateInput = objectType({
  name: text(120),
  email: stringType().trim().toLowerCase().email().max(254),
  role: enumType(["manager", "waiter", "kitchen"])
}).strict();
var StaffUpdateInput = atLeastOne(objectType({ role: enumType(["manager", "waiter", "kitchen"]), active: booleanType() }).partial().strict());
var isoDay = stringType().regex(/^\d{4}-\d{2}-\d{2}$/, "Use uma data no formato AAAA-MM-DD.");
var ReportQuery = objectType({ from: isoDay.optional(), to: isoDay.optional() }).strict();
var ActivityQuery = objectType({
  before: stringType().regex(/^\d{1,18}$/, "Posi\xE7\xE3o inv\xE1lida.").optional(),
  limit: coerce.number().int().min(1).max(100).optional()
}).strict();
var slug = stringType().trim().toLowerCase().min(2).max(60).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Use apenas letras min\xFAsculas, n\xFAmeros e h\xEDfenes (ex.: terraza-talatona).");
var AdminCreateRestaurantInput = objectType({
  name: text(120, 2),
  slug: slug.optional(),
  plan_code: stringType().regex(/^[a-z][a-z0-9_]{1,30}$/).optional(),
  currency: enumType(CURRENCIES).optional(),
  manager: objectType({ name: text(120), email: stringType().trim().toLowerCase().email().max(254) }).strict()
}).strict();
var AdminUpdateRestaurantInput = atLeastOne(objectType({ status: enumType(["ativo", "suspenso", "desativado"]), name: text(120, 2) }).partial().strict());
var featureList = arrayType(enumType(FEATURE_KEYS)).max(FEATURE_KEYS.length).transform((l) => Array.from(new Set(l)));
var planPrice = objectType({
  currency: enumType(CURRENCIES),
  monthly_cents: numberType().int().min(0).max(100000000000),
  yearly_cents: numberType().int().min(0).max(1000000000000).nullable().default(null)
}).strict();
var planFields = {
  name: text(40, 2),
  tagline: stringType().trim().max(160).refine(noNul, NUL_MESSAGE).default(""),
  display_order: numberType().int().min(0).max(1000),
  highlighted: booleanType(),
  active: booleanType(),
  features: featureList,
  prices: arrayType(planPrice).max(CURRENCIES.length).refine((l) => new Set(l.map((p) => p.currency)).size === l.length, "Cada moeda s\xF3 pode ter um pre\xE7o.")
};
var PlanCreateInput = objectType({ code: stringType().trim().toLowerCase().regex(/^[a-z][a-z0-9_]{1,30}$/, "Use letras min\xFAsculas, n\xFAmeros e _ (ex.: gold)."), ...planFields }).strict();
var PlanUpdateInput = atLeastOne(objectType(planFields).partial().strict());
var isoDate = stringType().regex(/^\d{4}-\d{2}-\d{2}$/, "Use uma data no formato AAAA-MM-DD.");
var SubscriptionUpdateInput = atLeastOne(objectType({
  plan_code: stringType().regex(/^[a-z][a-z0-9_]{1,30}$/),
  status: enumType(["ativa", "em_atraso", "cancelada"]),
  valid_until: unionType([isoDate, nullType()]),
  notes: optionalText(500)
}).partial().strict());
var LeadUpdateInput = objectType({ status: enumType(["novo", "contactado", "arquivado"]) }).strict();

// shared/money.ts
var CURRENCY_SYMBOLS = { AOA: "Kz", USD: "US$", EUR: "\u20AC", BRL: "R$", MZN: "MT", ZAR: "R", GBP: "\xA3" };
function currencySymbol(currency = "AOA") {
  return CURRENCY_SYMBOLS[currency] ?? currency;
}
function formatMoney(cents, currency = "AOA") {
  const negative = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, "\xA0");
  return `${negative ? "-" : ""}${grouped}${frac ? "," + String(frac).padStart(2, "0") : ""}\xA0${CURRENCY_SYMBOLS[currency] ?? currency}`;
}
function serviceFeeCents(subtotalCents, bps) {
  return (subtotalCents * BigInt(bps) + HALF_BPS_UNIT) / BPS_UNIT;
}
var BPS_UNIT = BigInt(1e4);
var HALF_BPS_UNIT = BigInt(5000);

// shared/activity.ts
var str = (v, max = 80) => typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
var int = (v) => typeof v === "number" && Number.isFinite(v) ? v : null;
var obj = (v) => v && typeof v === "object" && !Array.isArray(v) ? v : null;
var quoted = (name) => name ? ` \xAB${name}\xBB` : "";
var statusLabel = (v) => isOrderStatus(v) ? STATUS_LABEL[v] : null;
var own = (map, key) => typeof key === "string" && Object.hasOwn(map, key) ? map[key] : null;
var ROLES = { manager: "gerente", waiter: "empregado de mesa", kitchen: "cozinha" };
var role = (v) => own(ROLES, v) ?? "equipa";
var theTable = (m) => {
  const n = int(m.table_number);
  return n !== null ? `a mesa ${n}` : "uma mesa";
};
var ofTable = (m) => {
  const n = int(m.table_number);
  return n !== null ? `da mesa ${n}` : "de uma mesa";
};
var forTable = (m) => `para ${theTable(m)}`;
function describeActivity(action, metadata, currency = "AOA") {
  const m = obj(metadata) ?? {};
  const money = (cents) => cents === null ? "" : formatMoney(cents, currency);
  switch (action) {
    case "menu.category.create":
      return `Criou a categoria${quoted(str(m.name))}.`;
    case "menu.category.update":
      return "Alterou uma categoria do menu.";
    case "menu.category.delete":
      return "Apagou uma categoria do menu.";
    case "menu.item.create": {
      const p = money(int(m.price_cents));
      return `Criou o prato${quoted(str(m.name))}${p ? ` (${p})` : ""}.`;
    }
    case "menu.item.update": {
      const change = obj(m.price_change);
      const from = change ? int(change.from) : null;
      const to = change ? int(change.to) : null;
      return from !== null && to !== null && from !== to ? `Alterou um prato: o pre\xE7o passou de ${money(from)} para ${money(to)}.` : "Alterou um prato do menu.";
    }
    case "menu.item.availability":
      return m.available === false ? "Marcou um prato como esgotado." : "Voltou a marcar um prato como dispon\xEDvel.";
    case "menu.item.delete":
      return "Apagou um prato do menu.";
    case "menu.option.create":
      return `Criou a op\xE7\xE3o${quoted(str(m.name))} num prato.`;
    case "menu.option.update":
      return "Alterou uma op\xE7\xE3o de um prato.";
    case "menu.option.delete":
      return "Apagou uma op\xE7\xE3o de um prato.";
    case "asset.upload": {
      const kind = m.kind === "model" ? "um modelo 3D" : "uma fotografia";
      return `Enviou ${kind}.`;
    }
    case "table.create":
      return `Criou ${theTable(m)}.`;
    case "table.update":
      if (m.active_changed === true)
        return m.active === false ? `Desativou ${theTable(m)}.` : `Reativou ${theTable(m)}.`;
      return m.label_changed === true ? `Mudou o nome ${ofTable(m)}.` : `Alterou ${theTable(m)}.`;
    case "table.qr_regenerated":
      return `Gerou um novo QR Code ${forTable(m)}. O anterior deixou de funcionar.`;
    case "table.delete":
      return "Apagou uma mesa.";
    case "table.session_closed":
      return `Libertou ${theTable(m)}.`;
    case "qr.download": {
      if (m.kind === "tables") {
        const n = int(m.count);
        return n !== null ? `Descarregou o PDF dos QR Codes de ${n} ${n === 1 ? "mesa" : "mesas"}.` : "Descarregou o PDF dos QR Codes das mesas.";
      }
      return "Descarregou o PDF do QR Code do restaurante.";
    }
    case "waiter_call.attend":
      return `Atendeu o chamamento ${ofTable(m)}.`;
    case "order.cancel": {
      const why = str(m.reason, 120);
      return `Cancelou um pedido${why ? ` (motivo: ${why})` : ""}.`;
    }
    case "order.correct": {
      const why = str(m.reason, 120);
      const from = statusLabel(m.from);
      const to = statusLabel(m.to);
      const change = from && to ? `: de \xAB${from}\xBB para \xAB${to}\xBB` : "";
      return `Corrigiu o estado de um pedido${change}${why ? ` (motivo: ${why})` : ""}.`;
    }
    case "payment.record": {
      const method = own(METHOD_LABEL, m.method) ?? "";
      const amount = money(int(m.amount_cents));
      return `Registou um pagamento${amount ? ` de ${amount}` : ""}${method ? ` (${String(method).toLowerCase()})` : ""}.`;
    }
    case "payment.exempt": {
      const why = str(m.reason, 120);
      return `Registou um pedido como isento de pagamento${why ? ` (motivo: ${why})` : ""}.`;
    }
    case "payment.refund": {
      const amount = money(int(m.amount_cents));
      return `Registou um reembolso${amount ? ` de ${amount}` : ""}.`;
    }
    case "payment.void": {
      const amount = money(int(m.amount_cents));
      return `Anulou um registo de pagamento${amount ? ` de ${amount}` : ""}.`;
    }
    case "auth.login":
      return "Iniciou sess\xE3o.";
    case "auth.password_changed":
      return "Mudou a pr\xF3pria palavra-passe.";
    case "staff.create":
      return `Criou uma conta de ${role(m.role)}.`;
    case "staff.update": {
      const r = obj(m.role);
      const a = obj(m.active);
      const parts = [];
      if (r)
        parts.push(`fun\xE7\xE3o de ${role(r.from)} para ${role(r.to)}`);
      if (a)
        parts.push(a.to === false ? "conta desativada" : "conta reativada");
      return parts.length ? `Alterou uma conta da equipa: ${parts.join("; ")}.` : "Alterou uma conta da equipa.";
    }
    case "staff.password_reset":
      return "Rep\xF4s a palavra-passe de uma conta da equipa.";
    case "restaurant.update": {
      if (typeof m.accepting_orders === "boolean")
        return m.accepting_orders ? "Retomou os pedidos por QR Code." : "Pausou os pedidos por QR Code.";
      const bps = int(m.service_fee_bps);
      if (bps !== null)
        return `Alterou a taxa de servi\xE7o para ${(bps / 100).toString().replace(".", ",")} %.`;
      return "Alterou as defini\xE7\xF5es do restaurante.";
    }
    case "report.export": {
      const from = str(m.from, 10);
      const to = str(m.to, 10);
      return from && to ? `Exportou o relat\xF3rio de vendas em CSV (${dmy(from)} a ${dmy(to)}).` : "Exportou o relat\xF3rio de vendas em CSV.";
    }
    default:
      return `A\xE7\xE3o registada (${action.slice(0, 60)}).`;
  }
}
function dmy(iso) {
  const x = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return x ? `${x[3]}/${x[2]}/${x[1]}` : iso;
}

// server/src/lib/plans.ts
var TTL_MS = 15000;
var cache2 = new Map;
var BASELINE = new Set(DEFAULT_PLANS[0].features);
async function restaurantFeatures(db, restaurantId) {
  const hit = cache2.get(restaurantId);
  if (hit && Date.now() - hit.at < TTL_MS)
    return hit.features;
  const rows = await db.system((tx) => tx`SELECT p.features FROM subscriptions s JOIN plans p ON p.code = s.plan_code WHERE s.restaurant_id = ${restaurantId}`);
  const features = rows[0] ? new Set(rows[0].features.filter(isFeatureKey)) : BASELINE;
  if (cache2.size > 5000)
    cache2.clear();
  cache2.set(restaurantId, { at: Date.now(), features });
  return features;
}
function clearFeatureCache() {
  cache2.clear();
}
async function requireFeature(db, restaurantId, feature, what) {
  const features = await restaurantFeatures(db, restaurantId);
  if (!features.has(feature)) {
    throw new HttpError(403, "PLAN_FEATURE", `O plano do seu restaurante n\xE3o inclui ${what}. Fale com a Altiora Grupo para o ativar.`, { feature });
  }
}

// server/src/http/respond.ts
var JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};
function json(data, status = 200, headers) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });
}
var created = (data, headers) => json(data, 201, headers);
function noContent(headers) {
  return new Response(null, { status: 204, headers: { "cache-control": "no-store", ...headers } });
}

// server/src/modules/activity/routes.ts
var DEFAULT_LIMIT = 40;
async function list(ctx) {
  const parsed = ActivityQuery.safeParse(Object.fromEntries(ctx.url.searchParams));
  if (!parsed.success)
    throw badRequest("Pedido inv\xE1lido.", parsed.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })), "VALIDATION_ERROR");
  const a = ctx.auth;
  const rid = a.restaurantId;
  await requireFeature(ctx.deps.db, rid, "advanced_management", "o registo de atividade da equipa");
  const limit = parsed.data.limit ?? DEFAULT_LIMIT;
  const before = parsed.data.before ?? null;
  const { rows, currency } = await ctx.deps.db.as({ role: "manager", restaurantId: rid, userId: a.userId }, async (tx) => {
    const [r] = await tx`SELECT currency FROM restaurants WHERE id = ${rid}`;
    const found = before ? await tx`
          SELECT id::text AS entry_id, created_at, action, actor_id, actor_role, metadata FROM audit_logs
          WHERE restaurant_id = ${rid} AND action NOT LIKE 'platform.%' AND id < ${before}::bigint
          ORDER BY id DESC LIMIT ${limit + 1}` : await tx`
          SELECT id::text AS entry_id, created_at, action, actor_id, actor_role, metadata FROM audit_logs
          WHERE restaurant_id = ${rid} AND action NOT LIKE 'platform.%'
          ORDER BY id DESC LIMIT ${limit + 1}`;
    return { rows: found, currency: r?.currency ?? "AOA" };
  });
  const page = rows.slice(0, limit);
  const actorIds = [...new Set(page.map((r) => r.actor_id).filter((x) => !!x))];
  const names = new Map;
  if (actorIds.length > 0) {
    const members = await ctx.deps.db.system((tx) => tx`
        SELECT m.user_id, u.name FROM restaurant_members m JOIN users u ON u.id = m.user_id
        WHERE m.restaurant_id = ${rid} AND m.user_id = ANY(${actorIds}::uuid[])`);
    for (const m of members)
      names.set(m.user_id, m.name);
  }
  const entries = page.map((r) => ({
    id: r.entry_id,
    at: iso(r.created_at),
    actor_name: r.actor_id ? names.get(r.actor_id) ?? null : null,
    actor_role: r.actor_role,
    text: describeActivity(r.action, r.metadata, currency)
  }));
  return json({ entries, next_before: rows.length > limit ? page[page.length - 1].entry_id : null });
}
var activityRoutes = [
  { method: "GET", path: "/api/activity", access: { roles: ["manager"] }, handler: list, limits: [{ name: "activity", max: 60, windowMs: 60000 }] }
];

// server/src/auth/password.ts
import { randomBytes as randomBytes2, scrypt as scryptCb, timingSafeEqual as timingSafeEqual2 } from "crypto";

// server/src/lib/semaphore.ts
class Semaphore {
  max;
  active = 0;
  queue = [];
  constructor(max) {
    this.max = max;
  }
  async run(fn) {
    if (this.active >= this.max)
      await new Promise((resolve) => this.queue.push(resolve));
    else
      this.active++;
    try {
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next)
        next();
      else
        this.active--;
    }
  }
  get waiting() {
    return this.queue.length;
  }
}

// server/src/auth/password.ts
var KEYLEN = 32;
var R = 8;
var P = 1;
var gate = new Semaphore(4);
function derive(password, salt, logN, r, p) {
  const N = 2 ** logN;
  return gate.run(() => new Promise((resolve, reject) => {
    scryptCb(password.normalize("NFKC"), salt, KEYLEN, { N, r, p, maxmem: 256 * N * r + 4 * 1024 * 1024 }, (err, key) => err ? reject(err) : resolve(key));
  }));
}
async function hashPassword(password, logN = 15) {
  const salt = randomBytes2(16);
  const key = await derive(password, salt, logN, R, P);
  return `scrypt$${logN}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}
async function verifyPassword(password, stored) {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt")
    return false;
  const logN = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(logN) || logN < 10 || logN > 20 || !Number.isInteger(r) || r < 1 || r > 16 || !Number.isInteger(p) || p < 1 || p > 4)
    return false;
  try {
    const salt = Buffer.from(parts[4], "base64");
    const expected = Buffer.from(parts[5], "base64");
    const actual = await derive(password, salt, logN, r, p);
    return expected.length === actual.length && timingSafeEqual2(expected, actual);
  } catch {
    return false;
  }
}
var COMMON = new Set([
  "password",
  "password1",
  "password123",
  "1234567890",
  "12345678910",
  "qwertyuiop",
  "iloveyou12",
  "admin12345",
  "administrador",
  "senha12345",
  "senha123456",
  "palavrapasse",
  "altiora123",
  "altiora2026",
  "restaurante",
  "restaurante1",
  "abcdefghij",
  "0123456789",
  "1q2w3e4r5t",
  "welcome123",
  "letmein123",
  "luanda2026",
  "angola2026",
  "angola12345"
]);
function checkPasswordStrength(password, email) {
  if (password.length < 10)
    return "A palavra-passe deve ter pelo menos 10 caracteres.";
  if (password.length > 128)
    return "A palavra-passe pode ter no m\xE1ximo 128 caracteres.";
  if (new Set(password).size < 5)
    return "A palavra-passe \xE9 demasiado repetitiva.";
  const lower = password.toLowerCase();
  if (COMMON.has(lower))
    return "Esta palavra-passe \xE9 demasiado comum. Escolha outra.";
  if (email) {
    const e = email.toLowerCase();
    const local = e.split("@")[0] ?? "";
    if (lower === e || local.length >= 4 && lower.includes(local))
      return "A palavra-passe n\xE3o pode conter o seu e-mail.";
  }
  return null;
}

// server/src/db/dynamic.ts
async function updatePartial(tx, table, spec, input) {
  const params = [...spec.whereParams];
  const sets = [];
  for (const col of spec.columns) {
    if (!Object.prototype.hasOwnProperty.call(input, col) || input[col] === undefined)
      continue;
    params.push(input[col]);
    sets.push(`${col} = $${params.length}`);
  }
  if (sets.length === 0)
    return null;
  const rows = await tx.unsafe(`UPDATE ${table} SET ${sets.join(", ")} WHERE ${spec.where} RETURNING ${spec.returning}`, params);
  return rows[0] ?? null;
}

// server/src/lib/audit.ts
async function audit(tx, e) {
  await tx.unsafe(`INSERT INTO audit_logs (restaurant_id, actor_id, actor_role, action, entity_type, entity_id, metadata, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`, [e.restaurantId, e.actorId, e.actorRole, e.action, e.entityType ?? null, e.entityId ?? null, e.metadata ?? {}, e.ip ?? null]);
}

// server/src/lib/slug.ts
function slugify(text) {
  const s = text.normalize("NFD").replace(/[\u0300-\u036F]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50).replace(/-+$/g, "");
  return s.length >= 2 ? s : "restaurante";
}

// server/src/modules/admin/routes.ts
var toView = (r) => ({
  id: r.id,
  name: r.name,
  slug: r.slug,
  status: r.status,
  created_at: iso(r.created_at),
  menu_base_url: r.menu_base_url,
  currency: r.currency,
  is_demo: r.is_demo,
  plan_code: r.plan_code,
  subscription_status: r.subscription_status,
  valid_until: r.valid_until,
  subscription_notes: r.subscription_notes,
  managers: r.managers ?? []
});
var SELECT_RESTAURANT = `
  SELECT r.id, r.name, r.slug, r.status, r.created_at, r.menu_base_url, r.currency, r.is_demo,
         s.plan_code, s.status AS subscription_status, s.valid_until::text AS valid_until, s.notes AS subscription_notes,`;
async function list2(ctx) {
  const rows = await ctx.deps.db.system((tx) => tx.unsafe(`${SELECT_RESTAURANT}
             (SELECT coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'name', u.name, 'email', u.email) ORDER BY m.created_at), '[]'::jsonb)
              FROM restaurant_members m JOIN users u ON u.id = m.user_id
              WHERE m.restaurant_id = r.id AND m.role = 'manager' AND m.active) AS managers
      FROM restaurants r LEFT JOIN subscriptions s ON s.restaurant_id = r.id ORDER BY r.created_at DESC`));
  return json({ restaurants: rows.map(toView) });
}
async function createRestaurant(ctx) {
  const a = ctx.auth;
  const { db, config } = ctx.deps;
  const input = await ctx.body(AdminCreateRestaurantInput);
  const explicitSlug = input.slug !== undefined;
  const baseSlug = input.slug ?? slugify(input.name);
  const tempPassword = temporaryPassword();
  const tempHash = await hashPassword(tempPassword, config.scryptLogN);
  for (let attempt = 0;attempt < 6; attempt++) {
    const slug = attempt === 0 ? baseSlug : attempt < 5 ? `${baseSlug.slice(0, 54)}-${attempt + 1}` : `${baseSlug.slice(0, 50)}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, "x")}`;
    try {
      const out = await db.system(async (tx) => {
        const planCode = input.plan_code ?? "pro";
        const [plan] = await tx`SELECT code FROM plans WHERE code = ${planCode} AND active`;
        if (!plan)
          throw new HttpError(422, "PLAN_NOT_FOUND", "O plano escolhido n\xE3o existe ou j\xE1 n\xE3o est\xE1 dispon\xEDvel.");
        const [r] = await tx`INSERT INTO restaurants (name, slug, currency) VALUES (${input.name}, ${slug}, ${input.currency ?? "AOA"}) RETURNING id`;
        const restaurantId = r.id;
        await tx`INSERT INTO subscriptions (restaurant_id, plan_code) VALUES (${restaurantId}, ${planCode})`;
        const [existing] = await tx`
          SELECT id, is_platform_admin, name FROM users WHERE email = ${input.manager.email}`;
        let userId;
        let existingAccount = false;
        if (existing) {
          if (existing.is_platform_admin)
            throw conflict("Este e-mail pertence a uma conta de administra\xE7\xE3o da plataforma.", "EMAIL_IS_PLATFORM_ADMIN");
          userId = existing.id;
          existingAccount = true;
        } else {
          const [u] = await tx`
            INSERT INTO users (email, name, password_hash, must_change_password)
            VALUES (${input.manager.email}, ${input.manager.name}, ${tempHash}, true) RETURNING id`;
          userId = u.id;
        }
        await tx`INSERT INTO restaurant_members (restaurant_id, user_id, role) VALUES (${restaurantId}, ${userId}, 'manager')`;
        await audit(tx, {
          restaurantId,
          actorId: a.userId,
          actorRole: "platform",
          action: "platform.restaurant.create",
          entityType: "restaurant",
          entityId: restaurantId,
          metadata: { slug, manager_email: input.manager.email, existing_account: existingAccount, plan: planCode },
          ip: ctx.ip
        });
        const [row] = await tx.unsafe(`${SELECT_RESTAURANT} NULL::jsonb AS managers FROM restaurants r LEFT JOIN subscriptions s ON s.restaurant_id = r.id WHERE r.id = $1`, [restaurantId]);
        return { row, userId, existingAccount };
      });
      return created({
        restaurant: { ...toView(out.row), managers: [{ id: out.userId, name: input.manager.name, email: input.manager.email }] },
        manager: {
          email: input.manager.email,
          existing_account: out.existingAccount,
          temporary_password: out.existingAccount ? null : tempPassword
        }
      });
    } catch (err) {
      if (pgCode(err) === "23505" && pgConstraint(err) === "restaurants_slug_uq") {
        if (explicitSlug)
          throw conflict("Este endere\xE7o (slug) j\xE1 est\xE1 em uso por outro restaurante.", "SLUG_TAKEN");
        continue;
      }
      throw err;
    }
  }
  throw new HttpError(409, "SLUG_TAKEN", "N\xE3o foi poss\xEDvel gerar um endere\xE7o \xFAnico para o restaurante. Indique um manualmente.");
}
async function updateRestaurant(ctx) {
  const a = ctx.auth;
  const id = uuid.safeParse(ctx.params.id);
  if (!id.success)
    throw notFound("Restaurante n\xE3o encontrado.", "RESTAURANT_NOT_FOUND");
  const input = await ctx.body(AdminUpdateRestaurantInput);
  const row = await ctx.deps.db.system(async (tx) => {
    const r = await updatePartial(tx, "restaurants", {
      columns: ["status", "name"],
      where: "id = $1",
      whereParams: [id.data],
      returning: "id"
    }, input);
    if (!r)
      throw notFound("Restaurante n\xE3o encontrado.", "RESTAURANT_NOT_FOUND");
    await audit(tx, {
      restaurantId: id.data,
      actorId: a.userId,
      actorRole: "platform",
      action: "platform.restaurant.update",
      entityType: "restaurant",
      entityId: id.data,
      metadata: { ...input.status ? { status: input.status } : {}, ...input.name ? { renamed: true } : {} },
      ip: ctx.ip
    });
    const [full] = await tx.unsafe(`${SELECT_RESTAURANT}
             (SELECT coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'name', u.name, 'email', u.email) ORDER BY m.created_at), '[]'::jsonb)
              FROM restaurant_members m JOIN users u ON u.id = m.user_id
              WHERE m.restaurant_id = r.id AND m.role = 'manager' AND m.active) AS managers
      FROM restaurants r LEFT JOIN subscriptions s ON s.restaurant_id = r.id WHERE r.id = $1`, [id.data]);
    return full;
  });
  return json({ restaurant: toView(row) });
}
async function resetManagerPassword(ctx) {
  const a = ctx.auth;
  const { db, config } = ctx.deps;
  const rid = uuid.safeParse(ctx.params.id);
  const uid = uuid.safeParse(ctx.params.userId);
  if (!rid.success || !uid.success)
    throw notFound("Gerente n\xE3o encontrado.", "MANAGER_NOT_FOUND");
  const tempPassword = temporaryPassword();
  const tempHash = await hashPassword(tempPassword, config.scryptLogN);
  const email = await db.system(async (tx) => {
    const [m] = await tx`
      SELECT u.email FROM restaurant_members m JOIN users u ON u.id = m.user_id
      WHERE m.restaurant_id = ${rid.data} AND m.user_id = ${uid.data} AND m.role = 'manager' AND m.active`;
    if (!m)
      throw notFound("Gerente n\xE3o encontrado.", "MANAGER_NOT_FOUND");
    await tx`UPDATE users SET password_hash = ${tempHash}, must_change_password = true WHERE id = ${uid.data}`;
    await audit(tx, {
      restaurantId: rid.data,
      actorId: a.userId,
      actorRole: "platform",
      action: "platform.manager.password_reset",
      entityType: "user",
      entityId: uid.data,
      ip: ctx.ip
    });
    return m.email;
  });
  await revokeSessionsOfUser(db, uid.data);
  return json({ manager: { email, temporary_password: tempPassword } });
}
async function platformAudit(ctx) {
  const a = ctx.auth;
  const rows = await ctx.deps.db.as({ role: "platform", userId: a.userId }, (tx) => tx`
      SELECT id, restaurant_id, action, metadata, created_at FROM audit_logs ORDER BY id DESC LIMIT 100`);
  return json({ entries: rows.map((r) => ({ id: String(r.id), restaurant_id: r.restaurant_id, action: r.action, metadata: r.metadata, created_at: iso(r.created_at) })) });
}
var adminRoutes = [
  { method: "GET", path: "/api/admin/restaurants", access: "platform", handler: list2 },
  { method: "POST", path: "/api/admin/restaurants", access: "platform", handler: createRestaurant, limits: [{ name: "admin-create", max: 20, windowMs: 60000 }] },
  { method: "PATCH", path: "/api/admin/restaurants/:id", access: "platform", handler: updateRestaurant },
  { method: "POST", path: "/api/admin/restaurants/:id/managers/:userId/reset-password", access: "platform", handler: resetManagerPassword, noBody: true, limits: [{ name: "admin-reset", max: 20, windowMs: 60000 }] },
  { method: "GET", path: "/api/admin/audit", access: "platform", handler: platformAudit }
];

// server/src/modules/admin/billing.ts
async function loadPlans(tx) {
  const plans = await tx`
    SELECT p.code, p.name, p.tagline, p.display_order, p.highlighted, p.active, p.features,
           (SELECT count(*)::int FROM subscriptions s WHERE s.plan_code = p.code) AS restaurants
    FROM plans p ORDER BY p.display_order, p.code`;
  const prices = await tx`SELECT plan_code, currency, monthly_cents, yearly_cents FROM plan_prices ORDER BY currency`;
  return plans.map((p) => ({
    code: p.code,
    name: p.name,
    tagline: p.tagline,
    display_order: p.display_order,
    highlighted: p.highlighted,
    active: p.active,
    features: p.features.filter(isFeatureKey),
    restaurants: p.restaurants,
    prices: prices.filter((x) => x.plan_code === p.code).map((x) => ({ currency: x.currency, monthly_cents: Number(x.monthly_cents), yearly_cents: x.yearly_cents === null ? null : Number(x.yearly_cents) }))
  }));
}
async function writePrices(tx, code, prices) {
  await tx`DELETE FROM plan_prices WHERE plan_code = ${code}`;
  for (const p of prices) {
    await tx`INSERT INTO plan_prices (plan_code, currency, monthly_cents, yearly_cents) VALUES (${code}, ${p.currency}, ${p.monthly_cents}, ${p.yearly_cents})`;
  }
}
async function listPlans(ctx) {
  const plans = await ctx.deps.db.as(ctx.dbContext(), loadPlans);
  return json({ plans });
}
async function createPlan(ctx) {
  const a = ctx.auth;
  const input = await ctx.body(PlanCreateInput);
  try {
    const plan = await ctx.deps.db.as(ctx.dbContext(), async (tx) => {
      await tx`INSERT INTO plans (code, name, tagline, display_order, highlighted, active, features)
               VALUES (${input.code}, ${input.name}, ${input.tagline}, ${input.display_order}, ${input.highlighted}, ${input.active}, ${input.features}::text[])`;
      await writePrices(tx, input.code, input.prices);
      await audit(tx, { restaurantId: null, actorId: a.userId, actorRole: "platform", action: "platform.plan.create", entityType: "plan", metadata: { code: input.code }, ip: ctx.ip });
      return (await loadPlans(tx)).find((p) => p.code === input.code);
    });
    clearFeatureCache();
    return created({ plan });
  } catch (err) {
    if (pgCode(err) === "23505")
      throw conflict("J\xE1 existe um plano com este c\xF3digo.", "PLAN_EXISTS");
    throw err;
  }
}
async function updatePlan(ctx) {
  const a = ctx.auth;
  const code = ctx.params.code ?? "";
  if (!/^[a-z][a-z0-9_]{1,30}$/.test(code))
    throw notFound("Plano n\xE3o encontrado.", "PLAN_NOT_FOUND");
  const input = await ctx.body(PlanUpdateInput);
  const plan = await ctx.deps.db.as(ctx.dbContext(), async (tx) => {
    const [exists] = await tx`SELECT 1 FROM plans WHERE code = ${code}`;
    if (!exists)
      throw notFound("Plano n\xE3o encontrado.", "PLAN_NOT_FOUND");
    if (input.name !== undefined)
      await tx`UPDATE plans SET name = ${input.name}, updated_at = now() WHERE code = ${code}`;
    if (input.tagline !== undefined)
      await tx`UPDATE plans SET tagline = ${input.tagline}, updated_at = now() WHERE code = ${code}`;
    if (input.display_order !== undefined)
      await tx`UPDATE plans SET display_order = ${input.display_order}, updated_at = now() WHERE code = ${code}`;
    if (input.highlighted !== undefined) {
      if (input.highlighted)
        await tx`UPDATE plans SET highlighted = false WHERE code <> ${code}`;
      await tx`UPDATE plans SET highlighted = ${input.highlighted}, updated_at = now() WHERE code = ${code}`;
    }
    if (input.active !== undefined)
      await tx`UPDATE plans SET active = ${input.active}, updated_at = now() WHERE code = ${code}`;
    if (input.features !== undefined)
      await tx`UPDATE plans SET features = ${input.features}::text[], updated_at = now() WHERE code = ${code}`;
    if (input.prices !== undefined)
      await writePrices(tx, code, input.prices);
    await audit(tx, { restaurantId: null, actorId: a.userId, actorRole: "platform", action: "platform.plan.update", entityType: "plan", metadata: { code, fields: Object.keys(input) }, ip: ctx.ip });
    return (await loadPlans(tx)).find((p) => p.code === code);
  });
  clearFeatureCache();
  return json({ plan });
}
async function updateSubscription(ctx) {
  const a = ctx.auth;
  const id = uuid.safeParse(ctx.params.id);
  if (!id.success)
    throw notFound("Restaurante n\xE3o encontrado.", "RESTAURANT_NOT_FOUND");
  const input = await ctx.body(SubscriptionUpdateInput);
  const row = await ctx.deps.db.as(ctx.dbContext(), async (tx) => {
    const [r] = await tx`SELECT 1 FROM restaurants WHERE id = ${id.data}`;
    if (!r)
      throw notFound("Restaurante n\xE3o encontrado.", "RESTAURANT_NOT_FOUND");
    if (input.plan_code !== undefined) {
      const [p] = await tx`SELECT 1 FROM plans WHERE code = ${input.plan_code}`;
      if (!p)
        throw new HttpError(422, "PLAN_NOT_FOUND", "O plano escolhido n\xE3o existe.");
    }
    const [cur] = await tx`
      SELECT plan_code, status, valid_until::text AS valid_until, notes FROM subscriptions WHERE restaurant_id = ${id.data}`;
    const next = {
      plan_code: input.plan_code ?? cur?.plan_code ?? "starter",
      status: input.status ?? cur?.status ?? "ativa",
      valid_until: input.valid_until !== undefined ? input.valid_until : cur?.valid_until ?? null,
      notes: input.notes !== undefined ? input.notes : cur?.notes ?? null
    };
    await tx`
      INSERT INTO subscriptions (restaurant_id, plan_code, status, valid_until, notes)
      VALUES (${id.data}, ${next.plan_code}, ${next.status}, ${next.valid_until}::date, ${next.notes})
      ON CONFLICT (restaurant_id) DO UPDATE SET plan_code = EXCLUDED.plan_code, status = EXCLUDED.status,
        valid_until = EXCLUDED.valid_until, notes = EXCLUDED.notes, updated_at = now()`;
    await audit(tx, {
      restaurantId: id.data,
      actorId: a.userId,
      actorRole: "platform",
      action: "platform.subscription.update",
      entityType: "restaurant",
      entityId: id.data,
      metadata: { from: cur?.plan_code ?? null, to: next.plan_code, status: next.status, valid_until: next.valid_until },
      ip: ctx.ip
    });
    return next;
  });
  clearFeatureCache();
  return json({ subscription: row });
}
async function usage(ctx) {
  const rows = await ctx.deps.db.as(ctx.dbContext(), (tx) => tx`
      SELECT * FROM platform_usage()`);
  const out = rows.map((r) => ({ ...r, assets_bytes: Number(r.assets_bytes), last_order_at: iso(r.last_order_at) }));
  return json({ usage: out, generated_at: new Date().toISOString(), defaults: DEFAULT_PLANS.map((p) => p.code) });
}
var billingRoutes = [
  { method: "GET", path: "/api/admin/plans", access: "platform", handler: listPlans },
  { method: "POST", path: "/api/admin/plans", access: "platform", handler: createPlan, limits: [{ name: "admin-plan", max: 30, windowMs: 60000 }] },
  { method: "PATCH", path: "/api/admin/plans/:code", access: "platform", handler: updatePlan },
  { method: "PATCH", path: "/api/admin/restaurants/:id/subscription", access: "platform", handler: updateSubscription },
  { method: "GET", path: "/api/admin/usage", access: "platform", handler: usage }
];

// server/src/modules/assets/routes.ts
import { createHash as createHash2 } from "crypto";

// server/src/lib/assets.ts
class AssetError extends Error {
}
var u32 = (b, o) => (b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24) >>> 0;
var be32 = (b, o) => (b[o] << 24 | b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3]) >>> 0;
var be16 = (b, o) => b[o] << 8 | b[o + 1];
var ascii = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));
function jpegSize(b) {
  let o = 2;
  while (o + 9 < b.length) {
    if (b[o] !== 255)
      return null;
    const marker = b[o + 1];
    if (marker === 255) {
      o += 1;
      continue;
    }
    const len = be16(b, o + 2);
    if (marker >= 192 && marker <= 207 && marker !== 196 && marker !== 200 && marker !== 204) {
      return { height: be16(b, o + 5), width: be16(b, o + 7) };
    }
    o += 2 + len;
  }
  return null;
}
function webpSize(b) {
  const fmt = ascii(b, 12, 4);
  if (fmt === "VP8 " && b.length > 30)
    return { width: (b[26] | b[27] << 8) & 16383, height: (b[28] | b[29] << 8) & 16383 };
  if (fmt === "VP8L" && b.length > 25) {
    const bits = u32(b, 21);
    return { width: (bits & 16383) + 1, height: (bits >>> 14 & 16383) + 1 };
  }
  if (fmt === "VP8X" && b.length > 30)
    return { width: (b[24] | b[25] << 8 | b[26] << 16) + 1, height: (b[27] | b[28] << 8 | b[29] << 16) + 1 };
  return null;
}
var SUPPORTED_EXTENSIONS = new Set([
  "KHR_materials_unlit",
  "KHR_materials_emissive_strength",
  "KHR_materials_clearcoat",
  "KHR_materials_sheen",
  "KHR_materials_specular",
  "KHR_materials_ior",
  "KHR_materials_transmission",
  "KHR_materials_volume",
  "KHR_materials_pbrSpecularGlossiness",
  "KHR_texture_transform",
  "KHR_mesh_quantization",
  "KHR_lights_punctual"
]);
function parseGlb(b) {
  if (b.length < 20 || ascii(b, 0, 4) !== "glTF")
    throw new AssetError("O ficheiro n\xE3o \xE9 um modelo 3D no formato GLB.");
  if (u32(b, 4) !== 2)
    throw new AssetError("S\xF3 se aceitam modelos GLB da vers\xE3o 2.");
  if (u32(b, 8) !== b.length)
    throw new AssetError("O modelo 3D est\xE1 incompleto ou danificado.");
  const jsonLen = u32(b, 12);
  if (ascii(b, 16, 4) !== "JSON" || 20 + jsonLen > b.length)
    throw new AssetError("O modelo 3D est\xE1 danificado.");
  let doc;
  try {
    doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(b.subarray(20, 20 + jsonLen)));
  } catch {
    throw new AssetError("O modelo 3D est\xE1 danificado.");
  }
  const required = Array.isArray(doc.extensionsRequired) ? doc.extensionsRequired : [];
  for (const ext of required) {
    if (typeof ext !== "string" || !SUPPORTED_EXTENSIONS.has(ext)) {
      throw new AssetError("O modelo usa compress\xE3o (Draco, Meshopt ou KTX2) que n\xE3o \xE9 suportada. Exporte o modelo GLB sem compress\xE3o.");
    }
  }
  for (const key of ["buffers", "images"]) {
    const list = doc[key];
    if (Array.isArray(list)) {
      for (const entry of list) {
        if (typeof entry?.uri === "string" && !entry.uri.startsWith("data:"))
          throw new AssetError("O modelo depende de ficheiros externos. Exporte um GLB com tudo inclu\xEDdo.");
      }
    }
  }
  if (!Array.isArray(doc.meshes) || doc.meshes.length === 0)
    throw new AssetError("O modelo 3D n\xE3o tem nenhuma forma para mostrar.");
}
function inspectAsset(bytes) {
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    const s = jpegSize(bytes);
    if (!s)
      throw new AssetError("A fotografia est\xE1 danificada.");
    return { kind: "image", contentType: "image/jpeg", ...s };
  }
  if (bytes.length >= 33 && ascii(bytes, 0, 8) === `\x89PNG\r
\x1A
` && ascii(bytes, 12, 4) === "IHDR") {
    return { kind: "image", contentType: "image/png", width: be32(bytes, 16), height: be32(bytes, 20) };
  }
  if (bytes.length >= 30 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    const s = webpSize(bytes);
    if (!s)
      throw new AssetError("A fotografia est\xE1 danificada.");
    return { kind: "image", contentType: "image/webp", ...s };
  }
  if (bytes.length >= 20 && ascii(bytes, 0, 4) === "glTF") {
    parseGlb(bytes);
    return { kind: "model", contentType: "model/gltf-binary", width: null, height: null };
  }
  throw new AssetError("Formato n\xE3o aceite. Envie fotografias JPG, PNG ou WebP, ou modelos 3D GLB.");
}
async function purgeOrphanAssets(tx, restaurantId) {
  const rows = await tx`
    DELETE FROM assets a
    WHERE a.restaurant_id = ${restaurantId}
      AND a.created_at < now() - interval '15 minutes'
      AND NOT EXISTS (SELECT 1 FROM restaurants r WHERE r.id = a.restaurant_id AND ('/a/' || a.id::text) IN (r.logo_url, r.cover_url))
      AND NOT EXISTS (SELECT 1 FROM menu_items i WHERE i.restaurant_id = a.restaurant_id AND ('/a/' || a.id::text) IN (i.image_url, i.thumb_url, i.model_url))
    RETURNING a.id`;
  return rows.length;
}

// server/src/modules/assets/routes.ts
var MAX_IMAGE_BYTES = 2 * 1024 * 1024;
var MAX_MODEL_BYTES = 12 * 1024 * 1024;
async function upload(ctx) {
  const a = ctx.auth;
  const rid = a.restaurantId;
  const bytes = await ctx.bytes(MAX_MODEL_BYTES);
  let info;
  try {
    info = inspectAsset(bytes);
  } catch (err) {
    if (err instanceof AssetError)
      throw new HttpError(422, "ASSET_INVALID", err.message);
    throw err;
  }
  if (info.kind === "image" && bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new HttpError(413, "PAYLOAD_TOO_LARGE", "A fotografia \xE9 demasiado grande (m\xE1ximo 2 MB). Escolha uma mais pequena.");
  }
  if (info.kind === "model")
    await requireFeature(ctx.deps.db, rid, "model_3d", "pratos em 3D");
  const sha256 = createHash2("sha256").update(bytes).digest("hex");
  const quota = ctx.deps.config.assetQuotaBytes;
  const row = await ctx.deps.db.as({ role: "manager", restaurantId: rid, userId: a.userId }, async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${"assets:" + rid}))`;
    const [used] = await tx`SELECT coalesce(sum(byte_size), 0)::text AS n FROM assets WHERE restaurant_id = ${rid}`;
    if (Number(used?.n ?? 0) + bytes.byteLength > quota) {
      throw new HttpError(413, "STORAGE_FULL", `O espa\xE7o de ficheiros do restaurante est\xE1 cheio (${Math.round(quota / 1048576)} MB). Apague pratos ou fotografias que j\xE1 n\xE3o usa.`);
    }
    const [r] = await tx`
      INSERT INTO assets (restaurant_id, kind, content_type, byte_size, sha256, width, height, data, created_by)
      VALUES (${rid}, ${info.kind}, ${info.contentType}, ${bytes.byteLength}, ${sha256}, ${info.width}, ${info.height}, ${bytes}, ${a.userId})
      RETURNING id`;
    await audit(tx, { restaurantId: rid, actorId: a.userId, actorRole: a.role, action: "asset.upload", entityType: "asset", entityId: r.id, metadata: { kind: info.kind, bytes: bytes.byteLength }, ip: ctx.ip });
    return r;
  });
  return created({ asset: { id: row.id, url: `/a/${row.id}`, kind: info.kind, content_type: info.contentType, byte_size: bytes.byteLength, width: info.width, height: info.height } });
}
var assetRoutes = [
  { method: "POST", path: "/api/assets", access: { roles: ["manager"] }, handler: upload, noBody: true, limits: [{ name: "asset-upload", max: 60, windowMs: 60000 }] }
];

// server/src/modules/auth/routes.ts
var invalidCredentials = () => new HttpError(401, "INVALID_CREDENTIALS", "E-mail ou palavra-passe incorretos.");
var dummyHash = null;
var getDummyHash = (logN) => dummyHash ??= hashPassword("altiora-palavra-passe-que-nunca-e-valida", logN);
async function memberships(db, userId) {
  return db.system((tx) => tx`
      SELECT m.restaurant_id, r.name AS restaurant_name, m.role, r.status
      FROM restaurant_members m JOIN restaurants r ON r.id = m.restaurant_id
      WHERE m.user_id = ${userId} AND m.active
      ORDER BY (r.status = 'ativo') DESC, r.name`);
}
async function toSessionUser(db, a) {
  const list = a.role === "platform" ? [] : await memberships(db, a.userId);
  const features = a.restaurantId && a.role !== "platform" ? [...await restaurantFeatures(db, a.restaurantId)] : [];
  return {
    id: a.userId,
    name: a.name,
    email: a.email,
    role: a.role,
    must_change_password: a.mustChangePassword,
    restaurant: a.restaurantId ? { id: a.restaurantId, name: a.restaurantName ?? "", slug: a.restaurantSlug ?? "", status: a.restaurantStatus ?? "ativo" } : null,
    memberships: list.filter((m) => m.status === "ativo").map((m) => ({ restaurant_id: m.restaurant_id, restaurant_name: m.restaurant_name, role: m.role })),
    features
  };
}
function sessionCookie(ctx, token, maxAgeSec) {
  return serializeCookie(cookieName(ctx.deps.config), token, { maxAgeSec, secure: ctx.deps.config.cookieSecure });
}
function clearCookie(ctx) {
  return serializeCookie(cookieName(ctx.deps.config), "", { maxAgeSec: 0, secure: ctx.deps.config.cookieSecure });
}
async function login(ctx) {
  const { db, config, loginThrottle, log } = ctx.deps;
  const input = await ctx.body(LoginInput);
  const email = input.email;
  const keyIpEmail = `ip-email:${ctx.ip}|${email}`;
  const keyIp = `ip:${ctx.ip}`;
  const keyEmail = `email:${email}`;
  const wait = Math.max(loginThrottle.check(keyIpEmail, 6), loginThrottle.check(keyIp, 40), loginThrottle.check(keyEmail, 25));
  if (wait > 0)
    throw tooMany("Demasiadas tentativas de in\xEDcio de sess\xE3o. Tente novamente dentro de alguns minutos.", wait, "LOGIN_LOCKED");
  const user = await db.system(async (tx) => {
    const [u] = await tx`SELECT id, email, name, password_hash, is_platform_admin, active, must_change_password FROM users WHERE email = ${email}`;
    return u ?? null;
  });
  const ok = user ? await verifyPassword(input.password, user.password_hash) : (await verifyPassword(input.password, await getDummyHash(config.scryptLogN)), false);
  if (!user || !user.active || !ok) {
    loginThrottle.fail(keyIpEmail);
    loginThrottle.fail(keyIp);
    loginThrottle.fail(keyEmail);
    if (user) {
      await db.system((tx) => audit(tx, { restaurantId: null, actorId: user.id, actorRole: null, action: "auth.login_failed", entityType: "user", entityId: user.id, ip: ctx.ip }));
    }
    log.info("in\xEDcio de sess\xE3o recusado", { request_id: ctx.requestId });
    throw invalidCredentials();
  }
  loginThrottle.success(keyIpEmail);
  loginThrottle.success(keyEmail);
  let restaurantId = null;
  let role = "platform";
  if (!user.is_platform_admin) {
    const list = await memberships(db, user.id);
    const usable = list.find((m) => m.status === "ativo");
    if (!usable) {
      throw list.length ? new HttpError(403, "RESTAURANT_SUSPENDED", "A conta do restaurante est\xE1 suspensa. Contacte a Altiora Grupo.") : new HttpError(403, "NO_MEMBERSHIP", "Esta conta n\xE3o est\xE1 associada a nenhum restaurante. Contacte o gerente.");
    }
    restaurantId = usable.restaurant_id;
    role = usable.role;
  }
  const { token, maxAgeSec } = await createSession(db, config, {
    userId: user.id,
    restaurantId,
    ip: ctx.ip,
    userAgent: ctx.req.headers.get("user-agent")
  });
  const rest = await db.system(async (tx) => {
    await tx`UPDATE users SET last_login_at = now() WHERE id = ${user.id}`;
    await audit(tx, {
      restaurantId,
      actorId: user.id,
      actorRole: role,
      action: user.is_platform_admin ? "platform.login" : "auth.login",
      entityType: "user",
      entityId: user.id,
      ip: ctx.ip
    });
    if (!restaurantId)
      return null;
    return (await tx`SELECT id, name, slug, status FROM restaurants WHERE id = ${restaurantId}`)[0] ?? null;
  });
  const auth = {
    sessionId: "",
    userId: user.id,
    email: user.email,
    name: user.name,
    role,
    mustChangePassword: user.must_change_password,
    restaurantId,
    restaurantName: rest?.name ?? null,
    restaurantSlug: rest?.slug ?? null,
    restaurantStatus: rest?.status ?? null
  };
  return json({ user: await toSessionUser(db, auth) }, 200, { "set-cookie": sessionCookie(ctx, token, maxAgeSec) });
}
async function me(ctx) {
  return json({ user: await toSessionUser(ctx.deps.db, ctx.auth) });
}
async function logout(ctx) {
  const a = ctx.auth;
  await revokeSession(ctx.deps.db, a.sessionId);
  return noContent({ "set-cookie": clearCookie(ctx) });
}
async function changePassword(ctx) {
  const { db, config, limiter } = ctx.deps;
  const a = ctx.auth;
  const input = await ctx.body(ChangePasswordInput);
  const lim = limiter.hit(`chpw:${a.userId}`, 6, 60000);
  if (!lim.ok)
    throw tooMany("Demasiadas tentativas. Aguarde um momento.", lim.retryAfterSec);
  const stored = await db.system(async (tx) => (await tx`SELECT password_hash FROM users WHERE id = ${a.userId}`)[0]);
  if (!stored || !await verifyPassword(input.current_password, stored.password_hash)) {
    throw unprocessable("A palavra-passe atual est\xE1 incorreta.", "WRONG_CURRENT_PASSWORD");
  }
  const weak = checkPasswordStrength(input.new_password, a.email);
  if (weak)
    throw unprocessable(weak, "WEAK_PASSWORD");
  if (input.new_password === input.current_password)
    throw unprocessable("A nova palavra-passe tem de ser diferente da atual.", "SAME_PASSWORD");
  const hash = await hashPassword(input.new_password, config.scryptLogN);
  await db.system(async (tx) => {
    await tx`UPDATE users SET password_hash = ${hash}, must_change_password = false WHERE id = ${a.userId}`;
    await audit(tx, { restaurantId: a.restaurantId, actorId: a.userId, actorRole: a.role, action: a.role === "platform" ? "platform.password_changed" : "auth.password_changed", entityType: "user", entityId: a.userId, ip: ctx.ip });
  });
  await revokeOtherSessions(db, a.userId, a.sessionId);
  return noContent();
}
async function switchRestaurant(ctx) {
  const { db } = ctx.deps;
  const a = ctx.auth;
  if (a.role === "platform")
    throw forbidden("Esta conta n\xE3o pertence a restaurantes.", "FORBIDDEN");
  const input = await ctx.body(SwitchRestaurantInput);
  const target = (await memberships(db, a.userId)).find((m) => m.restaurant_id === input.restaurant_id && m.status === "ativo");
  if (!target)
    throw forbidden("N\xE3o pertence a esse restaurante.", "NOT_A_MEMBER");
  const rest = await db.system(async (tx) => {
    await tx`UPDATE sessions SET restaurant_id = ${target.restaurant_id} WHERE id = ${a.sessionId}`;
    return (await tx`SELECT id, name, slug, status FROM restaurants WHERE id = ${target.restaurant_id}`)[0];
  });
  const next = { ...a, role: target.role, restaurantId: rest.id, restaurantName: rest.name, restaurantSlug: rest.slug, restaurantStatus: rest.status };
  return json({ user: await toSessionUser(db, next) });
}
var authRoutes = [
  { method: "POST", path: "/api/auth/login", access: "public", handler: login, limits: [{ name: "login", max: 30, windowMs: 60000 }] },
  { method: "GET", path: "/api/auth/me", access: "session", handler: me, allowSuspended: true, allowMustChange: true },
  { method: "POST", path: "/api/auth/logout", access: "session", handler: logout, allowSuspended: true, allowMustChange: true, noBody: true },
  { method: "POST", path: "/api/auth/change-password", access: "session", handler: changePassword, allowSuspended: true, allowMustChange: true },
  { method: "POST", path: "/api/auth/switch-restaurant", access: "session", handler: switchRestaurant, allowSuspended: true }
];

// server/src/modules/calls/routes.ts
var view = (r) => ({ ...r, created_at: iso(r.created_at), resolved_at: iso(r.resolved_at) });
async function list3(ctx) {
  const a = ctx.auth;
  const rows = await ctx.deps.db.as(ctx.dbContext(), (tx) => tx`SELECT id, table_id, table_number, table_label, status, created_at, resolved_at FROM waiter_calls
            WHERE restaurant_id = ${a.restaurantId} AND status = 'aberta' ORDER BY created_at`);
  return json({ server_time: new Date().toISOString(), calls: rows.map(view) });
}
async function attend(ctx) {
  const a = ctx.auth;
  const id = uuid.safeParse(ctx.params.id);
  if (!id.success)
    throw notFound("Chamada n\xE3o encontrada.", "CALL_NOT_FOUND");
  const out = await ctx.deps.db.as(ctx.dbContext(), async (tx) => {
    const [r] = await tx`
      UPDATE waiter_calls SET status = 'atendida', resolved_at = now(), resolved_by = ${a.userId}
      WHERE id = ${id.data} AND restaurant_id = ${a.restaurantId} AND status = 'aberta'
      RETURNING id, table_id, table_number, table_label, status, created_at, resolved_at`;
    if (!r) {
      const [exists] = await tx`SELECT 1 FROM waiter_calls WHERE id = ${id.data} AND restaurant_id = ${a.restaurantId}`;
      if (!exists)
        throw notFound("Chamada n\xE3o encontrada.", "CALL_NOT_FOUND");
      throw new HttpError(409, "CALL_ALREADY_DONE", "Esta chamada j\xE1 foi atendida ou cancelada.");
    }
    await audit(tx, { restaurantId: a.restaurantId, actorId: a.userId, actorRole: a.role, action: "waiter_call.attend", entityType: "waiter_call", entityId: r.id, metadata: { table_number: r.table_number }, ip: ctx.ip });
    return r;
  });
  ctx.deps.hub.publishRestaurant(a.restaurantId, { type: "waiter.call.done", call_id: out.id, at: new Date().toISOString() });
  return json({ call: view(out) });
}
var callRoutes = [
  { method: "GET", path: "/api/staff/waiter-calls", access: { roles: ["waiter", "manager"] }, handler: list3 },
  { method: "POST", path: "/api/staff/waiter-calls/:id/attend", access: { roles: ["waiter", "manager"] }, handler: attend, noBody: true }
];

// shared/landing.ts
var noNul2 = (s) => !s.includes("\x00");
var clean = (max) => stringType().trim().max(max).refine(noNul2, "O texto cont\xE9m caracteres inv\xE1lidos.").optional().default("");
var LeadInput = objectType({
  name: stringType().trim().min(2, "Indique o seu nome.").max(120).refine(noNul2, "O texto cont\xE9m caracteres inv\xE1lidos."),
  business: clean(160),
  phone: clean(40),
  email: clean(160),
  message: clean(1500),
  consent: literalType(true, { errorMap: () => ({ message: "Para enviar, aceite que a Altiora Grupo o contacte." }) }),
  website: clean(200)
}).strict().refine((v) => v.phone !== "" || v.email !== "", { message: "Indique um telefone ou um e-mail para lhe respondermos.", path: ["phone"] }).refine((v) => v.email === "" || stringType().email().safeParse(v.email).success, { message: "O e-mail n\xE3o parece v\xE1lido.", path: ["email"] });

// server/src/modules/leads/routes.ts
async function submit(ctx) {
  const input = await ctx.body(LeadInput);
  if (input.website !== "")
    return created({ ok: true });
  const hour = ctx.deps.limiter.hit(`lead-hour:${ctx.ip}`, 4, 3600000);
  if (!hour.ok)
    throw tooMany("J\xE1 enviou v\xE1rios pedidos. Aguarde um pouco ou contacte-nos diretamente.", hour.retryAfterSec, "RATE_LIMITED");
  const day = ctx.deps.limiter.hit("lead-day:all", 300, 86400000);
  if (!day.ok)
    throw tooMany("Recebemos muitos pedidos neste momento. Tente mais tarde.", day.retryAfterSec, "RATE_LIMITED");
  await ctx.deps.db.system((tx) => tx`INSERT INTO leads (name, business, phone, email, message) VALUES (${input.name}, ${input.business}, ${input.phone}, ${input.email}, ${input.message})`);
  return created({ ok: true });
}
var view2 = (r) => ({ ...r, created_at: iso(r.created_at) });
async function list4(ctx) {
  const rows = await ctx.deps.db.as(ctx.dbContext(), (tx) => tx`SELECT id, name, business, phone, email, message, status, created_at FROM leads ORDER BY (status = 'novo') DESC, created_at DESC LIMIT 200`);
  return json({ leads: rows.map(view2) });
}
async function update(ctx) {
  const a = ctx.auth;
  const id = uuid.safeParse(ctx.params.id);
  if (!id.success)
    throw notFound("Pedido n\xE3o encontrado.", "LEAD_NOT_FOUND");
  const input = await ctx.body(LeadUpdateInput);
  const row = await ctx.deps.db.as(ctx.dbContext(), async (tx) => {
    const [r] = await tx`
      UPDATE leads SET status = ${input.status}, handled_at = CASE WHEN ${input.status} = 'novo' THEN NULL ELSE now() END
      WHERE id = ${id.data} RETURNING id, name, business, phone, email, message, status, created_at`;
    if (!r)
      throw notFound("Pedido n\xE3o encontrado.", "LEAD_NOT_FOUND");
    await audit(tx, { restaurantId: null, actorId: a.userId, actorRole: "platform", action: "platform.lead.update", entityType: "lead", entityId: id.data, metadata: { status: input.status }, ip: ctx.ip });
    return r;
  });
  return json({ lead: view2(row) });
}
async function remove(ctx) {
  const a = ctx.auth;
  const id = uuid.safeParse(ctx.params.id);
  if (!id.success)
    throw notFound("Pedido n\xE3o encontrado.", "LEAD_NOT_FOUND");
  await ctx.deps.db.as(ctx.dbContext(), async (tx) => {
    const rows = await tx`DELETE FROM leads WHERE id = ${id.data} RETURNING id`;
    if (rows.length === 0)
      throw notFound("Pedido n\xE3o encontrado.", "LEAD_NOT_FOUND");
    await audit(tx, { restaurantId: null, actorId: a.userId, actorRole: "platform", action: "platform.lead.delete", entityType: "lead", entityId: id.data, ip: ctx.ip });
  });
  return noContent();
}
var leadRoutes = [
  { method: "POST", path: "/api/leads", access: "public", handler: submit, limits: [{ name: "lead-submit", max: 10, windowMs: 3600000 }] },
  { method: "GET", path: "/api/admin/leads", access: "platform", handler: list4 },
  { method: "PATCH", path: "/api/admin/leads/:id", access: "platform", handler: update },
  { method: "DELETE", path: "/api/admin/leads/:id", access: "platform", handler: remove }
];

// server/src/modules/menu/routes.ts
var staffRoles = ["manager", "waiter", "kitchen"];
function who(ctx) {
  const a = ctx.auth;
  return { role: a.role, restaurantId: a.restaurantId, userId: a.userId };
}
function notifyMenuChanged(ctx, restaurantId) {
  ctx.deps.hub.publishRestaurant(restaurantId, { type: "menu.changed", at: new Date().toISOString() });
}
function idParam(ctx, what, code) {
  const id = uuid.safeParse(ctx.params.id);
  if (!id.success)
    throw notFound(`${what} n\xE3o encontrado.`, code);
  return id.data;
}
var CAT_COLS = "id, name, display_order, active";
var ITEM_COLS = "id, category_id, name, description, image_url, thumb_url, model_url, ingredients, allergens, price_cents, available, active, display_order";
var OPT_COLS = "id, menu_item_id, name, price_delta_cents, kind, active, display_order";
var itemView = (r, options = []) => ({
  id: r.id,
  category_id: r.category_id,
  name: r.name,
  description: r.description,
  image_url: r.image_url,
  thumb_url: r.thumb_url,
  model_url: r.model_url,
  ingredients: r.ingredients,
  allergens: r.allergens,
  price_cents: num(r.price_cents),
  available: r.available,
  active: r.active,
  display_order: r.display_order,
  options
});
var optionView = (r) => ({
  id: r.id,
  name: r.name,
  price_delta_cents: num(r.price_delta_cents),
  kind: r.kind,
  active: r.active,
  display_order: r.display_order
});
async function loadMenu(tx, restaurantId) {
  const cats = await tx`SELECT id, name, display_order, active FROM categories WHERE restaurant_id = ${restaurantId} ORDER BY display_order, lower(name)`;
  const items = await tx`
    SELECT id, category_id, name, description, image_url, thumb_url, model_url, ingredients, allergens, price_cents, available, active, display_order
    FROM menu_items WHERE restaurant_id = ${restaurantId} ORDER BY display_order, lower(name)`;
  const opts = await tx`
    SELECT id, menu_item_id, name, price_delta_cents, kind, active, display_order
    FROM menu_item_options WHERE restaurant_id = ${restaurantId} ORDER BY display_order, kind DESC, lower(name)`;
  const optsByItem = new Map;
  for (const o of opts) {
    const list = optsByItem.get(o.menu_item_id) ?? [];
    list.push(optionView(o));
    optsByItem.set(o.menu_item_id, list);
  }
  const categories = cats.map((c) => ({
    id: c.id,
    name: c.name,
    display_order: c.display_order,
    active: c.active,
    items: items.filter((i) => i.category_id === c.id).map((i) => itemView(i, optsByItem.get(i.id) ?? []))
  }));
  return { categories };
}
async function getMenu(ctx) {
  const a = who(ctx);
  const menu = await ctx.deps.db.as({ role: a.role, restaurantId: a.restaurantId, userId: a.userId }, (tx) => loadMenu(tx, a.restaurantId));
  return json(menu);
}
async function createCategory(ctx) {
  const a = who(ctx);
  const input = await ctx.body(CategoryInput);
  const row = await ctx.deps.db.as({ role: "manager", restaurantId: a.restaurantId, userId: a.userId }, async (tx) => {
    const [r] = await tx`
      INSERT INTO categories (restaurant_id, name, display_order, active)
      VALUES (${a.restaurantId}, ${input.name}, ${input.display_order}, ${input.active})
      RETURNING id, name, display_order, active`;
    await audit(tx, { restaurantId: a.restaurantId, actorId: a.userId, actorRole: a.role, action: "menu.category.create", entityType: "category", entityId: r.id, metadata: { name: input.name }, ip: ctx.ip });
    return r;
  });
  notifyMenuChanged(ctx, a.restaurantId);
  return created({ category: { ...row, items: [] } });
}
async function updateCategory(ctx) {
  const a = who(ctx);
  const id = idParam(ctx, "Categoria", "CATEGORY_NOT_FOUND");
  const input = await ctx.body(CategoryUpdateInput);
  const row = await ctx.deps.db.as({ role: "manager", restaurantId: a.restaurantId, userId: a.userId }, async (tx) => {
    const r = await updatePartial(tx, "categories", {
      columns: ["name", "display_order", "active"],
      where: "id = $1 AND restaurant_id = $2",
      whereParams: [id, a.restaurantId],
      returning: CAT_COLS
    }, input);
    if (!r)
      throw notFound("Categoria n\xE3o encontrada.", "CATEGORY_NOT_FOUND");
    await audit(tx, { restaurantId: a.restaurantId, actorId: a.userId, actorRole: a.role, action: "menu.category.update", entityType: "category", entityId: id, metadata: { fields: Object.keys(input) }, ip: ctx.ip });
    return r;
  });
  notifyMenuChanged(ctx, a.restaurantId);
  return json({ category: row });
}
async function deleteCategory(ctx) {
  const a = who(ctx);
  const id = idParam(ctx, "Categoria", "CATEGORY_NOT_FOUND");
  await ctx.deps.db.as({ role: "manager", restaurantId: a.restaurantId, userId: a.userId }, async (tx) => {
    const [c] = await tx`SELECT count(*)::int AS n FROM menu_items WHERE category_id = ${id} AND restaurant_id = ${a.restaurantId}`;
    if ((c?.n ?? 0) > 0)
      throw conflict("Esta categoria ainda tem pratos. Mova ou apague os pratos primeiro (ou desative a categoria).", "CATEGORY_NOT_EMPTY");
    const rows = await tx`DELETE FROM categories WHERE id = ${id} AND restaurant_id = ${a.restaurantId} RETURNING id`;
    if (rows.length === 0)
      throw notFound("Categoria n\xE3o encontrada.", "CATEGORY_NOT_FOUND");
    await audit(tx, { restaurantId: a.restaurantId, actorId: a.userId, actorRole: a.role, action: "menu.category.delete", entityType: "category", entityId: id, ip: ctx.ip });
  });
  notifyMenuChanged(ctx, a.restaurantId);
  return noContent();
}
async function createItem(ctx) {
  const a = who(ctx);
  const input = await ctx.body(MenuItemInput);
  if (input.model_url)
    await requireFeature(ctx.deps.db, a.restaurantId, "model_3d", "pratos em 3D");
  const row = await ctx.deps.db.as({ role: "manager", restaurantId: a.restaurantId, userId: a.userId }, async (tx) => {
    const [cat] = await tx`SELECT 1 FROM categories WHERE id = ${input.category_id} AND restaurant_id = ${a.restaurantId}`;
    if (!cat)
      throw notFound("Categoria n\xE3o encontrada.", "CATEGORY_NOT_FOUND");
    const [r] = await tx`
      INSERT INTO menu_items (restaurant_id, category_id, name, description, image_url, thumb_url, model_url, ingredients, allergens,
                              price_cents, available, active, display_order)
      VALUES (${a.restaurantId}, ${input.category_id}, ${input.name}, ${input.description}, ${input.image_url}, ${input.thumb_url}, ${input.model_url},
              ${input.ingredients}::text[], ${input.allergens}::text[],
              ${input.price_cents}, ${input.available}, ${input.active}, ${input.display_order})
      RETURNING id, category_id, name, description, image_url, thumb_url, model_url, ingredients, allergens, price_cents, available, active, display_order`;
    await audit(tx, { restaurantId: a.restaurantId, actorId: a.userId, actorRole: a.role, action: "menu.item.create", entityType: "menu_item", entityId: r.id, metadata: { name: input.name, price_cents: input.price_cents }, ip: ctx.ip });
    return r;
  });
  notifyMenuChanged(ctx, a.restaurantId);
  return created({ item: itemView(row) });
}
async function updateItem(ctx) {
  const a = who(ctx);
  const id = idParam(ctx, "Prato", "ITEM_NOT_FOUND");
  const input = await ctx.body(MenuItemUpdateInput);
  if (input.model_url)
    await requireFeature(ctx.deps.db, a.restaurantId, "model_3d", "pratos em 3D");
  const row = await ctx.deps.db.as({ role: "manager", restaurantId: a.restaurantId, userId: a.userId }, async (tx) => {
    if (input.category_id) {
      const [cat] = await tx`SELECT 1 FROM categories WHERE id = ${input.category_id} AND restaurant_id = ${a.restaurantId}`;
      if (!cat)
        throw notFound("Categoria n\xE3o encontrada.", "CATEGORY_NOT_FOUND");
    }
    const [before] = await tx`SELECT price_cents FROM menu_items WHERE id = ${id} AND restaurant_id = ${a.restaurantId} FOR UPDATE`;
    if (!before)
      throw notFound("Prato n\xE3o encontrado.", "ITEM_NOT_FOUND");
    const r = await updatePartial(tx, "menu_items", {
      columns: ["category_id", "name", "description", "image_url", "thumb_url", "model_url", "ingredients", "allergens", "price_cents", "available", "active", "display_order"],
      where: "id = $1 AND restaurant_id = $2",
      whereParams: [id, a.restaurantId],
      returning: ITEM_COLS
    }, input);
    if (!r)
      throw notFound("Prato n\xE3o encontrado.", "ITEM_NOT_FOUND");
    await purgeOrphanAssets(tx, a.restaurantId);
    const meta = { fields: Object.keys(input) };
    if (input.price_cents !== undefined && input.price_cents !== num(before.price_cents))
      meta.price_change = { from: num(before.price_cents), to: input.price_cents };
    await audit(tx, { restaurantId: a.restaurantId, actorId: a.userId, actorRole: a.role, action: "menu.item.update", entityType: "menu_item", entityId: id, metadata: meta, ip: ctx.ip });
    return r;
  });
  notifyMenuChanged(ctx, a.restaurantId);
  return json({ item: itemView(row) });
}
async function setAvailability(ctx) {
  const a = who(ctx);
  const id = idParam(ctx, "Prato", "ITEM_NOT_FOUND");
  const input = await ctx.body(AvailabilityInput);
  const row = await ctx.deps.db.as({ role: a.role, restaurantId: a.restaurantId, userId: a.userId }, async (tx) => {
    const [r] = await tx`
      UPDATE menu_items SET available = ${input.available}
      WHERE id = ${id} AND restaurant_id = ${a.restaurantId}
      RETURNING id, category_id, name, description, image_url, thumb_url, model_url, ingredients, allergens, price_cents, available, active, display_order`;
    if (!r)
      throw notFound("Prato n\xE3o encontrado.", "ITEM_NOT_FOUND");
    await audit(tx, { restaurantId: a.restaurantId, actorId: a.userId, actorRole: a.role, action: "menu.item.availability", entityType: "menu_item", entityId: id, metadata: { available: input.available }, ip: ctx.ip });
    return r;
  });
  notifyMenuChanged(ctx, a.restaurantId);
  return json({ item: itemView(row) });
}
async function deleteItem(ctx) {
  const a = who(ctx);
  const id = idParam(ctx, "Prato", "ITEM_NOT_FOUND");
  await ctx.deps.db.as({ role: "manager", restaurantId: a.restaurantId, userId: a.userId }, async (tx) => {
    const rows = await tx`DELETE FROM menu_items WHERE id = ${id} AND restaurant_id = ${a.restaurantId} RETURNING id`;
    if (rows.length === 0)
      throw notFound("Prato n\xE3o encontrado.", "ITEM_NOT_FOUND");
    await purgeOrphanAssets(tx, a.restaurantId);
    await audit(tx, { restaurantId: a.restaurantId, actorId: a.userId, actorRole: a.role, action: "menu.item.delete", entityType: "menu_item", entityId: id, ip: ctx.ip });
  });
  notifyMenuChanged(ctx, a.restaurantId);
  return noContent();
}
async function createOption(ctx) {
  const a = who(ctx);
  const itemId = idParam(ctx, "Prato", "ITEM_NOT_FOUND");
  const input = await ctx.body(OptionInput);
  const row = await ctx.deps.db.as({ role: "manager", restaurantId: a.restaurantId, userId: a.userId }, async (tx) => {
    const [item] = await tx`SELECT 1 FROM menu_items WHERE id = ${itemId} AND restaurant_id = ${a.restaurantId}`;
    if (!item)
      throw notFound("Prato n\xE3o encontrado.", "ITEM_NOT_FOUND");
    const [r] = await tx`
      INSERT INTO menu_item_options (restaurant_id, menu_item_id, name, price_delta_cents, kind, active, display_order)
      VALUES (${a.restaurantId}, ${itemId}, ${input.name}, ${input.price_delta_cents}, ${input.kind}, ${input.active}, ${input.display_order})
      RETURNING id, menu_item_id, name, price_delta_cents, kind, active, display_order`;
    await audit(tx, { restaurantId: a.restaurantId, actorId: a.userId, actorRole: a.role, action: "menu.option.create", entityType: "menu_option", entityId: r.id, metadata: { name: input.name }, ip: ctx.ip });
    return r;
  });
  notifyMenuChanged(ctx, a.restaurantId);
  return created({ option: optionView(row) });
}
async function updateOption(ctx) {
  const a = who(ctx);
  const id = idParam(ctx, "Extra", "OPTION_NOT_FOUND");
  const input = await ctx.body(OptionUpdateInput);
  const row = await ctx.deps.db.as({ role: "manager", restaurantId: a.restaurantId, userId: a.userId }, async (tx) => {
    const r = await updatePartial(tx, "menu_item_options", {
      columns: ["name", "price_delta_cents", "kind", "active", "display_order"],
      where: "id = $1 AND restaurant_id = $2",
      whereParams: [id, a.restaurantId],
      returning: OPT_COLS
    }, input);
    if (!r)
      throw notFound("Extra n\xE3o encontrado.", "OPTION_NOT_FOUND");
    await audit(tx, { restaurantId: a.restaurantId, actorId: a.userId, actorRole: a.role, action: "menu.option.update", entityType: "menu_option", entityId: id, metadata: { fields: Object.keys(input) }, ip: ctx.ip });
    return r;
  });
  notifyMenuChanged(ctx, a.restaurantId);
  return json({ option: optionView(row) });
}
async function deleteOption(ctx) {
  const a = who(ctx);
  const id = idParam(ctx, "Extra", "OPTION_NOT_FOUND");
  await ctx.deps.db.as({ role: "manager", restaurantId: a.restaurantId, userId: a.userId }, async (tx) => {
    const rows = await tx`DELETE FROM menu_item_options WHERE id = ${id} AND restaurant_id = ${a.restaurantId} RETURNING id`;
    if (rows.length === 0)
      throw notFound("Extra n\xE3o encontrado.", "OPTION_NOT_FOUND");
    await audit(tx, { restaurantId: a.restaurantId, actorId: a.userId, actorRole: a.role, action: "menu.option.delete", entityType: "menu_option", entityId: id, ip: ctx.ip });
  });
  notifyMenuChanged(ctx, a.restaurantId);
  return noContent();
}
var menuRoutes = [
  { method: "GET", path: "/api/menu", access: { roles: staffRoles }, handler: getMenu },
  { method: "POST", path: "/api/menu/categories", access: { roles: ["manager"] }, handler: createCategory },
  { method: "PATCH", path: "/api/menu/categories/:id", access: { roles: ["manager"] }, handler: updateCategory },
  { method: "DELETE", path: "/api/menu/categories/:id", access: { roles: ["manager"] }, handler: deleteCategory, noBody: true },
  { method: "POST", path: "/api/menu/items", access: { roles: ["manager"] }, handler: createItem },
  { method: "PATCH", path: "/api/menu/items/:id", access: { roles: ["manager"] }, handler: updateItem },
  { method: "DELETE", path: "/api/menu/items/:id", access: { roles: ["manager"] }, handler: deleteItem, noBody: true },
  { method: "PATCH", path: "/api/menu/items/:id/availability", access: { roles: ["kitchen", "manager"] }, handler: setAvailability },
  { method: "POST", path: "/api/menu/items/:id/options", access: { roles: ["manager"] }, handler: createOption },
  { method: "PATCH", path: "/api/menu/options/:id", access: { roles: ["manager"] }, handler: updateOption },
  { method: "DELETE", path: "/api/menu/options/:id", access: { roles: ["manager"] }, handler: deleteOption, noBody: true }
];

// server/src/modules/orders/service.ts
import { randomUUID } from "crypto";
async function priceOrder(tx, restaurantId, input, feeBps, limits) {
  const itemIds = [...new Set(input.items.map((i) => i.menu_item_id))];
  const optionIds = [...new Set(input.items.flatMap((i) => i.options.map((o) => o.option_id)))];
  const items = await tx`
    SELECT m.id, m.name, m.price_cents, m.available, (m.active AND c.active) AS active
    FROM menu_items m
    JOIN categories c ON c.id = m.category_id AND c.restaurant_id = m.restaurant_id
    WHERE m.restaurant_id = ${restaurantId} AND m.id = ANY(${itemIds}::uuid[])`;
  const itemById = new Map(items.map((r) => [r.id, r]));
  const options = optionIds.length ? await tx`
        SELECT id, menu_item_id, name, price_delta_cents, active, kind FROM menu_item_options
        WHERE restaurant_id = ${restaurantId} AND id = ANY(${optionIds}::uuid[])` : [];
  const optionById = new Map(options.map((r) => [r.id, r]));
  const sizeRows = await tx`
    SELECT DISTINCT menu_item_id FROM menu_item_options
    WHERE restaurant_id = ${restaurantId} AND kind = 'size' AND active AND menu_item_id = ANY(${itemIds}::uuid[])`;
  const itemsWithSizes = new Set(sizeRows.map((r) => r.menu_item_id));
  const unavailable = new Map;
  const lines = [];
  let subtotal = 0n;
  input.items.forEach((line, index) => {
    const item = itemById.get(line.menu_item_id);
    if (!item || !item.active) {
      throw unprocessable("Um dos itens do pedido j\xE1 n\xE3o existe no menu.", "ITEM_NOT_FOUND", { menu_item_id: line.menu_item_id });
    }
    if (!item.available)
      unavailable.set(item.id, item.name);
    const merged = new Map;
    for (const o of line.options)
      merged.set(o.option_id, (merged.get(o.option_id) ?? 0) + o.quantity);
    const priced = [];
    let optionsPerUnit = 0n;
    let sizesChosen = 0;
    for (const [optionId, quantity] of merged) {
      const opt = optionById.get(optionId);
      if (!opt || !opt.active || opt.menu_item_id !== item.id) {
        throw unprocessable("Um dos extras escolhidos j\xE1 n\xE3o est\xE1 dispon\xEDvel.", "OPTION_NOT_FOUND", { option_id: optionId });
      }
      if (quantity > 10)
        throw unprocessable("Quantidade de extras demasiado alta.", "OPTION_QUANTITY");
      if (opt.kind === "size") {
        sizesChosen += 1;
        if (quantity !== 1)
          throw unprocessable("S\xF3 se pode escolher um tamanho por prato.", "SIZE_ONE", { menu_item_id: item.id });
      }
      const delta = BigInt(opt.price_delta_cents);
      priced.push({ optionId, name: opt.name, deltaCents: delta, quantity });
      optionsPerUnit += delta * BigInt(quantity);
    }
    if (itemsWithSizes.has(item.id) && sizesChosen !== 1) {
      throw unprocessable(`Escolha o tamanho de ${item.name}.`, "SIZE_REQUIRED", { menu_item_id: item.id });
    }
    if (!itemsWithSizes.has(item.id) && sizesChosen > 0) {
      throw unprocessable("Um dos tamanhos escolhidos j\xE1 n\xE3o est\xE1 dispon\xEDvel.", "OPTION_NOT_FOUND", { menu_item_id: item.id });
    }
    const base = BigInt(item.price_cents);
    const lineTotal = (base + optionsPerUnit) * BigInt(line.quantity);
    subtotal += lineTotal;
    if (subtotal > BigInt(limits.maxOrderTotalCents)) {
      throw unprocessable("O valor do pedido excede o limite permitido.", "ORDER_TOO_LARGE");
    }
    lines.push({
      id: randomUUID(),
      menuItemId: item.id,
      name: item.name,
      basePriceCents: base,
      quantity: line.quantity,
      notes: line.notes,
      lineTotalCents: lineTotal,
      position: index,
      options: priced
    });
  });
  if (unavailable.size > 0) {
    throw conflict("Alguns itens esgotaram entretanto. Remova-os do pedido para continuar.", "ITEM_UNAVAILABLE", {
      items: [...unavailable].map(([id, name]) => ({ id, name }))
    });
  }
  const fee = serviceFeeCents(subtotal, feeBps);
  return { lines, subtotalCents: subtotal, serviceFeeCents: fee, totalCents: subtotal + fee };
}
async function insertOrder(tx, p) {
  const money = [p.priced.subtotalCents.toString(), p.priced.serviceFeeCents.toString(), p.priced.totalCents.toString()];
  let rows;
  if (p.source === "qr") {
    rows = await tx`
      INSERT INTO orders (restaurant_id, table_id, table_session_id, public_code, status, source,
                          subtotal_cents, service_fee_cents, total_cents, notes, idempotency_key)
      VALUES (${p.restaurantId}, ${p.tableId}, ${p.tableSessionId}, ${p.publicCode}, 'novo', 'qr',
              ${money[0]}, ${money[1]}, ${money[2]}, ${p.notes}, ${p.idempotencyKey})
      RETURNING id`;
  } else {
    rows = await tx`
      INSERT INTO orders (restaurant_id, table_id, table_session_id, public_code, status, source, created_by,
                          subtotal_cents, service_fee_cents, total_cents, notes, idempotency_key)
      VALUES (${p.restaurantId}, ${p.tableId}, ${p.tableSessionId}, ${p.publicCode}, 'novo', 'staff', ${p.createdBy},
              ${money[0]}, ${money[1]}, ${money[2]}, ${p.notes}, ${p.idempotencyKey})
      RETURNING id`;
  }
  const orderId = rows[0].id;
  const itemsJson = JSON.stringify(p.priced.lines.map((l) => ({
    id: l.id,
    menu_item_id: l.menuItemId,
    name: l.name,
    price: Number(l.basePriceCents),
    qty: l.quantity,
    notes: l.notes,
    total: Number(l.lineTotalCents),
    pos: l.position
  })));
  await tx.unsafe(`INSERT INTO order_items (id, restaurant_id, order_id, menu_item_id, item_name_snapshot, unit_price_snapshot_cents,
                              quantity, notes, line_total_cents, position)
     SELECT x.id, $1::uuid, $2::uuid, x.menu_item_id, x.name, x.price, x.qty, x.notes, x.total, x.pos
     FROM jsonb_to_recordset($3::text::jsonb)
       AS x(id uuid, menu_item_id uuid, name text, price bigint, qty int, notes text, total bigint, pos int)`, [p.restaurantId, orderId, itemsJson]);
  const optionRows = p.priced.lines.flatMap((l) => l.options.map((o) => ({ order_item_id: l.id, option_id: o.optionId, name: o.name, delta: Number(o.deltaCents), qty: o.quantity })));
  if (optionRows.length > 0) {
    await tx.unsafe(`INSERT INTO order_item_options (restaurant_id, order_item_id, option_id, option_name_snapshot, price_delta_snapshot_cents, quantity)
       SELECT $1::uuid, x.order_item_id, x.option_id, x.name, x.delta, x.qty
       FROM jsonb_to_recordset($2::text::jsonb) AS x(order_item_id uuid, option_id uuid, name text, delta bigint, qty int)`, [p.restaurantId, JSON.stringify(optionRows)]);
  }
  return { id: orderId };
}
async function loadItems(tx, orderIds) {
  const byOrder = new Map;
  if (orderIds.length === 0)
    return byOrder;
  const items = await tx`
    SELECT i.id, i.order_id, i.item_name_snapshot AS name, i.unit_price_snapshot_cents, i.quantity, i.notes, i.line_total_cents
    FROM order_items i WHERE i.order_id = ANY(${orderIds}::uuid[]) ORDER BY i.position, i.id`;
  const itemIds = items.map((i) => i.id);
  const options = itemIds.length ? await tx`
        SELECT o.order_item_id, o.option_name_snapshot AS name, o.price_delta_snapshot_cents, o.quantity
        FROM order_item_options o WHERE o.order_item_id = ANY(${itemIds}::uuid[]) ORDER BY o.option_name_snapshot` : [];
  const optsByItem = new Map;
  for (const o of options) {
    const list = optsByItem.get(o.order_item_id) ?? [];
    list.push({ name: o.name, quantity: o.quantity, price_delta_cents: num(o.price_delta_snapshot_cents) });
    optsByItem.set(o.order_item_id, list);
  }
  for (const i of items) {
    const list = byOrder.get(i.order_id) ?? [];
    list.push({
      id: i.id,
      name: i.name,
      quantity: i.quantity,
      unit_price_cents: num(i.unit_price_snapshot_cents),
      line_total_cents: num(i.line_total_cents),
      notes: i.notes,
      options: optsByItem.get(i.id) ?? []
    });
    byOrder.set(i.order_id, list);
  }
  return byOrder;
}
var STAFF_COLUMNS = `o.id, o.order_number, o.order_day, o.table_id, o.table_number, o.table_label, o.status, o.source,
  o.subtotal_cents, o.service_fee_cents, o.total_cents, o.notes, o.created_at, o.updated_at,
  o.preparing_at, o.ready_at, o.delivered_at, o.cancelled_at, o.cancel_reason`;
function dayString(v) {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}
async function listOrders(tx, restaurantId, f) {
  const params = [restaurantId];
  const where = ["o.restaurant_id = $1"];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replace("?", `$${params.length}`));
  };
  if (f.statuses?.length)
    add("o.status = ANY(?::text[])", f.statuses);
  if (f.since)
    add("o.created_at >= ?::timestamptz", f.since.toISOString());
  if (f.before)
    add("o.created_at < ?::timestamptz", f.before.toISOString());
  if (f.tableId)
    add("o.table_id = ?::uuid", f.tableId);
  if (f.unpaid) {
    where.push("o.status <> 'cancelado'");
    where.push("NOT EXISTS (SELECT 1 FROM payments x WHERE x.order_id = o.id AND x.status = 'isento')");
    where.push("o.total_cents > coalesce((SELECT sum(x.amount_cents) FROM payments x WHERE x.order_id = o.id AND x.status = 'pago'), 0)");
  }
  params.push(f.limit);
  const sql = `SELECT ${STAFF_COLUMNS} FROM orders o WHERE ${where.join(" AND ")}
               ORDER BY o.created_at ${f.direction === "asc" ? "ASC" : "DESC"}, o.order_number ${f.direction === "asc" ? "ASC" : "DESC"}
               LIMIT $${params.length}`;
  const rows = await tx.unsafe(sql, params);
  const items = await loadItems(tx, rows.map((r) => r.id));
  const views = rows.map((r) => toStaffView(r, items.get(r.id) ?? []));
  await attachPayments(tx, views);
  return views;
}
async function attachPayments(tx, orders) {
  if (orders.length === 0 || tx.role !== "manager" && tx.role !== "waiter")
    return;
  const rows = await tx`
    SELECT order_id, status, amount_cents FROM payments WHERE order_id = ANY(${orders.map((o) => o.id)}::uuid[])`;
  const byOrder = new Map;
  for (const p of rows) {
    const list = byOrder.get(p.order_id) ?? [];
    list.push({ status: p.status, amount_cents: num(p.amount_cents) });
    byOrder.set(p.order_id, list);
  }
  for (const o of orders)
    o.payment = summarizePayments(o.total_cents, byOrder.get(o.id) ?? []);
}
async function getOrder(tx, restaurantId, orderId) {
  const rows = await tx.unsafe(`SELECT ${STAFF_COLUMNS} FROM orders o WHERE o.restaurant_id = $1 AND o.id = $2`, [restaurantId, orderId]);
  if (!rows[0])
    return null;
  const items = await loadItems(tx, [orderId]);
  const view = toStaffView(rows[0], items.get(orderId) ?? []);
  await attachPayments(tx, [view]);
  return view;
}
function toStaffView(r, items) {
  return {
    id: r.id,
    order_number: r.order_number,
    order_day: dayString(r.order_day),
    table_id: r.table_id,
    table_number: r.table_number,
    table_label: r.table_label,
    status: r.status,
    source: r.source,
    subtotal_cents: num(r.subtotal_cents),
    service_fee_cents: num(r.service_fee_cents),
    total_cents: num(r.total_cents),
    notes: r.notes,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
    preparing_at: iso(r.preparing_at),
    ready_at: iso(r.ready_at),
    delivered_at: iso(r.delivered_at),
    cancelled_at: iso(r.cancelled_at),
    payment: null,
    cancel_reason: r.cancel_reason,
    items
  };
}
async function loadPublicOrder(tx, restaurantId, publicCode) {
  const rows = await tx`
    SELECT o.id, o.order_number, o.public_code, o.status, o.table_number, o.table_label, r.name AS restaurant_name, r.accent_color,
           o.subtotal_cents, o.service_fee_cents, o.total_cents, o.notes, o.created_at, o.updated_at,
           o.preparing_at, o.ready_at, o.delivered_at, o.cancelled_at
    FROM orders o JOIN restaurants r ON r.id = o.restaurant_id
    WHERE o.restaurant_id = ${restaurantId} AND o.public_code = ${publicCode}`;
  const r = rows[0];
  if (!r)
    return null;
  const items = await loadItems(tx, [r.id]);
  return {
    order_number: r.order_number,
    public_code: r.public_code,
    status: r.status,
    table_number: r.table_number,
    table_label: r.table_label,
    restaurant_name: r.restaurant_name,
    accent_color: r.accent_color,
    subtotal_cents: num(r.subtotal_cents),
    service_fee_cents: num(r.service_fee_cents),
    total_cents: num(r.total_cents),
    notes: r.notes,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
    preparing_at: iso(r.preparing_at),
    ready_at: iso(r.ready_at),
    delivered_at: iso(r.delivered_at),
    cancelled_at: iso(r.cancelled_at),
    items: items.get(r.id) ?? []
  };
}
async function listSessionOrders(tx, restaurantId) {
  const rows = await tx`
    SELECT order_number, public_code, status, total_cents, created_at FROM orders
    WHERE restaurant_id = ${restaurantId} ORDER BY created_at DESC LIMIT 30`;
  return rows.map((r) => ({
    order_number: r.order_number,
    public_code: r.public_code,
    status: r.status,
    total_cents: num(r.total_cents),
    created_at: iso(r.created_at)
  }));
}

// server/src/modules/orders/table-sessions.ts
async function currentSessionId(tx, t, ttlMinutes) {
  const [s] = await tx`
    SELECT id FROM table_sessions
    WHERE restaurant_id = ${t.restaurantId} AND table_id = ${t.tableId} AND closed_at IS NULL
      AND last_activity_at > now() - make_interval(mins => ${ttlMinutes})`;
  return s?.id ?? null;
}
async function ensureTableSession(tx, t, ttlMinutes) {
  const [open] = await tx`
    SELECT id, last_activity_at < now() - make_interval(mins => ${ttlMinutes}) AS stale
    FROM table_sessions
    WHERE restaurant_id = ${t.restaurantId} AND table_id = ${t.tableId} AND closed_at IS NULL
    FOR UPDATE`;
  if (open && !open.stale) {
    await tx`UPDATE table_sessions SET last_activity_at = now() WHERE id = ${open.id}`;
    return open.id;
  }
  if (open)
    await tx`UPDATE table_sessions SET closed_at = now(), close_reason = 'expirada' WHERE id = ${open.id}`;
  const [created] = await tx`
    INSERT INTO table_sessions (restaurant_id, table_id) VALUES (${t.restaurantId}, ${t.tableId})
    ON CONFLICT (table_id) WHERE closed_at IS NULL DO NOTHING
    RETURNING id`;
  if (created)
    return created.id;
  const [again] = await tx`
    SELECT id FROM table_sessions
    WHERE restaurant_id = ${t.restaurantId} AND table_id = ${t.tableId} AND closed_at IS NULL
    FOR UPDATE`;
  return again.id;
}

// server/src/modules/orders/routes.ts
var staffRoles2 = ["manager", "waiter", "kitchen"];
function staffAuth(ctx) {
  const a = ctx.auth;
  return { role: a.role, restaurantId: a.restaurantId, userId: a.userId };
}
var ListQuery = objectType({
  scope: enumType(["active", "history"]).default("active"),
  status: stringType().optional(),
  limit: coerce.number().int().min(1).max(200).default(100),
  before: stringType().datetime().optional(),
  table_id: uuid.optional(),
  unpaid: enumType(["1"]).optional()
});
async function list5(ctx) {
  const parsed = ListQuery.safeParse(Object.fromEntries(ctx.url.searchParams));
  if (!parsed.success)
    throw badRequest("Par\xE2metros de pesquisa inv\xE1lidos.", parsed.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })), "VALIDATION_ERROR");
  const q = parsed.data;
  const a = staffAuth(ctx);
  if (q.unpaid && a.role === "kitchen")
    throw forbidden("A cozinha n\xE3o tem acesso a pagamentos.", "FORBIDDEN");
  let statuses;
  if (q.status) {
    statuses = q.status.split(",").map((s) => s.trim()).filter((s) => ORDER_STATUSES.includes(s));
    if (statuses.length === 0)
      throw badRequest("Estado inv\xE1lido.", undefined, "VALIDATION_ERROR");
  } else if (q.unpaid) {
    statuses = [...ACTIVE_STATUSES, "entregue"];
  } else {
    statuses = q.scope === "active" ? [...ACTIVE_STATUSES] : ["entregue", "cancelado"];
  }
  const orders = await ctx.deps.db.as({ role: a.role, restaurantId: a.restaurantId, userId: a.userId }, (tx) => listOrders(tx, a.restaurantId, {
    statuses,
    before: q.before ? new Date(q.before) : undefined,
    tableId: q.table_id,
    unpaid: q.unpaid === "1",
    limit: q.limit,
    direction: q.scope === "active" && !q.unpaid ? "asc" : "desc"
  }));
  return json({ server_time: new Date().toISOString(), orders });
}
async function detail(ctx) {
  const id = uuid.safeParse(ctx.params.id);
  if (!id.success)
    throw notFound("Pedido n\xE3o encontrado.", "ORDER_NOT_FOUND");
  const a = staffAuth(ctx);
  const result = await ctx.deps.db.as({ role: a.role, restaurantId: a.restaurantId, userId: a.userId }, async (tx) => {
    const order = await getOrder(tx, a.restaurantId, id.data);
    if (!order)
      return null;
    const history = await tx`
      SELECT previous_status, new_status, changed_by_role, reason, created_at
      FROM order_status_history WHERE order_id = ${id.data} ORDER BY id`;
    return {
      order,
      history: history.map((h) => ({ ...h, created_at: iso(h.created_at) }))
    };
  });
  if (!result)
    throw notFound("Pedido n\xE3o encontrado.", "ORDER_NOT_FOUND");
  return json(result);
}
var IDEMPOTENCY_RE = /^[A-Za-z0-9_-]{16,100}$/;
async function createManual(ctx) {
  const a = staffAuth(ctx);
  await requireFeature(ctx.deps.db, a.restaurantId, "orders", "pedidos digitais");
  const rawKey = ctx.req.headers.get("idempotency-key");
  let key = null;
  if (rawKey !== null && rawKey !== "") {
    if (!IDEMPOTENCY_RE.test(rawKey))
      throw badRequest("Idempotency-Key inv\xE1lida (16 a 100 caracteres: letras, n\xFAmeros, - e _).", undefined, "IDEMPOTENCY_KEY_INVALID");
    key = rawKey;
  }
  const input = await ctx.body(StaffCreateOrderInput);
  const { limits, tableSessionMinutes } = ctx.deps.config;
  const attempt = () => ctx.deps.db.as({ role: a.role, restaurantId: a.restaurantId, userId: a.userId }, async (tx) => {
    if (key) {
      await lockIdempotencyKey(tx, a.restaurantId, key);
      const [prior] = await tx`
          SELECT id, source, created_by FROM orders WHERE restaurant_id = ${a.restaurantId} AND idempotency_key = ${key}`;
      if (prior) {
        if (prior.source !== "staff" || prior.created_by !== a.userId)
          throw conflict("Esta chave j\xE1 foi usada por outro pedido.", "IDEMPOTENCY_KEY_REUSED");
        const existing = await getOrder(tx, a.restaurantId, prior.id);
        return { order: existing, tableNumber: existing.table_number, replayed: true };
      }
    }
    const [table] = await tx`
        SELECT id, table_number, active FROM restaurant_tables WHERE id = ${input.table_id} AND restaurant_id = ${a.restaurantId}`;
    if (!table)
      throw notFound("Mesa n\xE3o encontrada.", "TABLE_NOT_FOUND");
    if (!table.active)
      throw conflict("Esta mesa est\xE1 desativada.", "TABLE_UNAVAILABLE");
    const [r] = await tx`SELECT service_fee_bps FROM restaurants WHERE id = ${a.restaurantId}`;
    const priced = await priceOrder(tx, a.restaurantId, { items: input.items, notes: input.notes }, r.service_fee_bps, limits);
    const sessionId = await ensureTableSession(tx, { restaurantId: a.restaurantId, tableId: table.id }, tableSessionMinutes);
    const { id } = await insertOrder(tx, {
      restaurantId: a.restaurantId,
      tableId: table.id,
      tableSessionId: sessionId,
      publicCode: randomToken(16),
      source: "staff",
      createdBy: a.userId,
      priced,
      notes: input.notes,
      idempotencyKey: key
    });
    const order = await getOrder(tx, a.restaurantId, id);
    return { order, tableNumber: table.table_number, replayed: false };
  });
  let out;
  try {
    out = await attempt();
  } catch (err) {
    if (key && pgCode(err) === "23505" && pgConstraint(err) === "orders_idem_uq")
      out = await attempt();
    else
      throw err;
  }
  if (!out.replayed) {
    ctx.deps.hub.publishRestaurant(a.restaurantId, {
      type: "order.created",
      order_id: out.order.id,
      order_number: out.order.order_number,
      table_number: out.tableNumber,
      at: new Date().toISOString()
    });
  }
  return out.replayed ? json({ order: out.order, replayed: true }) : created({ order: out.order });
}
async function transition(ctx) {
  const id = uuid.safeParse(ctx.params.id);
  if (!id.success)
    throw notFound("Pedido n\xE3o encontrado.", "ORDER_NOT_FOUND");
  const a = staffAuth(ctx);
  const input = await ctx.body(OrderStatusInput);
  const out = await ctx.deps.db.as({ role: a.role, restaurantId: a.restaurantId, userId: a.userId, reason: input.reason ?? null }, async (tx) => {
    const [cur] = await tx`
        SELECT status, public_code, order_number, table_number FROM orders
        WHERE id = ${id.data} AND restaurant_id = ${a.restaurantId} FOR UPDATE`;
    if (!cur)
      throw notFound("Pedido n\xE3o encontrado.", "ORDER_NOT_FOUND");
    if (input.from && input.from !== cur.status) {
      throw conflict("O pedido j\xE1 foi alterado por outra pessoa. A lista foi atualizada.", "STATE_CONFLICT", { current: cur.status });
    }
    if (cur.status === input.to)
      throw conflict("O pedido j\xE1 est\xE1 neste estado.", "STATE_CONFLICT", { current: cur.status });
    if (!canTransition(a.role, cur.status, input.to)) {
      const anyone = staffRoles2.some((r) => canTransition(r, cur.status, input.to));
      throw anyone ? forbidden("O seu perfil n\xE3o pode fazer esta altera\xE7\xE3o de estado.", "TRANSITION_NOT_ALLOWED") : new HttpError(409, "INVALID_TRANSITION", "Esta altera\xE7\xE3o de estado n\xE3o \xE9 permitida.");
    }
    if (transitionNeedsReason(cur.status, input.to) && !input.reason) {
      throw unprocessable("Indique o motivo desta altera\xE7\xE3o.", "REASON_REQUIRED");
    }
    await tx`UPDATE orders SET status = ${input.to} WHERE id = ${id.data} AND restaurant_id = ${a.restaurantId}`;
    if (a.role === "manager" && (input.to === "cancelado" || transitionNeedsReason(cur.status, input.to))) {
      await audit(tx, {
        restaurantId: a.restaurantId,
        actorId: a.userId,
        actorRole: a.role,
        action: input.to === "cancelado" ? "order.cancel" : "order.correct",
        entityType: "order",
        entityId: id.data,
        metadata: { from: cur.status, to: input.to, reason: input.reason },
        ip: ctx.ip
      });
    }
    const order = await getOrder(tx, a.restaurantId, id.data);
    return { order, from: cur.status, publicCode: cur.public_code };
  });
  const at = new Date().toISOString();
  ctx.deps.hub.publishRestaurant(a.restaurantId, {
    type: "order.status",
    order_id: out.order.id,
    order_number: out.order.order_number,
    table_number: out.order.table_number,
    from: out.from,
    to: out.order.status,
    at
  });
  ctx.deps.hub.publishOrder(out.publicCode, { type: "order.state", status: out.order.status, at });
  return json({ order: out.order });
}
var orderRoutes = [
  { method: "GET", path: "/api/orders", access: { roles: staffRoles2 }, handler: list5 },
  { method: "GET", path: "/api/orders/:id", access: { roles: staffRoles2 }, handler: detail },
  { method: "POST", path: "/api/orders", access: { roles: ["manager", "waiter"] }, handler: createManual },
  { method: "POST", path: "/api/order-status/:id", access: { roles: staffRoles2 }, handler: transition }
];

// server/src/modules/payments/routes.ts
var toView2 = (r) => ({
  id: r.id,
  order_id: r.order_id,
  method: r.method,
  amount_cents: num(r.amount_cents),
  status: r.status,
  reference: r.reference,
  created_at: iso(r.created_at),
  updated_at: iso(r.updated_at)
});
function staff(ctx) {
  const a = ctx.auth;
  return { role: a.role, restaurantId: a.restaurantId, userId: a.userId };
}
async function paymentsOf(tx, orderId) {
  const rows = await tx`
    SELECT id, order_id, method, amount_cents, status, reference, created_at, updated_at
    FROM payments WHERE order_id = ${orderId} ORDER BY created_at, id`;
  return rows.map(toView2);
}
async function list6(ctx) {
  const id = uuid.safeParse(ctx.params.id);
  if (!id.success)
    throw notFound("Pedido n\xE3o encontrado.", "ORDER_NOT_FOUND");
  const a = staff(ctx);
  const out = await ctx.deps.db.as({ role: a.role, restaurantId: a.restaurantId, userId: a.userId }, async (tx) => {
    const [order] = await tx`SELECT total_cents FROM orders WHERE id = ${id.data} AND restaurant_id = ${a.restaurantId}`;
    if (!order)
      return null;
    const payments = await paymentsOf(tx, id.data);
    return { payments, summary: summarizePayments(num(order.total_cents), payments), total_cents: num(order.total_cents) };
  });
  if (!out)
    throw notFound("Pedido n\xE3o encontrado.", "ORDER_NOT_FOUND");
  return json(out);
}
async function record(ctx) {
  const id = uuid.safeParse(ctx.params.id);
  if (!id.success)
    throw notFound("Pedido n\xE3o encontrado.", "ORDER_NOT_FOUND");
  const a = staff(ctx);
  const input = await ctx.body(PaymentCreateInput);
  if (input.status === "isento") {
    if (a.role !== "manager")
      throw forbidden("S\xF3 o gerente pode isentar um pedido.", "EXEMPT_MANAGER_ONLY");
    if (!input.reference || input.reference.length < 3)
      throw unprocessable("Indique o motivo da isen\xE7\xE3o.", "REASON_REQUIRED");
  }
  const out = await ctx.deps.db.as({ role: a.role, restaurantId: a.restaurantId, userId: a.userId }, async (tx) => {
    const [order] = await tx`
      SELECT status, total_cents FROM orders WHERE id = ${id.data} AND restaurant_id = ${a.restaurantId} FOR UPDATE`;
    if (!order)
      throw notFound("Pedido n\xE3o encontrado.", "ORDER_NOT_FOUND");
    if (order.status === "cancelado")
      throw conflict("Este pedido foi cancelado: n\xE3o se regista pagamento.", "ORDER_CANCELLED");
    const total = num(order.total_cents);
    const existing = await paymentsOf(tx, id.data);
    const before = summarizePayments(total, existing);
    let amount;
    if (input.status === "isento") {
      if (before.state === "isento")
        throw conflict("Este pedido j\xE1 est\xE1 isento.", "ALREADY_EXEMPT");
      if (before.paid_cents > 0)
        throw conflict("Este pedido j\xE1 tem pagamentos registados. Anule-os antes de o isentar.", "ORDER_HAS_PAYMENTS");
      amount = 0;
    } else {
      if (before.state === "isento")
        throw conflict("Este pedido est\xE1 isento: n\xE3o leva pagamento.", "ORDER_EXEMPT");
      if (before.due_cents <= 0)
        throw conflict("Este pedido j\xE1 est\xE1 pago.", "NOTHING_DUE");
      amount = input.amount_cents ?? before.due_cents;
      if (amount > before.due_cents) {
        throw unprocessable("O valor \xE9 superior ao que falta pagar neste pedido.", "AMOUNT_EXCEEDS_DUE", { due_cents: before.due_cents });
      }
    }
    const [row] = await tx`
      INSERT INTO payments (restaurant_id, order_id, method, amount_cents, status, reference, recorded_by)
      VALUES (${a.restaurantId}, ${id.data}, ${input.method}, ${amount}, ${input.status}, ${input.reference}, ${a.userId})
      RETURNING id, order_id, method, amount_cents, status, reference, created_at, updated_at`;
    await audit(tx, {
      restaurantId: a.restaurantId,
      actorId: a.userId,
      actorRole: a.role,
      action: input.status === "isento" ? "payment.exempt" : "payment.record",
      entityType: "order",
      entityId: id.data,
      metadata: { method: input.method, amount_cents: amount, ...input.status === "isento" ? { reason: input.reference } : {} },
      ip: ctx.ip
    });
    const payments = [...existing, toView2(row)];
    return { payment: toView2(row), summary: summarizePayments(total, payments) };
  });
  ctx.deps.hub.publishRestaurant(a.restaurantId, { type: "order.payment", order_id: id.data, at: new Date().toISOString() });
  return created(out);
}
var ALLOWED_CHANGES = {
  pago: ["reembolsado", "anulado"],
  isento: ["anulado"]
};
async function change(ctx) {
  const id = uuid.safeParse(ctx.params.id);
  if (!id.success)
    throw notFound("Pagamento n\xE3o encontrado.", "PAYMENT_NOT_FOUND");
  const a = staff(ctx);
  const input = await ctx.body(PaymentUpdateInput);
  const out = await ctx.deps.db.as({ role: a.role, restaurantId: a.restaurantId, userId: a.userId }, async (tx) => {
    const [cur] = await tx`
      SELECT id, order_id, method, amount_cents, status, reference, created_at, updated_at
      FROM payments WHERE id = ${id.data} AND restaurant_id = ${a.restaurantId} FOR UPDATE`;
    if (!cur)
      throw notFound("Pagamento n\xE3o encontrado.", "PAYMENT_NOT_FOUND");
    if (!ALLOWED_CHANGES[cur.status]?.includes(input.status)) {
      throw conflict("Este registo n\xE3o pode passar para esse estado.", "INVALID_PAYMENT_TRANSITION", { current: cur.status });
    }
    await tx`UPDATE payments SET status = ${input.status} WHERE id = ${id.data} AND restaurant_id = ${a.restaurantId}`;
    await audit(tx, {
      restaurantId: a.restaurantId,
      actorId: a.userId,
      actorRole: a.role,
      action: input.status === "reembolsado" ? "payment.refund" : "payment.void",
      entityType: "payment",
      entityId: id.data,
      metadata: { order_id: cur.order_id, previous: cur.status, amount_cents: num(cur.amount_cents), reason: input.reason },
      ip: ctx.ip
    });
    const [order] = await tx`SELECT total_cents FROM orders WHERE id = ${cur.order_id} AND restaurant_id = ${a.restaurantId}`;
    const payments = await paymentsOf(tx, cur.order_id);
    return {
      orderId: cur.order_id,
      payment: payments.find((p) => p.id === id.data),
      summary: summarizePayments(num(order?.total_cents), payments)
    };
  });
  ctx.deps.hub.publishRestaurant(a.restaurantId, { type: "order.payment", order_id: out.orderId, at: new Date().toISOString() });
  return json({ payment: out.payment, summary: out.summary });
}
var paymentRoutes = [
  { method: "GET", path: "/api/orders/:id/payments", access: { roles: ["manager", "waiter"] }, handler: list6 },
  { method: "POST", path: "/api/orders/:id/payments", access: { roles: ["manager", "waiter"] }, handler: record, limits: [{ name: "payment-record", max: 120, windowMs: 60000 }] },
  { method: "PATCH", path: "/api/payments/:id", access: { roles: ["manager"] }, handler: change, limits: [{ name: "payment-change", max: 60, windowMs: 60000 }] }
];

// server/src/http/sse.ts
var encoder = new TextEncoder;
function sseResponse(req, opts) {
  let cleanup = null;
  let heartbeat = null;
  let lifetime = null;
  let closed = false;
  let seq = 0;
  const stream = new ReadableStream({
    start(controller) {
      const close = () => {
        if (closed)
          return;
        closed = true;
        if (heartbeat)
          clearInterval(heartbeat);
        if (lifetime)
          clearTimeout(lifetime);
        cleanup?.();
        opts.onClose?.();
        try {
          controller.close();
        } catch {}
      };
      const write = (text) => {
        if (closed)
          return;
        if ((controller.desiredSize ?? 1) < -64)
          return close();
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          close();
        }
      };
      const send = (event) => write(`id: ${++seq}
event: ${event.type}
data: ${JSON.stringify(event)}

`);
      write(`retry: 3000

`);
      if (opts.hello)
        send(opts.hello);
      cleanup = opts.subscribe(send);
      heartbeat = setInterval(() => write(`: ping

`), opts.heartbeatMs ?? 15000);
      if (opts.maxLifetimeMs)
        lifetime = setTimeout(close, opts.maxLifetimeMs);
      req.signal.addEventListener("abort", close, { once: true });
    },
    cancel() {
      if (closed)
        return;
      closed = true;
      if (heartbeat)
        clearInterval(heartbeat);
      if (lifetime)
        clearTimeout(lifetime);
      cleanup?.();
      opts.onClose?.();
    }
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no"
    }
  });
}

// server/src/modules/public/routes.ts
var TOKEN_RE2 = /^[A-Za-z0-9_-]{22,64}$/;
var IDEMPOTENCY_RE2 = /^[A-Za-z0-9_-]{16,100}$/;
var MAX_STREAMS_PER_IP = 80;
function tableToken(ctx) {
  const t = ctx.params.token ?? "";
  if (!TOKEN_RE2.test(t))
    throw notFound("QR Code inv\xE1lido ou desativado.", "TABLE_NOT_FOUND");
  return t;
}
function orderCode(ctx) {
  const c = ctx.params.code ?? "";
  if (!TOKEN_RE2.test(c))
    throw notFound("Pedido n\xE3o encontrado.", "ORDER_NOT_FOUND");
  return c;
}
async function resolveTable(tx, token) {
  const [t] = await tx`
    SELECT table_id, restaurant_id, table_number, table_label, table_active, restaurant_status, accepting_orders
    FROM resolve_table_token(${token})`;
  if (!t)
    throw notFound("QR Code inv\xE1lido ou desativado.", "TABLE_NOT_FOUND");
  if (t.restaurant_status !== "ativo") {
    throw new HttpError(403, "RESTAURANT_UNAVAILABLE", "Este restaurante n\xE3o est\xE1 dispon\xEDvel neste momento.");
  }
  if (!t.table_active) {
    throw new HttpError(403, "TABLE_UNAVAILABLE", "Esta mesa n\xE3o est\xE1 dispon\xEDvel. Pe\xE7a ajuda a um empregado.");
  }
  await tx.setContext({ restaurantId: t.restaurant_id, tableId: t.table_id });
  return t;
}
async function buildMenu(tx, rid, table) {
  const [r] = await tx`
    SELECT slug, name, description, logo_url, cover_url, accent_color, service_fee_bps, accepting_orders, address, phone, email, whatsapp,
           maps_url, opening_hours, timezone, currency, theme, font, is_demo
    FROM restaurants WHERE id = ${rid}`;
  const cats = await tx`
    SELECT id, name FROM categories WHERE restaurant_id = ${rid} ORDER BY display_order, lower(name)`;
  const items = await tx`SELECT id, category_id, name, description, image_url, thumb_url, model_url, ingredients, allergens, price_cents, available
     FROM menu_items WHERE restaurant_id = ${rid} ORDER BY display_order, lower(name)`;
  const opts = await tx`
    SELECT id, menu_item_id, name, price_delta_cents, kind FROM menu_item_options
    WHERE restaurant_id = ${rid} ORDER BY display_order, kind DESC, lower(name)`;
  let call = null;
  if (table) {
    const [c] = await tx`SELECT id, created_at FROM waiter_calls WHERE table_id = ${table.id} AND status = 'aberta'`;
    if (c)
      call = { id: c.id, created_at: new Date(c.created_at).toISOString() };
  }
  const optsByItem = new Map;
  for (const o of opts) {
    const list = optsByItem.get(o.menu_item_id) ?? [];
    list.push({ id: o.id, name: o.name, price_delta_cents: Number(o.price_delta_cents), kind: o.kind });
    optsByItem.set(o.menu_item_id, list);
  }
  const categories = cats.map((c) => ({
    id: c.id,
    name: c.name,
    items: items.filter((i) => i.category_id === c.id).map((i) => ({
      id: i.id,
      name: i.name,
      description: i.description,
      image_url: i.image_url,
      thumb_url: i.thumb_url,
      model_url: i.model_url,
      ingredients: i.ingredients,
      allergens: i.allergens,
      price_cents: Number(i.price_cents),
      available: i.available,
      options: optsByItem.get(i.id) ?? []
    }))
  })).filter((c) => c.items.length > 0);
  return {
    restaurant: {
      slug: r.slug,
      name: r.name,
      description: r.description,
      logo_url: r.logo_url,
      cover_url: r.cover_url,
      accent_color: r.accent_color,
      service_fee_bps: r.service_fee_bps,
      address: r.address,
      phone: r.phone,
      email: r.email,
      whatsapp: r.whatsapp,
      maps_url: r.maps_url,
      opening_hours: parseHours(r.opening_hours),
      timezone: r.timezone,
      currency: r.currency,
      theme: r.theme,
      font: r.font,
      is_demo: r.is_demo,
      show_brand: true
    },
    table: table ? { number: table.number, label: table.label } : null,
    accepting_orders: r.accepting_orders,
    capabilities: { orders: false, whatsapp: false, model_3d: false, ar: false, waiter_call: false },
    waiter_call: call,
    categories
  };
}
function applyPlan(menu, features) {
  const r = menu.restaurant;
  const has3d = features.has("model_3d");
  const canOrder = menu.table !== null && features.has("orders") && !r.is_demo;
  return {
    ...menu,
    restaurant: {
      ...r,
      whatsapp: features.has("whatsapp_orders") ? r.whatsapp : null,
      accent_color: features.has("advanced_branding") ? r.accent_color : null,
      theme: features.has("advanced_branding") ? r.theme : "dark",
      font: features.has("exclusive_branding") ? r.font : "serif",
      show_brand: !features.has("exclusive_branding")
    },
    capabilities: {
      orders: canOrder,
      whatsapp: features.has("whatsapp_orders") && !!r.whatsapp && !r.is_demo,
      model_3d: has3d,
      ar: has3d && features.has("ar"),
      waiter_call: canOrder
    },
    waiter_call: canOrder ? menu.waiter_call : null,
    categories: has3d ? menu.categories : menu.categories.map((c) => ({ ...c, items: c.items.map((i) => ({ ...i, model_url: null })) }))
  };
}
async function getMenu2(ctx) {
  const token = tableToken(ctx);
  const { menu, rid } = await ctx.deps.db.as({ role: "public" }, async (tx) => {
    const t = await resolveTable(tx, token);
    return { rid: t.restaurant_id, menu: await buildMenu(tx, t.restaurant_id, { number: t.table_number, label: t.table_label, id: t.table_id }) };
  });
  return json(applyPlan(menu, await restaurantFeatures(ctx.deps.db, rid)));
}
var SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
async function getRestaurantMenu(ctx) {
  const slug = ctx.params.slug ?? "";
  if (!SLUG_RE.test(slug) || slug.length > 60)
    throw notFound("Restaurante n\xE3o encontrado.", "RESTAURANT_NOT_FOUND");
  const { menu, rid } = await ctx.deps.db.as({ role: "public" }, async (tx) => {
    const [r] = await tx`SELECT restaurant_id, restaurant_status FROM resolve_restaurant_slug(${slug})`;
    if (!r)
      throw notFound("Restaurante n\xE3o encontrado.", "RESTAURANT_NOT_FOUND");
    if (r.restaurant_status !== "ativo")
      throw new HttpError(403, "RESTAURANT_UNAVAILABLE", "Este restaurante n\xE3o est\xE1 dispon\xEDvel neste momento.");
    await tx.setContext({ restaurantId: r.restaurant_id });
    return { rid: r.restaurant_id, menu: await buildMenu(tx, r.restaurant_id, null) };
  });
  return json(applyPlan(menu, await restaurantFeatures(ctx.deps.db, rid)));
}
async function loadPublicMenuBySlug(deps, slug) {
  if (!SLUG_RE.test(slug) || slug.length > 60)
    return null;
  const found = await deps.db.as({ role: "public" }, async (tx) => {
    const [r] = await tx`SELECT restaurant_id, restaurant_status FROM resolve_restaurant_slug(${slug})`;
    if (!r || r.restaurant_status !== "ativo")
      return null;
    await tx.setContext({ restaurantId: r.restaurant_id });
    return { rid: r.restaurant_id, menu: await buildMenu(tx, r.restaurant_id, null) };
  });
  return found ? applyPlan(found.menu, await restaurantFeatures(deps.db, found.rid)) : null;
}
async function callWaiter(ctx) {
  const token = tableToken(ctx);
  const lim = ctx.deps.limiter.hit(`pub-call-table:${token}`, 6, 600000);
  if (!lim.ok)
    throw tooMany("J\xE1 chamou o gar\xE7om v\xE1rias vezes. Aguarde um momento.", lim.retryAfterSec, "CALL_TOO_FAST");
  const out = await ctx.deps.db.as({ role: "public" }, async (tx) => {
    const t = await resolveTable(tx, token);
    const [f] = await tx`SELECT restaurant_has_feature('orders') AS ok`;
    const [d] = await tx`SELECT is_demo FROM restaurants WHERE id = ${t.restaurant_id}`;
    if (!f?.ok || d?.is_demo)
      throw new HttpError(403, "PLAN_FEATURE", "Este restaurante n\xE3o tem o bot\xE3o \xABChamar o gar\xE7om\xBB ativo.");
    const [made] = await tx`
      INSERT INTO waiter_calls (restaurant_id, table_id, table_number, table_label)
      VALUES (${t.restaurant_id}, ${t.table_id}, ${t.table_number}, ${t.table_label})
      ON CONFLICT (table_id) WHERE status = 'aberta' DO NOTHING
      RETURNING id, created_at`;
    if (made)
      return { restaurantId: t.restaurant_id, call: made, isNew: true, table: t };
    const [open] = await tx`SELECT id, created_at FROM waiter_calls WHERE table_id = ${t.table_id} AND status = 'aberta'`;
    return { restaurantId: t.restaurant_id, call: open, isNew: false, table: t };
  });
  if (out.isNew) {
    ctx.deps.hub.publishRestaurant(out.restaurantId, {
      type: "waiter.call",
      call_id: out.call.id,
      table_number: out.table.table_number,
      table_label: out.table.table_label,
      at: new Date().toISOString()
    });
  }
  return json({ call: { id: out.call.id, created_at: new Date(out.call.created_at).toISOString() } }, out.isNew ? 201 : 200);
}
async function cancelWaiterCall(ctx) {
  const token = tableToken(ctx);
  const out = await ctx.deps.db.as({ role: "public" }, async (tx) => {
    const t = await resolveTable(tx, token);
    const rows = await tx`
      UPDATE waiter_calls SET status = 'cancelada', resolved_at = now() WHERE table_id = ${t.table_id} AND status = 'aberta' RETURNING id`;
    return { restaurantId: t.restaurant_id, ids: rows.map((r) => r.id) };
  });
  for (const id of out.ids)
    ctx.deps.hub.publishRestaurant(out.restaurantId, { type: "waiter.call.done", call_id: id, at: new Date().toISOString() });
  return json({ cancelled: out.ids.length });
}
async function getSessionOrders(ctx) {
  const token = tableToken(ctx);
  const orders = await ctx.deps.db.as({ role: "public" }, async (tx) => {
    const t = await resolveTable(tx, token);
    const sessionId = await currentSessionId(tx, { restaurantId: t.restaurant_id, tableId: t.table_id }, ctx.deps.config.tableSessionMinutes);
    if (!sessionId)
      return [];
    await tx.setContext({ tableSessionId: sessionId });
    return listSessionOrders(tx, t.restaurant_id);
  });
  return json({ orders });
}
async function attemptPlaceOrder(deps, token, idempotencyKey, input) {
  const publicCode = randomToken(16);
  const { limits } = deps.config;
  return deps.db.as({ role: "public" }, async (tx) => {
    const t = await resolveTable(tx, token);
    await lockIdempotencyKey(tx, t.restaurant_id, idempotencyKey);
    const [replay] = await tx`SELECT lookup_idempotent_order(${idempotencyKey}) AS code`;
    if (replay?.code) {
      await tx.setContext({ publicCode: replay.code });
      const existing = await loadPublicOrder(tx, t.restaurant_id, replay.code);
      if (existing)
        return { response: { order: existing, replayed: true }, event: null };
    }
    const [r] = await tx`
      SELECT service_fee_bps, accepting_orders, is_demo FROM restaurants WHERE id = ${t.restaurant_id}`;
    const [plan] = await tx`SELECT restaurant_has_feature('orders') AS ok`;
    if (r?.is_demo)
      throw conflict("Este \xE9 um card\xE1pio de demonstra\xE7\xE3o: os pedidos n\xE3o s\xE3o enviados.", "DEMO_RESTAURANT");
    if (!plan?.ok)
      throw new HttpError(403, "PLAN_FEATURE", "Este restaurante n\xE3o recebe pedidos digitais. Pe\xE7a a um empregado.");
    if (!r?.accepting_orders) {
      throw conflict("O restaurante n\xE3o est\xE1 a aceitar pedidos por QR Code neste momento. Pe\xE7a a um empregado.", "NOT_ACCEPTING_ORDERS");
    }
    await lockTableOrdering(tx, t.table_id);
    const [stats] = await tx`
      SELECT pending, EXTRACT(EPOCH FROM (clock_timestamp() - last_order_at))::text AS since_last FROM table_order_stats()`;
    if (stats && stats.pending >= limits.maxPendingOrdersPerTable) {
      throw tooMany("Esta mesa tem demasiados pedidos por atender. Aguarde ou chame um empregado.", 20, "TOO_MANY_PENDING_ORDERS");
    }
    if (stats?.since_last !== null && stats?.since_last !== undefined && Math.max(0, Number(stats.since_last)) < limits.minSecondsBetweenOrders) {
      throw tooMany("Pedido enviado h\xE1 instantes. Aguarde alguns segundos.", limits.minSecondsBetweenOrders, "ORDERING_TOO_FAST");
    }
    const priced = await priceOrder(tx, t.restaurant_id, input, r.service_fee_bps, limits);
    const sessionId = await ensureTableSession(tx, { restaurantId: t.restaurant_id, tableId: t.table_id }, deps.config.tableSessionMinutes);
    await tx.setContext({ publicCode, tableSessionId: sessionId });
    const { id } = await insertOrder(tx, {
      restaurantId: t.restaurant_id,
      tableId: t.table_id,
      tableSessionId: sessionId,
      publicCode,
      source: "qr",
      createdBy: null,
      priced,
      notes: input.notes,
      idempotencyKey
    });
    const order = await loadPublicOrder(tx, t.restaurant_id, publicCode);
    return {
      response: { order, replayed: false },
      event: { restaurantId: t.restaurant_id, orderId: id, orderNumber: order.order_number, tableNumber: t.table_number }
    };
  });
}
async function placeOrder(ctx) {
  const token = tableToken(ctx);
  const key = ctx.req.headers.get("idempotency-key") ?? "";
  if (!IDEMPOTENCY_RE2.test(key)) {
    throw badRequest("Falta o cabe\xE7alho Idempotency-Key (16 a 100 caracteres: letras, n\xFAmeros, - e _).", undefined, "IDEMPOTENCY_KEY_REQUIRED");
  }
  const input = await ctx.body(CreateOrderInput);
  const lim = ctx.deps.limiter.hit(`pub-order-table:${token}`, 12, 60000);
  if (!lim.ok)
    throw tooMany("Demasiados pedidos seguidos nesta mesa. Aguarde um momento.", lim.retryAfterSec);
  let result;
  try {
    result = await attemptPlaceOrder(ctx.deps, token, key, input);
  } catch (err) {
    if (pgCode(err) === "23505" && pgConstraint(err) === "orders_idem_uq")
      result = await attemptPlaceOrder(ctx.deps, token, key, input);
    else
      throw err;
  }
  if (result.event) {
    const e = result.event;
    ctx.deps.hub.publishRestaurant(e.restaurantId, {
      type: "order.created",
      order_id: e.orderId,
      order_number: e.orderNumber,
      table_number: e.tableNumber,
      at: new Date().toISOString()
    });
  }
  return json(result.response, result.response.replayed ? 200 : 201);
}
async function withOrder(ctx, fn) {
  const code = orderCode(ctx);
  return ctx.deps.db.as({ role: "public" }, async (tx) => {
    const [r] = await tx`SELECT restaurant_id FROM resolve_order_code(${code})`;
    if (!r)
      throw notFound("Pedido n\xE3o encontrado.", "ORDER_NOT_FOUND");
    await tx.setContext({ restaurantId: r.restaurant_id, publicCode: code });
    return fn(tx, r.restaurant_id, code);
  });
}
async function getOrderByCode(ctx) {
  const order = await withOrder(ctx, (tx, rid, code) => loadPublicOrder(tx, rid, code));
  if (!order)
    throw notFound("Pedido n\xE3o encontrado.", "ORDER_NOT_FOUND");
  return json({ order });
}
async function streamOrder(ctx) {
  const code = orderCode(ctx);
  const order = await withOrder(ctx, (tx, rid, c) => loadPublicOrder(tx, rid, c));
  if (!order)
    throw notFound("Pedido n\xE3o encontrado.", "ORDER_NOT_FOUND");
  const release = ctx.deps.hub.acquireSlot(`sse:${ctx.ip}`, MAX_STREAMS_PER_IP);
  if (!release)
    throw tooMany("Demasiadas liga\xE7\xF5es em tempo real a partir desta rede.", 30, "TOO_MANY_STREAMS");
  return sseResponse(ctx.req, {
    hello: { type: "order.state", status: order.status, at: new Date().toISOString() },
    subscribe: (send) => ctx.deps.hub.subscribeOrder(code, send),
    maxLifetimeMs: 25 * 60000,
    onClose: release
  });
}
var publicRoutes = [
  { method: "GET", path: "/api/public/menu/:token", access: "public", handler: getMenu2, limits: [{ name: "pub-menu", max: 600, windowMs: 60000 }] },
  { method: "GET", path: "/api/public/restaurants/:slug", access: "public", handler: getRestaurantMenu, limits: [{ name: "pub-rest", max: 600, windowMs: 60000 }] },
  { method: "POST", path: "/api/public/menu/:token/call-waiter", access: "public", handler: callWaiter, noBody: true, limits: [{ name: "pub-call", max: 20, windowMs: 60000 }] },
  { method: "POST", path: "/api/public/menu/:token/call-waiter/cancel", access: "public", handler: cancelWaiterCall, noBody: true, limits: [{ name: "pub-call-cancel", max: 20, windowMs: 60000 }] },
  { method: "GET", path: "/api/public/menu/:token/orders", access: "public", handler: getSessionOrders, limits: [{ name: "pub-session", max: 600, windowMs: 60000 }] },
  { method: "POST", path: "/api/public/menu/:token/orders", access: "public", handler: placeOrder, limits: [{ name: "pub-order", max: 40, windowMs: 60000 }] },
  { method: "GET", path: "/api/public/orders/:code", access: "public", handler: getOrderByCode, limits: [{ name: "pub-order-get", max: 600, windowMs: 60000 }] },
  { method: "GET", path: "/api/public/orders/:code/stream", access: "public", handler: streamOrder, limits: [{ name: "pub-stream", max: 120, windowMs: 60000 }] }
];

// shared/qr.ts
var ECC_INDEX = { L: 0, M: 1, Q: 2, H: 3 };
var ECC_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };
var MIN_VERSION = 1;
var MAX_VERSION = 40;
var ECC_CODEWORDS_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]
];
var NUM_ERROR_CORRECTION_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]
];
function numRawDataModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7)
      result -= 36;
  }
  return result;
}
function numDataCodewords(version, ecc) {
  const e = ECC_INDEX[ecc];
  return Math.floor(numRawDataModules(version) / 8) - ECC_CODEWORDS_PER_BLOCK[e][version] * NUM_ERROR_CORRECTION_BLOCKS[e][version];
}
var charCountBits = (version) => version <= 9 ? 8 : 16;
function byteCapacity(version, ecc) {
  return Math.floor((numDataCodewords(version, ecc) * 8 - 4 - charCountBits(version)) / 8);
}
function gfMultiply(x, y) {
  let z = 0;
  for (let i = 7;i >= 0; i--) {
    z = z << 1 ^ (z >>> 7) * 285;
    z ^= (y >>> i & 1) * x;
  }
  return z & 255;
}
function rsDivisor(degree) {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0;i < degree; i++) {
    for (let j = 0;j < result.length; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < result.length)
        result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 2);
  }
  return result;
}
function reedSolomonRemainder(data, degree) {
  const divisor = rsDivisor(degree);
  const result = new Uint8Array(degree);
  for (let k = 0;k < data.length; k++) {
    const factor = (data[k] ^ result[0]) & 255;
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0;i < divisor.length; i++)
      result[i] ^= gfMultiply(divisor[i], factor);
  }
  return result;
}
function buildDataCodewords(bytes, version, ecc) {
  const capacityBits = numDataCodewords(version, ecc) * 8;
  const bits = [];
  const push = (value, count) => {
    for (let i = count - 1;i >= 0; i--)
      bits.push(value >>> i & 1);
  };
  push(4, 4);
  push(bytes.length, charCountBits(version));
  for (const b of bytes)
    push(b, 8);
  push(0, Math.min(4, capacityBits - bits.length));
  push(0, (8 - bits.length % 8) % 8);
  for (let pad = 236;bits.length < capacityBits; pad ^= 236 ^ 17)
    push(pad, 8);
  const out = new Uint8Array(bits.length / 8);
  bits.forEach((bit, i) => {
    out[i >>> 3] |= bit << 7 - (i & 7);
  });
  return out;
}
function addEccAndInterleave(data, version, ecc) {
  const e = ECC_INDEX[ecc];
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[e][version];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[e][version];
  const rawCodewords = Math.floor(numRawDataModules(version) / 8);
  const numShortBlocks = numBlocks - rawCodewords % numBlocks;
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const blocks = [];
  let k = 0;
  for (let i = 0;i < numBlocks; i++) {
    const dat = Array.from(data.subarray(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1)));
    k += dat.length;
    const rem = reedSolomonRemainder(dat, blockEccLen);
    if (i < numShortBlocks)
      dat.push(0);
    blocks.push(dat.concat(Array.from(rem)));
  }
  const result = [];
  for (let i = 0;i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks)
        result.push(block[i]);
    });
  }
  return Uint8Array.from(result);
}
var bit = (value, i) => (value >>> i & 1) !== 0;
function alignmentPositions(version) {
  if (version === 1)
    return [];
  const numAlign = Math.floor(version / 7) + 2;
  const size = version * 4 + 17;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7;result.length < numAlign; pos -= step)
    result.splice(1, 0, pos);
  return result;
}

class Grid {
  version;
  size;
  modules;
  isFunction;
  constructor(version) {
    this.version = version;
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    this.isFunction = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
  }
  setFunction(x, y, dark) {
    this.modules[y][x] = dark;
    this.isFunction[y][x] = true;
  }
  drawFunctionPatterns() {
    const { size, version } = this;
    for (let i = 0;i < size; i++) {
      this.setFunction(6, i, i % 2 === 0);
      this.setFunction(i, 6, i % 2 === 0);
    }
    this.drawFinder(3, 3);
    this.drawFinder(size - 4, 3);
    this.drawFinder(3, size - 4);
    const align = alignmentPositions(version);
    const n = align.length;
    for (let i = 0;i < n; i++) {
      for (let j = 0;j < n; j++) {
        if (i === 0 && j === 0 || i === 0 && j === n - 1 || i === n - 1 && j === 0)
          continue;
        this.drawAlignment(align[i], align[j]);
      }
    }
    this.drawFormat(0, 0);
    this.drawVersion();
  }
  drawFinder(cx, cy) {
    for (let dy = -4;dy <= 4; dy++) {
      for (let dx = -4;dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < this.size && y >= 0 && y < this.size)
          this.setFunction(x, y, dist !== 2 && dist !== 4);
      }
    }
  }
  drawAlignment(cx, cy) {
    for (let dy = -2;dy <= 2; dy++)
      for (let dx = -2;dx <= 2; dx++)
        this.setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  drawFormat(ecc, mask) {
    const data = ecc << 3 | mask;
    let rem = data;
    for (let i = 0;i < 10; i++)
      rem = rem << 1 ^ (rem >>> 9) * 1335;
    const bits = (data << 10 | rem) ^ 21522;
    const { size } = this;
    for (let i = 0;i <= 5; i++)
      this.setFunction(8, i, bit(bits, i));
    this.setFunction(8, 7, bit(bits, 6));
    this.setFunction(8, 8, bit(bits, 7));
    this.setFunction(7, 8, bit(bits, 8));
    for (let i = 9;i < 15; i++)
      this.setFunction(14 - i, 8, bit(bits, i));
    for (let i = 0;i < 8; i++)
      this.setFunction(size - 1 - i, 8, bit(bits, i));
    for (let i = 8;i < 15; i++)
      this.setFunction(8, size - 15 + i, bit(bits, i));
    this.setFunction(8, size - 8, true);
  }
  drawVersion() {
    if (this.version < 7)
      return;
    let rem = this.version;
    for (let i = 0;i < 12; i++)
      rem = rem << 1 ^ (rem >>> 11) * 7973;
    const bits = this.version << 12 | rem;
    for (let i = 0;i < 18; i++) {
      const dark = bit(bits, i);
      const a = this.size - 11 + i % 3;
      const b = Math.floor(i / 3);
      this.setFunction(a, b, dark);
      this.setFunction(b, a, dark);
    }
  }
  drawCodewords(data) {
    const { size } = this;
    let i = 0;
    for (let right = size - 1;right >= 1; right -= 2) {
      if (right === 6)
        right = 5;
      for (let vert = 0;vert < size; vert++) {
        for (let j = 0;j < 2; j++) {
          const x = right - j;
          const upward = (right + 1 & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!this.isFunction[y][x] && i < data.length * 8) {
            this.modules[y][x] = bit(data[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }
  }
  applyMask(mask) {
    for (let y = 0;y < this.size; y++) {
      for (let x = 0;x < this.size; x++) {
        let invert;
        switch (mask) {
          case 0:
            invert = (x + y) % 2 === 0;
            break;
          case 1:
            invert = y % 2 === 0;
            break;
          case 2:
            invert = x % 3 === 0;
            break;
          case 3:
            invert = (x + y) % 3 === 0;
            break;
          case 4:
            invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
            break;
          case 5:
            invert = x * y % 2 + x * y % 3 === 0;
            break;
          case 6:
            invert = (x * y % 2 + x * y % 3) % 2 === 0;
            break;
          default:
            invert = ((x + y) % 2 + x * y % 3) % 2 === 0;
            break;
        }
        if (!this.isFunction[y][x] && invert)
          this.modules[y][x] = !this.modules[y][x];
      }
    }
  }
  penalty() {
    const { size, modules } = this;
    let result = 0;
    const finderPenalty = (runs) => {
      const n = runs[1];
      const core = n > 0 && runs[2] === n && runs[3] === n * 3 && runs[4] === n && runs[5] === n;
      return (core && runs[0] >= n * 4 && runs[6] >= n ? 1 : 0) + (core && runs[6] >= n * 4 && runs[0] >= n ? 1 : 0);
    };
    const scanLine = (get) => {
      let score = 0;
      let color = false;
      let runX = 0;
      const history = [0, 0, 0, 0, 0, 0, 0];
      const addHistory = (len) => {
        if (history[0] === 0)
          len += size;
        history.pop();
        history.unshift(len);
      };
      for (let i = 0;i < size; i++) {
        if (get(i) === color) {
          runX++;
          if (runX === 5)
            score += 3;
          else if (runX > 5)
            score++;
        } else {
          addHistory(runX);
          if (!color)
            score += finderPenalty(history) * 40;
          color = get(i);
          runX = 1;
        }
      }
      let len = runX;
      if (color) {
        addHistory(len);
        len = 0;
      }
      len += size;
      addHistory(len);
      score += finderPenalty(history) * 40;
      return score;
    };
    for (let y = 0;y < size; y++)
      result += scanLine((x) => modules[y][x]);
    for (let x = 0;x < size; x++)
      result += scanLine((y) => modules[y][x]);
    for (let y = 0;y < size - 1; y++) {
      for (let x = 0;x < size - 1; x++) {
        const c = modules[y][x];
        if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1])
          result += 3;
      }
    }
    let dark = 0;
    for (const row of modules)
      for (const m of row)
        if (m)
          dark++;
    const total = size * size;
    result += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return result;
  }
}
function encodeQr(text, ecc = "M", minVersion = MIN_VERSION) {
  const bytes = new TextEncoder().encode(text);
  let version = Math.max(MIN_VERSION, minVersion);
  while (version <= MAX_VERSION && byteCapacity(version, ecc) < bytes.length)
    version++;
  if (version > MAX_VERSION)
    throw new RangeError("O texto \xE9 demasiado comprido para um QR Code.");
  const data = buildDataCodewords(bytes, version, ecc);
  const all = addEccAndInterleave(data, version, ecc);
  const grid = new Grid(version);
  grid.drawFunctionPatterns();
  grid.drawCodewords(all);
  let bestMask = 0;
  let bestScore = Infinity;
  for (let mask = 0;mask < 8; mask++) {
    grid.applyMask(mask);
    grid.drawFormat(ECC_FORMAT_BITS[ecc], mask);
    const score = grid.penalty();
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
    }
    grid.applyMask(mask);
  }
  grid.applyMask(bestMask);
  grid.drawFormat(ECC_FORMAT_BITS[ecc], bestMask);
  const { size, modules } = grid;
  return {
    version,
    ecc,
    mask: bestMask,
    size,
    isDark: (x, y) => x >= 0 && x < size && y >= 0 && y < size && modules[y][x]
  };
}
function qrPath(qr, quiet = 4) {
  const parts = [];
  for (let y = 0;y < qr.size; y++) {
    let x = 0;
    while (x < qr.size) {
      if (!qr.isDark(x, y)) {
        x++;
        continue;
      }
      const start = x;
      while (x < qr.size && qr.isDark(x, y))
        x++;
      parts.push(`M${start + quiet} ${y + quiet}h${x - start}v1h-${x - start}z`);
    }
  }
  return { d: parts.join(""), side: qr.size + quiet * 2 };
}
function qrSvg(qr, opts = {}) {
  const quiet = opts.quiet ?? 4;
  const { d, side } = qrPath(qr, quiet);
  const light = opts.light === undefined ? "#ffffff" : opts.light;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges" role="img" aria-label="QR Code">` + (light ? `<rect width="${side}" height="${side}" fill="${light}"/>` : "") + `<path d="${d}" fill="${opts.dark ?? "#000000"}"/></svg>`;
}

// server/src/lib/pdf.ts
import { deflateSync } from "zlib";
var MM = 72 / 25.4;
var A4 = { w: 210, h: 297 };
function hexToRgb(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex ?? "");
  return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : null;
}
var W_REGULAR = [
  278,
  278,
  355,
  556,
  556,
  889,
  667,
  191,
  333,
  333,
  389,
  584,
  278,
  333,
  278,
  278,
  556,
  556,
  556,
  556,
  556,
  556,
  556,
  556,
  556,
  556,
  278,
  278,
  584,
  584,
  584,
  556,
  1015,
  667,
  667,
  722,
  722,
  667,
  611,
  778,
  722,
  278,
  500,
  667,
  556,
  833,
  722,
  778,
  667,
  778,
  722,
  667,
  611,
  722,
  667,
  944,
  667,
  667,
  611,
  278,
  278,
  278,
  469,
  556,
  333,
  556,
  556,
  500,
  556,
  556,
  278,
  556,
  556,
  222,
  222,
  500,
  222,
  833,
  556,
  556,
  556,
  556,
  333,
  500,
  278,
  556,
  500,
  722,
  500,
  500,
  500,
  334,
  260,
  334,
  584
];
var W_BOLD = [
  278,
  333,
  474,
  556,
  556,
  889,
  722,
  238,
  333,
  333,
  389,
  584,
  278,
  333,
  278,
  278,
  556,
  556,
  556,
  556,
  556,
  556,
  556,
  556,
  556,
  556,
  333,
  333,
  584,
  584,
  584,
  611,
  975,
  722,
  722,
  722,
  722,
  667,
  611,
  778,
  722,
  278,
  556,
  722,
  611,
  833,
  722,
  778,
  667,
  778,
  722,
  667,
  611,
  722,
  667,
  944,
  667,
  667,
  611,
  333,
  278,
  333,
  584,
  556,
  333,
  556,
  611,
  556,
  611,
  556,
  333,
  611,
  611,
  278,
  278,
  556,
  278,
  889,
  611,
  611,
  611,
  611,
  389,
  556,
  333,
  611,
  556,
  778,
  556,
  556,
  500,
  389,
  280,
  389,
  584
];
function textWidth(text, size, font = "regular") {
  const table = font === "bold" ? W_BOLD : W_REGULAR;
  let units = 0;
  for (const ch of text.normalize("NFD")) {
    const code = ch.codePointAt(0);
    if (code >= 768 && code <= 879)
      continue;
    units += code >= 32 && code <= 126 ? table[code - 32] : code === 183 ? 278 : code === 8211 ? 556 : code === 8212 ? 1000 : 556;
  }
  return units / 1000 * size * (25.4 / 72);
}
function wrapText(text, size, font, maxWidth, maxLines = 3) {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (textWidth(next, size, font) <= maxWidth || !current)
      current = next;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current)
    lines.push(current);
  if (lines.length <= maxLines)
    return lines;
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1];
  while (last.length > 1 && textWidth(`${last}\u2026`, size, font) > maxWidth)
    last = last.slice(0, -1);
  kept[maxLines - 1] = `${last}\u2026`;
  return kept;
}
var CP1252_EXTRA = {
  8364: 128,
  8218: 130,
  402: 131,
  8222: 132,
  8230: 133,
  8224: 134,
  8225: 135,
  710: 136,
  8240: 137,
  352: 138,
  8249: 139,
  338: 140,
  381: 142,
  8216: 145,
  8217: 146,
  8220: 147,
  8221: 148,
  8226: 149,
  8211: 150,
  8212: 151,
  732: 152,
  8482: 153,
  353: 154,
  8250: 155,
  339: 156,
  382: 158,
  376: 159
};
function pdfString(text) {
  let out = "(";
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    const byte = cp < 128 || cp >= 160 && cp <= 255 ? cp : CP1252_EXTRA[cp] ?? 63;
    if (byte === 40 || byte === 41 || byte === 92)
      out += `\\${String.fromCharCode(byte)}`;
    else if (byte < 32 || byte === 127)
      out += " ";
    else if (byte < 128)
      out += String.fromCharCode(byte);
    else
      out += `\\${byte.toString(8).padStart(3, "0")}`;
  }
  return `${out})`;
}
function metaString(text) {
  let hex = "FEFF";
  for (let i = 0;i < text.length; i++)
    hex += text.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0");
  return `<${hex}>`;
}
var num2 = (n) => (Math.round(n * 1000) / 1000).toString();
var color = (c) => `${num2(c[0])} ${num2(c[1])} ${num2(c[2])}`;

class PdfPage {
  width;
  height;
  ops = [];
  constructor(width = A4.w, height = A4.h) {
    this.width = width;
    this.height = height;
  }
  y(mm) {
    return (this.height - mm) * MM;
  }
  rect(x, y, w, h, fill) {
    this.ops.push(`${color(fill)} rg ${num2(x * MM)} ${num2(this.y(y + h))} ${num2(w * MM)} ${num2(h * MM)} re f`);
    return this;
  }
  frame(x, y, w, h, stroke, widthMm = 0.25, dash) {
    const d = dash ? `[${num2(dash[0] * MM)} ${num2(dash[1] * MM)}] 0 d` : "[] 0 d";
    this.ops.push(`q ${color(stroke)} RG ${num2(widthMm * MM)} w ${d} ${num2(x * MM)} ${num2(this.y(y + h))} ${num2(w * MM)} ${num2(h * MM)} re S Q`);
    return this;
  }
  line(x1, y1, x2, y2, stroke, widthMm = 0.25) {
    this.ops.push(`q ${color(stroke)} RG ${num2(widthMm * MM)} w ${num2(x1 * MM)} ${num2(this.y(y1))} m ${num2(x2 * MM)} ${num2(this.y(y2))} l S Q`);
    return this;
  }
  text(str, x, y, opts) {
    if (!str)
      return this;
    const font = opts.font ?? "regular";
    const w = textWidth(str, opts.size, font);
    const left = opts.align === "center" ? x - w / 2 : opts.align === "right" ? x - w : x;
    this.ops.push(`BT ${color(opts.color ?? [0, 0, 0])} rg /${font === "bold" ? "F2" : "F1"} ${num2(opts.size)} Tf ${num2(left * MM)} ${num2(this.y(y))} Td ${pdfString(str)} Tj ET`);
    return this;
  }
  paragraph(lines, x, y, opts) {
    const step = opts.leading ?? opts.size * 0.42;
    let at = y;
    for (const l of lines) {
      this.text(l, x, at, opts);
      at += step;
    }
    return at;
  }
  qr(qr, x, y, side, opts = {}) {
    const quiet = opts.quiet ?? 4;
    const unit = side / (qr.size + quiet * 2);
    if (opts.light !== null)
      this.rect(x, y, side, side, opts.light ?? [1, 1, 1]);
    const parts = [`${color(opts.dark ?? [0, 0, 0])} rg`];
    for (let row = 0;row < qr.size; row++) {
      let col = 0;
      while (col < qr.size) {
        if (!qr.isDark(col, row)) {
          col++;
          continue;
        }
        const start = col;
        while (col < qr.size && qr.isDark(col, row))
          col++;
        parts.push(`${num2((x + (start + quiet) * unit) * MM)} ${num2(this.y(y + (row + quiet) * unit + unit))} ${num2((col - start) * unit * MM)} ${num2(unit * MM)} re`);
      }
    }
    parts.push("f");
    this.ops.push(parts.join(" "));
    return this;
  }
  content() {
    return this.ops.join(`
`);
  }
}

class PdfDocument {
  meta;
  pages = [];
  constructor(meta = { title: "" }) {
    this.meta = meta;
  }
  addPage(width = A4.w, height = A4.h) {
    const page = new PdfPage(width, height);
    this.pages.push(page);
    return page;
  }
  get pageCount() {
    return this.pages.length;
  }
  build() {
    const chunks = [];
    const offsets = [];
    let length = 0;
    const push = (b) => {
      chunks.push(b);
      length += b.length;
    };
    const text = (s) => push(Buffer.from(s, "latin1"));
    const object = (id, body) => {
      offsets[id] = length;
      text(`${id} 0 obj
`);
      push(typeof body === "string" ? Buffer.from(body, "latin1") : body);
      text(`
endobj
`);
    };
    const n = this.pages.length;
    const pageId = (i) => 6 + i * 2;
    text(`%PDF-1.4
%\xE2\xE3\xCF\xD3
`);
    object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    object(2, `<< /Type /Pages /Count ${n} /Kids [${this.pages.map((_, i) => `${pageId(i)} 0 R`).join(" ")}] >>`);
    object(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    object(4, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
    const d = this.meta.created ?? new Date;
    const stamp = `D:${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}${String(d.getUTCHours()).padStart(2, "0")}${String(d.getUTCMinutes()).padStart(2, "0")}${String(d.getUTCSeconds()).padStart(2, "0")}Z`;
    object(5, `<< /Title ${metaString(this.meta.title)} /Author ${metaString(this.meta.author ?? "ALTIORA MENU")} /Producer ${metaString("ALTIORA MENU")} /CreationDate (${stamp}) >>`);
    this.pages.forEach((page, i) => {
      const id = pageId(i);
      object(id, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num2(page.width * MM)} ${num2(page.height * MM)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${id + 1} 0 R >>`);
      const stream = deflateSync(Buffer.from(page.content(), "latin1"));
      object(id + 1, Buffer.concat([Buffer.from(`<< /Length ${stream.length} /Filter /FlateDecode >>
stream
`, "latin1"), stream, Buffer.from(`
endstream`, "latin1")]));
    });
    const total = 6 + n * 2;
    const xref = length;
    text(`xref
0 ${total}
0000000000 65535 f 
`);
    for (let id = 1;id < total; id++)
      text(`${String(offsets[id]).padStart(10, "0")} 00000 n 
`);
    text(`trailer
<< /Size ${total} /Root 1 0 R /Info 5 0 R >>
startxref
${xref}
%%EOF
`);
    const all = Buffer.concat(chunks);
    const out = new Uint8Array(new ArrayBuffer(all.length));
    out.set(all);
    return out;
  }
}

// server/src/lib/qr-sheets.ts
var INK = [0.05, 0.05, 0.06];
var GRAY = [0.42, 0.42, 0.46];
var RULE = [0.72, 0.72, 0.75];
var GOLD = [0.788, 0.635, 0.294];
var hostOf2 = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
};
function footer(page, cx, y, url, brand) {
  page.text(hostOf2(url), cx, y, { size: 7, color: GRAY, align: "center" });
  if (brand.showBrand)
    page.text("ALTIORA MENU  \xB7  Digital Dining Experience", cx, y + 3.6, { size: 6, font: "bold", color: GRAY, align: "center" });
}
function card(page, x, y, w, h, t, brand) {
  const accent = hexToRgb(brand.accent) ?? GOLD;
  const cx = x + w / 2;
  page.rect(x, y, w, 3, accent);
  const name = wrapText(brand.restaurantName, 15, "bold", w - 16, 2);
  page.paragraph(name, cx, y + 15, { size: 15, font: "bold", color: INK, align: "center", leading: 6.4 });
  page.text(`Mesa ${t.number}`, cx, y + 42, { size: 30, font: "bold", color: INK, align: "center" });
  if (t.label)
    page.text(wrapText(t.label, 10, "regular", w - 16, 1)[0] ?? "", cx, y + 49, { size: 10, color: GRAY, align: "center" });
  const side = 62;
  page.qr(encodeQr(t.url, "M"), cx - side / 2, y + 54, side, { dark: INK });
  page.paragraph(["Aponte a c\xE2mara do telem\xF3vel", "ao QR Code para ver o menu."], cx, y + 123, { size: 9, color: INK, align: "center", leading: 4 });
  footer(page, cx, y + h - 9, t.url, brand);
  page.frame(x, y, w, h, RULE, 0.2, [1.5, 1.5]);
}
function tableCardsPdf(tables, brand) {
  const doc = new PdfDocument({ title: `QR Codes das mesas \u2014 ${brand.restaurantName}`, created: brand.created });
  const margin = 10;
  const w = (A4.w - margin * 2) / 2;
  const h = (A4.h - margin * 2) / 2;
  for (let i = 0;i < tables.length; i += 4) {
    const page = doc.addPage();
    tables.slice(i, i + 4).forEach((t, k) => card(page, margin + k % 2 * w, margin + Math.floor(k / 2) * h, w, h, t, brand));
  }
  if (doc.pageCount === 0)
    doc.addPage().text("Sem mesas para imprimir.", A4.w / 2, 40, { size: 14, color: GRAY, align: "center" });
  return doc.build();
}
function restaurantSheetPdf(url, brand) {
  const doc = new PdfDocument({ title: `QR Code \u2014 ${brand.restaurantName}`, created: brand.created });
  const page = doc.addPage();
  const cx = A4.w / 2;
  const accent = hexToRgb(brand.accent) ?? GOLD;
  page.rect(0, 0, A4.w, 8, accent);
  const name = wrapText(brand.restaurantName, 32, "bold", A4.w - 40, 2);
  const after = page.paragraph(name, cx, 44, { size: 32, font: "bold", color: INK, align: "center", leading: 13.5 });
  page.text("O nosso menu", cx, after + 10, { size: 16, color: GRAY, align: "center" });
  const side = 124;
  page.qr(encodeQr(url, "M"), cx - side / 2, 92, side, { dark: INK });
  page.paragraph(["Aponte a c\xE2mara do telem\xF3vel ao QR Code", "para ver o menu, sem instalar nada."], cx, 232, { size: 13, color: INK, align: "center", leading: 5.6 });
  footer(page, cx, 270, url, brand);
  return doc.build();
}

// server/src/modules/qr/routes.ts
var MAX_TABLES = 200;
function pdfResponse(bytes, filename) {
  return new Response(bytes, {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store"
    }
  });
}
async function loadBrand(ctx) {
  const a = ctx.auth;
  const rid = a.restaurantId;
  const row = await ctx.deps.db.as({ role: "manager", restaurantId: rid, userId: a.userId }, async (tx) => {
    const [r] = await tx`SELECT name, slug, accent_color, menu_base_url FROM restaurants WHERE id = ${rid}`;
    return r ?? null;
  });
  if (!row)
    throw notFound("Restaurante n\xE3o encontrado.", "RESTAURANT_NOT_FOUND");
  const features = await restaurantFeatures(ctx.deps.db, rid);
  return {
    row,
    baseUrl: row.menu_base_url ?? ctx.deps.config.publicBaseUrl,
    brand: {
      restaurantName: row.name,
      accent: features.has("advanced_branding") ? row.accent_color : null,
      showBrand: !features.has("exclusive_branding")
    }
  };
}
var safeName = (slug) => slug.replace(/[^a-z0-9-]/gi, "").slice(0, 60) || "restaurante";
async function restaurantPdf(ctx) {
  const a = ctx.auth;
  await requireFeature(ctx.deps.db, a.restaurantId, "qr_codes", "o QR Code do restaurante em PDF");
  const { brand, row, baseUrl } = await loadBrand(ctx);
  const bytes = restaurantSheetPdf(`${baseUrl}/r/${row.slug}`, brand);
  await ctx.deps.db.as({ role: "manager", restaurantId: a.restaurantId, userId: a.userId }, (tx) => audit(tx, { restaurantId: a.restaurantId, actorId: a.userId, actorRole: a.role, action: "qr.download", entityType: "restaurant", entityId: a.restaurantId, metadata: { kind: "restaurant" }, ip: ctx.ip }));
  return pdfResponse(bytes, `qr-${safeName(row.slug)}.pdf`);
}
async function tablesPdf(ctx) {
  const a = ctx.auth;
  const rid = a.restaurantId;
  await requireFeature(ctx.deps.db, rid, "tables", "os QR Codes por mesa");
  const rawIds = ctx.url.searchParams.get("ids");
  let wanted = null;
  if (rawIds) {
    wanted = rawIds.split(",").map((s) => s.trim()).filter(Boolean);
    if (wanted.length > MAX_TABLES || wanted.some((id) => !uuid.safeParse(id).success))
      throw new HttpError(400, "INVALID_IDS", "Lista de mesas inv\xE1lida.");
  }
  const { brand, row, baseUrl } = await loadBrand(ctx);
  const tables = await ctx.deps.db.as({ role: "manager", restaurantId: rid, userId: a.userId }, async (tx) => {
    const rows = await tx`
      SELECT id, table_number, label, qr_token, active FROM restaurant_tables WHERE restaurant_id = ${rid} ORDER BY table_number LIMIT ${MAX_TABLES}`;
    const picked = wanted ? rows.filter((t) => wanted.includes(t.id)) : rows.filter((t) => t.active);
    await audit(tx, { restaurantId: rid, actorId: a.userId, actorRole: a.role, action: "qr.download", entityType: "restaurant", entityId: rid, metadata: { kind: "tables", count: picked.length }, ip: ctx.ip });
    return picked;
  });
  if (wanted && tables.length === 0)
    throw notFound("Mesa n\xE3o encontrada.", "TABLE_NOT_FOUND");
  const bytes = tableCardsPdf(tables.map((t) => ({ number: t.table_number, label: t.label, url: `${baseUrl}/menu/${t.qr_token}` })), brand);
  return pdfResponse(bytes, `qr-${safeName(row.slug)}-mesas.pdf`);
}
var qrRoutes = [
  { method: "GET", path: "/api/qr/restaurant.pdf", access: { roles: ["manager"] }, handler: restaurantPdf, limits: [{ name: "qr-pdf", max: 30, windowMs: 60000 }] },
  { method: "GET", path: "/api/qr/tables.pdf", access: { roles: ["manager"] }, handler: tablesPdf, limits: [{ name: "qr-pdf", max: 30, windowMs: 60000 }] }
];

// shared/csv.ts
function csvMoney(cents) {
  const abs = Math.abs(Math.round(cents));
  return `${cents < 0 ? "-" : ""}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, "0")}`;
}
function csvText(value) {
  let v = value.replace(/\r?\n/g, " ").trim();
  if (/^[=+\-@\t]/.test(v))
    v = `'${v}`;
  return /[;"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
function salesCsv(r) {
  const sym = currencySymbol(r.range.currency);
  const lines = [];
  const row = (...cells) => lines.push(cells.join(";"));
  row("Dia", "Pedidos (sem cancelados)", `Vendas registadas (${sym})`, `Pagamentos confirmados (${sym})`);
  for (const d of r.by_day)
    row(d.day, String(d.orders), csvMoney(d.total_cents), csvMoney(d.confirmed_cents));
  row("Total", String(r.sales.orders), csvMoney(r.sales.total_cents), csvMoney(r.payments.confirmed_cents));
  lines.push("");
  row("Pagamentos por m\xE9todo", "Pagamentos", `Valor (${sym})`);
  for (const m of r.payments.by_method)
    row(csvText(METHOD_LABEL[m.method] ?? m.method), String(m.count), csvMoney(m.confirmed_cents));
  lines.push("");
  row("Pratos mais vendidos", "Quantidade", `Total (${sym})`);
  for (const i of r.top_items)
    row(csvText(i.name), String(i.quantity), csvMoney(i.total_cents));
  return `\uFEFF${lines.join(`\r
`)}\r
`;
}

// server/src/modules/reports/routes.ts
var DAY_MS = 86400000;
var MAX_DAYS = 366;
var dayNumber = (day) => Date.parse(`${day}T00:00:00Z`) / DAY_MS;
var dayString2 = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
function asDay(v) {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}
async function loadReport(ctx) {
  const parsed = ReportQuery.safeParse(Object.fromEntries(ctx.url.searchParams));
  if (!parsed.success) {
    throw badRequest("Datas inv\xE1lidas.", parsed.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })), "VALIDATION_ERROR");
  }
  const a = ctx.auth;
  return ctx.deps.db.as({ role: "manager", restaurantId: a.restaurantId, userId: a.userId }, async (tx) => {
    const [r] = await tx`
      SELECT timezone, currency, ((now() AT TIME ZONE timezone)::date)::text AS today FROM restaurants WHERE id = ${a.restaurantId}`;
    const to = parsed.data.to ?? r.today;
    const from = parsed.data.from ?? dayString2(dayNumber(to) - 6);
    if (Number.isNaN(dayNumber(from)) || Number.isNaN(dayNumber(to)))
      throw badRequest("Datas inv\xE1lidas.", undefined, "VALIDATION_ERROR");
    if (dayNumber(from) > dayNumber(to))
      throw unprocessable("A data inicial n\xE3o pode ser depois da final.", "RANGE_INVALID");
    if (dayNumber(to) - dayNumber(from) + 1 > MAX_DAYS)
      throw unprocessable(`O per\xEDodo n\xE3o pode ter mais de ${MAX_DAYS} dias.`, "RANGE_TOO_LARGE");
    const rid = a.restaurantId;
    const orderDays = await tx`
      SELECT o.order_day AS day, count(*)::int AS orders,
             coalesce(sum((SELECT sum(i.quantity) FROM order_items i WHERE i.order_id = o.id)), 0) AS units,
             coalesce(sum(o.subtotal_cents), 0) AS subtotal, coalesce(sum(o.service_fee_cents), 0) AS fee, coalesce(sum(o.total_cents), 0) AS total
      FROM orders o
      WHERE o.restaurant_id = ${rid} AND o.order_day BETWEEN ${from}::date AND ${to}::date AND o.status <> 'cancelado'
      GROUP BY o.order_day`;
    const [cancelled] = await tx`
      SELECT count(*)::int AS orders, coalesce(sum(total_cents), 0) AS total
      FROM orders WHERE restaurant_id = ${rid} AND order_day BETWEEN ${from}::date AND ${to}::date AND status = 'cancelado'`;
    const paymentDays = await tx`
      SELECT (p.created_at AT TIME ZONE ${r.timezone})::date AS day, coalesce(sum(p.amount_cents), 0) AS confirmed
      FROM payments p
      WHERE p.restaurant_id = ${rid} AND p.status = 'pago'
        AND (p.created_at AT TIME ZONE ${r.timezone})::date BETWEEN ${from}::date AND ${to}::date
      GROUP BY 1`;
    const methods = await tx`
      SELECT p.method, count(*)::int AS count, coalesce(sum(p.amount_cents), 0) AS confirmed
      FROM payments p
      WHERE p.restaurant_id = ${rid} AND p.status = 'pago'
        AND (p.created_at AT TIME ZONE ${r.timezone})::date BETWEEN ${from}::date AND ${to}::date
      GROUP BY p.method ORDER BY confirmed DESC, p.method`;
    const [refunded] = await tx`
      SELECT coalesce(sum(p.amount_cents), 0) AS total
      FROM payments p
      WHERE p.restaurant_id = ${rid} AND p.status = 'reembolsado'
        AND (p.created_at AT TIME ZONE ${r.timezone})::date BETWEEN ${from}::date AND ${to}::date`;
    const [outstanding] = await tx`
      SELECT coalesce(sum(GREATEST(o.total_cents - coalesce(pd.paid, 0), 0)) FILTER (WHERE NOT coalesce(pd.exempt, false)), 0) AS outstanding,
             (count(*) FILTER (WHERE coalesce(pd.exempt, false)))::int AS exempt_orders
      FROM orders o
      LEFT JOIN (
        SELECT order_id, sum(amount_cents) FILTER (WHERE status = 'pago') AS paid, bool_or(status = 'isento') AS exempt
        FROM payments WHERE restaurant_id = ${rid} GROUP BY order_id
      ) pd ON pd.order_id = o.id
      WHERE o.restaurant_id = ${rid} AND o.order_day BETWEEN ${from}::date AND ${to}::date AND o.status <> 'cancelado'`;
    const items = await tx`
      SELECT i.item_name_snapshot AS name, sum(i.quantity) AS quantity, sum(i.line_total_cents) AS total
      FROM order_items i JOIN orders o ON o.id = i.order_id AND o.restaurant_id = i.restaurant_id
      WHERE o.restaurant_id = ${rid} AND o.order_day BETWEEN ${from}::date AND ${to}::date AND o.status <> 'cancelado'
      GROUP BY i.item_name_snapshot ORDER BY sum(i.quantity) DESC, sum(i.line_total_cents) DESC, i.item_name_snapshot LIMIT 10`;
    const orderByDay = new Map(orderDays.map((d) => [asDay(d.day), d]));
    const paidByDay = new Map(paymentDays.map((d) => [asDay(d.day), num(d.confirmed)]));
    const byDay = [];
    for (let n = dayNumber(from);n <= dayNumber(to); n++) {
      const key = dayString2(n);
      const o = orderByDay.get(key);
      byDay.push({ day: key, orders: o?.orders ?? 0, total_cents: num(o?.total), confirmed_cents: paidByDay.get(key) ?? 0 });
    }
    const totalOrders = orderDays.reduce((n, d) => n + d.orders, 0);
    const totalCents = orderDays.reduce((n, d) => n + num(d.total), 0);
    const out = {
      range: { from, to, timezone: r.timezone, currency: r.currency },
      sales: {
        orders: totalOrders,
        units: orderDays.reduce((n, d) => n + num(d.units), 0),
        subtotal_cents: orderDays.reduce((n, d) => n + num(d.subtotal), 0),
        service_fee_cents: orderDays.reduce((n, d) => n + num(d.fee), 0),
        total_cents: totalCents,
        average_ticket_cents: totalOrders > 0 ? Math.round(totalCents / totalOrders) : 0
      },
      cancelled: { orders: cancelled.orders, total_cents: num(cancelled.total) },
      payments: {
        confirmed_cents: methods.reduce((n, m) => n + num(m.confirmed), 0),
        refunded_cents: num(refunded.total),
        by_method: methods.map((m) => ({ method: m.method, count: m.count, confirmed_cents: num(m.confirmed) }))
      },
      outstanding_cents: num(outstanding.outstanding),
      exempt_orders: outstanding.exempt_orders,
      by_day: byDay,
      top_items: items.map((i) => ({ name: i.name, quantity: num(i.quantity), total_cents: num(i.total) }))
    };
    return out;
  });
}
async function sales(ctx) {
  await requireFeature(ctx.deps.db, ctx.auth.restaurantId, "stats", "as estat\xEDsticas");
  return json({ report: await loadReport(ctx) });
}
async function salesFile(ctx) {
  const a = ctx.auth;
  const rid = a.restaurantId;
  await requireFeature(ctx.deps.db, rid, "stats", "as estat\xEDsticas");
  await requireFeature(ctx.deps.db, rid, "advanced_management", "a exporta\xE7\xE3o de relat\xF3rios em CSV");
  const report = await loadReport(ctx);
  await ctx.deps.db.as({ role: "manager", restaurantId: rid, userId: a.userId }, (tx) => audit(tx, { restaurantId: rid, actorId: a.userId, actorRole: a.role, action: "report.export", entityType: "report", metadata: { from: report.range.from, to: report.range.to }, ip: ctx.ip }));
  return new Response(salesCsv(report), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="vendas-${report.range.from}_a_${report.range.to}.csv"`,
      "cache-control": "no-store"
    }
  });
}
var limits = [{ name: "report", max: 60, windowMs: 60000 }];
var reportRoutes = [
  { method: "GET", path: "/api/reports/sales", access: { roles: ["manager"] }, handler: sales, limits },
  { method: "GET", path: "/api/reports/sales.csv", access: { roles: ["manager"] }, handler: salesFile, limits }
];

// server/src/modules/restaurants/routes.ts
var staffRoles3 = ["manager", "waiter", "kitchen"];
var COLUMNS = "id, name, slug, description, logo_url, cover_url, accent_color, address, phone, email, whatsapp, maps_url, opening_hours, theme, font, is_demo, status, accepting_orders, timezone, currency, service_fee_bps, menu_base_url";
async function getCurrent(ctx) {
  const a = ctx.auth;
  const rid = a.restaurantId;
  const row = await ctx.deps.db.as({ role: a.role, restaurantId: rid, userId: a.userId }, async (tx) => {
    const [r] = await tx.unsafe(`SELECT ${COLUMNS} FROM restaurants WHERE id = $1`, [rid]);
    return r ?? null;
  });
  if (!row)
    throw notFound("Restaurante n\xE3o encontrado.", "RESTAURANT_NOT_FOUND");
  return json({ restaurant: row });
}
async function updateCurrent(ctx) {
  const a = ctx.auth;
  const rid = a.restaurantId;
  const input = await ctx.body(RestaurantUpdateInput);
  const db = ctx.deps.db;
  if (input.accent_color || input.theme !== undefined)
    await requireFeature(db, rid, "advanced_branding", "a personaliza\xE7\xE3o de cor e tema");
  if (input.font !== undefined)
    await requireFeature(db, rid, "exclusive_branding", "a personaliza\xE7\xE3o exclusiva");
  if (input.whatsapp)
    await requireFeature(db, rid, "whatsapp_orders", "pedidos por WhatsApp");
  const patch = { ...input };
  const row = await ctx.deps.db.as({ role: "manager", restaurantId: rid, userId: a.userId }, async (tx) => {
    const r = await updatePartial(tx, "restaurants", {
      columns: ["name", "description", "logo_url", "cover_url", "accent_color", "address", "phone", "email", "whatsapp", "maps_url", "opening_hours", "theme", "font", "timezone", "service_fee_bps", "accepting_orders"],
      where: "id = $1",
      whereParams: [rid],
      returning: COLUMNS
    }, patch);
    if (!r)
      throw notFound("Restaurante n\xE3o encontrado.", "RESTAURANT_NOT_FOUND");
    await purgeOrphanAssets(tx, rid);
    await audit(tx, {
      restaurantId: rid,
      actorId: a.userId,
      actorRole: a.role,
      action: "restaurant.update",
      entityType: "restaurant",
      entityId: rid,
      metadata: { fields: Object.keys(input), ...input.accepting_orders !== undefined ? { accepting_orders: input.accepting_orders } : {}, ...input.service_fee_bps !== undefined ? { service_fee_bps: input.service_fee_bps } : {} },
      ip: ctx.ip
    });
    return r;
  });
  ctx.deps.hub.publishRestaurant(rid, { type: "menu.changed", at: new Date().toISOString() });
  return json({ restaurant: row });
}
async function getPlan(ctx) {
  const a = ctx.auth;
  const rid = a.restaurantId;
  const rows = await ctx.deps.db.system((tx) => tx`
      SELECT p.code, p.name, p.tagline, s.status, s.valid_until::text AS valid_until,
             (SELECT coalesce(sum(byte_size), 0) FROM assets WHERE restaurant_id = ${rid})::text AS used
      FROM subscriptions s JOIN plans p ON p.code = s.plan_code WHERE s.restaurant_id = ${rid}`);
  const features = [...await restaurantFeatures(ctx.deps.db, rid)];
  const r = rows[0];
  const overview = {
    plan: { code: r?.code ?? "starter", name: r?.name ?? "Starter", tagline: r?.tagline ?? "" },
    status: r?.status ?? "ativa",
    valid_until: r?.valid_until ?? null,
    features,
    storage: { used_bytes: Number(r?.used ?? 0), quota_bytes: ctx.deps.config.assetQuotaBytes }
  };
  return json({ plan: overview, catalog: Object.values(FEATURES), contact: ctx.deps.config.commercial });
}
var restaurantRoutes = [
  { method: "GET", path: "/api/restaurants/current/plan", access: { roles: ["manager"] }, handler: getPlan },
  { method: "GET", path: "/api/restaurants/current", access: { roles: staffRoles3 }, handler: getCurrent },
  { method: "PATCH", path: "/api/restaurants/current", access: { roles: ["manager"] }, handler: updateCurrent }
];

// server/src/modules/staff/routes.ts
var toView3 = (r, selfId) => ({
  user_id: r.user_id,
  name: r.name,
  email: r.email,
  role: r.role,
  active: r.active,
  must_change_password: r.must_change_password,
  last_login_at: iso(r.last_login_at),
  is_self: r.user_id === selfId
});
async function list7(ctx) {
  const a = ctx.auth;
  const rows = await ctx.deps.db.system((tx) => tx`
      SELECT m.user_id, u.name, u.email, m.role, m.active, u.must_change_password, u.last_login_at
      FROM restaurant_members m JOIN users u ON u.id = m.user_id
      WHERE m.restaurant_id = ${a.restaurantId}
      ORDER BY m.active DESC, CASE m.role WHEN 'manager' THEN 0 WHEN 'waiter' THEN 1 ELSE 2 END, lower(u.name), u.email`);
  return json({ members: rows.map((r) => toView3(r, a.userId)) });
}
async function create(ctx) {
  const a = ctx.auth;
  const { db, config } = ctx.deps;
  const input = await ctx.body(StaffCreateInput);
  const tempPassword = temporaryPassword();
  const tempHash = await hashPassword(tempPassword, config.scryptLogN);
  try {
    const row = await db.system(async (tx) => {
      const [existing] = await tx`SELECT id FROM users WHERE email = ${input.email}`;
      if (existing)
        throw conflict("J\xE1 existe uma conta com este e-mail.", "EMAIL_TAKEN");
      const [u] = await tx`
        INSERT INTO users (email, name, password_hash, must_change_password) VALUES (${input.email}, ${input.name}, ${tempHash}, true) RETURNING id`;
      await tx`INSERT INTO restaurant_members (restaurant_id, user_id, role) VALUES (${a.restaurantId}, ${u.id}, ${input.role})`;
      await audit(tx, {
        restaurantId: a.restaurantId,
        actorId: a.userId,
        actorRole: a.role,
        action: "staff.create",
        entityType: "user",
        entityId: u.id,
        metadata: { role: input.role, email: input.email },
        ip: ctx.ip
      });
      const [m] = await tx`
        SELECT m.user_id, u.name, u.email, m.role, m.active, u.must_change_password, u.last_login_at
        FROM restaurant_members m JOIN users u ON u.id = m.user_id WHERE m.restaurant_id = ${a.restaurantId} AND m.user_id = ${u.id}`;
      return m;
    });
    return created({ member: toView3(row, a.userId), temporary_password: tempPassword });
  } catch (err) {
    if (pgCode(err) === "23505" && pgConstraint(err) === "users_email_uq")
      throw conflict("J\xE1 existe uma conta com este e-mail.", "EMAIL_TAKEN");
    throw err;
  }
}
async function update2(ctx) {
  const a = ctx.auth;
  const uid = uuid.safeParse(ctx.params.userId);
  if (!uid.success)
    throw notFound("Pessoa n\xE3o encontrada.", "STAFF_NOT_FOUND");
  if (uid.data === a.userId)
    throw forbidden("N\xE3o pode alterar a sua pr\xF3pria conta. Pe\xE7a a outro gerente.", "CANNOT_EDIT_SELF");
  const input = await ctx.body(StaffUpdateInput);
  const row = await ctx.deps.db.system(async (tx) => {
    const [cur] = await tx`
      SELECT m.user_id, u.name, u.email, m.role, m.active, u.must_change_password, u.last_login_at
      FROM restaurant_members m JOIN users u ON u.id = m.user_id
      WHERE m.restaurant_id = ${a.restaurantId} AND m.user_id = ${uid.data} FOR UPDATE OF m`;
    if (!cur)
      throw notFound("Pessoa n\xE3o encontrada.", "STAFF_NOT_FOUND");
    const role = input.role ?? cur.role;
    const active = input.active ?? cur.active;
    await tx`UPDATE restaurant_members SET role = ${role}, active = ${active} WHERE restaurant_id = ${a.restaurantId} AND user_id = ${uid.data}`;
    if (!active) {
      await tx`UPDATE sessions SET revoked_at = now() WHERE user_id = ${uid.data} AND restaurant_id = ${a.restaurantId} AND revoked_at IS NULL`;
    }
    await audit(tx, {
      restaurantId: a.restaurantId,
      actorId: a.userId,
      actorRole: a.role,
      action: "staff.update",
      entityType: "user",
      entityId: uid.data,
      metadata: { ...input.role ? { role: { from: cur.role, to: input.role } } : {}, ...input.active !== undefined ? { active: { from: cur.active, to: input.active } } : {} },
      ip: ctx.ip
    });
    return { ...cur, role, active };
  });
  return json({ member: toView3(row, a.userId) });
}
async function resetPassword(ctx) {
  const a = ctx.auth;
  const { db, config } = ctx.deps;
  const uid = uuid.safeParse(ctx.params.userId);
  if (!uid.success)
    throw notFound("Pessoa n\xE3o encontrada.", "STAFF_NOT_FOUND");
  if (uid.data === a.userId)
    throw forbidden('Para mudar a sua palavra-passe use "Alterar palavra-passe".', "CANNOT_EDIT_SELF");
  const tempPassword = temporaryPassword();
  const tempHash = await hashPassword(tempPassword, config.scryptLogN);
  const email = await db.system(async (tx) => {
    const [m] = await tx`
      SELECT u.email, m.role, m.active FROM restaurant_members m JOIN users u ON u.id = m.user_id
      WHERE m.restaurant_id = ${a.restaurantId} AND m.user_id = ${uid.data}`;
    if (!m)
      throw notFound("Pessoa n\xE3o encontrada.", "STAFF_NOT_FOUND");
    if (!m.active)
      throw conflict("Esta pessoa est\xE1 desativada. Ative-a primeiro.", "STAFF_INACTIVE");
    if (m.role === "manager")
      throw forbidden("A palavra-passe de um gerente \xE9 reposta pela Altiora Grupo.", "MANAGER_RESET_BY_PLATFORM");
    const [other] = await tx`
      SELECT count(*)::int AS n FROM restaurant_members WHERE user_id = ${uid.data} AND restaurant_id <> ${a.restaurantId}`;
    if (other.n > 0)
      throw conflict("Esta conta tamb\xE9m \xE9 usada noutro restaurante. Pe\xE7a \xE0 Altiora Grupo para repor a palavra-passe.", "SHARED_ACCOUNT");
    await tx`UPDATE users SET password_hash = ${tempHash}, must_change_password = true WHERE id = ${uid.data}`;
    await audit(tx, {
      restaurantId: a.restaurantId,
      actorId: a.userId,
      actorRole: a.role,
      action: "staff.password_reset",
      entityType: "user",
      entityId: uid.data,
      ip: ctx.ip
    });
    return m.email;
  });
  await revokeSessionsOfUser(db, uid.data);
  return json({ email, temporary_password: tempPassword });
}
var staffRoutes = [
  { method: "GET", path: "/api/staff", access: { roles: ["manager"] }, handler: list7 },
  { method: "POST", path: "/api/staff", access: { roles: ["manager"] }, handler: create, limits: [{ name: "staff-create", max: 30, windowMs: 60000 }] },
  { method: "PATCH", path: "/api/staff/:userId", access: { roles: ["manager"] }, handler: update2, limits: [{ name: "staff-update", max: 60, windowMs: 60000 }] },
  { method: "POST", path: "/api/staff/:userId/reset-password", access: { roles: ["manager"] }, handler: resetPassword, noBody: true, limits: [{ name: "staff-reset", max: 20, windowMs: 60000 }] }
];

// server/src/modules/system/routes.ts
var staffRoles4 = ["manager", "waiter", "kitchen"];
var healthCache = new WeakMap;
async function health(ctx) {
  const now = Date.now();
  let cached = healthCache.get(ctx.deps.db);
  if (!cached || now - cached.at > 2000) {
    cached = { at: now, ok: await ctx.deps.db.ping() };
    healthCache.set(ctx.deps.db, cached);
  }
  const body = {
    status: cached.ok ? "ok" : "degraded",
    database: cached.ok ? "ok" : "indispon\xEDvel",
    version: ctx.deps.config.version,
    time: new Date(now).toISOString()
  };
  return json(body, cached.ok ? 200 : 503);
}
var MAX_STAFF_STREAMS_PER_USER = 8;
function staffStream(ctx) {
  const a = ctx.auth;
  const release = ctx.deps.hub.acquireSlot(`staff-sse:${a.userId}`, MAX_STAFF_STREAMS_PER_USER);
  if (!release)
    throw tooMany("H\xE1 demasiados pain\xE9is abertos com esta conta.", 30, "TOO_MANY_STREAMS");
  const rid = a.restaurantId;
  return sseResponse(ctx.req, {
    hello: { type: "hello", at: new Date().toISOString() },
    subscribe: (send) => ctx.deps.hub.subscribeRestaurant(rid, send),
    maxLifetimeMs: 15 * 60000,
    onClose: release
  });
}
var systemRoutes = [
  { method: "GET", path: "/api/health", access: "public", handler: health, limits: [{ name: "health", max: 120, windowMs: 60000 }] },
  { method: "GET", path: "/api/realtime/stream", access: { roles: staffRoles4 }, handler: staffStream, limits: [{ name: "staff-stream", max: 60, windowMs: 60000 }] }
];

// server/src/modules/tables/routes.ts
var staffRoles5 = ["manager", "waiter", "kitchen"];
function view3(row, baseUrl) {
  return {
    id: row.id,
    table_number: row.table_number,
    label: row.label,
    active: row.active,
    active_orders: row.active_orders,
    ready_orders: row.ready_orders,
    ...row.qr_token ? { qr_url: `${baseUrl}/menu/${row.qr_token}`, qr_rotated_at: iso(row.qr_rotated_at) } : {}
  };
}
function auth(ctx) {
  const a = ctx.auth;
  return { role: a.role, restaurantId: a.restaurantId, userId: a.userId };
}
async function listTables(ctx) {
  const a = auth(ctx);
  const tables = await ctx.deps.db.as({ role: a.role, restaurantId: a.restaurantId, userId: a.userId }, async (tx) => {
    const [r] = await tx`SELECT menu_base_url FROM restaurants WHERE id = ${a.restaurantId}`;
    const baseUrl = r?.menu_base_url ?? ctx.deps.config.publicBaseUrl;
    const rows = a.role === "manager" ? await tx`
            SELECT t.id, t.table_number, t.label, t.active, t.qr_token, t.qr_rotated_at,
                   (SELECT count(*)::int FROM orders o WHERE o.table_id = t.id AND o.status IN ('novo', 'em_preparacao', 'pronto')) AS active_orders,
                   (SELECT count(*)::int FROM orders o WHERE o.table_id = t.id AND o.status = 'pronto') AS ready_orders
            FROM restaurant_tables t WHERE t.restaurant_id = ${a.restaurantId} ORDER BY t.table_number` : await tx`
            SELECT t.id, t.table_number, t.label, t.active,
                   (SELECT count(*)::int FROM orders o WHERE o.table_id = t.id AND o.status IN ('novo', 'em_preparacao', 'pronto')) AS active_orders,
                   (SELECT count(*)::int FROM orders o WHERE o.table_id = t.id AND o.status = 'pronto') AS ready_orders
            FROM restaurant_tables t WHERE t.restaurant_id = ${a.restaurantId} ORDER BY t.table_number`;
    return rows.map((row) => view3(row, baseUrl));
  });
  return json({ tables });
}
async function createTable(ctx) {
  await requireFeature(ctx.deps.db, ctx.auth.restaurantId, "tables", "a gest\xE3o de mesas");
  const a = auth(ctx);
  const input = await ctx.body(TableCreateInput);
  const table = await ctx.deps.db.as({ role: "manager", restaurantId: a.restaurantId, userId: a.userId }, async (tx) => {
    const [row] = await tx`
      INSERT INTO restaurant_tables (restaurant_id, table_number, label, qr_token)
      VALUES (${a.restaurantId}, ${input.table_number}, ${input.label}, ${randomToken(16)})
      RETURNING id, table_number, label, active, qr_token, qr_rotated_at, 0 AS active_orders, 0 AS ready_orders`;
    const [r] = await tx`SELECT menu_base_url FROM restaurants WHERE id = ${a.restaurantId}`;
    await audit(tx, {
      restaurantId: a.restaurantId,
      actorId: a.userId,
      actorRole: a.role,
      action: "table.create",
      entityType: "table",
      entityId: row.id,
      metadata: { table_number: input.table_number },
      ip: ctx.ip
    });
    return view3(row, r?.menu_base_url ?? ctx.deps.config.publicBaseUrl);
  });
  return created({ table });
}
async function updateTable(ctx) {
  const a = auth(ctx);
  const id = uuid.safeParse(ctx.params.id);
  if (!id.success)
    throw notFound("Mesa n\xE3o encontrada.", "TABLE_NOT_FOUND");
  const input = await ctx.body(TableUpdateInput);
  const table = await ctx.deps.db.as({ role: "manager", restaurantId: a.restaurantId, userId: a.userId }, async (tx) => {
    const [current] = await tx`
      SELECT label, active FROM restaurant_tables WHERE id = ${id.data} AND restaurant_id = ${a.restaurantId} FOR UPDATE`;
    if (!current)
      throw notFound("Mesa n\xE3o encontrada.", "TABLE_NOT_FOUND");
    const label = "label" in input ? input.label ?? null : current.label;
    const active = input.active ?? current.active;
    const [row] = await tx`
      UPDATE restaurant_tables SET label = ${label}, active = ${active}
      WHERE id = ${id.data} AND restaurant_id = ${a.restaurantId}
      RETURNING id, table_number, label, active, qr_token, qr_rotated_at, 0 AS active_orders, 0 AS ready_orders`;
    const [r] = await tx`SELECT menu_base_url FROM restaurants WHERE id = ${a.restaurantId}`;
    await audit(tx, {
      restaurantId: a.restaurantId,
      actorId: a.userId,
      actorRole: a.role,
      action: "table.update",
      entityType: "table",
      entityId: id.data,
      metadata: { table_number: row.table_number, active, active_changed: active !== current.active, label_changed: label !== current.label },
      ip: ctx.ip
    });
    return view3(row, r?.menu_base_url ?? ctx.deps.config.publicBaseUrl);
  });
  return json({ table });
}
async function regenerateQr(ctx) {
  await requireFeature(ctx.deps.db, ctx.auth.restaurantId, "tables", "a gest\xE3o de mesas");
  const a = auth(ctx);
  const id = uuid.safeParse(ctx.params.id);
  if (!id.success)
    throw notFound("Mesa n\xE3o encontrada.", "TABLE_NOT_FOUND");
  const table = await ctx.deps.db.as({ role: "manager", restaurantId: a.restaurantId, userId: a.userId }, async (tx) => {
    const [row] = await tx`
      UPDATE restaurant_tables SET qr_token = ${randomToken(16)}, qr_rotated_at = now()
      WHERE id = ${id.data} AND restaurant_id = ${a.restaurantId}
      RETURNING id, table_number, label, active, qr_token, qr_rotated_at, 0 AS active_orders, 0 AS ready_orders`;
    if (!row)
      throw notFound("Mesa n\xE3o encontrada.", "TABLE_NOT_FOUND");
    await tx`UPDATE table_sessions SET closed_at = now(), closed_by = ${a.userId}, close_reason = 'qr_renovado'
             WHERE table_id = ${id.data} AND restaurant_id = ${a.restaurantId} AND closed_at IS NULL`;
    const [r] = await tx`SELECT menu_base_url FROM restaurants WHERE id = ${a.restaurantId}`;
    await audit(tx, {
      restaurantId: a.restaurantId,
      actorId: a.userId,
      actorRole: a.role,
      action: "table.qr_regenerated",
      entityType: "table",
      entityId: id.data,
      metadata: { table_number: row.table_number },
      ip: ctx.ip
    });
    return view3(row, r?.menu_base_url ?? ctx.deps.config.publicBaseUrl);
  });
  return json({ table });
}
async function deleteTable(ctx) {
  const a = auth(ctx);
  const id = uuid.safeParse(ctx.params.id);
  if (!id.success)
    throw notFound("Mesa n\xE3o encontrada.", "TABLE_NOT_FOUND");
  try {
    await ctx.deps.db.as({ role: "manager", restaurantId: a.restaurantId, userId: a.userId }, async (tx) => {
      const rows = await tx`DELETE FROM restaurant_tables WHERE id = ${id.data} AND restaurant_id = ${a.restaurantId} RETURNING id`;
      if (rows.length === 0)
        throw notFound("Mesa n\xE3o encontrada.", "TABLE_NOT_FOUND");
      await audit(tx, {
        restaurantId: a.restaurantId,
        actorId: a.userId,
        actorRole: a.role,
        action: "table.delete",
        entityType: "table",
        entityId: id.data,
        ip: ctx.ip
      });
    });
  } catch (err) {
    if (pgCode(err) === "23503")
      throw conflict("Esta mesa j\xE1 tem pedidos registados. Desative-a em vez de a apagar.", "TABLE_HAS_ORDERS");
    throw err;
  }
  return noContent();
}
async function closeSession(ctx) {
  const a = auth(ctx);
  const id = uuid.safeParse(ctx.params.id);
  if (!id.success)
    throw notFound("Mesa n\xE3o encontrada.", "TABLE_NOT_FOUND");
  const closed = await ctx.deps.db.as({ role: a.role, restaurantId: a.restaurantId, userId: a.userId }, async (tx) => {
    const [t] = await tx`SELECT table_number FROM restaurant_tables WHERE id = ${id.data} AND restaurant_id = ${a.restaurantId}`;
    if (!t)
      throw notFound("Mesa n\xE3o encontrada.", "TABLE_NOT_FOUND");
    const rows = await tx`
      UPDATE table_sessions SET closed_at = now(), closed_by = ${a.userId}, close_reason = 'mesa_libertada'
      WHERE table_id = ${id.data} AND restaurant_id = ${a.restaurantId} AND closed_at IS NULL
      RETURNING id`;
    if (rows.length > 0) {
      await audit(tx, {
        restaurantId: a.restaurantId,
        actorId: a.userId,
        actorRole: a.role,
        action: "table.session_closed",
        entityType: "table",
        entityId: id.data,
        metadata: { table_number: t.table_number },
        ip: ctx.ip
      });
    }
    return rows.length > 0;
  });
  return json({ closed });
}
var tableRoutes = [
  { method: "GET", path: "/api/tables", access: { roles: staffRoles5 }, handler: listTables },
  { method: "POST", path: "/api/tables", access: { roles: ["manager"] }, handler: createTable },
  { method: "PATCH", path: "/api/tables/:id", access: { roles: ["manager"] }, handler: updateTable },
  { method: "POST", path: "/api/tables/:id/regenerate-qr", access: { roles: ["manager"] }, handler: regenerateQr, noBody: true },
  { method: "DELETE", path: "/api/tables/:id", access: { roles: ["manager"] }, handler: deleteTable, noBody: true },
  { method: "POST", path: "/api/tables/:id/close-session", access: { roles: ["manager", "waiter"] }, handler: closeSession, noBody: true }
];

// server/src/modules/index.ts
var allRoutes = [
  ...systemRoutes,
  ...publicRoutes,
  ...authRoutes,
  ...assetRoutes,
  ...orderRoutes,
  ...paymentRoutes,
  ...staffRoutes,
  ...reportRoutes,
  ...activityRoutes,
  ...tableRoutes,
  ...menuRoutes,
  ...restaurantRoutes,
  ...adminRoutes,
  ...billingRoutes,
  ...callRoutes,
  ...qrRoutes,
  ...leadRoutes
];

// server/src/site/site.ts
import { readFile as readFile2 } from "fs/promises";
import { join as join2 } from "path";

// server/src/site/landing.ts
var ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
var esc = (v) => v.replace(/[&<>"']/g, (c) => ESC[c]);
function safeUrl(u) {
  if (!u)
    return null;
  if (/^\/(?![/\\])/.test(u))
    return u;
  if (/^https:\/\//i.test(u))
    return u;
  return null;
}
var digits = (v) => v.replace(/\D/g, "");
var ICONS = {
  qr: '<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z"/><path d="M14 14h3v3h-3zM20 14v2M14 20h2M18 19h2v2h-2z"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  cube: '<path d="M12 2.5l8.5 4.8v9.4L12 21.5l-8.5-4.8V7.3z"/><path d="M12 12l8.5-4.7M12 12v9.5M12 12L3.5 7.3"/>',
  bell: '<path d="M6 16.5V11a6 6 0 0112 0v5.5l1.5 2h-15z"/><path d="M10 21h4"/>',
  chart: '<path d="M4 20V4M4 20h16"/><path d="M8 16v-4M12 16V8M16 16v-6"/>',
  shield: '<path d="M12 2.5l7.5 3v6c0 4.7-3.2 8.2-7.5 10-4.3-1.8-7.5-5.3-7.5-10v-6z"/><path d="M9 12l2.2 2.2L15.5 10"/>',
  bolt: '<path d="M13 2.5L5 13.5h6l-1 8 8-11h-6z"/>',
  check: '<path d="M5 12.5l4.2 4.2L19 7"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  store: '<path d="M4 9.5L5.5 4h13L20 9.5"/><path d="M4 9.5a2.7 2.7 0 005.3 0 2.7 2.7 0 005.4 0 2.7 2.7 0 005.3 0"/><path d="M5 12.5V20h14v-7.5"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 6.5L12 13l8.5-6.5"/>',
  pin: '<path d="M12 21s-6.5-5.7-6.5-11a6.5 6.5 0 0113 0c0 5.3-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  call: '<path d="M5 4h4l1.5 4-2 1.5a11 11 0 005 5l1.5-2 4 1.5v4a2 2 0 01-2 2A15 15 0 013 6a2 2 0 012-2z"/>'
};
var icon = (name, cls = "") => `<svg class="lp-ic${cls ? ` ${cls}` : ""}" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;
var MARK = '<svg class="lp-mark" viewBox="0 0 32 32" width="28" height="28" aria-hidden="true" focusable="false"><rect x="3" y="3" width="26" height="26" rx="7" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M9.5 22.5L16 9l6.5 13.5M12 18.2h8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
var TITLE = "ALTIORA MENU \u2014 Card\xE1pios digitais com QR Code, 3D e realidade aumentada";
var DESCRIPTION = "Card\xE1pios digitais para restaurantes: QR Code por mesa, pratos em 3D e realidade aumentada, pedidos em tempo real e pre\xE7os em Kwanza. Sem aplica\xE7\xE3o para instalar.";
var FAQ = [
  { q: "Os clientes precisam de instalar alguma aplica\xE7\xE3o?", a: "N\xE3o. O cliente l\xEA o QR Code com a c\xE2mara do telem\xF3vel e o card\xE1pio abre no navegador, como uma p\xE1gina normal." },
  {
    q: "Tenho de ter modelos 3D de todos os pratos?",
    a: "N\xE3o. Os pratos que t\xEAm modelo 3D mostram o bot\xE3o \xABVer em 3D\xBB; os restantes mostram a fotografia. Pode come\xE7ar s\xF3 com fotografias e juntar modelos mais tarde, no plano que inclui 3D."
  },
  {
    q: "Como funciona a realidade aumentada (\xABVer na minha mesa\xBB)?",
    a: "Em telem\xF3veis compat\xEDveis, o cliente pousa o prato virtual na mesa, atrav\xE9s da c\xE2mara. O bot\xE3o s\xF3 aparece em aparelhos que o permitem; nos outros, o cliente v\xEA o prato em 3D ou a fotografia."
  },
  {
    q: "Como recebo os pedidos?",
    a: "Pelo sistema: a cozinha e os empregados veem cada pedido em tempo real, por mesa. Se preferir, o cliente envia o pedido j\xE1 escrito para o WhatsApp do restaurante. Cada op\xE7\xE3o depende do plano escolhido."
  },
  { q: "O sistema cobra pagamentos aos clientes?", a: "N\xE3o. O cliente n\xE3o paga pelo telem\xF3vel: faz o pedido e, se precisar de ajuda, chama o gar\xE7om com um toque. O pagamento faz-se no restaurante, como hoje." },
  {
    q: "Os dados do meu restaurante ficam separados dos outros?",
    a: "Sim. Cada restaurante s\xF3 v\xEA os seus pr\xF3prios dados. A equipa da Altiora v\xEA o estado, o plano e n\xFAmeros gerais de utiliza\xE7\xE3o, mas n\xE3o os pedidos, os menus nem os relat\xF3rios dos restaurantes."
  },
  {
    q: "Em que moedas posso mostrar os pre\xE7os?",
    a: "Em Kwanza (AOA) e noutras moedas: d\xF3lar, euro, real, metical, escudo cabo-verdiano, rand e libra. A moeda escolhe-se ao criar o restaurante e n\xE3o se muda depois de haver pedidos."
  },
  { q: "Posso mudar de plano mais tarde?", a: "Sim. A Altiora altera o plano do restaurante e as funcionalidades novas ficam dispon\xEDveis em poucos segundos." },
  { q: "Quanto custa?", a: "Os pre\xE7os de cada plano est\xE3o na sec\xE7\xE3o Planos. Onde ainda n\xE3o houver pre\xE7o indicado, pe\xE7a uma proposta pelo formul\xE1rio e dizemos-lhe o valor para o seu restaurante." }
];
var BENEFITS = [
  { icon: "phone", title: "Sem aplica\xE7\xE3o", text: "Funciona no navegador do telem\xF3vel. O cliente l\xEA o QR Code e j\xE1 est\xE1 no card\xE1pio." },
  { icon: "bolt", title: "Atualiza em segundos", text: "Mude pre\xE7os, esgote um prato ou acrescente novidades. O QR Code impresso continua a servir." },
  { icon: "cube", title: "Pratos que se veem antes de pedir", text: "Fotografias, ingredientes, alerg\xE9nios e, onde existir, o prato em 3D e na mesa do cliente." },
  { icon: "bell", title: "Pedidos e chamadas sem confus\xE3o", text: "A cozinha e os empregados recebem os pedidos em tempo real; o cliente chama o gar\xE7om com um toque." },
  { icon: "chart", title: "N\xFAmeros que ajudam a decidir", text: "Vendas por dia, pratos mais vendidos e exporta\xE7\xE3o para folha de c\xE1lculo (planos com estat\xEDsticas)." },
  { icon: "shield", title: "Cada restaurante, os seus dados", text: "Os dados de cada restaurante est\xE3o separados. A Altiora n\xE3o v\xEA os seus pedidos nem os seus relat\xF3rios." }
];
var FEATURE_GROUPS = [
  {
    title: "Para o cliente",
    icon: "phone",
    items: [
      "Pesquisa instant\xE2nea e filtros por categoria",
      "Ingredientes e alerg\xE9nios em cada prato",
      "Tamanhos e extras \xE0 escolha",
      "Prato em 3D e na mesa (realidade aumentada) quando existe modelo",
      "Carrinho com notas e envio do pedido",
      "Chamar o gar\xE7om com um toque"
    ]
  },
  {
    title: "Para a equipa",
    icon: "bell",
    items: [
      "Ecr\xE3 da cozinha com os pedidos novos em tempo real",
      "Ecr\xE3 do empregado com as chamadas de cada mesa",
      "Estados do pedido: novo, em prepara\xE7\xE3o, pronto, entregue",
      "Um QR Code por mesa, em PDF pronto a imprimir"
    ]
  },
  {
    title: "Para o dono",
    icon: "store",
    items: [
      "Pratos, categorias, pre\xE7os, fotografias e modelos 3D",
      "Dispon\xEDvel ou esgotado em segundos",
      "Estat\xEDsticas e pratos mais vendidos, com exporta\xE7\xE3o em CSV",
      "Registo da atividade da equipa",
      "Log\xF3tipo, capa e cores do restaurante"
    ]
  }
];
function header(hasDemo, has3d) {
  const links = [
    hasDemo ? ["#cardapio", "Card\xE1pio"] : null,
    has3d ? ["#modelo-3d", "3D e AR"] : null,
    ["#funcionalidades", "Funcionalidades"],
    ["#planos", "Planos"],
    ["#perguntas", "Perguntas"]
  ].filter((x) => x !== null);
  return `<a class="lp-skip" href="#conteudo">Saltar para o conte\xFAdo</a>
<header class="lp-header" id="topo">
  <div class="lp-wrap lp-header-row">
    <a class="lp-brand" href="/" aria-label="ALTIORA MENU \u2014 in\xEDcio">${MARK}<span class="lp-brand-name">ALTIORA <b>MENU</b></span></a>
    <button class="lp-nav-toggle" type="button" aria-expanded="false" aria-controls="lp-nav"><span class="lp-sr">Menu</span><span class="lp-burger" aria-hidden="true"></span></button>
    <nav class="lp-nav" id="lp-nav" aria-label="Principal">
      <ul>${links.map(([href, label]) => `<li><a href="${href}">${label}</a></li>`).join("")}</ul>
      <a class="lp-btn lp-btn-gold lp-btn-sm" href="#contacto">Pedir demonstra\xE7\xE3o</a>
    </nav>
  </div>
</header>`;
}
function heroPhone(d) {
  const demo = d.demo;
  if (!demo) {
    return `<div class="lp-phone" role="img" aria-label="Ilustra\xE7\xE3o de um card\xE1pio num telem\xF3vel"><div class="lp-phone-screen">
      <div class="lp-phone-top"><span class="lp-phone-logo">${MARK}</span><div><p class="lp-phone-name">O seu restaurante</p><p class="lp-phone-sub">Mesa 5 \xB7 Card\xE1pio</p></div></div>
      <div class="lp-phone-chips"><span class="is-on">Todos</span><span>Entradas</span><span>Pratos</span></div>
      ${'<div class="lp-phone-row lp-phone-skel"><span class="lp-skel-img"></span><div><span class="lp-skel-line"></span><span class="lp-skel-line lp-skel-short"></span></div></div>'.repeat(3)}
    </div></div>`;
  }
  const cats = [...new Set(demo.dishes.map((x) => x.category))].slice(0, 2);
  const logo = safeUrl(demo.logo_url);
  const rows = demo.dishes.slice(0, 4);
  return `<div class="lp-phone" role="img" aria-label="Exemplo do card\xE1pio de ${esc(demo.name)} no telem\xF3vel"><div class="lp-phone-screen">
      <div class="lp-phone-top">${logo ? `<img class="lp-phone-logo" src="${esc(logo)}" alt="" width="36" height="36" decoding="async" />` : `<span class="lp-phone-logo">${MARK}</span>`}<div><p class="lp-phone-name">${esc(demo.name)}</p><p class="lp-phone-sub">Mesa 5 \xB7 Card\xE1pio</p></div></div>
      <div class="lp-phone-chips"><span class="is-on">Todos</span>${cats.map((c) => `<span>${esc(c)}</span>`).join("")}</div>
      ${rows.map((r) => {
    const img = safeUrl(r.thumb_url ?? r.image_url);
    return `<div class="lp-phone-row">${img ? `<img src="${esc(img)}" alt="" width="56" height="56" decoding="async" />` : '<span class="lp-skel-img"></span>'}<div><p class="lp-phone-dish">${esc(r.name)}</p><p class="lp-phone-price">${esc(formatMoney(r.price_cents, demo.currency))}</p></div>${r.model_url ? '<span class="lp-phone-3d">3D</span>' : ""}</div>`;
  }).join("")}
    </div></div>`;
}
function hero(d) {
  const demo = d.demo;
  const qr = demo ? qrSvg(encodeQr(`${d.base_url}/r/${demo.slug}`, "M"), { quiet: 1, dark: "#0d0d0f", light: "#fbfaf7" }) : null;
  return `<section class="lp-hero" aria-labelledby="lp-h1">
  <div class="lp-hero-glow" aria-hidden="true"></div>
  <div class="lp-wrap lp-hero-grid">
    <div class="lp-hero-copy">
      <p class="lp-eyebrow">Digital Dining Experience</p>
      <h1 id="lp-h1">O card\xE1pio do seu restaurante, num QR Code e <span class="lp-gold">em 3D</span>.</h1>
      <p class="lp-lead">Os clientes leem o QR Code da mesa e veem o menu no telem\xF3vel, com fotografias, pre\xE7os em Kwanza e pratos em 3D. Sem instalar nenhuma aplica\xE7\xE3o.</p>
      <div class="lp-cta-row">
        <a class="lp-btn lp-btn-gold" href="#contacto">Pedir demonstra\xE7\xE3o ${icon("arrow")}</a>
        ${demo ? `<a class="lp-btn lp-btn-ghost-light" href="/r/${esc(demo.slug)}">Ver um card\xE1pio de exemplo</a>` : '<a class="lp-btn lp-btn-ghost-light" href="#funcionalidades">Ver funcionalidades</a>'}
      </div>
      <ul class="lp-proof"><li>${icon("check")}Sem aplica\xE7\xE3o para instalar</li><li>${icon("check")}QR Code por mesa</li><li>${icon("check")}Pre\xE7os em Kwanza e outras moedas</li></ul>
    </div>
    <div class="lp-hero-visual">
      ${heroPhone(d)}
      ${qr ? `<figure class="lp-qrcard"><div class="lp-qrcard-img">${qr}</div><figcaption>Aponte a c\xE2mara do telem\xF3vel: abre o card\xE1pio de exemplo.</figcaption></figure>` : ""}
    </div>
  </div>
</section>`;
}
function steps() {
  const items = [
    ["qr", "Imprima o QR Code", "Gere o PDF do restaurante ou de cada mesa, pronto a imprimir e a colocar na mesa."],
    ["phone", "O cliente abre o card\xE1pio", "Fotografias, ingredientes, alerg\xE9nios, tamanhos e extras. Nos pratos com modelo, \xABVer em 3D\xBB e \xABVer na minha mesa\xBB."],
    ["bell", "O pedido chega \xE0 equipa", "Pelo sistema, em tempo real para a cozinha e os empregados, ou por WhatsApp. O cliente pode ainda chamar o gar\xE7om."]
  ];
  return `<section class="lp-section" id="como-funciona" aria-labelledby="lp-h-steps">
  <div class="lp-wrap">
    <header class="lp-sec-head lp-center" data-reveal><p class="lp-eyebrow lp-eyebrow-dark">Como funciona</p><h2 id="lp-h-steps">Tr\xEAs passos, sem aplica\xE7\xE3o</h2></header>
    <ol class="lp-steps">${items.map(([ic, t, p], i) => `<li class="lp-step" data-reveal><span class="lp-step-n" aria-hidden="true">${i + 1}</span><span class="lp-step-ic">${icon(ic)}</span><h3>${t}</h3><p>${p}</p></li>`).join("")}</ol>
  </div>
</section>`;
}
function dishCard(x, currency) {
  const img = safeUrl(x.thumb_url ?? x.image_url);
  return `<article class="lp-dish" data-category="${esc(x.category)}">
      <div class="lp-dish-media">${img ? `<img src="${esc(img)}" alt="${esc(x.name)}" width="480" height="360" loading="lazy" decoding="async" />` : `<span class="lp-dish-noimg">${icon("layers")}</span>`}${x.model_url ? '<span class="lp-tag">3D</span>' : ""}</div>
      <div class="lp-dish-body">
        <p class="lp-dish-cat">${esc(x.category)}</p>
        <h3>${esc(x.name)}</h3>
        ${x.description ? `<p class="lp-dish-desc">${esc(x.description)}</p>` : ""}
        <div class="lp-dish-foot"><span class="lp-price">${esc(formatMoney(x.price_cents, currency))}</span>${x.allergens.length ? `<span class="lp-allergens" title="Alerg\xE9nios">${x.allergens.slice(0, 3).map((a) => `<span>${esc(a)}</span>`).join("")}</span>` : ""}</div>
      </div>
    </article>`;
}
function demoMenu(d) {
  const demo = d.demo;
  if (!demo || demo.dishes.length === 0)
    return "";
  const cats = [...new Set(demo.dishes.map((x) => x.category))];
  return `<section class="lp-section lp-alt" id="cardapio" aria-labelledby="lp-h-menu">
  <div class="lp-wrap">
    <header class="lp-sec-head lp-center" data-reveal>
      <p class="lp-eyebrow lp-eyebrow-dark">Card\xE1pio de exemplo</p>
      <h2 id="lp-h-menu">\xC9 assim que o cliente v\xEA o menu</h2>
      <p>Pratos do restaurante de demonstra\xE7\xE3o \xAB${esc(demo.name)}\xBB: fotografia, pre\xE7o, alerg\xE9nios e, onde existe, o selo 3D.</p>
    </header>
    ${cats.length > 1 ? `<div class="lp-chips" role="group" aria-label="Filtrar por categoria" hidden><button type="button" class="lp-chip is-on" data-cat="">Todos</button>${cats.map((c) => `<button type="button" class="lp-chip" data-cat="${esc(c)}">${esc(c)}</button>`).join("")}</div>` : ""}
    <div class="lp-dish-grid" data-reveal>${demo.dishes.map((x) => dishCard(x, demo.currency)).join("")}</div>
    <p class="lp-note">Pratos, imagens e pre\xE7os de exemplo, criados s\xF3 para esta demonstra\xE7\xE3o. No seu restaurante ser\xE3o os seus.</p>
    <p class="lp-center"><a class="lp-btn lp-btn-dark" href="/r/${esc(demo.slug)}">Abrir o card\xE1pio completo ${icon("arrow")}</a></p>
  </div>
</section>`;
}
function demo3d(d) {
  const dish = d.demo?.model_dish;
  const model = safeUrl(dish?.model_url);
  if (!d.demo || !dish || !model)
    return "";
  const poster = safeUrl(dish.image_url);
  return `<section class="lp-section lp-dark" id="modelo-3d" aria-labelledby="lp-h-3d">
  <div class="lp-wrap lp-3d-grid">
    <div class="lp-3d-copy" data-reveal>
      <p class="lp-eyebrow">3D e realidade aumentada</p>
      <h2 id="lp-h-3d">Veja o prato antes de o pedir</h2>
      <p class="lp-lead">Toque em \xABVer em 3D\xBB e rode o prato com o dedo. Em telem\xF3veis compat\xEDveis, \xABVer na minha mesa\xBB pousa o prato em cima da mesa, atrav\xE9s da c\xE2mara.</p>
      <ul class="lp-checks">
        <li>${icon("check")}Roda e amplia com os dedos</li>
        <li>${icon("check")}S\xF3 aparece nos pratos que t\xEAm modelo; nos outros, fica a fotografia</li>
        <li>${icon("check")}A realidade aumentada depende do telem\xF3vel e nunca \xE9 simulada</li>
      </ul>
      <p class="lp-note lp-note-dark">Modelo de demonstra\xE7\xE3o, gerado por computador.</p>
    </div>
    <div class="lp-3d-stage" data-reveal data-model="${esc(model)}" data-title="${esc(dish.name)}" data-fallback="/r/${esc(d.demo.slug)}">
      <div class="v3d-wrap lp-3d-wrap">
        ${poster ? `<img class="v3d-poster" src="${esc(poster)}" alt="${esc(dish.name)}" width="1200" height="900" loading="lazy" decoding="async" />` : ""}
        <div class="v3d-host" hidden></div>
        <button class="lp-btn lp-btn-gold lp-3d-open" type="button" hidden>${icon("cube")}Ver em 3D</button>
        <p class="v3d-status lp-3d-status" role="status" hidden></p>
      </div>
      <p class="lp-3d-caption"><strong>${esc(dish.name)}</strong> \xB7 ${esc(formatMoney(dish.price_cents, d.demo.currency))}</p>
    </div>
  </div>
</section>`;
}
function benefits() {
  return `<section class="lp-section" id="beneficios" aria-labelledby="lp-h-ben">
  <div class="lp-wrap">
    <header class="lp-sec-head lp-center" data-reveal><p class="lp-eyebrow lp-eyebrow-dark">Porqu\xEA o ALTIORA MENU</p><h2 id="lp-h-ben">Menos papel, menos filas, mais pedidos certos</h2></header>
    <div class="lp-cards">${BENEFITS.map((b) => `<article class="lp-card" data-reveal><span class="lp-card-ic">${icon(b.icon)}</span><h3>${b.title}</h3><p>${b.text}</p></article>`).join("")}</div>
  </div>
</section>`;
}
function features() {
  return `<section class="lp-section lp-alt" id="funcionalidades" aria-labelledby="lp-h-feat">
  <div class="lp-wrap">
    <header class="lp-sec-head lp-center" data-reveal><p class="lp-eyebrow lp-eyebrow-dark">Funcionalidades</p><h2 id="lp-h-feat">Tudo o que o restaurante usa no dia a dia</h2></header>
    <div class="lp-feat-grid">${FEATURE_GROUPS.map((g) => `<article class="lp-feat" data-reveal><h3><span class="lp-card-ic">${icon(g.icon)}</span>${g.title}</h3><ul>${g.items.map((i) => `<li>${icon("check")}<span>${i}</span></li>`).join("")}</ul></article>`).join("")}</div>
  </div>
</section>`;
}
function planBullets(plans, i) {
  const cur = plans[i];
  const included = cur.features.filter((f) => f.included);
  const prev = plans[i - 1];
  if (prev) {
    const prevKeys = prev.features.filter((f) => f.included).map((f) => f.key);
    const curKeys = new Set(included.map((f) => f.key));
    if (prevKeys.length > 0 && prevKeys.every((k) => curKeys.has(k))) {
      const extra = included.filter((f) => !prevKeys.includes(f.key));
      return extra.length > 0 ? { lead: `Tudo do plano ${prev.name}, e ainda:`, items: extra.map((f) => f.label) } : { lead: `Inclui o mesmo que o plano ${prev.name}.`, items: [] };
    }
  }
  return { lead: null, items: included.map((f) => f.label) };
}
function planCard(plans, i) {
  const p = plans[i];
  const b = planBullets(plans, i);
  const price = p.price ? `<p class="lp-plan-price"><span class="lp-plan-amount">${esc(formatMoney(p.price.monthly_cents, p.price.currency))}</span> <span class="lp-plan-per">por m\xEAs</span></p>${p.price.yearly_cents !== null ? `<p class="lp-plan-year">ou ${esc(formatMoney(p.price.yearly_cents, p.price.currency))} por ano</p>` : ""}` : '<p class="lp-plan-price lp-plan-ask">Pre\xE7o sob consulta</p>';
  return `<article class="lp-plan${p.highlighted ? " is-hot" : ""}" data-reveal>
      ${p.highlighted ? '<p class="lp-plan-badge">Mais escolhido</p>' : ""}
      <h3>${esc(p.name)}</h3>
      ${p.tagline ? `<p class="lp-plan-tag">${esc(p.tagline)}</p>` : ""}
      ${price}
      ${b.lead ? `<p class="lp-plan-lead">${esc(b.lead)}</p>` : ""}
      ${b.items.length ? `<ul class="lp-plan-list">${b.items.map((t) => `<li>${icon("check")}<span>${esc(t)}</span></li>`).join("")}</ul>` : ""}
      <a class="lp-btn ${p.highlighted ? "lp-btn-gold" : "lp-btn-ghost-light"} lp-btn-block" href="#contacto" data-plan="${esc(p.code)}">Pedir o plano ${esc(p.name)}</a>
    </article>`;
}
function plans(d) {
  if (d.plans.length === 0)
    return "";
  return `<section class="lp-section lp-dark lp-plans" id="planos" aria-labelledby="lp-h-plans">
  <div class="lp-wrap">
    <header class="lp-sec-head lp-center" data-reveal>
      <p class="lp-eyebrow">Planos</p>
      <h2 id="lp-h-plans">Comece simples. Cres\xE7a quando quiser.</h2>
      <p class="lp-lead">Escolha o plano que serve o seu restaurante hoje e mude mais tarde, sem perder o card\xE1pio nem os QR Codes.</p>
    </header>
    <div class="lp-plan-grid">${d.plans.map((_, i) => planCard(d.plans, i)).join("")}</div>
    <p class="lp-note lp-note-dark lp-center">Os pre\xE7os s\xE3o definidos pela Altiora Grupo e podem mudar. O ALTIORA MENU n\xE3o cobra pagamentos aos clientes dos restaurantes.</p>
  </div>
</section>`;
}
function interactiveDemo(d) {
  const demo = d.demo;
  if (!demo)
    return "";
  return `<section class="lp-section lp-alt" id="demonstracao" aria-labelledby="lp-h-demo">
  <div class="lp-wrap lp-demo-grid">
    <div class="lp-demo-copy" data-reveal>
      <p class="lp-eyebrow lp-eyebrow-dark">Demonstra\xE7\xE3o interativa</p>
      <h2 id="lp-h-demo">Experimente agora, sem instalar nada</h2>
      <p>Este \xE9 um card\xE1pio a funcionar: use a pesquisa, filtre por categoria e abra um prato para ver os detalhes e, onde existir, o 3D.</p>
      <p><a class="lp-btn lp-btn-dark" href="/r/${esc(demo.slug)}">Abrir em ecr\xE3 inteiro ${icon("arrow")}</a></p>
    </div>
    <div class="lp-demo-device" data-reveal>
      <div class="lp-demo-frame"><a class="lp-demo-fallback" href="/r/${esc(demo.slug)}">Abrir a demonstra\xE7\xE3o</a><iframe title="Card\xE1pio de demonstra\xE7\xE3o interativo" src="/r/${esc(demo.slug)}?embed=1" loading="lazy" width="390" height="780" referrerpolicy="no-referrer"></iframe></div>
    </div>
  </div>
</section>`;
}
function faq() {
  return `<section class="lp-section" id="perguntas" aria-labelledby="lp-h-faq">
  <div class="lp-wrap lp-narrow">
    <header class="lp-sec-head lp-center" data-reveal><p class="lp-eyebrow lp-eyebrow-dark">Perguntas frequentes</p><h2 id="lp-h-faq">O que costumam perguntar-nos</h2></header>
    <div class="lp-faq" data-reveal>${FAQ.map((f) => `<details class="lp-faq-item"><summary>${esc(f.q)}</summary><div class="lp-faq-a"><p>${esc(f.a)}</p></div></details>`).join("")}</div>
  </div>
</section>`;
}
function contactList(c) {
  const items = [];
  if (c.email)
    items.push(`<li>${icon("mail")}<a href="mailto:${esc(c.email)}">${esc(c.email)}</a></li>`);
  if (c.phone)
    items.push(`<li>${icon("call")}<a href="tel:+${esc(digits(c.phone))}">${esc(c.phone)}</a></li>`);
  if (c.whatsapp) {
    const text = encodeURIComponent("Ol\xE1! Quero saber mais sobre o ALTIORA MENU.");
    items.push(`<li>${icon("chat")}<a href="https://wa.me/${esc(digits(c.whatsapp))}?text=${text}" rel="noopener">WhatsApp: +${esc(digits(c.whatsapp))}</a></li>`);
  }
  if (c.address)
    items.push(`<li>${icon("pin")}<span>${esc(c.address)}</span></li>`);
  return items.length ? `<ul class="lp-contact-list">${items.join("")}</ul>` : "";
}
function field(id, label, attrs, opts = {}) {
  const control = opts.area ? `<textarea id="f-${id}" name="${id}" rows="4" maxlength="1400" ${attrs}></textarea>` : `<input id="f-${id}" name="${id}" ${attrs} />`;
  return `<div class="lp-field"><label for="f-${id}">${label}${opts.optional ? ' <span class="lp-opt">(opcional)</span>' : ""}</label>${control}${opts.hint ? `<p class="lp-hint">${opts.hint}</p>` : ""}<p class="lp-err" id="e-${id}" role="alert"></p></div>`;
}
function contact(d) {
  const list = contactList(d.contacts);
  return `<section class="lp-section lp-dark" id="contacto" aria-labelledby="lp-h-contact">
  <div class="lp-wrap lp-contact-grid">
    <div class="lp-contact-copy" data-reveal>
      <p class="lp-eyebrow">Contacto comercial</p>
      <h2 id="lp-h-contact">Vamos p\xF4r o seu card\xE1pio no telem\xF3vel dos clientes</h2>
      <p class="lp-lead">Diga-nos como se chama o restaurante e como o podemos contactar. Respondemos com uma proposta, sem compromisso.</p>
      ${list}
    </div>
    <div data-reveal>
      <noscript><style>.lp-form{display:none}</style><p class="lp-note lp-note-dark">O formul\xE1rio precisa de JavaScript.${list ? " Use os contactos ao lado." : ""}</p></noscript>
      <form class="lp-form" id="lp-form" novalidate action="/api/leads" method="post" aria-label="Pedir demonstra\xE7\xE3o ou proposta">
        ${field("name", "O seu nome", 'type="text" autocomplete="name" required maxlength="120"')}
        ${field("business", "Restaurante", 'type="text" autocomplete="organization" maxlength="160"', { optional: true })}
        <div class="lp-row">
          ${field("phone", "Telefone ou WhatsApp", 'type="tel" inputmode="tel" autocomplete="tel" maxlength="40"')}
          ${field("email", "E-mail", 'type="email" autocomplete="email" maxlength="160"')}
        </div>
        <p class="lp-hint lp-hint-top">Indique pelo menos um dos dois para lhe respondermos.</p>
        <div class="lp-field"><label for="f-plan">Plano em que tem interesse <span class="lp-opt">(opcional)</span></label>
          <select id="f-plan" name="plan"><option value="">Ainda n\xE3o sei</option>${d.plans.map((p) => `<option value="${esc(p.code)}">${esc(p.name)}</option>`).join("")}</select></div>
        ${field("message", "Mensagem", 'maxlength="1400" placeholder="Quantas mesas tem? Quer pratos em 3D?"', { area: true, optional: true })}
        <div class="lp-hp" aria-hidden="true"><label>Website <input type="text" name="website" tabindex="-1" autocomplete="off" /></label></div>
        <div class="lp-field lp-consent"><label class="lp-check"><input type="checkbox" id="f-consent" name="consent" /><span>Aceito que a Altiora Grupo me contacte sobre o ALTIORA MENU. Veja o <a href="/privacidade">aviso de privacidade</a>.</span></label><p class="lp-err" id="e-consent" role="alert"></p></div>
        <p class="lp-form-error" id="lp-form-error" role="alert"></p>
        <button class="lp-btn lp-btn-gold lp-btn-block" type="submit">Enviar pedido</button>
      </form>
      <div class="lp-sent" id="lp-sent" role="status" tabindex="-1" hidden><span class="lp-sent-ic">${icon("check")}</span><h3>Recebemos o seu pedido</h3><p>Obrigado! Vamos contact\xE1-lo em breve.</p></div>
    </div>
  </div>
</section>`;
}
function footer2(d, home = "") {
  return `<footer class="lp-footer">
  <div class="lp-wrap lp-footer-row">
    <div><a class="lp-brand" href="/" aria-label="ALTIORA MENU \u2014 in\xEDcio">${MARK}<span class="lp-brand-name">ALTIORA <b>MENU</b></span></a><p class="lp-footer-sig">Digital Dining Experience</p></div>
    <nav aria-label="Rodap\xE9"><ul><li><a href="${home}#planos">Planos</a></li><li><a href="${home}#perguntas">Perguntas</a></li><li><a href="/privacidade">Privacidade</a></li><li><a href="/entrar">\xC1rea do restaurante</a></li></ul></nav>
  </div>
  <div class="lp-wrap lp-footer-legal"><p>\xA9 ${d.year} Altiora Grupo. Todos os direitos reservados.</p></div>
</footer>`;
}
function jsonLd(d) {
  const base = d.base_url;
  const org = { "@type": "Organization", "@id": `${base}/#org`, name: "Altiora Grupo", url: `${base}/` };
  const contactPoint = { "@type": "ContactPoint", contactType: "sales", availableLanguage: ["pt"] };
  if (d.contacts.email)
    contactPoint.email = d.contacts.email;
  if (d.contacts.phone)
    contactPoint.telephone = d.contacts.phone;
  if (d.contacts.email || d.contacts.phone)
    org.contactPoint = contactPoint;
  const offers = d.plans.filter((p) => p.price).map((p) => ({ "@type": "Offer", name: `Plano ${p.name}`, price: (p.price.monthly_cents / 100).toFixed(2), priceCurrency: p.price.currency }));
  const app = {
    "@type": "SoftwareApplication",
    name: "ALTIORA MENU",
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    description: DESCRIPTION,
    publisher: { "@id": `${base}/#org` }
  };
  if (offers.length)
    app.offers = offers;
  const graph = [
    org,
    { "@type": "WebSite", "@id": `${base}/#site`, url: `${base}/`, name: "ALTIORA MENU", inLanguage: "pt-AO", publisher: { "@id": `${base}/#org` } },
    app,
    { "@type": "FAQPage", mainEntity: FAQ.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })) }
  ];
  return JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(/</g, "\\u003c");
}
function document(opts) {
  const { d, a } = opts;
  const og = `${d.base_url}/landing/og.jpg`;
  return `<!doctype html>
<html lang="pt-AO">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${esc(opts.title)}</title>
<meta name="description" content="${esc(opts.description)}" />
<meta name="robots" content="${opts.index ? "index, follow, max-image-preview:large" : "noindex"}" />
<meta name="theme-color" content="#070708" />
<link rel="canonical" href="${esc(opts.canonical)}" />
<meta property="og:type" content="website" />
<meta property="og:locale" content="pt_AO" />
<meta property="og:site_name" content="ALTIORA MENU" />
<meta property="og:title" content="${esc(opts.title)}" />
<meta property="og:description" content="${esc(opts.description)}" />
<meta property="og:url" content="${esc(opts.canonical)}" />
<meta property="og:image" content="${esc(og)}" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta name="twitter:card" content="summary_large_image" />
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
${a.font ? `<link rel="preload" href="${esc(a.font)}" as="font" type="font/woff" crossorigin />` : ""}
<link rel="stylesheet" href="${esc(a.css)}" />
${opts.ld ? `<script type="application/ld+json">${opts.ld}</script>` : ""}
<script type="module" src="${esc(a.js)}"></script>
</head>
<body>
${opts.body}
</body>
</html>`;
}
function renderLanding(d, a) {
  const hasDemo = !!d.demo && d.demo.dishes.length > 0;
  const has3d = !!d.demo?.model_dish?.model_url;
  const body = `${header(hasDemo, has3d)}
<main id="conteudo">
${hero(d)}
${steps()}
${demoMenu(d)}
${demo3d(d)}
${benefits()}
${features()}
${plans(d)}
${interactiveDemo(d)}
${faq()}
${contact(d)}
</main>
${footer2(d)}`;
  return document({ title: TITLE, description: DESCRIPTION, canonical: `${d.base_url}/`, d, a, body, ld: jsonLd(d), index: true });
}
function renderPrivacy(d, a) {
  const mail = d.contacts.email;
  const how = mail ? `escreva-nos para <a href="mailto:${esc(mail)}">${esc(mail)}</a>` : 'use o <a href="/#contacto">formul\xE1rio de contacto</a>';
  const body = `${header(false, false).replace(/href="#/g, 'href="/#')}
<main id="conteudo" class="lp-legal">
  <div class="lp-wrap lp-narrow">
    <p class="lp-eyebrow lp-eyebrow-dark">Aviso de privacidade</p>
    <h1>Como tratamos os seus dados</h1>
    <p class="lp-lead-dark">O ALTIORA MENU \xE9 um servi\xE7o da Altiora Grupo. Este texto explica, em linguagem simples, que dados recolhemos, para qu\xEA e como pode pedir a corre\xE7\xE3o ou o apagamento.</p>

    <h2>Quando nos contacta pela p\xE1gina comercial</h2>
    <p>O formul\xE1rio pede o seu nome e, se quiser, o nome do restaurante, o telefone, o e-mail e uma mensagem. Usamos estes dados s\xF3 para responder ao seu pedido e acompanhar a conversa comercial. Ficam guardados no sistema do ALTIORA MENU e s\xF3 a equipa comercial da Altiora Grupo os v\xEA.</p>

    <h2>Quando navega nesta p\xE1gina</h2>
    <p>Esta p\xE1gina n\xE3o usa cookies de publicidade nem de medi\xE7\xE3o e n\xE3o carrega programas de terceiros. A demonstra\xE7\xE3o inclu\xEDda na p\xE1gina \xE9 um card\xE1pio de exemplo, com pratos fict\xEDcios.</p>

    <h2>Se \xE9 cliente de um restaurante que usa o ALTIORA MENU</h2>
    <p>N\xE3o precisa de criar conta. O carrinho e o hist\xF3rico dos seus pedidos ficam guardados no seu pr\xF3prio telem\xF3vel. Quando faz um pedido, o restaurante recebe o conte\xFAdo do pedido (pratos, mesa e as notas que escrever) e guarda-o para o servir e gerir o seu neg\xF3cio. N\xE3o escreva nas notas dados que n\xE3o quer partilhar. O restaurante \xE9 respons\xE1vel pelo tratamento dos pedidos que recebe.</p>

    <h2>Contas da equipa</h2>
    <p>Quem trabalha num restaurante ou na Altiora Grupo entra com e-mail e palavra-passe. Para isso usamos um cookie de sess\xE3o, indispens\xE1vel ao funcionamento, que \xE9 apagado quando termina a sess\xE3o (ou ao fim do prazo de validade). As palavras-passe nunca s\xE3o guardadas em texto leg\xEDvel.</p>

    <h2>Quem v\xEA o qu\xEA</h2>
    <p>Cada restaurante s\xF3 tem acesso aos seus dados. A equipa da Altiora Grupo v\xEA o estado e o plano de cada restaurante e n\xFAmeros gerais de utiliza\xE7\xE3o, mas n\xE3o v\xEA os pedidos, os menus nem os relat\xF3rios dos restaurantes.</p>

    <h2>Como corrigir ou apagar os seus dados</h2>
    <p>Para pedir a corre\xE7\xE3o ou o apagamento dos dados que nos enviou pelo formul\xE1rio, ${how}. Para dados de pedidos feitos num restaurante, fale com o pr\xF3prio restaurante.</p>

    <p class="lp-note"><a href="/">\u2190 Voltar \xE0 p\xE1gina inicial</a></p>
  </div>
</main>
${footer2(d, "/")}`;
  return document({ title: "Privacidade \u2014 ALTIORA MENU", description: "Como o ALTIORA MENU trata os dados de contacto, dos clientes dos restaurantes e das equipas.", canonical: `${d.base_url}/privacidade`, d, a, body, index: true });
}

// server/src/site/site.ts
var UUID_RE2 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
var SLUG_RE2 = /^[a-z0-9]+(-[a-z0-9]+)*$/;
var esc2 = (v) => v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
function html(body, extra = {}) {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8", ...extra } });
}
function createSite(deps) {
  const { config, db, limiter } = deps;
  const base = config.publicBaseUrl.replace(/\/$/, "");
  async function serveAsset(req, id, ip) {
    const rate = limiter.hit(`asset:${ip}`, 3000, 60000);
    if (!rate.ok)
      return new Response("Demasiados pedidos.", { status: 429, headers: { "retry-after": String(rate.retryAfterSec) } });
    if (!UUID_RE2.test(id))
      return new Response("N\xE3o encontrado", { status: 404 });
    const etag = await db.system((tx) => tx`SELECT sha256 FROM assets WHERE id = ${id}`);
    const tag = etag[0] ? `"${etag[0].sha256}"` : null;
    if (!tag)
      return new Response("N\xE3o encontrado", { status: 404, headers: { "cache-control": "no-store" } });
    const headers = {
      etag: tag,
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "x-robots-tag": "noindex"
    };
    if (req.headers.get("if-none-match") === tag)
      return new Response(null, { status: 304, headers });
    const rows = await db.system((tx) => tx`SELECT content_type, data FROM assets WHERE id = ${id}`);
    const row = rows[0];
    if (!row)
      return new Response("N\xE3o encontrado", { status: 404 });
    return new Response(row.data, { headers: { ...headers, "content-type": row.content_type, "content-length": String(row.data.byteLength) } });
  }
  let manifest = null;
  async function landingAssets() {
    if (manifest)
      return manifest;
    try {
      const m = JSON.parse(await readFile2(join2(config.webDir, "asset-manifest.json"), "utf8"));
      manifest = { css: m["landing.css"] ?? "/assets/landing.css", js: m["landing.js"] ?? "/assets/landing.js", font: m["font"] ?? null };
      return manifest;
    } catch {
      return { css: "/assets/landing.css", js: "/assets/landing.js", font: null };
    }
  }
  let shell = null;
  async function spaShell() {
    if (shell)
      return shell;
    try {
      shell = await readFile2(join2(config.webDir, "index.html"), "utf8");
      return shell;
    } catch {
      return null;
    }
  }
  async function landingData() {
    let degraded = false;
    const rows = await db.as({ role: "public" }, async (tx) => {
      const plans = await tx`SELECT code, name, tagline, highlighted, features FROM plans WHERE active ORDER BY display_order, code`;
      const prices = await tx`SELECT plan_code, currency, monthly_cents, yearly_cents FROM plan_prices ORDER BY (currency = 'AOA') DESC, currency`;
      return { plans, prices };
    }).catch(() => {
      degraded = true;
      return {
        plans: DEFAULT_PLANS.map((p) => ({ code: p.code, name: p.name, tagline: p.tagline, highlighted: p.highlighted, features: [...p.features] })),
        prices: []
      };
    });
    const plans = rows.plans.map((p) => {
      const price = rows.prices.find((x) => x.plan_code === p.code);
      return {
        code: p.code,
        name: p.name,
        tagline: p.tagline,
        highlighted: p.highlighted,
        features: FEATURE_KEYS.map((k) => ({ key: k, label: FEATURES[k].label, description: FEATURES[k].description, included: p.features.includes(k) })),
        price: price ? { currency: price.currency, monthly_cents: Number(price.monthly_cents), yearly_cents: price.yearly_cents === null ? null : Number(price.yearly_cents) } : null
      };
    });
    let demo = null;
    const menu = degraded ? null : await loadPublicMenuBySlug(deps, config.demoSlug).catch(() => null);
    if (menu) {
      const toDish = (c, i) => ({
        name: i.name,
        description: i.description ?? "",
        price_cents: i.price_cents,
        category: c,
        image_url: i.image_url,
        thumb_url: i.thumb_url,
        model_url: i.model_url,
        allergens: i.allergens.map(allergenLabel)
      });
      const shown = menu.categories.map((c) => ({ name: c.name, items: c.items.filter((i) => i.available) }));
      const all = shown.flatMap((c) => c.items.map((i) => toDish(c.name, i)));
      const perCategory = shown.flatMap((c) => c.items.slice(0, 3).map((i) => toDish(c.name, i)));
      demo = {
        slug: menu.restaurant.slug,
        name: menu.restaurant.name,
        description: menu.restaurant.description ?? "",
        currency: menu.restaurant.currency,
        logo_url: menu.restaurant.logo_url,
        cover_url: menu.restaurant.cover_url,
        dishes: perCategory.slice(0, 12),
        model_dish: all.find((d) => d.model_url && d.image_url) ?? null
      };
    }
    return { data: { base_url: base, plans, demo, contacts: config.commercial, year: new Date().getFullYear() }, degraded };
  }
  const cache = new Map;
  async function commercialPage(key) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < 60000)
      return html(hit.body, INDEXABLE);
    const { data, degraded } = await landingData();
    const assets = await landingAssets();
    const body = key === "landing" ? renderLanding(data, assets) : renderPrivacy(data, assets);
    if (degraded)
      return html(body, { ...INDEXABLE, "cache-control": "no-store" });
    cache.set(key, { at: Date.now(), body });
    return html(body, INDEXABLE);
  }
  const INDEXABLE = { "x-robots-tag": "index, follow, max-image-preview:large", "cache-control": "public, max-age=300, stale-while-revalidate=600" };
  async function restaurantShell(slug) {
    const index = await spaShell();
    if (!index || !SLUG_RE2.test(slug) || slug.length > 60)
      return null;
    const info = await db.as({ role: "public" }, async (tx) => {
      const [r] = await tx`SELECT restaurant_id, restaurant_status FROM resolve_restaurant_slug(${slug})`;
      if (!r || r.restaurant_status !== "ativo")
        return null;
      await tx.setContext({ restaurantId: r.restaurant_id });
      const [x] = await tx`
          SELECT name, description, logo_url, cover_url, is_demo FROM restaurants WHERE id = ${r.restaurant_id}`;
      return x ?? null;
    }).catch(() => null);
    if (!info)
      return null;
    const title = `${info.name} \u2014 Card\xE1pio digital`;
    const description = (info.description ?? `Veja o card\xE1pio de ${info.name}.`).slice(0, 200);
    const image = info.cover_url ?? info.logo_url;
    const imageUrl = image ? image.startsWith("/") ? `${base}${image}` : image : `${base}/landing/og.jpg`;
    const tags = [
      `<meta name="description" content="${esc2(description)}" />`,
      `<meta property="og:type" content="website" />`,
      `<meta property="og:site_name" content="ALTIORA MENU" />`,
      `<meta property="og:title" content="${esc2(title)}" />`,
      `<meta property="og:description" content="${esc2(description)}" />`,
      `<meta property="og:url" content="${esc2(`${base}/r/${slug}`)}" />`,
      `<meta property="og:image" content="${esc2(imageUrl)}" />`,
      `<meta name="twitter:card" content="summary_large_image" />`
    ].join(`
    `);
    let out = index.replace(/<title>[^<]*<\/title>/, `<title>${esc2(title)}</title>`).replace("</head>", `    ${tags}
  </head>`);
    if (info.is_demo)
      out = out.replace('<meta name="robots" content="noindex, nofollow" />', '<meta name="robots" content="index, follow" />');
    return html(out, { "cache-control": "no-cache", ...info.is_demo ? { "x-robots-tag": "index, follow" } : {} });
  }
  return async function site(req, url, ip) {
    if (req.method !== "GET" && req.method !== "HEAD")
      return null;
    const p = url.pathname;
    if (p.startsWith("/a/"))
      return serveAsset(req, p.slice(3), ip);
    if (p === "/")
      return commercialPage("landing");
    if (p === "/privacidade")
      return commercialPage("privacy");
    if (p === "/robots.txt") {
      const txt = ["User-agent: *", "Allow: /", "Disallow: /api/", "Disallow: /menu/", "Disallow: /pedido/", "", `Sitemap: ${base}/sitemap.xml`, ""].join(`
`);
      return new Response(txt, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600", "x-robots-tag": "all" } });
    }
    if (p === "/sitemap.xml") {
      const demo = await loadPublicMenuBySlug(deps, config.demoSlug).catch(() => null);
      const urls = [`${base}/`, `${base}/privacidade`, ...demo ? [`${base}/r/${demo.restaurant.slug}`] : []];
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${esc2(u)}</loc></url>`).join(`
`)}
</urlset>
`;
      return new Response(xml, { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600", "x-robots-tag": "all" } });
    }
    const m = /^\/r\/([^/]+)\/?$/.exec(p);
    if (m)
      return restaurantShell(m[1]);
    return null;
  };
}

// server/src/app.ts
var REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;
function errorResponse(err, requestId) {
  const body = { error: { code: err.code, message: err.message, ...err.details !== undefined ? { details: err.details } : {} }, request_id: requestId };
  return new Response(JSON.stringify(body), {
    status: err.status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...err.headers }
  });
}
function createApp(deps) {
  installZodPt();
  const { config, log, limiter } = deps;
  const router = new Router;
  router.addAll(allRoutes);
  const sidCookie = cookieName(config);
  const site = createSite(deps);
  const clearSessionCookie = () => serializeCookie(sidCookie, "", { maxAgeSec: 0, secure: config.cookieSecure });
  async function handleApi(req, url, ip, requestId, setRoute) {
    if (req.method === "OPTIONS")
      return preflightResponse(req, url, deps.origins);
    if (url.pathname.length > 512)
      throw new HttpError(414, "URI_TOO_LONG", "Endere\xE7o demasiado longo.");
    const match = router.match(req.method, url.pathname);
    if (match.kind === "none")
      throw new HttpError(404, "ROUTE_NOT_FOUND", "Endere\xE7o n\xE3o encontrado.");
    if (match.kind === "method")
      throw new HttpError(405, "METHOD_NOT_ALLOWED", "M\xE9todo n\xE3o permitido.", undefined, { allow: match.allow.join(", ") });
    const { route, params } = match;
    setRoute(`${route.method} ${route.path}`);
    const general = limiter.hit(`ip:${ip}`, 1500, 60000);
    if (!general.ok)
      throw tooMany("Demasiados pedidos. Aguarde um momento e tente novamente.", general.retryAfterSec);
    for (const rule of route.limits ?? []) {
      const r = limiter.hit(`${rule.name}:${ip}`, rule.max, rule.windowMs);
      if (!r.ok)
        throw tooMany("Demasiados pedidos. Aguarde um momento e tente novamente.", r.retryAfterSec);
    }
    let auth = null;
    if (route.access !== "public") {
      if (req.method !== "GET" && req.method !== "HEAD")
        assertSameOrigin(req, url, deps.origins);
      const token = parseCookies(req.headers.get("cookie"))[sidCookie];
      if (!token)
        throw unauthorized();
      auth = await loadAuth(deps.db, config, token);
      if (!auth) {
        throw new HttpError(401, "SESSION_EXPIRED", "A sua sess\xE3o terminou. Inicie sess\xE3o novamente.", undefined, { "set-cookie": clearSessionCookie() });
      }
      if (route.access === "platform") {
        if (auth.role !== "platform")
          throw forbidden();
      } else if (route.access !== "session") {
        if (auth.role === "platform" || !route.access.roles.includes(auth.role))
          throw forbidden();
      }
      if (auth.role !== "platform" && auth.restaurantStatus !== "ativo" && !route.allowSuspended) {
        throw new HttpError(403, "RESTAURANT_SUSPENDED", "A conta do restaurante est\xE1 suspensa. Contacte a Altiora Grupo.");
      }
      if (auth.mustChangePassword && !route.allowMustChange) {
        throw new HttpError(403, "PASSWORD_CHANGE_REQUIRED", "Tem de definir uma nova palavra-passe antes de continuar.");
      }
    }
    let bodyPromise = null;
    const ctx = {
      req,
      url,
      params,
      ip,
      requestId,
      deps,
      auth,
      bytes(maxBytes) {
        return readBytesBody(req, maxBytes);
      },
      async body(schema) {
        bodyPromise ??= readJsonBody(req);
        const parsed = schema.safeParse(await bodyPromise);
        if (!parsed.success)
          throw new HttpError(400, "VALIDATION_ERROR", "Dados inv\xE1lidos.", zodDetails(parsed.error));
        return parsed.data;
      },
      dbContext(extra = {}) {
        if (!auth)
          throw new Error("dbContext() s\xF3 pode ser usado em rotas autenticadas");
        return { role: auth.role, restaurantId: auth.restaurantId, userId: auth.userId, ...extra };
      }
    };
    return route.handler(ctx);
  }
  async function handle(req, info = {}) {
    const started = performance.now();
    const supplied = req.headers.get("x-request-id");
    const requestId = supplied && REQUEST_ID_RE.test(supplied) ? supplied : randomUUID2();
    const ip = clientIp(req, info.ip, config.trustProxyHops);
    let url;
    try {
      url = new URL(req.url);
    } catch {
      return new Response("Pedido inv\xE1lido", { status: 400 });
    }
    const isApi = url.pathname === "/api" || url.pathname.startsWith("/api/");
    let routeLabel = isApi ? "api (sem rota)" : "site";
    let res;
    try {
      if (isApi)
        res = await handleApi(req, url, ip, requestId, (l) => routeLabel = l);
      else
        res = await site(req, url, ip) ?? await serveStatic(req, url, config.webDir);
    } catch (err) {
      const { error, serverFault } = mapError(err);
      if (serverFault)
        log.error("erro ao tratar o pedido", { request_id: requestId, route: routeLabel, err });
      res = errorResponse(error, requestId);
    }
    try {
      applySecurityHeaders(res, { isProd: config.isProd, isApi });
      res.headers.set("x-request-id", requestId);
      if (!res.headers.has("x-robots-tag"))
        res.headers.set("x-robots-tag", "noindex, nofollow");
      if (isApi) {
        const cors = corsHeaders(req, url, deps.origins);
        if (cors)
          for (const [k, v] of Object.entries(cors))
            res.headers.set(k, v);
      }
    } catch {}
    const ms = Math.round(performance.now() - started);
    const fields = { request_id: requestId, method: req.method, route: routeLabel, status: res.status, ms, ip };
    if (routeLabel === "GET /api/health" || routeLabel === "site")
      log.debug("pedido", fields);
    else if (res.status >= 500)
      log.error("pedido", fields);
    else
      log.info("pedido", fields);
    if (req.method === "HEAD")
      return new Response(null, { status: res.status, headers: res.headers });
    return res;
  }
  return { fetch: handle, router };
}

// server/src/bootstrap.ts
async function bootstrapPlatformAdmin(db, config, log) {
  const b = config.bootstrapAdmin;
  if (!b)
    return "skipped";
  const exists = await db.system(async (tx) => (await tx`SELECT count(*)::int AS n FROM users WHERE is_platform_admin`)[0].n > 0);
  if (exists)
    return "already-exists";
  const weak = checkPasswordStrength(b.password, b.email);
  if (weak) {
    log.error("BOOTSTRAP_ADMIN_PASSWORD recusada: " + weak);
    return "weak-password";
  }
  const hash = await hashPassword(b.password, config.scryptLogN);
  return db.system(async (tx) => {
    const [taken] = await tx`SELECT 1 FROM users WHERE email = ${b.email}`;
    if (taken) {
      log.error("O e-mail de BOOTSTRAP_ADMIN_EMAIL j\xE1 pertence a uma conta que n\xE3o \xE9 de administra\xE7\xE3o da plataforma.");
      return "email-in-use";
    }
    const [u] = await tx`
      INSERT INTO users (email, name, password_hash, is_platform_admin, must_change_password)
      VALUES (${b.email}, ${b.name}, ${hash}, true, true) RETURNING id`;
    await audit(tx, { restaurantId: null, actorId: u.id, actorRole: "platform", action: "platform.admin_bootstrap", entityType: "user", entityId: u.id });
    log.info("conta de administra\xE7\xE3o da plataforma criada (tem de trocar a palavra-passe no primeiro acesso)");
    return "created";
  });
}

// server/src/config.ts
class ConfigError extends Error {
  problems;
  constructor(problems) {
    super(`Configura\xE7\xE3o inv\xE1lida:
 - ` + problems.join(`
 - `));
    this.problems = problems;
    this.name = "ConfigError";
  }
}
var bool = (def) => stringType().optional().transform((v) => v === undefined ? def : ["true", "1", "yes", "sim"].includes(v.trim().toLowerCase()));
var intRange = (min, max, def) => coerce.number().int().min(min).max(max).default(def);
var EnvSchema = objectType({
  NODE_ENV: enumType(["development", "test", "production"]).default("development"),
  PORT: intRange(1, 65535, 3000),
  HOST: stringType().default("0.0.0.0"),
  DATABASE_URL: stringType({ required_error: "DATABASE_URL \xE9 obrigat\xF3rio (endere\xE7o da base de dados PostgreSQL)." }).regex(/^postgres(ql)?:\/\//, "DATABASE_URL deve come\xE7ar por postgres:// ou postgresql://"),
  DATABASE_SSL: enumType(["auto", "require", "disable"]).default("auto"),
  DATABASE_POOL_MAX: intRange(1, 50, 10),
  DATABASE_PREPARE: bool(true),
  PUBLIC_BASE_URL: stringType().url().default("http://localhost:3000"),
  ALLOWED_ORIGINS: stringType().default(""),
  TRUST_PROXY_HOPS: intRange(0, 5, 1),
  AUTO_MIGRATE: bool(true),
  BOOTSTRAP_ADMIN_EMAIL: stringType().email().optional(),
  BOOTSTRAP_ADMIN_PASSWORD: stringType().min(10).max(128).optional(),
  BOOTSTRAP_ADMIN_NAME: stringType().max(120).default("Administrador Altiora"),
  SESSION_IDLE_HOURS: intRange(1, 168, 12),
  SESSION_MAX_DAYS: intRange(1, 90, 14),
  TABLE_SESSION_MINUTES: intRange(10, 1440, 240),
  COOKIE_SECURE: stringType().optional(),
  SCRYPT_LOG_N: intRange(10, 17, 15),
  RATE_LIMIT_ENABLED: bool(true),
  MAX_PENDING_ORDERS_PER_TABLE: intRange(1, 100, 8),
  MIN_SECONDS_BETWEEN_ORDERS: intRange(0, 60, 3),
  ASSET_QUOTA_MB: intRange(5, 5000, 80),
  DEMO_RESTAURANT_SLUG: stringType().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).default("demo"),
  SEED_SHOWCASE: bool(false),
  DEMO_MEDIA_DIR: stringType().default("./scripts/demo-media/assets"),
  COMMERCIAL_EMAIL: stringType().email().optional(),
  COMMERCIAL_PHONE: stringType().max(40).optional(),
  COMMERCIAL_WHATSAPP: stringType().max(40).optional(),
  COMMERCIAL_ADDRESS: stringType().max(200).optional(),
  WEB_DIR: stringType().default("./dist/web"),
  MIGRATIONS_DIR: stringType().default("./db/migrations"),
  LOG_LEVEL: enumType(["debug", "info", "warn", "error"]).default("info")
});
var ENV_KEYS = Object.keys(EnvSchema.shape);
function originOf(url) {
  return new URL(url).origin;
}
function isLocalOrPrivateHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || h.startsWith("127."))
    return true;
  if (!h.includes("."))
    return true;
  if (h.endsWith(".internal") || h.endsWith(".local") || h.endsWith(".lan"))
    return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168;
  }
  return false;
}
function databaseTransportWarning(databaseUrl, ssl) {
  if (ssl === "require")
    return null;
  let url;
  try {
    url = new URL(databaseUrl);
  } catch {
    return null;
  }
  if (isLocalOrPrivateHost(url.hostname))
    return null;
  const mode = (url.searchParams.get("sslmode") ?? "").toLowerCase();
  if (ssl === "auto" && ["require", "verify-ca", "verify-full"].includes(mode))
    return null;
  return `A liga\xE7\xE3o \xE0 base de dados (${url.hostname}) pode n\xE3o estar cifrada. Defina DATABASE_SSL=require nas vari\xE1veis de ambiente.`;
}
function loadConfig(env = process.env) {
  const cleaned = {};
  for (const [k, v] of Object.entries(env))
    if (v !== undefined && v.trim() !== "")
      cleaned[k] = v.trim();
  if (!cleaned.PUBLIC_BASE_URL && cleaned.RENDER_EXTERNAL_URL)
    cleaned.PUBLIC_BASE_URL = cleaned.RENDER_EXTERNAL_URL;
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join(".") || "configura\xE7\xE3o"}: ${i.message}`));
  }
  const e = parsed.data;
  const problems = [];
  const isProd = e.NODE_ENV === "production";
  const publicBaseUrl = originOf(e.PUBLIC_BASE_URL);
  if (isProd && !publicBaseUrl.startsWith("https://")) {
    problems.push("PUBLIC_BASE_URL deve come\xE7ar por https:// em produ\xE7\xE3o.");
  }
  const allowedOrigins = [];
  for (const raw of e.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)) {
    try {
      allowedOrigins.push(originOf(raw));
    } catch {
      problems.push(`ALLOWED_ORIGINS cont\xE9m um endere\xE7o inv\xE1lido: ${raw}`);
    }
  }
  const bootstrapIncomplete = Boolean(e.BOOTSTRAP_ADMIN_EMAIL) !== Boolean(e.BOOTSTRAP_ADMIN_PASSWORD);
  if (problems.length)
    throw new ConfigError(problems);
  const cookieSecure = e.COOKIE_SECURE === undefined ? isProd : ["true", "1", "yes", "sim"].includes(e.COOKIE_SECURE.trim().toLowerCase());
  return {
    env: e.NODE_ENV,
    isProd,
    port: e.PORT,
    host: e.HOST,
    databaseUrl: e.DATABASE_URL,
    databaseSsl: e.DATABASE_SSL,
    databasePoolMax: e.DATABASE_POOL_MAX,
    databasePrepare: e.DATABASE_PREPARE,
    publicBaseUrl,
    allowedOrigins,
    trustProxyHops: e.TRUST_PROXY_HOPS,
    autoMigrate: e.AUTO_MIGRATE,
    bootstrapAdmin: e.BOOTSTRAP_ADMIN_EMAIL && e.BOOTSTRAP_ADMIN_PASSWORD ? { email: e.BOOTSTRAP_ADMIN_EMAIL.toLowerCase(), password: e.BOOTSTRAP_ADMIN_PASSWORD, name: e.BOOTSTRAP_ADMIN_NAME } : null,
    bootstrapIncomplete,
    sessionIdleHours: e.SESSION_IDLE_HOURS,
    sessionMaxDays: e.SESSION_MAX_DAYS,
    tableSessionMinutes: e.TABLE_SESSION_MINUTES,
    assetQuotaBytes: e.ASSET_QUOTA_MB * 1024 * 1024,
    demoSlug: e.DEMO_RESTAURANT_SLUG,
    seedShowcase: e.SEED_SHOWCASE,
    demoMediaDir: e.DEMO_MEDIA_DIR,
    commercial: {
      email: e.COMMERCIAL_EMAIL ?? null,
      phone: e.COMMERCIAL_PHONE?.trim() || null,
      whatsapp: e.COMMERCIAL_WHATSAPP ? e.COMMERCIAL_WHATSAPP.replace(/\D/g, "") || null : null,
      address: e.COMMERCIAL_ADDRESS?.trim() || null
    },
    cookieSecure,
    scryptLogN: e.SCRYPT_LOG_N,
    rateLimitEnabled: e.RATE_LIMIT_ENABLED,
    webDir: e.WEB_DIR,
    migrationsDir: e.MIGRATIONS_DIR,
    logLevel: e.LOG_LEVEL,
    version: process.env.APP_VERSION ?? "0.1.0",
    limits: {
      maxPendingOrdersPerTable: e.MAX_PENDING_ORDERS_PER_TABLE,
      minSecondsBetweenOrders: e.MIN_SECONDS_BETWEEN_ORDERS,
      maxOrderLines: 40,
      maxOrderQuantity: 100,
      maxOrderTotalCents: 1000000000000
    }
  };
}

// server/src/db/migrate.ts
import { readdir, readFile as readFile3 } from "fs/promises";
import { join as join3 } from "path";
var LOCK_KEY = "altiora_pedidos_migrations";
async function runMigrations(sql, dir, log) {
  const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  if (files.length === 0)
    throw new Error(`Nenhuma migra\xE7\xE3o encontrada em ${dir}`);
  await sql.begin(async (tx) => {
    await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtext('${LOCK_KEY}'))`);
    await tx.unsafe("CREATE SCHEMA IF NOT EXISTS altiora");
    await tx.unsafe(`CREATE TABLE IF NOT EXISTS altiora.schema_migrations (
      name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    await tx.unsafe("ALTER TABLE altiora.schema_migrations ENABLE ROW LEVEL SECURITY");
  });
  const result = { applied: [], alreadyApplied: [] };
  for (const file of files) {
    const text = await readFile3(join3(dir, file), "utf8");
    const checksum = sha256Hex(text);
    await sql.begin(async (tx) => {
      await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtext('${LOCK_KEY}'))`);
      const rows = await tx.unsafe("SELECT checksum FROM altiora.schema_migrations WHERE name = $1", [file]);
      if (rows.length > 0) {
        if (rows[0].checksum !== checksum) {
          throw new Error(`A migra\xE7\xE3o ${file} foi alterada depois de aplicada. Crie uma migra\xE7\xE3o nova em vez de editar esta.`);
        }
        result.alreadyApplied.push(file);
        return;
      }
      await tx.unsafe(`SET LOCAL search_path TO altiora, pg_temp; ${text}`);
      await tx.unsafe("INSERT INTO altiora.schema_migrations (name, checksum) VALUES ($1, $2)", [file, checksum]);
      result.applied.push(file);
      log?.info("migra\xE7\xE3o aplicada", { migration: file });
    });
  }
  return result;
}

// server/src/demo/showcase.ts
import { createHash as createHash3 } from "crypto";
import { readFile as readFile4 } from "fs/promises";
import { join as join4 } from "path";
var kz = (value) => Math.round(value * 100);
var AURORA_HOURS = {
  mon: [["12:00", "15:00"], ["19:00", "23:00"]],
  tue: [["12:00", "15:00"], ["19:00", "23:00"]],
  wed: [["12:00", "15:00"], ["19:00", "23:00"]],
  thu: [["12:00", "15:00"], ["19:00", "23:00"]],
  fri: [["12:00", "15:00"], ["19:00", "23:59"]],
  sat: [["12:00", "23:59"]],
  sun: [["12:00", "17:00"]]
};
var AURORA_MENU = [
  {
    name: "Entradas",
    items: [
      {
        media: "pasteis",
        name: "Past\xE9is de bacalhau",
        description: "Past\xE9is dourados de bacalhau e batata, com lim\xE3o e salsa.",
        price: 4500,
        ingredients: ["Bacalhau", "Batata", "Cebola", "Ovos", "Salsa", "Farinha de trigo"],
        allergens: ["peixe", "ovos", "gluten"],
        sizes: [{ name: "3 unidades", price: 0 }, { name: "6 unidades", price: 4000 }],
        extras: [{ name: "Molho picante da casa", price: 500 }]
      },
      {
        media: "salada",
        name: "Salada de manga e abacate",
        description: "Folhas frescas, manga, abacate e cebola roxa, com vinagrete de lim\xE3o e s\xE9samo.",
        price: 3800,
        ingredients: ["Alface", "R\xFAcula", "Manga", "Abacate", "Cebola roxa", "S\xE9samo", "Lim\xE3o", "Azeite"],
        allergens: ["sesamo"],
        extras: [{ name: "Camar\xE3o grelhado", price: 2500 }]
      }
    ]
  },
  {
    name: "Pratos tradicionais",
    items: [
      {
        media: "muamba",
        name: "Muamba de galinha",
        description: "Galinha cozinhada em molho de \xF3leo de palma com quiabos e gindungo, servida com funge.",
        price: 6500,
        ingredients: ["Galinha", "\xD3leo de palma", "Quiabo", "Cebola", "Alho", "Gindungo", "Funge de mandioca"],
        allergens: [],
        sizes: [{ name: "Normal", price: 0 }, { name: "Grande", price: 1500 }],
        extras: [{ name: "Funge extra", price: 500 }, { name: "Gindungo \xE0 parte", price: 0 }]
      },
      {
        media: "mufete",
        name: "Mufete de cacusso",
        description: "Cacusso grelhado com feij\xE3o de \xF3leo de palma, banana-p\xE3o frita, mandioca cozida e cebola roxa.",
        price: 8500,
        ingredients: ["Cacusso", "Feij\xE3o", "\xD3leo de palma", "Banana-p\xE3o", "Mandioca", "Cebola roxa", "Lim\xE3o"],
        allergens: ["peixe"],
        extras: [{ name: "Banana-p\xE3o extra", price: 800 }]
      }
    ]
  },
  {
    name: "Grelhados e mar",
    items: [
      {
        media: "dourada",
        name: "Dourada grelhada",
        description: "Dourada inteira grelhada no carv\xE3o, com legumes salteados, batata cozida e lim\xE3o.",
        price: 11500,
        ingredients: ["Dourada", "Azeite", "Alho", "Lim\xE3o", "Batata", "Courgette", "Tomate-cereja", "Salsa"],
        allergens: ["peixe"],
        extras: [{ name: "Manteiga de alho", price: 600 }]
      },
      {
        media: "camarao",
        name: "Camar\xE3o tigre grelhado",
        description: "Camar\xE3o tigre grelhado com manteiga de alho e ervas finas.",
        price: 14500,
        ingredients: ["Camar\xE3o tigre", "Manteiga", "Alho", "Salsa", "Lim\xE3o"],
        allergens: ["crustaceos", "leite"],
        sizes: [{ name: "4 unidades", price: 0 }, { name: "6 unidades", price: 5000 }],
        extras: [{ name: "Arroz de manteiga", price: 1200 }]
      },
      {
        media: "costeleta",
        name: "Costeleta de vaca",
        description: "Costeleta de vaca grelhada, com batata frita, manteiga de ervas e molho da casa.",
        price: 13500,
        ingredients: ["Vaca", "Manteiga de ervas", "Batata", "Alecrim", "Sal grosso"],
        allergens: ["leite"],
        extras: [{ name: "Ovo estrelado", price: 500 }, { name: "Batata frita extra", price: 1200 }]
      }
    ]
  },
  {
    name: "Sobremesas",
    items: [
      { media: "pudim", name: "Pudim de leite", description: "Receita da casa, com calda de caramelo e hortel\xE3.", price: 3200, ingredients: ["Leite", "Ovos", "A\xE7\xFAcar", "Caramelo", "Hortel\xE3"], allergens: ["leite", "ovos"] },
      { media: "mousse", name: "Mousse de maracuj\xE1", description: "Mousse cremosa de maracuj\xE1, com sementes e hortel\xE3.", price: 3000, ingredients: ["Maracuj\xE1", "Natas", "Ovos", "A\xE7\xFAcar", "Hortel\xE3"], allergens: ["leite", "ovos"] },
      { media: "cocada", name: "Cocada amarela", description: "Doce tradicional de coco e gemas.", price: 2800, ingredients: ["Coco", "Gemas", "A\xE7\xFAcar"], allergens: ["ovos"] }
    ]
  },
  {
    name: "Bebidas",
    items: [
      {
        media: "sumo",
        name: "Sumo de manga natural",
        description: "Feito na hora com manga fresca.",
        price: 2200,
        ingredients: ["Manga", "\xC1gua", "A\xE7\xFAcar"],
        allergens: [],
        sizes: [{ name: "Copo", price: 0 }, { name: "Jarro", price: 3000 }],
        extras: [{ name: "Sem a\xE7\xFAcar", price: 0 }, { name: "Sem gelo", price: 0 }]
      },
      { media: "cafe", name: "Caf\xE9 expresso", description: "Caf\xE9 de torra m\xE9dia, servido bem quente.", price: 1000, ingredients: ["Caf\xE9"], allergens: [] }
    ]
  }
];
async function readAsset(dir, name) {
  const bytes = new Uint8Array(await readFile4(join4(dir, name)));
  const info = inspectAsset(bytes);
  return { bytes, info, sha256: createHash3("sha256").update(bytes).digest("hex") };
}
async function seedShowcase(db, config) {
  const slug = config.demoSlug;
  const dir = config.demoMediaDir;
  const existing = await db.system(async (tx) => (await tx`SELECT id FROM restaurants WHERE slug = ${slug}`)[0]);
  if (existing)
    return { created: false, slug };
  let manifest;
  try {
    manifest = JSON.parse(await readFile4(join4(dir, "manifest.json"), "utf8"));
  } catch {
    throw new Error(`N\xE3o encontrei as imagens e os modelos 3D de demonstra\xE7\xE3o em \xAB${dir}\xBB (DEMO_MEDIA_DIR).`);
  }
  const media = new Map;
  const wanted = ["logo.png", "cover.jpg"];
  for (const cat of AURORA_MENU) {
    for (const item of cat.items) {
      const m = manifest.dishes[item.media];
      if (!m)
        throw new Error(`Falta \xAB${item.media}\xBB em ${join4(dir, "manifest.json")}`);
      wanted.push(m.image, m.thumb);
      if (m.model)
        wanted.push(m.model);
    }
  }
  for (const name of wanted)
    media.set(name, await readAsset(dir, name));
  const description = "Cozinha de autor com sabores de Angola e do Atl\xE2ntico. Restaurante fict\xEDcio, criado para demonstrar o ALTIORA MENU.";
  const dishes = await db.system(async (tx) => {
    const [r] = await tx`
      INSERT INTO restaurants (name, slug, description, accent_color, address, email, timezone, opening_hours, theme, font, is_demo, service_fee_bps)
      VALUES ('Casa Aurora', ${slug}, ${description}, '#C9A24B', 'Rua das Ac\u00E1cias, 12, Talatona, Luanda (endere\u00E7o fict\u00EDcio)', 'reservas@casaaurora.example',
              'Africa/Luanda', ${AURORA_HOURS}::jsonb, 'dark', 'serif', true, 0)
      RETURNING id`;
    const rid = r.id;
    await tx`INSERT INTO subscriptions (restaurant_id, plan_code, notes) VALUES (${rid}, 'premium', 'Restaurante de demonstra\u00E7\u00E3o da p\u00E1gina comercial')`;
    const store = async (name) => {
      const a = media.get(name);
      const [row] = await tx`
        INSERT INTO assets (restaurant_id, kind, content_type, byte_size, sha256, width, height, data)
        VALUES (${rid}, ${a.info.kind}, ${a.info.contentType}, ${a.bytes.byteLength}, ${a.sha256}, ${a.info.width}, ${a.info.height}, ${a.bytes})
        RETURNING id`;
      return `/a/${row.id}`;
    };
    await tx`UPDATE restaurants SET logo_url = ${await store("logo.png")}, cover_url = ${await store("cover.jpg")} WHERE id = ${rid}`;
    let count = 0;
    let categoryOrder = 0;
    for (const cat of AURORA_MENU) {
      const [c] = await tx`INSERT INTO categories (restaurant_id, name, display_order) VALUES (${rid}, ${cat.name}, ${categoryOrder++}) RETURNING id`;
      let itemOrder = 0;
      for (const item of cat.items) {
        const m = manifest.dishes[item.media];
        const image = await store(m.image);
        const thumb = await store(m.thumb);
        const model = m.model ? await store(m.model) : null;
        const [it] = await tx`
          INSERT INTO menu_items (restaurant_id, category_id, name, description, image_url, thumb_url, model_url, ingredients, allergens, price_cents, available, display_order)
          VALUES (${rid}, ${c.id}, ${item.name}, ${item.description}, ${image}, ${thumb}, ${model}, ${item.ingredients}::text[], ${item.allergens}::text[], ${kz(item.price)}, true, ${itemOrder++})
          RETURNING id`;
        let optionOrder = 0;
        for (const [kind, list] of [["size", item.sizes ?? []], ["extra", item.extras ?? []]]) {
          for (const o of list) {
            await tx`
              INSERT INTO menu_item_options (restaurant_id, menu_item_id, name, price_delta_cents, kind, display_order)
              VALUES (${rid}, ${it.id}, ${o.name}, ${kz(o.price)}, ${kind}, ${optionOrder++})`;
          }
        }
        count++;
      }
    }
    await audit(tx, { restaurantId: rid, actorId: null, actorRole: "platform", action: "platform.seed_demo", entityType: "restaurant", entityId: rid, metadata: { restaurant: "Casa Aurora" } });
    return count;
  });
  const models = Object.values(manifest.dishes).filter((d) => d.model).length;
  return { created: true, slug, dishes, models };
}

// server/src/http/hub.ts
class Hub {
  restaurants = new Map;
  orders = new Map;
  connections = 0;
  add(map, key, fn) {
    let set = map.get(key);
    if (!set)
      map.set(key, set = new Set);
    set.add(fn);
    this.connections++;
    return () => {
      const s = map.get(key);
      if (s?.delete(fn))
        this.connections--;
      if (s && s.size === 0)
        map.delete(key);
    };
  }
  emit(map, key, event) {
    const set = map.get(key);
    if (!set)
      return;
    for (const fn of [...set]) {
      try {
        fn(event);
      } catch {}
    }
  }
  subscribeRestaurant(restaurantId, fn) {
    return this.add(this.restaurants, restaurantId, fn);
  }
  subscribeOrder(publicCode, fn) {
    return this.add(this.orders, publicCode, fn);
  }
  publishRestaurant(restaurantId, event) {
    this.emit(this.restaurants, restaurantId, event);
  }
  publishOrder(publicCode, event) {
    this.emit(this.orders, publicCode, event);
  }
  get connectionCount() {
    return this.connections;
  }
  slots = new Map;
  acquireSlot(key, max) {
    const n = this.slots.get(key) ?? 0;
    if (n >= max)
      return null;
    this.slots.set(key, n + 1);
    let released = false;
    return () => {
      if (released)
        return;
      released = true;
      const cur = (this.slots.get(key) ?? 1) - 1;
      if (cur <= 0)
        this.slots.delete(key);
      else
        this.slots.set(key, cur);
    };
  }
}

// server/src/http/rate-limit.ts
class RateLimiter {
  enabled;
  maxKeys;
  now;
  buckets = new Map;
  constructor(enabled = true, maxKeys = 1e5, now = () => Date.now()) {
    this.enabled = enabled;
    this.maxKeys = maxKeys;
    this.now = now;
  }
  hit(key, max, windowMs) {
    if (!this.enabled)
      return { ok: true, retryAfterSec: 0 };
    const now = this.now();
    const rate = max / windowMs;
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys)
        this.prune(now);
      b = { tokens: max, ts: now };
      this.buckets.set(key, b);
    } else {
      b.tokens = Math.min(max, b.tokens + (now - b.ts) * rate);
      b.ts = now;
    }
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true, retryAfterSec: 0 };
    }
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((1 - b.tokens) / rate / 1000)) };
  }
  prune(now = this.now()) {
    for (const [k, b] of this.buckets)
      if (now - b.ts > 10 * 60000)
        this.buckets.delete(k);
    if (this.buckets.size >= this.maxKeys) {
      let n = Math.ceil(this.maxKeys * 0.1);
      for (const k of this.buckets.keys()) {
        this.buckets.delete(k);
        if (--n <= 0)
          break;
      }
    }
  }
  get size() {
    return this.buckets.size;
  }
}

class LoginThrottle {
  enabled;
  now;
  windowMs;
  map = new Map;
  constructor(enabled = true, now = () => Date.now(), windowMs = 15 * 60000) {
    this.enabled = enabled;
    this.now = now;
    this.windowMs = windowMs;
  }
  check(key, maxFailures) {
    if (!this.enabled)
      return 0;
    const f = this.map.get(key);
    if (!f)
      return 0;
    const now = this.now();
    if (now - f.last > this.windowMs) {
      this.map.delete(key);
      return 0;
    }
    if (f.count >= maxFailures)
      return Math.max(1, Math.ceil((f.last + this.windowMs - now) / 1000));
    return 0;
  }
  fail(key) {
    if (!this.enabled)
      return;
    const now = this.now();
    const f = this.map.get(key);
    if (!f || now - f.last > this.windowMs)
      this.map.set(key, { count: 1, first: now, last: now });
    else {
      f.count += 1;
      f.last = now;
    }
    if (this.map.size > 50000) {
      for (const [k, v] of this.map)
        if (now - v.last > this.windowMs)
          this.map.delete(k);
    }
  }
  success(key) {
    this.map.delete(key);
  }
}

// server/src/deps.ts
function buildDeps(config, db, log) {
  return {
    config,
    db,
    hub: new Hub,
    limiter: new RateLimiter(config.rateLimitEnabled),
    loginThrottle: new LoginThrottle(config.rateLimitEnabled),
    log,
    origins: buildOriginPolicy(config.publicBaseUrl, config.allowedOrigins)
  };
}

// server/src/lib/log.ts
var WEIGHT = { debug: 10, info: 20, warn: 30, error: 40 };
var SENSITIVE_KEY = /pass|token|secret|cookie|authorization|public_code|qr_|database_url|session_id|(^|[_-])sid($|[_-])/i;
var URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^\s/]*@/gi;
var KEY_VALUE_SECRET = /\b(password|passwd|pwd|secret|token)=[^\s&;,]+/gi;
function scrub(text) {
  return text.replace(URL_CREDENTIALS, "$1***@").replace(KEY_VALUE_SECRET, "$1=***");
}
function sanitize(value, depth = 0) {
  if (value instanceof Error) {
    const e = value;
    return {
      name: e.name,
      message: scrub(String(e.message)).slice(0, 300),
      ...typeof e.errno === "string" ? { sqlstate: e.errno } : {},
      ...typeof e.constraint === "string" ? { constraint: e.constraint } : {}
    };
  }
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value && typeof value === "object") {
    if (depth >= 3)
      return "[\u2026]";
    if (Array.isArray(value))
      return value.slice(0, 20).map((v) => sanitize(v, depth + 1));
    const out = {};
    for (const [k, v] of Object.entries(value))
      out[k] = SENSITIVE_KEY.test(k) ? "[omitido]" : sanitize(v, depth + 1);
    return out;
  }
  if (typeof value === "string") {
    const clean = scrub(value);
    return clean.length > 500 ? clean.slice(0, 500) + "\u2026" : clean;
  }
  if (typeof value === "bigint")
    return value.toString();
  if (typeof value === "function" || typeof value === "symbol")
    return;
  return value;
}
function createLogger(level, write = (l) => process.stdout.write(l + `
`)) {
  const emit = (lvl, msg, fields) => {
    if (WEIGHT[lvl] < WEIGHT[level])
      return;
    try {
      write(JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg: scrub(msg), ...sanitize(fields ?? {}) }));
    } catch {}
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f)
  };
}

// server/src/main.ts
async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`
N\xE3o foi poss\xEDvel arrancar: a configura\xE7\xE3o tem problemas.
` + err.problems.map((p) => " - " + p).join(`
`) + `
`);
      process.exit(1);
    }
    throw err;
  }
  const log = createLogger(config.logLevel);
  if (config.bootstrapIncomplete) {
    log.warn("BOOTSTRAP_ADMIN_EMAIL e BOOTSTRAP_ADMIN_PASSWORD s\xF3 funcionam em conjunto: a conta de administra\xE7\xE3o inicial n\xE3o foi criada. (Se j\xE1 entrou pela primeira vez, pode apagar as duas vari\xE1veis.)");
  }
  const db = new Database(config.databaseUrl, { max: config.databasePoolMax, ssl: config.databaseSsl, prepare: config.databasePrepare });
  let reachable = false;
  for (let attempt = 1;attempt <= 5 && !reachable; attempt++) {
    reachable = await db.ping();
    if (!reachable) {
      log.warn("base de dados ainda n\xE3o responde", { attempt, motivo: db.lastPingError });
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  if (!reachable) {
    log.error("N\xE3o foi poss\xEDvel ligar \xE0 base de dados. Verifique DATABASE_URL (e DATABASE_SSL).", { motivo: db.lastPingError });
    process.exit(1);
  }
  if (config.isProd) {
    const warning = databaseTransportWarning(config.databaseUrl, config.databaseSsl);
    if (warning)
      log.warn(warning);
    if (!process.env.PUBLIC_BASE_URL?.trim() && process.env.RENDER_EXTERNAL_URL) {
      log.info("PUBLIC_BASE_URL n\xE3o est\xE1 definido: a usar o endere\xE7o do Render. Se ligar um dom\xEDnio pr\xF3prio, defina PUBLIC_BASE_URL antes de imprimir os QR Codes.", { endereco: config.publicBaseUrl });
    }
  }
  if (config.autoMigrate) {
    try {
      const result = await runMigrations(db.sql, config.migrationsDir, log);
      log.info("migra\xE7\xF5es verificadas", { novas: result.applied.length, ja_aplicadas: result.alreadyApplied.length });
    } catch (err) {
      log.error("Falha nas migra\xE7\xF5es da base de dados", { err });
      process.exit(1);
    }
  }
  const check = await db.selfTest();
  if (!check.ok) {
    for (const p of check.problems)
      log.error("verifica\xE7\xE3o de seguran\xE7a: " + p);
    if (config.isProd) {
      log.error("O servidor n\xE3o arranca em produ\xE7\xE3o com estas falhas de seguran\xE7a.");
      process.exit(1);
    }
  } else {
    log.info("verifica\xE7\xE3o de seguran\xE7a da base de dados conclu\xEDda");
  }
  try {
    await bootstrapPlatformAdmin(db, config, log);
  } catch (err) {
    log.error("N\xE3o foi poss\xEDvel criar a conta de administra\xE7\xE3o inicial", { err });
  }
  if (config.seedShowcase) {
    try {
      const result = await seedShowcase(db, config);
      if (result.created)
        log.info("restaurante de demonstra\xE7\xE3o criado (Casa Aurora)", { endereco: `/r/${result.slug}`, pratos: result.dishes, com_3d: result.models });
      else
        log.info("restaurante de demonstra\xE7\xE3o j\xE1 existe: nada a fazer", { endereco: `/r/${result.slug}` });
    } catch (err) {
      log.warn("n\xE3o foi poss\xEDvel criar o restaurante de demonstra\xE7\xE3o", { err });
    }
  }
  const deps = buildDeps(config, db, log);
  const app = createApp(deps);
  const server = Bun.serve({
    port: config.port,
    hostname: config.host,
    idleTimeout: 60,
    maxRequestBodySize: 1024 * 1024,
    fetch: (req, srv) => app.fetch(req, { ip: srv.requestIP(req)?.address }),
    error: (err) => {
      log.error("erro n\xE3o tratado no servidor HTTP", { err });
      return new Response(JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "Ocorreu um erro inesperado. Tente novamente." } }), {
        status: 500,
        headers: { "content-type": "application/json; charset=utf-8" }
      });
    }
  });
  log.info("servidor a ouvir", { port: server.port, host: server.hostname, versao: config.version, ambiente: config.env });
  const timers = [
    setInterval(() => void purgeExpiredSessions(db).catch((err) => log.warn("limpeza de sess\xF5es falhou", { err })), 60 * 60000),
    setInterval(() => deps.limiter.prune(), 5 * 60000)
  ];
  for (const t of timers)
    t.unref?.();
  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping)
      return;
    stopping = true;
    log.info("a encerrar", { signal });
    const force = setTimeout(() => process.exit(1), 1e4);
    force.unref?.();
    try {
      await server.stop();
      await db.close();
    } catch (err) {
      log.warn("erro ao encerrar", { err });
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (err) => log.error("promessa rejeitada sem tratamento", { err }));
}
main();
