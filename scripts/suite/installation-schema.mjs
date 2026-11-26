#!/usr/bin/env node
// Validates installation files against examples/installation.schema.json without dependencies.
// It supports exactly the JSON Schema keywords the published schemas use and refuses any other
// keyword, so a schema change cannot silently go unchecked.
//   node scripts/suite/installation-schema.mjs FILE...
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const annotations = new Set(['$schema', '$id', 'title', 'description', 'default', '$defs', 'format']);
const documents = new Map();

function load(file) {
  if (!documents.has(file)) documents.set(file, JSON.parse(readFileSync(file, 'utf8')));
  return documents.get(file);
}

function resolveRef(ref, file) {
  const [target, fragment = ''] = ref.split('#');
  const next = target ? join(dirname(file), target) : file;
  let schema = load(next);
  for (const part of fragment.split('/').filter(Boolean)) schema = schema[decodeURIComponent(part)];
  if (schema === undefined) throw new Error(`Unresolved $ref ${ref}`);
  return { schema, file: next };
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function check(value, schema, file, path, errors) {
  if (schema === true) return;
  if (schema === false) { errors.push(`${path}: not allowed`); return; }
  for (const keyword of Object.keys(schema)) {
    if (annotations.has(keyword)) continue;
    const rule = schema[keyword];
    const kind = typeOf(value);
    switch (keyword) {
      case '$ref': { const next = resolveRef(rule, file); check(value, next.schema, next.file, path, errors); break; }
      case 'type': {
        const allowed = Array.isArray(rule) ? rule : [rule];
        if (!allowed.some((type) => type === kind || (type === 'number' && kind === 'integer'))) errors.push(`${path}: expected ${allowed.join('|')}`);
        break;
      }
      case 'const': if (JSON.stringify(value) !== JSON.stringify(rule)) errors.push(`${path}: must be ${JSON.stringify(rule)}`); break;
      case 'enum': if (!rule.some((item) => JSON.stringify(item) === JSON.stringify(value))) errors.push(`${path}: must be one of ${JSON.stringify(rule)}`); break;
      case 'pattern': if (kind === 'string' && !new RegExp(rule, 'u').test(value)) errors.push(`${path}: does not match ${rule}`); break;
      case 'minLength': if (kind === 'string' && [...value].length < rule) errors.push(`${path}: shorter than ${rule}`); break;
      case 'maxLength': if (kind === 'string' && [...value].length > rule) errors.push(`${path}: longer than ${rule}`); break;
      case 'minimum': if (typeof value === 'number' && value < rule) errors.push(`${path}: below ${rule}`); break;
      case 'maximum': if (typeof value === 'number' && value > rule) errors.push(`${path}: above ${rule}`); break;
      case 'minItems': if (kind === 'array' && value.length < rule) errors.push(`${path}: fewer than ${rule} items`); break;
      case 'maxItems': if (kind === 'array' && value.length > rule) errors.push(`${path}: more than ${rule} items`); break;
      case 'items': if (kind === 'array') value.forEach((item, index) => check(item, rule, file, `${path}[${index}]`, errors)); break;
      case 'minProperties': if (kind === 'object' && Object.keys(value).length < rule) errors.push(`${path}: fewer than ${rule} properties`); break;
      case 'required': if (kind === 'object') for (const name of rule) if (!(name in value)) errors.push(`${path}: missing ${name}`); break;
      case 'properties': if (kind === 'object') for (const [name, sub] of Object.entries(rule)) if (name in value) check(value[name], sub, file, `${path}.${name}`, errors); break;
      case 'additionalProperties':
        if (kind === 'object') for (const name of Object.keys(value)) if (!(schema.properties && name in schema.properties)) {
          if (rule === false) errors.push(`${path}: unknown property ${name}`); else check(value[name], rule, file, `${path}.${name}`, errors);
        }
        break;
      case 'propertyNames': if (kind === 'object') for (const name of Object.keys(value)) check(name, rule, file, `${path} key ${name}`, errors); break;
      case 'allOf': for (const sub of rule) check(value, sub, file, path, errors); break;
      case 'not': { const inner = []; check(value, rule, file, path, inner); if (!inner.length) errors.push(`${path}: matches a forbidden shape`); break; }
      case 'if': {
        const inner = []; check(value, rule, file, path, inner);
        if (!inner.length && schema.then !== undefined) check(value, schema.then, file, path, errors);
        if (inner.length && schema.else !== undefined) check(value, schema.else, file, path, errors);
        break;
      }
      case 'then': case 'else': break;
      default: throw new Error(`Unsupported JSON Schema keyword ${keyword} in ${file}`);
    }
  }
}

export function validateInstallation(value, schemaFile = join(root, 'examples/installation.schema.json')) {
  const errors = [];
  check(value, load(schemaFile), schemaFile, '$', errors);
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let failed = false;
  for (const file of process.argv.slice(2)) {
    const errors = validateInstallation(JSON.parse(readFileSync(file, 'utf8')));
    for (const error of errors) console.error(`${file}: ${error}`);
    failed ||= errors.length > 0;
  }
  process.exit(failed ? 1 : 0);
}
