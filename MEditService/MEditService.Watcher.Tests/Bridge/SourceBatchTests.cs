using MEditService.SourceAdapter;
using MEditService.Watcher.Tests.TestSupport;

namespace MEditService.Watcher.Tests.Bridge;

/// <summary>ADR-0015 invariant 2: what one mod folder settled together, and which projection the
/// watcher asked the Index for. The clock closes every batch here.</summary>
public sealed class SourceBatchTests
{
    private const string Origin = "OneMod";

    private static IReadOnlyList<string> ValidatedIn(WatchedTree tree, int scope) =>
        [.. tree.Index.Of("validate").Where(p => p.Scope == scope)
            .Select(p => (p.Plugin ?? throw new InvalidOperationException("a validate names no plugin")).Name)
            .Order(StringComparer.Ordinal)];

    private static async Task<string> OneTrackedMod(WatchedTree tree, params string[] plugins)
    {
        var modFolder = tree.AddMod(Origin, plugins[0]);
        foreach (var plugin in plugins.Skip(1)) tree.AddCopy(Origin, modFolder, plugin);
        WatchedTree.Track(modFolder, plugins);
        await tree.ApplyLoadOrder();
        return modFolder;
    }

    [Fact]
    public async Task WritesToTwoPluginsOfOneMod_InOneWindow_SettleAsOneBatchNamingBoth()
    {
        using var tree = new WatchedTree();
        var modFolder = await OneTrackedMod(tree, "A.esp", "B.esp");

        await tree.Observes(
            () => tree.WriteUnnamedDocument(modFolder, "A.esp"),
            () => tree.WriteUnnamedDocument(modFolder, "B.esp"));

        tree.AdvancePastBothWindows();

        Assert.Single(tree.Index.Of("projection"));
        Assert.Equal(["A.esp", "B.esp"], ValidatedIn(tree, 1));
    }

    // The rival this pins: a watcher-wide timer, which would coalesce two mods' writes into one
    // batch. Which mod settles first is the operating system's delivery order, so the two batches
    // are asserted as a set.
    [Fact]
    public async Task WritesToTwoDifferentMods_InOneWindow_SettleAsTwoSeparateBatches()
    {
        using var tree = new WatchedTree();
        var modA = tree.AddMod("ModA", "A.esp");
        var modB = tree.AddMod("ModB", "B.esp");
        WatchedTree.Track(modA, "A.esp");
        WatchedTree.Track(modB, "B.esp");
        await tree.ApplyLoadOrder();

        await tree.Observes(
            () => tree.WriteUnnamedDocument(modA, "A.esp"),
            () => tree.WriteUnnamedDocument(modB, "B.esp"));

        tree.AdvancePastBothWindows();

        Assert.Equal(2, tree.Index.Of("projection").Count);
        Assert.Equal(
            [["A.esp"], ["B.esp"]],
            new[] { ValidatedIn(tree, 1), ValidatedIn(tree, 2) }.OrderBy(batch => batch[0], StringComparer.Ordinal));
    }

    // Quiet is far longer than the bounding window here, so the quiet timer can never be what
    // closes this batch: only the bounding one can, and until it is due nothing settles.
    [Fact]
    public async Task AStreamThatNeverGoesQuiet_StillSettlesAtTheMaximumWindow()
    {
        var quiet = TimeSpan.FromSeconds(10);
        var maxWindow = TimeSpan.FromSeconds(1);
        using var tree = new WatchedTree(quiet: quiet, maxWindow: maxWindow);
        var modFolder = await OneTrackedMod(tree, "A.esp");

        await tree.Observes(() => tree.WriteUnnamedDocument(modFolder, "A.esp"));

        var step = maxWindow / 5;
        for (var elapsed = TimeSpan.Zero; elapsed + step < maxWindow; elapsed += step)
        {
            tree.Clock.Advance(step);
            Assert.Empty(tree.Index.Of("validate"));
        }

        tree.Clock.Advance(step + step);

        Assert.Single(tree.Index.Of("validate"));
    }

    // The narrow route: a whole-copy validate would land the same rows, so only the verb the Index
    // was asked for tells the two apart.
    [Fact]
    public async Task ADocumentThatNamesItsRecord_IsRefreshedByKey_NotValidatedWhole()
    {
        using var tree = new WatchedTree();
        var modFolder = await OneTrackedMod(tree, "A.esp");

        await tree.Observes(() => tree.WriteRecord(modFolder, "A.esp", "000800:A.esp"));

        tree.AdvancePastBothWindows();

        var refreshed = Assert.Single(tree.Index.Of("refresh"));
        Assert.Equal("A.esp", (refreshed.Plugin ?? throw new InvalidOperationException("no plugin")).Name);
        Assert.Equal(["000800:A.esp"], refreshed.Keys);
        Assert.Empty(tree.Index.Of("validate"));
    }

