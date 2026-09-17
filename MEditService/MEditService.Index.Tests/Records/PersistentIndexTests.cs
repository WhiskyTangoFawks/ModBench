using DuckDB.NET.Data;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Records;

// ADR-0009: one persistent file per MO2 instance, validating itself against the disk by content,
// never by clock. Each test is two launches over the same instance.
public sealed class PersistentIndexTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), $"medit-index-{Guid.NewGuid():N}");
    private readonly string _gameDirectory;
    private readonly string _instanceRoot;

    public PersistentIndexTests()
    {
        _gameDirectory = Directory.CreateDirectory(Path.Combine(_root, "GameDir")).FullName;
        _instanceRoot = Directory.CreateDirectory(Path.Combine(_root, "instance")).FullName;
    }

    public void Dispose()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
    }

    // Writes a real plugin file holding one Npc with the given EditorID into its own mod folder.
    private LoadOrderEntry WritePlugin(string name, string editorId, int slot)
    {
        var origin = Path.GetFileNameWithoutExtension(name) + "Mod";
        var folder = Directory.CreateDirectory(Path.Combine(_instanceRoot, "mods", origin)).FullName;
        var path = Path.Combine(folder, name);
        var mod = new Fallout4Mod(ModKey.FromFileName(name), Fallout4Release.Fallout4);
        mod.Npcs.AddNew(editorId);
        mod.WriteToBinary(path);
        return new LoadOrderEntry(name, path, origin, slot, Enabled: true, Winning: true);
    }

    private sealed class Launch : IDisposable
    {
        public Launch(string gameDirectory, string instanceRoot, IReadOnlyList<LoadOrderEntry> plugins)
        {
            var holder = new LoadOrderHolder();
            Opens = new GatedPluginAdapter();
            Index = Indexes.Open(holder, Opens);
            Index.Reconcile(holder, gameDirectory, plugins, GameRelease.Fallout4, instanceRoot);
        }

        public IndexProjector Index { get; }
        public GatedPluginAdapter Opens { get; }

        public void Dispose()
        {
            Index.Dispose();
            Opens.Dispose();
        }
    }

    private Launch Launched(IReadOnlyList<LoadOrderEntry> plugins) => new(_gameDirectory, _instanceRoot, plugins);

    // Rows the previous launch indexed are still there and the plugin answers reads again on nothing
    // more than a registration: no plugin is opened in this test's second half at all.
    [Fact]
    public void ReopeningTheSameFile_KeepsTheRows_AndRegisterAloneMakesThemAnswer()
    {
        var alpha = WritePlugin("Alpha.esp", "NpcAlpha", 0);
        using (Launched([alpha])) { }

        using var second = Launched([alpha]);

        Assert.Equal(0, second.Opens.OpenedTotal);
        Assert.NotEmpty(second.Index.RequireReads().GetDocuments(alpha.KeyOf()));
    }

    // ADR-0013: the registrations a file carries are the last known load order, kept on open so a
    // restart with an identical snapshot costs nothing; the first reconcile corrects them.
    [Fact]
    public void ReopeningTheSameFile_KeepsTheLastRegistrations_UntilTheSnapshotCorrectsThem()
    {
        var alpha = WritePlugin("Alpha.esp", "NpcAlpha", 0);
        var beta = WritePlugin("Beta.esp", "NpcBeta", 1);
        using (Launched([alpha, beta])) { }

        using var second = Launched([beta]);

        Assert.Equal(0, second.Opens.OpenedTotal);
        Assert.False(second.Index.Registers(alpha.KeyOf()));
        Assert.Empty(second.Index.RequireReads().GetDocuments(alpha.KeyOf()));
        Assert.True(second.Index.Registers(beta.KeyOf()));
        Assert.NotEmpty(second.Index.RequireReads().GetDocuments(beta.KeyOf()));

        // Alpha's rows outlived its registration: naming it again costs no open.
        second.Dispose();
        using var third = Launched([alpha, beta]);
        Assert.Equal(0, third.Opens.OpenedTotal);
        Assert.NotEmpty(third.Index.RequireReads().GetDocuments(alpha.KeyOf()));
    }

    // Content, never clock: the changed plugin is re-read on the next launch, and its neighbour,
    // untouched, keeps everything.
    [Fact]
    public void APluginWhoseBytesChangedBetweenOpens_IsTheOnlyOneDropped()
    {
        var alpha = WritePlugin("Alpha.esp", "NpcAlpha", 0);
        var beta = WritePlugin("Beta.esp", "NpcBeta", 1);
        using (Launched([alpha, beta])) { }

        var changed = new Fallout4Mod(ModKey.FromFileName("Alpha.esp"), Fallout4Release.Fallout4);
        changed.Npcs.AddNew("NpcAlphaEdited");
        changed.WriteToBinary(alpha.Path);

        using var second = Launched([alpha, beta]);

        Assert.Equal(["Alpha.esp"], second.Opens.Opened);
        var reads = second.Index.RequireReads();
        Assert.Contains(reads.GetDocuments(alpha.KeyOf()), d => d.EditorId == "NpcAlphaEdited");
        Assert.Contains(reads.GetDocuments(beta.KeyOf()), d => d.EditorId == "NpcBeta");
    }

    // A rewrite that lands the identical bytes is not a change at all — the same "by content" rule
    // read from the other side, and what stops a mod manager's touch costing a re-index.
    [Fact]
    public void APluginRewrittenWithIdenticalBytes_IsNotDropped()
    {
        var alpha = WritePlugin("Alpha.esp", "NpcAlpha", 0);
        using (Launched([alpha])) { }

        var bytes = File.ReadAllBytes(alpha.Path);
        File.Delete(alpha.Path);
        File.WriteAllBytes(alpha.Path, bytes);

        using var second = Launched([alpha]);
        Assert.Equal(0, second.Opens.OpenedTotal);
        Assert.NotEmpty(second.Index.RequireReads().GetDocuments(alpha.KeyOf()));
    }

    // The index holds exactly what exists: a file that is gone takes its rows with it.
    [Fact]
    public void APluginDeletedBetweenOpens_HasItsRowsRemoved()
    {
        var alpha = WritePlugin("Alpha.esp", "NpcAlpha", 0);
        using (Launched([alpha])) { }

        File.Delete(alpha.Path);

        using var second = Launched([alpha]);
        Assert.Empty(second.Index.RequireReads().GetDocuments(alpha.KeyOf()));
        Assert.Contains(second.Index.Status.Failures, f => f.Name == "Alpha.esp");
    }

    // A codec or schema change invalidates the whole file, not the rows of one plugin: the
    // stored documents are that version's output and there is no partial answer to give.
    [Fact]
    public void AFileWrittenUnderAnotherVersion_RebuildsFromScratch()
    {
        var alpha = WritePlugin("Alpha.esp", "NpcAlpha", 0);
        var beta = WritePlugin("Beta.esp", "NpcBeta", 1);
        using (Launched([alpha, beta])) { }

        // The other-build actor: the file aged the way a real codec or reflector change would age it,
        // there being no other way to write rows under a version this build cannot produce.
        using (var connection = new DuckDBConnection($"Data Source={IndexFiles.In(_instanceRoot)}"))
        {
            connection.Open();
            using var cmd = connection.CreateCommand();
            cmd.CommandText = "UPDATE mirror.files SET index_version = 'written-by-another-build'";
            cmd.ExecuteNonQuery();
        }

        using var second = Launched([alpha, beta]);
        Assert.Equal(["Alpha.esp", "Beta.esp"], second.Opens.Opened);
        Assert.NotEmpty(second.Index.RequireReads().GetDocuments(alpha.KeyOf()));
        Assert.NotEmpty(second.Index.RequireReads().GetDocuments(beta.KeyOf()));
    }

    // A file DuckDB cannot open at all — a storage-format change on upgrade, a truncated
    // write — is derived state worth exactly one cold load, so it is rebuilt rather than fatal.
    [Fact]
    public void AFileThatCannotBeOpened_RebuildsFromScratch()
    {
        var alpha = WritePlugin("Alpha.esp", "NpcAlpha", 0);
        using (Launched([alpha])) { }

        File.WriteAllText(IndexFiles.In(_instanceRoot), "this is not a DuckDB database");

        using var second = Launched([alpha]);
        Assert.Equal(["Alpha.esp"], second.Opens.Opened);
        Assert.NotEmpty(second.Index.RequireReads().GetDocuments(alpha.KeyOf()));
    }

    // DuckDB.NET shares one database instance per path in a process, so a second open here joins
    // the first rather than contending; the cross-process refusal (ADR-0009 point 5) is out of reach.
    [Fact]
    public void ASecondIndexOverTheSameFile_LeavesTheFirstOnesRowsIntact()
    {
        var alpha = WritePlugin("Alpha.esp", "NpcAlpha", 0);
        using var holder = Launched([alpha]);

        Launched([alpha]).Dispose();

        Assert.NotEmpty(holder.Index.RequireReads().GetDocuments(alpha.KeyOf()));
    }
}
