using MEditService.Codec.Schema;
using MEditService.Index.Queries;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

namespace MEditService.Index.Tests.Records;

public class RegistrationScopingTests
{
    private static readonly PluginAddress AlphaKey = new("Alpha.esp", "ModA");
    private static readonly PluginAddress BetaKey = new("Beta.esp", "ModB");

    private sealed class FixtureWithEveryKindOfExtractedRowAndBetaOverridingAlphasNpc : IDisposable
    {
        public FixtureWithEveryKindOfExtractedRowAndBetaOverridingAlphasNpc(string prefix)
        {
            string sharedNpcFk = "", askerFk = "";
            (string, string, string, string, string, string, string) betaKeys = ("", "", "", "", "", "", "");
            Plugins = new PluginFixtureBuilder(prefix)
                .WithPlugin(AlphaKey.Name, mod =>
                {
                    (_, sharedNpcFk, _, _, _, _, _) = Populate(mod, "A");
                    askerFk = mod.Npcs.AddNew("AlphaOnlyAsker").FormKey.ToString();
                }, origin: AlphaKey.Origin)
                .WithPlugin(BetaKey.Name, (mod, built) =>
                {
                    betaKeys = Populate(mod, "B");
                    var alpha = built[0];
                    mod.ModHeader.MasterReferences.Add(new MasterReference { Master = alpha.ModKey });
                    mod.Npcs.Set(alpha.Npcs.Single(n => n.FormKey.ToString() == sharedNpcFk).DeepCopy());
                }, origin: BetaKey.Origin)
                .BuildScattered();
            (BetaRaceFk, BetaNpcFk, BetaWorldspaceFk, BetaCellFk, BetaPlacedFk, BetaQuestFk, BetaTopicFk) = betaKeys;
            SharedNpcFk = sharedNpcFk;
            AskerFk = askerFk;

            Holder = new LoadOrderHolder();
            Opens = new GatedPluginAdapter();
            Index = Indexes.Open(Holder, Opens);
            Index.Reconcile(Holder, Plugins.GameDirectory, Plugins.Plugins, GameRelease.Fallout4);

            using var beta = Fallout4Mod.CreateFromBinaryOverlay(
                Plugins.Plugins.Single(p => p.Name == BetaKey.Name).Path, Fallout4Release.Fallout4);
            BetaRecords = [.. beta.EnumerateMajorRecords().Select(r => r.FormKey.ToString())];
        }

        public ScatteredFixtureData Plugins { get; }
        public OpenedIndex Index { get; }
        public GatedPluginAdapter Opens { get; }
        public LoadOrderHolder Holder { get; }
        public string SharedNpcFk { get; }
        public string AskerFk { get; }
        public string BetaNpcFk { get; }
        public string BetaRaceFk { get; }
        public string BetaWorldspaceFk { get; }
        public string BetaCellFk { get; }
        public string BetaPlacedFk { get; }
        public string BetaQuestFk { get; }
        public string BetaTopicFk { get; }
        public IReadOnlyList<string> BetaRecords { get; }

        public IEnumerable<string> BetaRecordsFound() => BetaRecords.Where(formKey => Index.RowOf(formKey, BetaKey) is not null);

        public IReadOnlyList<RecordSummary> EveryListedRecord() =>
            Index.Records.GetRecords(types: null, plugin: null, search: null, limit: 1000, offset: 0).Items;

        public FormKeyResolutionState ResolutionOfBetasNpc() =>
            Index.ResolutionOf(AskerFk, AlphaKey, BetaNpcFk).State;

        public void Reconcile(IReadOnlyList<LoadOrderEntry> snapshot) =>
            Index.Reconcile(Holder, Plugins.GameDirectory, snapshot, GameRelease.Fallout4);

        public IReadOnlyList<LoadOrderEntry> WithoutBeta => [.. Plugins.Plugins.Where(p => p.Name != BetaKey.Name)];

        public IReadOnlyList<LoadOrderEntry> WithBetaDisabled =>
            [.. Plugins.Plugins.Select(p => p.Name == BetaKey.Name ? p with { Enabled = false } : p)];

        public void Dispose()
        {
            Index.Dispose();
            Opens.Dispose();
            Plugins.Dispose();
        }
    }

