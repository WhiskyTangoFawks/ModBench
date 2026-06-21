# Phase 13.1 — VMAD Backend Index

**Status: Complete** · Parent: [phase-13](phase-13.md) · Depends on: — · **Model: Sonnet** *(well-specified schema + `SFRecordCompareEngine` reference impl; introduces the shared `VmadJson` serializer reused by 13.2/13.7 — get its shape right)*

*Goal: indexing a plugin populates dedicated DuckDB tables with its VMAD scripts and properties (scalars, scalar-arrays, and structs-as-JSON), and registers Object-property FormKeys in `form_references`. Re-indexing the same plugin does not duplicate rows.*

This subphase is the read-model write side only. Querying it back out is 13.2.

---

## DuckDB Tables

Add to `TableDdlBuilder.CreateTables()` ([Records/TableDdlBuilder.cs](../../MEditService/MEditService.Core/Records/TableDdlBuilder.cs)):

```sql
CREATE TABLE IF NOT EXISTS vmad_scripts (
    form_key     VARCHAR NOT NULL,
    plugin       VARCHAR NOT NULL,
    script_name  VARCHAR NOT NULL,
    script_index INTEGER NOT NULL,   -- order as stored (post-sort)
    flags        VARCHAR NOT NULL,   -- "Local" | "Inherited" | "Removed" | "Inherited and Removed"
    record_type  VARCHAR NOT NULL    -- DuckDB table name, e.g. "npc_"
);

CREATE TABLE IF NOT EXISTS vmad_properties (
    form_key       VARCHAR NOT NULL,
    plugin         VARCHAR NOT NULL,
    script_name    VARCHAR NOT NULL,
    property_name  VARCHAR NOT NULL,
    property_index INTEGER NOT NULL,
    record_type    VARCHAR NOT NULL,
    type           VARCHAR NOT NULL,   -- Mutagen type name: "Object","String","Int","Float","Bool",
                                       --   "ArrayOfObject","ArrayOfString","ArrayOfInt","ArrayOfFloat",
                                       --   "ArrayOfBool","Struct","ArrayOfStruct","Variable","ArrayOfVariable"
    flags          VARCHAR NOT NULL,   -- "" | "Edited" | "Removed"
    -- scalar value columns (one populated, per type; null otherwise)
    bool_value     BOOLEAN,
    int_value      INTEGER,
    float_value    FLOAT,
    string_value   VARCHAR,
    form_key_value VARCHAR,            -- Object: the referenced FormKey
    alias_value    SMALLINT,          -- Object: alias index (-1/None when unset)
    -- complex value column (Struct / ArrayOfStruct): full sub-tree as JSON; null for scalars/scalar-arrays
    struct_json    VARCHAR
);

CREATE TABLE IF NOT EXISTS vmad_property_list_items (
    form_key        VARCHAR NOT NULL,
    plugin          VARCHAR NOT NULL,
    script_name     VARCHAR NOT NULL,
    property_name   VARCHAR NOT NULL,
    property_index  INTEGER NOT NULL,
    list_item_index INTEGER NOT NULL,
    record_type     VARCHAR NOT NULL,
    type            VARCHAR NOT NULL,   -- element scalar type
    bool_value      BOOLEAN,
    int_value       INTEGER,
    float_value     FLOAT,
    string_value    VARCHAR,
    form_key_value  VARCHAR,
    alias_value     SMALLINT
);
```

Indexes on `(form_key, plugin)` for all three tables (mirror the existing index pattern in `TableDdlBuilder`).

**Storage rules (the Key Decision from the parent doc):**
- Scalars (Object/String/Int/Float/Bool) → typed columns on `vmad_properties`.
- Scalar arrays (`ArrayOf{Object,String,Int,Float,Bool}`) → one row per element in `vmad_property_list_items`; the parent row in `vmad_properties` carries `type` and null value columns.
- **Struct / ArrayOfStruct → `struct_json`** on `vmad_properties` (a serialized recursive representation; see DTO shape in 13.2). Do **not** explode struct members into relational rows.
- **Variable / ArrayOfVariable → row exists with `type` set, all value columns null** (display-only placeholder).

---

## Import walk — `DuckDbRecordRepository`

In [Records/DuckDbRecordRepository.cs](../../MEditService/MEditService.Core/Records/DuckDbRecordRepository.cs):

