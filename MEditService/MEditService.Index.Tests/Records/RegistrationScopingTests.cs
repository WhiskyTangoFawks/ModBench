using MEditService.Index;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

namespace MEditService.Index.Tests.Records;

// ADR-0009: registration is visibility. A copy the snapshot stops naming keeps its rows and
// answers nothing anywhere; naming it again makes them answer with no re-read.
public class RegistrationScopingTests
{
    private static readonly PluginCopyKey AlphaKey = new("Alpha.esp", "ModA");
    private static readonly PluginCopyKey BetaKey = new("Beta.esp", "ModB");

    // Every kind of row the index extracts, so every read path has something to not answer with. Beta
    // additionally overrides Alpha's Npc, so the override stack and the contested-FormKey read have a
    // Beta entry to lose.
    private sealed class Fixture : IDisposable
    {
        public Fixture(string prefix)
        {
            string sharedNpcFk = "";
            (string, string, string, string, string, string, string) betaKeys = ("", "", "", "", "", "", "");
            Plugins = new PluginFixtureBuilder(prefix)
                .WithPlugin(AlphaKey.Name, mod => (_, sharedNpcFk, _, _, _, _, _) = Populate(mod, "A"), origin: AlphaKey.Origin)
                .WithPlugin(BetaKey.Name, (mod, built) =>
                {
                    betaKeys = Populate(mod, "B");
                    var alpha = built[0];
                    mod.ModHeader.MasterReferences.Add(new MasterReference { Master = alpha.ModKey });
                    mod.Npcs.Set(alpha.Npcs.Single().DeepCopy());
                }, origin: BetaKey.Origin)
                .BuildScattered();
            (BetaRaceFk, BetaNpcFk, BetaWorldspaceFk, BetaCellFk, BetaPlacedFk, BetaQuestFk, BetaTopicFk) = betaKeys;
            SharedNpcFk = sharedNpcFk;

            Holder = new LoadOrderHolder();
            Opens = new GatedPluginAdapter();
            Index = Indexes.Open(Holder, Opens);
            Index.Reconcile(Holder, Plugins.GameDirectory, Plugins.Plugins, GameRelease.Fallout4);

            // +1 for the plugin header's own document: it is not an IMajorRecordGetter, so
            // EnumerateMajorRecords cannot count it. This is a row count, not a record count.
            using var beta = Fallout4Mod.CreateFromBinaryOverlay(
                Plugins.Plugins.Single(p => p.Name == BetaKey.Name).Path, Fallout4Release.Fallout4);
            BetaRowCount = beta.EnumerateMajorRecords().Count() + 1;
        }

        public ScatteredFixtureData Plugins { get; }
        public Indexer Index { get; }
        public GatedPluginAdapter Opens { get; }
        public LoadOrderHolder Holder { get; }
        public string SharedNpcFk { get; }
        public string BetaNpcFk { get; }
        public string BetaRaceFk { get; }
        public string BetaWorldspaceFk { get; }
        public string BetaCellFk { get; }
        public string BetaPlacedFk { get; }
        public string BetaQuestFk { get; }
        public string BetaTopicFk { get; }
        public int BetaRowCount { get; }

        public IRecordReads Reads => Index.RequireReads();

        public void Reconcile(IReadOnlyList<LoadOrderEntry> snapshot) =>
            Index.Reconcile(Holder, Plugins.GameDirectory, snapshot, GameRelease.Fallout4);

        public IReadOnlyList<LoadOrderEntry> WithoutBeta => [.. Plugins.Plugins.Where(p => p.Name != BetaKey.Name)];

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

    private static Fixture Build(string prefix) => new(prefix);

