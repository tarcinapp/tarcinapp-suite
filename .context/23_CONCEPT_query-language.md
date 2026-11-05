# 23_CONCEPT_query-language.md

## Overview

Tarcinapp has two query layers:

1. **EPS native syntax** — LoopBack 4 `filter[...]` notation. Accepted by `entity-persistence-service` directly.
2. **Gateway simplified aliases** — Shorter params added by the Gateway that map to EPS syntax. Only available when calling through the Gateway.

This document covers both layers. All examples show the form the client would send to the Gateway.

---

## Standard Filtering: `filter[where]`

The primary conditional filter. Supports all standard comparison operators.

```
GET /entities?filter[where][_kind]=book
GET /entities?filter[where][status]=active
GET /entities?filter[where][score][gte]=100
GET /entities?filter[where][_name][regexp]=^War
```

### Comparison Operators

| Operator | Example | Meaning |
|:---|:---|:---|
| `eq` (implicit) | `filter[where][field]=value` | Equal to |
| `neq` | `filter[where][field][neq]=value` | Not equal |
| `gt` | `filter[where][field][gt]=100` | Greater than |
| `gte` | `filter[where][field][gte]=100` | Greater than or equal |
| `lt` | `filter[where][field][lt]=100` | Less than |
| `lte` | `filter[where][field][lte]=100` | Less than or equal |
| `inq` | `filter[where][field][inq][]=a&filter[where][field][inq][]=b` | Value in list |
| `nin` | `filter[where][field][nin][]=a` | Value not in list |
| `between` | `filter[where][score][between][]=10&filter[where][score][between][]=20` | Inclusive range |
| `like` | `filter[where][field][like]=foo%25` | Case-sensitive pattern |
| `nlike` | `filter[where][field][nlike]=foo%25` | Not like (case-sensitive) |
| `ilike` | `filter[where][field][ilike]=foo%25` | Case-insensitive like |
| `nilike` | `filter[where][field][nilike]=foo%25` | Case-insensitive not like |
| `exists` | `filter[where][field][exists]=true` | Field exists / does not exist |
| `regexp` | `filter[where][field][regexp]=^hello` | Regular expression |

### Logical Operators

```
AND:
GET /entities?filter[where][and][0][_kind]=book&filter[where][and][1][_visibility]=public

OR:
GET /entities?filter[where][or][0][score][gte]=90&filter[where][or][1][featured]=true
```

### Type Coercion

All query string values are strings. For managed fields with known types (datetime, integer), the backend handles coercion automatically. For **custom (application-defined) fields** — e.g., `pages`, `price` — you **must** add an explicit type hint, otherwise the value is compared as a string and numeric comparisons will fail silently:

```
GET /entities?filter[where][pages][gt]=300&filter[where][pages][type]=number
```

Supported type hint values: `number`, `boolean`.

> **Gateway auto-type-injection on kind-alias routes:** When calling through a kind-alias route (e.g., `GET /books`) that has a JSON Schema configured, the `InjectTypeHintsToQuery` gateway filter automatically adds type hints for all fields defined in the schema. The filter processes all where-clause families (`filter[where]`, `where[...]`, `entityWhere[...]`, etc.) and skips managed fields (those starting with `_`) as well as lookup scope keys. **Exception:** inside a `filter[lookup][N][scope][where]`, type hints are NOT injected automatically — you must add them manually there, because the referenced record type may differ from the current route's schema.

### Datetime Filtering

Datetime values must be ISO 8601 strings. Use comparison operators (`gt`, `gte`, `lt`, `lte`) with datetime strings:

```
GET /entities?filter[where][_createdDateTime][gte]=2024-01-01T00:00:00Z
GET /entities?filter[where][_validUntilDateTime][lt]=2024-12-31T23:59:59Z
GET /entities?filter[where][_createdDateTime][between][]=2024-01-01T00:00:00Z&filter[where][_createdDateTime][between][]=2024-06-30T23:59:59Z
```

Managed datetime fields (`_createdDateTime`, `_lastUpdatedDateTime`, `_validFromDateTime`, `_validUntilDateTime`) are stored and compared as ISO 8601 and do not require a `[type]` hint.

### Exists / Absence Filter

Use `exists=false` to find records where a field is absent — useful for finding records that have never had a particular custom field set:

```
GET /entities?filter[where][publishedAt][exists]=false
GET /entities?filter[where][isbn][exists]=true
```

### Regexp Operator — Edge Cases

The `regexp` operator uses MongoDB regex syntax. Anchors (`^` and `$`) work as expected. For case-insensitive matching, pass a separate `[options]` key alongside `[regexp]`:

```
GET /entities?filter[where][_name][regexp]=^war&filter[where][_name][options]=i
GET /entities?filter[where][_name][regexp]=^War and Peace$
```

### `inq` / `nin` Edge Cases

- `inq` with an **empty array** returns **no results** — every record is excluded.
- `nin` with an **empty array** returns **all results** — no record is excluded.

```
GET /entities?filter[where][_kind][inq][]=book&filter[where][_kind][inq][]=article
GET /entities?filter[where][status][nin][]=archived
```

### Special Literal Handling

- `true` / `false` strings are always treated as booleans: `filter[where][isPublished]=true`
- `"null"` string is treated as null: `filter[where][deletedAt]=null`

### `where[...]` shorthand

For count, updateAll, deleteAll operations (which don't accept a `filter` object wrapper):

```
GET /entities/count?where[_kind]=book&where[status]=active
PATCH /entities?where[_kind]=draft
DELETE /entities?where[expiresAt][lt]=2024-01-01
```

---

## Field Selection: `filter[fields]`

Control which fields appear in the response.

```
GET /entities?filter[fields][_name]=true&filter[fields][author]=true
GET /entities?filter[fields][_id]=true&filter[fields][_name]=true
```

- **Include mode**: set fields to `true` — only those fields are returned.
- **Exclude mode**: set fields to `false` — all fields except those are returned.

> **Do not mix modes in a single request.** Combining `true` and `false` values in the same `filter[fields]` call produces undefined behavior. Use only include mode **or** only exclude mode per request.

### `_kind` is always returned

`_kind` is **always** included in the response regardless of field selection. This constraint is enforced at the EPS level — you cannot exclude it.

### Count-only cached fields — queryable but never returned

Several managed fields are **never returned in response bodies**, even if explicitly requested via `filter[fields]`. They exist solely as indexed, cached values for efficient filtering:

| Field | Queryable | Returned in response |
|:---|:---:|:---:|
| `_parentsCount` | ✓ | ✗ |
| `_ownerUsersCount` | ✓ | ✗ |
| `_ownerGroupsCount` | ✓ | ✗ |
| `_viewerUsersCount` | ✓ | ✗ |
| `_viewerGroupsCount` | ✓ | ✗ |
| `_idempotencyKey` | ✓ | ✗ |
| `_recordType` | ✓ | ✗ |

These fields can be used freely in `filter[where]` conditions. Requesting them in `filter[fields]` has no effect.

### Arbitrary fields and `false` exclusion — LoopBack edge case

Due to a LoopBack behavior, setting **any** arbitrary (non-schema) field to `false` in `filter[fields]` will exclude **all** other arbitrary fields from the response, even those not explicitly mentioned. Built-in managed fields (`_id`, `_name`, `_kind`) are unaffected by this edge case.

### Gateway alias: `?fields=`

```
GET /books?fields=_id,_name,author,isbn
```

Mapped to: `filter[fields][_id]=true&filter[fields][_name]=true&filter[fields][author]=true&filter[fields][isbn]=true`

---

## Sorting: `filter[order]`

```
GET /entities?filter[order]=_createdDateTime%20DESC
GET /entities?filter[order]=score%20ASC
GET /entities?filter[order][0]=score%20DESC&filter[order][1]=_name%20ASC
```

### Gateway alias: `?order=`

```
GET /books?order=_name ASC
```

> **Simplified `?order=` is single-field only.** Multi-field ordering requires raw `filter[order][0]=...&filter[order][1]=...` notation, which requires `app.allowBackendQueryNotation=true`.

---

## Pagination: `filter[limit]` and `filter[skip]`

```
GET /entities?filter[limit]=20&filter[skip]=40
```

### Gateway aliases: `?limit=` and `?skip=`

```
GET /books?limit=20&skip=40
```

Maximum limit is set by `APP_RESPONSE_LIMIT_ENTITIES` (EPS config). Requests exceeding this are capped silently.

> **Always specify `filter[limit]`** (or `?limit=`). Without it, the `APP_RESPONSE_LIMIT_ENTITIES` default applies and results are silently capped — there is no error or warning.

---

## Related Model Inclusion: `filter[include]`

Eagerly load related records alongside the primary result.

### For Lists — include contained entities

```
GET /lists?filter[include][0][relation]=_entities&filter[include][1][relation]=_reactions
```

The included entities appear as an `_entities` array on each list item in the response.

### For Entities — include reactions

```
GET /entities?filter[include][0][relation]=_reactions
```

The included reactions appear as a `_reactions` array on each entity in the response.

### With scope — filter and limit included records

Use a scope to filter the included records independently from the outer query:

```
GET /lists?filter[include][0][relation]=_entities&filter[include][0][scope][where][_kind]=review&filter[include][0][scope][limit]=5&filter[include][0][scope][sets][actives]=true
```

> Type hints in `filter[include][0][scope][where]` are **not** auto-injected by `InjectTypeHintsToQuery`. Add them manually if needed:
> ```
> filter[include][0][scope][where][pageCount][lte]=300&filter[include][0][scope][where][pageCount][type]=number
> ```

### Domain kind-alias includes

On kind-alias routes, you can use domain-named relations instead of the generic `_entities` / `_reactions`:

```
GET /bookshelves?filter[include][0][relation]=books
```

The gateway (`ConvertDomainIncludeAliasToGenericRelation` filter) rewrites this to:

```
filter[include][0][relation]=_entities&filter[include][0][scope][where][_kind]=book
```

The response-side `ProjectDomainIncludeAliasInResponse` filter then renames `_entities` back to `books` in the response payload. This translation is transparent to the caller.

### Gateway alias: `?include=`

```
GET /bookshelves?include=books,reviews
```

Mapped to: `filter[include][0][relation]=books&filter[include][1][relation]=reviews`

---

## Sets: Semantic State and Visibility Filters

Sets are named query shortcuts that apply complex filter combinations. They are EPS-native and accepted at the base URL.

### Status Sets

| Set | Equivalent filter |
|:---|:---|
| `sets[actives]=true` | `_validFromDateTime <= now AND (_validUntilDateTime IS NULL OR _validUntilDateTime > now)` |
| `sets[pendings]=true` | `_validFromDateTime IS NULL OR _validFromDateTime > now` |
| `sets[expireds]=true` | `_validUntilDateTime <= now` |

### Visibility Sets

| Set | Equivalent filter |
|:---|:---|
| `sets[publics]=true` | `_visibility = "public"` |
| `sets[protecteds]=true` | `_visibility = "protected"` |
| `sets[privates]=true` | `_visibility = "private"` |

### Ownership Set

| Set | Equivalent filter |
|:---|:---|
| `sets[owners][userIds]={userId}` | `_ownerUsers contains userId` |

### Root Items Set

| Set | Equivalent filter |
|:---|:---|
| `sets[roots]=true` | `_parentsCount = 0` |

### Combining Sets

```
GET /entities?sets[actives]=true&sets[publics]=true
GET /entities?sets[owners][userIds]=user123&sets[actives]=true
```

### Gateway injection

The Gateway automatically injects appropriate sets based on the caller's role and identity. For example, a `member` calling `GET /entities` will have the Gateway add:
- `sets[owners][userIds]={sub}` OR `(sets[actives]=true AND sets[publics]=true)` — scoping the query to only records the member can legitimately see.

Clients can also explicitly send sets to further narrow results (e.g., "show me only my active public records").

---

## Named Queries: `?q=`

Pre-configured query shortcuts defined in the gateway. Defined in `application-queries.yml` (or via environment properties). Named queries are **gateway-wide** — they are accessible on ALL endpoints, regardless of kind. If a named query should only apply to one kind, rely on the client to send it only on that endpoint.

```yaml
app:
  queries:
    my: "'sets[owners][userIds]=' + #userId"
    actives: "'sets[actives]'"
    by-slug: "'filter[where][_slug]=' + #query['slug']"
    by-name: "'filter[where][_name]=' + #query['name']"
```

Usage:

```
GET /books?q=my              ← my books (owner = caller)
GET /books?q=actives         ← only active books
GET /books?q=by-slug&slug=war-and-peace   ← book by slug
GET /books?q=by-name&name=Widget          ← book by name
```

If `?q=unknown-name` references an undefined query, the parameter is **silently dropped** and a `WARN` is logged. No error is returned to the client.

### SpEL Context Variables

Each saved query is a Spring Expression Language (SpEL) expression that evaluates to a URL query string (without the leading `?`). Two variables are available at evaluation time:

| Variable | Type | Description | Example usage |
|:---|:---|:---|:---|
| `#userId` | `String` | JWT `sub` of the authenticated caller. `null` for unauthenticated requests. | `'sets[owners][userIds]=' + #userId` |
| `#query` | `Map<String, String>` | All query parameters from the incoming request. Use to pass ad-hoc values into the query expression. | `'filter[where][_slug]=' + #query['slug']` |

> **`#now` is not a built-in SpEL variable** in the current gateway implementation. Datetime-relative queries (e.g., "records created after today") must be expressed via `filter[where]` directly by the client, or by pre-computing the timestamp in a custom saved query expression using SpEL's `new java.time.Instant.now()` if permitted by the SpEL sandbox.

### Default (Built-in) Named Queries

The default configuration ships with the following built-in named queries:

| Name | Expression | Effect |
|:---|:---|:---|
| `actives` | `'sets[actives]'` | Filter to active records only |
| `inactives` | `'sets[inactives]'` | Filter to inactive records |
| `my` | `'sets[owners][userIds]=' + #userId` | Scope to caller's own records |
| `name` | `'filter[where][_name]=' + #query['name']` | Exact name match (pass `&name=...`) |
| `slug` | `'filter[where][_slug]=' + #query['slug']` | Exact slug match (pass `&slug=...`) |

These can be overridden per-environment in `application-dev.properties`.

---

## Field Sets: `?fieldset=`

Pre-configured field projections defined in the gateway (`application-fieldsets.yml`). Applies a named keep-or-drop rule to the response payload in the gateway response phase, **after** data is received from the backend.

### Fieldset Modes

| Mode | Behavior |
|:---|:---|
| `show` | **Whitelist (inclusive):** only the listed fields are kept; all others are removed. |
| `hide` | **Blacklist (exclusive):** the listed fields are removed; all others are kept. |

An empty `fields` list with `hide` mode produces no change. An empty `fields` list with `show` mode produces an empty response object.

```yaml
app:
  fieldsets:
    global:
      bookinfo:
        mode: show
        fields: [_id, _name, author, isbn, _slug]
      no-sensitive:
        mode: hide
        fields: [_ownerUsers, _viewerUsers, _createdBy]
    entities:
      defaultFieldset: hide-managed-except-id
```

Usage:

```
GET /books?fieldset=bookinfo          ← only id, name, author, isbn, slug
GET /books?fieldset=show-managed-all  ← only managed (system) fields
GET /books?fieldset=hide-managed-all  ← only custom (application) fields
GET /books?fieldset=show-all          ← full payload (bypass any default)
```

### Built-in Global Fieldsets

| Fieldset Name | Mode | Effect |
|:---|:---|:---|
| `show-all` | `hide` | Returns all fields (empty hide list — bypasses any default) |
| `show-managed-all` | `show` | Returns only managed fields (`_id`, `_kind`, `_name`, `_slug`, `_visibility`, etc.) |
| `hide-managed-all` | `hide` | Removes all managed fields; returns only application-defined fields |
| `hide-managed-except-id` | `hide` | Removes managed fields except `_id` |
| `hide-managed-except-id-kind-name` | `hide` | Removes managed fields except `_id`, `_kind`, `_name` |

### Default Fieldset

A default fieldset fires automatically on all GET requests for a resource type when the client does **not** send a `?fieldset=` parameter:

```yaml
app:
  fieldsets:
    entities:
      defaultFieldset: hide-managed-except-id   # applied automatically
    lists:
      defaultFieldset: null                      # no default; full payload
```

Via environment variables:

```bash
APP_FIELDSETS_ENTITIES_DEFAULTFIELDSET=hide-managed-except-id
APP_FIELDSETS_GLOBAL_BOOKINFO_MODE=show
APP_FIELDSETS_GLOBAL_BOOKINFO_FIELDS=_id,_name,author,isbn
```

To explicitly request the full, unfiltered payload when a default is configured:

```
GET /books?fieldset=show-all
```

### Fieldset Interaction with OPA Field Masking

Fieldsets and OPA field masking are **independent and both applied**, with masking always having final authority:

1. **Fieldset** runs first in the response phase — it shapes the payload by its `show`/`hide` rules.
2. **OPA field masking** runs after — it removes any fields the caller is not authorized to see, regardless of whether the fieldset included them.

If a fieldset's `show` list includes a field that is forbidden by OPA policy, the field masking layer will still remove it. Fieldset definitions have no power to override security policy.

---

## Lookup References: `filter[lookup]`

Resolves `tapp://localhost/{type}/{uuid}` URI references stored in record fields at query time.

### Basic lookup

Resolve a field that holds a reference to another record:

```
GET /entities?filter[lookup][0][prop]=company
```

For each entity, if `company` contains `tapp://localhost/entity/abc123`, EPS resolves `abc123` and replaces the URI with the full entity object in the response.

### Lookup with scope filter

```
GET /entities?filter[lookup][0][prop]=company&filter[lookup][0][scope][where][_kind]=organization
```

### Array field lookup

If a field holds an array of `tapp://` URIs:

```
GET /entities?filter[lookup][0][prop]=tags
```

EPS resolves each URI in the array and returns an array of full objects.

### Nested lookup

```
GET /lists?filter[lookup][0][prop]=entities&filter[lookup][0][scope][lookup][0][prop]=parents
```

### Lookup scope options

| Option | Description |
|:---|:---|
| `scope[where]` | Filter the resolved records |
| `scope[limit]` | Limit resolved records |
| `scope[fields]` | Select fields on resolved records |
| `scope[lookup]` | Nested lookup on resolved records |

> **Type hints in lookup scope** are not auto-injected by the gateway. Add them manually when filtering on custom numeric/boolean fields inside a lookup scope:
> ```
> filter[lookup][0][scope][where][pageCount][lte]=300&filter[lookup][0][scope][where][pageCount][type]=number
> ```

### Gateway alias: `?lookup=`

```
GET /books?lookup=publisherId,authorId
```

Mapped to: `filter[lookup][0][prop]=publisherId&filter[lookup][1][prop]=authorId`

---

## Through Filters (Traversal Metadata)

When querying via traversal (e.g., `/lists/{id}/entities`), filter on the join record's fields using `through`:

```
GET /lists/{id}/entities?filter[where][through][addedBy]=user123
GET /lists/{id}/entities?filter[order][through][addedAt]=DESC
```

This filters on `list-entity-relation` record fields, not on the entity fields.

---

## Querying the Relation Record (List-Entity-Relation)

Access the relation record directly:

```
GET /relations?filter[where][_listId]=list-uuid&filter[where][_entityId]=entity-uuid
GET /relations/{id}
```

Access via traversal (returns entities with join metadata):

```
GET /lists/{id}/entities     ← entities in the list (with _fromMetadata, _toMetadata)
GET /entities/{id}/lists     ← lists containing the entity
```

---

## Query Performance Tips

### Use kind-alias routes instead of `filter[where][_kind]`

On a kind-alias route (e.g., `GET /books`), the gateway automatically injects `filter[where][_kind]=book`. You do not need to add it manually:

```
✓  GET /books?filter[where][author]=Tolstoy
✗  GET /entities?filter[where][_kind]=book&filter[where][author]=Tolstoy   (verbose, same result)
```

### Always specify `filter[limit]`

Without an explicit limit, `APP_RESPONSE_LIMIT_ENTITIES` applies silently. Large unintended result sets can degrade performance and increase costs.

```
GET /books?limit=50&skip=0
```

### Use `/count` for count-only queries

`GET /entities/count?where[_kind]=book` is much faster than fetching all records and counting client-side. The count endpoint returns a single `{"count": N}` object.

```
GET /books/count?where[status]=published
GET /entities/count?where[_kind]=book&where[_visibility]=public
```

### Use `_parentsCount=0` for root-level items

`_parentsCount` is a cached, indexed integer field. Filtering on it to find root-level (top-level, no parent) items is the most efficient approach:

```
GET /entities?filter[where][_parentsCount]=0
```

Equivalent to `sets[roots]=true`.

### Reduce payload size with `fieldset` or `filter[fields]`

For list views, use a fieldset or explicit field projection to avoid fetching large payloads:

```
GET /books?fieldset=bookinfo                ← pre-configured projection
GET /books?fields=_id,_name,author,isbn     ← ad-hoc projection
```

---

## Gateway Query Block (`allowBackendQueryNotation`)

The `app.allowBackendQueryNotation` flag controls whether raw backend `filter[*]` notation is passed through to the EPS or silently dropped.

| `app.allowBackendQueryNotation` | Default | Effect |
|:---|:---:|:---|
| `true` | **yes** | Raw `filter[where][...]`, `filter[limit]`, `filter[order]`, `where[...]`, etc. are passed through unchanged |
| `false` | — | Raw backend parameters are **silently dropped**; clients must use simplified params only |

> **Default is `true`.** The current default allows clients to use raw backend notation. Setting it to `false` enforces a clean API contract: only `?s=`, `?limit=`, `?skip=`, `?order=`, `?fields=`, `?q=` are accepted on kind-alias routes.

### What `PreventStringifiedJsonFilter` blocks

Independently of `allowBackendQueryNotation`, the `PreventStringifiedJsonFilter` **always** blocks the stringified JSON form of the filter:

```
# BLOCKED — stringified JSON filter:
GET /entities?filter={"where":{"_kind":"book"}}

# ALLOWED — key-value bracket notation (subject to allowBackendQueryNotation):
GET /entities?filter[where][_kind]=book
```

These two controls are separate:

| Control | Blocks |
|:---|:---|
| `PreventStringifiedJsonFilter` (always on) | `?filter={"where":...}` JSON string injection |
| `allowBackendQueryNotation=false` | `filter[where][...]`, `filter[limit]`, `filter[order]`, `where[...]`, and all other raw bracket-notation params |

### Recommended setup per environment

```yaml
# production — clean API contract
app:
  allowBackendQueryNotation: false
```

```properties
# development — allow raw notation for debugging
app.allowBackendQueryNotation=true
```

---

## Gateway Query Simplification Summary

| Client sends | Gateway maps to |
|:---|:---|
| `?s=foo` or `?search=foo` | `?filter[where][_name][regexp]=.*foo.*` |
| `?limit=N` | `?filter[limit]=N` |
| `?skip=N` | `?filter[skip]=N` |
| `?order=field DIR` | `?filter[order]=field DIR` |
| `?fields=f1,f2` | `?filter[fields][f1]=true&filter[fields][f2]=true` |
| `?include=r1,r2` | `?filter[include][0][relation]=r1&filter[include][1][relation]=r2` |
| `?lookup=p1,p2` | `?filter[lookup][0][prop]=p1&filter[lookup][1][prop]=p2` |
| `?q=queryName` | _(expands to configured query expression)_ |
| `?fieldset=name` | _(response-phase: keeps/drops fields per definition)_ |

> `?s=` / `?search=` targets the `_name` field only. Full-text search across multiple fields requires a saved query or raw backend notation.
>
> On `count`, `updateAll`, and `deleteAll` routes, `limit=`, `skip=`, `order=`, and `fields=` are **silently dropped** (no equivalent in `where[*]` notation).

---

## Related Documents

- [`10_COMPONENT_entity-persistence-service.md`](./10_COMPONENT_entity-persistence-service.md) — EPS native configuration and behavior
- [`11_COMPONENT_entity-persistence-gateway.md`](./11_COMPONENT_entity-persistence-gateway.md) — Query simplification and fieldset features
- [`20_CONCEPT_data-model.md`](./20_CONCEPT_data-model.md) — Managed fields available for filtering
- [`21_CONCEPT_security-and-authorization.md`](./21_CONCEPT_security-and-authorization.md) — How the gateway injects sets for access control
- [`entity-persistence-gateway/.context/80-FEATURE-QUERY-SIMPLIFICATION.md`](../../entity-persistence-gateway/.context/80-FEATURE-QUERY-SIMPLIFICATION.md) — Full saved-query reference and route coverage
- [`entity-persistence-gateway/.context/85-FEATURE-FIELDSETS.md`](../../entity-persistence-gateway/.context/85-FEATURE-FIELDSETS.md) — Fieldset configuration reference and built-in definitions
- [`entity-persistence-gateway/.context/20-FILTERS.md`](../../entity-persistence-gateway/.context/20-FILTERS.md) — `InjectTypeHintsToQuery`, `ConvertDomainIncludeAliasToGenericRelation`, and all gateway filters
