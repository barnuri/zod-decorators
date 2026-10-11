import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { ZodDto, ZodField, ZodObject, createZodDto, getZodSchema } from '../src/index.js';

const userSchema = z.object({
    id: z.string().uuid(),
    display_name: z.string().default('Anonymous'),
});

class UserDto extends createZodDto(userSchema) {}

@ZodObject()
class FilterDto {
    @ZodField(z.string().optional())
    tenant: string | undefined = undefined;

    @ZodField(z.coerce.number().int().min(1).default(1))
    page: number = 1;
}

describe('Zod DTO decorators', () => {
    test('provides an extendable class facade around an existing schema', () => {
        expect(UserDto.parse({ id: '3d2d41dc-d5e6-4b7c-8b95-fa9d2fb4f8bc' })).toEqual({
            id: '3d2d41dc-d5e6-4b7c-8b95-fa9d2fb4f8bc',
            display_name: 'Anonymous',
        });
    });

    test('builds a stripping object schema from decorated class fields', () => {
        const schema = getZodSchema(FilterDto);

        expect(schema.parse({ tenant: 'tenant-1', extra: 'discarded' })).toEqual({
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

describe('decorated DTO classes', () => {
    test('publishes the generated schema as a static on the class', () => {
        expect(ItemDto.schema).toBe(getZodSchema(ItemDto));
        expect(ItemDto.parse({ id: 'a', extra: 'discarded' })).toEqual({ id: 'a' });
    });

    test('carries field and object descriptions into the schema', () => {
        expect(ItemDto.schema.description).toBe('One detail row.');
        expect(ItemDto.schema.shape.id?.description).toBe('Row identifier.');
    });

    test('nests a DTO class as an array field', () => {
        expect(ItemPageDto.parse({ items: [{ id: 'a' }] })).toEqual({ items: [{ id: 'a' }], total: 0 });
    });

    test('rejects a payload failing a nested field', () => {
        expect(ItemPageDto.safeParse({ items: [{ id: 1 }] }).success).toBe(false);
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

describe('inherited DTO fields', () => {
    test('a subclass carries the base fields ahead of its own', () => {
        expect(Object.keys(StartedEventDto.schema.shape)).toEqual(['id', 'tenant_id', 'kind']);
    });

    test('a later subclass does not inherit an earlier sibling field', () => {
        expect(Object.keys(StoppedEventDto.schema.shape)).toEqual(['id', 'tenant_id', 'revision']);
        expect(StoppedEventDto.safeParse({ id: 'e1', tenant_id: null, revision: 1 }).success).toBe(true);
    });

    test('the base schema stays free of every subclass field', () => {
        expect(Object.keys(EventBaseDto.schema.shape)).toEqual(['id', 'tenant_id']);
    });

    test('a subclass inherits the base field descriptions', () => {
        expect(StartedEventDto.schema.shape.tenant_id?.description).toBe('Owning tenant.');
    });

    test('parses a subclass payload without requiring a sibling field', () => {
        expect(StartedEventDto.parse({ id: 'e1', tenant_id: null, kind: 'started' })).toEqual({
            id: 'e1',
            tenant_id: null,
            kind: 'started',
        });
    });
});

@ZodObject({
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

describe('ZodObject refine', () => {
    test('applies a cross-field rule and reports it on the named path', () => {
        expect(RangeDto.safeParse({ from: 1, until: 2 }).success).toBe(true);
        const result = RangeDto.safeParse({ until: 2 });

        expect(result.success).toBe(false);
        expect(result.error?.issues[0]).toMatchObject({ message: 'until needs from', path: ['until'] });
    });

    test('keeps the schema an object, so it still nests as a field', () => {
        expect(RangeDto.schema.shape).toHaveProperty('from');
    });
});
