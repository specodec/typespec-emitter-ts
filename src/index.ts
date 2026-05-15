import { type EmitContext, emitFile, type Model, type Enum } from "@typespec/compiler";
import {
  collectServices,
  type BaseEmitterOptions,
  type FieldInfo,
  extractFields,
  scalarName,
  isArrayType,
  isRecordType,
  isModelType,
  isUnionType,
  isScalarVariant,
  arrayElementType,
  recordElementType,
  toCamelCase,
  dottedPathToSnakeCase,
  checkAndReportReservedKeywords,
  safeFieldName,
  type EnumInfo,
  type EnumMemberInfo,
  type UnionInfo,
  type UnionVariantInfo,
} from "@specodec/typespec-emitter-core";

export type EmitterOptions = BaseEmitterOptions;

const pascalVariant = (v: UnionVariantInfo) => v.name.charAt(0).toUpperCase() + v.name.slice(1);

function typeToTs(type: any): string {
  const n = scalarName(type);
  if (n === "string") return "string";
  if (n === "boolean") return "boolean";
  if (n === "int64" || n === "uint64") return "bigint";
  if (
    [
      "int8",
      "int16",
      "int32",
      "uint8",
      "uint16",
      "uint32",
      "integer",
      "float32",
      "float64",
      "float",
      "decimal",
    ].includes(n)
  )
    return "number";
  if (n === "bytes") return "Uint8Array";
  if (type.kind === "Enum") return "string";
  if (isArrayType(type)) return `${typeToTs(arrayElementType(type)!)}[]`;
  if (isRecordType(type)) return `Record<string, ${typeToTs(recordElementType(type)!)}>`;
  if (type.kind === "Model" && type.name) return type.name;
  if (type.kind === "Union" && type.name) return type.name;
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
    const elem = arrayElementType(type)!;
    return `(() => { w.beginArray(${varExpr}.length); for (const item of ${varExpr}) { w.nextElement(); ${writeExpr(elem, "item")}; } w.endArray(); })()`;
  }
  if (isRecordType(type)) {
    const elem = recordElementType(type)!;
    return `(() => { w.beginObject(Object.keys(${varExpr}).length); for (const [key, val] of Object.entries(${varExpr})) { w.writeField(key); ${writeExpr(elem, "val")}; } w.endObject(); })()`;
  }
  if (type.kind === "Model" && type.name) return `write${type.name}(w, ${varExpr})`;
  if (type.kind === "Enum") return `w.writeString(${varExpr})`;
  if (type.kind === "Union" && type.name) return `write${type.name}(w, ${varExpr})`;
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
    const elem = arrayElementType(type)!;
    const elemTs = typeToTs(elem);
    return `(() => { const arr: ${elemTs}[] = []; r.beginArray(); while (r.hasNextElement()) { arr.push(${readExpr(elem)}); } r.endArray(); return arr; })()`;
  }
  if (isRecordType(type)) {
    const elem = recordElementType(type)!;
    const elemTs = typeToTs(elem);
    return `(() => { const record: Record<string, ${elemTs}> = {}; r.beginObject(); while (r.hasNextField()) { const key = r.readFieldName(); record[key] = ${readExpr(elem)}; } r.endObject(); return record; })()`;
  }
  if (type.kind === "Model" && type.name) {
    if (optional) return `(r.isNull() ? r.readNull() : decode${type.name}(r)) ?? undefined`;
    return `decode${type.name}(r)`;
  }
  if (type.kind === "Enum") return `r.readString()`;
  if (type.kind === "Union" && type.name) {
    if (optional) return `(r.isNull() ? r.readNull() : decode${type.name}(r)) ?? undefined`;
    return `decode${type.name}(r)`;
  }
  return `r.readString()`;
}

