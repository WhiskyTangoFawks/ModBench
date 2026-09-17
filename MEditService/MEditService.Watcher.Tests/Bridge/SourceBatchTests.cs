using MEditService.SourceRepo;
using MEditService.Tests.TestSupport;

namespace MEditService.Tests.Bridge;

/// <summary>ADR-0014 and ADR-0015 invariant 2: what one mod folder settled together, and which
/// projection the watcher asked the Index for. The clock closes every batch here.</summary>
public sealed class SourceBatchTests
{
    private const string Origin = "OneMod";

    private static IReadOnlyList<string> ValidatedIn(WatchedTree tree, int scope) =>
        [.. tree.Index.Of("validate").Where(p => p.Scope == scope)
            .Select(p => (p.Plugin ?? throw new InvalidOperationException("a validate names no plugin")).Name)
            .Order(StringComparer.Ordinal)];

    private static int Scopes(WatchedTree tree) => tree.Index.Of("projection").Count;

    [Fact]
    public async Task WritesToTwoPluginsOfOneMod_InOneWindow_SettleAsOneBatchNamingBoth()
    {
        using var tree = new WatchedTree();
        var modFolder = tree.AddMod(Origin, "A.esp");
        tree.AddCopy(Origin, modFolder, "B.esp");
        WatchedTree.Track(modFolder, "A.esp", "B.esp");
        tree.ApplyLoadOrder();
        tree.Watcher.WatchSourceOf(Origin);

        WatchedTree.WriteUnnamedDocument(modFolder, "A.esp");
        WatchedTree.WriteUnnamedDocument(modFolder, "B.esp");

        Assert.True(await tree.Settles(() => tree.Index.Of("validate").Count >= 2));
        // One scope, asserted off the clock: no further batch can land until it advances again.
        Assert.Single(tree.Index.Of("projection"));
        Assert.Equal(["A.esp", "B.esp"], ValidatedIn(tree, 1));
    }

    // The rival this pins: a watcher-wide timer, which would coalesce two mods' writes into one
    // batch because both land before any single window closes.
    [Fact]
    public async Task WritesToTwoDifferentMods_InOneWindow_SettleAsTwoSeparateBatches()
    {
        using var tree = new WatchedTree();
        var modA = tree.AddMod("ModA", "A.esp");
        var modB = tree.AddMod("ModB", "B.esp");
        WatchedTree.Track(modA, "A.esp");
        WatchedTree.Track(modB, "B.esp");
        tree.ApplyLoadOrder();
        tree.Watcher.WatchSourceOf("ModA");
        tree.Watcher.WatchSourceOf("ModB");

        WatchedTree.WriteUnnamedDocument(modA, "A.esp");
        WatchedTree.WriteUnnamedDocument(modB, "B.esp");

        Assert.True(await tree.Settles(() => tree.Index.Of("validate").Count >= 2));
        Assert.Equal(2, Scopes(tree));
        Assert.Equal(["A.esp"], ValidatedIn(tree, 1));
        Assert.Equal(["B.esp"], ValidatedIn(tree, 2));
    }

    // The narrow route: a whole-copy validate would land the same rows, so only the verb the Index
    // was asked for tells the two apart.
    [Fact]
    public async Task ADocumentThatNamesItsRecord_IsRefreshedByKey_NotValidatedWhole()
    {
        using var tree = new WatchedTree();
        var modFolder = tree.AddMod(Origin, "A.esp");
        WatchedTree.Track(modFolder, "A.esp");
        tree.ApplyLoadOrder();
        tree.Watcher.WatchSourceOf(Origin);

        WatchedTree.WriteRecord(modFolder, "A.esp", "000800:A.esp");

        Assert.True(await tree.Settles(() => tree.Index.Of("refresh").Count > 0));
        var refreshed = Assert.Single(tree.Index.Of("refresh"));
        Assert.Equal("A.esp", (refreshed.Plugin ?? throw new InvalidOperationException("no plugin")).Name);
        Assert.Equal(["000800:A.esp"], refreshed.Keys);
        Assert.Empty(tree.Index.Of("validate"));
    }

