import {
  EmitContext,
  emitFile,
  listServices,
  getNamespaceFullName,
  navigateTypesInNamespace,
  Model,
  Namespace,
  Interface,
  Program,
  Type,
  Scalar,
  Diagnostic,
} from "@typespec/compiler";
import {
  checkReservedKeyword,
  formatReservedError,
} from "@specodec/typespec-specodec-core";

export type EmitterOptions = {
  "emitter-output-dir": string;
  "ignore-reserved-keywords"?: boolean;
};

interface FieldInfo {
  name: string;
  type: Type;
  optional: boolean;
}

interface ServiceInfo {
  namespace: Namespace;
  iface?: Interface;
  serviceName: string;
  models: Model[];
}

function extractFields(model: Model): FieldInfo[] {
  const fields: FieldInfo[] = [];
  for (const [name, prop] of model.properties) {
    fields.push({ name, type: prop.type, optional: prop.optional ?? false });
  }
  return fields;
}

function scalarName(type: Type): string {
  if (type.kind === "Scalar") return (type as Scalar).name;
  return "";
}

function typeToTs(type: Type): string {
  const n = scalarName(type);
  if (n === "string") return "string";
  if (n === "boolean") return "boolean";
  if (n === "int64" || n === "uint64") return "bigint";
  if (["int8","int16","int32","uint8","uint16","uint32","integer","float32","float64","float","decimal"].includes(n)) return "number";
  if (n === "bytes") return "Uint8Array";
  if (type.kind === "Intrinsic" && (type as any).name === "string") return "string";
  if (type.kind === "Intrinsic" && (type as any).name === "boolean") return "boolean";
  if (type.kind === "Model" && (type as Model).indexer) {
    const indexer = (type as Model).indexer!;
    const keyName = (indexer.key as any).name;
    if (keyName === "integer") {
      return `${typeToTs(indexer.value)}[]`;
    } else if (keyName === "string") {
      return `Record<string, ${typeToTs(indexer.value)}>`;
    }
  }
  if (type.kind === "Model") return type.name || "unknown";
  return "unknown";
}

// Write a value of given type to `w` (SpecWriter — format-agnostic).
function writeExpr(type: Type, varExpr: string): string {
  const n = scalarName(type);
  if (n === "string") return `w.writeString(${varExpr})`;
  if (n === "boolean") return `w.writeBool(${varExpr})`;
  if (n === "int32" || n === "int8" || n === "int16" || n === "integer") return `w.writeInt32(${varExpr})`;
  if (n === "int64") return `w.writeInt64(${varExpr})`;
  if (n === "uint32" || n === "uint8" || n === "uint16") return `w.writeUint32(${varExpr})`;
  if (n === "uint64") return `w.writeUint64(${varExpr})`;
  if (n === "float32") return `w.writeFloat32(${varExpr})`;
  if (n === "float64" || n === "float" || n === "decimal") return `w.writeFloat64(${varExpr})`;
  if (n === "bytes") return `w.writeBytes(${varExpr})`;
  if (type.kind === "Model" && (type as Model).indexer) {
    const indexer = (type as Model).indexer!;
    const keyName = (indexer.key as any).name;
    if (keyName === "integer") {
      const elem = indexer.value;
      return `(() => { w.beginArray(${varExpr}.length); for (const _e of ${varExpr}) { w.nextElement(); ${writeExpr(elem, "_e")}; } w.endArray(); })()`;
    } else if (keyName === "string") {
      const elem = indexer.value;
      return `(() => { w.beginObject(Object.keys(${varExpr}).length); for (const [_k, _v] of Object.entries(${varExpr})) { w.writeField(_k); ${writeExpr(elem, "_v")}; } w.endObject(); })()`;
    }
  }
  if (type.kind === "Model" && type.name) return `_write${type.name}(w, ${varExpr})`;
  return `w.writeString(String(${varExpr}))`;
}

