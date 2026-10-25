using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.LoadOrder;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.RecordIndex.Tests.Query;

[Collection(TestPluginFixtureCollection.Name)]
public class RecordReadsTests(TestPluginFixture fixture)
{
    private static readonly PluginAddress Plugin = new(TestPluginFixture.PluginName, PluginOrigin.DataDirectory);
    private static readonly PluginAddress UnknownPlugin = new("NonExistent.esp", PluginOrigin.DataDirectory);
    private static readonly SchemaReflector Reflector = SharedSchemaReflector.Instance;

    private readonly TestPluginFixture _fixture = fixture;

    private OpenedIndex LoadedIndex() => Indexes.Reconciled(_fixture.DataFolder, _fixture.Plugins);

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

        var result = index.Queries.GetRecords(["npc_"], plugin: null, search: "00000800", limit: 100, offset: 0).Value();

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

        var result = index.Queries.GetRecords(["npc_"], plugin: null, search: search, limit: 10, offset: 0).Value();

        Assert.Equal([found], result.Items.Select(r => r.EditorId));
    }

    [Theory]
    [InlineData("000800:TestPlugin.esp")]
    [InlineData("000800:testplugin.esp")]
    public void ASearchByFormKey_FindsThatRecord_IgnoringCase_AcrossTypes(string search)
    {
        using var index = LoadedIndex();

        var result = index.Queries.GetRecords(["npc_", "weap"], plugin: null, search: search, limit: 100, offset: 0).Value();

        Assert.Equal(["000800:TestPlugin.esp"], result.Items.Select(r => r.FormKey));
        Assert.Equal(1, result.Total);
    }

    [Fact]
    public void ASearchByAMalformedFormKey_FallsBackToEditorIdMatch_FindingNothing()
    {
        using var index = LoadedIndex();

        var result = index.Queries.GetRecords(["npc_"], plugin: null, search: "ZZZZZZ:NotAFormKey.esp", limit: 100, offset: 0).Value();

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

    [Theory]
    [InlineData(null, new[] { "Zebra", "Apple" })]
    [InlineData("e", new[] { "Apple", "Zebra" })]
    public void AListing_IsInFormIdOrder_AndASearchTermsMatches_AreInEditorIdOrder(string? search, string[] expected)
    {
        using var fixture = ZebraBeforeApple();
        using var index = Indexes.Reconciled(fixture);

        var result = index.Queries.GetRecords(["npc_"], plugin: null, search: search, limit: 10, offset: 0).Value();

        Assert.Equal(expected, result.Items.Select(r => r.EditorId));
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

        var result = index.Queries.GetRecords(
            ["npc_"], new PluginAddress("Later.esp", PluginOrigin.DataDirectory), search: null, limit: 10, offset: 0).Value();

        Assert.Equal(["Overridden", "Own"], result.Items.Select(r => r.EditorId));
    }

    [Fact]
    public void AListing_OrdersARecordWhoseFormKeyIsSpelledWithMutagensOtherDelimiter_ByItsMastersPosition()
    {
        using var fixture = new PluginFixtureBuilder("medit-sort-underscore-master")
            .WithPlugin("Master.esm", mod => mod.Npcs.AddNew("Mastered"), origin: "MasterMod")
            .WithPlugin("Later.esp", (mod, masters) =>
            {
                mod.Npcs.AddNew("Own");
                mod.Npcs.GetOrAddAsOverride(masters[0].Npcs.Single());
            }, origin: "LaterMod")
            .BuildScattered()
            .CompiledPlugin();
        using var index = Indexes.Reconciled(fixture);
        var later = fixture.Plugins.Single(p => p.Name == "Later.esp");
        var overridden = index.DocumentOf(index.ListedIn(later.Key).Single(d => d.EditorId == "Mastered").FormKey, later.Key);

        index.Edit(later, overridden, later.SourceTextOf(overridden).Replace("000800:Master.esm", "000800_Master.esm", StringComparison.Ordinal));

        Assert.Equal(["Mastered", "Own"], index.ListedIn(later.Key).Select(r => r.EditorId));
    }

    [Fact]
    public void ADocument_HasAFieldForEveryColumnInItsSchema()
    {
        using var index = LoadedIndex();
        var formKey = _fixture.Npc1FormKey.ToString();
        var schema = Reflector.GetSchemas(GameRelease.Fallout4)["npc_"];

        var record = index.Queries.GetRecord(formKey).Value();

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

        var record = index.Queries.GetRecord(npcFormKey.ToString()).Value();

        Assert.NotNull(record);
        var raceField = record.Fields.FirstOrDefault(f => f.Metadata.Name == "Race");
        Assert.NotNull(raceField);
        Assert.Equal(raceFormKey.ToString(), Assert.IsType<JsonElement>(raceField.Value).GetString());
    }

    [Theory]
    [InlineData("ModA")]
    [InlineData("ModB")]
    public void AnOverrideStack_OfAFilenameInTwoOrigins_HoldsOnlyTheWinningOrigin(string winner)
    {
        FormKey npcFormKey = default;
        using var fixture = new PluginFixtureBuilder("medit-two-origins")
            .WithPlugin("Shared.esp", mod => npcFormKey = mod.Npcs.AddNew("SharedNpc").FormKey, origin: "ModA")
            .WithPlugin("Shared.esp", (mod, built) => mod.Npcs.Set(built[0].Npcs.First().DeepCopy()), origin: "ModB")
            .BuildScattered();
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder);

        var stack = index.WithWinner(holder, fixture.DataFolder, fixture.Plugins, winner).StackOf(npcFormKey.ToString());

        Assert.Equal(winner, Assert.Single(stack).Origin);
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

        var record = index.Queries.GetRecord(raceFormKey.ToString()).Value();

        Assert.NotNull(record);
        var flags = record.Fields.Single(f => f.Metadata.Name == "Flags");
        Assert.Equal("flags", flags.Metadata.Type);
        var names = Assert.IsType<JsonElement>(flags.Value).EnumerateArray().Select(e => e.GetString()).ToList();
        Assert.Equal([nameof(Race.Flag.Playable), nameof(Race.Flag.LowPriorityPushable)], names);
    }

    [Theory]
    [InlineData("FFFFFF:Unknown.esp")]
    [InlineData("' OR '1'='1")]
    public void AFormKeyInNoPlugin_ReadsNoDocument(string formKey)
    {
        using var index = LoadedIndex();

        Assert.Null(index.Queries.GetRecord(formKey).Value());
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

        var record = index.Queries.GetRecord(npcFormKey.ToString()).Value();

        Assert.NotNull(record);
        var keywordsField = record.Fields.FirstOrDefault(f => f.Metadata.Name == "Keywords");
        Assert.NotNull(keywordsField);
        Assert.Equal(
            ["000001:ArrayTest.esm", "000002:ArrayTest.esm"],
            Assert.IsType<JsonElement>(keywordsField.Value).EnumerateArray().Select(e => e.GetString()));
    }

    [Fact]
    public void APluginFilterNamingAnUnknownPlugin_FindsNothingEvenWhenTheSearchMatches()
    {
        using var index = LoadedIndex();
        var result = index.Queries.GetRecords(["npc_"], UnknownPlugin, search: "TestNPC", limit: 100, offset: 0).Value();
        Assert.Equal(0, result.Total);
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

        var summary = index.Queries.GetRecords(["npc_"], plugin: null, search: null, limit: 100, offset: 0).Value().Items.Single();
        Assert.Null(summary.EditorId);

        var detail = index.Queries.GetRecord(npcFormKey.ToString()).Value();
        Assert.NotNull(detail);
        Assert.Null(detail.EditorId);
    }

    [Fact]
    public void AnUnsetFormLinkField_ReadsNull()
    {
        using var index = LoadedIndex();

        var record = index.Queries.GetRecord(_fixture.Npc1FormKey.ToString()).Value();

        Assert.NotNull(record);
        var combatStyle = Assert.Single(record.Fields, f => f.Metadata.Name == "CombatStyle");
        Assert.Equal(("formKey", null), (combatStyle.Metadata.Type, combatStyle.Value));
    }

    [Fact]
    public void AHeaderMemberTheDocumentOmits_ReadsNull_InTheComparedColumn()
    {
        using var index = LoadedIndex();

        var compare = index.Queries.GetCompare(_fixture.Npc1FormKey.ToString()).Value();

        Assert.NotNull(compare);
        var only = Assert.Single(compare.Overrides);
        Assert.Equal((TestPluginFixture.PluginName, "TestNPC01"), (only.Plugin, only.EditorId));
        Assert.Null(Assert.Single(only.Fields, f => f.Metadata.Name == "MajorRecordFlagsRaw").Value);
    }

    [Theory]
    [InlineData("000800:Checked.esm", null)]
    [InlineData("FFFFFF:Checked.esm", "[0]: [FFFFFF:Checked.esm] <Error: Could not be resolved>")]
    public void AKeywordReference_FlagsCheckErrorOnTheKeywordsFieldOnlyWhereItDoesNotResolve(string linked, string? checkError)
    {
        FormKey npcFormKey = default;
        using var fixture = new PluginFixtureBuilder("medit-checkerror")
            .WithPlugin("Checked.esm", mod =>
            {
                mod.Keywords.AddNew("TestKeyword");
                var npc = mod.Npcs.AddNew("RefNPC");
                npcFormKey = npc.FormKey;
                npc.Keywords = [new FormLink<IKeywordGetter>(FormKey.Factory(linked))];
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);

        var record = index.Queries.GetRecord(npcFormKey.ToString()).Value();

        Assert.NotNull(record);
        Assert.Equal(checkError, Assert.Single(record.Fields, f => f.Metadata.Name == "Keywords").CheckError);
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

    [Theory]
    [InlineData(0, new[] { "000800:DupEditorId.esp", "000801:DupEditorId.esp" })]
    [InlineData(2, new[] { "000802:DupEditorId.esp", "000803:DupEditorId.esp" })]
    [InlineData(4, new[] { "000804:DupEditorId.esp", "000805:DupEditorId.esp" })]
    [InlineData(6, new[] { "000806:DupEditorId.esp" })]
    public void APageOfRecordsSharingOrLackingAnEditorId_HoldsItsOwnRecords_EveryTimeItIsAsked(int offset, string[] formKeys)
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
        IEnumerable<string> Page() =>
            index.Queries.GetRecords(["npc_"], plugin: null, search: null, limit: 2, offset: offset).Value().Items.Select(i => i.FormKey);

        var page = Page().ToList();

        Assert.Equal(formKeys, page);
        Assert.Equal(page, Page());
    }
}
