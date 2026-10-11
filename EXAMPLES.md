# @barnuri/zod-decorators — examples

Declarative DTO classes in the NestJS / `class-validator` shape, backed by Zod.
A decorated class is both the **TypeScript type** and the **validation schema**,
the way a pydantic model is in FastAPI.

Pair this with [`@barnuri/hono-decorators`](https://github.com/barnuri/hono-decorators/blob/master/EXAMPLES.md),
which consumes `<Dto>.schema` on the route.

## The default: a decorated class

```ts
import { ZodDto, ZodField, ZodObject } from '@barnuri/zod-decorators';
import { z } from 'zod';

@ZodObject({ description: 'A tenant as a selectable filter value.' })
export class TenantOptionDto extends ZodDto {
    @ZodField(z.string(), { description: 'CloudInfra tenant id.' })
    ci_tenant_id!: string;

    @ZodField(z.string().nullable().default(null), {
        description: 'Tenant display name, null when tenant_info has no record.',
    })
    ci_tenant_name!: string | null;
}
```

Three things this buys you:

```ts
TenantOptionDto.schema; // the Zod schema — pass to @Query/@Body/@Response
TenantOptionDto.parse(row); // validated, defaults applied, unknown keys stripped
function render(option: TenantOptionDto) {} // the class IS the type
```

`extends ZodDto` is what makes `.schema` / `.parse` / `.safeParse` type-check.
`@ZodObject` fills them in at decoration time. Skip the base class and the
statics exist at runtime but TypeScript won't see them.

## Field kinds

```ts
@ZodObject()
export class ExampleDto extends ZodDto {
    // Required.
    @ZodField(z.string())
    id!: string;

    // Optional — absent from the payload entirely.
    @ZodField(z.string().optional())
    note?: string;

    // Nullable with a default — always present on the wire.
    @ZodField(z.number().nullable().default(null))
    score!: number | null;

    // Coerced, for query strings where everything arrives as text.
    @ZodField(z.coerce.number().int().min(1).default(1))
    page!: number;

    // Enum.
    @ZodField(z.enum(['hour', 'day', 'week']))
    bucket!: 'hour' | 'day' | 'week';
}
```

## Nesting one DTO in another

`@ZodField` takes a DTO class directly, or a one-element array for a list —
the equivalent of NestJS's `@ApiProperty({ type: [ItemDto] })`.

```ts
@ZodObject({ description: 'One page of rows.' })
export class ItemsPageDto extends ZodDto {
    @ZodField([ItemDto], { description: 'The rows on this page.' })
    items!: ItemDto[];

    @ZodField(ItemSummaryDto, { description: 'Totals across all matching rows.' })
    summary!: ItemSummaryDto;

    @ZodField(z.number().int(), { description: 'Rows matching, ignoring pagination.' })
    total!: number;
}
```

The nested class must already be **defined above** the class referencing it —
its `schema` is read when the outer class is decorated, not lazily.

## Descriptions reach the OpenAPI document

`description` compiles to Zod's `.describe()`, which `@hono/zod-openapi` renders
as the schema and property `description`. Write them for anything a client
author couldn't guess from the field name:

```json
{
    "share_of_conversations": {
        "type": "number",
        "default": 0,
        "description": "Share of this dimension's own conversation total, not the page total — message-derived dimensions are non-additive, so a conversation can span several values."
    }
}
```

## Unknown keys

Stripping is the default, matching pydantic. Override per class:

```ts
@ZodObject({ unknownKeys: 'strict' })   // reject a payload carrying extra keys
@ZodObject({ unknownKeys: 'passthrough' }) // keep them
```

## Cross-field rules

A rule that reads more than one field goes on the class, not in `createZodDto`.
The schema stays a `z.ZodObject`, so the DTO still nests as a `@ZodField`:

```ts
@ZodObject({
    refine: [{ check: (v) => v['until'] === undefined || v['from'] !== undefined, message: 'until needs from', path: ['until'] }],
})
export class RangeDto extends ZodDto {
    @ZodField(z.number().optional()) from?: number;
    @ZodField(z.number().optional()) until?: number;
}
```

## Inheritance does not carry fields

`@ZodField` metadata is not inherited. A DTO that is "another DTO plus two
fields" restates every field:

```ts
// Correct: every field declared on the class that needs it.
@ZodObject()
export class DetailQueryDto extends ZodDto {
    @ZodField(isoDateTimeSchema.optional()) created_from?: string;
    @ZodField(isoDateTimeSchema.optional()) created_to?: string;
    @ZodField(pageNumberSchema) page!: number;
    @ZodField(pageSizeSchema) page_size!: number;
}
```

Share the *field schemas* (`pageNumberSchema`) and the description strings
between the classes, not a base class.

## `createZodDto` — legacy, do not add new uses

New DTOs are always decorated classes. When the decorators cannot express a
shape, extend this package (as `refine` above was added) rather than wrapping a
schema. Existing call sites look like this:

```ts
import { createZodDto } from '@barnuri/zod-decorators';

const pageSchema = baseSchema.merge(paginationSchema).refine(hasOneOf);
export class PageDto extends createZodDto(pageSchema) {}
```

Same static surface (`.schema`, `.parse`, `.safeParse`), so call sites do not
care which style produced the DTO.

Not every Zod schema wants to be a DTO. Enums and scalars
(`bucketIntervalSchema = z.enum([...])`) stay plain schemas — only object
shapes become classes.

## Anti-patterns

```ts
// Don't: a type declared separately from the schema. The class is the type.
export type TenantOption = z.infer<typeof tenantOptionSchema>;

// Don't: reading the schema through the helper when the class extends ZodDto.
getZodSchema(TenantOptionDto); // use TenantOptionDto.schema

// Don't: a DTO no route and no caller references. Delete it.
```
