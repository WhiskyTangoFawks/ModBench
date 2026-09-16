using MEditService.Codec.Schema;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Records;

public class RecordIndexFactoryTests : IDisposable
{
    private static readonly SchemaReflector Reflector = SharedSchemaReflector.Instance;

    private readonly string _root = Path.Combine(Path.GetTempPath(), $"medit-factory-{Guid.NewGuid():N}");

    public void Dispose()
    {
        GC.SuppressFinalize(this);
        if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
    }

    private static IRecordIndexFactory MakeFactory() =>
        new DuckDbRecordIndexFactory(Reflector, new TableDdlBuilder(Reflector));

    private string Folder(string name)
    {
        var path = Path.Combine(_root, name);
        Directory.CreateDirectory(path);
        return path;
    }

    // Writes a one-Npc plugin under the instance and indexes it, mirroring the two-instance shape:
    // both instances use the same mod folder name, so the PluginCopyKey is identical in each.
    private static PluginCopyKey IndexOnePlugin(DuckDbRecordIndex index, string instanceRoot, string editorId)
    {
        var folder = Path.Combine(instanceRoot, "mods", "Unofficial Patch");
        Directory.CreateDirectory(folder);
        var path = Path.Combine(folder, "UFO4P.esp");
        var mod = new Fallout4Mod(ModKey.FromFileName("UFO4P.esp"), Fallout4Release.Fallout4);
        mod.Npcs.AddNew(editorId);
        mod.WriteToBinary(path);

        var key = new PluginCopyKey("UFO4P.esp", "Unofficial Patch");
        using var overlay = Fallout4Mod.CreateFromBinaryOverlay(path, Fallout4Release.Fallout4);
        index.IndexMod(overlay, Registration.Participating(0), key, path);
        index.Register(key, Registration.Participating(0));
        index.UpdateWinners();
        return key;
    }

    [Fact]
    public void Create_ReturnsInitializedRepository()
    {
        using var repo = MakeFactory().Create(GameRelease.Fallout4);

        var result = repo.At(RecordRef.Effective).Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 1, Offset: 0));
        Assert.Equal(0, result.Total);
    }

    // `origin` is a mod folder name, unique only within an MO2
    // instance, so an index keyed any wider than the instance would hand one instance the other's
    // rows for the same (plugin, origin).
    [Fact]
    public void Create_KeysTheFileOnTheInstanceRoot_SoTwoInstancesShareNothing()
    {
        var a = Folder("instance-a");
        var b = Folder("instance-b");
        var factory = MakeFactory();

        PluginCopyKey key;
        using (var first = factory.Create(GameRelease.Fallout4, a)) key = IndexOnePlugin((DuckDbRecordIndex)first, a, "NpcFromA");

        using (var other = factory.Create(GameRelease.Fallout4, b))
        {
            Assert.Null(other.IndexedContentHash(key));
            Assert.Empty(other.At(RecordRef.Effective).GetDocuments(key));
        }

        using var again = factory.Create(GameRelease.Fallout4, a);
        Assert.NotNull(again.IndexedContentHash(key));
    }

    // An index handed no instance has nowhere to keep a file and says so by being in-memory rather
    // than by guessing a home — the shape the suite's several hundred index fixtures use.
    [Fact]
    public void Create_WithNoInstanceRoot_KeepsNothingBetweenIndexes()
    {
        var factory = MakeFactory();
        PluginCopyKey key;
        using (var first = factory.Create(GameRelease.Fallout4)) key = IndexOnePlugin((DuckDbRecordIndex)first, Folder("no-home"), "NpcNowhere");

        using var second = factory.Create(GameRelease.Fallout4);
        Assert.Null(second.IndexedContentHash(key));
    }

    // ADR-0014: the rebuild endpoint's whole job — every trace of what the old file held is gone,
    // not merely re-validated, because a rebuild must fix a row no hash-validate can (a wrong but
    // still self-consistent body).
    [Fact]
    public void Rebuild_DropsEveryRow_AndReopensTheFileEmpty()
    {
        var instance = Folder("rebuild-instance");
        var factory = MakeFactory();
        PluginCopyKey key;
        using (var first = factory.Create(GameRelease.Fallout4, instance)) key = IndexOnePlugin((DuckDbRecordIndex)first, instance, "NpcBeforeRebuild");

        using var rebuilt = factory.Rebuild(GameRelease.Fallout4, instance, atLeastSequence: 0);

        Assert.Null(rebuilt.IndexedContentHash(key));
        Assert.Empty(rebuilt.At(RecordRef.Effective).GetDocuments(key));
    }

    // ADR-0014: the process may already have answered a caller with a sequence value the fresh
    // file's own table (seeded at 0) does not know about; the rebuild must never let Sequence
    // regress within one process.
    [Fact]
    public void Rebuild_SeedsTheSequence_AtLeastTheValueGiven()
    {
        var instance = Folder("rebuild-sequence-instance");
        var factory = MakeFactory();
        long priorSequence;
        using (var first = factory.Create(GameRelease.Fallout4, instance))
        {
            IndexOnePlugin((DuckDbRecordIndex)first, instance, "NpcForSequence");
            priorSequence = first.Sequence;
        }
        Assert.True(priorSequence > 0, "sanity: indexing must have advanced the sequence past 0");

        using var rebuilt = factory.Rebuild(GameRelease.Fallout4, instance, priorSequence);

        Assert.True(rebuilt.Sequence >= priorSequence,
            $"rebuilt sequence {rebuilt.Sequence} regressed below the prior process value {priorSequence}");
    }

    // ADR-0009 point 5: the same refusal PutLoadOrder answers with, at the seam that actually
    // guards it — deleting an open file succeeds on POSIX and destroys a live index.
    [ForeignIndexHolderFact]
    public void Rebuild_RefusesAndNeverDeletes_WhenAnotherProcessHoldsTheFile()
    {
        var instance = Folder("rebuild-held-instance");
        var factory = MakeFactory();
        using (var first = factory.Create(GameRelease.Fallout4, instance)) IndexOnePlugin((DuckDbRecordIndex)first, instance, "NpcBeforeHold");

        var indexPath = IndexFile.For(instance);
        var bytesBeforeHold = File.ReadAllBytes(indexPath);
        using var otherWindow = ForeignIndexHolder.Hold(indexPath);

        Assert.Throws<IndexHeldElsewhereException>(() => factory.Rebuild(GameRelease.Fallout4, instance, atLeastSequence: 0));

        Assert.True(File.Exists(indexPath), "the file must still exist — a refusal must never delete it");
        Assert.Equal(bytesBeforeHold, File.ReadAllBytes(indexPath));
    }
}
