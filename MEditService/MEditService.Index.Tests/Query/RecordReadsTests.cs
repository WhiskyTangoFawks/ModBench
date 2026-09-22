using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Index;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using MEditService.TestSupport.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Index.Tests.Query;

[Collection(TestPluginFixtureCollection.Name)]
public class RecordReadsTests(TestPluginFixture fixture)
{
    private readonly TestPluginFixture _fixture = fixture;
    private static readonly SchemaReflector Reflector = SharedSchemaReflector.Instance;

    private IndexProjector LoadedIndex() => Indexes.Reconciled(_fixture.DataFolder, _fixture.Plugins);

    // --- Search ---

    [Fact]
    public void GetRecords_ByTable_ReturnsAllRecords()
    {
        using var index = LoadedIndex();
        var result = index.RequireReads().Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 100, Offset: 0));
        Assert.Equal(TestPluginFixture.RecordCount, result.Total);
        Assert.Equal(TestPluginFixture.RecordCount, result.Items.Count);
    }

    [Fact]
    public void GetRecords_WithPluginFilter_ReturnsMatchingOnly()
    {
        using var index = LoadedIndex();
        var result = index.RequireReads().Search(new RecordQuery(RecordTypes: ["npc_"], Plugin: TestPluginFixture.PluginName, Limit: 100, Offset: 0));
        Assert.Equal(TestPluginFixture.RecordCount, result.Total);
        Assert.All(result.Items, r => Assert.Equal(TestPluginFixture.PluginName, r.Plugin));
    }

    [Fact]
    public void GetRecords_WithPluginFilter_WrongPlugin_ReturnsEmpty()
    {
        using var index = LoadedIndex();
        var result = index.RequireReads().Search(new RecordQuery(RecordTypes: ["npc_"], Plugin: "NonExistent.esp", Limit: 100, Offset: 0));
        Assert.Equal(0, result.Total);
        Assert.Empty(result.Items);
    }

    [Fact]
    public void GetRecords_WithSearch_FiltersOnEditorId()
    {
        using var index = LoadedIndex();
        var result = index.RequireReads().Search(new RecordQuery(RecordTypes: ["npc_"], Search: "TestNPC01", Limit: 100, Offset: 0));
        Assert.Equal(1, result.Total);
        Assert.Equal("TestNPC01", result.Items[0].EditorId);
    }

    [Fact]
    public void GetRecords_Pagination_RespectsLimitAndOffset()
    {
        using var index = LoadedIndex();
        var reads = index.RequireReads();
        var page1 = reads.Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 1, Offset: 0));
        var page2 = reads.Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 1, Offset: 1));
        Assert.Single(page1.Items);
        Assert.Single(page2.Items);
        Assert.NotEqual(page1.Items[0].FormKey, page2.Items[0].FormKey);
        Assert.Equal(TestPluginFixture.RecordCount, page1.Total);
    }

    // The FormKey picker seeds its QuickPick with the record's own FormKey, which is only coherent
    // if searching by that FormKey resolves it — a search that matches `search` against EditorID
    // only makes a seeded (or pasted) FormKey match nothing.
    [Fact]
    public void GetRecords_SearchByFormKey_ResolvesExactRecord()
    {
        using var index = LoadedIndex();
        var formKey = _fixture.Npc1FormKey.ToString();

        var result = index.RequireReads().Search(new RecordQuery(RecordTypes: ["npc_"], Search: formKey, Limit: 100, Offset: 0));

        Assert.Equal(1, result.Total);
        Assert.Equal(formKey, result.Items[0].FormKey);
    }

    // A FormKey-shaped query is matched case-insensitively against the canonical stored form — the
    // picker seeds from whatever casing a resolved link displays, and the paste-a-FormKey path
    // can't assume the user typed the exact stored case.
    [Fact]
    public void GetRecords_SearchByFormKey_IsCaseInsensitive()
    {
        using var index = LoadedIndex();
        var formKey = _fixture.Npc1FormKey.ToString();

        var result = index.RequireReads().Search(new RecordQuery(RecordTypes: ["npc_"], Search: formKey.ToLowerInvariant(), Limit: 100, Offset: 0));

        Assert.Equal(1, result.Total);
        Assert.Equal(formKey, result.Items[0].FormKey);
    }

    // A search string that merely looks close to a FormKey but doesn't fully parse (too short, bad
    // delimiter, non-hex id) must fall back to the EditorID path, not throw or silently match
    // everything.
    [Fact]
    public void GetRecords_SearchByMalformedFormKeyLikeString_FallsBackToEditorIdMatch_NoResults()
    {
        using var index = LoadedIndex();

        var result = index.RequireReads().Search(new RecordQuery(RecordTypes: ["npc_"], Search: "ZZZZZZ:NotAFormKey.esp", Limit: 100, Offset: 0));

        Assert.Equal(0, result.Total);
    }

    [Fact]
    public void GetRecords_ReturnsSortedByEditorIdAscending()
    {
        using var fixture = new PluginFixtureBuilder("medit-sort-editorid")
            .WithPlugin("SortTest.esp", mod =>
            {
                mod.Npcs.AddNew("Zebra");
                mod.Npcs.AddNew("Apple");
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);

        var result = index.RequireReads().Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 10, Offset: 0));

        Assert.Equal(["Apple", "Zebra"], result.Items.Select(r => r.EditorId));
    }

    // --- GetDocument ---

    [Fact]
    public void GetRecord_WinnerOnly_ReturnsWinner()
    {
        using var index = LoadedIndex();
        var formKey = _fixture.Npc1FormKey.ToString();

        var record = index.RequireReads().GetDocument(formKey);

        Assert.NotNull(record);
        Assert.True(record.IsWinner);
        Assert.Equal(formKey, record.FormKey);
        Assert.NotEmpty(record.Fields);
    }

    [Fact]
    public void GetRecord_ReturnsFieldForEveryColumnInSchema()
    {
        using var index = LoadedIndex();
        var formKey = _fixture.Npc1FormKey.ToString();
        var schema = Reflector.GetSchemas(GameRelease.Fallout4)["npc_"];

        var record = index.RequireReads().GetDocument(formKey);

        Assert.NotNull(record);
        Assert.NotEmpty(schema.RecordColumns);
        var fieldNames = record.Fields.Select(f => f.Metadata.Name).ToHashSet();
        Assert.All(schema.RecordColumns, col => Assert.Contains(col.Name, fieldNames));
    }

    [Fact]
    public void GetRecord_ScalarFormLinkColumn_ReturnsExactStoredValue()
    {
        FormKey npcFormKey = default, raceFormKey = default;
        using var fixture = new PluginFixtureBuilder("medit-columnlist-value")
            .WithPlugin("ColumnValue.esm", mod =>
            {
                raceFormKey = mod.Races.AddNew("TestRace").FormKey;
                var npc = mod.Npcs.AddNew("ColumnValueNPC");
                npcFormKey = npc.FormKey;
                npc.Race = new FormLink<IRaceGetter>(raceFormKey);
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);

        var record = index.RequireReads().GetDocument(npcFormKey.ToString());

        Assert.NotNull(record);
        var raceField = record.Fields.FirstOrDefault(f => f.Metadata.Name == "Race");
        Assert.NotNull(raceField);
        Assert.Equal(raceFormKey.ToString(), Assert.IsType<JsonElement>(raceField.Value).GetString());
    }

    // ADR-0012: two origins holding the same file name under different origin values.
    [Fact]
    public void GetAllOverrides_SameFilenameDifferentOrigin_ReturnsDistinctOriginPerRow()
    {
        FormKey npcFormKey = default;
        using var fixture = new PluginFixtureBuilder("medit-two-origins")
            .WithPlugin("Shared.esp", mod => npcFormKey = mod.Npcs.AddNew("SharedNpc").FormKey, origin: "ModA")
            .WithPlugin("Shared.esp", (mod, built) => mod.Npcs.Set(built[0].Npcs.First().DeepCopy()), origin: "ModB")
            .BuildScattered();
        using var index = Indexes.Reconciled(fixture);

        var formKey = npcFormKey.ToString();
        var overrideStack = index.RequireReads().GetOverrideStack(formKey)
            ?? throw new InvalidOperationException($"Expected an override stack for '{formKey}'.");
        var overrides = overrideStack.Entries;

        Assert.Equal(2, overrides.Count);
        Assert.Contains(overrides, o => o.Plugin.Origin == "ModA");
        Assert.Contains(overrides, o => o.Plugin.Origin == "ModB");
    }

    [Fact]
    public void GetRecord_WithPlugin_ReturnsMatchingPlugin()
    {
        using var index = LoadedIndex();
        var formKey = _fixture.Npc1FormKey.ToString();

        var record = index.RequireReads().GetDocument(formKey, new PluginCopyKey(TestPluginFixture.PluginName, "Data"));

        Assert.NotNull(record);
        Assert.Equal(TestPluginFixture.PluginName, record.Plugin.Name);
        Assert.Equal("TestNPC01", record.EditorId);
    }

    [Fact]
    public void GetRecord_BitmaskField_AboveSafeInteger_SerializesAsDecimalString()
    {
        // 2^53 + 1 — not exactly representable as an IEEE 754 float64.
        // Race.Flag is a [Flags] ulong split across two 32-bit DATA fields, so bit 53 survives binary round-trip.
        const long combined = 9007199254740993;
        FormKey raceFormKey = default;
        using var fixture = new PluginFixtureBuilder("medit-bitmask")
            .WithPlugin("Flags.esp", mod =>
            {
                var race = mod.Races.AddNew("HighBitRace");
                race.Flags = (Race.Flag)(ulong)combined;
                raceFormKey = race.FormKey;
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);

        var record = index.RequireReads().GetDocument(raceFormKey.ToString());

        Assert.NotNull(record);
        var flags = record.Fields.Single(f => f.Metadata.Name == "Flags");
        Assert.Equal("flags", flags.Metadata.Type);
        // The document's own spelling: the contained members by name, whatever their bit.
        var names = Assert.IsType<JsonElement>(flags.Value).EnumerateArray().Select(e => e.GetString()).ToList();
        Assert.Equal([nameof(Race.Flag.Playable), nameof(Race.Flag.LowPriorityPushable)], names);
    }

    [Fact]
    public void GetRecord_UnknownFormKey_ReturnsNull()
    {
        using var index = LoadedIndex();

        var record = index.RequireReads().GetDocument("FFFFFF:Unknown.esp");

        Assert.Null(record);
    }

    private static PluginFixtureData TwoProviders(string prefix, out FormKey sharedNpc)
    {
        FormKey npcKey = default;
        var fixture = new PluginFixtureBuilder(prefix)
            .WithPlugin("PluginA.esm", mod => npcKey = mod.Npcs.AddNew("SharedNPC").FormKey)
            .WithPlugin("PluginB.esp", (mod, built) =>
            {
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("PluginA.esm") });
                mod.Npcs.Set(built[0].Npcs.First().DeepCopy());
            })
            .Build();
        sharedNpc = npcKey;
        return fixture;
    }

    [Fact]
    public void GetRecord_WinnerOnly_True_ReturnsWinnerNotEarlierOverride()
    {
        using var fixture = TwoProviders("medit-winner", out var npcKey);
        using var index = Indexes.Reconciled(fixture);

        var record = index.RequireReads().GetDocument(npcKey.ToString());

        Assert.NotNull(record);
        Assert.True(record.IsWinner);
        Assert.Equal("PluginB.esp", record.Plugin.Name);
    }

    // --- GetOverrideStack ---

    [Fact]
    public void GetAllOverrides_TwoPlugins_OrderedByLoadOrderIndex_WinnerIsHigher()
    {
        using var fixture = TwoProviders("medit-duckdb", out var npcKey);
        using var index = Indexes.Reconciled(fixture);

        var overrideStack = index.RequireReads().GetOverrideStack(npcKey.ToString())
            ?? throw new InvalidOperationException($"Expected an override stack for '{npcKey}'.");
        var overrides = overrideStack.Entries;

        Assert.Equal(2, overrides.Count);
        Assert.Equal(0, overrides[0].LoadOrderIndex);
        Assert.Equal(1, overrides[1].LoadOrderIndex);
        Assert.False(overrides[0].IsWinner);
        Assert.True(overrides[1].IsWinner);
    }

    // --- GetRecordTypeCounts ---

    [Fact]
    public void CountRecordsForPlugin_ReturnsCorrectCount()
    {
        using var index = LoadedIndex();
        var count = index.RequireReads().CountOf(new PluginCopyKey(TestPluginFixture.PluginName, "Data"), "npc_");
        Assert.Equal(TestPluginFixture.RecordCount, count);
    }

    [Fact]
    public void CountRecordsForPlugin_UnknownPlugin_ReturnsZero()
    {
        using var index = LoadedIndex();
        var count = index.RequireReads().CountOf(new PluginCopyKey("NonExistent.esp", "Data"), "npc_");
        Assert.Equal(0, count);
    }

    // --- Type resolution: GetDocument resolves a FormKey's type itself ---

    [Fact]
    public void GetDocument_KnownFormKey_ResolvesRecordType()
    {
        using var index = LoadedIndex();
        var document = index.RequireReads().GetDocument(_fixture.Npc1FormKey.ToString());
        Assert.Equal("npc_", document?.RecordType);
    }

    [Fact]
    public void GetDocument_UnknownFormKey_ReturnsNull()
    {
        using var index = LoadedIndex();
        var document = index.RequireReads().GetDocument("FFFFFF:Unknown.esp");
        Assert.Null(document);
    }

    // --- Resolve (ADR-0005) ---

    [Fact]
    public void ResolveFormKey_KnownFormKey_ReturnsRecordTypeAndEditorId()
    {
        using var index = LoadedIndex();
        var entry = index.RequireReads().Resolve(_fixture.Npc1FormKey.ToString());
        Assert.NotNull(entry);
        Assert.Equal("npc_", entry.Value.RecordType);
        Assert.Equal("TestNPC01", entry.Value.EditorId);
    }

    [Fact]
    public void ResolveFormKey_UnknownFormKey_ReturnsNull()
    {
        using var index = LoadedIndex();
        var entry = index.RequireReads().Resolve("FFFFFF:Unknown.esp");
        Assert.Null(entry);
    }

    // --- Winners ---

    [Fact]
    public void UpdateWinners_SinglePlugin_AllRecordsAreWinners()
    {
        using var index = LoadedIndex();
        var result = index.RequireReads().Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 100, Offset: 0));
        Assert.All(result.Items, r => Assert.True(r.IsWinner));
    }

    // --- Array field deserialization ---

    [Fact]
    public void GetRecord_ArrayField_ValueIsJsonArrayNotString()
    {
        FormKey npcFormKey = default;
        using var fixture = new PluginFixtureBuilder("medit-array")
            .WithPlugin("ArrayTest.esm", mod =>
            {
                var npc = mod.Npcs.AddNew("KeywordedNPC");
                npcFormKey = npc.FormKey;
                npc.Keywords =
                [
                    new FormLink<IKeywordGetter>(FormKey.Factory("000001:ArrayTest.esm")),
                    new FormLink<IKeywordGetter>(FormKey.Factory("000002:ArrayTest.esm")),
                ];
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);

        var record = index.RequireReads().GetDocument(npcFormKey.ToString());

        Assert.NotNull(record);
        var keywordsField = record.Fields.FirstOrDefault(f => f.Metadata.Name == "Keywords");
        Assert.NotNull(keywordsField);
        var element = Assert.IsType<JsonElement>(keywordsField.Value);
        Assert.Equal(JsonValueKind.Array, element.ValueKind);
        Assert.Equal(2, element.GetArrayLength());
    }

    // --- Combined filter ---

    [Fact]
    public void GetRecords_WithPluginAndSearchFilter_AndFiltersApply()
    {
        using var index = LoadedIndex();
        // Non-existent plugin + matching search = 0 results (not "all matching search").
        var result = index.RequireReads().Search(new RecordQuery(RecordTypes: ["npc_"], Plugin: "NonExistent.esp", Search: "TestNPC", Limit: 100, Offset: 0));
        Assert.Equal(0, result.Total);
    }

    [Fact]
    public void SearchRecords_WithPluginFilter_ReturnsMatchingOnly()
    {
        using var fixture = new PluginFixtureBuilder("medit-search")
            .WithPlugin("SearchA.esm", mod => mod.Npcs.AddNew("NPC_A"))
            .WithPlugin("SearchB.esp", mod => mod.Npcs.AddNew("NPC_B"))
            .Build();
        using var index = Indexes.Reconciled(fixture);

        var result = index.RequireReads().Search(new RecordQuery(RecordTypes: ["npc_"], Plugin: "SearchA.esm", Limit: 100, Offset: 0));

        Assert.Equal(1, result.Total);
        Assert.All(result.Items, r => Assert.Equal("SearchA.esm", r.Plugin));
    }

    // --- Null EditorID round-trip ---

    [Fact]
    public void GetRecord_NullEditorId_ReturnsNullEditorId()
    {
        FormKey npcFormKey = default;
        using var fixture = new PluginFixtureBuilder("medit-null-edid")
            .WithPlugin("NullEdId.esm", mod =>
            {
                npcFormKey = mod.GetNextFormKey();
                mod.Npcs.Set(new Npc(npcFormKey, Fallout4Release.Fallout4) { EditorID = null });
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);
        var reads = index.RequireReads();

        var summary = reads.Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 100, Offset: 0)).Items.Single();
        Assert.Null(summary.EditorId);

        var detail = reads.GetDocument(npcFormKey.ToString());
        Assert.NotNull(detail);
        Assert.Null(detail.EditorId);
    }

    // --- Reads before any reconcile ---

    [Fact]
    public void RequireReads_BeforeAnyReconcile_ThrowsNoLoadOrder()
    {
        using var index = Indexes.Open(new LoadOrderHolder());
        Assert.Throws<NoLoadOrderException>(() => index.RequireReads());
    }

    // --- SQL injection (parameterized query contract) ---

    [Fact]
    public void GetDocument_SqlInjectionAttempt_ReturnsNull()
    {
        // Without parameterization "' OR '1'='1" would match every row.
        using var index = LoadedIndex();
        var result = index.RequireReads().GetDocument("' OR '1'='1");
        Assert.Null(result);
    }

    // --- Null scalar field returns C# null, not DBNull ---

    [Fact]
    public void GetRecord_UnsetFormLinkField_ReturnsNull()
    {
        using var index = LoadedIndex();
        var formKey = _fixture.Npc1FormKey.ToString();
        var record = index.RequireReads().GetDocument(formKey);
        Assert.NotNull(record);
        var linkField = record.Fields.FirstOrDefault(f => f.Metadata.Type == "formKey" && f.Value == null);
        Assert.NotNull(linkField); // NPC has unset FormLink fields → null in DuckDB
    }

    // --- CheckError ---

    [Fact]
    public void GetRecord_DanglingKeywordReference_CheckErrorOnKeywordsField()
    {
        FormKey npcFormKey = default;
        using var fixture = new PluginFixtureBuilder("medit-checkerror-dangling")
            .WithPlugin("Dangling.esm", mod =>
            {
                var npc = mod.Npcs.AddNew("DanglingRefNPC");
                npcFormKey = npc.FormKey;
                npc.Keywords = [new FormLink<IKeywordGetter>(FormKey.Factory("FFFFFF:Dangling.esm"))];
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);

        var record = index.RequireReads().GetDocument(npcFormKey.ToString());
        Assert.NotNull(record);
        var keywordsField = record.Fields.FirstOrDefault(f => f.Metadata.Name == "Keywords");
        Assert.NotNull(keywordsField);
        Assert.Equal("[0]: [FFFFFF:Dangling.esm] <Error: Could not be resolved>", keywordsField.CheckError);
    }

    [Fact]
    public void GetRecord_KeywordReferenceResolvesInLoadOrder_CheckErrorIsNull()
    {
        FormKey npcFormKey = default;
        using var fixture = new PluginFixtureBuilder("medit-checkerror-clean")
            .WithPlugin("Clean.esm", mod =>
            {
                var keyword = mod.Keywords.AddNew("TestKeyword");
                var npc = mod.Npcs.AddNew("CleanRefNPC");
                npcFormKey = npc.FormKey;
                npc.Keywords = [new FormLink<IKeywordGetter>(keyword.FormKey)];
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);

        var record = index.RequireReads().GetDocument(npcFormKey.ToString());
        Assert.NotNull(record);
        var keywordsField = record.Fields.FirstOrDefault(f => f.Metadata.Name == "Keywords");
        Assert.NotNull(keywordsField);
        Assert.Null(keywordsField.CheckError);
    }

    [Fact]
    public void GetAllOverrides_SharedKeywordRef_CheckErrorConsistentAcrossOverrides()
    {
        FormKey npcFormKey = default;
        using var fixture = new PluginFixtureBuilder("medit-checkerror-shared")
            .WithPlugin("Base.esm", mod =>
            {
                var keyword = mod.Keywords.AddNew("SharedKw");
                var npc = mod.Npcs.AddNew("SharedNPC");
                npcFormKey = npc.FormKey;
                npc.Keywords = [new FormLink<IKeywordGetter>(keyword.FormKey)];
            })
            .WithPlugin("Patch.esp", (mod, built) =>
            {
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Base.esm") });
                mod.Npcs.Set(built[0].Npcs.First().DeepCopy());
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);

        var overrideStack = index.RequireReads().GetOverrideStack(npcFormKey.ToString())
            ?? throw new InvalidOperationException($"Expected an override stack for '{npcFormKey}'.");
        var overrides = overrideStack.Entries;

        Assert.Equal(2, overrides.Count);
        var baseKw = overrides[0].Effective.Fields.FirstOrDefault(f => f.Metadata.Name == "Keywords");
        var patchKw = overrides[1].Effective.Fields.FirstOrDefault(f => f.Metadata.Name == "Keywords");
        Assert.NotNull(baseKw);
        Assert.NotNull(patchKw);
        Assert.Null(baseKw.CheckError);
        Assert.Null(patchKw.CheckError);
    }

    // editor_id alone is not a unique ordering: several NPCs share "Dup" and two share a blank
    // EditorID, ordinary in real plugin data, so an ORDER BY with no tiebreak lets DuckDB place tied
    // rows either side of a LIMIT boundary.
    [Fact]
    public void Search_PagesRecordsWithSharedAndBlankEditorId_ReturnsEveryRowExactlyOnceAndStably()
    {
        using var fixture = new PluginFixtureBuilder("medit-dup-edid")
            .WithPlugin("DupEditorId.esp", mod =>
            {
                mod.Npcs.AddNew("Dup");
                mod.Npcs.AddNew("Dup");
                mod.Npcs.AddNew("Dup");
                mod.Npcs.AddNew(); // blank EditorID
                mod.Npcs.AddNew(); // blank EditorID
                mod.Npcs.AddNew("UniqueA");
                mod.Npcs.AddNew("UniqueB");
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);
        var reads = index.RequireReads();

        var full = reads.Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 100, Offset: 0));
        Assert.Equal(7, full.Total);
        var expected = full.Items.Select(i => i.FormKey).ToList();

        List<string> WalkAllPages()
        {
            var seen = new List<string>();
            for (var offset = 0; offset < full.Total; offset += 2)
            {
                var page = reads.Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 2, Offset: offset));
                seen.AddRange(page.Items.Select(i => i.FormKey));
            }
            return seen;
        }

        var firstWalk = WalkAllPages();
        var secondWalk = WalkAllPages();

        Assert.Equal(expected, firstWalk);
        Assert.Equal(firstWalk, secondWalk);
    }
}
