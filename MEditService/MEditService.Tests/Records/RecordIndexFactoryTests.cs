using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
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

    /// <summary>A directory to hold a mod folder. An <i>instance</i> only when a Create call keys
    /// on it — which is the distinction <see cref="Create_WithNoInstanceRoot_KeepsNothingBetweenIndexes"/>
    /// turns on, so the two cases share this and differ only in what they hand the factory.</summary>
    private string Folder(string name)
    {
        var path = Path.Combine(_root, name);
        Directory.CreateDirectory(path);
        return path;
    }

    // Writes a one-Npc plugin under the instance and indexes it, mirroring the two-instance shape:
    // both instances use the same mod folder name, so the PluginKey is identical in each.
    private static PluginKey IndexOnePlugin(IRecordIndex index, string instanceRoot, string editorId)
    {
        var folder = Path.Combine(instanceRoot, "mods", "Unofficial Patch");
        Directory.CreateDirectory(folder);
        var path = Path.Combine(folder, "UFO4P.esp");
        var mod = new Fallout4Mod(ModKey.FromFileName("UFO4P.esp"), Fallout4Release.Fallout4);
        mod.Npcs.AddNew(editorId);
        mod.WriteToBinary(path);

        var key = new PluginKey("UFO4P.esp", "Unofficial Patch");
        using var overlay = Fallout4Mod.CreateFromBinaryOverlay(path, Fallout4Release.Fallout4);
        index.Index(overlay, Registration.Participating(0), key, path);
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

        PluginKey key;
        using (var first = factory.Create(GameRelease.Fallout4, a)) key = IndexOnePlugin(first, a, "NpcFromA");

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
        PluginKey key;
        using (var first = factory.Create(GameRelease.Fallout4)) key = IndexOnePlugin(first, Folder("no-home"), "NpcNowhere");

        using var second = factory.Create(GameRelease.Fallout4);
        Assert.Null(second.IndexedContentHash(key));
    }
}