- [ ] At the top of `Index()`, before the per-type loop, delete existing VMAD rows for the plugin: `DeleteVmadForPlugin(plugin)` (three `DELETE FROM ... WHERE plugin = ?`). This is the delete-before-insert pattern that keeps re-index idempotent.
- [ ] After indexing record types, walk all major records implementing `IHaveVirtualMachineAdapterGetter` whose `VirtualMachineAdapter` is non-null. Populate the three tables using a DuckDB appender per table (one appender flush at the end, matching how existing tables are appended).
- [ ] For each `IScriptEntryGetter`: write a `vmad_scripts` row (`Name`, `Flags.ToString()`, index). Scripts are stored already sorted by Mutagen; `script_index` is positional.
- [ ] For each property, dispatch on concrete type (`switch (property)`, mirror `AVirtualMachineAdapterBinaryWriteTranslation.WriteProperty`):
  - `ScriptBoolProperty` → `bool_value`
  - `ScriptIntProperty` → `int_value`
  - `ScriptFloatProperty` → `float_value`
  - `ScriptStringProperty` → `string_value`
  - `ScriptObjectProperty` → `form_key_value = .Object.FormKey.ToString()`, `alias_value = .Alias`
  - `Script*ListProperty` (scalar element) → parent row + one `vmad_property_list_items` row per element
  - `ScriptStructProperty` / `ScriptStructListProperty` → serialize to `struct_json`
  - `ScriptVariableProperty` / `ScriptVariableListProperty` → row with type set, values null
- [ ] **Defensive Variable handling:** wrap the per-*record* VMAD extraction in try/catch. Mutagen's `ParseProperty` throws `NotImplementedException` if a Variable property is present in the binary; in that case log a warning (`_logger.LogWarning`) naming the record FormKey and skip that record's VMAD without aborting the index pass. *(In practice Variable properties never appear in shipped content; this is robustness only.)*

> Note on parse-time throw: a Variable property makes Mutagen throw while *reading the record*, which happens during plugin import — earlier than this walk. Verify where the throw actually surfaces during implementation (record enumeration vs. property access) and place the catch accordingly so one bad record never aborts indexing. Add a regression test only if a Variable-bearing fixture is obtainable; otherwise document the limitation in the Proof.

### form_references (not deferred)

- [ ] For each `ScriptObjectProperty` and each element of a `ScriptObjectListProperty` with a non-null FormKey, insert a `form_references` row so VMAD Object references appear in the Phase 11 "Referenced By" tab. Use the same `form_references` insert path the generic indexer uses for array-of-FormKey fields; `FieldPath` should be a readable VMAD path (e.g. `VMAD\<ScriptName>\<PropertyName>`). Check `DuckDbRecordRepository.Index()` for the existing `form_references` collection point and extend it.

---

## Helper extraction

Keep the walk readable: extract a `VmadIndexer` (or private partial) responsible for turning one record's `IVirtualMachineAdapterGetter` into appender rows. The struct-JSON serializer is shared with 13.2's read assembly — put the JSON DTO shape in `Queries/Models.cs` (defined in 13.2) or a small `Schema/VmadJson.cs` and reuse it on both sides so write and read agree on the serialization.

---

## Tests

Use a real FO4 fixture plugin with a known scripted record (an ACTI or NPC_ with at least one script + a Bool and an Object property). Mirror existing `DuckDbRecordRepositoryTests` setup.

- [ ] Indexing a record with a known script inserts a `vmad_scripts` row with the correct `script_name` and `flags`.
- [ ] A Bool property and an Object property land in `vmad_properties` with the right `type` and the right value column populated (`bool_value`; `form_key_value` + `alias_value`).
- [ ] A scalar-array property (e.g. ArrayOfInt) produces N `vmad_property_list_items` rows in order.
- [ ] A Struct property populates `struct_json` (non-null) and leaves scalar columns null.
- [ ] Indexing the same plugin twice does not double `vmad_scripts` / `vmad_properties` / `vmad_property_list_items` row counts (delete-before-insert).
- [ ] An Object property inserts a `form_references` row pointing at the referenced FormKey.

---

## Proof

```text
Passed!  - Failed: 0, Passed: 586, Skipped: 0, Total: 586, Duration: 2 m 19 s
```

Implementation commit: `ca5fca4`  
Mutation triage commit: `a00c979`  
Merge commit: `36c7f65`

Variable/VariableList NoCoverage accepted: Mutagen throws `NotImplementedException` during binary
parsing for these property types; the switch arms are structurally unreachable through real plugin
data. Documented in commit message.