    private static (string RaceFk, string NpcFk, string WorldspaceFk, string CellFk, string PlacedFk, string QuestFk, string TopicFk)
        Populate(Fallout4Mod mod, string tag)
    {
        var race = mod.Races.AddNew($"Race{tag}");
        var npc = mod.Npcs.AddNew($"Npc{tag}");
        npc.Race.SetTo(race.FormKey);

        var wrld = mod.Worldspaces.AddNew($"World{tag}");
        var extCell = new Cell(mod) { EditorID = $"Cell{tag}", Grid = new CellGrid { Point = new P2Int(0, 0) } };
        var placed = new PlacedObject(mod) { EditorID = $"Ref{tag}" };
        extCell.Persistent.Add(placed);
        var subBlock = new WorldspaceSubBlock { BlockNumberX = 0, BlockNumberY = 0 };
        subBlock.Items.Add(extCell);
        var block = new WorldspaceBlock { BlockNumberX = 0, BlockNumberY = 0 };
        block.Items.Add(subBlock);
        wrld.SubCells.Add(block);

        var intCell = new Cell(mod) { EditorID = $"Interior{tag}" };
        var intSub = new CellSubBlock { BlockNumber = 0 };
        intSub.Cells.Add(intCell);
        var intBlock = new CellBlock { BlockNumber = 0 };
        intBlock.SubBlocks.Add(intSub);
        mod.Cells.Records.Add(intBlock);

        var quest = mod.Quests.AddNew($"Quest{tag}");
        var topic = new DialogTopic(mod) { EditorID = $"Topic{tag}" };
        quest.DialogTopics.Add(topic);

        return (race.FormKey.ToString(), npc.FormKey.ToString(), wrld.FormKey.ToString(), extCell.FormKey.ToString(),
            placed.FormKey.ToString(), quest.FormKey.ToString(), topic.FormKey.ToString());
    }

    private static FixtureWithEveryKindOfExtractedRowAndBetaOverridingAlphasNpc Build(string prefix) => new(prefix);

    [Fact]
    public void APluginAbsentFromTheSnapshot_AnswersNoRead_WhileTheOtherProviderStillAnswers()
    {
        using var fx = Build("registration-unregister");
        var index = fx.Index;

        Assert.Equal(fx.BetaRecords, fx.BetaRecordsFound());
        Assert.Equal(2, index.StackOf(fx.SharedNpcFk).Count);
        Assert.NotEmpty(index.Records.GetReferences(fx.BetaRaceFk));
        Assert.NotNull(index.PlacementGroupIn(BetaKey, fx.BetaCellFk, fx.BetaPlacedFk));
        Assert.NotEmpty(index.Containers.GetChildren(BetaKey, fx.BetaQuestFk));

        fx.Reconcile(fx.WithoutBeta);

        Assert.Null(index.Records.GetRecord(fx.BetaNpcFk));
        Assert.Null(index.CopyIn(fx.BetaNpcFk, BetaKey));
        Assert.Empty(fx.BetaRecordsFound());
        Assert.Null(index.Records.GetCompare(fx.BetaNpcFk));
        var only = Assert.Single(index.StackOf(fx.SharedNpcFk));
        Assert.Equal(AlphaKey.Name, only.Plugin);
        Assert.True(only.IsWinner);
        Assert.Equal(AlphaKey.Name, index.Records.GetRecord(fx.SharedNpcFk)?.Plugin);

        Assert.DoesNotContain(fx.EveryListedRecord(), r => r.Plugin == BetaKey.Name);
        Assert.Empty(index.Records.GetPluginRecordTypes(BetaKey));

        Assert.Equal(FormKeyResolutionState.Unresolved, fx.ResolutionOfBetasNpc());
        Assert.Empty(index.Records.GetReferences(fx.BetaRaceFk));
        var cells = index.Worldspaces.GetWorldspaceBlocks(BetaKey, fx.BetaWorldspaceFk);
        Assert.Empty(cells.Blocks);
        Assert.Empty(cells.TopCells);
        Assert.Empty(index.Worldspaces.GetInteriorCells(BetaKey));
        var cellRefs = index.Worldspaces.GetCellChildRecords(BetaKey, fx.BetaCellFk);
        Assert.Empty(cellRefs.Persistent);
        Assert.Empty(cellRefs.Temporary);
        Assert.Empty(index.Containers.GetChildren(BetaKey, fx.BetaQuestFk));

        var filterNamingBetaWhereTheSharedNpcFormKeySitsInBothPluginsSoALeakedRowWouldSurfaceAlphasCopy =
            $"SELECT form_key FROM npc_ WHERE plugin = '{BetaKey.Name}' AND origin = '{BetaKey.Origin}'";
        index.SetFilter(filterNamingBetaWhereTheSharedNpcFormKeySitsInBothPluginsSoALeakedRowWouldSurfaceAlphasCopy, "filter.sql");
        Assert.Empty(fx.EveryListedRecord());
        Assert.DoesNotContain(index.Records.GetPlugins(), p => p.HasMatchingRecords);
        index.SetFilter($"SELECT form_key FROM npc_ WHERE plugin = '{AlphaKey.Name}' AND origin = '{AlphaKey.Origin}'", "filter.sql");
        Assert.True(index.PluginRowOf(AlphaKey)?.HasMatchingRecords);
        Assert.Contains(fx.EveryListedRecord(), r => r.FormKey == fx.SharedNpcFk);
        index.ClearFilter();

        Assert.NotEmpty(index.ListedIn(AlphaKey));
        Assert.NotEmpty(index.Records.GetPluginRecordTypes(AlphaKey));
    }