function readExpr(type: Type, optional?: boolean): string {
  const n = scalarName(type);
  if (n === "string") return `r.readString()`;
  if (n === "boolean") return `r.readBool()`;
  if (n === "int32" || n === "int8" || n === "int16" || n === "integer") return `r.readInt32()`;
  if (n === "int64") return `r.readInt64()`;
  if (n === "uint32" || n === "uint8" || n === "uint16") return `r.readUint32()`;
  if (n === "uint64") return `r.readUint64()`;
  if (n === "float32") return `r.readFloat32()`;
  if (n === "float64" || n === "float" || n === "decimal") return `r.readFloat64()`;
  if (n === "bytes") return `r.readBytes()`;
  if (type.kind === "Model" && (type as Model).indexer) {
    const indexer = (type as Model).indexer!;
    const keyName = (indexer.key as any).name;
    if (keyName === "integer") {
      const elem = indexer.value;
      const elemTs = typeToTs(elem);
      return `(() => { const _a: ${elemTs}[] = []; r.beginArray(); while (r.hasNextElement()) { _a.push(${readExpr(elem)}); } r.endArray(); return _a; })()`;
    } else if (keyName === "string") {
      const elem = indexer.value;
      const elemTs = typeToTs(elem);
      return `(() => { const _m: Record<string, ${elemTs}> = {}; r.beginObject(); while (r.hasNextField()) { const _k = r.readFieldName(); _m[_k] = ${readExpr(elem)}; } r.endObject(); return _m; })()`;
    }
  }
  if (type.kind === "Model" && type.name) {
    if (optional) {
      return `(r.isNull() ? r.readNull() : _decode${type.name}(r)) ?? undefined`;
    }
    return `_decode${type.name}(r)`;
  }
  return `r.readString()`;
}

function emitModelFunctions(m: Model, L: string[]): void {
  if (!m.name) return;
  const fields = extractFields(m);
  const required = fields.filter(f => !f.optional);
  const optional = fields.filter(f => f.optional);

  // _write${Name}(w, obj) — single format-agnostic write function
  L.push(`function _write${m.name}(w: SpecWriter, obj: ${m.name}): void {`);
  if (optional.length === 0) {
    L.push(`  w.beginObject(${fields.length});`);
  } else {
    L.push(`  let _n = ${required.length};`);
    for (const f of optional) {
      L.push(`  if (obj.${f.name} !== undefined) _n++;`);
    }
    L.push(`  w.beginObject(_n);`);
  }
  for (const f of fields) {
    if (f.optional) {
      L.push(`  if (obj.${f.name} !== undefined) { w.writeField("${f.name}"); ${writeExpr(f.type, `obj.${f.name}`)}; }`);
    } else {
      L.push(`  w.writeField("${f.name}"); ${writeExpr(f.type, `obj.${f.name}`)};`);
    }
  }
  L.push(`  w.endObject();`);
  L.push(`}`);
  L.push("");

  // _decode${Name}(r)
  L.push(`function _decode${m.name}(r: SpecReader): ${m.name} {`);
  L.push(`  const obj: Partial<${m.name}> = {};`);
  L.push(`  r.beginObject();`);
  L.push(`  while (r.hasNextField()) {`);
  L.push(`    switch (r.readFieldName()) {`);
  for (const f of fields) {
    L.push(`      case "${f.name}": obj.${f.name} = ${readExpr(f.type, f.optional)}; break;`);
  }
  L.push(`      default: r.skip();`);
  L.push(`    }`);
  L.push(`  }`);
  L.push(`  r.endObject();`);
  L.push(`  return obj as ${m.name};`);
  L.push(`}`);
  L.push("");
}

function collectServices(program: Program): ServiceInfo[] {
  const services = listServices(program);
  const result: ServiceInfo[] = [];
  
  function isStdLibNamespace(ns: Namespace): boolean {
    const fullName = getNamespaceFullName(ns);
    return fullName === "TypeSpec" || fullName.startsWith("TypeSpec.");
  }
  
  function collectFromNs(ns: Namespace, iface?: Interface) {
    if (isStdLibNamespace(ns)) return;
    
    const models: Model[] = [];
    const seen = new Set<string>();
    navigateTypesInNamespace(ns, {
      model: (m: Model) => {
        if (m.name && !seen.has(m.name)) {
          const modelNs = m.namespace;
          if (modelNs && !isStdLibNamespace(modelNs)) {
            models.push(m);
            seen.add(m.name);
          }
        }
      },
    });
    if (models.length > 0) {
      result.push({ 
        namespace: ns, 
        iface: iface || { name: ns.name || "TestService", namespace: ns } as Interface, 
        serviceName: iface?.name || ns.name || "TestService", 
        models 
      });
    }
  }
  for (const svc of services) collectFromNs(svc.type);
  if (result.length === 0) {
    const globalNs = program.getGlobalNamespaceType();
    for (const [, ns] of globalNs.namespaces) collectFromNs(ns);
    collectFromNs(globalNs);
  }
  return result;
}

