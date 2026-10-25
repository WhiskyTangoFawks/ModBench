using MEditService.Codec.Schema;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Strings;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class RecordQueriesTests(RecordQueriesTests.TwoNpcs shared) : IClassFixture<RecordQueriesTests.TwoNpcs>, IDisposable
{
    private const string PluginName = "TestPlugin.esp";
    private const string Npc01 = "000800:TestPlugin.esp";
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

    private readonly IQueries _svc = shared.Index.Queries;
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

    private OpenedIndex Reconciled(ScatteredFixtureData fixture, IPluginAdapter? adapter = null)
    {
        var index = Indexes.Reconciled(fixture, adapter: adapter);
        _built.Add(index);
        return index;
    }

    private OpenedIndex Reconciled(PluginFixtureBuilder builder) => Reconciled(Built(builder));

    private OpenedIndex OwnTwoNpcs() => Reconciled(TwoNpcsPlugin());

    private OpenedIndex WithAnUnreadableNpc(string unreadable)
    {
        var dataFolder = new ScratchDirectory("medit-record-query-unreadable-");
        _built.Add(dataFolder);
        var path = Path.Combine(dataFolder, FormKey.Factory(unreadable).ModKey.FileName);
        DeletedNpcPlugin.WriteHoldingFields(path, FormKey.Factory(unreadable));
        var index = Indexes.Reconciled(
            dataFolder,
            [new LoadOrderEntry(Path.GetFileName(path), path, PluginOrigin.DataDirectory, Line: 0, Enabled: true, Winning: true)]);
        _built.Add(index);
        return index;
    }

    [Fact]
    public void TheIndexedPlugin_IsListed()
    {
        var plugin = Assert.Single(_svc.GetPlugins().Value());

        Assert.Equal(PluginName, plugin.Name);
    }

    private sealed record CompiledPluginRow(bool IsCompiledPlugin, bool PluginSourceUnreadable);

    private CompiledPluginRow PluginRowOf(ScatteredFixtureData fixture)
    {
        var plugin = Reconciled(fixture).PluginResponseOf(PluginKey) ?? throw new InvalidOperationException("Expected the plugin's row.");
        return new(plugin.IsCompiledPlugin, plugin.PluginSourceUnreadable is not null);
    }

    [Fact]
    public void APluginNoTreeBacks_IsNoCompiledPlugin()
    {
        Assert.Equal(new CompiledPluginRow(IsCompiledPlugin: false, PluginSourceUnreadable: false), PluginRowOf(Built(TwoNpcsPlugin())));
    }

    [Fact]
    public void APluginItsModsTreeBacks_IsACompiledPlugin_WhoseSourceReads()
    {
        var fixture = Built(TwoNpcsPlugin());
        SourceMods.Init(fixture.Plugins.Single());

        Assert.Equal(new CompiledPluginRow(IsCompiledPlugin: true, PluginSourceUnreadable: false), PluginRowOf(fixture));
    }

    [Fact]
    public void ACompiledPluginWhoseTreeIsGone_IsACompiledPlugin_WhoseSourceIsUnreadable()
    {
        var fixture = Built(TwoNpcsPlugin());
        var entry = fixture.Plugins.Single();
        SourceMods.Init(entry);
        Directory.Delete(PluginSourceRoot.In(entry.ModFolderOf(), PluginName), recursive: true);

        Assert.Equal(new CompiledPluginRow(IsCompiledPlugin: true, PluginSourceUnreadable: true), PluginRowOf(fixture));
    }

    [Fact]
    public void ACompiledPlugin_IsMarkedPerPlugin_NotPerFilename()
    {
        var fixture = Built(new PluginFixtureBuilder("record-query")
            .WithPlugin(PluginName, mod => mod.Npcs.AddNew("CompiledPlugin"), origin: "SourceMod")
            .WithPlugin(PluginName, mod => mod.Npcs.AddNew("NonCompiledPlugin"), origin: "NonSourceMod"));
        SourceMods.Init(fixture.Plugins.Single(p => p.Origin == "SourceMod"));

        var plugins = Reconciled(fixture).Queries.GetPlugins().Value();

        Assert.True(plugins.Single(p => p.Origin == "SourceMod").IsCompiledPlugin);
        Assert.False(plugins.Single(p => p.Origin == "NonSourceMod").IsCompiledPlugin);
    }

    private OpenedIndex PatchOfAGhostMaster() => Reconciled(new PluginFixtureBuilder("record-query")
        .WithPlugin("Patch.esp", mod => mod.Npcs.AddNew("PatchedNpc").Race.SetTo(new FormKey(ModKey.FromFileName("Ghost.esm"), 0x800))));

    [Fact]
    public void AReferenceIntoAnAbsentMaster_ReadsUnresolved_RatherThanErroring()
    {
        var detail = PatchOfAGhostMaster().Queries.GetRecord("000800:Patch.esp").Value();

        Assert.NotNull(detail);
        var raceField = Assert.Single(detail.Fields, f => f.Metadata.Name == "Race");
        var raceValue = raceField.Value;
        Assert.NotNull(raceValue);
        Assert.Contains("Ghost.esm", raceValue.ToString());
        Assert.Contains("Could not be resolved", raceField.CheckError);
    }

    [Fact]
    public void AListing_PagesTheRecordsOfTheTypesItNames_ThatMatchTheSearch()
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

        var page = index.Queries.GetRecords(types: ["npc_"], plugin: null, search: "Npc", limit: 2, offset: 1).Value();

        Assert.Equal(4, page.Total);
        Assert.Equal(["Npc2", "Npc3"], EditorIds(page));
    }

    [Theory]
    [InlineData("01000800", "Patch.esp")]
    [InlineData("0x01000800", "Patch.esp")]
    [InlineData("FE000800", "Light.esp")]
    [InlineData("00000800", "Base.esm")]
    public void AFormIdSearch_FindsTheFormKeyItNames(string formId, string plugin)
    {
        var index = Reconciled(new PluginFixtureBuilder("record-query")
            .WithPlugin("Base.esm", mod => mod.Npcs.AddNew("BaseNpc"))
            .WithPlugin("Light.esp", mod =>
            {
                mod.ModHeader.Flags = Fallout4ModHeader.HeaderFlag.Small;
                mod.Npcs.AddNew("LightNpc");
            })
            .WithPlugin("Patch.esp", mod => mod.Npcs.AddNew("PatchNpc")));

        var page = index.Queries.GetRecords(types: null, plugin: null, search: formId, limit: 20, offset: 0).Value();

        Assert.Equal([$"000800:{plugin}"], FormKeys(page));
    }

    [Theory]
    [InlineData("FE000800", "000800:L0.esp")]
    [InlineData("FE001800", "000800:L1.esp")]
    [InlineData("FE001FFF", "000FFF:L1.esp")]
    [InlineData("01000800", "000800:F1.esp")]
    public void ALightFormId_DecodesItsIndexAndIdSeparately(string formId, string formKey)
    {
        var index = Roster(("F0.esm", false, true), ("L0.esp", true, true), ("F1.esp", false, true), ("L1.esp", true, true));

        var page = index.Queries.GetRecords(types: null, plugin: null, search: formId, limit: 20, offset: 0).Value();

        Assert.Equal([formKey], FormKeys(page));
    }

    [Fact]
    public void AFormId_CountsOnlyActivePlugins()
    {
        var index = Roster(("F0.esm", false, true), ("Off.esp", false, false), ("F1.esp", false, true));

        var page = index.Queries.GetRecords(types: null, plugin: null, search: "01000800", limit: 20, offset: 0).Value();

        Assert.Equal(["000800:F1.esp"], FormKeys(page));
    }

    [Fact]
    public void FE_IsAFullIndex_WhereNoActivePluginIsLight()
    {
        var index = Roster([.. Enumerable.Range(0, 255).Select(i => ($"P{i:D3}.esp", false, true))]);

        var page = index.Queries.GetRecords(types: null, plugin: null, search: "FE000800", limit: 20, offset: 0).Value();

        Assert.Equal(["000800:P254.esp"], FormKeys(page));
    }

    [Fact]
    public void AFormIdNoActivePluginHolds_SearchesAsTyped()
    {
        var index = Reconciled(new PluginFixtureBuilder("record-query").WithPlugin(PluginName, mod => mod.Npcs.AddNew("Npc7F000800")));

        var page = index.Queries.GetRecords(types: null, plugin: null, search: "7F000800", limit: 20, offset: 0).Value();

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
    public void AListingOfNoType_ListsEveryTypeButTheHeader()
    {
        var index = Reconciled(new PluginFixtureBuilder("record-query").WithPlugin(PluginName, mod =>
        {
            mod.Npcs.AddNew("TheNpc");
            mod.Keywords.AddNew("TheKeyword");
        }));

        var page = index.Queries.GetRecords(types: null, plugin: null, search: null, limit: 10, offset: 0).Value();

        Assert.Equal(["TheNpc", "TheKeyword"], EditorIds(page));
    }

    [Theory]
    [InlineData(PluginOrigin.DataDirectory, new[] { "InData" })]
    [InlineData("OtherOrigin", new string[0])]
    public void AListingOfAPlugin_ListsOnlyTheCopiesItsOriginProvides(string origin, string[] expected)
    {
        var index = Reconciled(new PluginFixtureBuilder("record-query")
            .WithPlugin(PluginName, mod => mod.Npcs.AddNew("InOther"), origin: "OtherOrigin")
            .WithPlugin(PluginName, mod => mod.Npcs.AddNew("InData"))
            .WithPlugin("Other.esp", mod => mod.Npcs.AddNew("InAnotherFilename")));

        var page = index.Queries.GetRecords(types: ["npc_"], plugin: new PluginAddress(PluginName, origin), search: null, limit: 10, offset: 0).Value();

        Assert.Equal(expected, EditorIds(page));
    }

    [Fact]
    public void AListedRow_CarriesTheFactsTheIndexDerives_ThePageAfterTheTotal()
    {
        var index = Reconciled(new PluginFixtureBuilder("record-query").WithPlugin(PluginName, mod =>
        {
            var holder = new Quest(mod) { EditorID = "Holder", Name = "Full" };
            holder.DialogTopics.Add(new DialogTopic(mod) { EditorID = "Held" });
            mod.Quests.Add(holder);
            mod.Quests.AddNew("Bare");
            mod.Quests.AddNew("BeyondThePage");
        }, origin: PluginKey.Origin));

        var result = index.Queries.GetRecords(types: ["qust"], plugin: null, search: null, limit: 2, offset: 0).Value();

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
    public void ARecord_IsTheCopyTheLastActivePluginHolds()
    {
        var index = Reconciled(new PluginFixtureBuilder("record-query")
            .WithPlugin("Base.esm", mod => mod.Npcs.AddNew("AsTheMasterHasIt"))
            .WithPlugin("Patch.esp", (mod, earlier) =>
            {
                var patched = earlier[0].Npcs.Single().DeepCopy();
                patched.EditorID = "AsThePatchHasIt";
                mod.Npcs.Add(patched);
            }));

        var detail = index.Queries.GetRecord("000800:Base.esm").Value();

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
            var compare = index.Queries.GetCompare(NpcWithNoWinnerYet).Value() ?? throw new InvalidOperationException("Expected the record to compare.");
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
        index.Reconcile(holder, fixture.DataFolder, [.. fixture.Plugins.Where(p => p.Name != "Later.esp")], GameRelease.Fallout4);
        gate.ParkNextOpenOf("Later.esp");
        var winnerDeactivated = fixture.Plugins
            .Select(p => p.Name switch { "Winner.esp" => p with { Enabled = false }, "Next.esp" => p with { Enabled = true }, _ => p })
            .ToList();
        var load = Task.Run(() => index.Reconcile(holder, fixture.DataFolder, winnerDeactivated, GameRelease.Fallout4));
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
    public async Task BeforeTheWinnerSweep_AComparisonAnswersEveryCopy_WithNoneFlaggedWinner()
    {
        await WhileNoCopyIsFlaggedWinner(index =>
        {
            var compare = index.Queries.GetCompare(NpcWithNoWinnerYet).Value();

            Assert.NotNull(compare);
            Assert.Equal(["Base.esm", "Next.esp"], compare.Overrides.Select(o => o.Plugin));
            Assert.DoesNotContain(compare.Overrides, o => o.IsWinner);
        });
    }

    [Fact]
    public void ARecord_CarriesItsRecordType_ForCopyAsNewRecordNeedsTheSchemaTableNameUpFront()
    {
        Assert.Equal("npc_", _svc.GetRecord(Npc01).Value()?.RecordType);
    }

    [Fact]
    public void AColumn_CarriesTheDiagnosisTheDocumentArrivedWith_ForTheRecordEditorRendersTheColumnReadOnlyFromItAlone()
    {
        const string unreadable = "000800:Unreadable.esp";
        var index = WithAnUnreadableNpc(unreadable);
        var diagnosis = index.RowOf(unreadable, new PluginAddress("Unreadable.esp", PluginOrigin.DataDirectory))?.ParseDiagnosis;
        Assert.NotNull(diagnosis);

        var compare = index.Queries.GetCompare(unreadable).Value();

        Assert.NotNull(compare);
        Assert.Equal(diagnosis, Assert.Single(compare.Overrides).ParseDiagnosis);
    }

    [Fact]
    public void AReadableRecordsColumn_CarriesNoDiagnosis()
    {
        var compare = _svc.GetCompare(Npc01).Value();

        Assert.NotNull(compare);
        Assert.All(compare.Overrides, o => Assert.Null(o.ParseDiagnosis));
    }

    [Fact]
    public void AComparison_CarriesTheLoadOrdersStringsLanguage()
    {
        var fixture = Built(TwoNpcsPlugin());
        var index = Reconciled(fixture);

        index.Receive(index.Holder, SnapshotPlugins.Snapshot(fixture.DataFolder, null, GameRelease.Fallout4, fixture.Plugins, stringsLanguage: Language.German));
        index.Settled();

        Assert.Equal("German", index.Queries.GetCompare(Npc01).Value()?.StringsLanguage);
    }

    [Fact]
    public void AComparison_NamesTheRecordTypeAsXEditDoes()
    {
        Assert.Equal("Non-Player Character", _svc.GetCompare(Npc01).Value()?.RecordTypeName);
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
    public void AReference_NamesItsRecordTypeAsXEditDoes()
    {
        var references = KeywordReferredToFromBaseAndPatch().Queries.GetReferences("000800:Target.esp").Value();

        Assert.NotEmpty(references);
        Assert.All(references, reference => Assert.Equal(("npc_", "Non-Player Character"), (reference.RecordType, reference.RecordTypeName)));
    }

    [Fact]
    public void TheReferencesToARecord_AreInLoadOrder()
    {
        var plugins = KeywordReferredToFromBaseAndPatch().Queries.GetReferences("000800:Target.esp").Value().Select(r => r.Plugin);

        Assert.Equal(["Base.esp", "Patch.esp"], plugins);
    }

    [Fact]
    public void EveryColumn_CarriesItsRecordType()
    {
        var compare = _svc.GetCompare(Npc01).Value();

        Assert.NotNull(compare);
        Assert.All(compare.Overrides, o => Assert.Equal("npc_", o.RecordType));
    }

    [Theory]
    [InlineData(LoadOrderEntry.OverwriteOrigin, true)]
    [InlineData("TestMod", false)]
    public void AColumn_IsInOverwrite_ExactlyWhenNoModProvidesItsPlugin(string origin, bool inOverwrite)
    {
        var index = Reconciled(new PluginFixtureBuilder("record-query").WithPlugin(PluginName, mod => mod.Npcs.AddNew("TestNPC"), origin: origin));

        var compare = index.Queries.GetCompare(Npc01).Value();

        Assert.NotNull(compare);
        Assert.Equal(inOverwrite, Assert.Single(compare.Overrides).IsInOverwrite);
    }

    [Fact]
    public void AConditionList_IsClassifiedAsFieldDiffChildren_ThroughTheOneConflictClassifier_ForItIsAnOrdinaryReflectedArrayColumn()
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
    public void AConditionsFormParameter_ResolvesItsEditorId_AsTheParameterOneRecordResolutionInItsColumn()
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
        Reconciled(plugins).Queries.GetCompare(formKey).Value() ?? throw new InvalidOperationException($"Expected a comparison of {formKey}.");

    private static IReadOnlyList<FieldDiff> Children(FieldDiff diff) =>
        diff.Children ?? throw new InvalidOperationException($"Expected \"{diff.FieldName}\" to have children.");

    [Fact]
    public void AnUnknownFormKey_HasNoComparison()
    {
        Assert.Null(_svc.GetCompare("FFFFFF:Unknown.esp").Value());
    }

    [Fact]
    public void APluginsRecordTypes_AreEachCounted()
    {
        var result = _svc.GetPluginRecordTypes(PluginKey).Value();

        Assert.Equal(2, Assert.Single(result, r => r.Type == "npc_").Count);
        Assert.All(result, r => Assert.True(r.Count > 0));
    }

    [Fact]
    public void ARecordTypesCount_HoldsNoRecordAnotherOfThePluginsRecordsHolds_WhateverTheCaseThePluginIsAskedIn()
    {
        var index = Reconciled(new PluginFixtureBuilder("record-query").WithPlugin(PluginName, mod =>
        {
            var room = new Cell(mod) { EditorID = "Room" };
            room.Temporary.Add(new PlacedObject(mod) { EditorID = "Chair" });
            room.Temporary.Add(new PlacedObject(mod) { EditorID = "Table" });
            mod.AddInteriorCells(room);
            mod.Statics.AddNew("Rock");
        }, origin: PluginKey.Origin));

        var counts = index.Queries.GetPluginRecordTypes(PluginKey with { Name = PluginName.ToUpperInvariant() }).Value();

        Assert.Equal([("cell", 1), ("stat", 1)], counts.Select(c => (c.Type, c.Count)).Order());
    }

    [Fact]
    public void APluginsRecordType_IsNamedAsXEditNamesIt_WhileTheSignatureStaysTheKey()
    {
        Assert.Equal("Non-Player Character", Assert.Single(_svc.GetPluginRecordTypes(PluginKey).Value(), r => r.Type == "npc_").DisplayName);
    }

    private static PluginFixtureBuilder ManyTypesPlugin() => new PluginFixtureBuilder("record-query").WithPlugin(PluginName, mod =>
    {
        mod.Npcs.AddNew("Npc");
        mod.Quests.AddNew("Quest");
        var subBlock = new CellSubBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellSubBlock };
        subBlock.Cells.Add(new Cell(mod) { EditorID = "Cell" });
        var block = new CellBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellBlock };
        block.SubBlocks.Add(subBlock);
        mod.Cells.Records.Add(block);
        mod.Worldspaces.AddNew("World");
    }, origin: PluginKey.Origin);

    private OpenedIndex ManyTypes() => Reconciled(ManyTypesPlugin());

    [Fact]
    public void APluginsRecordType_IsCreatable_ExactlyWhenTheGameGivesItATopLevelGroup_AHeldTypeWhoseReadFailedIncluded()
    {
        var index = Reconciled(Built(ManyTypesPlugin()), new DiagnosingAdapter { FailedRecordType = "refr" });

        var result = index.Queries.GetPluginRecordTypes(PluginKey).Value();

        Assert.Equal(
            [("cell", true), ("npc_", true), ("qust", true), ("refr", false), ("wrld", true)],
            result.Select(row => (row.Type, row.IsCreatable)).Order());
    }

    [Fact]
    public void APluginsRecordTypes_SayWhichAreContainers_AnEmptyOneIncluded()
    {
        var containers = ManyTypes().Queries.GetPluginRecordTypes(PluginKey).Value().Where(r => r.IsContainer).Select(r => r.Type);

        Assert.Equal(["cell", "qust", "wrld"], containers.Order(StringComparer.Ordinal));
    }

    [Fact]
    public void APluginsRecordTypes_LeaveOutTheHeader_ForItIsReachedOnlyViaOpenHeaderOnThePluginNode()
    {
        Assert.DoesNotContain(_svc.GetPluginRecordTypes(PluginKey).Value(), r => r.Type == PluginHeader.RecordType);
    }

    [Fact]
    public void AnUnknownPlugin_HasNoRecordTypes()
    {
        Assert.Empty(_svc.GetPluginRecordTypes(new PluginAddress("DoesNotExist.esp", PluginOrigin.DataDirectory)).Value());
    }

    [Fact]
    public void TheCreatablePluginExtensions_AreTheHeldReleasesExtensions()
    {
        Assert.Equal([".esm", ".esl", ".esp"], _svc.GetCreatablePluginExtensions().Value());
    }

    [Fact]
    public void ACreatableFlatType_IsNamedAsXEditNamesIt()
    {
        Assert.Equal("Non-Player Character", Assert.Single(_svc.GetCreatableRecordTypes().Value(), r => r.Type == "npc_").DisplayName);
    }

    [Fact]
    public void TheCreatableTypes_AreInNameOrder()
    {
        var names = _svc.GetCreatableRecordTypes().Value().Select(r => r.DisplayName).ToList();

        Assert.Equal(names.Order(StringComparer.OrdinalIgnoreCase), names);
    }

    private OpenedIndex OneOfEachType() => Reconciled(new PluginFixtureBuilder("record-query").WithPlugin(PluginName, mod =>
    {
        mod.Npcs.AddNew("NpcX");
        mod.Keywords.AddNew("KeywordX");
        mod.Weapons.AddNew("WeaponX");
    }));

    [Fact]
    public void AListingOfSeveralTypes_ListsExactlyThose()
    {
        var page = OneOfEachType().Queries.GetRecords(types: ["npc_", "kywd"], plugin: null, search: "X", limit: 10, offset: 0).Value();

        Assert.Equal(["KeywordX", "NpcX"], EditorIds(page));
    }

    [Fact]
    public void AListingOfAnUnknownTypeAmongKnownOnes_ListsTheKnownOnes()
    {
        var page = OneOfEachType().Queries.GetRecords(types: ["npc_", "xxxx"], plugin: null, search: "X", limit: 10, offset: 0).Value();

        Assert.Equal(["NpcX"], EditorIds(page));
    }

    [Fact]
    public void AListingOfAnUnknownType_IsEmpty()
    {
        var result = _svc.GetRecords(types: ["xxxx"], plugin: null, search: null, limit: 10, offset: 0).Value();

        Assert.Equal(0, result.Total);
        Assert.Empty(result.Items);
    }

    [Fact]
    public void AFilterSet_IsInForce_WithItsSource()
    {
        var index = OwnTwoNpcs();

        index.Queries.SetFilter(MatchesNpc02, "npcs.sql").Accepted();

        Assert.Equal(new RecordFilter(MatchesNpc02, "npcs.sql"), index.Queries.GetFilter().Value());
    }

    [Fact]
    public void AClearedFilter_LeavesNoFilterInForce()
    {
        var index = OwnTwoNpcs();
        index.Queries.SetFilter(MatchesNpc02, "npcs.sql").Accepted();

        index.Queries.ClearFilter();

        Assert.Null(index.Queries.GetFilter().Value());
    }

    [Fact]
    public async Task AwaitingASequenceReached_AnswersTheSequenceObserved_NotTheBound()
    {
        var observed = _svc.GetSequence();
        Assert.True(observed > 0, "the reconcile advanced the sequence");

        Assert.Equal(new SequenceAwaitResponse(true, observed), await _svc.AwaitSequence(observed - 1, TimeSpan.FromSeconds(1)));
    }

    [Fact]
    public async Task AwaitingASequenceNotReached_AnswersFalseAndTheSequenceObserved()
    {
        var observed = _svc.GetSequence();

        Assert.Equal(new SequenceAwaitResponse(false, observed), await _svc.AwaitSequence(observed + 2, TimeSpan.FromMilliseconds(50)));
    }
}
