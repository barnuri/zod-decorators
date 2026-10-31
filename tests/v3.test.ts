import { describe, expect, expectTypeOf, test } from 'bun:test';
import { z } from 'zod/v3';
import { ZodDto, ZodField, ZodObject, getZodSchema, typedSchema } from '../src/v3.js';

@ZodObject()
class FilterDto {
    @ZodField(z.string().optional())
    tenant: string | undefined = undefined;

    @ZodField(z.coerce.number().int().min(1).default(1))
    page = 1;
}

describe('zod 3 DTO decorators', () => {
    test('builds a zod 3 object schema', () => {
        const schema = getZodSchema(FilterDto);

        expect(schema).toBeInstanceOf(z.ZodObject);
        expect(schema._def.typeName).toBe(z.ZodFirstPartyTypeKind.ZodObject);
    });

    test('builds a stripping object schema from decorated class fields', () => {
        expect(getZodSchema(FilterDto).parse({ tenant: 'tenant-1', extra: 'discarded' })).toEqual({
            tenant: 'tenant-1',
            page: 1,
        });
    });
});

@ZodObject({ description: 'One detail row.' })
class ItemDto extends ZodDto {
    @ZodField(z.string(), { description: 'Row identifier.' })
    id!: string;
}

@ZodObject()
class ItemPageDto extends ZodDto {
    @ZodField([ItemDto])
    items!: ItemDto[];

    @ZodField(z.number().int().default(0))
    total!: number;
}

describe('zod 3 decorated DTO classes', () => {
    test('publishes the generated schema as a static on the class', () => {
        expect(ItemDto.schema).toBe(getZodSchema(ItemDto));
        expect(ItemDto.parse({ id: 'a', extra: 'discarded' })).toEqual({ id: 'a' });
    });

    test('carries field and object descriptions into the schema', () => {
        expect(ItemDto.schema.description).toBe('One detail row.');
        expect(ItemDto.schema.shape['id'].description).toBe('Row identifier.');
    });

    test('nests a DTO class as an array field', () => {
        expect(ItemPageDto.parse({ items: [{ id: 'a' }] })).toEqual({ items: [{ id: 'a' }], total: 0 });
        expect(ItemPageDto.schema.shape['items']).toBeInstanceOf(z.ZodArray);
    });

    test('rejects a payload failing a nested field', () => {
        expect(ItemPageDto.safeParse({ items: [{ id: 1 }] }).success).toBe(false);
    });
});

@ZodObject({ unknownKeys: 'passthrough' })
class LooseDto extends ZodDto {
    @ZodField(z.string())
    id!: string;
}

@ZodObject({ unknownKeys: 'strict' })
class StrictDto extends ZodDto {
    @ZodField(z.string())
    id!: string;
}

describe('zod 3 unknown keys', () => {
    test('passthrough keeps undeclared keys', () => {
        expect<unknown>(LooseDto.parse({ id: 'a', extra: 1 })).toEqual({ id: 'a', extra: 1 });
        expect(LooseDto.schema._def.unknownKeys).toBe('passthrough');
    });

    test('strict rejects undeclared keys', () => {
        expect(StrictDto.safeParse({ id: 'a', extra: 1 }).success).toBe(false);
        expect(StrictDto.schema._def.unknownKeys).toBe('strict');
    });

    test('strip is the default', () => {
        expect(ItemDto.schema._def.unknownKeys).toBe('strip');
    });
});

@ZodObject({ description: 'Fields every event carries.' })
class EventBaseDto extends ZodDto {
    @ZodField(z.string(), { description: 'Event identifier.' })
    id!: string;

    @ZodField(z.string().nullable(), { description: 'Owning tenant.' })
    tenant_id!: string | null;
}

@ZodObject({ description: 'Started.' })
class StartedEventDto extends EventBaseDto {
    @ZodField(z.literal('started'))
    kind!: 'started';
}

@ZodObject({ description: 'Stopped.' })
class StoppedEventDto extends EventBaseDto {
    @ZodField(z.number().int())
    revision!: number;
}

describe('zod 3 inherited DTO fields', () => {
    test('a subclass carries the base fields ahead of its own', () => {
        expect(Object.keys(StartedEventDto.schema.shape)).toEqual(['id', 'tenant_id', 'kind']);
    });

    test('a later subclass does not inherit an earlier sibling field', () => {
        expect(Object.keys(StoppedEventDto.schema.shape)).toEqual(['id', 'tenant_id', 'revision']);
    });

    test('the base schema stays free of every subclass field', () => {
        expect(Object.keys(EventBaseDto.schema.shape)).toEqual(['id', 'tenant_id']);
    });
});

@ZodObject({
    description: 'A range.',
    refine: [
        {
            check: (value: Record<string, unknown>): boolean =>
                value['until'] === undefined || value['from'] !== undefined,
            message: 'until needs from',
            path: ['until'],
        },
    ],
})
class RangeDto extends ZodDto {
    @ZodField(z.number().optional())
    from?: number;

    @ZodField(z.number().optional())
    until?: number;
}

@ZodObject()
class RangeHolderDto extends ZodDto {
    @ZodField(RangeDto, { description: 'Nested range.' })
    range!: RangeDto;
}

