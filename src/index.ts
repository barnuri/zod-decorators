import { z } from 'zod';

/** Property shape of a generated object schema. */
type DtoShape = Record<string, z.ZodType>;

export interface ZodDtoClass<Schema extends z.ZodType> {
    new (): z.output<Schema>;
    readonly schema: Schema;
    parse(input: unknown): z.output<Schema>;
    safeParse(input: unknown): z.ZodSafeParseResult<z.output<Schema>>;
}

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

/** A class carrying a Zod schema: a createZodDto facade or a @ZodObject class. */
export interface SchemaCarryingClass {
    readonly schema: z.ZodType;
}

/**
 * What @ZodField accepts: a Zod schema, a DTO class, or a one-element array of
 * either, which becomes an array field.
 */
export type ZodFieldSource = z.ZodType | SchemaCarryingClass | readonly [z.ZodType | SchemaCarryingClass];

type ZodDtoConstructor<DtoT> = (new () => DtoT) & { readonly schema: z.ZodType };

type FieldMetadata = Map<string | symbol, z.ZodType>;
type ObjectDecorator = (value: Function, context: ClassDecoratorContext) => void;
type ObjectMetadata = DecoratorMetadataObject & {
    [dtoFields]?: FieldMetadata;
};

const dtoFields = Symbol('zod-decorators.fields');
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
    // WHY: Stage-3 metadata inherits from the base class's, so a subclass reads the
    // base's own Map here. Copy it rather than share it — sharing lets two subclasses
    // of one base append their fields to each other.
    const fields = new Map<string | symbol, z.ZodType>(metadata[dtoFields]);
    metadata[dtoFields] = fields;
    return fields;
}

function isSchemaCarryingClass(source: ZodFieldSource): source is SchemaCarryingClass {
    return typeof source === 'function' && 'schema' in source;
}

/** Resolves a @ZodField source to the Zod schema it stands for. */
function fieldSchema(source: ZodFieldSource): z.ZodType {
    if (Array.isArray(source)) {
        return z.array(fieldSchema(source[0] as ZodFieldSource));
    }
    if (isSchemaCarryingClass(source)) {
        return source.schema;
    }
    return source as z.ZodType;
}

function describedSchema<SchemaT extends z.ZodType>(schema: SchemaT, description: string | undefined): SchemaT {
    return description === undefined ? schema : (schema.describe(description) as unknown as SchemaT);
}

function objectSchema(metadata: ObjectMetadata, options: ZodObjectOptions): z.ZodObject<DtoShape> {
    const shape: Record<string, z.ZodType> = {};
    for (const [name, schema] of fieldsOf(metadata)) {
        if (typeof name !== 'string') {
            throw new TypeError('Zod DTO fields must use string property names');
        }
        shape[name] = schema;
    }
    if (options.unknownKeys === 'passthrough') {
        return z.looseObject(shape);
    }
    if (options.unknownKeys === 'strict') {
        return z.strictObject(shape);
    }
    return z.object(shape);
}

/** Creates an extendable DTO class facade around an existing Zod schema. */
export function createZodDto<Schema extends z.ZodType>(schema: Schema): ZodDtoClass<Schema> {
    class ZodDto {
        static readonly schema = schema;

        static parse(input: unknown): z.output<Schema> {
            return schema.parse(input);
        }

        static safeParse(input: unknown): z.ZodSafeParseResult<z.output<Schema>> {
            return schema.safeParse(input);
        }
    }

    return ZodDto as unknown as ZodDtoClass<Schema>;
}

/**
 * Declares a property schema for a Stage-3-decorated DTO class. The source is a
 * Zod schema, another decorated DTO class, or a one-element array of either for
 * a list field.
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
 * Creates a Zod object schema from the class fields annotated with @ZodField and
 * publishes it as the class's own static schema/parse/safeParse.
 */
export function ZodObject(options: ZodObjectOptions = {}): ObjectDecorator {
    return (value: Function, context: ClassDecoratorContext): void => {
        const schema = (options.refine ?? []).reduce(
            (refined: z.ZodObject<DtoShape>, rule: ZodObjectRefinement) =>
                refined.refine(rule.check, {
                    message: rule.message,
                    path: rule.path === undefined ? undefined : [...rule.path],
                }),
            describedSchema(objectSchema(metadataOf(context), options), options.description),
        );
        schemas.set(value, schema);
        // WHY: ZodDto declares these statics but cannot compute them — the field
        // metadata only exists once the class decorator runs.
        Object.defineProperty(value, 'schema', { value: schema, enumerable: false, configurable: true });
    };
}

/**
 * Base class for a @ZodObject DTO, giving it the same static surface a
 * createZodDto facade has. The decorator fills in `schema`; extending this is
 * what makes `MyDto.schema` type-check at the call site.
 */
export class ZodDto {
    declare static readonly schema: z.ZodObject<DtoShape>;

    static parse<DtoT>(this: ZodDtoConstructor<DtoT>, input: unknown): DtoT {
        return getZodSchema(this).parse(input) as DtoT;
    }

    static safeParse<DtoT>(this: ZodDtoConstructor<DtoT>, input: unknown): z.ZodSafeParseResult<DtoT> {
        return getZodSchema(this).safeParse(input) as z.ZodSafeParseResult<DtoT>;
    }
}

/** Returns the object schema generated for a class annotated with @ZodObject. */
export function getZodSchema<Dto extends Function>(dto: Dto): z.ZodObject<DtoShape> {
    const schema = schemas.get(dto);
    if (schema === undefined) {
        throw new TypeError('DTO classes must use @ZodObject before their schema is read');
    }
    return schema;
}
