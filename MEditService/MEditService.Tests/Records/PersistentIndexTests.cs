using DuckDB.NET.Data;
using MEditService.LoadOrder;
using MEditService.Index;
using MEditService.Codec.Schema;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Records;

// ADR-0009: one persistent file per MO2 instance, validating itself against the disk by content,
// never by clock. Two assertions reach past the seam through `Connection`: unregistered rows and a
// version this build cannot produce have no other witness.
public class PersistentIndexTests : IDisposable
{
    private static readonly SchemaReflector Reflector = SharedSchemaReflector.Instance;
    private static readonly TableDdlBuilder Ddl = new TableDdlBuilder(Reflector);

    private readonly string _root = Path.Combine(Path.GetTempPath(), $"medit-index-{Guid.NewGuid():N}");

    public void Dispose()
    {
        GC.SuppressFinalize(this);
        if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
    }

    private string DataFolder
    {
        get
        {
            var path = Path.Combine(_root, "Data");
            Directory.CreateDirectory(path);
            return path;
        }
    }

    private string IndexPath => IndexFile.For(Path.Combine(_root, "instance"));

    private DuckDbRecordIndex OpenIndex()
    {
        var index = new DuckDbRecordIndex(Reflector, Ddl, NullLogger.Instance, IndexPath);
        index.Initialize(GameRelease.Fallout4);
        return index;
    }

