using MEditService.Codec.Schema;
using MEditService.Index.Queries;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Query;

public sealed class RecordQueryServiceTests(RecordQueryServiceTests.TwoNpcs shared) : IClassFixture<RecordQueryServiceTests.TwoNpcs>, IDisposable
{
    private const string PluginName = "TestPlugin.esp";
    private const string Npc01 = "000800:TestPlugin.esp";
    private const string Npc02 = "000801:TestPlugin.esp";
    private const string MatchesNpc02 = "SELECT form_key FROM npc_ WHERE editor_id = 'TestNPC02'";
    private static readonly PluginAddress PluginKey = new(PluginName, "TestMod");

    private static PluginFixtureBuilder TwoNpcsPlugin() => new PluginFixtureBuilder("record-query").WithPlugin(PluginName, mod =>
    {
        var npc01 = mod.Npcs.AddNew("TestNPC01");
        const Npc.AggressionType nonDefaultSoTheColumnIsNotSkippedAsAbsent = Npc.AggressionType.Aggressive;
        npc01.Aggression = nonDefaultSoTheColumnIsNotSkippedAsAbsent;
        mod.Npcs.AddNew("TestNPC02");
    }, origin: PluginKey.Origin);

    public sealed class TwoNpcs : IDisposable
    {
        private readonly ScatteredFixtureData _fixture = TwoNpcsPlugin().BuildScattered();

        internal OpenedIndex Index { get; }

        public TwoNpcs() => Index = Indexes.Reconciled(_fixture);

        public void Dispose()
        {
            Index.Dispose();
            _fixture.Dispose();
        }
    }

    private readonly IRecordQueryService _svc = shared.Index.Records;
    private readonly List<IDisposable> _built = [];

    public void Dispose()
    {
        foreach (var built in Enumerable.Reverse(_built)) built.Dispose();
    }

    private ScatteredFixtureData Built(PluginFixtureBuilder builder)
    {
        var fixture = builder.BuildScattered();
        _built.Add(fixture);
        return fixture;
    }

    private OpenedIndex Reconciled(ScatteredFixtureData fixture, string? instanceRoot = null)
    {
        var index = Indexes.Reconciled(fixture, instanceRoot);
        _built.Add(index);
        return index;
    }

    private OpenedIndex Reconciled(PluginFixtureBuilder builder) => Reconciled(Built(builder));

    private OpenedIndex OwnTwoNpcs() => Reconciled(TwoNpcsPlugin());

    private OpenedIndex WithAnUnreadableNpc(string unreadable, params LoadOrderEntry[] besides)
    {
        var gameDirectory = new ScratchDirectory("medit-record-query-unreadable-");
        _built.Add(gameDirectory);
        var path = Path.Combine(gameDirectory, FormKey.Factory(unreadable).ModKey.FileName);
        DeletedNpcPlugin.WriteHoldingFields(path, FormKey.Factory(unreadable));
        var index = Indexes.Reconciled(
            gameDirectory,
            [new LoadOrderEntry(Path.GetFileName(path), path, PluginOrigin.DataDirectory, Line: 0, Enabled: true, Winning: true), .. besides]);
        _built.Add(index);
        return index;
    }

    [Fact]
    public void GetPlugins_ReturnsLoadedPlugin()
    {
        var plugin = Assert.Single(_svc.GetPlugins());

        Assert.Equal(PluginName, plugin.Plugin.Name);
        Assert.Equal(2, plugin.Content.RecordCount);
    }

    [Fact]
    public void GetPlugins_MarksOnlyThePluginHoldingAnUnreadableRecord()
    {
        var readable = Built(new PluginFixtureBuilder("record-query").WithPlugin("Readable.esp", mod => mod.Npcs.AddNew("Readable")))
            .Plugins.Single();
        var index = WithAnUnreadableNpc("000800:Unreadable.esp", readable with { Line = 1 });

        var plugins = index.Records.GetPlugins();

        Assert.True(plugins.Single(p => p.Plugin.Name == "Unreadable.esp").HasParseFailure);
        Assert.False(plugins.Single(p => p.Plugin.Name == "Readable.esp").HasParseFailure);
    }

    [Theory]
    [InlineData(false, false, false, false)]
    [InlineData(true, false, true, false)]
    [InlineData(true, true, true, true)]
    public void GetPlugins_MarksTrackedAndPluginSourceUnreadable_AsTheIndexDerivedThePlugin(
        bool trackTheMod, bool removeThePluginSource, bool tracked, bool pluginSourceUnreadable)
    {
        var fixture = Built(TwoNpcsPlugin());
        var entry = fixture.Plugins.Single();
        if (trackTheMod) TrackedMods.Track(entry, fixture.GameDirectory);
        if (removeThePluginSource) Directory.Delete(PluginSourceRoot.In(entry.ModFolderOf(), PluginName), recursive: true);

        var plugin = Reconciled(fixture).PluginRowOf(PluginKey) ?? throw new InvalidOperationException("Expected the plugin's row.");

        Assert.Equal((tracked, pluginSourceUnreadable), (plugin.IsTracked, plugin.PluginSourceUnreadable is not null));
    }

    [Fact]
    public void GetPlugins_MarksTrackedPerPlugin_NotPerFilename()
    {
        var fixture = Built(new PluginFixtureBuilder("record-query")
            .WithPlugin(PluginName, mod => mod.Npcs.AddNew("Tracked"), origin: "TrackedMod")
            .WithPlugin(PluginName, mod => mod.Npcs.AddNew("Untracked"), origin: "UntrackedMod"));
        TrackedMods.Track(fixture.Plugins.Single(p => p.Origin == "TrackedMod"), fixture.GameDirectory);

        var plugins = Reconciled(fixture).Records.GetPlugins();

        Assert.True(plugins.Single(p => p.Plugin.Origin == "TrackedMod").IsTracked);
        Assert.False(plugins.Single(p => p.Plugin.Origin == "UntrackedMod").IsTracked);
    }