    [Fact]
    public void APluginThatIsNotActive_AnswersNoReadOfARecord()
    {
        using var fx = Build("registration-inactive-reads");
        var index = fx.Index;
        Assert.Equal(fx.BetaRecords, fx.BetaRecordsFound());

        fx.Reconcile(fx.WithBetaDisabled);

        Assert.Null(index.Records.GetRecord(fx.BetaNpcFk));
        Assert.Null(index.CopyIn(fx.BetaNpcFk, BetaKey));
        Assert.Empty(fx.BetaRecordsFound());
        Assert.Null(index.Records.GetCompare(fx.BetaNpcFk));
        var shared = Assert.Single(index.StackOf(fx.SharedNpcFk));
        Assert.Equal(AlphaKey, new PluginAddress(shared.Plugin, shared.Origin));
        Assert.DoesNotContain(fx.EveryListedRecord(), r => r.Plugin == BetaKey.Name);
        Assert.Empty(index.Records.GetPluginRecordTypes(BetaKey));
        Assert.Equal(FormKeyResolutionState.Unresolved, fx.ResolutionOfBetasNpc());
        Assert.Empty(index.Records.GetReferences(fx.BetaRaceFk));
        Assert.Empty(index.Worldspaces.GetInteriorCells(BetaKey));
        Assert.Null(index.PlacementGroupIn(BetaKey, fx.BetaCellFk, fx.BetaPlacedFk));
        Assert.Empty(index.Containers.GetChildren(BetaKey, fx.BetaQuestFk));
    }

    [Fact]
    public void APluginThatIsNotActive_IsInNoRelationTheSqlDoorReads()
    {
        using var fx = Build("registration-inactive-door");
        string[] relations =
        [
            "records", "form_lookup", "form_references", "placement", "cell_location",
            "container_child", "npc_",
        ];
        bool HoldsBeta(string relation)
        {
            var pluginColumn = relation == "form_references" ? "source_plugin" : "plugin";
            return fx.Index.Matching(
                $"SELECT form_key FROM records WHERE EXISTS (SELECT 1 FROM \"{relation}\" WHERE {pluginColumn} = '{BetaKey.Name}')") > 0;
        }
        Assert.All(relations, relation => Assert.True(HoldsBeta(relation), relation));

        fx.Reconcile(fx.WithBetaDisabled);

        Assert.All(relations, relation => Assert.False(HoldsBeta(relation), relation));
        Assert.False(fx.Index.Accepts($"SELECT form_key FROM mirror.records WHERE plugin = '{BetaKey.Name}'"));
    }

    [Fact]
    public void APluginAbsentThenRestored_AnswersAgainWithoutReindex()
    {
        using var fx = Build("registration-reregister");
        var index = fx.Index;
        fx.Reconcile(fx.WithoutBeta);
        Assert.Empty(fx.BetaRecordsFound());
        var opened = fx.Opens.OpenedTotal;

        fx.Reconcile(fx.Plugins.Plugins);

        Assert.Equal(opened, fx.Opens.OpenedTotal);
        Assert.Equal(fx.BetaRecords, fx.BetaRecordsFound());
        var stack = index.StackOf(fx.SharedNpcFk);
        Assert.Equal(2, stack.Count);
        Assert.True(stack.Single(e => e.Plugin == BetaKey.Name).IsWinner);
        Assert.Equal(BetaKey.Name, index.Records.GetRecord(fx.SharedNpcFk)?.Plugin);
        Assert.NotEqual(FormKeyResolutionState.Unresolved, fx.ResolutionOfBetasNpc());
        Assert.NotNull(index.PlacementGroupIn(BetaKey, fx.BetaCellFk, fx.BetaPlacedFk));
        Assert.NotEmpty(index.Containers.GetChildren(BetaKey, fx.BetaQuestFk));
    }

    [Fact]
    public async Task AFileThatWentAway_ReadsNothing_AndItsReturnWithNewBytesIsOpenedOnce()
    {
        using var fx = Build("registration-unindex");
        var betaPath = fx.Plugins.Plugins.Single(p => p.Name == BetaKey.Name).Path;
        var opened = fx.Opens.OpenedTotal;

        File.Delete(betaPath);
        fx.Index.NextSnapshot();

        Assert.Empty(fx.Index.ListedIn(BetaKey));

        var beta = new Fallout4Mod(ModKey.FromFileName(BetaKey.Name), Fallout4Release.Fallout4);
        beta.Npcs.AddNew("NpcBAgain");
        beta.WriteToBinary(betaPath);
        fx.Reconcile(fx.WithoutBeta);
        fx.Reconcile(fx.Plugins.Plugins);

        Assert.Equal(opened + 1, fx.Opens.OpenedTotal);
        Assert.NotEmpty(fx.Index.ListedIn(BetaKey));
    }
}