export async function $onEmit(context: EmitContext<EmitterOptions>) {
  const program = context.program;
  const outputDir = context.emitterOutputDir;
  const ignoreReservedKeywords = context.options["ignore-reserved-keywords"] ?? false;
  const services = collectServices(program);

  const reservedFieldErrors: Diagnostic[] = [];
  for (const svc of services) {
    for (const m of svc.models) {
      if (!m.name) continue;
      for (const [fieldName, prop] of m.properties) {
        const reservedIn = checkReservedKeyword(fieldName);
        if (reservedIn.length > 0) {
          const message = formatReservedError(fieldName, m.name, reservedIn);
          const diag: Diagnostic = {
            severity: "error",
            code: "reserved-keyword",
            message,
            target: prop,
          };
          reservedFieldErrors.push(diag);
        }
      }
    }
  }

  if (reservedFieldErrors.length > 0 && !ignoreReservedKeywords) {
    program.reportDiagnostics(reservedFieldErrors);
    return;
  }

  if (reservedFieldErrors.length > 0 && ignoreReservedKeywords) {
    for (const diag of reservedFieldErrors) {
      console.warn(`Warning: ${diag.message}`);
    }
  }

  for (const svc of services) {
    const L: string[] = [];
    L.push("// Generated by @specodec/typespec-specodec-ts. DO NOT EDIT.");
    L.push(`import type { SpecReader, SpecWriter, SpecCodec } from "@specodec/specodec-ts";`);
    L.push("");

    // 1. Interfaces (types only)
    for (const m of svc.models) {
      if (!m.name) continue;
      const fields = extractFields(m);
      L.push(`export interface ${m.name} {`);
      for (const f of fields) {
        L.push(`  ${f.name}${f.optional ? "?" : ""}: ${typeToTs(f.type)};`);
      }
      L.push("}");
      L.push("");
    }

    // 2. Internal write/decode helpers
    for (const m of svc.models) {
      emitModelFunctions(m, L);
    }

    // 3. Exported SpecCodec objects
    for (const m of svc.models) {
      if (!m.name) continue;
      L.push(`export const ${m.name}Codec: SpecCodec<${m.name}> = {`);
      L.push(`  encode(w: SpecWriter, obj: ${m.name}): void { _write${m.name}(w, obj); },`);
      L.push(`  decode(r: SpecReader): ${m.name} { return _decode${m.name}(r); },`);
      L.push(`};`);
      L.push("");
    }

    const snake = (s: string) => s.replace(/([A-Z])/g, (m, c, i) => (i ? "-" : "") + c.toLowerCase());
    const fileName = snake(svc.serviceName);
    await emitFile(program, { path: `${outputDir}/${fileName}.types.ts`, content: L.join("\n") });
    
    // Also output models.json manifest for test generator
    const allModels: any = {};
    const SUB_MODELS = ['Inner', 'Coord', 'IdVal', 'Label', 'Money', 'Range32', 'Addr', 'Point3'];
    
    for (const m of svc.models) {
      if (!m.name) continue;
      const fields = extractFields(m);
      const fieldDefs = fields.map(f => {
        const scalar = scalarName(f.type);
        let t = scalar;
        let isArray = false;
        let isRecord = false;
        let isModel = false;
        
        if (!t && f.type.kind === 'Model') {
          const mt = f.type as Model;
          if (mt.indexer) {
            const keyName = (mt.indexer.key as any).name;
            if (keyName === 'integer') {
              isArray = true;
              const elem = mt.indexer.value;
              t = scalarName(elem) || (elem.kind === 'Model' && elem.name ? elem.name : 'unknown');
              isModel = elem.kind === 'Model' && !!elem.name;
            } else if (keyName === 'string') {
              isRecord = true;
              const elem = mt.indexer.value;
              t = scalarName(elem) || (elem.kind === 'Model' && elem.name ? elem.name : 'unknown');
              isModel = elem.kind === 'Model' && !!elem.name;
            }
          } else if (mt.name) {
            t = mt.name;
            isModel = true;
          }
        }
        
        return {
          name: f.name,
          type: t || 'unknown',
          optional: f.optional,
          isArray,
          isRecord,
          isModel
        };
      });
      allModels[m.name] = { name: m.name, fields: fieldDefs };
    }
    
    const manifest = {
      models: allModels,
      testModels: svc.models.filter(m => m.name && !SUB_MODELS.includes(m.name)).map(m => m.name)
    };
    
    await emitFile(program, { path: `${outputDir}/models.json`, content: JSON.stringify(manifest, null, 2) });
  }
}