    [Fact]
    public void Unregister_LeavesRowsInPlace_AndNoReadAnswersForThePlugin()
    {
        using var fx = Build("registration-unregister");
        var reads = fx.Reads;

        // Premise: registered, everything answers — otherwise the emptiness below proves nothing.
        Assert.Equal(fx.BetaRowCount, reads.GetDocuments(BetaKey).Count);
        var initialSharedStack = reads.GetOverrideStack(fx.SharedNpcFk);
        Assert.NotNull(initialSharedStack);
        Assert.Equal(2, initialSharedStack.Entries.Count);
        Assert.NotEmpty(reads.GetReferencedBy(fx.BetaRaceFk));
        Assert.NotNull(reads.GetPlacement(fx.BetaPlacedFk, BetaKey));
        Assert.NotEmpty(reads.GetContainerChildren(BetaKey, fx.BetaQuestFk));

        fx.Reconcile(fx.WithoutBeta);

        // Unregistered, not unindexed: Register_AfterUnregister_AnswersAgainWithoutReindex is the
        // rows' own witness.
        Assert.False(fx.Index.Registers(BetaKey));

        // Documents.
        Assert.Null(reads.GetDocument(fx.BetaNpcFk));
        Assert.Null(reads.GetDocument(fx.BetaNpcFk, BetaKey));
        Assert.Empty(reads.GetDocuments(BetaKey));
        Assert.Null(reads.GetOverrideStack(fx.BetaNpcFk));
        var shared = reads.GetOverrideStack(fx.SharedNpcFk);
        Assert.NotNull(shared);
        var only = Assert.Single(shared.Entries);
        Assert.Equal(AlphaKey.Name, only.Plugin.Name);
        Assert.True(only.IsWinner);
        var sharedDocument = reads.GetDocument(fx.SharedNpcFk);
        Assert.NotNull(sharedDocument);
        Assert.Equal(AlphaKey.Name, sharedDocument.Plugin.Name);

        // Listings and counts.
        Assert.Empty(reads.Search(new RecordQuery(Plugin: BetaKey.Name, Origin: BetaKey.Origin, Limit: 1000)).Items);
        Assert.DoesNotContain(reads.Search(new RecordQuery(Limit: 1000)).Items, r => r.Plugin == BetaKey.Name);
        Assert.Empty(reads.GetRecordTypeCounts(BetaKey));
        Assert.Empty(reads.GetNativeFormKeys(BetaKey));

        // Extracted tables.
        Assert.Null(reads.Resolve(fx.BetaNpcFk));
        Assert.Empty(reads.GetReferencedBy(fx.BetaRaceFk));
        Assert.Empty(reads.GetWorldspaceCells(BetaKey, fx.BetaWorldspaceFk));
        Assert.Empty(reads.GetInteriorCells(BetaKey, 50, 0).Items);
        var cellRefs = reads.GetCellReferences(BetaKey, fx.BetaCellFk);
        Assert.Empty(cellRefs.Persistent);
        Assert.Empty(cellRefs.Temporary);
        Assert.Null(reads.GetPlacement(fx.BetaPlacedFk, BetaKey));
        Assert.Null(reads.GetCellLocation(BetaKey, fx.BetaCellFk));
        Assert.Empty(reads.GetContainerChildren(BetaKey, fx.BetaQuestFk));
        Assert.Null(reads.GetContainerParent(BetaKey, fx.BetaTopicFk));

        // The SQL door: user filter SQL and the filtered-chevron read see nothing of Beta either. The
        // shared NPC's FormKey sits in both copies, so a leaked Beta row would surface Alpha's copy.
        fx.Index.SetFilter($"SELECT form_key FROM npc_ WHERE plugin = '{BetaKey.Name}' AND origin = '{BetaKey.Origin}'", "filter.sql");
        Assert.Empty(reads.Search(new RecordQuery(Limit: 1000)).Items);
        Assert.Empty(reads.GetPluginsWithMatchingRecords(["npc_"]));
        fx.Index.SetFilter($"SELECT form_key FROM npc_ WHERE plugin = '{AlphaKey.Name}' AND origin = '{AlphaKey.Origin}'", "filter.sql");
        Assert.Contains(AlphaKey, reads.GetPluginsWithMatchingRecords(["npc_"]));
        Assert.Contains(reads.Search(new RecordQuery(Limit: 1000)).Items, r => r.FormKey == fx.SharedNpcFk);
        fx.Index.ClearFilter();

        // Alpha, still registered, is untouched by its neighbour's unregistration.
        Assert.NotEmpty(reads.GetDocuments(AlphaKey));
        Assert.NotEmpty(reads.GetRecordTypeCounts(AlphaKey));
    }

    [Fact]
    public void Register_AfterUnregister_AnswersAgainWithoutReindex()
    {
        using var fx = Build("registration-reregister");
        var reads = fx.Reads;
        fx.Reconcile(fx.WithoutBeta);
        Assert.Empty(reads.GetDocuments(BetaKey));
        var opened = fx.Opens.OpenedTotal;

        fx.Reconcile(fx.Plugins.Plugins);

        Assert.Equal(opened, fx.Opens.OpenedTotal);
        Assert.Equal(fx.BetaRowCount, reads.GetDocuments(BetaKey).Count);
        var stackResult = reads.GetOverrideStack(fx.SharedNpcFk);
        Assert.NotNull(stackResult);
        var stack = stackResult.Entries;
        Assert.Equal(2, stack.Count);
        Assert.True(stack.Single(e => e.Plugin.Name == BetaKey.Name).IsWinner);
        var sharedAfterReregister = reads.GetDocument(fx.SharedNpcFk);
        Assert.NotNull(sharedAfterReregister);
        Assert.Equal(BetaKey.Name, sharedAfterReregister.Plugin.Name);
        Assert.NotNull(reads.Resolve(fx.BetaNpcFk));
        Assert.NotNull(reads.GetPlacement(fx.BetaPlacedFk, BetaKey));
        Assert.NotEmpty(reads.GetContainerChildren(BetaKey, fx.BetaQuestFk));
    }

    // Unindex is the file-gone verb: the inverse of indexing, rows and registration alike, so the
    // copy's return is a fresh read of the binary.
    [Fact]
    public async Task Unindex_RemovesTheRowsThemselves()
    {
        using var fx = Build("registration-unindex");
        var betaPath = fx.Plugins.Plugins.Single(p => p.Name == BetaKey.Name).Path;
        var opened = fx.Opens.OpenedTotal;

        File.Delete(betaPath);
        Assert.True(await fx.Index.RefreshBinary(BetaKey, betaPath));

        Assert.False(fx.Index.Registers(BetaKey));
        Assert.Empty(fx.Reads.GetDocuments(BetaKey));

        var beta = new Fallout4Mod(ModKey.FromFileName(BetaKey.Name), Fallout4Release.Fallout4);
        beta.Npcs.AddNew("NpcBAgain");
        beta.WriteToBinary(betaPath);
        fx.Reconcile(fx.WithoutBeta);
        fx.Reconcile(fx.Plugins.Plugins);

        Assert.Equal(opened + 1, fx.Opens.OpenedTotal);
        Assert.NotEmpty(fx.Reads.GetDocuments(BetaKey));
    }
}