    private OpenedIndex PatchOfAGhostMaster() => Reconciled(new PluginFixtureBuilder("record-query")
        .WithPlugin("Patch.esp", mod => mod.Npcs.AddNew("PatchedNpc").Race.SetTo(new FormKey(ModKey.FromFileName("Ghost.esm"), 0x800))));

    [Fact]
    public void GetPlugins_PluginWithMissingMaster_ReportsItAsAMasterIssue()
    {
        var patch = Assert.Single(PatchOfAGhostMaster().Records.GetPlugins(), p => p.Plugin.Name == "Patch.esp");

        Assert.Equal(["Ghost.esm"], patch.MasterIssues);
    }

    [Fact]
    public void GetRecord_ReferenceIntoAbsentMaster_RendersUnresolvedRatherThanErroring()
    {
        var detail = PatchOfAGhostMaster().Records.GetRecord("000800:Patch.esp");

        Assert.NotNull(detail);
        var raceField = Assert.Single(detail.Fields, f => f.Metadata.Name == "Race");
        var raceValue = raceField.Value;
        Assert.NotNull(raceValue);
        Assert.Contains("Ghost.esm", raceValue.ToString());
        Assert.Contains("Could not be resolved", raceField.CheckError);
    }

    [Fact]
    public void GetPlugins_PluginWithNoMissingMasters_ReportsEmptyMasterIssues()
    {
        Assert.Equal([], Assert.Single(_svc.GetPlugins()).MasterIssues);
    }

    [Fact]
    public void GetRecords_PagesTheRecordsOfTheTypesItNames_ThatMatchTheSearch()
    {
        var index = Reconciled(new PluginFixtureBuilder("record-query").WithPlugin(PluginName, mod =>
        {
            mod.Npcs.AddNew("Npc1");
            mod.Npcs.AddNew("Npc2");
            mod.Npcs.AddNew("Npc3");
            mod.Npcs.AddNew("Npc4");
            mod.Keywords.AddNew("NpcKeyword");
            mod.Npcs.AddNew("Other");
        }));

        var page = index.Records.GetRecords(types: ["npc_"], plugin: null, search: "Npc", limit: 2, offset: 1);

        Assert.Equal(4, page.Total);
        Assert.Equal(["Npc2", "Npc3"], EditorIds(page));
    }

    [Theory]
    [InlineData(null, new[] { "TestNPC02" })]
    [InlineData("TestNPC", new[] { "TestNPC01", "TestNPC02" })]
    public void GetRecords_TheFilterInForceNarrowsTheListing_NeverASearch(string? search, string[] expected)
    {
        var index = OwnTwoNpcs();
        index.SetFilter(MatchesNpc02, "npcs.sql");

        var page = index.Records.GetRecords(types: ["npc_"], plugin: null, search: search, limit: 10, offset: 0);

        Assert.Equal(expected, EditorIds(page));
    }

    [Theory]
    [InlineData("01000800", "Patch.esp")]
    [InlineData("0x01000800", "Patch.esp")]
    [InlineData("FE000800", "Light.esp")]
    [InlineData("00000800", "Base.esm")]
    public void GetRecords_AFormIdSearchesTheFormKeyItNames(string formId, string plugin)
    {
        var index = Reconciled(new PluginFixtureBuilder("record-query")
            .WithPlugin("Base.esm", mod => mod.Npcs.AddNew("BaseNpc"))
            .WithPlugin("Light.esp", mod =>
            {
                mod.ModHeader.Flags = Fallout4ModHeader.HeaderFlag.Small;
                mod.Npcs.AddNew("LightNpc");
            })
            .WithPlugin("Patch.esp", mod => mod.Npcs.AddNew("PatchNpc")));

        var page = index.Records.GetRecords(types: null, plugin: null, search: formId, limit: 20, offset: 0);

        Assert.Equal([$"000800:{plugin}"], FormKeys(page));
    }

    [Theory]
    [InlineData("FE000800", "000800:L0.esp")]
    [InlineData("FE001800", "000800:L1.esp")]
    [InlineData("FE001FFF", "000FFF:L1.esp")]
    [InlineData("01000800", "000800:F1.esp")]
    public void GetRecords_ALightFormIdDecodesItsIndexAndIdSeparately(string formId, string formKey)
    {
        var index = Roster(("F0.esm", false, true), ("L0.esp", true, true), ("F1.esp", false, true), ("L1.esp", true, true));

        var page = index.Records.GetRecords(types: null, plugin: null, search: formId, limit: 20, offset: 0);

        Assert.Equal([formKey], FormKeys(page));
    }

    [Fact]
    public void GetRecords_AFormIdCountsOnlyActivePlugins()
    {
        var index = Roster(("F0.esm", false, true), ("Off.esp", false, false), ("F1.esp", false, true));

        var page = index.Records.GetRecords(types: null, plugin: null, search: "01000800", limit: 20, offset: 0);

        Assert.Equal(["000800:F1.esp"], FormKeys(page));
    }

    [Fact]
    public void GetRecords_FeIsAFullIndexWhereNoActivePluginIsLight()
    {
        var index = Roster([.. Enumerable.Range(0, 255).Select(i => ($"P{i:D3}.esp", false, true))]);

        var page = index.Records.GetRecords(types: null, plugin: null, search: "FE000800", limit: 20, offset: 0);

        Assert.Equal(["000800:P254.esp"], FormKeys(page));
    }

    [Fact]
    public void GetRecords_AFormIdNoActivePluginHoldsSearchesAsTyped()
    {
        var index = Reconciled(new PluginFixtureBuilder("record-query").WithPlugin(PluginName, mod => mod.Npcs.AddNew("Npc7F000800")));

        var page = index.Records.GetRecords(types: null, plugin: null, search: "7F000800", limit: 20, offset: 0);

        Assert.Equal(["Npc7F000800"], EditorIds(page));
    }

    private static IReadOnlyList<string> FormKeys(PagedResult<RecordSummary> page) => [.. page.Items.Select(r => r.FormKey)];

    private static IReadOnlyList<string?> EditorIds(PagedResult<RecordSummary> page) => [.. page.Items.Select(r => r.EditorId)];

    private static readonly uint[] IdsEachPluginHolds = [0x800, 0xFFF];

