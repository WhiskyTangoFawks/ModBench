using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Index.Queries;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Index.Tests.Query;

[Collection(TestPluginFixtureCollection.Name)]
public class RecordReadsTests(TestPluginFixture fixture)
{
    private static readonly PluginAddress Plugin = new(TestPluginFixture.PluginName, PluginOrigin.DataDirectory);
    private static readonly PluginAddress UnknownPlugin = new("NonExistent.esp", PluginOrigin.DataDirectory);
    private static readonly SchemaReflector Reflector = SharedSchemaReflector.Instance;

    private readonly TestPluginFixture _fixture = fixture;

    private OpenedIndex LoadedIndex() => Indexes.Reconciled(_fixture.DataFolder, _fixture.Plugins);

    [Fact]
    public void ATypeListing_ReturnsEveryRecordOfTheType()
    {
        using var index = LoadedIndex();
        var result = index.Records.GetRecords(["npc_"], plugin: null, search: null, limit: 100, offset: 0).Value();
        Assert.Equal(TestPluginFixture.RecordCount, result.Total);
        Assert.Equal(TestPluginFixture.RecordCount, result.Items.Count);
    }

    [Fact]
    public void APluginFilter_ListsOnlyThatPluginsRecords()
    {
        using var index = LoadedIndex();
        var result = index.Records.GetRecords(["npc_"], Plugin, search: null, limit: 100, offset: 0).Value();
        Assert.Equal(TestPluginFixture.RecordCount, result.Total);
        Assert.All(result.Items, r => Assert.Equal(TestPluginFixture.PluginName, r.Plugin));
    }

    [Fact]
    public void APluginFilter_NamingAnUnknownPlugin_ListsNothing()
    {
        using var index = LoadedIndex();
        var result = index.Records.GetRecords(["npc_"], UnknownPlugin, search: null, limit: 100, offset: 0).Value();
        Assert.Equal(0, result.Total);
        Assert.Empty(result.Items);
    }

    [Fact]
    public void ASearch_MatchesTheEditorId()
    {
        using var index = LoadedIndex();
        var result = index.Records.GetRecords(["npc_"], plugin: null, search: "TestNPC01", limit: 100, offset: 0).Value();
        Assert.Equal(1, result.Total);
        Assert.Equal("TestNPC01", result.Items[0].EditorId);
    }