    [Fact]
    public async Task ACommittedDocumentDeletedFromTheWorkingTree_IsRefreshedByTheKeyItFiled_NotValidatedWhole()
    {
        using var tree = new WatchedTree();
        var modFolder = tree.AddMod(Origin, "A.esp");
        Directory.CreateDirectory(SourceRepository.RootIn(modFolder, "A.esp"));
        var document = tree.WriteRecord(modFolder, "A.esp", "000800:A.esp");
        WatchedTree.Track(modFolder, "A.esp");
        await tree.ApplyLoadOrder();

        await tree.Observes(() => File.Delete(document));

        tree.AdvancePastBothWindows();

        Assert.Equal(["000800:A.esp"], Assert.Single(tree.Index.Of("refresh")).Keys);
        Assert.Empty(tree.Index.Of("validate"));
    }

    [Fact]
    public async Task ADocumentNoCommitFiled_DeletedFromTheWorkingTree_ValidatesTheCopyWhole()
    {
        using var tree = new WatchedTree();
        var modFolder = await OneTrackedMod(tree, "A.esp");
        var document = string.Empty;
        await tree.Observes(() => document = tree.WriteRecord(modFolder, "A.esp", "000800:A.esp"));
        Assert.True(await tree.Settles(() => tree.Index.Of("refresh").Count == 1), "the written document never settled");

        await tree.Observes(() => File.Delete(document));

        tree.AdvancePastBothWindows();

        Assert.Single(tree.Index.Of("validate"));
        Assert.Single(tree.Index.Of("refresh"));
    }

    [Fact]
    public async Task ARefMove_ValidatesEveryPluginOfTheModWhole()
    {
        using var tree = new WatchedTree();
        var modFolder = await OneTrackedMod(tree, "A.esp", "B.esp");

        await tree.Observes(() => tree.MoveRef(modFolder));

        tree.AdvancePastBothWindows();

        Assert.Single(tree.Index.Of("projection"));
        Assert.Equal(["A.esp", "B.esp"], ValidatedIn(tree, 1));
    }

    // A document that names no record cannot be refreshed by key, so the whole copy is the only
    // honest question to ask the Index.
    [Fact]
    public async Task ADocumentNamingNoRecord_ValidatesTheCopyWhole()
    {
        using var tree = new WatchedTree();
        var modFolder = await OneTrackedMod(tree, "A.esp");

        await tree.Observes(() => tree.WriteUnnamedDocument(modFolder, "A.esp"));

        tree.AdvancePastBothWindows();

        Assert.Single(tree.Index.Of("validate"));
        Assert.Empty(tree.Index.Of("refresh"));
    }

    [Fact]
    public async Task AnUnrelatedFileUnderTheModFolder_ReachesTheIndexNotAtAll()
    {
        using var tree = new WatchedTree();
        var modFolder = await OneTrackedMod(tree, "A.esp");

        // A .json outside the source root, so passing takes more than the carries-no-record filter
        // the extension alone would trip.
        await tree.Observes(
            () => tree.WriteFile(Path.Combine(modFolder, "notes.json"), """{"note":"not a record"}"""u8.ToArray()),
            () => tree.WriteRecord(modFolder, "A.esp", "000800:A.esp"));

        tree.AdvancePastBothWindows();

        Assert.Equal(["000800:A.esp"], Assert.Single(tree.Index.Of("refresh")).Keys);
        Assert.Empty(tree.Index.Of("validate"));
    }

    // Never exclusive owners of the folder (ADR-0003): a mod manager's Replace install removes the
    // repository under a running backend, and an untracked mod has nothing to project from.
    [Fact]
    public async Task ADeletedRepository_LeavesTheSourceWriteUnprojected()
    {
        using var tree = new WatchedTree();
        var modFolder = await OneTrackedMod(tree, "A.esp");

        await tree.Observes(
            () => WatchedTree.RemoveRepository(modFolder),
            () => tree.WriteUnnamedDocument(modFolder, "A.esp"));
        Assert.False(SourceRepository.IsTracked(modFolder));

        tree.AdvancePastBothWindows();

        // The batch opened and closed; what an untracked mod has is nothing to project from, so
        // neither door was reached.
        Assert.Empty(tree.Index.Of("validate"));
        Assert.Empty(tree.Index.Of("refresh"));
    }

    // ADR-0015: a closed Index has nowhere for a batch to land, and a refused projection would be
    // logged — so an empty log is what says the batch was declined rather than attempted.
    [Fact]
    public async Task AfterTheIndexCloses_AWatchThatFires_ProjectsNothingAndLogsNothing()
    {
        using var tree = new WatchedTree();
        var modFolder = await OneTrackedMod(tree, "A.esp");
        tree.Index.Closed = true;

        await tree.Observes(() => tree.WriteUnnamedDocument(modFolder, "A.esp"));

        tree.AdvancePastBothWindows();

        Assert.Empty(tree.Index.Projections);
        Assert.Empty(tree.LogEntries);
    }
}
