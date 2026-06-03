using MEditService.Core.Schema;
using Mutagen.Bethesda;

namespace MEditService.Tests.Indexing;

public class SchemaReflectorTests
{
    private readonly ISchemaReflector _reflector = new SchemaReflector();

    [Fact]
    public void GetSchemas_ContainsKnownFallout4RecordTypes()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        Assert.True(schemas.ContainsKey("npc_"));
        Assert.True(schemas.ContainsKey("weap"));
        Assert.True(schemas.ContainsKey("armo"));
    }

    [Fact]
    public void GetSchemas_ExcludesPlacedRecordTypes()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        Assert.False(schemas.ContainsKey("refr"));
        Assert.False(schemas.ContainsKey("achr"));
    }

    [Fact]
    public void GetSchemas_Npc_BoolColumn_MapsToBooleanDuckDbType()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "aggro_radius_behavior_enabled");
        Assert.NotNull(col);
        Assert.Equal("BOOLEAN", col.DuckDbType);
        Assert.Equal("bool", col.ApiType);
    }

    [Fact]
    public void GetSchemas_Npc_EnumColumn_MapsToVarcharWithEnumValues()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "aggression");
        Assert.NotNull(col);
        Assert.Equal("VARCHAR", col.DuckDbType);
        Assert.Equal("enum", col.ApiType);
        Assert.NotEmpty(col.EnumValues);
        Assert.Contains("Unaggressive", col.EnumValues);
    }

    [Fact]
    public void GetSchemas_Npc_FormLinkColumn_MapsToFormKeyTypeWithValidTypes()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "race");
        Assert.NotNull(col);
        Assert.Equal("VARCHAR", col.DuckDbType);
        Assert.Equal("formKey", col.ApiType);
        Assert.Contains("race", col.ValidFormKeyTypes);
    }

    [Fact]
    public void GetSchemas_Npc_FormLinkColumn_HasNullApply()
    {
        // FormLink fields are read-only in the index; Apply must be null so writes are no-ops.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "race");
        Assert.NotNull(col);
        Assert.Null(col.Apply);
    }

    [Fact]
    public void GetSchemas_Npc_StringColumn_MapsToVarcharStringType()
    {
        // EditorID is excluded from RecordColumns (it's a base column), but Name is a translated string.
        // BleedoutOverride is a short/int type. Find a string or translated-string column on NPC.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        // The NPC Name is a TranslatedString — maps to VARCHAR/"string"
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "name");
        Assert.NotNull(col);
        Assert.Equal("VARCHAR", col.DuckDbType);
        Assert.Equal("string", col.ApiType);
    }

    [Fact]
    public void GetSchemas_IsCachedAcrossCalls()
    {
        var first = _reflector.GetSchemas(GameRelease.Fallout4);
        var second = _reflector.GetSchemas(GameRelease.Fallout4);
        Assert.Same(first, second);
    }

    // ── Phase 12: array and struct field types ─────────────────────────────────

    [Fact]
    public void GetSchemas_Npc_Keywords_IsReflectedAsArrayOfFormKeys()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "keywords");
        Assert.NotNull(col);
        Assert.Equal("array", col.ApiType);
        Assert.NotNull(col.ElementType);
        Assert.Equal("formKey", col.ElementType.Type);
        Assert.Contains("kywd", col.ElementType.ValidFormKeyTypes);
    }

    [Fact]
    public void GetSchemas_Npc_Keywords_IsSortable()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "keywords");
        Assert.NotNull(col);
        Assert.NotNull(col.ElementType);
        Assert.True(col.ElementType.IsSortable);
    }

    [Fact]
    public void GetSchemas_Npc_Factions_IsReflectedAsArrayOfStructs()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "factions");
        Assert.NotNull(col);
        Assert.Equal("array", col.ApiType);
        Assert.NotNull(col.ElementType);
        Assert.Equal("struct", col.ElementType.Type);
        var fields = col.ElementType.Fields;
        Assert.NotNull(fields);
        Assert.Contains(fields, f => f.Name == "faction" && f.Type == "formKey");
        Assert.Contains(fields, f => f.Name == "rank" && f.Type == "int");
    }

    [Fact]
    public void GetSchemas_Npc_Keywords_Extract_ReturnsJsonArray()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "keywords");
        Assert.NotNull(col);

        // Build a test NPC with two keywords
        var npc = new Mutagen.Bethesda.Fallout4.Npc(
            Mutagen.Bethesda.Plugins.FormKey.Factory("000001:Fallout4.esm"),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4);
        var kw1 = Mutagen.Bethesda.Plugins.FormKey.Factory("000010:Fallout4.esm");
        var kw2 = Mutagen.Bethesda.Plugins.FormKey.Factory("000020:Fallout4.esm");
        npc.Keywords = [
            new Mutagen.Bethesda.Plugins.FormLink<Mutagen.Bethesda.Fallout4.IKeywordGetter>(kw1),
            new Mutagen.Bethesda.Plugins.FormLink<Mutagen.Bethesda.Fallout4.IKeywordGetter>(kw2),
        ];

        var result = col.Extract(npc);
        Assert.NotNull(result);
        var json = Assert.IsType<string>(result);
        var parsed = System.Text.Json.JsonSerializer.Deserialize<List<string>>(json);
        Assert.NotNull(parsed);
        Assert.Equal(2, parsed.Count);
        Assert.Contains(kw1.ToString(), parsed);
        Assert.Contains(kw2.ToString(), parsed);
    }

    // ── ToSnakeCase ────────────────────────────────────────────────────────────

    [Fact]
    public void ToSnakeCase_WordBoundary_InsertsUnderscore()
    {
        Assert.Equal("aggro_radius", SchemaReflector.ToSnakeCase("AggroRadius"));
    }

    [Fact]
    public void ToSnakeCase_SingleWord_LowercasesOnly()
    {
        Assert.Equal("name", SchemaReflector.ToSnakeCase("Name"));
    }

    [Fact]
    public void ToSnakeCase_MultipleWordBoundaries_AllConverted()
    {
        Assert.Equal("aggro_radius_behavior_enabled", SchemaReflector.ToSnakeCase("AggroRadiusBehaviorEnabled"));
    }

    [Fact]
    public void ToSnakeCase_AlreadyLowercase_Unchanged()
    {
        Assert.Equal("name", SchemaReflector.ToSnakeCase("name"));
    }

    // ── Float column ──────────────────────────────────────────────────────────

    [Fact]
    public void GetSchemas_Npc_FloatColumn_HasFloatDuckDbAndApiType()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "height_min");
        Assert.NotNull(col);
        Assert.Equal("FLOAT", col.DuckDbType);
        Assert.Equal("float", col.ApiType);
    }

    [Fact]
    public void GetSchemas_Npc_FloatColumn_Extract_ReturnsCurrentValue()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "height_min");
        Assert.NotNull(col);

        var npc = new Mutagen.Bethesda.Fallout4.Npc(
            Mutagen.Bethesda.Plugins.FormKey.Factory("000001:Fallout4.esm"),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4);
        npc.HeightMin = 1.5f;

        var result = col.Extract(npc);
        Assert.Equal(1.5f, result);
    }

    [Fact]
    public void GetSchemas_Npc_FloatColumn_Apply_ChangesValue()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "height_min");
        Assert.NotNull(col);
        Assert.NotNull(col.Apply);

        var npc = new Mutagen.Bethesda.Fallout4.Npc(
            Mutagen.Bethesda.Plugins.FormKey.Factory("000001:Fallout4.esm"),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4);
        npc.HeightMin = 1.0f;

        col.Apply(npc, System.Text.Json.JsonDocument.Parse("2.5").RootElement);

        Assert.Equal(2.5f, npc.HeightMin, precision: 3);
    }

    // ── Factions (struct array) extraction ────────────────────────────────────

    [Fact]
    public void GetSchemas_Npc_Factions_Extract_ProducesJsonWithFactionAndRank()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "factions");
        Assert.NotNull(col);

        var npc = new Mutagen.Bethesda.Fallout4.Npc(
            Mutagen.Bethesda.Plugins.FormKey.Factory("000001:Fallout4.esm"),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4);
        var factionKey = Mutagen.Bethesda.Plugins.FormKey.Factory("000002:Fallout4.esm");
        npc.Factions.Add(new Mutagen.Bethesda.Fallout4.RankPlacement
        {
            Faction = new Mutagen.Bethesda.Plugins.FormLink<Mutagen.Bethesda.Fallout4.IFactionGetter>(factionKey),
            Rank = 5,
        });

        var result = col.Extract(npc);
        Assert.NotNull(result);
        var json = Assert.IsType<string>(result);
        var items = System.Text.Json.JsonSerializer.Deserialize<List<Dictionary<string, System.Text.Json.JsonElement>>>(json);
        Assert.NotNull(items);
        Assert.Single(items);
        Assert.Equal(factionKey.ToString(), items[0]["faction"].GetString());
        Assert.Equal(5, items[0]["rank"].GetInt32());
    }

    // ── Array Apply ───────────────────────────────────────────────────────────

    [Fact]
    public void GetSchemas_Npc_Keywords_Apply_ReplacesKeywordList()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "keywords");
        Assert.NotNull(col);
        Assert.NotNull(col.Apply);

        var npc = new Mutagen.Bethesda.Fallout4.Npc(
            Mutagen.Bethesda.Plugins.FormKey.Factory("000001:Fallout4.esm"),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4);
        var kw1 = Mutagen.Bethesda.Plugins.FormKey.Factory("000010:Fallout4.esm");
        var kw2 = Mutagen.Bethesda.Plugins.FormKey.Factory("000020:Fallout4.esm");

        var json = $"[\"{kw1}\",\"{kw2}\"]";
        col.Apply(npc, System.Text.Json.JsonDocument.Parse(json).RootElement);

        Assert.NotNull(npc.Keywords);
        Assert.Equal(2, npc.Keywords!.Count);
        var appliedKeys = npc.Keywords.Select(k => ((Mutagen.Bethesda.Plugins.IFormLinkGetter)k).FormKey).ToList();
        Assert.Contains(kw1, appliedKeys);
        Assert.Contains(kw2, appliedKeys);
    }

    [Fact]
    public void GetSchemas_Npc_Factions_Apply_UpdatesFactionList()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "factions");
        Assert.NotNull(col);
        Assert.NotNull(col.Apply);

        var npc = new Mutagen.Bethesda.Fallout4.Npc(
            Mutagen.Bethesda.Plugins.FormKey.Factory("000001:Fallout4.esm"),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4);
        var factionKey = Mutagen.Bethesda.Plugins.FormKey.Factory("000003:Fallout4.esm");
        var json = $"[{{\"faction\":\"{factionKey}\",\"rank\":7}}]";

        col.Apply(npc, System.Text.Json.JsonDocument.Parse(json).RootElement);

        Assert.Single(npc.Factions);
        Assert.Equal(7, npc.Factions[0].Rank);
        Assert.Equal(factionKey, npc.Factions[0].Faction.FormKey);
    }

    // ── Array Apply: guard and branch coverage ───────────────────────────────

    [Fact]
    public void GetSchemas_Npc_Keywords_Apply_NonArrayJson_IsNoOp()
    {
        // Mutant 901: removes the `if (json.ValueKind != JsonValueKind.Array) return` guard.
        // Passing a non-array JSON must leave the keyword list unchanged.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "keywords");
        Assert.NotNull(col);
        Assert.NotNull(col.Apply);

        var npc = new Mutagen.Bethesda.Fallout4.Npc(
            Mutagen.Bethesda.Plugins.FormKey.Factory("000001:Fallout4.esm"),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4);
        var kw = Mutagen.Bethesda.Plugins.FormKey.Factory("000010:Fallout4.esm");
        npc.Keywords = [new Mutagen.Bethesda.Plugins.FormLink<Mutagen.Bethesda.Fallout4.IKeywordGetter>(kw)];

        // Pass a JSON object (not an array) — Apply must be a no-op.
        col.Apply(npc, System.Text.Json.JsonDocument.Parse("{}").RootElement);

        // Keywords list is unchanged (still has the original entry).
        Assert.NotNull(npc.Keywords);
        Assert.Single(npc.Keywords);
    }

    [Fact]
    public void GetSchemas_Npc_Factions_Apply_NonArrayJson_IsNoOp()
    {
        // Confirms the array-kind guard (line 526) protects the Loqui-list path too.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "factions");
        Assert.NotNull(col);
        Assert.NotNull(col.Apply);

        var npc = new Mutagen.Bethesda.Fallout4.Npc(
            Mutagen.Bethesda.Plugins.FormKey.Factory("000001:Fallout4.esm"),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4);
        var factionKey = Mutagen.Bethesda.Plugins.FormKey.Factory("000003:Fallout4.esm");
        npc.Factions.Add(new Mutagen.Bethesda.Fallout4.RankPlacement
        {
            Faction = new Mutagen.Bethesda.Plugins.FormLink<Mutagen.Bethesda.Fallout4.IFactionGetter>(factionKey),
            Rank = 3,
        });

        // Pass a JSON string (not an array) — Apply must be a no-op.
        col.Apply(npc, System.Text.Json.JsonDocument.Parse("\"not-an-array\"").RootElement);

        // Factions list is unchanged.
        Assert.Single(npc.Factions);
    }

    [Fact]
    public void GetSchemas_Npc_Keywords_Apply_IsLoquiFalse_SetterTypeIsNull()
    {
        // Mutants 909, 911: `capturedIsLoqui && listType.IsGenericType` mutated to always-true
        // or to OR. For a FormLink list (capturedIsLoqui=false), setterType MUST be null so the
        // Loqui-element branch (line 555) is never entered. The keyword Apply uses the FormLink
        // branch (line 545) — if setterType were non-null AND capturedIsLoqui were true (mutation),
        // Activator.CreateInstance would be called with wrong type and produce wrong output.
        // This test verifies that applying one keyword FormKey yields exactly one keyword entry,
        // not zero (which would happen if we fell through to the Loqui branch incorrectly).
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "keywords");
        Assert.NotNull(col);
        Assert.NotNull(col.Apply);

        var npc = new Mutagen.Bethesda.Fallout4.Npc(
            Mutagen.Bethesda.Plugins.FormKey.Factory("000001:Fallout4.esm"),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4);
        var kw = Mutagen.Bethesda.Plugins.FormKey.Factory("ABCDEF:Fallout4.esm");

        col.Apply(npc, System.Text.Json.JsonDocument.Parse($"[\"{kw}\"]").RootElement);

        // Must have exactly one keyword with the correct FormKey.
        Assert.NotNull(npc.Keywords);
        Assert.Single(npc.Keywords);
        var applied = ((Mutagen.Bethesda.Plugins.IFormLinkGetter)npc.Keywords![0]).FormKey;
        Assert.Equal(kw, applied);
    }

    [Fact]
    public void GetSchemas_Npc_Factions_Apply_SubFieldApplyNull_ElementStillAdded()
    {
        // Mutant 927: `if (sf.Apply == null) continue` is removed.
        // If sf.Apply is null for a sub-field, that sub-field should be silently skipped
        // (not crash). The faction rank is an int sub-field whose Apply is non-null;
        // the test verifies that only fields with non-null Apply are written.
        // After Apply, the faction must be in the list (item != null check at line 566 passes).
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "factions");
        Assert.NotNull(col);
        Assert.NotNull(col.Apply);

        var npc = new Mutagen.Bethesda.Fallout4.Npc(
            Mutagen.Bethesda.Plugins.FormKey.Factory("000001:Fallout4.esm"),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4);
        var factionKey = Mutagen.Bethesda.Plugins.FormKey.Factory("000004:Fallout4.esm");
        // Only supply "rank" — omit "faction" (FormLink sub-field) to leave it at its default.
        var json = $"[{{\"rank\":2}}]";

        col.Apply(npc, System.Text.Json.JsonDocument.Parse(json).RootElement);

        // Element must be added even if some sub-fields are absent/default.
        Assert.Single(npc.Factions);
        Assert.Equal(2, npc.Factions[0].Rank);
    }

    // ── Sub-object (struct) column — no Apply ────────────────────────────────

    [Fact]
    public void GetSchemas_Npc_Weight_IsReflectedAsStruct()
    {
        // Confirms that NpcWeight is reflected as a struct-typed column with float sub-fields.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "weight");
        Assert.NotNull(col);
        Assert.Equal("struct", col.ApiType);
        Assert.NotNull(col.SubFields);
        Assert.Contains(col.SubFields!, f => f.Name == "thin" && f.Type == "float");
        Assert.Contains(col.SubFields!, f => f.Name == "muscular" && f.Type == "float");
        Assert.Contains(col.SubFields!, f => f.Name == "fat" && f.Type == "float");
    }

    [Fact]
    public void GetSchemas_Npc_Weight_Apply_IsNull()
    {
        // The Loqui registration SetterType is an interface (INpcWeight), not an instantiable
        // concrete class — so the sub-object Apply closure is never created and Apply is null.
        // This test documents and guards that invariant.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "weight");
        Assert.NotNull(col);
        Assert.Null(col.Apply);
    }

    // ── Enum Apply (GetColumnInfo MakeApply path) ─────────────────────────────

    [Fact]
    public void GetSchemas_Npc_EnumColumn_Apply_ChangesValue()
    {
        // Mutant 873: MakeApply(v => Enum.Parse(...)) in GetColumnInfo.
        // Calling Apply must update the enum property; the mutation replaces Enum.Parse
        // with a null/default-returning variant, which would leave the property unchanged.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "aggression");
        Assert.NotNull(col);
        Assert.NotNull(col.Apply);

        var npc = new Mutagen.Bethesda.Fallout4.Npc(
            Mutagen.Bethesda.Plugins.FormKey.Factory("000001:Fallout4.esm"),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4);
        npc.Aggression = Mutagen.Bethesda.Fallout4.Npc.AggressionType.Unaggressive;

        col.Apply(npc, System.Text.Json.JsonDocument.Parse("\"VeryAggressive\"").RootElement);

        Assert.Equal(Mutagen.Bethesda.Fallout4.Npc.AggressionType.VeryAggressive, npc.Aggression);
    }

    // ── SerializeListItems null element (line 393) ───────────────────────────

    [Fact]
    public void GetSchemas_Npc_Keywords_Extract_WithNullElement_ReturnsNullInJson()
    {
        // Mutants 797, 798: the `if (item == null) { result.Add(null); continue; }` guard in
        // SerializeListItems.  When a list contains a null entry the extractor must include a
        // JSON null for that position instead of crashing.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "keywords");
        Assert.NotNull(col);

        var npc = new Mutagen.Bethesda.Fallout4.Npc(
            Mutagen.Bethesda.Plugins.FormKey.Factory("000001:Fallout4.esm"),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4);

        // Force a null into the keyword list (ExtendedList<T> is a List<T> and accepts nulls).
        var kw = Mutagen.Bethesda.Plugins.FormKey.Factory("000010:Fallout4.esm");
        var kwList = new Noggog.ExtendedList<Mutagen.Bethesda.Plugins.IFormLinkGetter<Mutagen.Bethesda.Fallout4.IKeywordGetter>>();
        kwList.Add(null!);
        kwList.Add(new Mutagen.Bethesda.Plugins.FormLink<Mutagen.Bethesda.Fallout4.IKeywordGetter>(kw));
        npc.Keywords = kwList;

        var result = col.Extract(npc);
        Assert.NotNull(result);
        var json = Assert.IsType<string>(result);
        var parsed = System.Text.Json.JsonSerializer.Deserialize<List<string?>>(json);
        Assert.NotNull(parsed);
        Assert.Equal(2, parsed.Count);
        Assert.Null(parsed[0]);   // null element preserved
        Assert.NotNull(parsed[1]);
    }

    // ── Apply on mismatched record type — property not found (lines 419, 421) ──

    [Fact]
    public void GetSchemas_Npc_ScalarColumn_Apply_OnMismatchedRecordType_IsNoOp()
    {
        // Mutant 818: removes `if (rp == null) return` in MakeApply inside GetColumnInfo.
        // When Apply is called with a record type that does not have the column's property,
        // the property lookup returns null and we must return early without throwing.
        // Without the guard, code would dereference null and throw NullReferenceException.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var aggressionCol = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "aggression");
        Assert.NotNull(aggressionCol);
        Assert.NotNull(aggressionCol.Apply);

        // Use a Weapon record — it has no "Aggression" property.
        var weapon = new Mutagen.Bethesda.Fallout4.Weapon(
            Mutagen.Bethesda.Plugins.FormKey.Factory("000002:Fallout4.esm"),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4);

        // Must not throw; must silently do nothing.
        var ex = Record.Exception(() =>
            aggressionCol.Apply(weapon, System.Text.Json.JsonDocument.Parse("\"VeryAggressive\"").RootElement));
        Assert.Null(ex);
    }

}
