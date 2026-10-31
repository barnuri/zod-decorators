import { z } from 'zod/v3';

type DtoShape = Record<string, z.ZodTypeAny>;

/** A rule across several fields; `path` names the field the error is reported on. */
export interface ZodObjectRefinement {
    readonly check: (value: Record<string, unknown>) => boolean;
    readonly message: string;
    readonly path?: readonly string[];
}

export interface ZodObjectOptions {
    readonly unknownKeys?: 'passthrough' | 'strict' | 'strip';
    /** OpenAPI description for the generated object schema. */
    readonly description?: string;
    /** Cross-field rules, applied in order after every field parses. */
    readonly refine?: readonly ZodObjectRefinement[];
}

export interface ZodFieldOptions {
    /** OpenAPI description for the generated property schema. */
    readonly description?: string;
}

/** A class carrying a zod 3 schema, such as a @ZodObject class from this module. */
export interface SchemaCarryingClass {
    readonly schema: z.ZodTypeAny;
}

/**
 * What @ZodField accepts: a zod 3 schema, a DTO class, or a one-element array of
 * either, which becomes an array field.
 */
export type ZodFieldSource = z.ZodTypeAny | SchemaCarryingClass | readonly [z.ZodTypeAny | SchemaCarryingClass];

type ZodDtoConstructor<TDto> = (new () => TDto) & { readonly schema: z.ZodTypeAny };

type OptionalKeys<TDto> = { [TKey in keyof TDto]-?: {} extends Pick<TDto, TKey> ? TKey : never }[keyof TDto];

type FieldValue<TDto, TKey extends keyof TDto> = Exclude<TDto[TKey], undefined>;

type FieldSchema<TValue> = z.ZodType<TValue, z.ZodTypeDef, TValue>;

/**
 * The object shape `typedSchema` gives a DTO's schema: one field schema per class
 * property, optional where the property is, and defaulted (omittable on input) for
 * the `TDefaultedKeys`.
 */
export type TypedDtoShape<TDto, TDefaultedKeys extends keyof TDto = never> = {
    -readonly [TKey in keyof TDto]-?: TKey extends TDefaultedKeys
        ? z.ZodDefault<FieldSchema<FieldValue<TDto, TKey>>>
        : TKey extends OptionalKeys<TDto>
          ? z.ZodOptional<FieldSchema<FieldValue<TDto, TKey>>>
          : FieldSchema<TDto[TKey]>;
};

type FieldMetadata = Map<string | symbol, z.ZodTypeAny>;
type ObjectDecorator = (value: Function, context: ClassDecoratorContext) => void;
type ObjectMetadata = DecoratorMetadataObject & {
    [dtoFields]?: FieldMetadata;
};

interface RefinedObjectDef extends z.ZodObjectDef<DtoShape> {
    readonly rules: readonly ZodObjectRefinement[];
}

function refinementsUnsupported(method: string): never {
    throw new Error(`.${method}() cannot be used on object schemas containing refinements`);
}

// WHY: zod 3's refine returns a ZodEffects, which has no shape and is no longer an
// object. Running the rules in _parse keeps the published schema a ZodObject, and
// the overrides below keep zod 3's object methods from building a plain ZodObject
// that drops them, matching zod 4 (rules kept, or the method throws).
class RefinedZodObject extends z.ZodObject<DtoShape> {
    declare _def: RefinedObjectDef;

    override _parse(input: z.ParseInput): z.ParseReturnType<this['_output']> {
        const result = super._parse(input);
        return z.isAsync(result) ? result.then(parsed => this.checked(input, parsed)) : this.checked(input, result);
    }

    override extend<TAugmentation extends z.ZodRawShape>(augmentation: TAugmentation) {
        if (Object.keys(augmentation).some(key => Object.hasOwn(this.shape, key))) {
            throw new Error('Cannot overwrite keys on object schemas containing refinements');
        }
        return this.refined(super.extend(augmentation));
    }

    override strict(message?: Parameters<z.ZodObject<DtoShape>['strict']>[0]) {
        return this.refined(super.strict(message));
    }

    override strip() {
        return this.refined(super.strip());
    }

    override passthrough() {
        return this.refined(super.passthrough());
    }

    override catchall<TIndex extends z.ZodTypeAny>(index: TIndex) {
        return this.refined(super.catchall(index));
    }

    override required(mask?: Record<string, true>) {
        return this.refined(super.required(mask as never));
    }

    override merge(): never {
        return refinementsUnsupported('merge');
    }

    override pick(): never {
        return refinementsUnsupported('pick');
    }

    override omit(): never {
        return refinementsUnsupported('omit');
    }

    override partial(): never {
        return refinementsUnsupported('partial');
    }

    override deepPartial(): never {
        return refinementsUnsupported('deepPartial');
    }

    private refined<TSchema extends z.ZodTypeAny>(schema: TSchema): TSchema {
        return new RefinedZodObject({ ...schema._def, rules: this._def.rules }) as unknown as TSchema;
    }

    // WHY: zod 4 skips refinements once the object has any issue; zod 3's ZodEffects
    // would still run them on a "dirty" result such as a strict unknown-key failure.
    private checked(
        input: z.ParseInput,
        result: z.SyncParseReturnType<this['_output']>,
    ): z.SyncParseReturnType<this['_output']> {
        if (result.status !== 'valid') {
            return result;
        }
        const ctx = this._getOrReturnCtx(input);
        const failed = this._def.rules.filter(rule => !rule.check(result.value));
        for (const rule of failed) {
            z.addIssueToContext(ctx, {
                code: z.ZodIssueCode.custom,
                message: rule.message,
                path: rule.path === undefined ? undefined : [...rule.path],
            });
        }
        return failed.length === 0 ? result : z.DIRTY(result.value);
    }
}