    private OpenedIndex Roster(params (string Name, bool Light, bool Active)[] plugins)
    {
        var builder = new PluginFixtureBuilder("record-query-roster");
        foreach (var (name, light, active) in plugins)
        {
            builder.WithPlugin(name, mod =>
            {
                if (light) mod.ModHeader.Flags = Fallout4ModHeader.HeaderFlag.Small;
                foreach (var id in IdsEachPluginHolds) mod.Npcs.Add(new Npc(new FormKey(mod.ModKey, id), Fallout4Release.Fallout4));
            }, enabled: active);
        }
        return Reconciled(builder);
    }

    [Fact]
    public void GetRecords_NoType_ListsEveryTypeButTheHeader()
    {
        var index = Reconciled(new PluginFixtureBuilder("record-query").WithPlugin(PluginName, mod =>
        {
            mod.Npcs.AddNew("TheNpc");
            mod.Keywords.AddNew("TheKeyword");
        }));

        var page = index.Records.GetRecords(types: null, plugin: null, search: null, limit: 10, offset: 0);

        Assert.Equal(["TheNpc", "TheKeyword"], EditorIds(page));
    }

    [Theory]
    [InlineData(PluginOrigin.DataDirectory, new[] { "InData" })]
    [InlineData("OtherOrigin", new string[0])]
    public void GetRecords_OfAPlugin_ListsOnlyTheCopiesItsOriginProvides(string origin, string[] expected)
    {
        var index = Reconciled(new PluginFixtureBuilder("record-query")
            .WithPlugin(PluginName, mod => mod.Npcs.AddNew("InOther"), origin: "OtherOrigin")
            .WithPlugin(PluginName, mod => mod.Npcs.AddNew("InData")));

        var page = index.Records.GetRecords(types: ["npc_"], plugin: new PluginAddress(PluginName, origin), search: null, limit: 10, offset: 0);

        Assert.Equal(expected, EditorIds(page));
    }

    [Fact]
    public void GetRecords_ListsEachRowWithTheFactsTheIndexDerives_ThePageAfterTheTotal()
    {
        var index = Reconciled(new PluginFixtureBuilder("record-query").WithPlugin(PluginName, mod =>
        {
            var holder = new Quest(mod) { EditorID = "Holder", Name = "Full" };
            holder.DialogTopics.Add(new DialogTopic(mod) { EditorID = "Held" });
            mod.Quests.Add(holder);
            mod.Quests.AddNew("Bare");
            mod.Quests.AddNew("BeyondThePage");
        }, origin: PluginKey.Origin));

        var result = index.Records.GetRecords(types: ["qust"], plugin: null, search: null, limit: 2, offset: 0);

        Assert.Equal(3, result.Total);
        Assert.Equal(
            [
                new RecordSummary(
                    "000800:TestPlugin.esp", PluginName, 0, true, "Holder", PluginKey.Origin, WorkingTreeState.None,
                    HasContainerChildren: true, FullName: "Full"),
                new RecordSummary("000802:TestPlugin.esp", PluginName, 0, true, "Bare", PluginKey.Origin),
            ],
            result.Items);
    }

    [Fact]
    public void GetRecord_IsTheCopyTheLastActivePluginHolds()
    {
        var index = Reconciled(new PluginFixtureBuilder("record-query")
            .WithPlugin("Base.esm", mod => mod.Npcs.AddNew("AsTheMasterHasIt"))
            .WithPlugin("Patch.esp", (mod, earlier) =>
            {
                var patched = earlier[0].Npcs.Single().DeepCopy();
                patched.EditorID = "AsThePatchHasIt";
                mod.Npcs.Add(patched);
            }));

        var detail = index.Records.GetRecord("000800:Base.esm");

        Assert.NotNull(detail);
        Assert.Equal(("Patch.esp", "AsThePatchHasIt", true), (detail.Plugin, detail.EditorId, detail.IsWinner));
    }

    private const string NpcWithNoWinnerYet = "000800:Base.esm";
    private static readonly FormKey AbsentFromLater = FormKey.Factory("000FFF:Later.esp");

    [Fact]
    public async Task ALinkIntoAPluginNotYetIndexed_IsMarkedDanglingOnlyOnceTheIndexIsReady()
    {
        static List<string?> DanglingMarks(OpenedIndex index)
        {
            var compare = index.Records.GetCompare(NpcWithNoWinnerYet) ?? throw new InvalidOperationException("Expected the record to compare.");
            return [
                .. compare.Overrides.SelectMany(o => o.Fields).Where(f => f.Metadata.Name == "Race").Select(f => f.CheckError),
                .. compare.Diffs.Single(d => d.FieldName == "Race").CheckErrors?.Values ?? []];
        }

        List<string?> whileIndexing = [];
        await WhileNoCopyIsFlaggedWinner(
            index => whileIndexing = DanglingMarks(index),
            index => Assert.All(DanglingMarks(index), mark => Assert.Contains("Could not be resolved", mark, StringComparison.Ordinal)),
            raceOfBase: AbsentFromLater);

        Assert.All(whileIndexing, Assert.Null);
        Assert.NotEmpty(whileIndexing);
    }

    private async Task WhileNoCopyIsFlaggedWinner(Action<OpenedIndex> asked, Action<OpenedIndex>? afterwards = null, FormKey? raceOfBase = null)
    {
        var fixture = Built(new PluginFixtureBuilder("record-query")
            .WithPlugin("Base.esm", mod =>
            {
                var npc = mod.Npcs.AddNew("AsTheMasterHasIt");
                if (raceOfBase is { } race) npc.Race.SetTo(race);
            })
            .WithPlugin("Winner.esp", (mod, earlier) => mod.Npcs.Add(earlier[0].Npcs.Single().DeepCopy()))
            .WithPlugin("Next.esp", (mod, earlier) => mod.Npcs.Add(earlier[0].Npcs.Single().DeepCopy()), enabled: false)
            .WithPlugin("Later.esp"));
        var holder = new LoadOrderHolder();
        using var gate = new GatedPluginAdapter();
        using var index = Indexes.Open(holder, gate);
        index.Reconcile(holder, fixture.GameDirectory, [.. fixture.Plugins.Where(p => p.Name != "Later.esp")], GameRelease.Fallout4);
        gate.ParkNextOpenOf("Later.esp");
        var winnerDeactivated = fixture.Plugins
            .Select(p => p.Name switch { "Winner.esp" => p with { Enabled = false }, "Next.esp" => p with { Enabled = true }, _ => p })
            .ToList();
        var load = Task.Run(() => index.Reconcile(holder, fixture.GameDirectory, winnerDeactivated, GameRelease.Fallout4));
        await gate.WaitUntilParkedAsync();

        try
        {
            asked(index);
        }
        finally
        {
            gate.Release();
            await load;
        }
        afterwards?.Invoke(index);
    }