function emitModelFunctions(m: Model, L: string[]): void {
  if (!m.name) return;
  const fields = extractFields(m);
  const required = fields.filter((f) => !f.optional);
  const optional = fields.filter((f) => f.optional);
  const tsField = (f: FieldInfo) => safeFieldName("typescript", toCamelCase(f.name));

  L.push(`export function write${m.name}(w: SpecWriter, obj: ${m.name}): void {`);
  if (optional.length === 0) {
    L.push(`  w.beginObject(${fields.length});`);
  } else {
    L.push(`  let fieldCount = ${required.length};`);
    for (const f of optional) L.push(`  if (obj.${tsField(f)} !== undefined) fieldCount++;`);
    L.push(`  w.beginObject(fieldCount);`);
  }
  for (const f of fields) {
    if (f.optional) {
      L.push(
        `  if (obj.${tsField(f)} !== undefined) { w.writeField("${f.name}"); ${writeExpr(f.type, `obj.${tsField(f)}`)}; }`,
      );
    } else {
      L.push(`  w.writeField("${f.name}"); ${writeExpr(f.type, `obj.${tsField(f)}`)};`);
    }
  }
  L.push(`  w.endObject();`);
  L.push(`}`);
  L.push("");

  L.push(`export function decode${m.name}(r: SpecReader): ${m.name} {`);
  const hasUnionField = fields.some((f) => !f.optional && isUnionType(f.type));
  if (hasUnionField) {
    for (const f of fields) {
      const fn = tsField(f);
      if (f.optional) {
        L.push(`  let ${fn}: ${typeToTs(f.type)} | undefined;`);
      } else if (isUnionType(f.type)) {
        const undefCls = `${(f.type as any).name}Undefined`;
        L.push(`  let ${fn}: ${typeToTs(f.type)} = new ${undefCls}(SpecUndefined.instance);`);
      } else {
        L.push(`  let ${fn}: ${typeToTs(f.type)} = ${defaultForType(f.type)};`);
      }
    }
  } else {
    L.push(`  const obj: Partial<${m.name}> = {};`);
  }
  L.push(`  r.beginObject();`);
  L.push(`  while (r.hasNextField()) {`);
  L.push(`    switch (r.readFieldName()) {`);
  for (const f of fields) {
    if (hasUnionField) {
      L.push(`      case "${f.name}": ${tsField(f)} = ${readExpr(f.type, f.optional)}; break;`);
    } else {
      L.push(`      case "${f.name}": obj.${tsField(f)} = ${readExpr(f.type, f.optional)}; break;`);
    }
  }
  L.push(`      default: r.skip();`);
  L.push(`    }`);
  L.push(`  }`);
  L.push(`  r.endObject();`);
  if (hasUnionField) {
    const args = fields.map((f) => `${tsField(f)}: ${tsField(f)}`).join(", ");
    L.push(`  return { ${args} };`);
  } else {
    L.push(`  return obj as ${m.name};`);
  }
  L.push(`}`);
  L.push("");
}

function defaultForType(type: any): string {
  const n = scalarName(type);
  if (n === "string") return `""`;
  if (n === "boolean") return `false`;
  if (["int8","int16","int32","uint8","uint16","uint32","integer","float32","float64","float","decimal"].includes(n)) return `0`;
  if (n === "int64" || n === "uint64") return `BigInt(0)`;
  if (n === "bytes") return `new Uint8Array(0)`;
  if (type.kind === "Enum") return `""`;
  if (isArrayType(type)) return `[]`;
  if (isRecordType(type)) return `{}`;
  if (isModelType(type)) return `null as any`;
  return `null as any`;
}

function emitEnum(e: EnumInfo, L: string[]): void {
  L.push(`export enum ${e.name} {`);
  for (const m of e.members) {
    L.push(`  ${m.name} = ${m.value},`);
  }
  L.push("}");
  L.push("");
}

function emitUnionType(u: UnionInfo, L: string[]): void {
  L.push(`export abstract class ${u.name} {}`);
  L.push(``);
  for (const v of u.variants) {
    const cls = `${u.name}${pascalVariant(v)}`;
    const tsType = typeToTs(v.type);
    L.push(`export class ${cls} extends ${u.name} { constructor(public readonly value: ${tsType}) { super(); } }`);
    L.push(``);
  }
  const undefCls = `${u.name}Undefined`;
  L.push(`export class ${undefCls} extends ${u.name} { constructor(public readonly value: SpecUndefined) { super(); } }`);
  L.push(``);
}

