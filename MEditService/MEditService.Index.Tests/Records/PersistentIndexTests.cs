using DuckDB.NET.Data;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Records;

public sealed class PersistentIndexTests : IDisposable
{
    private readonly ScratchDirectory _root = new("medit-index-");
    private readonly string _gameDirectory;
    private readonly string _instanceRoot;

    public PersistentIndexTests()
    {
        _gameDirectory = Directory.CreateDirectory(Path.Combine(_root.Path, "GameDir")).FullName;
        _instanceRoot = Directory.CreateDirectory(Path.Combine(_root.Path, "instance")).FullName;
    }

    public void Dispose() => _root.Dispose();

    private LoadOrderEntry WriteARealPluginHoldingOneNpcIntoItsOwnModFolder(string name, string editorId, int line)
    {
        var origin = Path.GetFileNameWithoutExtension(name) + "Mod";
        var folder = Directory.CreateDirectory(Path.Combine(_instanceRoot, "mods", origin)).FullName;
        var path = Path.Combine(folder, name);
        var mod = new Fallout4Mod(ModKey.FromFileName(name), Fallout4Release.Fallout4);
        mod.Npcs.AddNew(editorId);
        mod.WriteToBinary(path);
        return new LoadOrderEntry(name, path, origin, line, Enabled: true, Winning: true);
    }

    private sealed class Launch : IDisposable
    {
        public Launch(string gameDirectory, string instanceRoot, IReadOnlyList<LoadOrderEntry> plugins, DiskSaysAdapter? disk)
        {
            var holder = new LoadOrderHolder();
            Opens = new GatedPluginAdapter(inner: disk);
            Index = Indexes.Open(holder, Opens);
            Index.Reconcile(holder, gameDirectory, plugins, GameRelease.Fallout4, instanceRoot);
        }

        public OpenedIndex Index { get; }
        public GatedPluginAdapter Opens { get; }

        public void Dispose()
        {
            Index.Dispose();
            Opens.Dispose();
        }
    }

    private Launch Launched(IReadOnlyList<LoadOrderEntry> plugins, DiskSaysAdapter? disk = null) =>
        new(_gameDirectory, _instanceRoot, plugins, disk);

    [Fact]
    public void ReopeningTheSameFile_KeepsTheRows_AndRegisterAloneMakesThemAnswer()
    {
        var alpha = WriteARealPluginHoldingOneNpcIntoItsOwnModFolder("Alpha.esp", "NpcAlpha", 0);
        using (Launched([alpha])) { }

        using var second = Launched([alpha]);

        Assert.Equal(0, second.Opens.OpenedTotal);
        Assert.NotEmpty(second.Index.ListedIn(alpha.KeyOf()));
    }

    [Fact]
    public void ReopeningTheSameFile_KeepsTheLastRegistrations_UntilTheSnapshotCorrectsThem()
    {
        var alpha = WriteARealPluginHoldingOneNpcIntoItsOwnModFolder("Alpha.esp", "NpcAlpha", 0);
        var beta = WriteARealPluginHoldingOneNpcIntoItsOwnModFolder("Beta.esp", "NpcBeta", 1);
        using (Launched([alpha, beta])) { }

        using var second = Launched([beta]);

        Assert.Equal(0, second.Opens.OpenedTotal);
        Assert.Empty(second.Index.ListedIn(alpha.KeyOf()));
        Assert.NotEmpty(second.Index.ListedIn(beta.KeyOf()));

        second.Dispose();
        using var thirdNamingAlphaAgainAfterItsRowsOutlivedItsRegistration = Launched([alpha, beta]);
        Assert.Equal(0, thirdNamingAlphaAgainAfterItsRowsOutlivedItsRegistration.Opens.OpenedTotal);
        Assert.NotEmpty(thirdNamingAlphaAgainAfterItsRowsOutlivedItsRegistration.Index.ListedIn(alpha.KeyOf()));
    }

    [Fact]
    public void APluginWhoseBytesChangedBetweenOpens_IsTheOnlyOneDropped()
    {
        var alpha = WriteARealPluginHoldingOneNpcIntoItsOwnModFolder("Alpha.esp", "NpcAlpha", 0);
        var beta = WriteARealPluginHoldingOneNpcIntoItsOwnModFolder("Beta.esp", "NpcBeta", 1);
        using (Launched([alpha, beta])) { }

        var changed = new Fallout4Mod(ModKey.FromFileName("Alpha.esp"), Fallout4Release.Fallout4);
        changed.Npcs.AddNew("NpcAlphaEdited");
        changed.WriteToBinary(alpha.Path);

        using var second = Launched([alpha, beta]);

        Assert.Equal(["Alpha.esp"], second.Opens.Opened);
        Assert.Contains(second.Index.ListedIn(alpha.KeyOf()), d => d.EditorId == "NpcAlphaEdited");
        Assert.Contains(second.Index.ListedIn(beta.KeyOf()), d => d.EditorId == "NpcBeta");
    }