    [Fact]
    public void ASearchByFormId_AlsoOffersTheRecordsWhoseEditorIdHoldsItsText()
    {
        using var fixture = new PluginFixtureBuilder("medit-search-formid-text")
            .WithPlugin("Ids.esp", mod =>
            {
                mod.Npcs.AddNew("AtThatFormId");
                mod.Npcs.AddNew("Names00000800");
                mod.Npcs.AddNew("Unrelated");
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);

        var result = index.Records.GetRecords(["npc_"], plugin: null, search: "00000800", limit: 100, offset: 0).Value();

        Assert.Equal(["AtThatFormId", "Names00000800"], result.Items.Select(r => r.EditorId));
        Assert.Equal(2, result.Total);
    }

    [Theory]
    [InlineData("Gun_", "Gun_Rifle")]
    [InlineData("%", "Full%Auto")]
    [InlineData("\\", "Back\\Slash")]
    public void ASearch_MatchesItsTextLiterally(string search, string found)
    {
        using var fixture = new PluginFixtureBuilder("medit-search-literal")
            .WithPlugin("Literal.esp", mod =>
            {
                foreach (var editorId in new[] { "Gun_Rifle", "GunXRifle", "Full%Auto", "Back\\Slash" })
                    mod.Npcs.AddNew(editorId);
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);

        var result = index.Records.GetRecords(["npc_"], plugin: null, search: search, limit: 10, offset: 0).Value();

        Assert.Equal([found], result.Items.Select(r => r.EditorId));
    }

    [Fact]
    public void APage_RespectsLimitAndOffset()
    {
        using var index = LoadedIndex();
        var page1 = index.Records.GetRecords(["npc_"], plugin: null, search: null, limit: 1, offset: 0).Value();
        var page2 = index.Records.GetRecords(["npc_"], plugin: null, search: null, limit: 1, offset: 1).Value();
        Assert.Single(page1.Items);
        Assert.Single(page2.Items);
        Assert.NotEqual(page1.Items[0].FormKey, page2.Items[0].FormKey);
        Assert.Equal(TestPluginFixture.RecordCount, page1.Total);
    }

    [Fact]
    public void ASearchByFormKey_FindsThatRecord()
    {
        using var index = LoadedIndex();
        var formKey = _fixture.Npc1FormKey.ToString();

        var result = index.Records.GetRecords(["npc_"], plugin: null, search: formKey, limit: 100, offset: 0).Value();

        Assert.Equal(1, result.Total);
        Assert.Equal(formKey, result.Items[0].FormKey);
    }

    [Fact]
    public void ASearchByFormKey_IgnoresCase()
    {
        using var index = LoadedIndex();
        var formKey = _fixture.Npc1FormKey.ToString();

        var result = index.Records.GetRecords(["npc_"], plugin: null, search: formKey.ToLowerInvariant(), limit: 100, offset: 0).Value();

        Assert.Equal(1, result.Total);
        Assert.Equal(formKey, result.Items[0].FormKey);
    }

    [Fact]
    public void ASearchByAMalformedFormKey_FallsBackToEditorIdMatch_FindingNothing()
    {
        using var index = LoadedIndex();

        var result = index.Records.GetRecords(["npc_"], plugin: null, search: "ZZZZZZ:NotAFormKey.esp", limit: 100, offset: 0).Value();

        Assert.Equal(0, result.Total);
    }

    private static PluginFixtureData ZebraBeforeApple() =>
        new PluginFixtureBuilder("medit-sort")
            .WithPlugin("SortTest.esp", mod =>
            {
                mod.Npcs.AddNew("Zebra");
                mod.Npcs.AddNew("Apple");
            })
            .Build();

    [Fact]
    public void AListing_IsInFormIdOrder()
    {
        using var fixture = ZebraBeforeApple();
        using var index = Indexes.Reconciled(fixture);

        var result = index.Records.GetRecords(["npc_"], plugin: null, search: null, limit: 10, offset: 0).Value();

        Assert.Equal(["Zebra", "Apple"], result.Items.Select(r => r.EditorId));
    }

    [Fact]
    public void AListing_OrdersARecordWhoseMasterIsNamedInAnotherCase_ByThatMastersPosition()
    {
        using var fixture = new PluginFixtureBuilder("medit-sort-cased-master")
            .WithPlugin("Master.esm", mod => mod.Npcs.AddNew("Mastered"))
            .WithPlugin("Later.esp", mod =>
            {
                mod.Npcs.AddNew("Own");
                mod.Npcs.Set(new Npc(new FormKey(ModKey.FromFileName("MASTER.ESM"), 0x800), Fallout4Release.Fallout4) { EditorID = "Overridden" });
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);

        var result = index.Records.GetRecords(
            ["npc_"], new PluginAddress("Later.esp", PluginOrigin.DataDirectory), search: null, limit: 10, offset: 0).Value();

        Assert.Equal(["Overridden", "Own"], result.Items.Select(r => r.EditorId));
    }

    [Fact]
    public void ASearchTermsMatches_AreInEditorIdOrder()
    {
        using var fixture = ZebraBeforeApple();
        using var index = Indexes.Reconciled(fixture);

        var result = index.Records.GetRecords(["npc_"], plugin: null, search: "e", limit: 10, offset: 0).Value();

        Assert.Equal(["Apple", "Zebra"], result.Items.Select(r => r.EditorId));
    }

    [Fact]
    public void AFormKeyAlone_ReadsTheWinningDocument()
    {
        using var index = LoadedIndex();
        var formKey = _fixture.Npc1FormKey.ToString();

        var record = index.Records.GetRecord(formKey).Value();

        Assert.NotNull(record);
        Assert.True(record.IsWinner);
        Assert.Equal(formKey, record.FormKey);
        Assert.NotEmpty(record.Fields);
    }

    [Fact]
    public void ADocument_HasAFieldForEveryColumnInItsSchema()
    {
        using var index = LoadedIndex();
        var formKey = _fixture.Npc1FormKey.ToString();
        var schema = Reflector.GetSchemas(GameRelease.Fallout4)["npc_"];

        var record = index.Records.GetRecord(formKey).Value();

        Assert.NotNull(record);
        Assert.NotEmpty(schema.RecordColumns);
        var fieldNames = record.Fields.Select(f => f.Metadata.Name).ToHashSet();
        Assert.All(schema.RecordColumns, col => Assert.Contains(col.Name, fieldNames));
    }

    [Fact]
    public void AFormLinkField_ReadsItsExactFormKey()
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

        var record = index.Records.GetRecord(npcFormKey.ToString()).Value();

        Assert.NotNull(record);
        var raceField = record.Fields.FirstOrDefault(f => f.Metadata.Name == "Race");
        Assert.NotNull(raceField);
        Assert.Equal(raceFormKey.ToString(), Assert.IsType<JsonElement>(raceField.Value).GetString());
    }

    [Fact]
    public void AnOverrideStack_OfAFilenameInTwoOrigins_HoldsOnlyTheWinningOrigin()
    {
        FormKey npcFormKey = default;
        using var fixture = new PluginFixtureBuilder("medit-two-origins")
            .WithPlugin("Shared.esp", mod => npcFormKey = mod.Npcs.AddNew("SharedNpc").FormKey, origin: "ModA")
            .WithPlugin("Shared.esp", (mod, built) => mod.Npcs.Set(built[0].Npcs.First().DeepCopy()), origin: "ModB")
            .BuildScattered();
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder);

        foreach (var winner in new[] { "ModA", "ModB" })
        {
            var stack = index.WithWinner(holder, fixture.GameDirectory, fixture.Plugins, winner).StackOf(npcFormKey.ToString());
            Assert.Equal(winner, Assert.Single(stack).Origin);
        }
    }

    [Fact]
    public void APluginAddress_ReadsThatPluginsDocument()
    {
        using var index = LoadedIndex();
        var formKey = _fixture.Npc1FormKey.ToString();

        var record = index.CopyIn(formKey, Plugin);

        Assert.NotNull(record);
        Assert.Equal(TestPluginFixture.PluginName, record.Plugin);
        Assert.Equal("TestNPC01", record.EditorId);
    }

    [Fact]
    public void ABitmaskAboveTheSafeInteger_SerializesAsMemberNames()
    {
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

        var record = index.Records.GetRecord(raceFormKey.ToString()).Value();

        Assert.NotNull(record);
        var flags = record.Fields.Single(f => f.Metadata.Name == "Flags");
        Assert.Equal("flags", flags.Metadata.Type);
        var names = Assert.IsType<JsonElement>(flags.Value).EnumerateArray().Select(e => e.GetString()).ToList();
        Assert.Equal([nameof(Race.Flag.Playable), nameof(Race.Flag.LowPriorityPushable)], names);
    }

    [Fact]
    public void AFormKeyInNoPlugin_ReadsNoDocument()
    {
        using var index = LoadedIndex();

        var record = index.Records.GetRecord("FFFFFF:Unknown.esp").Value();

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
    public void TheLaterProvider_IsTheWinningDocument()
    {
        using var fixture = TwoProviders("medit-winner", out var npcKey);
        using var index = Indexes.Reconciled(fixture);

        var record = index.Records.GetRecord(npcKey.ToString()).Value();

        Assert.NotNull(record);
        Assert.True(record.IsWinner);
        Assert.Equal("PluginB.esp", record.Plugin);
    }

    [Fact]
    public void TheOverrideStack_IsOrderedByLoadOrderIndex_WithTheLaterPluginTheWinner()
    {
        using var fixture = TwoProviders("medit-duckdb", out var npcKey);
        using var index = Indexes.Reconciled(fixture);

        var overrides = index.StackOf(npcKey.ToString());

        Assert.Equal(2, overrides.Count);
        Assert.Equal(0, overrides[0].LoadOrderIndex);
        Assert.Equal(1, overrides[1].LoadOrderIndex);
        Assert.False(overrides[0].IsWinner);
        Assert.True(overrides[1].IsWinner);
    }

    [Fact]
    public void ACountOfAPluginsType_IsItsRecordCount()
    {
        using var index = LoadedIndex();
        var count = index.CountOf(Plugin, "npc_");
        Assert.Equal(TestPluginFixture.RecordCount, count);
    }

    [Fact]
    public void ACountOfAnUnknownPlugin_IsZero()
    {
        using var index = LoadedIndex();
        var count = index.CountOf(UnknownPlugin, "npc_");
        Assert.Equal(0, count);
    }

    [Fact]
    public void AKnownFormKey_ReadsItsRecordType()
    {
        using var index = LoadedIndex();
        var document = index.Records.GetRecord(_fixture.Npc1FormKey.ToString()).Value();
        Assert.Equal("npc_", document?.RecordType);
    }

    [Fact]
    public void AKnownFormKey_ResolvesToItsRecordTypeAndEditorId()
    {
        using var index = LoadedIndex();
        var npc1 = _fixture.Npc1FormKey.ToString();

        var link = index.ResolutionOf(npc1, Plugin, npc1);

        Assert.Equal("npc_", link.RecordType);
        Assert.Equal("TestNPC01", link.EditorId);
    }

    [Fact]
    public void AnUnknownFormKey_ResolvesToNothing()
    {
        using var index = LoadedIndex();
        var link = index.ResolutionOf(_fixture.Npc1FormKey.ToString(), Plugin, "FFFFFF:Unknown.esp");

        Assert.Equal(new FormKeyResolution(FormKeyResolutionState.Unresolved, null, null), link);
    }

    [Fact]
    public void ALoneProvidersListing_MarksEveryRecordAWinner()
    {
        using var index = LoadedIndex();
        var result = index.Records.GetRecords(["npc_"], plugin: null, search: null, limit: 100, offset: 0).Value();
        Assert.All(result.Items, r => Assert.True(r.IsWinner));
    }

    [Fact]
    public void AnArrayField_ReadsAsAJsonArray()
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

        var record = index.Records.GetRecord(npcFormKey.ToString()).Value();

        Assert.NotNull(record);
        var keywordsField = record.Fields.FirstOrDefault(f => f.Metadata.Name == "Keywords");
        Assert.NotNull(keywordsField);
        var element = Assert.IsType<JsonElement>(keywordsField.Value);
        Assert.Equal(JsonValueKind.Array, element.ValueKind);
        Assert.Equal(2, element.GetArrayLength());
    }

    [Fact]
    public void APluginFilterNamingAnUnknownPlugin_FindsNothingEvenWhenTheSearchMatches()
    {
        using var index = LoadedIndex();
        var result = index.Records.GetRecords(["npc_"], UnknownPlugin, search: "TestNPC", limit: 100, offset: 0).Value();
        Assert.Equal(0, result.Total);
    }

    [Fact]
    public void APluginFilter_ExcludesTheOtherPluginsRecords()
    {
        using var fixture = new PluginFixtureBuilder("medit-search")
            .WithPlugin("SearchA.esm", mod => mod.Npcs.AddNew("NPC_A"))
            .WithPlugin("SearchB.esp", mod => mod.Npcs.AddNew("NPC_B"))
            .Build();
        using var index = Indexes.Reconciled(fixture);

        var result = index.Records.GetRecords(["npc_"], new PluginAddress("SearchA.esm", PluginOrigin.DataDirectory), search: null, limit: 100, offset: 0).Value();

        Assert.Equal(1, result.Total);
        Assert.All(result.Items, r => Assert.Equal("SearchA.esm", r.Plugin));
    }

    [Fact]
    public void ARecordWithoutAnEditorId_ReadsANullEditorId()
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

        var summary = index.Records.GetRecords(["npc_"], plugin: null, search: null, limit: 100, offset: 0).Value().Items.Single();
        Assert.Null(summary.EditorId);

        var detail = index.Records.GetRecord(npcFormKey.ToString()).Value();
        Assert.NotNull(detail);
        Assert.Null(detail.EditorId);
    }