function emitUnionFunctions(u: UnionInfo, L: string[]): void {
  L.push(`export function write${u.name}(w: SpecWriter, obj: ${u.name}): void {`);
  L.push(`  w.beginObject(1);`);
  for (const v of u.variants) {
    const cls = `${u.name}${pascalVariant(v)}`;
    L.push(`  if (obj instanceof ${cls}) { w.writeField("${v.name}"); ${writeExpr(v.type, `obj.value`)}; }`);
  }
  L.push(`  w.endObject();`);
  L.push(`}`);
  L.push("");

  L.push(`export function decode${u.name}(r: SpecReader): ${u.name} {`);
  L.push(`  r.beginObject();`);
  L.push(`  if (!r.hasNextField()) { r.endObject(); throw new Error("empty union ${u.name}"); }`);
  L.push(`  const _field = r.readFieldName();`);
  L.push(`  let _result: ${u.name};`);
  L.push(`  switch (_field) {`);
  for (const v of u.variants) {
    const cls = `${u.name}${pascalVariant(v)}`;
    L.push(`    case "${v.name}": _result = new ${cls}(${readExpr(v.type)}); break;`);
  }
  L.push(`    default: throw new Error("unknown variant " + _field + " for union ${u.name}");`);
  L.push(`  }`);
  L.push(`  while (r.hasNextField()) { r.readFieldName(); r.skip(); }`);
  L.push(`  r.endObject();`);
  L.push(`  return _result;`);
  L.push(`}`);
  L.push("");
}