const dtoFields = Symbol('zod-decorators.v3.fields');
const schemas = new WeakMap<Function, z.ZodObject<DtoShape>>();

function metadataOf(context: Pick<ClassDecoratorContext | ClassFieldDecoratorContext, 'metadata'>): ObjectMetadata {
    if (context.metadata === undefined) {
        throw new TypeError('This runtime does not support Stage-3 decorator metadata');
    }
    return context.metadata as ObjectMetadata;
}

function fieldsOf(metadata: ObjectMetadata): FieldMetadata {
    if (Object.hasOwn(metadata, dtoFields)) {
        return metadata[dtoFields] as FieldMetadata;
    }
    // WHY: Stage-3 metadata inherits from the base class's; copying keeps sibling
    // subclasses from appending fields to each other.
    const fields = new Map<string | symbol, z.ZodTypeAny>(metadata[dtoFields]);
    metadata[dtoFields] = fields;
    return fields;
}

function isSchemaCarryingClass(source: ZodFieldSource): source is SchemaCarryingClass {
    return typeof source === 'function' && 'schema' in source;
}

function fieldSchema(source: ZodFieldSource): z.ZodTypeAny {
    if (Array.isArray(source)) {
        return z.array(fieldSchema(source[0] as ZodFieldSource));
    }
    if (isSchemaCarryingClass(source)) {
        return source.schema;
    }
    return source as z.ZodTypeAny;
}

function describedSchema<TSchema extends z.ZodTypeAny>(schema: TSchema, description: string | undefined): TSchema {
    return description === undefined ? schema : schema.describe(description);
}

function objectSchema(metadata: ObjectMetadata, options: ZodObjectOptions): z.ZodObject<DtoShape> {
    const shape: DtoShape = {};
    for (const [name, schema] of fieldsOf(metadata)) {
        if (typeof name !== 'string') {
            throw new TypeError('Zod DTO fields must use string property names');
        }
        shape[name] = schema;
    }
    const object = z.object(shape);
    if (options.unknownKeys === 'passthrough') {
        return object.passthrough();
    }
    if (options.unknownKeys === 'strict') {
        return object.strict();
    }
    return object;
}

function refinedSchema(object: z.ZodObject<DtoShape>, rules: readonly ZodObjectRefinement[]): z.ZodObject<DtoShape> {
    if (rules.length === 0) {
        return object;
    }
    return new RefinedZodObject({ ...object._def, rules } as RefinedObjectDef);
}

/**
 * Declares a property schema for a Stage-3-decorated zod 3 DTO class. The source
 * is a zod 3 schema, another decorated DTO class, or a one-element array of
 * either for a list field.
 */
export function ZodField(
    source: ZodFieldSource,
    options: ZodFieldOptions = {},
): (value: undefined, context: ClassFieldDecoratorContext) => void {
    return (_value: undefined, context: ClassFieldDecoratorContext): void => {
        if (context.static || context.private) {
            throw new TypeError('@ZodField supports public instance fields only');
        }
        fieldsOf(metadataOf(context)).set(context.name, describedSchema(fieldSchema(source), options.description));
    };
}

/**
 * Creates a zod 3 object schema from the class fields annotated with @ZodField
 * and publishes it as the class's own static schema/parse/safeParse.
 */
export function ZodObject(options: ZodObjectOptions = {}): ObjectDecorator {
    return (value: Function, context: ClassDecoratorContext): void => {
        const schema = refinedSchema(
            describedSchema(objectSchema(metadataOf(context), options), options.description),
            options.refine ?? [],
        );
        schemas.set(value, schema);
        Object.defineProperty(value, 'schema', { value: schema, enumerable: false, configurable: true });
    };
}

/**
 * Base class for a zod 3 @ZodObject DTO. The decorator fills in `schema`;
 * extending this is what makes `MyDto.schema` type-check at the call site.
 */
export class ZodDto {
    declare static readonly schema: z.ZodObject<DtoShape>;

    static parse<TDto>(this: ZodDtoConstructor<TDto>, input: unknown): TDto {
        return getZodSchema(this).parse(input) as TDto;
    }

    static safeParse<TDto>(this: ZodDtoConstructor<TDto>, input: unknown): z.SafeParseReturnType<unknown, TDto> {
        return getZodSchema(this).safeParse(input) as z.SafeParseReturnType<unknown, TDto>;
    }
}

/**
 * Returns a DTO's schema typed from the class, for code that infers types from a
 * schema (`z.infer`, `z.input`) rather than naming the class. `TDefaultedKeys` names
 * the fields declared with `.default()`, which a caller may omit.
 */
export function typedSchema<TDto, TDefaultedKeys extends keyof TDto = never>(
    dto: ZodDtoConstructor<TDto>,
): z.ZodObject<TypedDtoShape<TDto, TDefaultedKeys>> {
    return getZodSchema(dto) as unknown as z.ZodObject<TypedDtoShape<TDto, TDefaultedKeys>>;
}

/** Returns the zod 3 object schema generated for a class annotated with @ZodObject. */
export function getZodSchema<TDto extends Function>(dto: TDto): z.ZodObject<DtoShape> {
    const schema = schemas.get(dto);
    if (schema === undefined) {
        throw new TypeError('DTO classes must use @ZodObject before their schema is read');
    }
    return schema;
}
