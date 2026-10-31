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

@ZodObject({ description: 'A user as a selectable filter value.' })
export class UserOptionDto extends ZodDto {
    @ZodField(z.string(), { description: 'User id.' })
    user_id!: string;

    @ZodField(z.string().nullable().default(null), {
        description: 'User display name, null when the user has no profile.',
    })
    display_name!: string | null;
}
```

Three things this buys you:

```ts
UserOptionDto.schema; // the Zod schema — pass to @Query/@Body/@Response
UserOptionDto.parse(row); // validated, defaults applied, unknown keys stripped
function render(option: UserOptionDto) {} // the class IS the type
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
    "share_of_orders": {
        "type": "number",
        "default": 0,
        "description": "Share of this category's own order total, not the page total. An order can span several categories, so the shares do not add up to 1."
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

## A typed schema for inference: `typedSchema`

`<Dto>.schema` is typed as a generic object, which is enough to pass to a route.
Code that *infers* a type from a schema (`z.infer`, `z.input`, an endpoint
descriptor typed by its schemas) needs `typedSchema`, which types the same schema
from the class fields. Name the fields that carry a `.default()` so the input side
may omit them:

```ts
@ZodObject()
export class ListUsersQueryDto extends ZodDto {
    @ZodField(z.coerce.number().int().min(1).default(1)) page!: number;
    @ZodField(z.string().optional()) search?: string;
}

const input = typedSchema<ListUsersQueryDto, 'page'>(ListUsersQueryDto);
type Out = z.output<typeof input>; // { page: number; search?: string }
type In = z.input<typeof input>; // { page?: number; search?: string }
input.shape.search; // typed field schema, reusable in another DTO
```

It returns `<Dto>.schema` itself; only the type differs. The type follows the
class, so a field whose schema disagrees with its property type is not caught here.

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
export type UserOption = z.infer<typeof userOptionSchema>;

// Don't: reading the schema through the helper when the class extends ZodDto.
getZodSchema(UserOptionDto); // use UserOptionDto.schema

// Don't: a DTO no route and no caller references. Delete it.
```

## zod 3 schemas (`@barnuri/zod-decorators/v3`) — for a2ui

`@a2ui/react` and `@a2ui/web_core` read zod 3 internals (`_def.typeName`), so a
zod 4 schema does not work there. For those shapes import the decorators from the
`v3` subpath and the field schemas from `zod/v3` (the zod 4 package's bundled zod
3, no extra dependency). Everything else keeps the main entry.

```ts
import { z } from 'zod/v3';
import { ZodDto, ZodField, ZodObject } from '@barnuri/zod-decorators/v3';

@ZodObject({ description: 'Props of the metric card component.' })
export class MetricCardPropsDto extends ZodDto {
    @ZodField(z.string(), { description: 'Card title.' }) title!: string;
    @ZodField(z.number().optional(), { description: 'Value to show.' }) value?: number;
}

MetricCardPropsDto.schema; // a zod 3 ZodObject, ready for the a2ui catalog
```

Same API as the main entry (`ZodObject`, `ZodField`, `ZodDto`, `getZodSchema`,
`typedSchema`), without the legacy `createZodDto`. `unknownKeys` maps to zod 3's
`.passthrough()` / `.strict()`. Never mix the two: a `v3` DTO's fields are
`zod/v3` schemas and its nested DTOs are `v3` DTOs.

`refine` behaves as it does in zod 4:

- The schema stays a `ZodObject`, so a refined DTO nests as a field and a2ui still
  binds its props. A hand-written top-level `.refine()` is a `ZodEffects`, which
  a2ui treats as a static value.
- The rules run only when every field parsed and no unknown key was rejected.
- `.extend`, `.strict`, `.strip`, `.passthrough`, `.catchall`, `.required` and
  `.describe` keep the rules. `.extend` throws when it overwrites a field.
- `.merge`, `.pick`, `.omit`, `.partial` and `.deepPartial` throw rather than
  return a schema without the rules. Declare a new DTO instead.

In an a2ui component, never use one DTO class for two fields. zod-to-json-schema
prints the second use as a root-relative `$ref`, and the a2ui catalog moves the
props under `allOf`, so that `$ref` points nowhere. Declare a second class.