    // Writes a real plugin file holding one Npc with the given EditorID, and returns its path.
    private string WritePlugin(string name, string editorId)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(name), Fallout4Release.Fallout4);
        mod.Npcs.AddNew(editorId);
        var path = Path.Combine(DataFolder, name);
        mod.WriteToBinary(path);
        return path;
    }

    private static PluginKey KeyOf(string name) => new(name, "Data");

    private static void IndexFileAt(DuckDbRecordIndex index, string path, int loadOrderIndex)
    {
        var key = KeyOf(Path.GetFileName(path));
        using var mod = Fallout4Mod.CreateFromBinaryOverlay(path, Fallout4Release.Fallout4);
        index.IndexMod(mod, Registration.Participating(loadOrderIndex), key, path);
    }

    private static long RecordRowsFor(DuckDbRecordIndex index, PluginKey key)
    {
        using var cmd = index.Connection.CreateCommand();
        cmd.CommandText = "SELECT COUNT(*) FROM mirror.records WHERE plugin = $1 AND origin = $2";
        cmd.Parameters.Add(new DuckDBParameter { Value = key.Name });
        cmd.Parameters.Add(new DuckDBParameter { Value = key.Origin! });
        return Convert.ToInt64(cmd.ExecuteScalar(), System.Globalization.CultureInfo.InvariantCulture);
    }

    // Rows the previous process indexed are still there and the plugin answers reads again on nothing
    // more than a Register: there is no Index call in this test's second half at all.
    [Fact]
    public void ReopeningTheSameFile_KeepsTheRows_AndRegisterAloneMakesThemAnswer()
    {
        var alpha = WritePlugin("Alpha.esp", "NpcAlpha");
        using (var first = OpenIndex()) IndexFileAt(first, alpha, 0);

        using var second = OpenIndex();
        var key = KeyOf("Alpha.esp");
        Assert.NotNull(second.IndexedContentHash(key));
        Assert.True(RecordRowsFor(second, key) > 0);

        second.Register(key, Registration.Participating(0));
        second.UpdateWinners();
        Assert.NotEmpty(second.At(RecordRef.Effective).GetDocuments(key));
    }

    // A freshly opened index is in no load order yet, so whatever the last one registered must not be
    // visible — the rows are there, and nothing answers until this process registers them itself.
    [Fact]
    public void ReopeningTheSameFile_KeepsTheLastRegistrations_UntilTheSnapshotCorrectsThem()
    {
        // ADR-0013: the registrations a file carries are the last known load
        // order, kept on open so a restart with an identical snapshot costs nothing; the first reconcile
        // corrects them.
        var alpha = WritePlugin("Alpha.esp", "NpcAlpha");
        using (var first = OpenIndex()) IndexFileAt(first, alpha, 0);

        using var second = OpenIndex();
        Assert.Contains(KeyOf("Alpha.esp"), second.RegisteredPlugins());
        Assert.NotEmpty(second.At(RecordRef.Effective).GetDocuments(KeyOf("Alpha.esp")));

        second.Unregister(KeyOf("Alpha.esp"));
        Assert.Empty(second.At(RecordRef.Effective).GetDocuments(KeyOf("Alpha.esp")));
    }

    // Content, never clock: the changed plugin's rows are dropped so the next load re-indexes
    // it, and its neighbour — untouched — keeps everything.
    [Fact]
    public void APluginWhoseBytesChangedBetweenOpens_IsTheOnlyOneDropped()
    {
        var alpha = WritePlugin("Alpha.esp", "NpcAlpha");
        var beta = WritePlugin("Beta.esp", "NpcBeta");
        using (var first = OpenIndex())
        {
            IndexFileAt(first, alpha, 0);
            IndexFileAt(first, beta, 1);
        }

        var changed = new Fallout4Mod(ModKey.FromFileName("Alpha.esp"), Fallout4Release.Fallout4);
        changed.Npcs.AddNew("NpcAlphaEdited");
        changed.WriteToBinary(alpha);

        using var second = OpenIndex();
        Assert.Null(second.IndexedContentHash(KeyOf("Alpha.esp")));
        Assert.Equal(0, RecordRowsFor(second, KeyOf("Alpha.esp")));
        Assert.NotNull(second.IndexedContentHash(KeyOf("Beta.esp")));
        Assert.True(RecordRowsFor(second, KeyOf("Beta.esp")) > 0);
    }

    // A rewrite that lands the identical bytes is not a change at all — the same "by content" rule
    // read from the other side, and what stops a mod manager's touch costing a re-index.
    [Fact]
    public void APluginRewrittenWithIdenticalBytes_IsNotDropped()
    {
        var alpha = WritePlugin("Alpha.esp", "NpcAlpha");
        using (var first = OpenIndex()) IndexFileAt(first, alpha, 0);

        var bytes = File.ReadAllBytes(alpha);
        File.Delete(alpha);
        File.WriteAllBytes(alpha, bytes);

        using var second = OpenIndex();
        Assert.NotNull(second.IndexedContentHash(KeyOf("Alpha.esp")));
        Assert.True(RecordRowsFor(second, KeyOf("Alpha.esp")) > 0);
    }

    // The index holds exactly what exists: a file that is gone takes its rows with it.
    [Fact]
    public void APluginDeletedBetweenOpens_HasItsRowsRemoved()
    {
        var alpha = WritePlugin("Alpha.esp", "NpcAlpha");
        using (var first = OpenIndex()) IndexFileAt(first, alpha, 0);

        File.Delete(alpha);

        using var second = OpenIndex();
        var key = KeyOf("Alpha.esp");
        Assert.Null(second.IndexedContentHash(key));
        Assert.Equal(0, RecordRowsFor(second, key));

        // And registering it anyway cannot conjure the rows back — "removed" is removed, not hidden.
        second.Register(key, Registration.Participating(0));
        second.UpdateWinners();
        Assert.Empty(second.At(RecordRef.Effective).GetDocuments(key));
    }

    // A codec or schema change invalidates the whole file, not the rows of one plugin: the
    // stored documents are that version's output and there is no partial answer to give.
    [Fact]
    public void AFileWrittenUnderAnotherVersion_RebuildsFromScratch()
    {
        var alpha = WritePlugin("Alpha.esp", "NpcAlpha");
        var beta = WritePlugin("Beta.esp", "NpcBeta");
        using (var first = OpenIndex())
        {
            IndexFileAt(first, alpha, 0);
            IndexFileAt(first, beta, 1);
            // The one white-box reach in this file, and only to age the file the way a real codec or
            // reflector change would: there is no other way to write rows under a version this build
            // cannot produce.
            using var cmd = first.Connection.CreateCommand();
            cmd.CommandText = "UPDATE mirror.files SET index_version = 'written-by-another-build'";
            cmd.ExecuteNonQuery();
        }

        using var second = OpenIndex();
        Assert.Null(second.IndexedContentHash(KeyOf("Alpha.esp")));
        Assert.Null(second.IndexedContentHash(KeyOf("Beta.esp")));
        Assert.Equal(0, RecordRowsFor(second, KeyOf("Alpha.esp")));
        Assert.Equal(0, RecordRowsFor(second, KeyOf("Beta.esp")));

        // And it is a working index afterwards, not a wedged one.
        IndexFileAt(second, alpha, 0);
        Assert.NotNull(second.IndexedContentHash(KeyOf("Alpha.esp")));
    }

    // A file DuckDB cannot open at all — a storage-format change on upgrade, a truncated
    // write — is derived state worth exactly one cold load, so it is rebuilt rather than fatal.
    [Fact]
    public void AFileThatCannotBeOpened_RebuildsFromScratch()
    {
        var alpha = WritePlugin("Alpha.esp", "NpcAlpha");
        using (var first = OpenIndex()) IndexFileAt(first, alpha, 0);

        File.WriteAllText(IndexPath, "this is not a DuckDB database");

        using var second = OpenIndex();
        Assert.Null(second.IndexedContentHash(KeyOf("Alpha.esp")));
        IndexFileAt(second, alpha, 0);
        Assert.NotNull(second.IndexedContentHash(KeyOf("Alpha.esp")));
    }

    // DuckDB.NET shares one database instance per path in a process, so a second open here joins
    // the first rather than contending; the cross-process refusal (ADR-0009 point 5) is out of reach.
    [Fact]
    public void ASecondIndexOverTheSameFile_LeavesTheFirstOnesRowsIntact()
    {
        var alpha = WritePlugin("Alpha.esp", "NpcAlpha");
        using var holder = OpenIndex();
        IndexFileAt(holder, alpha, 0);

        OpenIndex().Dispose();

        Assert.NotNull(holder.IndexedContentHash(KeyOf("Alpha.esp")));
        Assert.True(RecordRowsFor(holder, KeyOf("Alpha.esp")) > 0);
    }

    // The two failures arrive as the same exception type, so the message is all there is to tell
    // them apart, and a lock wrongly read as corruption costs another window its index.
    [Theory]
    [InlineData("IO Error: Could not set lock on file \"/x/Fallout4-ab.duckdb\": Conflicting lock is held in /usr/bin/dotnet (PID 4242)", true)]
    [InlineData("IO Error: Could not set lock on file \"C:\\x\\Fallout4-ab.duckdb\": The process cannot access the file because another process has locked a portion of the file.", true)]
    [InlineData("IO Error: The file is not a valid DuckDB database file!", false)]
    [InlineData("Serialization Error: Failed to deserialize: unsupported storage version", false)]
    public void AnOpenFailure_IsClassifiedAsAnotherWriterOnlyWhenItIsALockConflict(string message, bool expected) =>
        Assert.Equal(expected, IndexStore.IsAnotherWriter(new InvalidOperationException(message)));

    // An index given no home is still a working index — the in-memory shape, which is what a caller
    // with no install to key a file by gets, and what every other fixture in this suite uses.
    [Fact]
    public void AnIndexWithNoFile_IndexesWithoutStampingAnything()
    {
        using var index = new DuckDbRecordIndex(Reflector, Ddl, NullLogger.Instance);
        index.Initialize(GameRelease.Fallout4);

        var mod = new Fallout4Mod(ModKey.FromFileName("Alpha.esp"), Fallout4Release.Fallout4);
        mod.Npcs.AddNew("NpcAlpha");
        index.IndexMod((IModGetter)mod, Registration.Participating(0), KeyOf("Alpha.esp"));

        Assert.NotEmpty(index.At(RecordRef.Effective).GetDocuments(KeyOf("Alpha.esp")));
        Assert.Null(index.IndexedContentHash(KeyOf("Alpha.esp")));
    }
}