    [Fact]
    public async Task ARefMove_ValidatesEveryPluginOfTheModWhole()
    {
        using var tree = new WatchedTree();
        var modFolder = tree.AddMod(Origin, "A.esp");
        tree.AddCopy(Origin, modFolder, "B.esp");
        WatchedTree.Track(modFolder, "A.esp", "B.esp");
        tree.ApplyLoadOrder();
        tree.Watcher.WatchSourceOf(Origin);

        WatchedTree.MoveRef(modFolder);

        Assert.True(await tree.Settles(() => tree.Index.Of("validate").Count >= 2));
        Assert.Single(tree.Index.Of("projection"));
        Assert.Equal(["A.esp", "B.esp"], ValidatedIn(tree, 1));
    }

    // A document that names no record cannot be refreshed by key, so the whole copy is the only
    // honest question to ask the Index.
    [Fact]
    public async Task ADocumentNamingNoRecord_ValidatesTheCopyWhole()
    {
        using var tree = new WatchedTree();
        var modFolder = tree.AddMod(Origin, "A.esp");
        WatchedTree.Track(modFolder, "A.esp");
        tree.ApplyLoadOrder();
        tree.Watcher.WatchSourceOf(Origin);

        WatchedTree.WriteUnnamedDocument(modFolder, "A.esp");

        Assert.True(await tree.Settles(() => tree.Index.Of("validate").Count > 0));
        Assert.Empty(tree.Index.Of("refresh"));
    }

    [Fact]
    public async Task AnUnrelatedFileUnderTheModFolder_ReachesTheIndexNotAtAll()
    {
        using var tree = new WatchedTree();
        var modFolder = tree.AddMod(Origin, "A.esp");
        WatchedTree.Track(modFolder, "A.esp");
        tree.ApplyLoadOrder();
        tree.Watcher.WatchSourceOf(Origin);

        // A .json outside the source root, so passing takes more than the carries-no-record filter
        // the extension alone would trip.
        File.WriteAllText(Path.Combine(modFolder, "notes.json"), """{"note":"not a record"}""");
        // One watch delivers in order, so a later event landing proves the loose asset's already
        // had its chance.
        WatchedTree.WriteRecord(modFolder, "A.esp", "000800:A.esp");

        Assert.True(await tree.Settles(() => tree.Index.Of("refresh").Count > 0));
        Assert.Equal(["000800:A.esp"], Assert.Single(tree.Index.Of("refresh")).Keys);
        Assert.Empty(tree.Index.Of("validate"));
    }

    // Never exclusive owners of the folder (ADR-0003): a mod manager's Replace install removes the
    // repository under a running backend, and an untracked mod has nothing to project from.
    [Fact]
    public async Task ADeletedRepository_LeavesTheSourceWriteUnprojected()
    {
        using var tree = new WatchedTree();
        var modFolder = tree.AddMod(Origin, "A.esp");
        WatchedTree.Track(modFolder, "A.esp");
        tree.ApplyLoadOrder();
        tree.Watcher.WatchSourceOf(Origin);

        Directory.Delete(Path.Combine(modFolder, ".git"), recursive: true);
        Assert.False(SourceRepository.IsTracked(modFolder));
        WatchedTree.WriteUnnamedDocument(modFolder, "A.esp");

        // The batch still opens a scope; what an untracked mod has is nothing to project from, so
        // neither door is ever reached.
        Assert.True(await tree.NothingReaches(
            () => tree.Index.Of("validate").Count > 0 || tree.Index.Of("refresh").Count > 0));
    }

    // ADR-0015: a closed Index has nowhere for a batch to land, and a refused projection would be
    // logged — so an empty log is what says the batch was declined rather than attempted.
    [Fact]
    public async Task AfterTheIndexCloses_AWatchThatFires_ProjectsNothingAndLogsNothing()
    {
        using var tree = new WatchedTree();
        var modFolder = tree.AddMod(Origin, "A.esp");
        WatchedTree.Track(modFolder, "A.esp");
        tree.ApplyLoadOrder();
        tree.Watcher.WatchSourceOf(Origin);
        tree.Index.Closed = true;

        WatchedTree.WriteUnnamedDocument(modFolder, "A.esp");

        Assert.True(await tree.NothingReaches(() => tree.Index.Projections.Count > 0));
        Assert.Empty(tree.LogEntries);
    }
}