    [Fact]
    public void APluginRewrittenWithIdenticalBytes_IsNotDropped()
    {
        var alpha = WriteARealPluginHoldingOneNpcIntoItsOwnModFolder("Alpha.esp", "NpcAlpha", 0);
        using (Launched([alpha])) { }

        var bytes = File.ReadAllBytes(alpha.Path);
        File.Delete(alpha.Path);
        File.WriteAllBytes(alpha.Path, bytes);

        using var second = Launched([alpha]);
        Assert.Equal(0, second.Opens.OpenedTotal);
        Assert.NotEmpty(second.Index.ListedIn(alpha.KeyOf()));
    }

    [Fact]
    public void APluginDeletedBetweenOpens_HasItsRowsRemoved()
    {
        var alpha = WriteARealPluginHoldingOneNpcIntoItsOwnModFolder("Alpha.esp", "NpcAlpha", 0);
        using (Launched([alpha])) { }

        File.Delete(alpha.Path);

        using var second = Launched([alpha]);
        Assert.Empty(second.Index.ListedIn(alpha.KeyOf()));
        Assert.Contains(second.Index.Status.Failures, f => f.Name == "Alpha.esp");
    }

    [Fact]
    public void APluginTheAdapterSaysWentBetweenOpens_HasItsRowsRemoved()
    {
        var alpha = WriteARealPluginHoldingOneNpcIntoItsOwnModFolder("Alpha.esp", "NpcAlpha", 0);
        using (Launched([alpha])) { }
        var disk = new DiskSaysAdapter();

        disk.Gone(alpha.Path);

        using var second = Launched([alpha], disk);
        Assert.Empty(second.Index.ListedIn(alpha.KeyOf()));
        Assert.Contains(second.Index.Status.Failures, f => f.Name == "Alpha.esp");
    }

    [Fact]
    public void APluginTheAdapterSaysChangedBetweenOpens_IsTheOneReadAgain()
    {
        var alpha = WriteARealPluginHoldingOneNpcIntoItsOwnModFolder("Alpha.esp", "NpcAlpha", 0);
        var beta = WriteARealPluginHoldingOneNpcIntoItsOwnModFolder("Beta.esp", "NpcBeta", 1);
        using (Launched([alpha, beta])) { }
        var disk = new DiskSaysAdapter();

        disk.Changed(alpha.Path);

        using var second = Launched([alpha, beta], disk);
        Assert.Equal(["Alpha.esp"], second.Opens.Opened);
    }

    [Fact]
    public void AFileWrittenUnderAnotherVersion_RebuildsFromScratch()
    {
        var alpha = WriteARealPluginHoldingOneNpcIntoItsOwnModFolder("Alpha.esp", "NpcAlpha", 0);
        var beta = WriteARealPluginHoldingOneNpcIntoItsOwnModFolder("Beta.esp", "NpcBeta", 1);
        using (Launched([alpha, beta])) { }

        AgeTheFileWithSqlSinceNoOtherWayWritesRowsUnderAVersionThisBuildCannotProduce(
            "UPDATE mirror.index_version SET value = 'written-by-another-build'");

        using var second = Launched([alpha, beta]);
        Assert.Equal(["Alpha.esp", "Beta.esp"], second.Opens.Opened);
        Assert.NotEmpty(second.Index.ListedIn(alpha.KeyOf()));
        Assert.NotEmpty(second.Index.ListedIn(beta.KeyOf()));
    }

    private void AgeTheFileWithSqlSinceNoOtherWayWritesRowsUnderAVersionThisBuildCannotProduce(string sql)
    {
        using var connection = new DuckDBConnection($"Data Source={IndexFiles.In(_instanceRoot)}");
        connection.Open();
        using var cmd = connection.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }

    [Fact]
    public void AFileThatCannotBeOpened_RebuildsFromScratch()
    {
        var alpha = WriteARealPluginHoldingOneNpcIntoItsOwnModFolder("Alpha.esp", "NpcAlpha", 0);
        using (Launched([alpha])) { }

        File.WriteAllText(IndexFiles.In(_instanceRoot), "this is not a DuckDB database");

        using var second = Launched([alpha]);
        Assert.Equal(["Alpha.esp"], second.Opens.Opened);
        Assert.NotEmpty(second.Index.ListedIn(alpha.KeyOf()));
    }

    [Fact]
    public void ASecondIndexOverTheSameFile_LeavesTheFirstOnesRowsIntact()
    {
        var alpha = WriteARealPluginHoldingOneNpcIntoItsOwnModFolder("Alpha.esp", "NpcAlpha", 0);
        using var holder = Launched([alpha]);

        var secondIndexJoiningTheFirstBecauseDuckDbNetSharesOneDatabaseInstancePerPathInAProcess = Launched([alpha]);
        secondIndexJoiningTheFirstBecauseDuckDbNetSharesOneDatabaseInstancePerPathInAProcess.Dispose();

        Assert.NotEmpty(holder.Index.ListedIn(alpha.KeyOf()));
    }
}