    [Fact]
    public async Task GetCompare_BeforeTheWinnerSweep_AnswersEveryCopy_WithNoneFlaggedWinner()
    {
        await WhileNoCopyIsFlaggedWinner(index =>
        {
            var compare = index.Records.GetCompare(NpcWithNoWinnerYet);

            Assert.NotNull(compare);
            Assert.Equal(["Base.esm", "Next.esp"], compare.Overrides.Select(o => o.Plugin));
            Assert.DoesNotContain(compare.Overrides, o => o.IsWinner);
        });
    }

    [Fact]
    public async Task GetRecord_BeforeTheWinnerSweep_IsNotReady_ForNoCopyWinsYetAndNullWouldSayItIsGone()
    {
        await WhileNoCopyIsFlaggedWinner(index =>
            Assert.Throws<IndexNotReadyException>(() => index.Records.GetRecord(NpcWithNoWinnerYet)));
    }

    [Fact]
    public async Task GetCompareRecords_BeforeTheWinnerSweep_IsNotReady_ForALinkResolvesToWinnersOnly()
    {
        await WhileNoCopyIsFlaggedWinner(index =>
            Assert.Throws<IndexNotReadyException>(
                () => index.Records.GetCompareRecords([new RecordCopy(NpcWithNoWinnerYet, new PluginAddress("Base.esm", "Base.esm"))])));
    }

    [Fact]
    public void GetRecord_ReturnsRecordType_ForCopyAsNewRecordNeedsTheSchemaTableNameUpFront()
    {
        Assert.Equal("npc_", _svc.GetRecord(Npc01)?.RecordType);
    }

    [Fact]
    public void GetCompare_SingleOverride_ReturnsDiffs()
    {
        var compare = _svc.GetCompare(Npc01);

        Assert.NotNull(compare);
        Assert.Equal(ConflictThis.OnlyOne, Assert.Single(compare.Overrides).ConflictThis);
        Assert.Equal(ConflictAll.OnlyOne, compare.ConflictAll);
        Assert.NotEmpty(compare.Diffs);
    }

