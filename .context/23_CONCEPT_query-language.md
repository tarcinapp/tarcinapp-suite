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

### Type Hints

All query string values are strings. For numeric/boolean fields on custom (unmanaged) data, add a type hint:

```
GET /entities?filter[where][pages][gt]=300&filter[where][pages][type]=number
```

Supported types: `number`, `boolean`.

> **Gateway auto-type-conversion**: When calling through the Gateway with Kind Alias routes, the gateway automatically applies type conversion based on the JSON Schema configured for that kind. Type hints are not required in this case.

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

- Include mode: set fields to `true` — only those fields returned
- Exclude mode: set fields to `false` — all fields except those returned

> **`_kind` is always included** regardless of field selection — it is a system constraint.

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

---

## Pagination: `filter[limit]` and `filter[skip]`

```
GET /entities?filter[limit]=20&filter[skip]=40
```

### Gateway aliases: `?limit=` and `?skip=`
```
GET /books?limit=20&skip=40
```

Maximum limit is set by `APP_RESPONSE_LIMIT_ENTITIES` (EPS config). Requests exceeding this are capped.

---

## Related Model Inclusion: `filter[include]`

Eagerly load related records alongside the primary result.

### For Lists
```
GET /lists?filter[include][0][relation]=_entities&filter[include][1][relation]=_reactions
```

### For Entities
```
GET /entities?filter[include][0][relation]=_reactions
```

### With scope
```
GET /lists?filter[include][0][relation]=_entities&filter[include][0][scope][where][_kind]=book&filter[include][0][scope][limit]=5
```

Included records are returned as an additional array field (prefixed with `_`) on each result item.

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

Pre-configured query shortcuts defined in the gateway. Use context variables like `#userId` and `#now`.

```yaml
app:
  queries:
    my: "'sets[owners][userIds]='+#userId"
    actives: "'sets[actives]'"
    by-name: "'filter[where][_slug]='+#query['slug']"
```

Usage:
```
GET /books?q=my             ← my books (owner = caller)
GET /books?q=actives        ← only active books
GET /books?q=by-name&slug=war-and-peace  ← book by slug
```

SPEL expressions are supported for advanced query building.

---

## Field Sets: `?fieldset=`

Pre-configured field selections defined in the gateway. Returns a named subset of fields.

```yaml
app:
  fieldsets:
    bookinfo:
      show: _id, _name, author, isbn, _slug
    managed:
      show: _id, _kind, _name, _slug, _visibility, _version, _ownerUsers, _createdDateTime, ...
    unmanaged:
      hide: _slug, _visibility, _version, _ownerUsers, _ownerGroups, ...
```

Usage:
```
GET /books?fieldset=bookinfo        ← only id, name, author, isbn, slug
GET /books?fieldset=managed         ← only managed (system) fields
GET /books?fieldset=unmanaged       ← only custom (application) fields
```

Available fieldsets are declared in the OAS spec per endpoint. The GUI shows a dropdown only when fieldsets are declared.

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
GET /lists/{id}/entities                     ← entities in the list (with _fromMetadata, _toMetadata)
GET /entities/{id}/lists                     ← lists containing the entity
```

---

## Gateway Query Simplification Summary

| Client sends | Gateway maps to |
|:---|:---|
| `?s=foo` | `?filter[where][_name][regexp]=.*foo.*` |
| `?limit=N` | `?filter[limit]=N` |
| `?skip=N` | `?filter[skip]=N` |
| `?order=field DIR` | `?filter[order]=field DIR` |
| `?fields=f1,f2` | `?filter[fields][f1]=true&filter[fields][f2]=true` |
| `?q=queryName` | _(expands to configured query expression)_ |
| `?fieldset=name` | _(expands to configured field set)_ |

> If `app.allowBackendQueryNotation=false` (default), the backend's native notation is blocked at the gateway and clients must use simplified params only.

---

## Related Documents
- `10_COMPONENT_entity-persistence-service.md` — EPS native configuration and behavior
- `11_COMPONENT_entity-persistence-gateway.md` — Query simplification and fieldset features
- `20_CONCEPT_data-model.md` — Managed fields available for filtering
- `21_CONCEPT_security-and-authorization.md` — How the gateway injects sets for access control