describe('zod 3 ZodObject refine', () => {
    test('applies a cross-field rule and reports it on the named path', () => {
        expect(RangeDto.safeParse({ from: 1, until: 2 }).success).toBe(true);
        const result = RangeDto.safeParse({ until: 2 });

        expect(result.success).toBe(false);
        expect(result.error?.issues[0]).toMatchObject({ message: 'until needs from', path: ['until'] });
    });

    test('keeps the schema a zod 3 object, so it still nests as a field', () => {
        expect(RangeDto.schema).toBeInstanceOf(z.ZodObject);
        expect(RangeDto.schema._def.typeName).toBe(z.ZodFirstPartyTypeKind.ZodObject);
        expect(RangeDto.schema.shape).toHaveProperty('from');
        expect(RangeDto.schema.description).toBe('A range.');
    });

    test('keeps the rule when the DTO is nested with a field description', () => {
        const result = RangeHolderDto.safeParse({ range: { until: 2 } });

        expect(result.success).toBe(false);
        expect(result.error?.issues[0]).toMatchObject({ message: 'until needs from', path: ['range', 'until'] });
        expect(RangeHolderDto.schema.shape['range'].description).toBe('Nested range.');
    });
});

@ZodObject()
class ListQueryDto extends ZodDto {
    @ZodField(z.string())
    tenant!: string;

    @ZodField(z.string().nullable().optional())
    search?: string | null;

    @ZodField(z.coerce.number().int().min(1).default(1))
    page!: number;
}

describe('zod 3 typedSchema', () => {
    test('returns the class schema itself', () => {
        expect<unknown>(typedSchema(ListQueryDto)).toBe(ListQueryDto.schema);
    });

    test('types the output from the class fields', () => {
        const schema = typedSchema<ListQueryDto, 'page'>(ListQueryDto);

        expectTypeOf<z.output<typeof schema>>().toEqualTypeOf<{
            tenant: string;
            search?: string | null | undefined;
            page: number;
        }>();
        expect(schema.parse({ tenant: 't1', page: '2' })).toEqual({ tenant: 't1', page: 2 });
    });

    test('lets the input omit a defaulted field', () => {
        const schema = typedSchema<ListQueryDto, 'page'>(ListQueryDto);

        expectTypeOf<z.input<typeof schema>>().toEqualTypeOf<{
            tenant: string;
            search?: string | null | undefined;
            page?: number | undefined;
        }>();
        expect(schema.parse({ tenant: 't1' })).toEqual({ tenant: 't1', page: 1 });
    });
});

@ZodObject({
    refine: [
        {
            check: (value: Record<string, unknown>): boolean => (value['from'] as number) <= (value['to'] as number),
            message: 'from after to',
            path: ['from'],
        },
    ],
})
class BoundsDto extends ZodDto {
    @ZodField(z.number())
    from!: number;

    @ZodField(z.number())
    to!: number;
}

@ZodObject({
    unknownKeys: 'strict',
    refine: [{ check: (value: Record<string, unknown>): boolean => value['a'] !== 'x', message: 'no x', path: ['a'] }],
})
class StrictRefinedDto extends ZodDto {
    @ZodField(z.string())
    a!: string;
}

const reversed = { from: 3, to: 2 };

describe('zod 3 refined schemas derived through object methods', () => {
    test.each([
        ['extend', (): z.ZodTypeAny => BoundsDto.schema.extend({ note: z.string().optional() })],
        ['setKey', (): z.ZodTypeAny => BoundsDto.schema.setKey('note', z.string().optional())],
        ['strict', (): z.ZodTypeAny => BoundsDto.schema.strict()],
        ['strip', (): z.ZodTypeAny => BoundsDto.schema.strip()],
        ['passthrough', (): z.ZodTypeAny => BoundsDto.schema.passthrough()],
        ['catchall', (): z.ZodTypeAny => BoundsDto.schema.catchall(z.unknown())],
        ['required', (): z.ZodTypeAny => BoundsDto.schema.required()],
        ['describe', (): z.ZodTypeAny => BoundsDto.schema.describe('Bounds.')],
    ])('%s keeps the cross-field rule', (_method: string, derive: () => z.ZodTypeAny) => {
        const schema = derive();

        expect(schema).toBeInstanceOf(z.ZodObject);
        expect(schema.safeParse({ from: 1, to: 2 }).success).toBe(true);
        expect(schema.safeParse(reversed).error?.issues).toMatchObject([{ message: 'from after to', path: ['from'] }]);
    });

    test('extend refuses to overwrite a refined field', () => {
        expect(() => BoundsDto.schema.extend({ from: z.string() })).toThrow(
            'Cannot overwrite keys on object schemas containing refinements',
        );
    });

    test.each([
        ['merge', (): unknown => BoundsDto.schema.merge(ItemDto.schema)],
        ['pick', (): unknown => BoundsDto.schema.pick({ from: true })],
        ['omit', (): unknown => BoundsDto.schema.omit({ to: true })],
        ['partial', (): unknown => BoundsDto.schema.partial()],
        ['deepPartial', (): unknown => BoundsDto.schema.deepPartial()],
    ])('%s throws instead of dropping the rule', (method: string, derive: () => unknown) => {
        expect(derive).toThrow(`.${method}() cannot be used on object schemas containing refinements`);
    });
});

describe('zod 3 refine runs only on an otherwise valid object', () => {
    test('a strict unknown-key failure skips the rules', () => {
        expect(StrictRefinedDto.safeParse({ a: 'x', z: 1 }).error?.issues).toMatchObject([
            { code: 'unrecognized_keys', path: [] },
        ]);
    });

    test('a field failure skips the rules', () => {
        expect(BoundsDto.safeParse({ from: 3, to: 'b' }).error?.issues).toMatchObject([
            { code: 'invalid_type', path: ['to'] },
        ]);
    });

    test('async parsing applies the rules', async () => {
        const result = await BoundsDto.schema.safeParseAsync(reversed);

        expect(result.error?.issues).toMatchObject([{ message: 'from after to', path: ['from'] }]);
    });
});