    [Fact]
    public void ReadsBeforeAnyReconcile_ThrowNoLoadOrder()
    {
        using var index = Indexes.Open(new LoadOrderHolder());
        Assert.Equal(IndexRefusal.NoLoadOrder, index.Records.GetRecord(_fixture.Npc1FormKey.ToString()).Refused().Refusal);
    }

    [Fact]
    public void AFormKeyOfSqlText_ReadsNoDocument()
    {
        using var index = LoadedIndex();
        var result = index.Records.GetRecord("' OR '1'='1").Value();
        Assert.Null(result);
    }

    [Fact]
    public void AnUnsetFormLinkField_ReadsNull()
    {
        using var index = LoadedIndex();
        var formKey = _fixture.Npc1FormKey.ToString();
        var record = index.Records.GetRecord(formKey).Value();
        Assert.NotNull(record);
        var linkField = record.Fields.FirstOrDefault(f => f.Metadata.Type == "formKey" && f.Value == null);
        Assert.NotNull(linkField);
    }

    [Fact]
    public void ADanglingKeywordReference_FlagsCheckErrorOnTheKeywordsField()
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

        var record = index.Records.GetRecord(npcFormKey.ToString()).Value();
        Assert.NotNull(record);
        var keywordsField = record.Fields.FirstOrDefault(f => f.Metadata.Name == "Keywords");
        Assert.NotNull(keywordsField);
        Assert.Equal("[0]: [FFFFFF:Dangling.esm] <Error: Could not be resolved>", keywordsField.CheckError);
    }

    [Fact]
    public void AKeywordReferenceResolvingInTheLoadOrder_HasNoCheckError()
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

        var record = index.Records.GetRecord(npcFormKey.ToString()).Value();
        Assert.NotNull(record);
        var keywordsField = record.Fields.FirstOrDefault(f => f.Metadata.Name == "Keywords");
        Assert.NotNull(keywordsField);
        Assert.Null(keywordsField.CheckError);
    }

    [Fact]
    public void ASharedKeywordReference_HasNoCheckErrorInAnyOverride()
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

        var overrides = index.StackOf(npcFormKey.ToString());

        Assert.Equal(2, overrides.Count);
        var baseKw = overrides[0].Fields.FirstOrDefault(f => f.Metadata.Name == "Keywords");
        var patchKw = overrides[1].Fields.FirstOrDefault(f => f.Metadata.Name == "Keywords");
        Assert.NotNull(baseKw);
        Assert.NotNull(patchKw);
        Assert.Null(baseKw.CheckError);
        Assert.Null(patchKw.CheckError);
    }

    [Fact]
    public void Search_PagesRecordsWithSharedAndBlankEditorId_ReturnsEveryRowExactlyOnceAndStably()
    {
        using var fixture = new PluginFixtureBuilder("medit-dup-edid")
            .WithPlugin("DupEditorId.esp", mod =>
            {
                mod.Npcs.AddNew("Dup");
                mod.Npcs.AddNew("Dup");
                mod.Npcs.AddNew("Dup");
                mod.Npcs.AddNew();
                mod.Npcs.AddNew();
                mod.Npcs.AddNew("UniqueA");
                mod.Npcs.AddNew("UniqueB");
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);

        var full = index.Records.GetRecords(["npc_"], plugin: null, search: null, limit: 100, offset: 0).Value();
        Assert.Equal(7, full.Total);
        var expected = full.Items.Select(i => i.FormKey).ToList();

        List<string> WalkAllPages()
        {
            var seen = new List<string>();
            for (var offset = 0; offset < full.Total; offset += 2)
            {
                var page = index.Records.GetRecords(["npc_"], plugin: null, search: null, limit: 2, offset: offset).Value();
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
