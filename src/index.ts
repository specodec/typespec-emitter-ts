import {
  EmitContext,
  emitFile,
  Model,
  Diagnostic,
} from "@typespec/compiler";
import {
  collectServices,
  ServiceInfo,
  BaseEmitterOptions,
  FieldInfo,
  extractFields,
  scalarName,
  isArrayType,
  isRecordType,
  arrayElementType,
  recordElementType,
  toSnakeCase,
  checkAndReportReservedKeywords,
} from "@specodec/typespec-emitter-core";

export type EmitterOptions = BaseEmitterOptions;

function typeToTs(type: any): string {
  const n = scalarName(type);
  if (n === "string") return "string";
  if (n === "boolean") return "boolean";
  if (n === "int64" || n === "uint64") return "bigint";
  if (["int8","int16","int32","uint8","uint16","uint32","integer","float32","float64","float","decimal"].includes(n)) return "number";
  if (n === "bytes") return "Uint8Array";
  if (isArrayType(type)) return `${typeToTs(arrayElementType(type))}[]`;
  if (isRecordType(type)) return `Record<string, ${typeToTs(recordElementType(type))}>`;
  if (type.kind === "Model" && type.name) return type.name;
  return "unknown";
}

function writeExpr(type: any, varExpr: string): string {
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
  if (isArrayType(type)) {
    const elem = arrayElementType(type);
    return `(() => { w.beginArray(${varExpr}.length); for (const _e of ${varExpr}) { w.nextElement(); ${writeExpr(elem, "_e")}; } w.endArray(); })()`;
  }
  if (isRecordType(type)) {
    const elem = recordElementType(type);
    return `(() => { w.beginObject(Object.keys(${varExpr}).length); for (const [_k, _v] of Object.entries(${varExpr})) { w.writeField(_k); ${writeExpr(elem, "_v")}; } w.endObject(); })()`;
  }
  if (type.kind === "Model" && type.name) return `_write${type.name}(w, ${varExpr})`;
  return `w.writeString(String(${varExpr}))`;
}

function readExpr(type: any, optional?: boolean): string {
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
  if (isArrayType(type)) {
    const elem = arrayElementType(type);
    const elemTs = typeToTs(elem);
    return `(() => { const _a: ${elemTs}[] = []; r.beginArray(); while (r.hasNextElement()) { _a.push(${readExpr(elem)}); } r.endArray(); return _a; })()`;
  }
  if (isRecordType(type)) {
    const elem = recordElementType(type);
    const elemTs = typeToTs(elem);
    return `(() => { const _m: Record<string, ${elemTs}> = {}; r.beginObject(); while (r.hasNextField()) { const _k = r.readFieldName(); _m[_k] = ${readExpr(elem)}; } r.endObject(); return _m; })()`;
  }
  if (type.kind === "Model" && type.name) {
    if (optional) return `(r.isNull() ? r.readNull() : _decode${type.name}(r)) ?? undefined`;
    return `_decode${type.name}(r)`;
  }
  return `r.readString()`;
}

function emitModelFunctions(m: Model, L: string[]): void {
  if (!m.name) return;
  const fields = extractFields(m);
  const required = fields.filter(f => !f.optional);
  const optional = fields.filter(f => f.optional);

  L.push(`function _write${m.name}(w: SpecWriter, obj: ${m.name}): void {`);
  if (optional.length === 0) {
    L.push(`  w.beginObject(${fields.length});`);
  } else {
    L.push(`  let _n = ${required.length};`);
    for (const f of optional) L.push(`  if (obj.${f.name} !== undefined) _n++;`);
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

export async function $onEmit(context: EmitContext<EmitterOptions>) {
  const program = context.program;
  const outputDir = context.emitterOutputDir;
  const ignoreReservedKeywords = context.options["ignore-reserved-keywords"] ?? false;
  const services = collectServices(program);

  if (checkAndReportReservedKeywords(program, services, ignoreReservedKeywords)) return;

  for (const svc of services) {
    const L: string[] = [];
    L.push("// Generated by @specodec/typespec-emitter-typescript. DO NOT EDIT.");
    L.push(`import type { SpecReader, SpecWriter, SpecCodec } from "@specodec/specodec-runtime-typescript";`);
    L.push("");

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

    for (const m of svc.models) emitModelFunctions(m, L);

    for (const m of svc.models) {
      if (!m.name) continue;
      L.push(`export const ${m.name}Codec: SpecCodec<${m.name}> = {`);
      L.push(`  encode(w: SpecWriter, obj: ${m.name}): void { _write${m.name}(w, obj); },`);
      L.push(`  decode(r: SpecReader): ${m.name} { return _decode${m.name}(r); },`);
      L.push(`};`);
      L.push("");
    }

    const fileName = `${toSnakeCase(svc.serviceName)}_types.ts`;
    await emitFile(program, { path: `${outputDir}/${fileName}`, content: L.join("\n") });
  }
}
