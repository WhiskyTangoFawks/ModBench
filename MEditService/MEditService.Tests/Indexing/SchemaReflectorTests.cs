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

    // ── IsFormLink requires both IsInterface AND IsGenericType (mutant 599) ─────

    [Fact]
    public void GetSchemas_Npc_Weight_IsStructNotFormkey()
    {
        // INpcWeightGetter is a non-generic interface. With the IsFormLink && → || mutant,
        // IsInterface=true alone would classify it as a formkey column.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "weight");
        Assert.NotNull(col);
        Assert.Equal("struct", col.ApiType);
    }

    // ── Null list returns null from Extract (mutant 894) ──────────────────────

    [Fact]
    public void GetSchemas_Npc_Keywords_Extract_ReturnsNullWhenKeywordsNotSet()
    {
        // A freshly created NPC has Keywords = null. The extractor should return null,
        // not call SerializeListItems on a null IEnumerable.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "keywords");
        Assert.NotNull(col);

        var npc = new Mutagen.Bethesda.Fallout4.Npc(
            Mutagen.Bethesda.Plugins.FormKey.Factory("000001:Fallout4.esm"),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4);

        var result = col.Extract(npc);
        Assert.Null(result);
    }

    // ── Loqui scalar Apply: applies JSON object to struct sub-field ───────────────

    [Fact]
    public void GetSchemas_Npc_Weight_Apply_UpdatesSubFields()
    {
        // The weight column holds INpcWeightGetter (a Loqui scalar). Apply should
        // deserialise a JSON object and write each primitive sub-field back via
        // the sub-field Apply delegates (loqui scalar Apply path, lines ~582-597).
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "weight");
        Assert.NotNull(col);
        Assert.NotNull(col.Apply);

        var npc = new Mutagen.Bethesda.Fallout4.Npc(
            Mutagen.Bethesda.Plugins.FormKey.Factory("000001:Fallout4.esm"),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4);

        var json = """{"thin":0.5,"fat":0.8,"muscular":0.3}""";
        col.Apply(npc, System.Text.Json.JsonDocument.Parse(json).RootElement);

        Assert.NotNull(npc.Weight);
        Assert.Equal(0.5f, npc.Weight!.Thin, precision: 3);
        Assert.Equal(0.8f, npc.Weight.Fat, precision: 3);
        Assert.Equal(0.3f, npc.Weight.Muscular, precision: 3);
    }

    // ── ulong column: TryMapPrimitive BIGINT path (mutant 296/297) ───────────────

    [Fact]
    public void GetSchemas_ImageSpaceAdapter_UInt64Column_MapsToBigInt()
    {
        // IImageSpaceAdapterGetter has a UInt64 Unknown field — exercises the ulong branch
        // in TryMapPrimitive (maps to BIGINT / "int").
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["imad"].RecordColumns.FirstOrDefault(c => c.Name == "unknown");
        Assert.NotNull(col);
        Assert.Equal("BIGINT", col.DuckDbType);
        Assert.Equal("int", col.ApiType);
    }

    // ── Primitive type parity: GetColumnInfo and GetSubFieldInfo cover the same types ──
    // For each primitive api-type, verify that a top-level column of that type exists (GetColumnInfo
    // handled it) AND a sub-field of that same type exists in a struct/array-element column
    // (GetSubFieldInfo handled it).  A refactor that drops a type from one chain but not the other
    // will fail the sub-field assertion.
    //
    // float: height_min (top) / npc_ weight.thin (sub)
    // int:   xp_value_offset (top) / npc_ factions[].rank (sub, sbyte -> int)
    // formKey: race (top) / npc_ factions[].faction (sub)
    // enum:  aggression (top) / npc_ face_tinting_layers[].data_type (sub)
    // bool:  aggro_radius_behavior_enabled (top) — no bool sub-field found in npc_ structs; bool
    //        parity is asserted by confirming the DuckDbType for the top-level column.

    [Theory]
    [InlineData("height_min", "float", "FLOAT", "weight", false, "thin")]
    [InlineData("xp_value_offset", "int", "INTEGER", "factions", true, "rank")]
    [InlineData("race", "formKey", "VARCHAR", "factions", true, "faction")]
    [InlineData("aggression", "enum", "VARCHAR", "face_tinting_layers", true, "data_type")]
    public void GetSchemas_PrimitiveType_ColumnAndSubFieldBothReflected(
        string topLevelColumnName,
        string expectedApiType,
        string expectedDuckDbType,
        string structOrArrayColumn,
        bool isArray,
        string subFieldName)
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var npc = schemas["npc_"];

        var topCol = npc.RecordColumns.FirstOrDefault(c => c.Name == topLevelColumnName);
        Assert.NotNull(topCol);
        Assert.Equal(expectedApiType, topCol!.ApiType);
        Assert.Equal(expectedDuckDbType, topCol.DuckDbType);

        var structCol = npc.RecordColumns.FirstOrDefault(c => c.Name == structOrArrayColumn);
        Assert.NotNull(structCol);

        IReadOnlyList<MEditService.Core.Queries.FieldMetadata>? subFields = isArray
            ? structCol!.ElementType?.Fields
            : structCol!.SubFields;

        Assert.NotNull(subFields);
        var subField = subFields!.FirstOrDefault(f => f.Name == subFieldName);
        Assert.NotNull(subField);
        Assert.Equal(expectedApiType, subField!.Type);
    }

}