    [Fact]
    public void GetCompare_EachColumnCarriesXEditsHexLoadIndex_ALightPluginCountingAmongTheLightOnesAfterFE()
    {
        var index = Reconciled(new PluginFixtureBuilder("record-query")
            .WithPlugin("Base.esm", mod => mod.Npcs.AddNew("SharedNPC"))
            .WithPlugin("Light.esp", (mod, prev) =>
            {
                mod.ModHeader.Flags = Fallout4ModHeader.HeaderFlag.Small;
                mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First());
            })
            .WithPlugin("Patch.esp", (mod, prev) => mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First())));

        var compare = index.Records.GetCompare("000800:Base.esm");

        Assert.Equal(["00", "FE:000", "01"], compare?.Overrides.Select(o => o.LoadIndex) ?? []);
    }

    [Fact]
    public void GetCompare_CarriesTheDiagnosisTheDocumentArrivedWith_ForTheRecordEditorRendersTheColumnReadOnlyFromItAlone()
    {
        const string unreadable = "000800:Unreadable.esp";
        var index = WithAnUnreadableNpc(unreadable);
        var diagnosis = index.RowOf(unreadable, new PluginAddress("Unreadable.esp", PluginOrigin.DataDirectory))?.ParseDiagnosis;
        Assert.NotNull(diagnosis);

        var compare = index.Records.GetCompare(unreadable);

        Assert.NotNull(compare);
        Assert.Equal(diagnosis, Assert.Single(compare.Overrides).ParseDiagnosis);
    }

    [Fact]
    public void GetCompare_LeavesAReadableRecordsColumnWithoutADiagnosis()
    {
        var compare = _svc.GetCompare(Npc01);

        Assert.NotNull(compare);
        Assert.All(compare.Overrides, o => Assert.Null(o.ParseDiagnosis));
    }

    [Fact]
    public void GetCompare_NamesTheRecordTypeAsXEditDoes()
    {
        Assert.Equal("Non-Player Character", _svc.GetCompare(Npc01)?.RecordTypeName);
    }

    private OpenedIndex KeywordReferredToFromBaseAndPatch() => Reconciled(new PluginFixtureBuilder("record-query")
        .WithPlugin("Target.esp", mod => mod.Keywords.AddNew("Target"))
        .WithPlugin("Base.esp", (mod, prev) =>
        {
            var npc = mod.Npcs.AddNew("Referrer");
            npc.Keywords = [prev[0].Keywords.Single().ToLink()];
        })
        .WithPlugin("Patch.esp", (mod, prev) => mod.Npcs.Add(prev[1].Npcs.Single().DeepCopy())));

    [Fact]
    public void GetReferences_NameTheRecordTypeAsXEditDoes()
    {
        var references = KeywordReferredToFromBaseAndPatch().Records.GetReferences("000800:Target.esp");

        Assert.NotEmpty(references);
        Assert.All(references, reference => Assert.Equal(("npc_", "Non-Player Character"), (reference.RecordType, reference.RecordTypeName)));
    }

    [Fact]
    public void GetReferences_ListThePluginsInLoadOrder()
    {
        var plugins = KeywordReferredToFromBaseAndPatch().Records.GetReferences("000800:Target.esp").Select(r => r.Plugin);

        Assert.Equal(["Base.esp", "Patch.esp"], plugins);
    }

    [Fact]
    public void GetCompare_OverridesCarryRecordType()
    {
        var compare = _svc.GetCompare(Npc01);

        Assert.NotNull(compare);
        Assert.All(compare.Overrides, o => Assert.Equal("npc_", o.RecordType));
    }

    [Theory]
    [InlineData("overwrite/")]
    [InlineData("Overwrite/")]
    [InlineData("OVERWRITE/")]
    public void GetCompare_OverwriteOriginColumn_CarriesIsInOverwriteTrue_IgnoringCase_ForOverwriteIsAReservedOriginNotAMod(string origin)
    {
        var index = Reconciled(new PluginFixtureBuilder("record-query").WithPlugin(PluginName, mod => mod.Npcs.AddNew("TestNPC"), origin: origin));

        var compare = index.Records.GetCompare(Npc01);

        Assert.NotNull(compare);
        Assert.True(Assert.Single(compare.Overrides).IsInOverwrite);
    }

    [Fact]
    public void GetCompare_ModOriginColumn_CarriesIsInOverwriteFalse()
    {
        var compare = _svc.GetCompare(Npc01);

        Assert.NotNull(compare);
        Assert.All(compare.Overrides, o => Assert.False(o.IsInOverwrite));
    }

    [Fact]
    public void GetCompare_RecordIdenticalExceptVmad_ClassifiesAsConflict()
    {
        var compare = Compared(new PluginFixtureBuilder("record-query")
            .WithPlugin("Base.esp", mod => MakeScriptedNpc(mod, 10))
            .WithPlugin("Mid.esp", (mod, prev) => mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First()).VirtualMachineAdapter = ScriptVmad(20))
            .WithPlugin("Top.esp", (mod, prev) => mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First()).VirtualMachineAdapter = ScriptVmad(30)));

        Assert.Equal(ConflictAll.Conflict, compare.ConflictAll);
        Assert.Equal("Top.esp", PowerPropertyDiff(compare).WinnerColumn);
    }

    [Fact]
    public void GetCompare_NoOverrideCarriesAnAdapter_OmitsTheFieldEntirely()
    {
        var compare = _svc.GetCompare(Npc01);

        Assert.NotNull(compare);
        Assert.DoesNotContain(compare.Diffs, d => d.FieldName == VmadField);
    }

    [Fact]
    public void GetCompare_OnlyOverrideCarriesAnAdapter_StillDiffsTheField()
    {
        var compare = Compared(new PluginFixtureBuilder("record-query")
            .WithPlugin("Base.esp", mod => mod.Npcs.AddNew("PlainNpc"))
            .WithPlugin("Over.esp", (mod, prev) => mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First()).VirtualMachineAdapter = ScriptVmad(5)));

        Assert.Contains(compare.Diffs, d => d.FieldName == VmadField);
        Assert.Equal(ConflictAll.Override, compare.ConflictAll);
    }

    [Fact]
    public void GetCompare_FieldOverrideAndVmadOverride_StaysOverride()
    {
        var compare = Compared(new PluginFixtureBuilder("record-query")
            .WithPlugin("Base.esp", mod => MakeScriptedNpc(mod, 10))
            .WithPlugin("Over.esp", (mod, prev) =>
            {
                var o = mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First());
                o.Aggression = Npc.AggressionType.Frenzied;
                o.VirtualMachineAdapter = ScriptVmad(20);
            }));

        Assert.Equal(ConflictAll.Override, compare.ConflictAll);
    }

    [Fact]
    public void GetCompare_NonMastersAgreeingOnTheFieldButDifferingOnVmad_AgainstAMasterCarryingAnAdapter_EscalateToConflict_NotOverride()
    {
        var compare = Compared(new PluginFixtureBuilder("record-query")
            .WithPlugin("Base.esp", mod => MakeScriptedNpc(mod, 10))
            .WithPlugin("Mid.esp", (mod, prev) =>
            {
                var o = mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First());
                o.Aggression = Npc.AggressionType.Frenzied;
                o.VirtualMachineAdapter = ScriptVmad(20);
            })
            .WithPlugin("Top.esp", (mod, prev) =>
            {
                var o = mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First());
                o.Aggression = Npc.AggressionType.Frenzied;
                o.VirtualMachineAdapter = ScriptVmad(30);
            }));

        Assert.Equal(ConflictAll.Conflict, compare.ConflictAll);
    }

    [Fact]
    public void GetCompare_NonMastersAgreeingOnTheFieldButDifferingOnVmad_AgainstAMasterCarryingNoAdapter_EscalateToConflict_NotOverride()
    {
        var compare = Compared(new PluginFixtureBuilder("record-query")
            .WithPlugin("Base.esp", mod => mod.Npcs.AddNew("EscalateTest").Aggression = Npc.AggressionType.Unaggressive)
            .WithPlugin("Mid.esp", (mod, prev) =>
            {
                var o = mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First());
                o.Aggression = Npc.AggressionType.Frenzied;
                o.VirtualMachineAdapter = ScriptVmad(10);
            })
            .WithPlugin("Top.esp", (mod, prev) =>
            {
                var o = mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First());
                o.Aggression = Npc.AggressionType.Frenzied;
                o.VirtualMachineAdapter = ScriptVmad(20);
            }));

        Assert.Equal(ConflictAll.Conflict, compare.ConflictAll);
    }

    [Fact]
    public void GetCompare_ConflictedFieldWithUncontestedVmad_DoesNotDowngradeFromConflict()
    {
        var compare = Compared(new PluginFixtureBuilder("record-query")
            .WithPlugin("Base.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("EscalateNoDowngradeTest");
                npc.Aggression = Npc.AggressionType.Unaggressive;
                npc.VirtualMachineAdapter = ScriptVmad(10);
            })
            .WithPlugin("Mid.esp", (mod, prev) => mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First()).Aggression = Npc.AggressionType.Frenzied)
            .WithPlugin("Top.esp", (mod, prev) => mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First()).Aggression = Npc.AggressionType.Aggressive));

        Assert.Equal(ConflictAll.Conflict, compare.ConflictAll);
    }

    [Fact]
    public void GetCompare_EquivalentGenericFieldAndVmadPropertyConflictLoss_ShowTheSameConflictThis()
    {
        var compare = Compared(new PluginFixtureBuilder("record-query")
            .WithPlugin("Base.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("ParityTest");
                npc.Aggression = Npc.AggressionType.Unaggressive;
                npc.VirtualMachineAdapter = ScriptVmad(10);
            })
            .WithPlugin("Mid.esp", (mod, prev) =>
            {
                var o = mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First());
                o.Aggression = Npc.AggressionType.Frenzied;
                o.VirtualMachineAdapter = ScriptVmad(20);
            })
            .WithPlugin("Top.esp", (mod, prev) =>
            {
                var o = mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First());
                o.Aggression = Npc.AggressionType.Aggressive;
                o.VirtualMachineAdapter = ScriptVmad(30);
            }));

        var fieldStates = compare.Diffs.First(d => d.FieldName == "Aggression").CellStates;
        var vmadStates = PowerPropertyDiff(compare).CellStates;
        Assert.Equal(ConflictThis.ConflictLoses, fieldStates["Mid.esp"]);
        Assert.Equal(ConflictThis.ConflictWins, fieldStates["Top.esp"]);
        Assert.Equal(fieldStates["Mid.esp"], vmadStates["Mid.esp"]);
        Assert.Equal(fieldStates["Top.esp"], vmadStates["Top.esp"]);
    }

    [Fact]
    public void GetCompare_RecordHasConditions_ClassifiesThemAsFieldDiffChildren_ThroughTheOneConflictClassifierForAConditionListIsAnOrdinaryReflectedArrayColumn()
    {
        var compare = Compared(new PluginFixtureBuilder("record-query")
            .WithPlugin("Base.esp", mod => mod.ConstructibleObjects.AddNew("Recipe").Conditions.Add(new ConditionFloat
            {
                CompareOperator = CompareOperator.EqualTo,
                ComparisonValue = 1f,
                Data = new FunctionConditionData { Function = Condition.Function.GetIsID },
            })));

        var conditions = Assert.Single(compare.Diffs, d => d.FieldName == "Conditions");
        var condition = Assert.Single(Children(conditions));
        var data0 = Assert.Single(Children(condition), c => c.FieldName == "Data");
        var function = Assert.Single(Children(data0), c => c.FieldName == "Function");
        Assert.Equal("GetIsID", function.Values["Base.esp"]?.ToString());
        Assert.Equal("Base.esp", conditions.WinnerColumn);
    }

    [Fact]
    public void GetCompare_ConditionFormParameter_ResolvesEditorId_AsTheConditionsParameterOneRecordResolutionInItsColumn()
    {
        var compare = Compared(new PluginFixtureBuilder("record-query")
            .WithPlugin("Base.esp", mod =>
            {
                var quest = mod.Quests.AddNew("SomeQuest");
                var conditionData = new FunctionConditionData { Function = Condition.Function.GetStageDone };
                conditionData.ParameterOneRecord.SetTo(quest.FormKey);
                mod.ConstructibleObjects.AddNew("Recipe").Conditions.Add(new ConditionFloat
                {
                    CompareOperator = CompareOperator.EqualTo,
                    ComparisonValue = 1f,
                    Data = conditionData,
                });
            }), "000801:Base.esp");

        var conditions = Assert.Single(compare.Diffs, d => d.FieldName == "Conditions");
        var condition = Assert.Single(Children(conditions));
        var data0 = Assert.Single(Children(condition), c => c.FieldName == "Data");
        var param = Assert.Single(Children(data0), c => c.FieldName == "ParameterOneRecord");
        var resolutions = param.Resolutions;
        Assert.NotNull(resolutions);
        var paramResolution = resolutions["Base.esp"];
        Assert.Equal(FormKeyResolutionState.ResolvedValidType, paramResolution.State);
        Assert.Equal("SomeQuest", paramResolution.EditorId);
    }

    private CompareResult Compared(PluginFixtureBuilder plugins, string formKey = "000800:Base.esp") =>
        Reconciled(plugins).Records.GetCompare(formKey) ?? throw new InvalidOperationException($"Expected a comparison of {formKey}.");

    private static void MakeScriptedNpc(IFallout4Mod mod, int power) =>
        mod.Npcs.AddNew("ScriptedNPC").VirtualMachineAdapter = ScriptVmad(power);

    private const string VmadField = "VirtualMachineAdapter";

    private static IReadOnlyList<FieldDiff> Children(FieldDiff diff) =>
        diff.Children ?? throw new InvalidOperationException($"Expected \"{diff.FieldName}\" to have children.");

    private static FieldDiff PowerPropertyDiff(CompareResult compare)
    {
        var vmad = compare.Diffs.First(d => d.FieldName == VmadField);
        var scripts = Children(vmad).First(c => c.FieldName == "Scripts");
        var script = Children(scripts).First(c => c.FieldName == "S");
        var properties = Children(script).First(c => c.FieldName == "Properties");
        return Children(properties).First(c => c.FieldName == "Power");
    }

    private static VirtualMachineAdapter ScriptVmad(int power)
    {
        var vmad = new VirtualMachineAdapter();
        var script = new ScriptEntry { Name = "S", Flags = ScriptEntry.Flag.Local };
        script.Properties.Add(new ScriptIntProperty { Name = "Power", Data = power });
        vmad.Scripts.Add(script);
        return vmad;
    }

    [Fact]
    public void GetCompare_UnknownFormKey_ReturnsNull()
    {
        Assert.Null(_svc.GetCompare("FFFFFF:Unknown.esp"));
    }

    [Fact]
    public void GetPluginRecordTypes_ReturnsCountsForPlugin()
    {
        var result = _svc.GetPluginRecordTypes(PluginKey);

        Assert.Equal(2, Assert.Single(result, r => r.Type == "npc_").Count);
        Assert.All(result, r => Assert.True(r.Count > 0));
    }

    [Fact]
    public void GetPluginRecordTypes_MarksOnlyTheTypeWhoseCountCarriesAFailure()
    {
        var fixture = Built(new PluginFixtureBuilder("record-query").WithPlugin(PluginName, mod =>
        {
            MisshapedPerks.Add(mod, "Unreadable");
            mod.Npcs.AddNew("Readable");
        }, origin: PluginKey.Origin));
        MisshapedPerks.Misshape(fixture.Plugins.Single().Path);

        var result = Reconciled(fixture).Records.GetPluginRecordTypes(PluginKey);

        Assert.True(Assert.Single(result, r => r.Type == "perk").HasParseFailure);
        Assert.False(Assert.Single(result, r => r.Type == "npc_").HasParseFailure);
    }

    [Fact]
    public void GetPluginRecordTypes_DisplayName_MatchesXEdit_WhileTheSignatureStaysTheKey()
    {
        Assert.Equal("Non-Player Character", Assert.Single(_svc.GetPluginRecordTypes(PluginKey), r => r.Type == "npc_").DisplayName);
    }

    private OpenedIndex ManyTypes() => Reconciled(new PluginFixtureBuilder("record-query").WithPlugin(PluginName, mod =>
    {
        mod.Npcs.AddNew("Npc");
        mod.Quests.AddNew("Quest");
        var subBlock = new CellSubBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellSubBlock };
        subBlock.Cells.Add(new Cell(mod) { EditorID = "Cell" });
        var block = new CellBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellBlock };
        block.SubBlocks.Add(subBlock);
        mod.Cells.Records.Add(block);
        mod.Worldspaces.AddNew("World");
    }, origin: PluginKey.Origin));

    [Fact]
    public void GetPluginRecordTypes_IsCreatable_AgreesWithTheCreatableEndpoint_ForTheGroupMenuReadsItInsteadOfASecondPackageJsonSideList()
    {
        var index = ManyTypes();
        var creatable = index.Records.GetCreatableRecordTypes().Select(r => r.Type).ToHashSet(StringComparer.Ordinal);

        var result = index.Records.GetPluginRecordTypes(PluginKey);

        Assert.Contains("npc_", creatable);
        Assert.Contains("qust", creatable);
        Assert.All(result, row => Assert.Equal(creatable.Contains(row.Type), row.IsCreatable));
    }

    [Fact]
    public void GetPluginRecordTypes_SaysWhichTypesAreContainers_AnEmptyOneIncluded()
    {
        var containers = ManyTypes().Records.GetPluginRecordTypes(PluginKey).Where(r => r.IsContainer).Select(r => r.Type);

        Assert.Equal(["cell", "qust", "wrld"], containers.Order(StringComparer.Ordinal));
    }

    [Fact]
    public void GetPluginRecordTypes_ExcludesHeader_ForItIsReachedOnlyViaOpenHeaderOnThePluginNode()
    {
        Assert.DoesNotContain(_svc.GetPluginRecordTypes(PluginKey), r => r.Type == PluginHeader.RecordType);
    }

    [Fact]
    public void GetPluginRecordTypes_UnknownPlugin_ReturnsEmpty()
    {
        Assert.Empty(_svc.GetPluginRecordTypes(new PluginAddress("DoesNotExist.esp", PluginOrigin.DataDirectory)));
    }

    [Fact]
    public void GetCreatableRecordTypes_NamesAFlatTypeAsXEditDoes()
    {
        Assert.Equal("Non-Player Character", Assert.Single(_svc.GetCreatableRecordTypes(), r => r.Type == "npc_").DisplayName);
    }

    [Theory]
    [InlineData(PluginHeader.RecordType)]
    [InlineData("refr")]
    [InlineData("dial")]
    [InlineData("info")]
    public void GetCreatableRecordTypes_LeavesOutTheHeaderAndEveryHeldType(string recordType)
    {
        Assert.DoesNotContain(_svc.GetCreatableRecordTypes(), r => r.Type == recordType);
    }

    [Theory]
    [InlineData("cell")]
    [InlineData("wrld")]
    [InlineData("qust")]
    public void GetCreatableRecordTypes_NamesEveryTypeWithATopLevelGroup(string recordType)
    {
        Assert.Contains(_svc.GetCreatableRecordTypes(), r => r.Type == recordType);
    }

    [Fact]
    public void GetCreatableRecordTypes_IsInNameOrder()
    {
        var names = _svc.GetCreatableRecordTypes().Select(r => r.DisplayName).ToList();

        Assert.Equal(names.Order(StringComparer.OrdinalIgnoreCase), names);
    }

    private OpenedIndex Unloaded()
    {
        var index = Indexes.Open(new LoadOrderHolder());
        _built.Add(index);
        return index;
    }

    [Fact]
    public void GetCreatableRecordTypes_NoLoadOrder_ThrowsNoLoadOrderException()
    {
        Assert.Throws<NoLoadOrderException>(() => Unloaded().Records.GetCreatableRecordTypes());
    }

    private OpenedIndex OneOfEachType() => Reconciled(new PluginFixtureBuilder("record-query").WithPlugin(PluginName, mod =>
    {
        mod.Npcs.AddNew("NpcX");
        mod.Keywords.AddNew("KeywordX");
        mod.Weapons.AddNew("WeaponX");
    }));

    [Fact]
    public void GetRecords_SeveralTypes_ListsExactlyThose()
    {
        var page = OneOfEachType().Records.GetRecords(types: ["npc_", "kywd"], plugin: null, search: "X", limit: 10, offset: 0);

        Assert.Equal(["KeywordX", "NpcX"], EditorIds(page));
    }

    [Fact]
    public void GetRecords_AnUnknownTypeAmongKnownOnes_ListsTheKnownOnes()
    {
        var page = OneOfEachType().Records.GetRecords(types: ["npc_", "xxxx"], plugin: null, search: "X", limit: 10, offset: 0);

        Assert.Equal(["NpcX"], EditorIds(page));
    }

    [Fact]
    public void GetRecords_UnknownType_ReturnsEmptyPagedResult()
    {
        var result = _svc.GetRecords(types: ["xxxx"], plugin: null, search: null, limit: 10, offset: 0);

        Assert.Equal(0, result.Total);
        Assert.Empty(result.Items);
    }

    [Fact]
    public void GetPlugins_NoLoadOrder_ThrowsNoLoadOrderException()
    {
        var ex = Assert.Throws<NoLoadOrderException>(() => Unloaded().Records.GetPlugins());
        Assert.Contains("No load order", ex.Message);
    }

    [Fact]
    public void GetRecords_NoLoadOrder_ThrowsNoLoadOrderException()
    {
        var ex = Assert.Throws<NoLoadOrderException>(() => Unloaded().Records.GetRecords(["npc_"], null, null, 10, 0));
        Assert.Contains("No load order", ex.Message);
    }

    [Fact]
    public void GetPlugins_WithFilterMatchingRecords_ReturnsPlugin()
    {
        var index = OwnTwoNpcs();
        index.SetFilter(MatchesNpc02, "npcs.sql");

        Assert.True(Assert.Single(index.Records.GetPlugins(), p => p.Plugin.Name == PluginName).HasMatchingRecords);
    }

    [Fact]
    public void GetPlugins_WithFilterMatchingNoRecords_KeepsPluginVisibleButFlagsNoMatch_ForTheTreeIsAlsoTheLoadOrderAndAHiddenPluginWouldBeUnreorderable()
    {
        var index = OwnTwoNpcs();
        index.SetFilter("SELECT 'NoSuchFormKey:000000' AS form_key", "nothing.sql");

        Assert.False(Assert.Single(index.Records.GetPlugins(), p => p.Plugin.Name == PluginName).HasMatchingRecords);
    }

    [Fact]
    public void GetPlugins_AfterClearFilter_RestoresAllPlugins()
    {
        var index = OwnTwoNpcs();
        index.SetFilter("SELECT 'NoSuchFormKey:000000' AS form_key", "nothing.sql");
        index.ClearFilter();

        var plugin = Assert.Single(index.Records.GetPlugins());
        Assert.Equal(PluginName, plugin.Plugin.Name);
        Assert.True(plugin.HasMatchingRecords);
    }

    [Fact]
    public void SetFilter_PutsTheFilterInForce_WithItsSource()
    {
        var index = OwnTwoNpcs();

        index.Records.SetFilter(MatchesNpc02, "npcs.sql");

        Assert.Equal((MatchesNpc02, "npcs.sql"), index.Records.GetFilter());
    }

    [Fact]
    public void ClearFilter_LeavesNoFilterInForce()
    {
        var index = OwnTwoNpcs();
        index.Records.SetFilter(MatchesNpc02, "npcs.sql");

        index.Records.ClearFilter();

        Assert.Null(index.Records.GetFilter());
    }

    [Fact]
    public void GetFilter_WithNoLoadOrder_RefusesRatherThanAnsweringUnfiltered()
    {
        Assert.Throws<NoLoadOrderException>(() => Unloaded().Records.GetFilter());
    }

    [Fact]
    public async Task AwaitSequence_Reached_AnswersTheSequenceObserved_NotTheBound()
    {
        var observed = _svc.GetSequence();
        Assert.True(observed > 0, "the reconcile advanced the sequence");

        Assert.Equal(new SequenceAwaitResponse(true, observed), await _svc.AwaitSequence(observed - 1, TimeSpan.FromSeconds(1)));
    }

    [Fact]
    public async Task AwaitSequence_NotReached_AnswersFalseAndTheSequenceObserved()
    {
        var observed = _svc.GetSequence();

        Assert.Equal(new SequenceAwaitResponse(false, observed), await _svc.AwaitSequence(observed + 2, TimeSpan.FromMilliseconds(50)));
    }

    [Fact]
    public void RebuildStore_RebuildsTheStoreOfTheGivenGameAndInstance()
    {
        var fixture = Built(TwoNpcsPlugin());
        var index = Reconciled(fixture, instanceRoot: fixture.InstanceRoot);

        Assert.Null(index.Records.RebuildStore(GameRelease.Fallout4, fixture.InstanceRoot));

        Waits.Reached(() => index.Status.State == LoadOrderState.Ready, "the refill");
        Assert.Equal("TestNPC02", index.Records.GetRecord(Npc02)?.EditorId);
    }

    [Fact]
    public void RebuildStore_OfAnInstanceRootThatIsNotThere_RefusesNamingIt()
    {
        var fixture = Built(TwoNpcsPlugin());
        var index = Reconciled(fixture, instanceRoot: fixture.InstanceRoot);
        var gone = Path.Combine(fixture.InstanceRoot, "no-such-instance");

        var refusal = index.Records.RebuildStore(GameRelease.Fallout4, gone);

        Assert.Equal(StoreRebuildRefusal.InstanceRootNotFound, refusal?.Refusal);
        Assert.Contains(gone, refusal?.Message, StringComparison.Ordinal);
        Assert.Equal("TestNPC02", index.Records.GetRecord(Npc02)?.EditorId);
    }

    [Fact]
    public void GetRecords_MapsEveryWorkingTreeStateTheIndexHas()
    {
        var fixture = Built(new PluginFixtureBuilder("record-query").WithPlugin(PluginName, mod =>
        {
            mod.Npcs.AddNew("Unchanged");
            mod.Npcs.AddNew("Edited");
        }, origin: PluginKey.Origin));
        var entry = fixture.Plugins.Single();
        TrackedMods.Track(entry, fixture.GameDirectory);
        var index = Reconciled(fixture);
        var edited = index.DocumentOf(Npc02, PluginKey);
        var body = index.BodyOf(Npc02, PluginKey);
        index.Edit(entry, edited, body.Replace("\"Edited\"", "\"EditedInTheTree\"", StringComparison.Ordinal));
        index.Create(entry, "000900:TestPlugin.esp", "npc_", "Added",
            body.Replace(Npc02, "000900:TestPlugin.esp", StringComparison.Ordinal).Replace("\"Edited\"", "\"Added\"", StringComparison.Ordinal));

        var result = index.Records.GetRecords(types: ["npc_"], plugin: null, search: null, limit: 10, offset: 0);

        Assert.Equal(
            [WorkingTreeState.None, WorkingTreeState.Modified, WorkingTreeState.Added],
            result.Items.Select(row => row.WorkingTreeState));
    }
}