export async function $onEmit(context: EmitContext<EmitterOptions>) {
  const program = context.program;
  const outputDir = context.emitterOutputDir;
  const ignoreReservedKeywords = context.options["ignore-reserved-keywords"] ?? false;
  const services = collectServices(program);

  if (checkAndReportReservedKeywords(program, services, ignoreReservedKeywords)) return;

  const tsModelNs = new Map<string, string>();
  for (const s of services) {
    for (const m of s.models) { if (m.name) tsModelNs.set(m.name, s.serviceName); }
    for (const e of s.enums) { if (e.name) tsModelNs.set(e.name, s.serviceName); }
    for (const u of s.unions) { if (u.name) tsModelNs.set(u.name, s.serviceName); }
  }

  for (const svc of services) {
    const L: string[] = [];
    L.push("// Generated by @specodec/typespec-emitter-typescript. DO NOT EDIT.");
    L.push(`import { SpecUndefined, type SpecReader, type SpecWriter, type SpecCodec } from "@specodec/specodec-runtime-typescript";`);

  const xrefNs = new Set<string>();
  const xrefFuncs = new Map<string, Set<string>>();
  for (const m of svc.models) {
    if (!m.name) continue;
    for (const f of extractFields(m)) {
      const collectX = (t: any) => {
        if ((t.kind === "Model" || t.kind === "Enum") && t.name) {
          const ns = tsModelNs.get(t.name);
          if (ns && ns !== svc.serviceName) {
            const nsSnake = dottedPathToSnakeCase(ns);
            xrefNs.add(nsSnake);
            if (!xrefFuncs.has(nsSnake)) xrefFuncs.set(nsSnake, new Set());
            if (t.kind === "Model") {
              xrefFuncs.get(nsSnake)!.add("write" + t.name);
              xrefFuncs.get(nsSnake)!.add("decode" + t.name);
            }
          }
        }
        if (t.kind === "Union" && t.name) {
          const ns = tsModelNs.get(t.name);
          if (ns && ns !== svc.serviceName) {
            const nsSnake = dottedPathToSnakeCase(ns);
            xrefNs.add(nsSnake);
            if (!xrefFuncs.has(nsSnake)) xrefFuncs.set(nsSnake, new Set());
            xrefFuncs.get(nsSnake)!.add("write" + t.name);
            xrefFuncs.get(nsSnake)!.add("decode" + t.name);
          }
        }
        if (isArrayType(t)) collectX(arrayElementType(t)!);
        if (isRecordType(t)) collectX(recordElementType(t)!);
      };
      collectX(f.type);
    }
  }
  for (const u of svc.unions) {
    for (const v of u.variants) {
      const collectX = (t: any) => {
        if ((t.kind === "Model" || t.kind === "Enum") && t.name) {
          const ns = tsModelNs.get(t.name);
          if (ns && ns !== svc.serviceName) {
            const nsSnake = dottedPathToSnakeCase(ns);
            xrefNs.add(nsSnake);
            if (!xrefFuncs.has(nsSnake)) xrefFuncs.set(nsSnake, new Set());
            if (t.kind === "Model") {
              xrefFuncs.get(nsSnake)!.add("write" + t.name);
              xrefFuncs.get(nsSnake)!.add("decode" + t.name);
            }
          }
        }
        if (t.kind === "Union" && t.name) {
          const ns = tsModelNs.get(t.name);
          if (ns && ns !== svc.serviceName) {
            const nsSnake = dottedPathToSnakeCase(ns);
            xrefNs.add(nsSnake);
            if (!xrefFuncs.has(nsSnake)) xrefFuncs.set(nsSnake, new Set());
            xrefFuncs.get(nsSnake)!.add("write" + t.name);
            xrefFuncs.get(nsSnake)!.add("decode" + t.name);
          }
        }
        if (isArrayType(t)) collectX(arrayElementType(t)!);
        if (isRecordType(t)) collectX(recordElementType(t)!);
      };
      collectX(v.type);
    }
  }
  for (const ns of [...xrefNs].sort()) {
    const funcs = [...(xrefFuncs.get(ns) || new Set<string>())].sort().join(", ");
    L.push(`import { ${funcs} } from './${ns}_types.js';`);
  }
  if (xrefNs.size > 0) L.push("");

    for (const e of svc.enums) emitEnum(e, L);

    for (const m of svc.models) {
      if (!m.name) continue;
      const fields = extractFields(m);
      L.push(`export interface ${m.name} {`);
      for (const f of fields) {
        L.push(`  ${safeFieldName("typescript", toCamelCase(f.name))}${f.optional ? "?" : ""}: ${typeToTs(f.type)};`);
      }
      L.push("}");
      L.push("");
    }

    for (const u of svc.unions) emitUnionType(u, L);

    for (const m of svc.models) emitModelFunctions(m, L);

    for (const u of svc.unions) emitUnionFunctions(u, L);

    for (const m of svc.models) {
      if (!m.name) continue;
      L.push(`export const ${m.name}Codec: SpecCodec<${m.name}> = {`);
      L.push(`  encode(w: SpecWriter, obj: ${m.name}): void { write${m.name}(w, obj); },`);
      L.push(`  decode(r: SpecReader): ${m.name} { return decode${m.name}(r); },`);
      L.push(`};`);
      L.push("");
    }

    for (const u of svc.unions) {
      L.push(`export const ${u.name}Codec: SpecCodec<${u.name}> = {`);
      L.push(`  encode(w: SpecWriter, obj: ${u.name}): void { write${u.name}(w, obj); },`);
      L.push(`  decode(r: SpecReader): ${u.name} { return decode${u.name}(r); },`),
      L.push(`};`);
      L.push("");
    }

    const fileName = `${dottedPathToSnakeCase(svc.serviceName)}_types.ts`;
    await emitFile(program, { path: `${outputDir}/${fileName}`, content: L.join("\n") });
  }

  let barrelContent = "// Generated by @specodec/typespec-emitter-typescript. DO NOT EDIT.\n";
  for (const svc of services) {
    barrelContent += `export * from './${dottedPathToSnakeCase(svc.serviceName)}_types.js';\n`;
  }
  await emitFile(program, { path: `${outputDir}/index.ts`, content: barrelContent });
}
